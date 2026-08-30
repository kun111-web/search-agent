// 连不上模型的时候，重试到底隔多久来一次。退避是按失败次数往上加的，但采集那头
// 每采到新内容也会叫一次筛选——那一叫不能把退避绕过去，否则断网时会每隔一两秒就硬撞
// 一次接口。跑法：npx electron .retry-pace-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "retry-pace-")));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "通过  " : "不通过"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const { PageScraper } = require("./electron/agent/scraper");

// 模型这头一直连不上，记下每次尝试的时刻
function brokenPool(attempts) {
  return {
    hasKey: () => true,
    preferredModel: () => "m",
    complete: async () => {
      attempts.push(Date.now());
      const error = new Error("连不上模型接口：socket hang up");
      error.kind = "network";
      throw error;
    },
  };
}

function newScraper(events = []) {
  const scraper = new PageScraper({ activeTabId: "t1", tabFor: () => ({ id: "t1" }) }, (event) => events.push(event));
  scraper.savePool = () => {};
  scraper.archiveArticles = () => {};
  return scraper;
}

// 球和主窗口的状态栏都从这两种事件取字
function lastStatus(events) {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    if (events[at].type === "agent-status") {
      return events[at];
    }
  }
  return null;
}

function lastFiltering(events) {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    if (events[at].type === "filtering" && events[at].active) {
      return events[at];
    }
  }
  return null;
}

function feed(scraper, count, from = 0) {
  for (let at = 0; at < count; at += 1) {
    scraper.pending.push({
      key: `k${from + at}`,
      text: `22:${String(from + at).padStart(2, "0")}:00 第 ${from + at} 条内容，长度够进库`,
      ts: 1787664643000 + (from + at) * 1000,
      arrival: from + at,
      origin: "甲站",
      originId: "t1",
      originUrl: "https://example.com/",
    });
  }
}

(async () => {
  const attempts = [];
  const events = [];
  const scraper = newScraper(events);
  scraper.agentRunning = true;
  scraper.requirement = "只要财经";
  scraper.pool = brokenPool(attempts);
  feed(scraper, 40);

  // 第一批：当场失败，定下退避
  await scraper.flushAgent();
  check("连不上模型时这一批退回了队列", scraper.queueSize() === 40, `队列 ${scraper.queueSize()} 条`);
  check("试过一次", attempts.length === 1, `${attempts.length} 次`);

  // 断连本身还不算"重连失败"，此刻该说的是"等着重连"
  const first = lastStatus(events);
  check("断连时状态栏说要重连", /连不上模型，\d+ 秒后重连/.test(first?.message || ""), first?.message || "没有");
  check("而且是警示的调子", first?.tone === "warn", `tone=${first?.tone}`);

  // 采集那头马上采到新内容，连着叫好几次筛选。退避还没到点，一次都不该发出去。
  const before = attempts.length;
  for (let round = 0; round < 5; round += 1) {
    feed(scraper, 2, 100 + round * 2);
    await scraper.flushAgent();
  }
  const extra = attempts.length - before;
  check("采到新内容不会把退避绕过去", extra === 0, `退避没到点却又发了 ${extra} 次`);

  // 等到退避到点，该重试了
  await new Promise((resolve) => setTimeout(resolve, 4200));
  await scraper.flushAgent();
  check("退避到点会重试", attempts.length === before + 1, `一共试了 ${attempts.length} 次`);

  // 发起重连的那一刻，状态栏不能跟平常筛选长一个样
  const trying = lastFiltering(events);
  check("重连中带着第几次", trying?.retry === 1, `retry=${trying?.retry}`);

  // 这一次又没成：现在才轮到"重连失败"
  const failed = lastStatus(events);
  check("重连失败说得明白", /第 1 次重连失败，\d+ 秒后再试/.test(failed?.message || ""), failed?.message || "没有");
  check("重连失败也是警示的调子", failed?.tone === "warn", `tone=${failed?.tone}`);

  // 退避随失败次数往上加：第一次 4 秒，第二次 8 秒
  const waited = 8000;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await scraper.flushAgent();
  check("第二次的退避更长，中途还是不发", attempts.length === before + 1, `一共试了 ${attempts.length} 次`);

  // 连不上属于"等着重连"，不该把筛选停掉——网回来了得能自己接上
  check("连不上不会把筛选停掉", scraper.agentRunning === true, `agentRunning=${scraper.agentRunning}`);
  check("条目一条没丢", scraper.queueSize() === 50, `队列 ${scraper.queueSize()} 条`);

  // 网回来了：这一批该正常筛出来，并且退避立刻清掉
  scraper.pool = {
    hasKey: () => true,
    preferredModel: () => "m",
    complete: async () => ({
      data: { articles: [{ index: 1, title: "通了", summary: "网回来了", match: "符合" }] },
      usage: null,
      model: "m",
    }),
  };
  // 基线要在等待之前取：上一批失败时定下的那个退避定时器会在这段 sleep 里自己到点，
  // 那一次就是真正的"重连成功"。
  const beforeOk = events.length;
  await new Promise((resolve) => setTimeout(resolve, waited));
  await scraper.flushAgent();
  check("网回来后筛出了内容", scraper.articles.length > 0, `${scraper.articles.length} 篇`);

  // 通了得说一声：状态栏上一直挂着"第 N 次重连失败"，不给交代就看不出恢复了没有
  const recovered = events
    .slice(beforeOk)
    .find((event) => event.type === "agent-status" && String(event.message).includes("重连成功"));
  check("重连成功有交代", Boolean(recovered), recovered?.message || "什么都没说");
  const step = scraper.steps.find((item) => item.input === "重连成功");
  check("步骤列表里留了痕迹", Boolean(step), step ? step.result : "没有这一步");
  // 一批成功就把退避解除，攒着的那些跟着一路筛完，不用再等
  check(
    "成功之后不再受退避拖着",
    scraper.retryNotBefore === 0 && scraper.queueSize() === 0,
    `退避闸=${scraper.retryNotBefore}，队列还剩 ${scraper.queueSize()} 条`,
  );

  const bad = results.filter((item) => !item.pass);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  for (const item of bad) {
    console.log(`  - ${item.name}`);
  }
  app.exit(bad.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
