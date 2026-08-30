const statusEl = document.querySelector("#status");
const startBtn = document.querySelector("#start");
const stopBtn = document.querySelector("#stop");
const agentStartBtn = document.querySelector("#agent-start");
const agentStopBtn = document.querySelector("#agent-stop");
const taskEl = document.querySelector("#task");
const stepsEl = document.querySelector("#steps");
const rawEl = document.querySelector("#raw-items");
const articlesEl = document.querySelector("#articles");
const picksEl = document.querySelector("#tab-picks");
const collectMeta = document.querySelector("#collect-meta");
const agentMeta = document.querySelector("#agent-meta");
const settingsHint = document.querySelector("#settings-hint");
const cacheHint = document.querySelector("#cache-hint");
const cacheHintBase = cacheHint.textContent;

const archiveMeta = document.querySelector("#archive-meta");
const archiveDaysEl = document.querySelector("#archive-days");
const archiveExportBtn = document.querySelector("#archive-export");
const archiveHint = document.querySelector("#archive-hint");
const archiveHintBase = archiveHint.textContent;

const panels = {
  task: document.querySelector("#panel-task"),
  archive: document.querySelector("#panel-archive"),
  settings: document.querySelector("#panel-settings"),
};

// 两边都只保留最近这些：主进程发来的列表本身有上限，渲染层再兜一道，
// 免得连续跑一整天把节点和数组越堆越大。分块之后这个数是每块各算的。
const STEP_KEEP = 200;
const BLOCK_KEEP = 300;
// 主进程那边也是这个数，改的话两边一起改。
const PICK_MAX = 2;

const steps = [];
// originId -> { id, items, body, count }。同时采两个页面时每块一份，各自维护自己的
// 列表和 DOM 容器，这样一块来了新内容不必把另一块也重画。
const blocks = new Map();
// 这次采的是哪几个页面，主进程按勾选顺序给过来，块序照它走。
let sources = [];
let openTabs = [];
let activeTabId = "";
// 勾了哪几个标签页。空集就是"采当前这个"。
const picked = new Set();
let pickRows = [];
let pickHint = null;
// 上一次画出来的那份列表长什么样，用来判断要不要重建。null 是"还没画过"，
// 一个标签页都没有时签名是空串，得跟"没画过"分得开。
let picksKey = null;
// 开程序默认要盯的那几个站，由主进程给。
let defaultSites = [];
// 默认那几个站只自动勾一次。勾上了、或者用户自己动过勾选，就再也不自动插手，
// 否则用户取消勾选后下一次标签页状态更新又会给他勾回去。
let autoPicked = false;
let rawItems = [];
let rawTotal = 0;
let filteringHint = "";
let agentHint = "";
let pendingCount = 0;
let agentOn = false;
let screenedCount = 0;
let collectRunning = false;

let archiveDays = [];
let exporting = false;
// 展开过的日期才去读当天正文，列表本身只带条数。
const archiveOpen = new Set();
const archiveItems = new Map();
// 列表最初只铺开最近这几天的正文；再往前是历史存档，整月整年堆在页面上会把渲染
// 拖垮。点任何一天的头部都能照样展开——这个数只是"默认摊开多少"，不是封顶。
const ARCHIVE_AUTO_OPEN_DAYS = 7;

function showTab(name) {
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = key !== name;
  }
  for (const button of document.querySelectorAll(".tab")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  if (name === "settings") {
    void renderCacheStats();
  }
  if (name === "archive") {
    void loadArchive();
  }
}

function setRunning(running, message) {
  statusEl.textContent = message || (running ? "运行中" : "未运行");
  statusEl.classList.toggle("running", running);
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  // 采集时每采到一批就来一条 status，勾选那几个框只在启停那一下改禁用状态。
  if (running !== collectRunning) {
    collectRunning = running;
    syncPicks();
  }
}

function setAgentRunning(running, message) {
  agentOn = running;
  // 始终可点：改了要求后再点一次就是按新要求重筛。
  agentStartBtn.disabled = false;
  agentStopBtn.disabled = !running;
  agentHint = message || "";
  renderArticleStatus();
}

function renderSteps() {
  const recent = steps.slice(-8).reverse();
  stepsEl.replaceChildren(
    ...recent.map((step) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = `${step.index}. ${step.action}`;
      const result = document.createElement("div");
      result.textContent = `${step.input || ""} ${step.result || ""}`.trim();
      item.append(title, result);
      return item;
    }),
  );
}

function renderRaw() {
  collectMeta.textContent = rawTotal ? `已采集 ${rawTotal} 条原始内容` : "还未开始";
  rawEl.replaceChildren(
    ...rawItems.map((entry, index) => {
      const item = document.createElement("li");
      // 只盯一个页面时主进程不带 origin，不必每条前面都顶一个同样的站名。
      item.textContent = `${index + 1}. ${entry.origin ? `[${entry.origin}] ` : ""}${entry.text}`;
      return item;
    }),
  );
}

// 能采的只有真网页。新标签页和本地文件页采不出东西，不摆出来让人误勾。
function pickableTabs() {
  return openTabs.filter((tab) => !tab.isNewTab && /^https?:/i.test(tab.url || ""));
}

// 跟主进程 default-sites.js 里同一把尺子：只比主机名。默认地址带着 #/ 这样的前端路由，
// 用户在站内点两下地址就变了，一字不差地比会认不出这还是同一个站。
function tabHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// 按默认列表的顺序勾，勾出来的顺序决定界面上的块序。
function applyDefaultPicks() {
  if (autoPicked || !defaultSites.length) {
    return;
  }
  const tabs = pickableTabs();
  for (const site of defaultSites) {
    if (picked.size >= PICK_MAX) {
      break;
    }
    const host = tabHost(site.url);
    const tab = tabs.find((item) => !picked.has(item.id) && tabHost(item.url) === host);
    if (tab) {
      picked.add(tab.id);
    }
  }
  // 差一个就等下一轮再补：刚开程序时两个默认页往往一快一慢，慢的那个地址还没定下来，
  // 这会儿就收手会永远少勾一个。凑齐了才不再插手，用户自己动勾选也算收手。
  if (picked.size >= Math.min(defaultSites.length, PICK_MAX)) {
    autoPicked = true;
  }
}

function pickLabel(tab) {
  const name = tab.title || tab.displayUrl || tab.url;
  return tab.id === activeTabId ? `${name}（当前）` : name;
}

function hintLine(text) {
  return Object.assign(document.createElement("p"), { className: "hint", textContent: text });
}

// 勾了几个决定别的还能不能点，以及下面那行提示怎么写。只改这两样，不重建列表：重建会把
// 焦点弄丢，连着点两下时后一下还会落在已经被换掉的那个节点上。
function syncPicks() {
  const chosen = pickRows.filter(({ tab }) => picked.has(tab.id)).length;
  for (const { tab, box } of pickRows) {
    box.checked = picked.has(tab.id);
    // 勾满两个之后其余的就点不动了，免得点了没反应又不知道为什么。
    box.disabled = collectRunning || (!box.checked && chosen >= PICK_MAX);
  }
  if (pickHint) {
    pickHint.textContent = chosen
      ? `这次采勾中的 ${chosen} 个页面`
      : `不勾就采当前这个页面，最多可以勾 ${PICK_MAX} 个`;
  }
}

// 列表长什么样。标签页状态变一次就来一条广播（标题变了、图标变了、开始或结束加载、
// SPA 换路由都算），采集期间页面自动刷新那几秒能来好几条。只要这份签名没变就不重建，
// 免得用户正按着勾选框的时候节点被换掉——那一下的 click 不成立，看着就是"点了没反应"。
function picksSignature(tabs) {
  return tabs.map((tab) => `${tab.id}\u0000${pickLabel(tab)}`).join("\n");
}

// 勾选的意义是"这次采哪几个页面"，所以采集跑起来之后就不给改了：中途换页面会让已经采到的
// 内容归属对不上。停下来重新点开始就能换。
function renderPicks() {
  const tabs = pickableTabs();
  const signature = picksSignature(tabs);
  if (picksKey === signature) {
    // 行还是那几行，只把勾选状态和提示刷一遍
    syncPicks();
    return;
  }
  picksKey = signature;
  pickRows = [];
  pickHint = null;
  if (!tabs.length) {
    picksEl.replaceChildren(hintLine("先在标签页里打开要采的网页，这里就能勾了。"));
    return;
  }

  const rows = tabs.map((tab) => {
    const row = document.createElement("label");
    row.className = "pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      // 用户自己动过手，之后就别再替他勾了
      autoPicked = true;
      if (box.checked) {
        picked.add(tab.id);
      } else {
        picked.delete(tab.id);
      }
      syncPicks();
    });
    const text = document.createElement("span");
    text.textContent = pickLabel(tab);
    row.append(box, text);
    pickRows.push({ tab, box });
    return row;
  });

  pickHint = hintLine("");
  picksEl.replaceChildren(...rows, pickHint);
  syncPicks();
}

function articleTotal() {
  let total = 0;
  for (const block of blocks.values()) {
    total += block.items.length;
  }
  return total;
}

function allArticles() {
  return orderedBlocks().flatMap((block) => block.items);
}

function articleMeta() {
  if (filteringHint) {
    return filteringHint;
  }
  const bits = [];
  if (agentHint) {
    bits.push(agentHint);
  }
  const total = articleTotal();
  if (total) {
    bits.push(`已输出 ${total} 篇`);
  } else if (screenedCount) {
    bits.push(`已筛 ${screenedCount} 条 · 0 篇符合`);
  }
  if (pendingCount) {
    bits.push(agentOn ? `队列 ${pendingCount} 条` : `${pendingCount} 条待筛选`);
  }
  return bits.join(" · ") || (agentOn ? "等待符合要求的文章" : "筛选未开启");
}

function articlePlaceholder() {
  if (filteringHint) {
    return "Agent 正在筛选，稍等一下。";
  }
  if (!agentOn) {
    return "采集到内容后，点「开始筛选」让 Agent 按上面的要求输出文章。";
  }
  // 判过一批却一篇都没留下，是要求太窄，不是还没开始。这两种情况看起来一模一样，
  // 不说清楚就会以为筛选坏了。
  if (screenedCount) {
    return `已经筛过 ${screenedCount} 条，都不符合当前要求。想放宽就改上面的要求，再点一次「开始筛选」。`;
  }
  return "Agent 已开启，采集到新内容就会筛选并写到这里。";
}

function buildArticleCard(article) {
  const card = document.createElement("article");
  const title = document.createElement("strong");
  title.textContent = article.title || "未命名";
  const summary = document.createElement("p");
  summary.className = "excerpt";
  summary.textContent = article.summary || "";
  const meta = document.createElement("div");
  meta.className = "url";
  meta.textContent = [article.time, article.match].filter(Boolean).join(" · ");
  card.append(title, summary, meta);
  return card;
}

function blockFor(id) {
  let block = blocks.get(id);
  if (!block) {
    block = { id, items: [], body: null, head: null };
    blocks.set(id, block);
  }
  return block;
}

// 块序跟着勾选顺序走，不按"哪个站先出结果"排——那样每次跑起来的排布都可能不一样。
// 排在后面的是归不到当前这几个源的，多半是上一轮采别的页面时筛出来的，兜住别让它们
// 从界面上消失。
function orderedBlocks() {
  const known = new Set();
  const ordered = [];
  for (const source of sources) {
    known.add(source.id);
    const block = blocks.get(source.id);
    if (block) {
      ordered.push(block);
    }
  }
  for (const [id, block] of blocks) {
    if (!known.has(id) && block.items.length) {
      ordered.push(block);
    }
  }
  return ordered;
}

function blockTitle(block) {
  const label = sources.find((source) => source.id === block.id)?.label || "之前采到的";
  return `${label} · ${block.items.length} 篇`;
}

function buildBlock(block) {
  const section = document.createElement("section");
  section.className = "art-block";
  const head = document.createElement("header");
  head.textContent = blockTitle(block);
  const body = document.createElement("div");
  body.className = "notes";
  body.append(...block.items.map(buildArticleCard));
  block.head = head;
  block.body = body;
  section.append(head, body);
  return section;
}

// 筛选进度、队列长度这些只改上面那行说明文字。列表非空时一个节点都不用动，
// 否则「正在筛选/筛完了」每批来两趟，每趟都把整列卡片重建一遍。
function renderArticleStatus() {
  agentMeta.textContent = articleMeta();
  if (!articleTotal()) {
    articlesEl.textContent = articlePlaceholder();
  }
}

function renderArticles() {
  agentMeta.textContent = articleMeta();
  const ordered = orderedBlocks();
  if (!articleTotal()) {
    // 容器整个被换成一行说明文字了，各块记着的 DOM 引用都作废。
    for (const block of blocks.values()) {
      block.body = null;
      block.head = null;
    }
    articlesEl.textContent = articlePlaceholder();
    return;
  }

  // 只有一块内容时不套分块的壳：单独一个站名顶在上面没有信息量。
  if (ordered.length < 2) {
    const only = ordered[0];
    only.head = null;
    only.body = articlesEl;
    articlesEl.replaceChildren(...only.items.map(buildArticleCard));
    return;
  }

  articlesEl.replaceChildren(...ordered.map(buildBlock));
}

// 与主进程同一把尺子：内容自己的时间优先，其次是到达先后。这边只排不判，主进程送来
// 的每篇都带着这两个字段。
function byNewestFirst(left, right) {
  return (right.ts || 0) - (left.ts || 0) || (right.arrival || 0) - (left.arrival || 0);
}

// 并进一块之后要重排：批次是按新到旧一批批筛的，光往队首插会让越旧的批次越靠前，
// 重筛历史时整块都是倒的。
//
// 排完通常新的那几篇正好落在这块的最前面，返回真表示这种情形，往 DOM 头上插几个节点
// 就够了。跑一整天列表有上千篇，每批都整块重建光是造 DOM 就够让面板卡住。并进来的内容
// 插到了中间（重筛历史、页面往下滚出更早的内容），或者这块还没画出来，就得整块重画。
function mergeBlock(block, fresh) {
  const previous = block.items.slice();
  block.items.push(...fresh);
  block.items.sort(byNewestFirst);
  if (block.items.length > BLOCK_KEEP) {
    block.items.length = BLOCK_KEEP;
  }
  if (!block.body || !previous.length) {
    return false;
  }
  return (
    block.items.slice(0, fresh.length).every((article) => fresh.includes(article)) &&
    block.items.slice(fresh.length).every((article, index) => article === previous[index])
  );
}

function mergeArticles(fresh) {
  if (!fresh.length) {
    return;
  }

  // 一批筛的都是同一个页面的内容，但重筛时两个源的批次会交替回来，这里照样按来源分开并。
  const grouped = new Map();
  for (const article of fresh) {
    const id = article.originId || "";
    if (!grouped.has(id)) {
      grouped.set(id, []);
    }
    grouped.get(id).push(article);
  }

  const prependable = [];
  let repaint = false;
  for (const [id, items] of grouped) {
    if (mergeBlock(blockFor(id), items)) {
      prependable.push([blockFor(id), items.length]);
    } else {
      repaint = true;
    }
  }

  // 有一块要重画就整个重画：新出现的块会改变块序和结构，只补另一块的头部补不出来。
  if (repaint) {
    renderArticles();
    return;
  }

  agentMeta.textContent = articleMeta();
  for (const [block, count] of prependable) {
    block.body.prepend(...block.items.slice(0, count).map(buildArticleCard));
    while (block.body.children.length > BLOCK_KEEP) {
      block.body.lastElementChild.remove();
    }
    if (block.head) {
      block.head.textContent = blockTitle(block);
    }
  }
}

function setArticles(list) {
  blocks.clear();
  for (const article of list) {
    blockFor(article.originId || "").items.push(article);
  }
  for (const block of blocks.values()) {
    block.items.sort(byNewestFirst);
    if (block.items.length > BLOCK_KEEP) {
      block.items.length = BLOCK_KEEP;
    }
  }
  renderArticles();
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "reset":
      steps.length = 0;
      blocks.clear();
      sources = [];
      rawItems = [];
      rawTotal = 0;
      filteringHint = "";
      pendingCount = 0;
      screenedCount = 0;
      renderSteps();
      renderRaw();
      renderArticles();
      break;
    // 这次采的是哪几个页面。块序、块标题都跟着它变，来了就重画一次。
    case "sources":
      sources = event.sources || [];
      renderArticles();
      break;
    case "status":
      setRunning(Boolean(event.running), event.message);
      break;
    case "step":
      steps.push(event.step);
      if (steps.length > STEP_KEEP) {
        steps.splice(0, steps.length - STEP_KEEP);
      }
      renderSteps();
      break;
    case "raw":
      rawItems = event.items || [];
      rawTotal = event.total || 0;
      renderRaw();
      break;
    // 带 fresh 的是增量，带 articles 的是整份替换（重筛清空、恢复现场）。
    case "articles":
      if (event.fresh) {
        mergeArticles(event.fresh);
      } else {
        // 整份替换只发生在换要求重筛、重新开始采集这些时刻，旧判定作废，计数归零
        screenedCount = 0;
        setArticles(event.articles || []);
      }
      break;
    case "filtering":
      pendingCount = event.pending;
      // 开始筛的那条事件不带 screened，别把已有计数抹成 undefined
      screenedCount = event.screened ?? screenedCount;
      // 上一批连不上模型的话，这一次是在重连。写清楚是第几回，否则跟平常筛选一个样，
      // 看着就像卡住了。
      filteringHint = event.active
        ? event.retry
          ? `正在重连模型（第 ${event.retry} 次）…`
          : `Agent 正在筛选 ${event.count} 条${event.pending ? `，队列还有 ${event.pending} 条` : ""}…`
        : "";
      renderArticleStatus();
      break;
    case "agent-status":
      setAgentRunning(Boolean(event.running), event.message);
      break;
    case "queue":
      pendingCount = event.pending;
      renderArticleStatus();
      break;
    case "archived":
      // 只有正看着数据库页时才值得重画，否则等切过去时再拉。
      if (!panels.archive.hidden) {
        void loadArchive();
      }
      break;
    case "error":
      agentMeta.textContent = event.message || "出错了";
      setRunning(false, "出错");
      break;
    default:
      console.warn("未处理的 agent 事件", event.type);
      break;
  }
}

function todayString() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function archiveSummary() {
  if (!archiveDays.length) {
    return "还没有入库的内容";
  }
  const total = archiveDays.reduce((sum, day) => sum + day.count, 0);
  return `${archiveDays.length} 天 · 共 ${total} 篇`;
}

function buildArchiveItem(date, item) {
  const card = document.createElement("article");

  const head = document.createElement("div");
  head.className = "item-head";
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "删除";
  remove.addEventListener("click", () => void deleteArchiveItem(date, item.id));
  head.append(title, remove);
  card.append(head);

  if (item.summary) {
    const summary = document.createElement("p");
    summary.className = "full";
    summary.textContent = item.summary;
    card.append(summary);
  }
  // 摘要是模型转述的，原文才是采到的原话。旧归档里没存 raw，那就只有摘要。
  if (item.raw && item.raw !== item.summary) {
    const raw = document.createElement("p");
    raw.className = "full url";
    raw.textContent = item.raw;
    card.append(raw);
  }

  const meta = document.createElement("div");
  meta.className = "url";
  meta.textContent = [item.time, item.origin, item.source, item.match, item.requirement && `要求：${item.requirement}`]
    .filter(Boolean)
    .join(" · ");
  card.append(meta);

  return card;
}

function buildArchiveDay(day) {
  const open = archiveOpen.has(day.date);
  const wrap = document.createElement("section");
  wrap.className = "day";

  const head = document.createElement("div");
  head.className = "day-head";
  head.addEventListener("click", (event) => {
    if (event.target.tagName !== "BUTTON") {
      void toggleArchiveDay(day.date);
    }
  });

  const caret = document.createElement("span");
  caret.className = "day-caret";
  caret.textContent = open ? "▾" : "▸";

  const date = document.createElement("span");
  date.className = "day-date";
  date.textContent = day.date === todayString() ? `${day.date}（今天）` : day.date;

  const count = document.createElement("span");
  count.className = "day-count";
  count.textContent = `${day.count} 篇`;

  const exportDay = document.createElement("button");
  exportDay.type = "button";
  exportDay.className = "ghost";
  exportDay.textContent = "导出";
  exportDay.addEventListener("click", () => void runExport(day.date));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "删除这天";
  remove.addEventListener("click", () => void deleteArchiveDay(day.date));

  head.append(caret, date, count, exportDay, remove);
  wrap.append(head);

  if (open) {
    const body = document.createElement("div");
    body.className = "day-body";
    body.append(...(archiveItems.get(day.date) || []).map((item) => buildArchiveItem(day.date, item)));
    wrap.append(body);
  }

  return wrap;
}

function renderArchive() {
  archiveMeta.textContent = archiveSummary();
  archiveExportBtn.disabled = exporting || archiveDays.length === 0;
  if (!archiveDays.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "筛选出结果后会自动存到这里，按当天日期分组。";
    archiveDaysEl.replaceChildren(empty);
    return;
  }
  archiveDaysEl.replaceChildren(...archiveDays.map(buildArchiveDay));
}

async function loadArchive() {
  archiveDays = await window.browser.getArchiveDays();
  // 展开着的日期连正文一起刷新，否则删完一条视图还停在旧数据上。
  for (const date of [...archiveOpen]) {
    if (!archiveDays.some((day) => day.date === date)) {
      archiveOpen.delete(date);
      archiveItems.delete(date);
      continue;
    }
    const day = await window.browser.getArchiveDay(date);
    archiveItems.set(date, day.items || []);
  }
  // 头几次打开数据库页时把最近几天替用户摊开：这些天往往正是要看的。
  for (const day of archiveDays.slice(0, ARCHIVE_AUTO_OPEN_DAYS)) {
    if (!archiveOpen.has(day.date)) {
      archiveOpen.add(day.date);
      const full = await window.browser.getArchiveDay(day.date);
      archiveItems.set(day.date, full.items || []);
    }
  }
  renderArchive();
}

// 不传日期就是导出全部。保存框由主进程弹，这里只负责别让用户连点。
async function runExport(date) {
  if (exporting) {
    return;
  }
  exporting = true;
  archiveExportBtn.disabled = true;
  archiveHint.textContent = date ? `正在导出 ${date}…` : "正在导出全部…";
  try {
    const result = await window.browser.exportArchive(date);
    if (result.canceled) {
      archiveHint.textContent = archiveHintBase;
    } else if (result.ok) {
      archiveHint.textContent = `已导出 ${result.itemCount} 篇（${result.dayCount} 天）到 ${result.path}`;
    } else {
      archiveHint.textContent = result.message || "导出失败。";
    }
  } catch (error) {
    archiveHint.textContent = error.message || "导出失败。";
  } finally {
    exporting = false;
    archiveExportBtn.disabled = archiveDays.length === 0;
  }
}

async function toggleArchiveDay(date) {
  if (archiveOpen.has(date)) {
    archiveOpen.delete(date);
    renderArchive();
    return;
  }
  archiveOpen.add(date);
  const day = await window.browser.getArchiveDay(date);
  archiveItems.set(date, day.items || []);
  renderArchive();
}

// 删除都要过主进程的确认弹窗，用户点了取消就什么都别动。
async function deleteArchiveDay(date) {
  const result = await window.browser.removeArchiveDay(date);
  if (result?.cancelled) {
    return;
  }
  archiveOpen.delete(date);
  archiveItems.delete(date);
  await loadArchive();
}

async function deleteArchiveItem(date, id) {
  const result = await window.browser.removeArchiveItem(date, id);
  if (result?.cancelled) {
    return;
  }
  await loadArchive();
}

async function renderCacheStats() {
  const { size } = await window.browser.getCacheStats();
  cacheHint.textContent = size ? `${cacheHintBase}当前已缓存 ${size} 条判定。` : cacheHintBase;
}

async function loadSettings() {
  const settings = await window.browser.getSettings();
  document.querySelector("#base-url").value = settings.baseUrl;
  document.querySelector("#model").value = settings.model;
  document.querySelector("#api-key").value = settings.apiKey;
  document.querySelector("#api-format").value = settings.apiFormat || "chat";
  document.querySelector("#fallback-base-url").value = settings.fallbackBaseUrl;
  document.querySelector("#fallback-model").value = settings.fallbackModel;
  document.querySelector("#fallback-api-key").value = settings.fallbackApiKey;
  document.querySelector("#fallback-api-format").value = settings.fallbackApiFormat || "chat";
  document.querySelector("#max-minutes").value = String(settings.maxMinutes);
  document.querySelector("#refresh-seconds").value = String(settings.refreshSeconds);
  document.querySelector("#batch-size").value = String(settings.batchSize ?? 8);
}

function readSettingsForm() {
  return {
    baseUrl: document.querySelector("#base-url").value,
    model: document.querySelector("#model").value,
    apiKey: document.querySelector("#api-key").value,
    apiFormat: document.querySelector("#api-format").value,
    fallbackBaseUrl: document.querySelector("#fallback-base-url").value,
    fallbackModel: document.querySelector("#fallback-model").value,
    fallbackApiKey: document.querySelector("#fallback-api-key").value,
    fallbackApiFormat: document.querySelector("#fallback-api-format").value,
    maxMinutes: Number(document.querySelector("#max-minutes").value),
    refreshSeconds: Number(document.querySelector("#refresh-seconds").value),
    batchSize: Number(document.querySelector("#batch-size").value),
  };
}

async function restoreAgent() {
  const state = await window.browser.getAgentState();
  setRunning(state.running, state.running ? "运行中" : "未运行");
  steps.length = 0;
  steps.push(...(state.steps || []).slice(-STEP_KEEP));
  rawItems = state.rawItems || [];
  rawTotal = state.rawTotal || rawItems.length;
  filteringHint = "";
  pendingCount = state.pending || 0;
  screenedCount = state.screened || 0;
  sources = state.sources || [];
  renderSteps();
  renderRaw();
  setAgentRunning(Boolean(state.agentRunning), "");
  setArticles(state.articles || []);
}

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.dataset.tab;
  if (tab) {
    showTab(tab);
  }
});

startBtn.addEventListener("click", async () => {
  showTab("task");
  setRunning(true, "启动中");
  await window.browser.startCollect(taskEl.value, [...picked]);
});

stopBtn.addEventListener("click", () => window.browser.stopCollect());

agentStartBtn.addEventListener("click", async () => {
  showTab("task");
  await window.browser.startFilter(taskEl.value);
});

agentStopBtn.addEventListener("click", () => window.browser.stopFilter());

document.querySelector("#minimize-orb").addEventListener("click", () => window.browser.minimizeToOrb());

document.querySelector("#copy-notes").addEventListener("click", async () => {
  const groups = orderedBlocks();
  const text = groups
    .map((block) => {
      const body = block.items
        .map((article, index) => `${index + 1}. ${article.title}\n${article.summary}\n${article.match || ""}`)
        .join("\n\n");
      // 分了块就把站名一起带上，粘到别处才看得出哪段是哪个站的。
      return groups.length > 1 ? `【${blockTitle(block)}】\n${body}` : body;
    })
    .join("\n\n");
  await navigator.clipboard.writeText(text || "还没有 Agent 输出");
});

document.querySelector("#save-settings").addEventListener("click", async () => {
  await window.browser.saveSettings(readSettingsForm());
  settingsHint.textContent = "已保存。";
});

document.querySelector("#archive-refresh").addEventListener("click", () => void loadArchive());

archiveExportBtn.addEventListener("click", () => void runExport());

document.querySelector("#archive-clear").addEventListener("click", async () => {
  const result = await window.browser.clearArchive();
  if (result?.cancelled) {
    return;
  }
  archiveOpen.clear();
  archiveItems.clear();
  archiveHint.textContent = result?.ok
    ? `已删除 ${result.total} 条归档、采集池和判定缓存。`
    : "删除时有文件删不掉（可能被占用），刷新看看还剩什么。";
  await loadArchive();
  await renderCacheStats();
});

document.querySelector("#clear-cache").addEventListener("click", async () => {
  const { ok } = await window.browser.clearCache();
  await renderCacheStats();
  settingsHint.textContent = ok
    ? "筛选缓存已清空，下次筛选会重新问模型。"
    : "缓存文件删不掉（可能被占用），本次运行内的判定已清空，但重启后可能恢复。";
});

document.querySelector("#test-settings").addEventListener("click", async () => {
  settingsHint.textContent = "正在测试…";
  try {
    await window.browser.saveSettings(readSettingsForm());
    const result = await window.browser.testSettings();
    const say = (label, probe) =>
      probe ? `${label} ${probe.model}：${probe.ok ? "通" : `不通（${probe.message || "未知原因"}）`}` : "";
    settingsHint.textContent = [
      say("主模型", result.main),
      result.fallback ? say("备用模型", result.fallback) : "备用模型：没填 Key，主模型断了不会自动顶上",
    ]
      .filter(Boolean)
      .join("；");
  } catch (error) {
    settingsHint.textContent = error.message || "连接失败。";
  }
});

// 标签页开了关了、标题变了都会来一条，勾选列表跟着它走。
function readTabs(state) {
  openTabs = state.tabs || [];
  activeTabId = state.activeTabId || "";
  // 从勾选里去掉那些已经不能采的。不只是关掉的：勾中的页面被导航到新标签页或非网页
  // 地址之后也采不了，那一行会从列表里消失，id 却还留在勾选集合里——勾选数就跟看到的
  // 对不上了，还能再多勾一个，最后传出去三个 id，实际只采到一个。
  const alive = new Set(pickableTabs().map((tab) => tab.id));
  for (const id of [...picked]) {
    if (!alive.has(id)) {
      picked.delete(id);
    }
  }
  applyDefaultPicks();
  renderPicks();
}

// browser:state 里的 agentRunning 是「采集或筛选任一在跑」，拿它推采集状态会把
// 停止采集的按钮点亮。采集状态只认 agent:event 的 status，以及启动时的 agent:state。
window.browser.onAgent(handleAgentEvent);
window.browser.onState(readTabs);

loadSettings();
restoreAgent();
renderCacheStats();
// 默认站点要先拿到，否则第一批标签页状态来的时候还不知道该勾哪几个。
void window.browser
  .getDefaultSites()
  .then((sites) => {
    defaultSites = sites || [];
  })
  .then(() => window.browser.ready())
  .then(readTabs);
