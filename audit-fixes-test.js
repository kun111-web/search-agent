// node .audit-fixes-test.js — isolated business regression tests; no real credentials or APIs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const root = __dirname;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-fixes-"));
let dataDir = temp;
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "electron") return { app: { getPath: () => dataDir } };
  return originalLoad.call(this, name, parent, isMain);
};
let passed = 0;
async function test(name, fn) {
  dataDir = path.join(temp, String(passed));
  fs.mkdirSync(dataDir, { recursive: true });
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(root, "electron"))) delete require.cache[key];
  }
  await fn();
  for (const file of ["agent/filter-cache", "agent/archive"]) {
    const exports = require.cache[require.resolve(path.join(root, "electron", file))]?.exports;
    exports?.flush?.();
    exports?.flushPool?.();
  }
  passed++;
  console.log(`通过 ${name}`);
}
const mod = (name) => require(path.join(root, "electron", name));
const entry = (key, originId = "a", ts = 1) => ({ key, text: `测试正文-${key}`, originId,
  origin: originId, originUrl: `https://example.invalid/${originId}`, ts, arrival: ts });
function scraper(events = []) {
  const { PageScraper } = mod("agent/scraper");
  const s = new PageScraper({ showCollector() {} }, e => events.push(e));
  s.settings = { batchSize: 8 };
  s.agentRunning = true;
  s.agentController = new AbortController();
  return s;
}
function delayedPool() {
  let resolve, started;
  const ready = new Promise(r => started = r);
  return { ready, reply: () => resolve({ model: "audit", data: { articles: [{ index: 1, title: "有效标题", summary: "有效摘要" }] } }),
    hasKey: () => true, preferredModel: () => "audit", complete: () => {
      started(); return new Promise(r => resolve = r);
    } };
}

async function main() {
  await test("归档初次写失败抛错，恢复后可重试且不会误去重", () => {
    const a = mod("agent/archive");
    const file = path.join(dataDir, "archive", a.today() + ".jsonl");
    fs.mkdirSync(file, { recursive: true });
    const item = { title: "写入测试", raw: "归档首次写入的独立原文" };
    assert.throws(() => a.save([item]), /归档写入失败/);
    fs.rmdirSync(file);
    assert.equal(a.save([item, item]).added, 1);
    assert.equal(a.readDay(a.today()).items.length, 1);
    assert.equal(a.save([item]).added, 0);
  });
  await test("追加失败保留已落盘内容，恢复后补写失败条目", () => {
    const a = mod("agent/archive");
    a.save([{ title: "甲", raw: "第一篇独立内容" }]);
    const item = { title: "乙", raw: "第二篇完全不同的新闻" };
    const append = fs.appendFileSync;
    fs.appendFileSync = () => { throw new Error("simulated disk failure"); };
    try { assert.throws(() => a.save([item]), /归档写入失败/); }
    finally { fs.appendFileSync = append; }
    assert.equal(a.readDay(a.today()).items.length, 1);
    assert.equal(a.save([item]).total, 2);
    assert.equal(a.readDay(a.today()).items.length, 2);
  });
  await test("旧格式归档部分删除后删到空，重载不会复活", () => {
    const a = mod("agent/archive");
    const date = "2026-01-02";
    const file = path.join(dataDir, "archive", date + ".json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items: [{ id: "a", title: "甲" }, { id: "b", title: "乙" }] }));
    assert.equal(a.removeItem(date, "a").ok, true);
    assert.deepEqual(a.readDay(date).items.map(x => x.id), ["b"]);
    assert.equal(fs.existsSync(file), false);
    assert.equal(a.removeItem(date, "b").ok, true);
    delete require.cache[require.resolve("./electron/agent/archive")];
    assert.equal(mod("agent/archive").readDay(date).items.length, 0);
    assert.equal(mod("agent/archive").listDays().length, 0);
  });
  await test("旧文件清理失败也不会回退并复活已删内容", () => {
    const a = mod("agent/archive");
    const date = "2026-01-03";
    const file = path.join(dataDir, "archive", date + ".json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items: [{ id: "a", title: "甲" }] }));
    const remove = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (target === file) throw new Error("simulated file lock");
      return remove(target, options);
    };
    try { assert.equal(a.removeItem(date, "a").ok, false); }
    finally { fs.rmSync = remove; }
    assert.equal(a.readDay(date).items.length, 0);
    assert.equal(a.listDays().length, 0);
  });
  await test("双来源失败回队保留各 200 条，真实超限有提示", () => {
    const events = [], s = scraper(events);
    s.pending = [...Array.from({ length: 200 }, (_, n) => entry("a" + n, "a", 10000 - n)),
      ...Array.from({ length: 200 }, (_, n) => entry("b" + n, "b", 1000 - n))];
    const batch = s.takeBatch(s.pending);
    s.requeueFailedBatch(batch, { kind: "network", message: "offline" });
    assert.equal(s.pending.length, 400);
    assert.equal(s.pending.filter(x => x.originId === "b").length, 200);
    s.requeueFailedBatch([entry("extra", "a", 20000)], { kind: "network", message: "offline" });
    assert.equal(s.pending.length, 400);
    assert.ok(events.some(e => e.step?.result.includes("1 条最旧")));
    s.stopFilter();
  });
  await test("正文异常第六次暂停并保留队列，网络错误仍可重试", () => {
    const s = scraper();
    for (let n = 1; n <= 6; n++) {
      s.requeueFailedBatch(n === 1 ? [entry("failed")] : [], { kind: "response", message: "bad JSON" });
      assert.equal(s.agentRunning, n < 6);
    }
    assert.equal(s.pending.length, 1);
    assert.equal(s.retryTimer, null);
    const network = scraper();
    for (let n = 0; n < 10; n++) network.requeueFailedBatch([], { kind: "network", message: "offline" });
    assert.equal(network.agentRunning, true);
    network.stopFilter();
    const auth = scraper();
    for (let n = 1; n <= 3; n++) auth.requeueFailedBatch([], { kind: "auth", message: "bad key" });
    assert.equal(auth.agentRunning, false);
  });
  await test("缺失内容的模型条目不写拒绝缓存，再试会调用模型", async () => {
    const { filterArticles } = mod("agent/filter"), cache = mod("agent/filter-cache");
    let calls = 0;
    const pool = { hasKey: () => true, preferredModel: () => "audit", complete: async () => {
      calls++; return { model: "audit", data: { articles: calls === 1 ? [{ index: 1 }] : [{ index: 1, title: "恢复正常" }] } };
    } };
    const args = { pool, requirement: "全部保留", items: [entry("one")] };
    await assert.rejects(filterArticles(args), e => e.kind === "response");
    assert.equal(cache.size(), 0);
    assert.equal((await filterArticles(args)).articles.length, 1);
    assert.equal(calls, 2);
  });
  await test("明确的空 articles 仍能正常缓存拒绝", async () => {
    const { filterArticles } = mod("agent/filter");
    let calls = 0;
    const pool = { hasKey: () => true, preferredModel: () => "audit", complete: async () => {
      calls++; return { model: "audit", data: { articles: [] } };
    } };
    const args = { pool, items: [entry("none")], requirement: "不要任何内容" };
    await filterArticles(args);
    assert.equal((await filterArticles(args)).cached, 1);
    assert.equal(calls, 1);
  });
  for (const action of ["start", "startFilter", "clearOutputs", "stopFilter"]) {
    await test(`${action} 隔离旧请求；旧收尾不会清掉新批次状态或缓存`, async () => {
      const events = [], s = scraper(events), old = delayedPool();
      s.pool = old;
      s.pending = [entry("old")];
      const oldSignal = s.agentController.signal;
      const oldRun = s.flushAgent();
      await old.ready;
      if (action === "start") { s.run = async () => {}; await s.start("新要求", {}, []); }
      else if (action === "startFilter") s.startFilter("新要求", {});
      else if (action === "clearOutputs") s.clearOutputs();
      else { s.stopFilter(); s.startFilter("新要求", {}); }
      assert.equal(oldSignal.aborted, true);
      const next = delayedPool();
      s.pending = [entry("new")];
      s.pool = next;
      const nextRun = s.flushAgent();
      await next.ready;
      const count = events.length;
      old.reply();
      await oldRun;
      assert.equal(s.filtering, true);
      assert.equal(s.articles.length, 0);
      assert.equal(events.length, count);
      assert.equal(mod("agent/filter-cache").size(), 0);
      next.reply();
      await nextRun;
      assert.equal(s.filtering, false);
      assert.equal(s.articles.length, 1);
      assert.equal(s.articles[0].raw, "测试正文-new");
      assert.equal(mod("agent/archive").readDay(mod("agent/archive").today()).items.length, 1);
      s.stopFilter();
    });
  }
  await test("分发格式解开主备密文，任一解密失败则报错", () => {
    const { portableSettings } = require("./bundle/portable-settings");
    const settings = { model: "m", apiKey: "enc:v1:" + Buffer.from("main-test").toString("base64"),
      fallbackApiKey: "enc:v1:" + Buffer.from("fallback-test").toString("base64") };
    const out = portableSettings(settings, b => b.toString());
    assert.equal(out.apiKey, "main-test");
    assert.equal(out.fallbackApiKey, "fallback-test");
    assert.ok(settings.apiKey.startsWith("enc:v1:"));
    assert.throws(() => portableSettings(settings, () => { throw new Error("wrong account"); }), /无法.*解密/);
    assert.throws(() => portableSettings(settings, () => ""), /无效/);
    assert.deepEqual(portableSettings({ apiKey: "plain-test", fallbackApiKey: "" }, () => assert.fail()),
      { apiKey: "plain-test", fallbackApiKey: "" });
  });
  await test("生成器用解密结果生成脚本；解密失败时不改已有分发包", () => {
    const source = fs.readFileSync("bundle/make-bundle.js", "utf8");
    const run = (fail) => {
      const writes = [];
      const config = { apiKey: "enc:v1:ZmFrZQ==", fallbackApiKey: "", model: "test" };
      const fakeFs = { existsSync: () => true,
        readFileSync: file => file.endsWith("agent-settings.json") ? JSON.stringify(config) :
          file.endsWith(".template") ? "__CONFIG_JSON__" : '{"version":"test"}',
        mkdirSync: () => {}, copyFileSync: (a, b) => writes.push({ path: b }),
        writeFileSync: (file, text) => writes.push({ path: file, text }), readdirSync: () => [] };
      const context = { __dirname: path.join(root, "bundle"), console: { log() {}, error() {} },
        process: { env: { APPDATA: "fake-appdata", USERPROFILE: "fake-home" }, exit: () => { throw new Error("exit"); } },
        require: name => name === "node:fs" ? fakeFs : name === "electron" ? "fake-electron" :
          name === "node:child_process" ? { execFileSync: () => {
            if (fail) throw new Error("decrypt failed");
            return 'SEARCH_AGENT_CONFIG:{"apiKey":"portable-test","model":"test"}\n';
          } } : require(name) };
      if (fail) assert.throws(() => vm.runInNewContext(source, context), /exit/);
      else vm.runInNewContext(source, context);
      return writes;
    };
    assert.equal(run(true).length, 0);
    const generated = run(false).find(x => x.text);
    assert.ok(generated.text.includes("portable-test"));
    assert.ok(!generated.text.includes("enc:v1:"));
  });
  console.log(`\n${passed} 个回归场景全部通过`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
