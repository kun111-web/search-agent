// ?????????????????????????????????????????
// ???? collector.html??????????????????????????????
// ???npx electron .picks-render-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "??  " : "???"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "picks-render-"));
const stubPreload = path.join(stubDir, "stub-preload.js");
fs.writeFileSync(
  stubPreload,
  `const { contextBridge } = require("electron");
const listeners = {};
const calls = [];
const settings = {
  baseUrl: "https://example.com/v1", model: "m", apiKey: "",
  fallbackBaseUrl: "https://example.com/v1", fallbackModel: "f", fallbackApiKey: "",
  maxMinutes: 0, refreshSeconds: 45, hasKey: false,
};
contextBridge.exposeInMainWorld("browser", {
  onAgent: (fn) => { listeners.agent = fn; },
  onState: (fn) => { listeners.state = fn; },
  getSettings: async () => settings,
  saveSettings: async (next) => { calls.push(["saveSettings", next]); return settings; },
  testSettings: async () => ({ main: { model: "m", ok: true } }),
  getAgentState: async () => ({ running: false, agentRunning: false, steps: [], articles: [], rawItems: [], rawTotal: 0, summary: "", pending: 0, sources: [] }),
  getArchiveDays: async () => [],
  getArchiveDay: async () => ({ items: [] }),
  getCacheStats: async () => ({ size: 0 }),
  getDefaultSites: async () => ["https://news.example.com/"],
  ready: async () => ({ ok: true }),
  startCollect: async (task, ids) => { calls.push(["startCollect", task, ids]); },
  stopCollect: async () => {},
  startFilter: async () => {},
  stopFilter: async () => {},
  minimizeToOrb: async () => {},
  clearArchive: async () => ({ ok: true }),
  clearCache: async () => ({ ok: true }),
  exportArchive: async () => ({ ok: true }),
  removeArchiveDay: async () => ({ ok: true }),
  removeArchiveItem: async () => ({ ok: true }),
});
contextBridge.exposeInMainWorld("harness", {
  emit: (name, payload) => { listeners[name]?.(payload); },
  calls: () => calls,
});
`,
  "utf8",
);

const NEWS_SITE = { id: "t1", title: "????", url: "https://news.example.com/", displayUrl: "news.example.com" };
const OTHER = { id: "t2", title: "????", url: "https://example.com/news", displayUrl: "example.com" };
const state = (list) => JSON.stringify({ tabs: list, activeTabId: "t1" });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: stubPreload, sandbox: false, contextIsolation: true },
  });

  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      errors.push(event.message);
    }
  });

  await win.loadFile(path.join(__dirname, "src/collector.html"));
  const run = (script) => win.webContents.executeJavaScript(script, true);
  // ??????????????
  await new Promise((resolve) => setTimeout(resolve, 400));

  await run(`window.harness.emit("state", ${state([NEWS_SITE, OTHER])})`);
  const shown = await run(`document.querySelectorAll("#tab-picks .pick").length`);
  check("???????", shown === 2, `${shown} ?`);

  // ????????????????????
  await run(`[...document.querySelectorAll("#tab-picks input")].forEach((box, at) => { box.dataset.mark = "m" + at; })`);

  // ????????????????????????????????????????????
  for (let round = 0; round < 4; round += 1) {
    await run(`window.harness.emit("state", ${state([NEWS_SITE, OTHER])})`);
  }
  const marks = await run(`[...document.querySelectorAll("#tab-picks input")].map((box) => box.dataset.mark || "")`);
  check("?????????????", marks.join(",") === "m0,m1", `?? ${marks.join(",") || "???"}`);

  // ???????????????????
  await run(`document.querySelectorAll("#tab-picks input")[1].click()`);
  await run(`window.harness.emit("state", ${state([NEWS_SITE, OTHER])})`);
  const stillChecked = await run(`document.querySelectorAll("#tab-picks input")[1].checked`);
  check("?????????????", stillChecked === true, `checked=${stillChecked}`);

  // ?????????
  const renamed = { ...NEWS_SITE, title: "????-???" };
  await run(`window.harness.emit("state", ${state([renamed, OTHER])})`);
  const labels = await run(`[...document.querySelectorAll("#tab-picks .pick span")].map((el) => el.textContent)`);
  check("??????????", labels.some((text) => text.includes("???")), labels.join(" | "));
  const keptAfterRename = await run(`document.querySelectorAll("#tab-picks input")[1].checked`);
  check("??????????", keptAfterRename === true, `checked=${keptAfterRename}`);

  // ?????????????????????????????????????????
  // ??????????????????????????????
  const blank = { id: "t2", title: "????", url: "about:blank", isNewTab: true, displayUrl: "" };
  await run(`window.harness.emit("state", ${state([NEWS_SITE, blank])})`);
  const rows = await run(`document.querySelectorAll("#tab-picks .pick").length`);
  check("?????????????", rows === 1, `${rows} ?`);

  await run(`document.querySelector("#start").click()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const startCall = await run(`JSON.stringify(window.harness.calls().find((c) => c[0] === "startCollect") || [])`);
  const parsed = JSON.parse(startCall);
  check("?????????", Array.isArray(parsed[2]) && !parsed[2].includes("t2"), startCall);

  check("????????", errors.length === 0, errors.join(" | "));

  const bad = results.filter((item) => !item.pass);
  console.log(`\n${results.length - bad.length}/${results.length} ??`);
  for (const item of bad) {
    console.log(`  - ${item.name}`);
  }
  app.exit(bad.length ? 1 : 0);
});
