// 采集链路整体走一遍：拿真实页面上那种带"相似文章"尾巴的条目喂进去,看落到池子、
// 界面、筛选队列里的是不是这条自己的内容,以及同一条快讯尾巴变长后还会不会再采一遍。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "scrape-flow-")));

const { PageScraper } = require("./electron/agent/scraper");
const archive = require("./electron/agent/archive");

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "通过" : "不通过"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// 第一次采到的样子：尾巴上挂着一条转发
const round1 = [
  {
    text: "21:30:43 美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%。 华尔街见闻 复制 相似文章 21:30:58【选股宝】美股三大股指高开，道指涨0.36%",
    time: "21:30:43",
    ts: 1787664643000,
    seq: 2,
  },
  {
    text: "21:30:42 航行警告！兴化湾江阴港海域实弹射击 据中国海事局网站消息，福州海事局发布航行警告，8月26日1时至18时。 新浪财经 复制",
    time: "21:30:42",
    ts: 1787664642000,
    seq: 1,
  },
];

// 十几秒后再采：同一条快讯的尾巴上又多挂了两条转发，别的没变
const round2 = [
  {
    text: "21:30:43 美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%。 华尔街见闻 复制 相似文章 21:30:36【华尔街见闻】标普500指数高开23.80点，涨幅0.31%。 21:30:58【选股宝】美股三大股指高开，道指涨0.36%",
    time: "21:30:43",
    ts: 1787664643000,
    seq: 3,
  },
  {
    text: "21:31:12 跳水世青赛：中国队获混合团体冠军 北京时间8月25日，中国队以414.55分夺冠。 界面网 复制",
    time: "21:31:12",
    ts: 1787664672000,
    seq: 4,
  },
];

let queue = [round1, round2];
const tabManager = {
  activeTabId: "t1",
  tabFor: () => ({ id: "t1" }),
  getTabUrl: () => "https://news.example.com/",
  getTabTitle: () => "示例快讯站聚合消息-示例网聚合消息",
  waitForIdle: async () => {},
  ensureLiveProbe: async () => {},
  scrollToTop: async () => {},
  reloadTab: () => {},
  drainLiveItems: async () => queue.shift() || [],
  extractPageData: async () => ({ title: "示例快讯站", excerpt: "财经快讯", text: "财经快讯" }),
};

const events = [];
const scraper = new PageScraper(tabManager, (event) => events.push(event));
// 这两样跟本次要验的东西无关：一个是把页面拽回顶部，一个是隔一阵子点刷新
scraper.keepOnPage = async () => {};
scraper.maybeRefresh = async () => false;

const source = scraper.newSource("t1", "https://news.example.com/");

(async () => {
  const first = await scraper.pollSource(source, 1);
  check("第一轮采到两条", first === 2, `采到 ${first} 条`);

  const stocks = scraper.pending.find((entry) => entry.text.includes("美股三大股指"));
  check("推荐区没进筛选队列", stocks && !stocks.text.includes("相似文章"), stocks ? stocks.text.slice(0, 46) : "没找到");
  check(
    "这条自己的内容留着",
    stocks && stocks.text.includes("纳指涨0.65%") && stocks.text.includes("华尔街见闻"),
    "",
  );

  const shown = scraper.rawItems.find((item) => item.text.includes("美股三大股指"));
  check("界面上看到的也是干净的", shown && !shown.text.includes("相似文章"), "");

  check("最新的排在最前", scraper.rawItems[0].ts === 1787664643000, `头一条 ts=${scraper.rawItems[0].ts}`);

  const second = await scraper.pollSource(source, 2);
  check("第二轮只多了真正的新条目", second === 1, `采到 ${second} 条`);
  check(
    "同一条快讯尾巴变长了也没再采一遍",
    scraper.pending.filter((entry) => entry.text.includes("美股三大股指")).length === 1,
    `队列里有 ${scraper.pending.filter((entry) => entry.text.includes("美股三大股指")).length} 条`,
  );
  check("三条各就各位", scraper.pending.length === 3, `队列 ${scraper.pending.length} 条`);
  check(
    "新采到的那条最新，排到了最前",
    scraper.rawItems[0].text.includes("跳水世青赛"),
    scraper.rawItems[0].text.slice(0, 30),
  );

  // 池子里落盘的内容
  archive.flushPool();
  const poolDir = path.join(app.getPath("userData"), "pool");
  const poolFile = path.join(poolDir, fs.readdirSync(poolDir)[0]);
  const rows = fs
    .readFileSync(poolFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  check("池子里存了三条", rows.length === 3, `${rows.length} 条`);
  check("池子里也没有推荐区", rows.every((row) => !row.text.includes("相似文章")), "");
  check("池子里每条都带来源", rows.every((row) => row.origin === "示例快讯站聚合消息"), rows[0].origin);

  // 重启之后按现在的算法重算池子指纹，同一条不该再入池
  delete require.cache[require.resolve("./electron/agent/archive")];
  const restarted = require("./electron/agent/archive");
  const again = restarted.savePool([{ text: round2[0].text.replace("相似文章", "相似文章 22:00:00【新浪财经】又一条转发。"), ts: 1787664643000 }]);
  check("重开程序后，同一条快讯不会再入池", again.added === 0, `又入池 ${again.added} 条`);

  const bad = results.filter((pass) => !pass).length;
  console.log(`\n${results.length - bad}/${results.length} 项通过`);
  console.log(bad ? "结论：有失败" : "结论：全部通过");
  app.exit(bad ? 1 : 0);
})().catch((error) => {
  console.log(`跑挂了：${error.stack}`);
  app.exit(1);
});
