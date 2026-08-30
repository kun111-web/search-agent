// 这一轮修的几处 bug，逐条验。用 electron 跑：npx electron .bugfix-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, screen } = require("electron");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "bugfix-"));
app.setPath("userData", userData);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "通过  " : "不通过"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// ── 1. 主备切换时判定缓存写进哪个分区 ───────────────────────────────────────
// 池子在 complete() 里会改自己的首选：主模型不通切到备用，冷却够了又切回主模型。
// 缓存分区按模型名分，写的时候必须跟"读的时候按谁算的"比，不能跟"现在的首选"比。
async function testCacheScope() {
  const { filterArticles } = require("./electron/agent/filter");
  const cache = require("./electron/agent/filter-cache");
  const requirement = "只要财经";
  const item = { key: "k-switch", text: "22:01:00 某公司发布财报", ts: 1787664643000, arrival: 1 };

  // 主模型不通，备用顶上：complete 返回备用，池子的首选也跟着变成备用
  let preferred = "main-model";
  const pool = {
    hasKey: () => true,
    preferredModel: () => preferred,
    complete: async () => {
      preferred = "backup-model";
      return {
        data: { articles: [{ index: 1, title: "财报", summary: "某公司发布财报", match: "财经" }] },
        usage: null,
        model: "backup-model",
      };
    },
  };

  const out = await filterArticles({ pool, requirement, items: [item], pageUrl: "" });
  check("切到备用后判定照旧输出", out.articles.length === 1, `${out.articles.length} 篇`);

  const backupScope = cache.scopeOf(requirement, "backup-model");
  const mainScope = cache.scopeOf(requirement, "main-model");
  check("判定记在真正用的那个模型名下", cache.read(backupScope, item.key) !== undefined, "备用分区");
  check("没有串到主模型的分区里去", cache.read(mainScope, item.key) === undefined, "主模型分区应为空");

  // 反方向：冷却到了，complete 里切回主模型。读缓存那一刻的首选是备用。
  preferred = "backup-model";
  const item2 = { key: "k-restore", text: "22:02:00 另一家公司发布财报", ts: 1787664700000, arrival: 2 };
  const pool2 = {
    hasKey: () => true,
    preferredModel: () => preferred,
    complete: async () => {
      preferred = "main-model";
      return {
        data: { articles: [{ index: 1, title: "财报二", summary: "另一家公司", match: "财经" }] },
        usage: null,
        model: "main-model",
      };
    },
  };
  await filterArticles({ pool: pool2, requirement, items: [item2], pageUrl: "" });
  check("切回主模型时同理", cache.read(mainScope, item2.key) !== undefined, "主模型分区");
  check("没有反向串到备用分区", cache.read(backupScope, item2.key) === undefined, "备用分区不该有这条");
}

// ── 2. 响应体读到一半断了，算网络问题还是算模型答得不对 ─────────────────────
// 算错的后果是反的：network 会重连、会切备用；response 两样都不做，还计入致命次数，
// 攒够三次就把筛选停了。
async function testBodyReadFailure() {
  const { completeJson } = require("./electron/agent/llm");
  const settings = { baseUrl: "https://example.invalid/v1", model: "m", apiKey: "k" };
  const realFetch = global.fetch;

  const cases = [
    ["读 body 时连接断了", Object.assign(new TypeError("terminated"), { cause: new Error("socket hang up") })],
    ["网关吐了一页 HTML", new SyntaxError("Unexpected token '<'")],
    ["读 body 时超时", Object.assign(new Error("timeout"), { name: "TimeoutError" })],
  ];

  for (const [name, thrown] of cases) {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw thrown;
      },
    });
    let kind = "没抛";
    try {
      await completeJson({ settings, messages: [] });
    } catch (error) {
      kind = error.kind;
    }
    check(`${name} → 算网络问题`, kind === "network", `kind=${kind}`);
  }

  // 连上了、body 也是好 JSON，只是内容不成样子——这个才该算 response
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "不是 JSON" } }] }) });
  let kind = "没抛";
  try {
    await completeJson({ settings, messages: [] });
  } catch (error) {
    kind = error.kind;
  }
  check("模型答的不是 JSON → 仍算 response", kind === "response", `kind=${kind}`);

  // 状态码不对而 body 又读不出来时，得听状态码的
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => {
      throw new SyntaxError("no json");
    },
  });
  kind = "没抛";
  try {
    await completeJson({ settings, messages: [] });
  } catch (error) {
    kind = error.kind;
  }
  check("429 配上读不出的 body → 仍算限流", kind === "rate", `kind=${kind}`);

  global.fetch = realFetch;
}

// ── 3~6. 采集侧 ────────────────────────────────────────────────────────────
function fakeTabs(options = {}) {
  const calls = { removeLiveProbe: [], reloadTab: [] };
  return {
    calls,
    activeTabId: "t1",
    tabFor: (id) => ({ id: id || "t1" }),
    getTabUrl: () => "https://news.example.com/",
    getTabTitle: () => "示例快讯站",
    waitForIdle: async () => {},
    ensureLiveProbe: async () => {},
    scrollToTop: async () => {},
    showCollector: () => {},
    reloadTab: (id) => calls.reloadTab.push(id),
    removeLiveProbe: async (id) => {
      calls.removeLiveProbe.push(id);
      return 1;
    },
    drainLiveItems: async () => (options.drain ? options.drain() : []),
    extractPageData: async () => options.snapshot || { title: "示例快讯站", excerpt: "财经快讯", text: "财经快讯" },
    clickRefreshControl: async () => "",
  };
}

function newScraper(tabManager) {
  const { PageScraper } = require("./electron/agent/scraper");
  const scraper = new PageScraper(tabManager, () => {});
  scraper.keepOnPage = async () => {};
  scraper.maybeRefresh = async () => false;
  scraper.savePool = () => {};
  scraper.archiveArticles = () => {};
  return scraper;
}

async function testRestartAfterStop() {
  let seq = 0;
  const tabs = fakeTabs({
    drain: () => {
      seq += 1;
      return [{ text: `22:0${seq % 10}:00 第 ${seq} 条快讯内容够长可以入库`, ts: 1787664643000 + seq * 1000, seq }];
    },
  });
  const scraper = newScraper(tabs);
  const settings = { maxMinutes: 0, refreshSeconds: 0 };

  const first = scraper.start("", settings, ["t1"]).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("采集跑起来了", scraper.running === true);

  scraper.stopCollect();
  // 点停止之后立刻再点开始：这中间界面写的是"已停止"，不该顶一句"正在抓取"回来。
  // 没设时限的采集是不会自己结束的，所以只看它有没有当场翻脸，不等它跑完。
  const started = Date.now();
  const second = scraper.start("", settings, ["t1"]);
  const outcome = await Promise.race([
    second.then(() => "自己结束了").catch((error) => `报错：${error.message}`),
    new Promise((resolve) => setTimeout(() => resolve("跑起来了"), 2000)),
  ]);
  const waited = Date.now() - started;
  check("停止后立刻重开能开起来", outcome === "跑起来了", outcome);
  check("重开不用干等一整个轮询间隔", waited < 2500, `${waited}ms`);

  scraper.stopCollect();
  await first;
  await second.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("采集收工把探针撤了下来", tabs.calls.removeLiveProbe.includes("t1"), `撤了 ${tabs.calls.removeLiveProbe.length} 次`);
}

async function testBlockedPageKeepsItems() {
  const tabs = fakeTabs({
    // 正文里带"人机验证"这几个字的正常快讯，会被当成验证页
    snapshot: { title: "示例快讯站", excerpt: "某平台上线人机验证功能，防止刷单", text: "某平台上线人机验证功能" },
    drain: () => [{ text: "22:10:00 某平台上线人机验证功能，用于防止黄牛刷单，已在全量灰度", ts: 1787664643000, seq: 1 }],
  });
  const scraper = newScraper(tabs);
  const source = scraper.newSource("t1", "https://news.example.com/");
  const gained = await scraper.pollSource(source, 1);
  check("正文提到验证但确实采到了东西，不丢", gained === 1, `采到 ${gained} 条`);

  // 真验证页：探针一条也采不到
  const blocked = fakeTabs({
    snapshot: { title: "安全验证", excerpt: "请进行滑动验证", text: "请进行滑动验证" },
    drain: () => [],
  });
  const scraper2 = newScraper(blocked);
  const source2 = scraper2.newSource("t1", "https://news.example.com/");
  const gained2 = await scraper2.pollSource(source2, 1);
  check("真的验证页照旧跳过", gained2 === 0, `采到 ${gained2} 条`);
}

async function testPerSourceQuota() {
  const tabs = fakeTabs();
  const scraper = newScraper(tabs);
  const fast = scraper.newSource("t1", "https://fast.example.com/");
  const slow = scraper.newSource("t2", "https://slow.example.com/");
  fast.label = "解析得出时间的站";
  slow.label = "解析不出时间的站";
  scraper.sources = [fast, slow];

  // 一个站能解析出时间，另一个解析不出（ts 为 0，排序上永远垫底）
  const slowItems = Array.from({ length: 40 }, (_, at) => ({
    text: `没有时间戳的第 ${at} 条内容，长度足够进入库中不被短句过滤掉`,
    ts: 0,
    seq: at,
  }));
  const fastItems = Array.from({ length: 400 }, (_, at) => ({
    text: `带时间戳的第 ${at} 条内容，长度足够进入库中不被短句过滤掉`,
    ts: 1787664643000 + at * 1000,
    seq: at,
  }));

  tabs.drainLiveItems = async (id) => {
    const items = id === "t2" ? slowItems.splice(0, 40) : fastItems.splice(0, 200);
    return items;
  };

  await scraper.pollSource(slow, 1);
  await scraper.pollSource(fast, 1);
  await scraper.pollSource(fast, 2);

  // 界面那份列表带的是站名，筛选队列带的是站 id
  const slowShown = scraper.rawItems.filter((item) => item.origin === slow.label).length;
  const slowQueued = scraper.collected.filter((item) => item.originId === "t2").length;
  check("解析不出时间的那个站没被挤掉", slowShown > 0, `界面上还有 ${slowShown} 条`);
  check("它也还在这次要筛的范围里", slowQueued > 0, `队列里还有 ${slowQueued} 条`);
}

function testClearOutputs() {
  const scraper = newScraper(fakeTabs());
  const before = scraper.agentGeneration;
  scraper.clearOutputs();
  check("清空数据让在路上的那批作废", scraper.agentGeneration > before, `代次 ${before} → ${scraper.agentGeneration}`);
}

// ── 7. 配置文件坏了，不能拿默认值把它盖掉 ──────────────────────────────────
function testSettingsCorrupt() {
  const settingsFile = path.join(userData, "agent-settings.json");
  const { readSettings } = require("./electron/agent/settings");

  fs.writeFileSync(settingsFile, '{"apiKey":"sk-真的很重要", "model":"mimo', "utf8");
  const settings = readSettings();
  check("读坏文件不崩，给一份能用的", typeof settings.baseUrl === "string");
  check("坏掉的原文留了备份", fs.existsSync(`${settingsFile}.corrupt`), `${settingsFile}.corrupt`);
  const kept = fs.readFileSync(`${settingsFile}.corrupt`, "utf8");
  check("备份里能找回 Key", kept.includes("sk-真的很重要"));

  // 再读一次不能把备份冲掉
  fs.writeFileSync(settingsFile, "还是坏的", "utf8");
  readSettings();
  check("第二次读不覆盖那份备份", fs.readFileSync(`${settingsFile}.corrupt`, "utf8").includes("sk-真的很重要"));
  fs.rmSync(settingsFile, { force: true });
  fs.rmSync(`${settingsFile}.corrupt`, { force: true });
}

// ── 8. 悬浮球面板的几何 ────────────────────────────────────────────────────
function testOrbGeometry() {
  const { OrbWindow } = require("./electron/orb");
  const area = screen.getPrimaryDisplay().workArea;
  const orb = new OrbWindow(() => {});

  // 球贴在屏幕左沿，面板记着的宽度比半屏还大
  orb.anchor = { x: area.x + 4, y: area.y + 200 };
  orb.panel = { width: Math.round(area.width * 0.8), height: 500 };
  orb.chooseSide();
  check("球贴左沿时面板朝右开", orb.side === "right", `side=${orb.side}`);

  const room = orb.roomForPanel();
  check("宽度上限不超过那侧真有的地方", room.width <= area.width - 4 - 60, `上限 ${room.width}，屏宽 ${area.width}`);
  check("高度上限给状态栏留了地方", room.height < area.height, `上限 ${room.height}，可用高 ${area.height}`);

  // 拉到最高时整个窗口装得进工作区
  orb.panel = { width: 400, height: 99999 };
  orb.expanded = true;
  const size = orb.panelSizeNow();
  const top = orb.panelTop(size.height);
  const statusHeight = orb.ballTop || 46;
  check(
    "面板拉到最高，窗口底边还在屏幕里",
    top - statusHeight + statusHeight + size.height <= area.y + area.height,
    `底边 ${top + size.height}，屏幕底 ${area.y + area.height}`,
  );

  // 球贴在屏幕右沿：朝左开，且不越出左边界
  orb.anchor = { x: area.x + area.width - 64, y: area.y + 200 };
  orb.panel = { width: 400, height: 500 };
  orb.chooseSide();
  check("球贴右沿时面板朝左开", orb.side === "left", `side=${orb.side}`);
  const leftRoom = orb.roomForPanel();
  check("朝左开也不越出屏幕左沿", leftRoom.width <= area.width - 64, `上限 ${leftRoom.width}`);
}

(async () => {
  await testCacheScope();
  await testBodyReadFailure();
  await testRestartAfterStop();
  await testBlockedPageKeepsItems();
  await testPerSourceQuota();
  testClearOutputs();
  testSettingsCorrupt();
  testOrbGeometry();

  const bad = results.filter((item) => !item.pass);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log("没过的：");
    for (const item of bad) {
      console.log(`  - ${item.name}`);
    }
  }
  app.exit(bad.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
