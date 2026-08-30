const { looksLikeUrl, normalizeNavigationInput } = require("../navigation");
const { isBlockedPage } = require("../page-quality");
const { filterArticles } = require("./filter");
const { ModelPool } = require("./model-pool");
const { TIME_TOKENS, itemKey, stripTailSection, SeenKeys } = require("./dedup");
const { byNewestFirst } = require("./ordering");
const archive = require("./archive");

const POLL_ACTIVE_MS = 1200;
const POLL_IDLE_MAX_MS = 4000;
const POLL_BACKOFF_MS = 400;
const SNAPSHOT_INTERVAL_MS = 15000;
const REFRESH_MIN_GAP_MS = 15000;
const HEARTBEAT_MS = 30000;
// 一个页面连着这么多轮采不动，就重新加载它，让探针跟着页面一起重建。
const SOURCE_RELOAD_AFTER = 3;
// 点停止之后，最多等这么久让上一轮循环收尾，再放行下一次"开始采集"。
const SETTLE_WAIT_MS = 10000;
const BATCH_SIZE = 8;
// 网络不通不该把筛选判死刑：人多半不在电脑前，等网络回来自己接着筛才对。所以这类
// 错误一直重连，只是间隔越拉越长，免得断网一小时刷出上千条日志。
const FILTER_RETRY_BASE_MS = 4000;
const FILTER_RETRY_MAX_MS = 60000;
// Key 不对、模型名不对这种，重试一万次也是一样的错。两个模型都是这种错才停下来喊人，
// 只有一个不行的话备用模型还能顶着。
const FILTER_FATAL_MAX = 3;
// 模型答非所问（response：连上了也回了 JSON，但解析不出可用结构）不算配置坏了，多半是
// 这批内容让模型犯了迷糊，下一批常自己就好。跟着 fatal 一起数 3 批就停筛太冤枉，它有
// 自己的宽松退避：重试到这么多回才认输，间隔照旧翻倍。名单里没有 model/auth——那两类
// 是请求根本没被受理，多试也是同样的拒绝。
const RESPONSE_RETRY_MAX = 6;
const SEEN_MAX = 5000;
const RAW_MAX = 300;
// 面板只是个实时视图，全部结果都已经进了归档，留最近这些够回看了。按来源各算一份：
// 合起来算的话，一个刷得勤的站能把另一个站的输出全顶出去，重开面板时那一块就是空的。
const ARTICLES_PER_SOURCE = 300;
const STEP_MAX = 200;
const PENDING_MAX = 200;
const RAW_PREVIEW = 8;
// 探针一条都认不出来时，切出来的块少于这个数就当一篇文章整条送出，超过才按条目切。
const FALLBACK_ARTICLE_BLOCKS = 12;
// 被渲染折行切开的段落，长度就是一整行的容量。短于这个数的行是自成一体的。
const WRAP_MIN_CHARS = 40;
// 句末标点后面还可能跟着引号或右括号。
const SENTENCE_END = /[。！？…；.!?;][")）'”’]*$/;
// 以时间打头的行是下一条的开头，不管上一块看着说完没说完，都得在这里断开。
const LINE_STARTS_TIME = /^\d{1,2}:\d{2}(?::\d{2})?/;
// 接到这么长还没遇上句号，说明折行判断已经跑偏了，别再往上堆。
const WRAP_MERGE_MAX = 500;
const IDLE_STATUS = "采集中，等待页面更新";

// 同时盯两个页面已经够用，再多就是每轮都要跑一遍探针、队列还得排更久，
// 落到每个页面上的响应反而变慢。
const SOURCE_MAX = 2;

const HAS_TIME = new RegExp(TIME_TOKENS.source, "i");

// 轮询间隔里点了停止，就别把这一觉睡完。停止到循环真正收尾之间，界面写着"已停止"
// 而 running 还是 true，这段时间里再点开始会被当成"正在抓取"顶回去。
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// 每块内容都要标上是哪个站来的。新闻站的标题多是"财联社A股24小时电报-上市公司动态-…"
// 这种，第一段就是给人看的那个名字；标题还没下来时退用域名。
function sourceLabel(title, url) {
  const head = String(title || "")
    .split(/[-|｜_—–·]/)[0]
    .replace(/\s+/g, " ")
    .trim();
  if (head.length >= 2) {
    return head.slice(0, 16);
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "未知来源";
  }
}

// 按来源各算一份配额，而不是合起来数。合起来数的话，能解析出时间的那个站会把解析
// 不出时间的那个站整个挤掉——后者的条目时间戳是 0，排序上永远垫在最后，一截断就全没
// 了，界面上那一块永远空着，点筛选也筛不到它。
function trimPerSource(list, limit) {
  const counts = new Map();
  return list.filter((item) => {
    const id = item.originId || item.origin || "";
    const used = counts.get(id) || 0;
    if (used >= limit) {
      return false;
    }
    counts.set(id, used + 1);
    return true;
  });
}

function samePage(left, right) {
  try {
    const first = new URL(left);
    const second = new URL(right);
    return first.origin === second.origin && first.pathname === second.pathname;
  } catch {
    return left === right;
  }
}

class PageScraper {
  constructor(tabManager, emit) {
    this.tabManager = tabManager;
    this.emit = emit;
    this.aborted = false;
    this.running = false;
    this.agentRunning = false;
    this.agentController = null;
    this.steps = [];
    this.stepIndex = 0;
    this.articles = [];
    this.articleTotal = 0;
    // 送去判过的条数。一篇都没留下时，界面要靠它区分"要求太窄"和"还没采到内容"。
    this.screenedTotal = 0;
    this.rawItems = [];
    this.summary = "";
    this.collected = [];
    this.pending = [];
    // 点筛选那一刻攒下的那批单独排队。混进 pending 会被那边的条数上限截掉，边筛边
    // 采到的新消息也会被压在这一整批后面。
    this.backlog = [];
    this.arrival = 0;
    this.filtering = false;
    this.waitFailures = 0;
    this.fatalFailures = 0;
    // 上一批失败后定下的"下次最早什么时候能再问模型"，见 flushAgent。
    this.retryNotBefore = 0;
    // 模型答非所问的连击数。跟 fatalFailures 分开数：前者下一批常自愈，后者重试无用。
    this.responseFailures = 0;
    this.agentGeneration = 0;
    this.controller = null;
    this.settings = null;
    // 正在跑的那一轮采集循环。点停止之后要靠它等收尾。
    this.loop = null;
    // 没点筛选之前也得有个池子：空池的 hasKey() 是 false，跟没填 Key 一样走透传。
    this.pool = new ModelPool(null);
    this.requirement = "";
    this.refreshAfterMs = 0;
    // 这次在盯的那一到两个页面，每个自带一套采集状态（见 newSource）。
    this.sources = [];
    // 上一批筛的是哪个源，两个源靠它轮流上。
    this.lastBatchOrigin = "";
  }

  getPublicState() {
    return {
      running: this.running,
      agentRunning: this.agentRunning,
      steps: this.steps,
      articles: this.articles,
      rawItems: this.rawPreview(),
      rawTotal: this.rawItems.length,
      summary: this.summary,
      pending: this.queueSize(),
      screened: this.screenedTotal,
      sources: this.publicSources(),
    };
  }

  // 界面按这份列表分块，条目靠 originId 归位。
  publicSources() {
    return this.sources.map((source) => ({
      id: source.id,
      label: source.label,
      url: source.url,
      total: source.total,
      dead: source.dead,
    }));
  }

  // 面板只要文本，排序要靠时间，所以内部按对象存，对外发的是精简过的。只盯一个页面时
  // 不必在每条前面重复同一个站名。
  rawPreview() {
    const multi = this.sources.length > 1;
    return this.rawItems.slice(0, RAW_PREVIEW).map((item) => ({
      text: item.text,
      origin: multi ? item.origin || "" : "",
    }));
  }

  queueSize() {
    return this.pending.length + this.backlog.length;
  }

  // 清空数据库时连界面上这些一起收掉。采集和筛选本身不停，新采到的照旧往里写。
  clearOutputs() {
    // 推进代次，让已经发给模型、还在路上的那一批作废。不然清空之后几秒，那批回来照旧
    // 往列表里塞卡片、往归档里写文件，看着像是没删干净。
    this.agentGeneration += 1;
    this.articles = [];
    this.articleTotal = 0;
    this.screenedTotal = 0;
    this.rawItems = [];
    this.collected = [];
    this.pending = [];
    this.backlog = [];
    for (const source of this.sources) {
      source.total = 0;
    }
    this.emit({ type: "articles", articles: [] });
    this.emit({ type: "sources", sources: this.publicSources() });
    this.emit({ type: "raw", items: [], total: 0 });
    this.emit({ type: "queue", pending: 0, agentRunning: this.agentRunning });
  }

  stop(reason = "已停止") {
    this.stopCollect(reason);
    this.stopFilter();
  }

  stopCollect(reason = "已停止") {
    if (!this.running) {
      return this.getPublicState();
    }
    this.aborted = true;
    // 这个 signal 现在管着轮询间隔的那一觉：不叫醒它，停止后还要干等最多一个间隔。
    this.controller?.abort();
    this.emit({ type: "status", running: false, message: reason });
    return this.getPublicState();
  }

  // 采集收工，把探针从盯过的页面上撤下来。留着它就是留一个 MutationObserver 和一个
  // 几秒一次的全量扫描在那儿跑，标签页不关就一直跑；反复开始停止还会一页压一份。
  async retireProbes() {
    await Promise.all(
      this.sources.map(async (source) => {
        try {
          await this.tabManager.removeLiveProbe(source.id);
        } catch {
          // 页面已经关了或跳走了，探针跟着没了，不用管
        }
      }),
    );
  }

  // 等上一轮采集循环收尾。页面那头的等待（waitForIdle）不接受取消，最坏要等它自己
  // 超时，所以这里也给个上限，别让"开始采集"这个按钮跟着一起卡住。
  async settleLoop(limitMs = SETTLE_WAIT_MS) {
    const loop = this.loop;
    if (!loop) {
      return;
    }
    await Promise.race([loop.catch(() => {}), sleep(limitMs)]);
  }

  // 每次点开始筛选，都把这次运行采到的内容按当前要求整批重过一遍。要求没变也照样重筛：
  // 点这个按钮的意思就是"重新判一次"，早退会让按钮看起来毫无反应。要求确实没改时
  // 判定会整批命中缓存，重筛很快，也不花 token。
  startFilter(task, settings) {
    this.agentController?.abort();
    this.agentGeneration += 1;
    this.settings = settings;
    this.requirement = this.readRequirement(task);
    this.agentRunning = true;
    this.agentController = new AbortController();
    this.waitFailures = 0;
    this.fatalFailures = 0;
    // 人自己点的筛选，不该还被上一轮的退避拖着等
    this.retryNotBefore = 0;
    this.responseFailures = 0;
    this.pool = this.newPool(settings);
    this.articles = [];
    this.articleTotal = 0;
    this.screenedTotal = 0;
    this.pending = [];
    this.backlog = this.buildRescreenQueue();

    this.emit({ type: "articles", articles: [] });
    this.emit({
      type: "agent-status",
      running: true,
      message: this.backlog.length
        ? `按当前要求筛这次采到的 ${this.backlog.length} 条`
        : "这次还没采到内容，先开始采集",
    });
    this.emit({ type: "queue", pending: this.queueSize(), agentRunning: true });
    void this.flushAgent();
    return this.getPublicState();
  }

  // 换主模型还是换备用模型，界面上得说一声：突然换了个模型名，判定口味和 token 花法
  // 都会变，不说的话看着像是模型不听话了。
  newPool(settings) {
    return new ModelPool(settings, (message) => {
      this.addStep("agent", "模型", message);
      this.emit({ type: "agent-status", running: this.agentRunning, message, tone: "warn" });
    });
  }

  // 只排这次运行采到的。硬盘上的采集池照旧留着原始底稿，但不往筛选队列里灌：那是好
  // 几天攒下来的量，一按筛选就是几百条起步，跟面板上"这次采到多少"完全对不上；何况
  // 判定是按要求分开缓存的，改一次要求就得把那几百条全部重新问一遍模型。
  buildRescreenQueue() {
    return this.collected.slice().sort(byNewestFirst);
  }

  // tone 是给状态栏用的：出岔子停下来的和手点停止的，看着不该一个样。
  stopFilter(reason = "已停止筛选", tone = "") {
    if (!this.agentRunning) {
      return this.getPublicState();
    }
    this.agentRunning = false;
    this.agentController?.abort();
    this.agentController = null;
    this.emit({ type: "agent-status", running: false, message: reason, tone });
    return this.getPublicState();
  }

  readRequirement(task) {
    const trimmed = String(task || "").trim();
    if (!trimmed || looksLikeUrl(trimmed)) {
      return "输出最新文章的标题和摘要";
    }
    return trimmed;
  }

  async start(task, settings, tabIds) {
    // 刚点过停止的话，循环可能还在收尾——最后一次等待已经被叫醒，但页面那边的
    // waitForIdle 还没回来。界面上写着"已停止"，这时候再点开始理应能开，不该顶一句
    // "正在抓取"回去。等它自己落定，等不到就当它卡住了，照旧往下走。
    if (this.running && this.aborted) {
      await this.settleLoop();
    }
    if (this.running) {
      this.emit({ type: "error", message: "正在抓取" });
      throw new Error("正在抓取");
    }

    this.running = true;
    this.aborted = false;
    this.steps = [];
    this.stepIndex = 0;
    this.articles = [];
    this.articleTotal = 0;
    this.screenedTotal = 0;
    this.rawItems = [];
    this.collected = [];
    this.pending = [];
    this.backlog = [];
    this.arrival = 0;
    this.filtering = false;
    this.waitFailures = 0;
    this.fatalFailures = 0;
    this.retryNotBefore = 0;
    this.responseFailures = 0;
    this.summary = "";
    this.settings = settings;
    this.pool = this.newPool(settings);
    this.sources = [];
    this.lastBatchOrigin = "";
    this.refreshAfterMs = Math.max(0, Number(settings.refreshSeconds) || 0) * 1000;
    this.requirement = this.readRequirement(task);
    this.controller = new AbortController();
    this.tabManager.showCollector();
    this.emit({ type: "reset" });
    this.emit({ type: "articles", articles: [] });
    this.emit({ type: "status", running: true, message: "采集已开始" });

    // 收尾事件必须等 running 落回 false 再发，否则监听方读到的还是"仍在采集"。
    let failure = null;
    try {
      // 留个把手给下一次 start：点停止之后它得等这一轮真收完再开。
      this.loop = this.run(String(task || "").trim(), settings, tabIds);
      await this.loop;
    } catch (error) {
      failure = error;
    }
    this.loop = null;
    this.running = false;
    this.controller = null;
    await this.retireProbes();

    if (!failure) {
      this.emit({ type: "status", running: false, message: this.summary || "采集结束" });
      return this.getPublicState();
    }
    if (this.aborted || failure.name === "AbortError") {
      this.emit({ type: "status", running: false, message: "已停止" });
      return this.getPublicState();
    }
    this.emit({ type: "error", message: failure.message });
    throw failure;
  }

  async run(task, settings, tabIds) {
    if (looksLikeUrl(task) || task.startsWith("http")) {
      await this.open(normalizeNavigationInput(task), "打开要监听的页面");
    }

    this.sources = await this.resolveSources(tabIds);
    if (!this.sources.length) {
      throw new Error("请先打开一个网页，再开始采集。");
    }

    this.emit({ type: "sources", sources: this.publicSources() });
    this.addStep(
      "collect",
      this.sources.map((source) => source.label).join(" + "),
      this.sources.length > 1 ? `同时盯着这 ${this.sources.length} 个页面` : "开始盯这个页面",
    );
    await Promise.all(this.sources.map((source) => this.tabManager.scrollToTop(source.id)));

    const maxMinutes = Math.max(0, Number(settings?.maxMinutes) || 0);
    const deadline = maxMinutes ? Date.now() + maxMinutes * 60000 : 0;
    let pollMs = POLL_ACTIVE_MS;
    let lastHeartbeatAt = Date.now();
    let lastStatus = "";

    for (let round = 1; !deadline || Date.now() < deadline; round += 1) {
      this.assertRunning();

      // 两个页面串着采：每轮的活儿就是几次 IPC 往返，谁也不用等谁一整个轮询间隔。
      const gains = [];
      for (const source of this.sources.filter((item) => !item.dead)) {
        const gained = await this.pollGuarded(source, round);
        if (gained) {
          gains.push(`${source.label} +${gained}`);
        }
      }

      const alive = this.sources.filter((source) => !source.dead);
      if (!alive.length) {
        this.summary = "要采的页面都关掉了，采集结束。";
        return;
      }

      if (gains.length) {
        pollMs = POLL_ACTIVE_MS;
        lastStatus = "";
        this.emit({ type: "raw", items: this.rawPreview(), total: this.rawItems.length });
        this.emit({ type: "sources", sources: this.publicSources() });
        this.emit({ type: "queue", pending: this.queueSize(), agentRunning: this.agentRunning });
        this.emit({ type: "status", running: true, message: `采集到新内容：${gains.join("，")}` });
        void this.flushAgent();
      } else {
        pollMs = Math.min(POLL_IDLE_MAX_MS, pollMs + POLL_BACKOFF_MS);
        // 这个循环每 1.2 秒转一次，静默的一轮不该再把列表重播给三个渲染进程。
        if (lastStatus !== IDLE_STATUS) {
          lastStatus = IDLE_STATUS;
          this.emit({ type: "status", running: true, message: IDLE_STATUS });
        }
        if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
          lastHeartbeatAt = Date.now();
          for (const source of alive) {
            this.addStep(
              "collect",
              source.label,
              `${Math.round((Date.now() - source.lastFreshAt) / 1000)} 秒无新增，最新仍是 ${source.newestLabel || "未知"}`,
            );
          }
        }
      }

      await sleep(pollMs, this.controller?.signal);
    }

    this.summary = `已采集满 ${maxMinutes} 分钟，自动结束。`;
  }

  // 用户在面板上勾的那一到两个标签页。什么都没勾就采当前在看的这个，跟以前一样。
  // 新标签页和本地文件采不出东西，直接跳过；一个都不剩时由调用方报错。
  async resolveSources(tabIds) {
    const wanted = [...new Set((Array.isArray(tabIds) ? tabIds : []).map(String).filter(Boolean))].slice(0, SOURCE_MAX);
    const ids = wanted.length ? wanted : [this.tabManager.activeTabId].filter(Boolean);

    // 勾的另一个页面可能刚打开还在转圈，等它落定才拿得到地址和标题。
    await Promise.all(ids.map((id) => this.tabManager.waitForIdle(7000, id)));

    const sources = [];
    for (const id of ids) {
      const url = this.tabManager.getTabUrl(id);
      if (!url || url.startsWith("file://")) {
        continue;
      }
      sources.push(this.newSource(id, url));
    }
    return sources;
  }

  // 每个页面各有一套自己的进度：新旧时间、闲了多久、上次刷新和快照的时刻。混用一套的话
  // 一个页面刷得勤就会把另一个页面的静默判断带跑偏。
  //
  // 去重表也是各自一份。两个站经常转同一条新闻，共享一张表会让后到的那个站什么都采不到，
  // 那一块就空着——而分开采并不会多花 token：判定缓存按内容指纹存，同一条内容第二次送去
  // 筛选直接命中缓存。
  newSource(id, url) {
    return {
      id: String(id),
      url,
      label: sourceLabel(this.tabManager.getTabTitle(id), url),
      seen: new SeenKeys(SEEN_MAX),
      probeTotal: 0,
      total: 0,
      newestTs: 0,
      newestLabel: "",
      lastFreshAt: Date.now(),
      lastSnapshotAt: 0,
      lastRefreshAt: 0,
      selfUpdating: false,
      dead: false,
      // 连着几轮采不动了。归零的时机是"这一轮采成了"。
      failures: 0,
    };
  }

  // 采一个页面这一轮，出岔子不抛出去。
  //
  // 页面正在跳转、渲染进程崩了、脚本注进去的一半被打断——这类事随时会发生，可下一轮
  // 多半自己就好了。要是让它把异常抛到采集循环外面，一次抽风就等于整场采集收摊，另一个
  // 好着的页面跟着一起停，人不在电脑前就一直停着。所以这里兜住，坏的那一轮当没采到，
  // 接着转下一轮。连着几轮都不行才重新加载这个页面：探针跟着页面一起重建，比在原地
  // 反复试有用。
  async pollGuarded(source, round) {
    try {
      const gained = await this.pollSource(source, round);
      if (source.failures) {
        this.addStep("collect", source.label, `缓过来了，接着采（之前连着 ${source.failures} 轮没采成）`);
        source.failures = 0;
      }
      return gained;
    } catch (error) {
      // 点了停止是真要停，别在这儿兜住
      if (this.aborted || error.name === "AbortError") {
        throw error;
      }
      source.failures += 1;
      this.emit({ type: "status", running: true, message: `${source.label} 这一轮没采成，接着重试` });

      if (source.failures % SOURCE_RELOAD_AFTER === 0) {
        this.addStep("collect", source.label, `连着 ${source.failures} 轮没采成（${error.message}），重新加载页面再试`);
        await this.reloadSource(source);
      } else if (source.failures === 1) {
        // 只在头一次记：连着失败时每轮都写一条，日志会被同一句话灌满
        this.addStep("collect", source.label, `这一轮没采成：${error.message}，下一轮接着试`);
      }
      return 0;
    }
  }

  // 重新加载这个页面，顺手把探针和快照的节奏也重置了。加载本身再出岔子也不管，
  // 下一轮照旧会再试。
  async reloadSource(source) {
    try {
      this.tabManager.reloadTab(source.id);
      await this.tabManager.waitForIdle(9000, source.id);
      await this.tabManager.scrollToTop(source.id);
      // 页面重来了，探针也跟着重建。这个计数不清零的话，"探针一条都认不出才切整页
      // 文本"那条兜底路会因为重载前认出过东西而永远关着。
      source.probeTotal = 0;
      source.lastSnapshotAt = 0;
      source.lastRefreshAt = Date.now();
      source.lastFreshAt = Date.now();
    } catch (error) {
      if (this.aborted || error.name === "AbortError") {
        throw error;
      }
      this.addStep("collect", source.label, `重新加载也没成：${error.message}`);
    }
  }

  // 采一个页面这一轮，返回新增了几条。
  async pollSource(source, round) {
    if (!this.tabManager.tabFor(source.id)) {
      source.dead = true;
      this.addStep("collect", source.label, "这个标签页已经关掉了，不再采它");
      this.emit({ type: "sources", sources: this.publicSources() });
      return 0;
    }

    await this.keepOnPage(source);
    await this.tabManager.ensureLiveProbe(source.id);

    let incoming = await this.tabManager.drainLiveItems(source.id);
    source.probeTotal += incoming.length;

    // 探针负责持续监听，整页快照只用来查验证页和兜底，不必每轮都做。
    if (round === 1 || Date.now() - source.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      source.lastSnapshotAt = Date.now();
      // 直接取正文，不走 collectActivePage：那条路会顺手弹开采集面板并把整页快照
      // 广播给所有渲染进程，而这里只是自己做验证页判断和兜底切分。
      const snapshot = await this.tabManager.extractPageData(1, 20000, source.id);
      // 探针上面那一下已经把缓冲区腾空了，这里直接返回等于把那些条目永久扔掉——它们
      // 在探针那边也记过，不会再报第二遍。而"验证页"是按正文里有没有"人机验证"这类
      // 字眼判的，一条正常快讯提到这几个字就会命中。真是验证页的话探针本来就采不到
      // 东西，所以只在这一轮确实空手时才认。
      if (isBlockedPage(snapshot?.title, snapshot?.excerpt) && !incoming.length) {
        this.addStep("collect", source.label, "当前是验证页，继续等待");
        return 0;
      }
      // 只有探针在这个页面上一条都认不出来时才退化成切整页文本，
      // 否则安静的一轮会把导航、侧栏这些正文碎片当成新消息灌进来。
      // 第一轮不算：这时页面很可能还在渲染（SPA 要等接口回来），探针本来就该空手，
      // 切整页只会把半截页面剁碎灌进池子，而且这些碎片会一直留着。下次快照在十几
      // 秒后，那时探针要还是一条不认，才真的说明这页得靠切文本。
      if (!source.probeTotal && round > 1) {
        // excerpt 已经压掉换行，兜底要用原始正文才能切出条目。
        const blocks = this.splitBlocks(snapshot?.text || snapshot?.excerpt || "");
        // 探针一条不认，说明这页没有成排的条目结构。块数还少的话它就是一篇文章，
        // 拆开只会得到互相看不懂的段落，整篇当一条更有用。
        incoming =
          blocks.length && blocks.length <= FALLBACK_ARTICLE_BLOCKS
            ? [{ text: blocks.join("\n"), time: "", ts: 0, seq: 0 }]
            : blocks.slice(0, 60).map((text) => ({ text, time: "", ts: 0, seq: 0 }));
      }
    }

    const fresh = [];
    for (const item of incoming) {
      // 尾巴上那串"相似文章"在这里就剪掉，后面入池、送筛选、进档案、上界面拿到的
      // 都是这条自己的内容。留着它等于按别家转发的标题付钱，还会把判定带偏。
      const text = stripTailSection(item.text);
      const key = this.itemKey(text);
      if (!key || source.seen.has(key)) {
        continue;
      }
      source.seen.add(key);
      // key 顺着条目一路带到筛选那边当缓存指纹，省得再算一遍。
      fresh.push({ ...item, text, key });
    }
    fresh.sort((left, right) => right.ts - left.ts || right.seq - left.seq);

    if (fresh.length) {
      this.acceptFresh(source, fresh, round);
    }

    if (await this.maybeRefresh(source)) {
      source.lastRefreshAt = Date.now();
      source.lastFreshAt = Date.now();
      source.lastSnapshotAt = 0;
    }

    return fresh.length;
  }

  // 把一个页面这一轮采到的新条目记进各份列表。条目从这里开始带上来源，一路走到筛选、
  // 归档、悬浮球，界面才分得清哪块是哪个站的。
  acceptFresh(source, fresh, round) {
    if (round > 1) {
      source.selfUpdating = true;
    }
    source.lastFreshAt = Date.now();
    source.total += fresh.length;
    if (fresh[0].ts > source.newestTs) {
      source.newestTs = fresh[0].ts;
      source.newestLabel = fresh[0].time;
    }

    // fresh 已按新到旧排好，让最新的拿到最大的 arrival，时间相同时也能排在前面。
    const entries = fresh.map((item, index) => ({
      text: item.text,
      key: item.key,
      ts: item.ts,
      arrival: this.arrival + (fresh.length - index),
      origin: source.label,
      originId: source.id,
      originUrl: source.url,
    }));
    this.arrival += fresh.length;

    // 这几份列表都不能只往队首插。页面往下滚会加载出更早的内容，那一轮采到的
    // 就比之前采到的旧，插队首等于把旧的顶到最前面；截断时也会先丢掉真正新的。
    this.rawItems.push(
      ...fresh.map((item, index) => ({
        text: this.formatItem(item),
        ts: item.ts,
        arrival: entries[index].arrival,
        origin: source.label,
      })),
    );
    this.rawItems.sort(byNewestFirst);
    this.rawItems = trimPerSource(this.rawItems, RAW_MAX);

    this.savePool(entries);
    this.pending.push(...entries);
    this.collected.push(...entries);
    this.collected.sort(byNewestFirst);
    this.collected = trimPerSource(this.collected, RAW_MAX);
    if (this.pending.length > PENDING_MAX) {
      this.pending.sort(byNewestFirst);
      const kept = trimPerSource(this.pending, PENDING_MAX);
      const dropped = this.pending.length - kept.length;
      this.pending = kept;
      // 丢掉的是最旧的那些，选择是对的，但不说一声的话结果区少了内容却查无实据：
      // 这些条目在去重表里已经记过，不会再被采到，也就永远不会被判定。
      if (dropped) {
        this.addStep("agent", "队列排不下", `筛选跟不上采集，${dropped} 条最旧的没能送去判定`);
      }
    }

    this.addStep(
      "collect",
      source.label,
      `第 ${round} 轮新增 ${fresh.length} 条，这个站累计 ${source.total} 条，最新 ${source.newestLabel || "未知"}`,
    );
  }

  async maybeRefresh(source) {
    if (!this.refreshAfterMs) {
      return false;
    }

    const idleMs = Date.now() - source.lastFreshAt;
    // 页面自己会推送新内容时，别急着打断它。
    const threshold = source.selfUpdating ? this.refreshAfterMs * 3 : this.refreshAfterMs;
    if (idleMs < threshold || Date.now() - source.lastRefreshAt < REFRESH_MIN_GAP_MS) {
      return false;
    }

    const idleSeconds = Math.round(idleMs / 1000);
    const clicked = await this.tabManager.clickRefreshControl(source.id);
    if (clicked) {
      this.addStep("refresh", source.label, `${idleSeconds} 秒没有新内容，点了页面上的“${clicked}”`);
      await sleep(800);
      return true;
    }

    this.tabManager.reloadTab(source.id);
    await this.tabManager.waitForIdle(7000, source.id);
    await this.tabManager.scrollToTop(source.id);
    this.addStep("refresh", source.label, `${idleSeconds} 秒没有新内容，已重新加载页面`);
    return true;
  }

  // 上一批失败后定下的"下次最早什么时候能再问"。这道闸门必须在这儿把关，不能只靠那个
  // 定时器：采集每采到新内容也会叫一次筛选，而连不上模型时上一批是当场失败的、filtering
  // 已经落回 false，那一叫就当场又发一次请求。快讯站几秒一条，退避于是形同虚设，断网
  // 期间每隔一两秒就硬撞一次接口。到点了自然有那个定时器来叫。
  async flushAgent() {
    if (this.filtering || !this.agentRunning || !this.queueSize() || Date.now() < this.retryNotBefore) {
      return;
    }

    this.filtering = true;
    // 边筛边采到的新消息先走，点筛选那一刻攒下的那批垫在后面：几十条要跑好几分钟，
    // 不能让刚到的消息在后面干等。同一批里也是最新的先送。
    const fromPending = this.pending.length > 0;
    if (fromPending) {
      this.pending.sort(byNewestFirst);
    }
    const batch = this.takeBatch(fromPending ? this.pending : this.backlog);
    const started = Date.now();
    const generation = this.agentGeneration;
    let retryAfterMs = 0;
    this.emit({
      type: "filtering",
      active: true,
      count: batch.length,
      pending: this.queueSize(),
      model: this.pool.preferredModel(),
      // 上一批是连不上失败的，这一次就是去重连，第几回也带上。不说的话状态栏跟平常
      // 筛选长得一模一样，人看着就是"卡在那儿不动"，不知道其实一直在试。
      retry: this.waitFailures,
    });
    try {
      const result = await filterArticles({
        pool: this.pool,
        requirement: this.requirement,
        items: batch,
        pageUrl: batch[0]?.originUrl || "",
        signal: this.agentController?.signal,
      });
      if (generation !== this.agentGeneration) {
        return;
      }
      // 之前一直连不上、这批终于通了，得给个交代：状态栏上挂着"第 N 次重连失败"，
      // 不说一声就看不出到底恢复了没有。
      if (this.waitFailures) {
        this.addStep("agent", "重连成功", `试了 ${this.waitFailures} 次，模型接口通了`);
        this.emit({ type: "agent-status", running: true, message: "重连成功，继续筛选" });
      }
      this.waitFailures = 0;
      this.fatalFailures = 0;
      this.responseFailures = 0;
      this.retryNotBefore = 0;
      this.screenedTotal += batch.length;
      if (result.articles.length) {
        // 不能只往队首插：批次是按新到旧一批批送去筛的，插队首等于让越旧的批次
        // 越靠前。每批并进来之后按条目自己的时间重排一次。
        this.articles.push(...result.articles);
        this.articles.sort(byNewestFirst);
        this.trimArticles();
        this.articleTotal += result.articles.length;
        // 只发新增的这几篇。跑久了整份列表有上千篇，每批都重播一遍等于
        // 让 IPC 流量随已输出篇数线性增长，渲染层也得把卡片全部重建。
        this.emit({ type: "articles", fresh: result.articles });
        this.archiveArticles(result.articles);
      }
      this.addStep(
        "agent",
        this.filterLabel(result),
        this.filterDetail(result, batch.length),
        Date.now() - started,
        result.usedModel ? Date.now() - started : 0,
      );
    } catch (error) {
      if (error.name === "AbortError" || generation !== this.agentGeneration) {
        return;
      }
      retryAfterMs = this.requeueFailedBatch(batch, error, fromPending);
    } finally {
      this.filtering = false;
      this.emit({
        type: "filtering",
        active: false,
        count: batch.length,
        pending: this.queueSize(),
        screened: this.screenedTotal,
        model: this.pool.preferredModel(),
      });
      if (this.queueSize() && this.agentRunning) {
        if (retryAfterMs) {
          setTimeout(() => void this.flushAgent(), retryAfterMs);
        } else {
          void this.flushAgent();
        }
      }
    }
  }

  // 列表已经按新到旧排好，从头数够数了就把这个来源后面的丢掉。
  trimArticles() {
    const counts = new Map();
    this.articles = this.articles.filter((article) => {
      const id = article.originId || "";
      const used = counts.get(id) || 0;
      if (used >= ARTICLES_PER_SOURCE) {
        return false;
      }
      counts.set(id, used + 1);
      return true;
    });
  }

  // 一批只装同一个源的条目：送去筛的时候要连着"这是哪个页面"一起告诉模型，混着送就没法
  // 说清楚了。两个源轮着来，一个站刷得再勤也压不住另一个站——不然快的那个能把慢的那个
  // 一直堵在队尾，界面上就成了只有一块在出结果。
  // 每批条数走设置。关掉思考模式后单批耗时降了一个量级，8 条的默认值偏保守；
  // 想省请求次数的人可以在设置里调大（写入时已钳制在 1~32）。
  takeBatch(queue) {
    const limit = Math.max(1, Math.round(Number(this.settings?.batchSize) || BATCH_SIZE));
    const ids = [...new Set(queue.map((item) => item.originId || ""))];
    if (!ids.length) {
      return [];
    }
    // 从上次筛过的那个源之后接着轮；上次那个源已经空了也不影响，indexOf 给 -1 就从头来。
    const pick = ids[(ids.indexOf(this.lastBatchOrigin) + 1) % ids.length];
    this.lastBatchOrigin = pick;

    const batch = [];
    for (let index = 0; index < queue.length && batch.length < limit; ) {
      if ((queue[index].originId || "") === pick) {
        batch.push(queue.splice(index, 1)[0]);
      } else {
        index += 1;
      }
    }
    return batch;
  }

  // 这一批已经从队列里取走了，模型报错时必须放回去，否则一次超时或 429
  // 就等于把这 8 条内容永久丢掉。
  //
  // 放回去之后分两条路走。网络类的（连不上、超时、限流、对面 5xx）一直等着重连，
  // 间隔翻着涨到一分钟为止：网断了是外面的事，人回来时该看到筛选自己续上了，而不是
  // 早就停在那儿。Key 或模型名不对这种重试也没用，模型池已经把备用的也试过一遍了，
  // 连着几次都这样就停下来，让人去改设置，队列原样留着。
  requeueFailedBatch(batch, error, fromPending = true) {
    if (fromPending) {
      this.pending.push(...batch);
      if (this.pending.length > PENDING_MAX) {
        this.pending.sort(byNewestFirst);
        this.pending.length = PENDING_MAX;
      }
    } else {
      // 重筛队列不截断，退回队首下一轮接着重试这一批。
      this.backlog.unshift(...batch);
    }
    this.emit({ type: "queue", pending: this.queueSize(), agentRunning: this.agentRunning });

    // 三种失败分开数。网断了攒的那些次数不该把"配置有问题"的容忍额度提前耗光——
    // 断网半小时之后 Key 恰好也填错了，那也该有完整的几次机会才判死刑。
    // response（模型答非所问）有自己的宽松额度，见 RESPONSE_RETRY_MAX。
    const waiting = error.kind === "network" || error.kind === "rate";
    const unruly = error.kind === "response" && !waiting;
    if (waiting) {
      this.waitFailures += 1;
    } else if (unruly) {
      this.responseFailures += 1;
    } else {
      this.fatalFailures += 1;
    }

    // fatal 还是那 3 次的上限，但 response 的连击不该把它喂满——那种错重试是常态，
    // 真正的配置错误在它自己那份额度里先到顶了才轮得到这里拦。连着答非所问到上限，
    // 才停下来：多半是这批要求或内容把模型带进了死胡同。
    if (unruly && this.responseFailures < RESPONSE_RETRY_MAX) {
      const tries = this.responseFailures;
      const retryAfterMs = Math.min(FILTER_RETRY_MAX_MS, FILTER_RETRY_BASE_MS * tries);
      const seconds = Math.round(retryAfterMs / 1000);
      this.retryNotBefore = Date.now() + retryAfterMs;
      this.addStep(
        "agent",
        `模型输出异常（第 ${tries} 次）`,
        `${error.message}；这 ${batch.length} 条已退回队列，${seconds} 秒后换一批再试`,
      );
      this.emit({
        type: "agent-status",
        running: true,
        tone: "warn",
        message: `模型输出异常，${seconds} 秒后重试（第 ${tries} 次）`,
      });
      return retryAfterMs;
    }

    if (!waiting && !unruly && this.fatalFailures >= FILTER_FATAL_MAX) {
      this.addStep("agent", "筛选已暂停", `连续 ${this.fatalFailures} 次失败：${error.message}`);
      this.stopFilter(`筛选失败已暂停：${error.message}`, "warn");
      return 0;
    }

    const tries = waiting ? this.waitFailures : this.fatalFailures + this.responseFailures;
    const retryAfterMs = Math.min(FILTER_RETRY_MAX_MS, FILTER_RETRY_BASE_MS * tries);
    const seconds = Math.round(retryAfterMs / 1000);
    // 这个时刻之前谁来叫都不发请求，见 flushAgent
    this.retryNotBefore = Date.now() + retryAfterMs;

    // 累计的第一次是断连本身，之后每一次都是"一回重连没成"。这两件事得分开说：一直
    // 写着"连不上模型"看不出到底试过没有。
    const failedRetries = this.waitFailures - 1;
    const label = waiting
      ? failedRetries > 0
        ? `第 ${failedRetries} 次重连失败`
        : "连不上模型，等着重连"
      : "筛选失败";
    this.addStep("agent", label, `${error.message}；这 ${batch.length} 条已退回队列，${seconds} 秒后重试`);
    // 状态栏要能看出是在等重连，而不是卡死了
    this.emit({
      type: "agent-status",
      running: true,
      tone: "warn",
      message: waiting
        ? failedRetries > 0
          ? `第 ${failedRetries} 次重连失败，${seconds} 秒后再试`
          : `连不上模型，${seconds} 秒后重连`
        : `筛选失败：${error.message}`,
    });
    return retryAfterMs;
  }

  // 入池失败不能影响采集，最多是这批内容没在底稿里留下痕迹。
  savePool(entries) {
    try {
      archive.savePool(entries);
    } catch (error) {
      this.addStep("archive", "采集池写入失败", error.message);
    }
  }

  // 归档失败不能影响筛选本身，最多是这一批没入库。页面地址跟着每条走，不能用一个全局的：
  // 同时采两个站时那个全局的只会是其中一个。
  archiveArticles(articles) {
    try {
      const saved = archive.save(articles, { requirement: this.requirement });
      if (saved.added) {
        this.emit({ type: "archived", date: saved.date, added: saved.added, total: saved.total });
      }
    } catch (error) {
      this.addStep("archive", "入库失败", error.message);
    }
  }

  filterLabel(result) {
    if (result.usedModel) {
      return result.cached ? "模型筛选（部分命中缓存）" : "模型筛选";
    }
    return result.cached ? "全部命中缓存" : "规则筛选";
  }

  filterDetail(result, batchSize) {
    const parts = [
      result.articles.length
        ? `本批 ${batchSize} 条中输出 ${result.articles.length} 篇，累计 ${this.articleTotal} 篇`
        : `本批 ${batchSize} 条都不符合要求`,
    ];
    if (result.cached) {
      parts.push(`${result.cached} 条走缓存，未消耗 token`);
    }
    if (result.asked) {
      // 带上模型名：切过备用之后，日志得能看出这批是谁判的
      parts.push(`${result.asked} 条问了${result.model || "模型"}`);
    }
    if (result.usageText) {
      parts.push(result.usageText);
    }
    return parts.join("，");
  }

  // 只管这个源自己的标签页。采集期间用户尽管去别的标签页看东西，那不影响这里——
  // 但要采的这个标签页自己被点走了，就得拉回来，否则采到的不再是他挑的那个页面。
  async keepOnPage(source) {
    const current = this.tabManager.getTabUrl(source.id);
    if (current && !samePage(current, source.url)) {
      this.addStep("navigate", source.label, "离开了原页面，已拉回继续采集");
      this.tabManager.navigateTab(source.id, source.url);
      await this.tabManager.waitForIdle(7000, source.id);
    }
  }

  formatItem(item) {
    const text = String(item.text || "").trim();
    if (item.time && !HAS_TIME.test(text)) {
      return `${item.time} ${text}`;
    }
    return text;
  }

  itemKey(text) {
    return itemKey(text);
  }

  // 探针在这个页面上一条都认不出来时的兜底切分。这里切出来的东西同样要进筛选和
  // 归档，所以也不截长度。
  //
  // innerText 会把渲染时的折行一起带出来，一句话常被切成好几段，断点还落在词中间
  // （"已启动向联合" / "国支付7.25亿美元"）。所以行尾没有句末标点、长度又够一整行
  // 的，说明这句还没说完，把下一行接上去。短行不接：那是自成一体的条目或标题，
  // 粘起来反倒把粒度弄没了。
  splitBlocks(text) {
    const blocks = [];
    for (const raw of String(text || "").split(/\n+/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) {
        continue;
      }
      const last = blocks.length - 1;
      const previous = last >= 0 ? blocks[last] : "";
      const wrapped =
        previous.length >= WRAP_MIN_CHARS &&
        previous.length < WRAP_MERGE_MAX &&
        !SENTENCE_END.test(previous) &&
        !LINE_STARTS_TIME.test(line);
      if (wrapped) {
        blocks[last] = previous + line;
        continue;
      }
      blocks.push(line);
    }
    return blocks.filter((block) => block.length >= 10);
  }

  async open(url, label) {
    this.assertRunning();
    this.tabManager.navigateActive(url);
    await this.tabManager.waitForIdle();
    this.addStep("navigate", url, label);
  }

  addStep(action, input, result, actionMs = 0, modelMs = 0) {
    this.stepIndex += 1;
    const step = {
      index: this.stepIndex,
      thought: "",
      action,
      input,
      result,
      modelMs,
      actionMs,
    };
    this.steps.push(step);
    if (this.steps.length > STEP_MAX) {
      this.steps.splice(0, this.steps.length - STEP_MAX);
    }
    this.emit({ type: "step", step });
  }

  assertRunning() {
    if (this.aborted) {
      const error = new Error("已停止");
      error.name = "AbortError";
      throw error;
    }
  }
}

module.exports = { PageScraper };
