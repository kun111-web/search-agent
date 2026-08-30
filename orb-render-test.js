// 悬浮球界面的烟雾测试：把真的 orb.html 加载起来，喂几轮消息，看画出来的是什么。
// 桩掉 preload 里那套 IPC，只留渲染逻辑。跑法：npx electron .orb-render-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "通过  " : "不通过"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// 桩 preload：把主进程那头的调用都记下来，事件回调留给测试自己触发。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-render-"));
const stubPreload = path.join(stubDir, "stub-preload.js");
fs.writeFileSync(
  stubPreload,
  `const { contextBridge } = require("electron");
const listeners = {};
const calls = [];
const noop = (name) => (...args) => { calls.push([name, ...args]); };
contextBridge.exposeInMainWorld("orb", {
  onCards: (fn) => { listeners.cards = fn; },
  onStatus: (fn) => { listeners.status = fn; },
  onLayout: (fn) => { listeners.layout = fn; },
  onFont: (fn) => { listeners.font = fn; },
  restore: noop("restore"),
  markRead: noop("markRead"),
  setExpanded: noop("setExpanded"),
  setInteractive: noop("setInteractive"),
  dragStart: noop("dragStart"),
  dragEnd: noop("dragEnd"),
  resizeStart: noop("resizeStart"),
  resizeEnd: noop("resizeEnd"),
  stepFont: noop("stepFont"),
});
contextBridge.exposeInMainWorld("harness", {
  emit: (name, payload) => { listeners[name]?.(payload); },
  calls: () => calls,
});
`,
  "utf8",
);

function card(id, title) {
  return { originId: id, title, summary: `${title}的摘要`, time: "22:00", match: "符合" };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: stubPreload, sandbox: false, contextIsolation: true },
  });

  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    // 抓屏那条是必然失败的（无头窗口拿不到屏幕流），不算问题
    if (level >= 2 && !message.includes("屏幕流启动失败")) {
      errors.push(message);
    }
  });
  win.webContents.on("preload-error", (_event, _file, error) => errors.push(`preload: ${error.message}`));

  await win.loadFile(path.join(__dirname, "src/orb.html"));
  const run = (script) => win.webContents.executeJavaScript(script, true);

  // 一个来源：先两条
  await run(`window.harness.emit("cards", { items: [${JSON.stringify(card("t1", "第一条"))}, ${JSON.stringify(card("t1", "第二条"))}], sources: [{ id: "t1", label: "甲站" }] })`);
  const first = await run(`({
    count: document.querySelectorAll("#panel-body .card").length,
    fresh: document.querySelectorAll("#panel-body .card.fresh").length,
    badge: document.querySelector("#badge").textContent,
  })`);
  check("两条消息都画出来了", first.count === 2, `${first.count} 张卡片`);
  check("第一次画的不算新消息", first.fresh === 0, `${first.fresh} 张带高亮`);

  // 同一份列表再来一遍（球窗口重建时就是这个情形）：不该凭空冒出高亮
  await run(`window.harness.emit("cards", { items: [${JSON.stringify(card("t1", "第一条"))}, ${JSON.stringify(card("t1", "第二条"))}], sources: [{ id: "t1", label: "甲站" }] })`);
  const again = await run(`document.querySelectorAll("#panel-body .card.fresh").length`);
  check("同一份列表重画，最上面那条不再永远算新", again === 0, `${again} 张带高亮`);

  // 真来了新的一条
  await run(`window.harness.emit("cards", { items: [${JSON.stringify(card("t1", "刚到的"))}, ${JSON.stringify(card("t1", "第一条"))}, ${JSON.stringify(card("t1", "第二条"))}], sources: [{ id: "t1", label: "甲站" }] })`);
  const fresh = await run(`({
    count: document.querySelectorAll("#panel-body .card").length,
    fresh: [...document.querySelectorAll("#panel-body .card.fresh")].map((el) => el.querySelector("strong").textContent),
  })`);
  check("真的新消息带上了高亮", fresh.fresh.length === 1 && fresh.fresh[0] === "刚到的", fresh.fresh.join("、") || "没有");

  // 两个来源：分块
  const two = `[${JSON.stringify(card("t1", "甲站消息"))}, ${JSON.stringify(card("t2", "乙站消息"))}, ${JSON.stringify(card("t9", "老消息"))}]`;
  await run(`window.harness.emit("cards", { items: ${two}, sources: [{ id: "t1", label: "甲站" }, { id: "t2", label: "乙站" }] })`);
  const grouped = await run(`({
    groups: [...document.querySelectorAll("#panel-body .group header")].map((el) => el.textContent),
    cards: document.querySelectorAll("#panel-body .card").length,
  })`);
  check("两个来源分成两块，另加一块兜底", grouped.groups.length === 3, grouped.groups.join(" | "));
  check("三条消息各就各位", grouped.cards === 3, `${grouped.cards} 张`);

  // 翻到下面读旧消息时，新消息不该把人甩回顶部。面板收着的时候没有布局，滚不动，
  // 得先展开。
  await run(`document.querySelector("#expand").click()`);
  const scrolledTo = await run(`(() => {
    const body = document.querySelector("#panel-body");
    body.style.height = "60px";
    body.style.overflowY = "scroll";
    body.scrollTop = 30;
    return body.scrollTop;
  })()`);
  const more = `[${JSON.stringify(card("t1", "又到一条"))}, ${JSON.stringify(card("t1", "甲站消息"))}, ${JSON.stringify(card("t2", "乙站消息"))}, ${JSON.stringify(card("t9", "老消息"))}]`;
  await run(`window.harness.emit("cards", { items: ${more}, sources: [{ id: "t1", label: "甲站" }, { id: "t2", label: "乙站" }] })`);
  const after = await run(`document.querySelector("#panel-body").scrollTop`);
  check("正在读下面时新消息不把人甩回顶部", scrolledTo > 0 && after > 0, `原来 ${scrolledTo} → 现在 ${after}`);

  // 停在顶上的照旧跟着最新走
  await run(`document.querySelector("#panel-body").scrollTop = 0`);
  await run(`window.harness.emit("cards", { items: ${two}, sources: [{ id: "t1", label: "甲站" }, { id: "t2", label: "乙站" }] })`);
  const atTop = await run(`document.querySelector("#panel-body").scrollTop`);
  check("本来停在顶上的仍然停在顶上", atTop === 0, `${atTop}`);

  // 指针压在面板上时会放开鼠标穿透。收起面板之后指针多半落到了窗口外面，那之后既没有
  // mousemove 也没有 mouseleave，穿透要是不主动放开，球周围一整片会一直挡着桌面上的点击。
  await run(`(() => {
    const box = document.querySelector("#panel").getBoundingClientRect();
    document.dispatchEvent(new MouseEvent("mousemove", {
      clientX: Math.round(box.x + box.width / 2),
      clientY: Math.round(box.y + box.height / 2),
      bubbles: true,
    }));
  })()`);
  const grabbed = await run(`document.body.dataset.hit`);
  check("指针压在面板上就放开交互", grabbed === "1", `hit=${grabbed}`);

  await run(`document.querySelector("#collapse").click()`);
  const released = await run(`document.body.dataset.hit`);
  const calls = await run(`window.harness.calls().filter((c) => c[0] === "setInteractive").map((c) => String(c[1]))`);
  check("收起面板会主动放开鼠标穿透", released === "0", `hit=${released}，通知过 ${calls.join(",")}`);

  // 模型那一行要能看出"在重连"和"重连失败"，不能跟平常筛选长一个样
  const modelLine = () => run(`({
    text: document.querySelector("#status-model .text").textContent,
    warn: document.querySelector("#status-model").classList.contains("warn"),
    on: document.querySelector("#status-model").classList.contains("on"),
  })`);

  await run(`window.harness.emit("status", { collect: "采集中", model: "正在筛 8 条 · mimo-v2.5", collectRunning: true, modelRunning: true, modelWarn: false })`);
  const normal = await modelLine();
  check("平常筛选是常态的样子", normal.text.includes("正在筛") && !normal.warn, `${normal.text}，warn=${normal.warn}`);

  await run(`window.harness.emit("status", { collect: "采集中", model: "连不上模型，4 秒后重连", collectRunning: true, modelRunning: true, modelWarn: true })`);
  const waiting = await modelLine();
  check("等着重连时是警示的样子", waiting.text.includes("秒后重连") && waiting.warn, `${waiting.text}，warn=${waiting.warn}`);

  await run(`window.harness.emit("status", { collect: "采集中", model: "正在重连（第 1 次） · mimo-v2.5", collectRunning: true, modelRunning: true, modelWarn: true })`);
  const retrying = await modelLine();
  check("正在重连看得出来", retrying.text.includes("正在重连（第 1 次）") && retrying.warn, `${retrying.text}，warn=${retrying.warn}`);

  await run(`window.harness.emit("status", { collect: "采集中", model: "第 1 次重连失败，8 秒后再试", collectRunning: true, modelRunning: true, modelWarn: true })`);
  const failedLine = await modelLine();
  check("重连失败看得出来", failedLine.text.includes("重连失败") && failedLine.warn, `${failedLine.text}，warn=${failedLine.warn}`);

  check("整个过程没有报错", errors.length === 0, errors.join(" | "));

  const bad = results.filter((item) => !item.pass);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  for (const item of bad) {
    console.log(`  - ${item.name}`);
  }
  app.exit(bad.length ? 1 : 0);
});
