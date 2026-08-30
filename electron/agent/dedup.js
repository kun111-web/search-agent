// 判断"这条内容采过没有"的指纹算法。采集循环、重筛排队、落盘入池三处都得用同
// 一套，否则同一条内容会在某一环重新冒出来。

// 与探针保持一致：年月日收点分隔，月日不收，否则百分比小数会被当成日期。
const TIME_TOKENS =
  /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/月]\d{1,2}日?|\d{1,2}:\d{2}(?::\d{2})?|刚刚|刚才|\d+\s*(?:秒|分钟|分|小时|时|天)前|\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|days?)\s*ago/gi;

// 条目尾巴上常挂着实时增长的互动计数（"阅 3316 评论 ( 0 ) 分享 ( 0 )"）。这些数字
// 每隔几分钟就变一次，留在指纹里的话，同一条新闻每变一次就被当成新内容采一遍。
const ENGAGEMENT_COUNTS =
  /(?:阅读|阅|浏览|查看|评论|留言|回复|分享|转发|点赞|收藏)\s*[（(]?\s*[\d.,]+\s*[wWkK万亿]?\s*[）)]?/g;

// 聚合站的条目底下常挂一串"相似文章"，别家转发同一条新闻的标题会陆续挂进来。那串
// 东西不是这条的内容，而且几分钟就长一截——留在指纹里，同一条新闻每被转发一次就
// 又被当成新内容采一遍，白送模型判一遍，档案里也多出一条看着重复的。
// 只收这几个铁定是界面标签的词。"相关报道""相关新闻"不能收：新闻正文里"据相关报道"
// 这样的说法很常见，收了会把正文从中间砍断。
const TAIL_SECTION = /(?:相似文章|相关阅读|推荐阅读|延伸阅读|热门推荐|猜你喜欢|为您推荐)[\s\S]*$/;
// 砍完只剩一小截的，说明那几个字长在正文里而不是尾巴上，按原文算。
const TAIL_KEEP_MIN = 12;

const KEY_MAX = 100;
// 同一条新闻会以两种形态进来：时间路径拿到干净的正文，结构路径拿到外层容器，尾巴
// 上多了栏目标签。两者开头是一模一样的，拿这几个字分桶，桶内再比前缀关系。分桶长
// 度必须短于下面的前缀门槛，否则短的那一方连不进长的那个桶，压根不会被比到。
const KEY_BUCKET = 12;
// 前缀关系只在短的那一方够长时才算同一条。"星期五" 这类残片当前缀会像通配符一样，
// 把开头相同的正常条目整片吞掉，所以短过这个数的指纹只认完全相同。
const PREFIX_MIN = 16;

/**
 * 剪掉条目尾巴上的"相似文章"推荐区。这串东西是别家转发同一条新闻的标题，不是这条
 * 自己的内容：留着它，同一条新闻每被转发一次就换一个指纹、被当成新内容重采一遍，
 * 送模型时还得按字数付钱，推荐区里别的品种、别的公司名还会把判定带偏。
 */
function stripTailSection(text) {
  const full = String(text || "");
  const trimmed = full.replace(TAIL_SECTION, "").trim();
  return trimmed.replace(/\s+/g, "").length >= TAIL_KEEP_MIN ? trimmed : full;
}

function itemKey(text) {
  return stripTailSection(text)
    .replace(TIME_TOKENS, " ")
    .replace(ENGAGEMENT_COUNTS, " ")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, KEY_MAX);
}

/**
 * 见过的指纹。除了完全相同，一方是另一方前缀的也算见过：那是同一条内容的两种形
 * 态，尾部差的是栏目标签、来源署名这类附加物。
 */
class SeenKeys {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.buckets = new Map();
    this.order = [];
  }

  get size() {
    return this.order.length;
  }

  has(key) {
    const list = this.buckets.get(String(key).slice(0, KEY_BUCKET));
    if (!list) {
      return false;
    }
    for (const known of list) {
      if (known === key) {
        return true;
      }
      const short = known.length < key.length ? known : key;
      const long = known.length < key.length ? key : known;
      if (short.length >= PREFIX_MIN && long.startsWith(short)) {
        return true;
      }
    }
    return false;
  }

  add(key) {
    const bucket = String(key).slice(0, KEY_BUCKET);
    const list = this.buckets.get(bucket);
    if (list) {
      list.push(key);
    } else {
      this.buckets.set(bucket, [key]);
    }
    this.order.push(key);
    while (this.order.length > this.max) {
      this.evict();
    }
  }

  evict() {
    const oldest = this.order.shift();
    if (oldest === undefined) {
      return;
    }
    const bucket = oldest.slice(0, KEY_BUCKET);
    const list = this.buckets.get(bucket);
    if (!list) {
      return;
    }
    const at = list.indexOf(oldest);
    if (at >= 0) {
      list.splice(at, 1);
    }
    if (!list.length) {
      this.buckets.delete(bucket);
    }
  }
}

module.exports = { TIME_TOKENS, TAIL_SECTION, stripTailSection, itemKey, SeenKeys };
