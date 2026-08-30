const { describeUsage } = require("./llm");
const { byNewestFirst } = require("./ordering");
const cache = require("./filter-cache");

const DEFAULT_REQUIREMENT = "输出最新文章的标题和摘要";

const SYSTEM_PROMPT = `你是文章筛选 Agent。采集模块会送来当前页新抓到的原始条目。
根据用户要求，只输出真正符合要求的文章数据。不要编造原文里没有的事实。

只返回 JSON：
{
  "articles": [
    {
      "index": 该条目在输入里的编号（整数，必须原样回填）,
      "title": "标题",
      "summary": "一两句摘要或原文要点",
      "time": "若有时间则保留",
      "source": "内容来源，比如站点名或栏目名；没有就留空。不要在这里重复原文",
      "match": "为何符合要求"
    }
  ]
}

每篇都必须带上 index，否则无法对应回原条目。
不符合要求的条目不要放进 articles。如果都不符合，返回 {"articles":[]}。`;

// 一个 Key 都没填就没法理解"只要什么、忽略什么"。中文按分隔符切词切不开，硬做关键词
// 匹配只会把新消息整批丢掉，所以这里原样透传并说明情况。（跟"备用模型"是两回事：
// 那个是主模型连不上时顶上来的另一家，这里是压根没模型可用。）
function passthroughArticles(items) {
  return items.map((item) => ({
    title: item.text.slice(0, 40),
    summary: item.text,
    time: (item.text.match(/\d{1,2}:\d{2}(?::\d{2})?/) || [""])[0],
    source: "",
    match: "无 API Key，未做筛选",
    raw: item.text,
    ...carried(item),
  }));
}

// 这几样都是随条目走的，不经模型也不进缓存：缓存只存判定结果，命中旧缓存的条目照样
// 要从当前条目现取这些字段。
//
// raw 是探针采到的原文。ts 和 arrival 必须带：模型一批一批问，输出顺序只反映批次
// 先后，排序得靠条目自己的时间。origin 那几个是"这条从哪个页面采来的"，界面按它分块。
function carried(item) {
  return {
    ts: item.ts,
    arrival: item.arrival,
    origin: item.origin,
    originId: item.originId,
    originUrl: item.originUrl,
  };
}

function withRaw(plan) {
  return plan
    .filter((slot) => slot.article)
    .map((slot) => ({
      ...slot.article,
      raw: slot.item.text,
      ...carried(slot.item),
    }));
}

function normalizeArticle(raw) {
  const article = {
    title: String(raw.title || "").trim(),
    summary: String(raw.summary || raw.source || "").trim(),
    time: String(raw.time || "").trim(),
    source: String(raw.source || "").trim(),
    match: String(raw.match || "").trim(),
  };
  return article.title || article.summary ? article : null;
}

// 服务端的 prompt 缓存按 token 前缀命中，把一次会话里逐字不变的部分
// 全部压进 system，条目才是每次唯一变化的尾巴。
function buildSystemMessage(requirement, pageUrl) {
  return `${SYSTEM_PROMPT}\n\n用户要求：${requirement || DEFAULT_REQUIREMENT}\n页面：${pageUrl || "未知"}`;
}

function dedupe(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item.key || item.text;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      key,
      text: item.text,
      ts: Number(item.ts) || 0,
      arrival: Number(item.arrival) || 0,
      origin: String(item.origin || ""),
      originId: String(item.originId || ""),
      originUrl: String(item.originUrl || ""),
    });
  }
  return unique;
}

async function filterArticles({ pool, requirement, items, pageUrl, signal }) {
  const unique = dedupe(items);
  if (!unique.length) {
    return { articles: [], usedModel: false, cached: 0, asked: 0, usageText: "" };
  }

  if (!pool.hasKey()) {
    return { articles: passthroughArticles(unique), usedModel: false, cached: 0, asked: 0, usageText: "" };
  }

  // 读缓存只能按"这批大概会用谁"来找。真赶上切换，这批就是照主模型的分区找、按备用
  // 模型的分区记，各自的判定不会串到一块去。
  //
  // 这个模型名必须在这儿存住：下面 complete() 会在主模型不通时切到备用、冷却够了又
  // 切回主模型，都会改掉池子的首选。拿调用之后的首选去跟实际用的比，等于两头都变过，
  // 比出来的"没换模型"是假的——备用判的会被记进主模型的分区，回切那批又被记进备用
  // 的分区。换了模型却复用旧判定，正是分区想拦的事。
  const plannedModel = pool.preferredModel();
  const scope = cache.scopeOf(requirement, plannedModel);
  const plan = unique.map((item) => ({ item, article: cache.read(scope, item.key) }));
  const asked = plan.filter((slot) => slot.article === undefined);
  const cachedCount = plan.length - asked.length;

  if (!asked.length) {
    return {
      articles: withRaw(plan),
      usedModel: false,
      cached: cachedCount,
      asked: 0,
      usageText: "",
    };
  }

  const { data, usage, model } = await pool.complete({
    signal,
    messages: [
      { role: "system", content: buildSystemMessage(requirement, pageUrl) },
      {
        role: "user",
        content: `新采集条目：\n${asked.map((slot, index) => `${index + 1}. ${slot.item.text}`).join("\n")}`,
      },
    ],
  });
  const writeScope = model === plannedModel ? scope : cache.scopeOf(requirement, model);

  const raw = Array.isArray(data.articles) ? data.articles : [];
  const byIndex = new Map();
  const unmatched = [];
  for (const entry of raw) {
    const article = normalizeArticle(entry);
    if (!article) {
      continue;
    }
    const index = Number(entry.index);
    if (Number.isInteger(index) && index >= 1 && index <= asked.length && !byIndex.has(index)) {
      byIndex.set(index, article);
    } else {
      unmatched.push(article);
    }
  }

  // 只有编号全都对得上，"没被选中"才等于"模型判定不符合"。一旦有回不上号的输出，
  // 就无从判断漏掉的是哪几条，此时记下拒绝会把它们永久钉死。
  const rejectionsTrustworthy = unmatched.length === 0;
  for (const [position, slot] of asked.entries()) {
    const article = byIndex.get(position + 1);
    if (article) {
      slot.article = article;
      cache.write(writeScope, slot.item.key, article);
    } else if (rejectionsTrustworthy) {
      slot.article = null;
      cache.write(writeScope, slot.item.key, null);
    }
  }

  // 回不上号的输出对应不到具体条目，也就没有自己的时间。挂上这批里最旧的那个时刻，
  // 让它们落在这批的末尾；留着时间戳为 0 的话会沉到整份列表的最底下去。来源同理，
  // 一批里的条目都来自同一个页面，跟着借用就是对的。
  let oldest = null;
  for (const item of unique) {
    if (!oldest || byNewestFirst(oldest, item) < 0) {
      oldest = item;
    }
  }
  const articles = withRaw(plan);
  articles.push(...unmatched.map((article) => ({ ...article, ...carried(oldest) })));

  return {
    articles,
    usedModel: true,
    cached: cachedCount,
    asked: asked.length,
    usageText: describeUsage(usage),
    model,
  };
}

module.exports = {
  filterArticles,
};
