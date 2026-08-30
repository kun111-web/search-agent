const PROBE_KEY = "__searchAgentLiveProbe";
const PROBE_VERSION = 4;

const PROBE_CONFIG = {
  key: PROBE_KEY,
  version: PROBE_VERSION,
  maxBuffer: 400,
  // 条目正文不再做长度截断：筛选和入库都要完整原文。单条的天然上界由下面这条
  // 卡片放弃线兜住，爬到这么大一坨文字就说明爬到整块列表、而不是单条了。
  cardTextMax: 3600,
  minBody: 8,
  ownBodyMin: 40,
  rescanMs: 2500,
  // 全扫是增量监听之外的安全网。行情跳动、倒计时这类页面时刻都在变 mutation，
  // 全扫自己却老也捞不到新东西；连着几轮空手就把间隔翻倍拉长到这条线为止，
  // 真的录到新条目时立刻缩回去。
  rescanMaxMs: 10000,
  // shadow root 的发现要对每个元素问一遍 shadowRoot。组件树建页之后基本不变，
  // 结果缓存起来按这个间隔低频刷新就够，不必每次全扫都重找一遍。
  rootRescanMs: 24000,
  debounceMs: 200,
  minFeedItems: 3,
  futureGraceMs: 600000,
  // 没有时间锚点时靠"一排结构相同的兄弟"认列表。导航菜单、标签云、页码同样是
  // 一排相同结构，靠这条正文下限把它们挡在外面：菜单项通常只有两三个字。
  listMinBody: 24,
};

// 这个函数会被序列化后注入页面执行，不能引用模块作用域里的任何东西。
function probeMain(config) {
  const previous = window[config.key];
  if (previous && previous.version === config.version) {
    return { installed: false, version: config.version };
  }
  if (previous && typeof previous.dispose === "function") {
    try {
      previous.dispose();
    } catch (_error) {
      // 旧探针已经随页面销毁
    }
  }

  const ANCHOR_MAX = 32;
  // 锚点该是个时间标签，不是一句话。短快讯整条也就三十来字（"财联社8月22日电，美国
  // 本周石油钻井数452，前值455。"），光看长度会把它当成锚点：于是这一小块顶掉了整条
  // 卡片，旁边真正写着 01:01:31 的时间标签反倒没人要，整条的时间只剩到天的精度。把
  // 时间抠掉还剩一堆字的，就是正文里顺口写了个日期，不算锚点——这些条目由结构路径
  // 采走，那边会从正文开头把日期和时分一起认出来。
  const ANCHOR_BODY_MAX = 10;
  const SEEN_MAX = 6000;
  // 时间要么写在属性里，要么就是某个叶子节点的全部文字。带时间属性的元素满页也就
  // 几十个，叶子节点却成千上万，分两组匹配就不用为了四个属性把整页元素都问一遍。
  const ATTR_SELECTOR = "time,[datetime],[data-time],[data-timestamp],[data-date]";
  const TEXT_SELECTOR = "time,span,em,i,b,strong,small,label,td,th,p,div,dt,dd,h3,h4,h5,a";
  // 一排条目总得挂在某个容器下，够得着的容器就这么几种标签。
  const LIST_CONTAINER_SELECTOR = "ul,ol,dl,tbody,div,section,main,article";
  const LIST_NOISE_SELECTOR = "nav,footer,aside";
  // 正文里连续的几个段落也是"一排结构相同的兄弟"，但它们是一篇文章而不是一串条目。
  // 条目内部通常有点结构（标题、链接、单元格），纯文本的兄弟则要么本身就是列表语义
  // 的标签，要么自带时间戳——快讯站常把日期、时间、正文全塞进一个 div。
  const LIST_ITEM_TAGS = new Set(["LI", "TR", "DD", "DT", "A"]);
  // 组件密集的站点能有上千个 shadow host，每个都挂监听不值得，挂到这个数就够用了。
  const ROOT_MAX = 200;
  // 年月日允许用点分隔（2026.08.21 这种国内站点很常见），但只在带四位年份时认：
  // 月日那一档要是也收点，"上涨3.14%" 就会被当成 3 月 14 日。
  const TIME_TOKEN =
    /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/月]\d{1,2}日?|\d{1,2}:\d{2}(?::\d{2})?|刚刚|刚才|\d+\s*(?:秒|分钟|分|小时|时|天)前|\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|days?)\s*ago/gi;
  const TIME_ONCE = new RegExp(TIME_TOKEN.source, "i");
  // 单独一截时分，用来把"日期"和"时分"两类 token 分开。
  const CLOCK_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  // 条目的时间只会写在开头，往后扫就开始撞上正文里的数字了。
  const HEAD_SCAN = 40;
  // 条目尾巴上常挂着实时增长的互动计数（"阅 3316 评论 ( 0 ) 分享 ( 0 )"）。指纹里留着
  // 它，同一条内容每涨一次阅读量就被当成新条目报一遍。与主进程那份保持一致。
  const ENGAGEMENT_COUNTS =
    /(?:阅读|阅|浏览|查看|评论|留言|回复|分享|转发|点赞|收藏)\s*[（(]?\s*[\d.,]+\s*[wWkK万亿]?\s*[）)]?/g;
  const UNIT_MS = {
    秒: 1000,
    分: 60000,
    分钟: 60000,
    时: 3600000,
    小时: 3600000,
    天: 86400000,
  };

  const seen = new Set();
  const buffer = [];
  const pendingRoots = new Set();
  // 一次扫描里同一批祖先会被反复量长度：每个候选都要沿祖先链往上爬，findCard 要量
  // 两次（整段多长、去掉时间还剩多少正文），嵌套判定又要量一次。textContent 会把
  // 整棵子树粘成字符串，长列表上这就是重复几百遍的开销，所以量过的记下来。
  // 用弱引用装：缓存只在一轮扫描内有用，不该拖着已经被移出页面的节点不让回收。
  let metrics = new WeakMap();
  let primaryFeed = null;
  let primaryList = null;
  const observedRoots = new WeakSet();
  const timedCards = new WeakSet();
  let sequence = 0;
  let debounceTimer = null;
  let disposed = false;
  // DOM 一点没动过时就不必再全量扫一遍：条目按指纹去重，重复扫描不会多出内容。
  let mutationSeq = 0;
  let lastFullScanSeq = -1;

  function normalize(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripTime(value) {
    return normalize(value).replace(TIME_TOKEN, " ").replace(/\s+/g, " ").trim();
  }

  // 去重指纹：时间和互动计数都得去掉，它们不变内容也照样在变。
  function fingerprint(value) {
    return stripTime(value)
      .replace(ENGAGEMENT_COUNTS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  // TIME_TOKEN 带 g，直接拿它 test 会因为 lastIndex 留在上一次的位置而漏判。
  function hasTime(value) {
    return TIME_ONCE.test(String(value == null ? "" : value));
  }

  // 结构路径认出来的条目没有独立的时间元素可指，时间就写在正文开头："01:59:42 财联社
  // 8月22日电…"、"2026.08.21 星期五 23:52:28 【…】"。不把它认出来，这些条目的时间戳
  // 就是 0，排序时会被压到所有带时间的条目后面，而它们往往恰恰是最新的几条。
  function parseHeadTime(raw, now) {
    const tokens = normalize(raw).slice(0, HEAD_SCAN).match(TIME_TOKEN);
    if (!tokens) {
      return null;
    }
    // parseTime 只认"日期在前、时分在后"，而页面上这两截常反着写，中间还夹着"星期五"
    // 之类的字。抠出来重排一遍再交给它，日期和时分才能一起被认走；只认到日期的话，
    // 同一天的条目会被压成同一个时刻，又变回没有依据可排。
    const dates = tokens.filter((token) => !CLOCK_ONLY.test(token));
    const clocks = tokens.filter((token) => CLOCK_ONLY.test(token));
    return parseTime(`${dates[0] || ""} ${clocks[0] || ""}`.trim(), now);
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function clockLabel(ts) {
    const date = new Date(ts);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function parseRelative(text, now) {
    if (/刚刚|刚才|方才/.test(text) || /^just now$/i.test(text)) {
      return { ts: now.getTime(), label: "刚刚" };
    }
    const chinese = text.match(/(\d+)\s*(秒|分钟|分|小时|时|天)前/);
    if (chinese) {
      return { ts: now.getTime() - Number(chinese[1]) * UNIT_MS[chinese[2]], label: chinese[0] };
    }
    const english = text.match(/(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\s*ago/i);
    if (english) {
      const unit = english[2].toLowerCase();
      const scale = unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60000 : unit.startsWith("h") ? 3600000 : 86400000;
      return { ts: now.getTime() - Number(english[1]) * scale, label: english[0] };
    }
    return null;
  }

  function parseTime(raw, now) {
    const text = normalize(raw);
    if (!text || text.length > 64) {
      return null;
    }

    if (/^\d{13}$/.test(text)) {
      return { ts: Number(text), label: clockLabel(Number(text)) };
    }
    if (/^\d{10}$/.test(text)) {
      return { ts: Number(text) * 1000, label: clockLabel(Number(text) * 1000) };
    }

    const relative = parseRelative(text, now);
    if (relative) {
      return relative;
    }

    const full = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (full) {
      const ts = new Date(
        Number(full[1]),
        Number(full[2]) - 1,
        Number(full[3]),
        Number(full[4] || 0),
        Number(full[5] || 0),
        Number(full[6] || 0),
      ).getTime();
      const label = full[0].replace("T", " ").slice(0, 16);
      return Number.isFinite(ts) ? { ts, label } : null;
    }

    const monthDay = text.match(/(?:^|\D)(\d{1,2})[-/月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?!\d)/);
    if (monthDay && Number(monthDay[1]) <= 12 && Number(monthDay[2]) <= 31 && (monthDay[3] || /[月日]/.test(text) || text.length >= 5)) {
      let ts = new Date(
        now.getFullYear(),
        Number(monthDay[1]) - 1,
        Number(monthDay[2]),
        Number(monthDay[3] || 0),
        Number(monthDay[4] || 0),
        Number(monthDay[5] || 0),
      ).getTime();
      if (ts - now.getTime() > 2 * 86400000) {
        ts = new Date(new Date(ts).setFullYear(now.getFullYear() - 1)).getTime();
      }
      // monthDay[0] 把前面那个用来定界的非数字字符也吃进来了（"社8月22日"），去掉。
      return { ts, label: monthDay[0].replace(/^\D+/, "").trim().slice(0, 24) };
    }

    const clock = text.match(/(?:^|[^\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/);
    if (clock) {
      const hour = Number(clock[1]);
      const minute = Number(clock[2]);
      const second = Number(clock[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) {
        return null;
      }
      const date = new Date(now.getTime());
      date.setHours(hour, minute, second, 0);
      let ts = date.getTime();
      // 站点常见的跨零点列表：比当前晚 6 小时以上的，按昨天算。
      if (ts - now.getTime() > 6 * 3600000) {
        ts -= 86400000;
      }
      return { ts, label: clock[3] ? `${pad(hour)}:${pad(minute)}:${pad(second)}` : `${pad(hour)}:${pad(minute)}` };
    }

    return null;
  }

  // 缓存只在一轮扫描内有效，DOM 一变就作废。
  function measure(node) {
    let size = metrics.get(node);
    if (!size) {
      const raw = node.textContent || "";
      size = { total: raw.length, body: stripTime(raw).replace(/\s+/g, "").length };
      metrics.set(node, size);
    }
    return size;
  }

  function findCard(anchor) {
    let node = anchor;
    for (let hops = 0; hops < 8; hops += 1) {
      const size = measure(node);
      // 往上爬到整块列表就说明这个时间不是条目时间，放弃。
      if (size.total > config.cardTextMax) {
        return null;
      }
      if (size.body >= config.minBody) {
        return node;
      }
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) {
        return null;
      }
      node = parent;
    }
    return null;
  }

  function isHidden(element) {
    if (typeof element.getClientRects !== "function") {
      return false;
    }
    return element.getClientRects().length === 0;
  }

  function readTimeAttribute(element) {
    if (!element.getAttribute) {
      return "";
    }
    return (
      element.getAttribute("datetime") ||
      element.getAttribute("data-time") ||
      element.getAttribute("data-timestamp") ||
      element.getAttribute("data-date") ||
      ""
    );
  }

  function collectCandidates(root, output) {
    let attrNodes;
    let textNodes;
    try {
      if (!root.querySelectorAll) {
        return;
      }
      attrNodes = root.querySelectorAll(ATTR_SELECTOR);
      textNodes = root.querySelectorAll(TEXT_SELECTOR);
    } catch (_error) {
      return;
    }

    const now = new Date();
    // 增量扫描传进来的 root 自己也可能就是那个带时间的节点。
    const rootElement = root.nodeType === 1 && root.matches ? root : null;
    // 属性里写的时间比一段文字更可靠，认过的元素文本组不再重复认。
    const byAttribute = new Set();

    const consider = (element, source) => {
      if (!/\d/.test(source) && !/刚刚|刚才|方才|just now/i.test(source)) {
        return;
      }
      const time = parseTime(source, now);
      if (!time) {
        return;
      }
      // 经济日历、节目预告这类未来时间不是"新消息"，否则会一直霸占最新位置。
      if (time.ts > now.getTime() + config.futureGraceMs) {
        return;
      }
      const card = findCard(element);
      if (!card || card.closest("nav, footer")) {
        return;
      }
      output.push({ card, anchor: element, time });
    };

    for (const element of rootElement && rootElement.matches(ATTR_SELECTOR)
      ? [rootElement, ...attrNodes]
      : attrNodes) {
      const source = readTimeAttribute(element);
      if (!source) {
        continue;
      }
      byAttribute.add(element);
      consider(element, source);
    }

    for (const element of rootElement && rootElement.matches(TEXT_SELECTOR)
      ? [rootElement, ...textNodes]
      : textNodes) {
      if (byAttribute.has(element) || element.children.length !== 0) {
        continue;
      }
      const own = normalize(element.textContent);
      if (own && own.length <= ANCHOR_MAX && stripTime(own).length <= ANCHOR_BODY_MAX) {
        consider(element, own);
      }
    }
  }

  // textContent 会把整棵子树的文字粘成一团，连"复制成功"这类 display:none 的提示
  // 浮层、被折叠的重复条目一起读进来。所以自己走一遍子树，遇到不渲染的整块就跳过，
  // 顺便按节点分段保住可读性。这里不能用 innerText 代劳：它对 display:none 的元素
  // 会退回 textContent（噪音照旧进来），而对 visibility:hidden 又直接给空串（真正
  // 的正文会整条丢掉）。
  function readText(element) {
    if (!element.children.length) {
      return normalize(element.textContent);
    }
    const parts = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const value = normalize(child.textContent);
          if (value) {
            parts.push(value);
          }
        } else if (child.nodeType === 1 && !isHidden(child)) {
          walk(child);
        }
      }
    };
    walk(element);
    return normalize(parts.join(" "));
  }

  function buildItem(candidate) {
    const text = readText(candidate.card);
    // key 只是去重指纹，取前一段就够；text 保持原样，一个字都不截。
    const key = fingerprint(text);
    if (key.replace(/\s+/g, "").length < config.minBody) {
      return null;
    }
    return { text, time: candidate.time.label, ts: candidate.time.ts, key };
  }

  function record(item) {
    if (!item || seen.has(item.key)) {
      return;
    }
    seen.add(item.key);
    if (seen.size > SEEN_MAX) {
      seen.delete(seen.values().next().value);
    }
    sequence += 1;
    buffer.push({ text: item.text, time: item.time, ts: item.ts, seq: sequence });
    if (buffer.length > config.maxBuffer) {
      buffer.splice(0, buffer.length - config.maxBuffer);
    }
  }

  function depthOf(element) {
    let depth = 0;
    let node = element;
    while (node.parentElement) {
      depth += 1;
      node = node.parentElement;
    }
    return depth;
  }

  // 页面上带时间的东西很多：行情跳动、日历预告、顶部工具栏。真正的消息流是条目
  // 最密集的那一片。列表项常被各自的 wrapper 包住，所以要沿祖先链统计，再在条目
  // 数接近的祖先里挑最深的那个，避免一路选到 body 上去。
  function chooseFeed(candidates) {
    const counts = new Map();
    for (const candidate of candidates) {
      let node = candidate.card.parentElement;
      let hops = 0;
      while (node && node !== document.documentElement && hops < 6) {
        counts.set(node, (counts.get(node) || 0) + 1);
        node = node.parentElement;
        hops += 1;
      }
    }

    let max = 0;
    for (const count of counts.values()) {
      if (count > max) {
        max = count;
      }
    }

    const floor = Math.max(config.minFeedItems, Math.ceil(max * 0.6));
    let best = null;
    let bestDepth = -1;
    for (const [node, count] of counts) {
      if (count < floor) {
        continue;
      }
      const depth = depthOf(node);
      if (depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
    }
    return best;
  }

  // 选择器进不了 shadow DOM，用 Web Components 搭的站点整块内容都会隐身。逐个
  // host 钻进去，每个 shadow root 都当成一个独立的扫描根。
  //
  // 这趟遍历不便宜——document 加上途中发现的每个 root 都要把全部元素问一遍。而
  // 组件树在建页之后基本是静止的，所以结果缓存进 shadowRoots，按低频刷新；全扫
  // 用缓存那份就好。
  let shadowRoots = [];
  let lastRootScanAt = 0;

  function discoverShadowRoots() {
    const roots = [document];
    const found = [];
    for (let index = 0; index < roots.length && found.length < ROOT_MAX; index += 1) {
      let hosts;
      try {
        hosts = roots[index].querySelectorAll("*");
      } catch (_error) {
        continue;
      }
      for (const host of hosts) {
        if (host.shadowRoot) {
          found.push(host.shadowRoot);
          // 嵌套的 shadow DOM（root 里再挂 host）也要钻，所以发现即入队。
          roots.push(host.shadowRoot);
          if (found.length >= ROOT_MAX) {
            break;
          }
        }
      }
    }
    shadowRoots = found;
    lastRootScanAt = Date.now();
  }

  function observeAllRoots() {
    observeRoot(document);
    for (const root of shadowRoots) {
      observeRoot(root);
    }
  }

  // 动态类名常带序号（item-3、col-2），签名里去掉带数字的部分，同一排兄弟才认得
  // 出是同一种结构。
  function classSignature(element) {
    const raw = typeof element.className === "string" ? element.className : "";
    const names = [];
    for (const name of raw.split(/\s+/)) {
      if (name && !/\d/.test(name)) {
        names.push(name);
      }
    }
    return `${element.tagName}#${names.sort().join(".")}`;
  }

  // 时间锚点认不出东西的页面（普通新闻列表、论坛、博客归档都不在条目上写时间），
  // 唯一还剩的信号就是"同一个容器下摆着一排结构相同的子元素"。
  function listGroupOf(container) {
    if (container.children.length < config.minFeedItems) {
      return null;
    }
    if (container.closest && container.closest(LIST_NOISE_SELECTOR)) {
      return null;
    }

    const groups = new Map();
    for (const child of container.children) {
      const signature = classSignature(child);
      const bucket = groups.get(signature);
      if (bucket) {
        bucket.push(child);
      } else {
        groups.set(signature, [child]);
      }
    }

    let best = null;
    for (const bucket of groups.values()) {
      if (bucket.length < config.minFeedItems) {
        continue;
      }
      const items = [];
      let bodySum = 0;
      for (const child of bucket) {
        if (!child.children.length && !LIST_ITEM_TAGS.has(child.tagName) && !hasTime(child.textContent)) {
          continue;
        }
        const size = measure(child);
        // 单项就有这么多字，说明这一"排"是版块容器而不是条目。
        if (size.total > config.cardTextMax || size.body < config.listMinBody) {
          continue;
        }
        if (isHidden(child)) {
          continue;
        }
        items.push(child);
        bodySum += size.body;
      }
      if (items.length < config.minFeedItems) {
        continue;
      }
      // 条目多、每条自己的正文也够长，才像一串内容。
      const score = items.length * (bodySum / items.length);
      if (!best || score > best.score) {
        best = { container, items, score };
      }
    }
    return best;
  }

  function chooseList(roots) {
    let best = null;
    const consider = (container) => {
      const group = listGroupOf(container);
      if (group && (!best || group.score > best.score)) {
        best = group;
      }
    };

    for (const root of roots) {
      // 传进来的范围自己就可能是那个列表容器，querySelectorAll 只找后代。
      if (root.nodeType === 1) {
        consider(root);
      }
      let containers;
      try {
        if (!root.querySelectorAll) {
          continue;
        }
        containers = root.querySelectorAll(LIST_CONTAINER_SELECTOR);
      } catch (_error) {
        continue;
      }
      for (const container of containers) {
        consider(container);
      }
    }
    return best;
  }

  function buildListItem(element, now) {
    const text = readText(element);
    const key = fingerprint(text);
    if (key.replace(/\s+/g, "").length < config.minBody) {
      return null;
    }
    const stamp = parseHeadTime(text, now);
    return { text, time: stamp ? stamp.label : "", ts: stamp ? stamp.ts : 0, key };
  }

  // 时间路径采下来的卡片，列表路径不能换个边界再采一遍，否则同一条内容会以两种范围
  // 各进一次（一条纯正文，一条还带着标签和阅读量）。两边的边界常常差着一两层包装，
  // 所以按包含关系判断。这份记录必须跨轮次留着：增量扫描只带来局部的时间锚点，只看
  // 本轮结果的话，上一轮采过的条目会被当成新的重采一遍。
  function alreadyTimed(item) {
    if (timedCards.has(item)) {
      return true;
    }
    let node = item.parentElement;
    for (let hops = 0; node && hops < 6; hops += 1) {
      if (timedCards.has(node)) {
        return true;
      }
      node = node.parentElement;
    }
    // 里面连时间都没有，就不可能包着时间路径采下的卡片，省下这趟子树遍历。
    if (!hasTime(item.textContent)) {
      return false;
    }
    let inner;
    try {
      inner = item.querySelectorAll("*");
    } catch (_error) {
      return false;
    }
    for (const node of inner) {
      if (timedCards.has(node)) {
        return true;
      }
    }
    return false;
  }

  function scanList(full) {
    if (primaryList && !primaryList.isConnected) {
      primaryList = null;
    }
    if (full || !primaryList) {
      // 时间锚点已经定位到消息流时，只在那一片里找它漏掉的条目：站点常有一部分条目
      // 的时间写在别处或写得认不出来。范围锁死在消息流内，就不会捞到侧栏和推荐位。
      const scope = primaryFeed && primaryFeed.isConnected ? [primaryFeed] : full ? [document, ...shadowRoots] : [document];
      const found = chooseList(scope);
      primaryList = found ? found.container : primaryList;
    }
    if (!primaryList) {
      return;
    }

    const group = listGroupOf(primaryList);
    if (!group) {
      return;
    }
    // 正文开头写了时间的条目能认出时间戳，认不出的只剩位置这一个信号，而列表基本都
    // 是新的在上面。倒着记，让最靠前的那条拿到最大的序号，取用那边按序号倒排时它才
    // 排在最前面。
    const now = new Date();
    for (let index = group.items.length - 1; index >= 0; index -= 1) {
      const item = group.items[index];
      if (alreadyTimed(item)) {
        continue;
      }
      record(buildListItem(item, now));
    }
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) {
      return;
    }
    observedRoots.add(root);
    const target = root.nodeType === 9 ? root.documentElement : root;
    if (!target) {
      return;
    }
    try {
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    } catch (_error) {
      // 这个 root 已经脱离页面了
    }
  }

  function scan(roots, full) {
    if (disposed) {
      return;
    }
    if (full) {
      lastFullScanSeq = mutationSeq;
      // shadow root 名单按低频刷新，第一轮全扫总是要找一次的。新发现的 root
      // 这一轮就挂上监听，之后它们内部的增量变化走 MutationObserver 进来。
      if (!lastRootScanAt || Date.now() - lastRootScanAt >= config.rootRescanMs) {
        discoverShadowRoots();
      }
      observeAllRoots();
    }
    metrics = new WeakMap();
    const scanRoots = full ? [document, ...shadowRoots] : roots;

    const candidates = [];
    for (const root of scanRoots) {
      // 11 是 shadow root 的 nodeType。
      if (root && (root.nodeType === 1 || root.nodeType === 9 || root.nodeType === 11)) {
        collectCandidates(root, candidates);
      }
    }

    if (primaryFeed && !primaryFeed.isConnected) {
      primaryFeed = null;
    }
    if (full && candidates.length) {
      primaryFeed = chooseFeed(candidates) || primaryFeed;
    }

    if (!candidates.length) {
      // 整页一个时间都没有：普通新闻列表、论坛、博客归档都是这样，只能靠结构找。
      scanList(full);
      return;
    }

    // 一条内容常被好几层容器同时命中，通常要的是最内层，外面那些只是包装。
    // 但聚合站会把"同一新闻的其他来源"当成小标题嵌在正文条目里面，那些小标题
    // 自己也带时间，这时候外层才是真条目、内层是附属，一律取内层就把正文丢了。
    // 用"外层扣掉内层之后还剩多少自己的正文"来区分：剩得多说明外层有独立内容。
    const cards = new Set(candidates.map((candidate) => candidate.card));
    const nested = new Map();
    for (const card of cards) {
      let node = card.parentElement;
      let hops = 0;
      while (node && hops < 12) {
        if (cards.has(node)) {
          const inners = nested.get(node);
          if (inners) {
            inners.push(card);
          } else {
            nested.set(node, [card]);
          }
        }
        node = node.parentElement;
        hops += 1;
      }
    }

    const dropped = new Set();
    for (const [card, inners] of nested) {
      let innerBody = 0;
      for (const inner of inners) {
        innerBody += measure(inner).body;
      }
      const total = measure(card).body;
      const own = total - innerBody;
      // 光看绝对量不够：板块容器塞十来条时也可能凑出几十字说明文字，所以还要求
      // 自有正文占到一半以上，才认定外层是条目本体。
      if (own >= config.ownBodyMin && own * 2 >= total) {
        for (const inner of inners) {
          dropped.add(inner);
        }
      } else {
        dropped.add(card);
      }
    }

    for (const candidate of candidates) {
      if (dropped.has(candidate.card) || isHidden(candidate.card)) {
        continue;
      }
      if (primaryFeed && !primaryFeed.contains(candidate.card)) {
        continue;
      }
      record(buildItem(candidate));
      timedCards.add(candidate.card);
    }

    // 站点常有一部分条目的时间写在别处或写得认不出来，时间路径就会漏掉它们。
    // 上面采过的会被挡掉，剩下的交给结构路径捡回来。
    scanList(full);
  }

  function flushPending() {
    debounceTimer = null;
    if (!pendingRoots.size) {
      return;
    }
    const overflowed = pendingRoots.size > 60;
    const roots = overflowed ? [document] : [...pendingRoots];
    pendingRoots.clear();
    scan(roots, overflowed);
  }

  function schedule() {
    if (debounceTimer || disposed) {
      return;
    }
    debounceTimer = setTimeout(flushPending, config.debounceMs);
  }

  const observer = new MutationObserver((mutations) => {
    mutationSeq += 1;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const parent = mutation.target.parentElement;
        if (parent) {
          pendingRoots.add(parent);
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          pendingRoots.add(node.parentElement || node);
        } else if (node.nodeType === 3 && node.parentElement) {
          pendingRoots.add(node.parentElement);
        }
      }
    }
    schedule();
  });

  // 安全网全扫自己调度自己：间隔是活的。连着两轮一条新条目都没捞到就把间隔翻倍
  // 拉长到 rescanMaxMs——那种页面通常是行情跳动在撩拨 mutation，增量路径全都接得住，
  // 全扫只是在白跑；一旦又真的录到新东西，立刻缩回基准间隔。
  let rescanTimer = null;
  let rescanDelay = config.rescanMs;
  let idleScans = 0;

  function scheduleRescan() {
    rescanTimer = setTimeout(() => {
      if (disposed) {
        return;
      }
      if (mutationSeq !== lastFullScanSeq) {
        const before = seen.size;
        scan([document], true);
        if (seen.size > before) {
          idleScans = 0;
          rescanDelay = config.rescanMs;
        } else if ((idleScans += 1) >= 2) {
          rescanDelay = Math.min(config.rescanMaxMs, rescanDelay * 2);
        }
      }
      scheduleRescan();
    }, rescanDelay);
  }

  scheduleRescan();

  const probe = {
    version: config.version,
    drain() {
      return buffer.splice(0, buffer.length);
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(rescanTimer);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  };

  // 监听统一由全量扫描挂载：主文档和途中发现的每个 shadow root 都要挂上。
  scan([document], true);
  window[config.key] = probe;
  return { installed: true, version: config.version };
}

// 只点明确表示"刷新/有新内容"的控件，避免误点跳走的链接。
function refreshControlMain() {
  const LABEL = /^(刷新|重新加载|更新|点击刷新|加载更多|加载更多内容|查看更多|显示更多|refresh|reload|load more|show more|new (posts|items|messages|tweets))$/i;
  const COUNTER = /\d+\s*条(新|最新|更新)/;
  const candidates = document.querySelectorAll(
    "button,a[role='button'],[role='button'],[class*='refresh'],[class*='Refresh'],[class*='more'],[class*='More'],[class*='new-'],[id*='refresh']",
  );

  for (const element of candidates) {
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 20) {
      continue;
    }
    if (!LABEL.test(text) && !COUNTER.test(text)) {
      continue;
    }
    if (element.getClientRects().length === 0) {
      continue;
    }
    if (element.tagName === "A" && element.getAttribute("href") && !/^#|^javascript:/i.test(element.getAttribute("href"))) {
      continue;
    }
    element.click();
    return text;
  }
  return "";
}

const KEY_LITERAL = JSON.stringify(PROBE_KEY);

const INSTALL_SCRIPT = `(${probeMain.toString()})(${JSON.stringify(PROBE_CONFIG)})`;

const READY_SCRIPT = `(() => {
  const probe = window[${KEY_LITERAL}];
  return Boolean(probe && probe.version === ${PROBE_VERSION});
})()`;

const DRAIN_SCRIPT = `(() => {
  const probe = window[${KEY_LITERAL}];
  return probe && typeof probe.drain === "function" ? probe.drain() : [];
})()`;

// 采集停了就把探针从页面上撤下来。它是 MutationObserver 加一个几秒一次的全量扫描，
// 不撤的话会一直跑到这个标签页被关掉或跳走为止——人已经把程序缩成球了，风扇还在转。
const UNINSTALL_SCRIPT = `(() => {
  const probe = window[${KEY_LITERAL}];
  if (!probe) {
    return { removed: false };
  }
  try {
    if (typeof probe.dispose === "function") {
      probe.dispose();
    }
  } finally {
    delete window[${KEY_LITERAL}];
  }
  return { removed: true };
})()`;

const REFRESH_SCRIPT = `(${refreshControlMain.toString()})()`;

module.exports = {
  INSTALL_SCRIPT,
  READY_SCRIPT,
  DRAIN_SCRIPT,
  REFRESH_SCRIPT,
  UNINSTALL_SCRIPT,
};
