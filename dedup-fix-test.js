// 两处去重的修复：采集层的指纹别把尾巴上的"相似文章"算进去；归档层按原文认条目，
// 不再靠模型现写的标题。用真实数据里那几条重复当样本。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "dedup-fix-")));

const { itemKey, stripTailSection, SeenKeys } = require("./electron/agent/dedup");
const archive = require("./electron/agent/archive");

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "通过" : "不通过"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// 真实样本：同一条快讯采到两次，尾巴上的"相似文章"列表长短不同
const A =
  "21:30:43 美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%。 华尔街见闻 复制 相似文章 21:30:58【选股宝】美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%";
const B =
  "21:30:43 美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%。 华尔街见闻 复制 相似文章 21:30:36【华尔街见闻】标普500指数高开23.80点，涨幅0.31%，报7676.66点； 道琼斯工业平均指数高开177.76点，涨幅0.33%，报53594.92点； 纳斯达克综合指数高开168.52点，涨幅0.65%，报26148.71点。 21:30:58【选股宝】美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%";

console.log("一、采集层：尾巴变了不该当成新内容\n");
check("同一条快讯的两种形态指纹相同", itemKey(A) === itemKey(B), itemKey(A).slice(0, 46));

const seen = new SeenKeys(1000);
seen.add(itemKey(A));
check("第二次采到时被拦住", seen.has(itemKey(B)), "");

// 别把不同的新闻误判成同一条
const other = "21:30:42 航行警告！兴化湾江阴港海域实弹射击 据中国海事局网站消息，福州海事局发布航行警告 相似文章 21:31:00【新浪财经】航行警告";
check("不同的新闻还是分得开", !seen.has(itemKey(other)), `${itemKey(other).slice(0, 30)}…`);

// 只有"相似文章"这类界面标签才截断，正文里的这些说法不能砍
const normal = "10:00:00 央行发布相关政策解读，涉及相关行业的信贷投放。 新浪财经";
check("正文里的'相关'不会被误砍", itemKey(normal).includes("涉及相关行业的信贷投放"), itemKey(normal));

const quoted = "09:12:00 某公司回应停产传闻：据相关报道公司部分产线检修，属正常安排，不影响全年出货。 财联社";
check("正文里的'据相关报道'不会被砍断", itemKey(quoted).includes("属正常安排"), itemKey(quoted).slice(0, 40));

const newsWord = "08:30:00 证监会就相关新闻发布会答问，明确下一步监管重点。 上证快讯";
check("正文里的'相关新闻'不会被砍断", itemKey(newsWord).includes("明确下一步监管重点"), itemKey(newsWord));

// 反过来：标签出现在开头（正文残缺）时，砍完只剩一小截，那就按原文算，别砍出个残片
const stub = "12:00:00 相似文章 央行今日开展7天期逆回购操作3000亿元。";
check("砍完只剩残片时按原文算", itemKey(stub).includes("逆回购"), itemKey(stub));

console.log("\n二、送去判定之前，把推荐区剪掉\n");

// 真实样本：569 字里 537 字是别家转发的标题
const bloated =
  "16:44:44 伊拉克总统：政府阵容即将确定。 新浪财经 复制 相似文章 16:44:44【新浪财经】伊拉克总统：政府阵容即将确定。 16:45:14【新浪财经】伊拉克总统：我们在伊朗议会议长最近访问巴格达期间，向他通报了霍尔木兹海峡紧张局势给伊拉克造成的损害程度。 17:08:08【华尔街见闻】伊拉克总统：已有部分装载伊拉克石油船只获准通过霍尔木兹海峡";
const cleaned = stripTailSection(bloated);
check(
  "推荐区剪掉了",
  cleaned === "16:44:44 伊拉克总统：政府阵容即将确定。 新浪财经 复制",
  `${bloated.length} 字 → ${cleaned.length} 字`,
);

// 判定会被推荐区带偏：这条讲乙二醇，推荐区里混着 PTA 和对二甲苯
const mixed =
  "21:10:57 乙二醇连续主力合约日内跌5%，现报4222.00元。 新浪财经 复制 相似文章 21:11:17【新浪财经】对二甲苯连续主力合约日内跌3%。 21:11:22【新浪财经】PTA连续主力合约日内跌4%。";
const only = stripTailSection(mixed);
check("剪完不再混着别的品种", !only.includes("PTA") && !only.includes("对二甲苯") && only.includes("乙二醇"), only);

check("没有推荐区的条目原样不动", stripTailSection(normal) === normal, "");
check("剪完只剩残片的按原文算", stripTailSection(stub) === stub, "");

console.log("\n三、归档层：模型换个说法也是同一条\n");

// 同一条原文，模型两次写出不同的标题和摘要——真实数据里就是这样
const first = {
  title: "美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%",
  summary: "美股三大股指高开，道指、标普500指数和纳指均上涨。",
  raw: A,
  ts: 1787664643000,
  origin: "示例快讯站聚合消息",
};
const second = {
  title: "美股三大股指高开",
  summary: "美股三大股指高开，道指涨0.36%，标普500指数涨0.35%，纳指涨0.65%。",
  raw: B,
  ts: 1787664643000,
  origin: "示例快讯站聚合消息",
};

let saved = archive.save([first], { requirement: "全部" });
check("第一条入库", saved.added === 1, `入库 ${saved.added} 条`);
saved = archive.save([second], { requirement: "全部" });
check("模型换了说法，仍认得出是同一条", saved.added === 0 && saved.total === 1, `又入库 ${saved.added} 条，共 ${saved.total} 条`);

const third = {
  title: "航行警告！兴化湾江阴港海域实弹射击",
  summary: "福州海事局发布航行警告。",
  raw: other,
  ts: 1787664642000,
  origin: "示例快讯站聚合消息",
};
saved = archive.save([third], { requirement: "全部" });
check("真的新内容照常入库", saved.added === 1 && saved.total === 2, `共 ${saved.total} 条`);

// 老档案里没存原文的条目,退回标题加摘要,不能因此漏掉或重复
const legacy = { title: "老条目", summary: "早先存下的，没有原文", raw: "", ts: 1787660000000 };
saved = archive.save([legacy], { requirement: "全部" });
check("没有原文的老条目也能入库", saved.added === 1, `共 ${saved.total} 条`);
saved = archive.save([legacy], { requirement: "全部" });
check("没有原文的老条目不会重复入库", saved.added === 0, `共 ${saved.total} 条`);

console.log("\n四、换了指纹算法之后，老档案不会被重新灌一遍\n");

// 老条目：里面存着的 id 是旧算法（标题+摘要）算出来的，跟现在的算法对不上
const day = archive.today();
const dir = path.join(app.getPath("userData"), "archive");
const oldItem = {
  id: "0000000000000000",
  title: "跳水世青赛：中国队获混合团体冠军",
  summary: "中国队夺得混合团体冠军。",
  raw: "21:31:12 跳水世青赛：中国队获混合团体冠军 北京时间8月25日，2026年世界泳联青少年跳水锦标赛在克罗地亚里耶卡继续进行",
  ts: 1787664672000,
  savedAt: "2026-08-25T13:31:22.438Z",
};
// 同一条原文，模型换了个说法
const reworded = { ...oldItem, title: "跳水世青赛中国队夺冠", summary: "换个说法的摘要。" };

// 关掉程序再打开：内存里的热缓存没了，只能从磁盘认
function afterRestart() {
  delete require.cache[require.resolve("./electron/agent/archive")];
  return require("./electron/agent/archive");
}

// 前面几节已经往今天的档案里写过东西，这一节要的是干净的起点
function clearDay() {
  for (const name of [`${day}.jsonl`, `${day}.json`, `${day}.json.migrated`]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

// 现在的格式：一行一条的 JSONL
clearDay();
fs.writeFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify(oldItem)}\n`, "utf8");
const fromJsonl = afterRestart().save([reworded], { requirement: "全部" });
check(
  "老条目的 id 是旧算法算的，同一条不会再入库一遍",
  fromJsonl.added === 0,
  `又入库 ${fromJsonl.added} 条，共 ${fromJsonl.total} 条`,
);

// 从老版本升级上来的：磁盘上还是整份 JSON 的旧格式
clearDay();
fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify({ date: day, items: [oldItem] }, null, 2), "utf8");
const fromLegacy = afterRestart().save([reworded], { requirement: "全部" });
check("旧格式档案里的同一条也认得出", fromLegacy.added === 0, `又入库 ${fromLegacy.added} 条，共 ${fromLegacy.total} 条`);

// 旧格式档案遇到真的新内容：转成 JSONL，旧文件得让开，否则会被读成两份
clearDay();
fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify({ date: day, items: [oldItem] }, null, 2), "utf8");
const grown = afterRestart().save(
  [{ title: "另一条新闻", summary: "确实是新的", raw: "22:00:00 另一条新闻 内容跟上面那条无关" }],
  { requirement: "全部" },
);
check("旧格式档案照旧能加进新内容", grown.added === 1, `又入库 ${grown.added} 条，共 ${grown.total} 条`);
check("转成了 JSONL", fs.existsSync(path.join(dir, `${day}.jsonl`)), "");
check(
  "旧文件让开了，不会被当成第二份读进来",
  !fs.existsSync(path.join(dir, `${day}.json`)) && fs.existsSync(path.join(dir, `${day}.json.migrated`)),
  "",
);
const afterMigrate = afterRestart().readDay(day);
check("迁移之后读出来还是两条", afterMigrate.items.length === 2, `${afterMigrate.items.length} 条`);

const bad = results.filter((pass) => !pass).length;
console.log(`\n${results.length - bad}/${results.length} 项通过`);
console.log(bad ? "结论：有失败" : "结论：全部通过");
setTimeout(() => app.exit(bad ? 1 : 0), 50);
