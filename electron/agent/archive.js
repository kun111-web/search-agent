const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const { writeFileAtomic } = require("../atomic-write");
const { itemKey, SeenKeys } = require("./dedup");
const { byArchivedNewestFirst } = require("./ordering");

const DIR = "archive";
const POOL_DIR = "pool";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 老档案的 time 字段是给人看的那串字（"23:25:08"、"8月22日 01:01:31"），从里面把时分抠出来。
const CLOCK_IN_LABEL = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
// 一天里能攒下的条目量级。指纹表按这个数封顶，免得盯着高频页面跑一整天把内存撑爆。
const POOL_KNOWN_MAX = 20000;
// 采集池不限条数，所以按行追加而不是重写整份文件：写入量只跟这一批新增的条数有关，
// 跟池里已经攒了多少条无关。顺带还多一层健壮性——写到一半断电只坏最后一行，
// 换成整份 JSON 就是整天的池都读不回来了。
const POOL_SAVE_DEBOUNCE_MS = 3000;
// 池子是"采到过什么"的原始底稿，程序自己不读它，重筛也只排这次运行采到的内容，
// 它的价值几乎都在最近几天。不限期留下去目录就只增不减，而唯一的清空入口又连归档
// 一起删。所以按保留期自动收掉旧池子，归档不受影响。
const POOL_KEEP_DAYS = 30;

// 归档走和池同一套账：新的一天从第一条开始就是 .jsonl 按行追加。以前是每批筛选结果回来
// 都把当天全部条目 stringify 成带缩进的 JSON 整份重写，一天几千条之后每个字节都要跟着
// 写几百遍——总写入量随条数平方涨。追加式每天的总写入量只跟入库条数成正比。
// 读的时候优先找 .jsonl，找不到才退回旧的整份 .json（只有历史那些天会有）。
//
// 旧文件不做转换除非这天又写入了新内容：到那时把旧内容连同新增的一起原子写成完整
// .jsonl，再把旧文件改名成 .json.migrated 留底（目录列表不认这个后缀）。改名的目的不是删，
// 是让"哪份是权威"只剩一个答案——两份并存的话，万一 rename 失败，读取方要自己猜谁更新。

// date -> { mtimeMs, count, latest }，只服务 listDays 的概览。
// 入库时这里跟着增量推进，打开数据库页就不用再把整天的文件重新解析一遍。
const overview = new Map();

// 采集时每批筛选结果都要并进当天的文件，逐次重读会让读盘量随文件体积
// 平方增长，所以把"当天"这一份留在内存里。只缓存一天，跨天自动换。
let hotDay = null;

function archiveDir() {
  return path.join(app.getPath("userData"), DIR);
}

// 日期来自渲染进程，直接拼进路径就能穿越到 userData 之外。
function dayFile(date) {
  if (!DATE_PATTERN.test(date)) {
    return null;
  }
  return path.join(archiveDir(), `${date}.json`);
}

function dayJsonlFile(date) {
  if (!DATE_PATTERN.test(date)) {
    return null;
  }
  return path.join(archiveDir(), `${date}.jsonl`);
}

// 必须按本地时区算。toISOString 走 UTC，东八区晚上 8 点之后就会归到第二天去。
function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// 优先按原文认条目。标题和摘要是模型现写的，同一条原文送两趟就会得到两种措辞
// （"美股三大股指高开" 和 "美股三大股指高开，道指涨0.36%…"），拿它们当指纹等于
// 认不出是同一条，档案里就多一条。原文是采下来的，跟模型措辞无关。
// itemKey 那一层还会把时间、互动计数、尾巴上的"相似文章"抹掉，同一条的不同形态
// 也能归到一处。老档案里有些条目没存原文，那才退回标题加摘要。
function fingerprint(article) {
  const basis = itemKey(article.raw) || `${article.title || ""}\u0000${article.summary || ""}`;
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

// 早先存下的档案没有 ts，只留了给人看的那串时间。档案按天分文件，把这一天和那串
// 时分拼起来就还原出时间戳了，这些老条目才排得准；只按入库时刻排的话，同一批入库的
// 几条内部就没有依据（"23:25 排在 23:48 前面"）。
function restoreStamp(item, date) {
  if (Number(item.ts) > 0) {
    return;
  }
  const clock = CLOCK_IN_LABEL.exec(String(item.time || ""));
  if (!clock) {
    return;
  }
  const [year, month, day] = date.split("-").map(Number);
  let ts = new Date(year, month - 1, day, Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)).getTime();
  if (!Number.isFinite(ts)) {
    return;
  }
  // 跨零点采到的是头一天夜里的消息，却归到了第二天的档案里，直接拼就拼到未来去了。
  // 比入库时刻还晚出一截的，按前一天算。
  const savedAt = Date.parse(item.savedAt) || 0;
  if (savedAt && ts > savedAt + 6 * 3600000) {
    ts -= 86400000;
  }
  item.ts = ts;
}

function parseLegacyJson(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function readDay(date) {
  const jsonlFile = dayJsonlFile(date);
  const legacyFile = dayFile(date);

  // 一行一个条目（JSONL）。坏行跳过——跟采集池同一个道理，断电最多坏最后一行，
  // 不该让整天都读不出来。
  if (jsonlFile) {
    let raw = "";
    try {
      raw = fs.readFileSync(jsonlFile, "utf8");
    } catch {
      // 没有 .jsonl 就往下面找旧格式
    }
    if (raw) {
      const items = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed) {
            items.push(parsed);
          }
        } catch {
          // 这一行的最后一段没写完，忽略
        }
      }
      for (const item of items) {
        restoreStamp(item, date);
      }
      items.sort(byArchivedNewestFirst);
      return { date, items };
    }
  }

  // 旧版整份 JSON：{}, 缩进、数组都在 items 字段里。
  if (legacyFile) {
    try {
      const items = parseLegacyJson(fs.readFileSync(legacyFile, "utf8"));
      for (const item of items) {
        restoreStamp(item, date);
      }
      items.sort(byArchivedNewestFirst);
      return { date, items };
    } catch {
      return { date, items: [] };
    }
  }

  return { date, items: [] };
}

// 一律按现在的算法重算，不用条目里存着的 id：那些 id 是当时的算法留下的，算法一改
// 就跟新采到的对不上，同一条内容会再入库一遍。
function knownOf(items) {
  return new Set(items.map((item) => fingerprint(item)));
}

function itemToRecord(article, meta, savedAt) {
  return {
    id: fingerprint(article),
    title: String(article.title || "").trim(),
    summary: String(article.summary || "").trim(),
    time: String(article.time || "").trim(),
    match: String(article.match || "").trim(),
    source: String(article.source || "").trim(),
    raw: String(article.raw || "").trim(),
    requirement: String(meta.requirement || "").trim(),
    // 同时采两个页面时这两样必须跟着每条走：整批共用一个地址的话，另一个站采到的
    // 内容会被记成从这个站来的。
    origin: String(article.origin || "").trim(),
    pageUrl: String(article.originUrl || meta.pageUrl || "").trim(),
    // time 是给人看的那串字，跨天、跨年就没法比大小了。排序要的是条目自己的
    // 时间戳，跟着文章一路从探针带下来。
    ts: Number(article.ts) || 0,
    savedAt,
  };
}

function encodeLines(items) {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 把这一批新条目落进当天的文件。首次给这天写入时把内存里的整份（含从旧格式迁移来的）
// 原子写成完整的 .jsonl 再让旧文件退位；之后都只追加这几行新的。
 */
function persistNewItems(date, allItems, newlySaved) {
  const file = dayJsonlFile(date);
  if (!file) {
    return false;
  }
  try {
    const existsJsonl = fileMtimeMs(file) > 0;
    if (!existsJsonl) {
      writeFileAtomic(file, encodeLines(allItems));
      const legacy = dayFile(date);
      if (legacy && fileMtimeMs(legacy) > 0) {
        try {
          fs.renameSync(legacy, `${legacy}.migrated`);
        } catch {
          // 改不成名也无所谓：读取方永远优先 .jsonl，旧文件躺着不影响正确性
        }
      }
    } else {
      fs.appendFileSync(file, encodeLines(newlySaved), "utf8");
    }
  } catch {
    return false;
  }
  // 概览条目跟着这批一起长，数据库页就不用回头再解析文件了。
  overview.set(date, {
    mtimeMs: fileMtimeMs(file),
    count: allItems.length,
    // 排过序后最新那条在头上，跟 listDays 从文件里推出来的口径一致。
    latest: allItems.length ? allItems[0].savedAt : "",
  });
  return true;
}

function hotDayFor(date) {
  if (!hotDay || hotDay.date !== date) {
    const { items } = readDay(date);
    hotDay = { date, items, known: knownOf(items) };
  }
  return hotDay;
}

function forgetDay(date) {
  overview.delete(date);
  if (hotDay && hotDay.date === date) {
    hotDay = null;
  }
}

/**
 * 把一批筛选结果并进当天的档案。同一条内容重复筛出来时只留最早那条，
 * 这样重筛、缓存回放、跨重启重采都不会把档案撑出一堆副本。
 */
function save(articles, meta = {}) {
  const incoming = (Array.isArray(articles) ? articles : []).filter(
    (article) => article && (article.title || article.summary),
  );
  const date = today();
  const { items, known } = hotDayFor(date);
  if (!incoming.length) {
    return { date, added: 0, total: items.length };
  }

  const savedAt = new Date().toISOString();
  let added = 0;
  const newlySaved = [];

  for (const article of incoming) {
    const record = itemToRecord(article, meta, savedAt);
    if (known.has(record.id)) {
      continue;
    }
    known.add(record.id);
    newlySaved.push(record);
    items.push(record);
    added += 1;
  }

  if (added) {
    // 存的时候就排好，界面、按天展开、导出就都不用各排一遍。追加进来的批次既可能比
    // 已有内容新（实时采集），也可能更旧（重筛历史），光靠 push 的先后是排不对的。
    items.sort(byArchivedNewestFirst);
    persistNewItems(date, items, newlySaved);
  }
  return { date, added, total: items.length };
}

// 当天的池：内存里只留"还没落盘的那几行"和已知指纹，条目本身不驻留内存。
let poolDay = null;
let poolTimer = null;

function poolDirPath() {
  return path.join(app.getPath("userData"), POOL_DIR);
}

function poolFile(date) {
  if (!DATE_PATTERN.test(date)) {
    return null;
  }
  return path.join(poolDirPath(), `${date}.jsonl`);
}

function readPool(date) {
  const file = poolFile(date);
  if (!file) {
    return { date, items: [] };
  }
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { date, items: [] };
  }

  const items = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.text) {
        items.push(parsed);
      }
    } catch {
      // 坏了的那一行跳过就是，不该让整天的池都读不出来
    }
  }
  return { date, items };
}

function flushPool() {
  clearTimeout(poolTimer);
  poolTimer = null;
  if (!poolDay || !poolDay.buffer.length) {
    return;
  }
  const file = poolFile(poolDay.date);
  if (!file) {
    return;
  }
  try {
    fs.mkdirSync(poolDirPath(), { recursive: true });
    fs.appendFileSync(file, `${poolDay.buffer.join("\n")}\n`, "utf8");
    poolDay.buffer.length = 0;
  } catch {
    // 池写不进去最多是这批内容没留下底稿，不该打断正在跑的采集
  }
}

function poolDayFor(date) {
  if (!poolDay || poolDay.date !== date) {
    flushPool();
    // 指纹要覆盖当天已落盘的全部条目，否则重启后页面上那些老条目会再入池一遍。
    // 一律按正文现算，不用行里存的那份：老文件里的指纹是旧算法留下的。
    const { items } = readPool(date);
    const known = new SeenKeys(POOL_KNOWN_MAX);
    for (const item of items) {
      known.add(itemKey(item.text));
    }
    poolDay = { date, buffer: [], known };
  }
  return poolDay;
}

/**
 * 记下采到的原始条目，不看筛选结果，也不限条数。归档只存判定通过的文章，被判"不符合"
 * 的那些就此没了痕迹；这份底稿留着原文，是"到底采到过什么"的唯一凭据。程序自己不读它，
 * 筛选只处理这次运行采到的内容。
 */
function savePool(items) {
  const incoming = (Array.isArray(items) ? items : []).filter((item) => item && item.text);
  if (!incoming.length) {
    return { added: 0 };
  }

  const day = poolDayFor(today());
  const savedAt = new Date().toISOString();
  let added = 0;

  for (const item of incoming) {
    const text = String(item.text || "");
    const key = itemKey(text);
    if (!key || day.known.has(key)) {
      continue;
    }
    day.known.add(key);
    day.buffer.push(JSON.stringify({ key, text, ts: Number(item.ts) || 0, origin: item.origin || "", savedAt }));
    added += 1;
  }

  if (added) {
    clearTimeout(poolTimer);
    poolTimer = setTimeout(flushPool, POOL_SAVE_DEBOUNCE_MS);
  }
  return { added };
}

function clearPool() {
  clearTimeout(poolTimer);
  poolTimer = null;
  poolDay = null;
  try {
    fs.rmSync(poolDirPath(), { recursive: true, force: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// 启动时清一次就够：池子按天落盘，跨天那一刻 poolDayFor 也不会回头碰旧文件。
// 日期取自文件名而不是 mtime——mtime 会被复制、同步这些事改乱，文件名里的日期才是
// 这批内容的真实归属。不合日期格式的名字一律不动。
function prunePool(keepDays = POOL_KEEP_DAYS) {
  let names = [];
  try {
    names = fs.readdirSync(poolDirPath());
  } catch {
    return 0;
  }
  const days = Math.max(1, Number(keepDays) || POOL_KEEP_DAYS);
  const deadline = Date.now() - days * 86400000;
  let removed = 0;
  for (const name of names) {
    const date = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
    if (!DATE_PATTERN.test(date)) {
      continue;
    }
    const [year, month, day] = date.split("-").map(Number);
    if (new Date(year, month - 1, day).getTime() < deadline) {
      try {
        fs.rmSync(path.join(poolDirPath(), name), { force: true });
        removed += 1;
      } catch {
        // 被占用就留给下次启动再试，不值得为它拦住启动
      }
    }
  }
  return removed;
}

/**
 * 日期倒序的概览。.jsonl 和旧的 .json 都认，同名日期以 .jsonl 为准（迁移只发生在有新
 * 内容要写入的那天，正常情况下两份不会同时处于活跃状态）。
 *
 * 当天那份在每次入库时已经被增推进缓存了，mtime 也一并刷新过，照旧拿 mtime 一比就能
 * 判出"没有外部改动"；历史那些天一旦写完就不会再变，同样靠 mtime 记住结果。
 * 两边都不用为了画个列表把整个归档解析一遍。
 */
function listDays() {
  let names = [];
  try {
    names = fs.readdirSync(archiveDir());
  } catch {
    overview.clear();
    return [];
  }

  // date -> 文件名，同名日期 .jsonl 优先。".json.migrated" 尾巴不是 ".json"，天然被排除。
  const holders = new Map();
  for (const name of names) {
    let date = "";
    if (name.endsWith(".jsonl")) {
      date = name.slice(0, -6);
    } else if (name.endsWith(".json")) {
      date = name.slice(0, -5);
    }
    if (!DATE_PATTERN.test(date)) {
      continue;
    }
    const holder = holders.get(date);
    if (!holder || !holder.endsWith(".jsonl")) {
      holders.set(date, name);
    }
  }

  const days = [];
  for (const [date, name] of holders) {
    const mtimeMs = fileMtimeMs(path.join(archiveDir(), name));

    let entry = overview.get(date);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      const { items } = readDay(date);
      entry = {
        mtimeMs,
        count: items.length,
        // readDay 出来就是新的在前，最新那条在头上。
        latest: items.length ? items[0].savedAt : "",
      };
      overview.set(date, entry);
    }
    if (entry.count) {
      days.push({ date, count: entry.count, latest: entry.latest });
    }
  }

  for (const date of overview.keys()) {
    if (!holders.has(date)) {
      overview.delete(date);
    }
  }

  return days.sort((left, right) => (left.date < right.date ? 1 : -1));
}

/** 按日期倒序读出全部归档，只在导出时用。 */
function readAll() {
  return listDays().map((day) => readDay(day.date));
}

function removeDay(date) {
  const files = [dayFile(date), dayJsonlFile(date)].filter(Boolean);
  if (!files.length) {
    return { ok: false };
  }
  try {
    for (const file of files) {
      fs.rmSync(file, { force: true });
    }
    forgetDay(date);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// 删除要改写整天的内容，这是唯一不走追加的路。趁今天还在热缓存里就直接在那份数组上改，
// 别用 readDay 另抄一份——用户点删除的那几秒正赶上批次入库的话，另抄的快照会把刚进来的
// 那几条写丢。
function rewriteDaySmaller(date, kept) {
  const file = dayJsonlFile(date);
  if (!file) {
    return false;
  }
  try {
    if (kept.length) {
      writeFileAtomic(file, encodeLines(kept));
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch {
    return false;
  }
  return true;
}

function removeItem(date, id) {
  const { items } = hotDayFor(date);
  const kept = items.filter((item) => item.id !== id);
  if (kept.length === items.length) {
    return { ok: false, remaining: items.length };
  }
  if (!rewriteDaySmaller(date, kept)) {
    return { ok: false, remaining: items.length };
  }
  // 整天都删空了就把文件也收掉，免得列表里留一堆 0 条的日期。
  hotDay = kept.length ? { date, items: kept, known: knownOf(kept) } : null;
  overview.delete(date);
  return { ok: true, remaining: kept.length };
}

function clearAll() {
  overview.clear();
  hotDay = null;
  // 采集池一起清掉。用户点的是"清空全部数据"，池里那份原文底稿也算数据，
  // 只清归档等于内容还留着一份。
  const pool = clearPool();
  try {
    fs.rmSync(archiveDir(), { recursive: true, force: true });
    return { ok: pool.ok };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  today,
  save,
  listDays,
  readAll,
  readDay,
  removeDay,
  removeItem,
  clearAll,
  savePool,
  clearPool,
  flushPool,
  prunePool,
};
