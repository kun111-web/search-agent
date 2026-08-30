const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { writeFileAtomic } = require("./atomic-write");

const FILE = "browser-session.json";
const SAVE_DEBOUNCE_MS = 800;
const MAX_TABS = 30;

let saveTimer = null;
let lastWritten = "";

function sessionPath() {
  return path.join(app.getPath("userData"), FILE);
}

function isRestorable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function readSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(), "utf8"));
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs
          .filter((tab) => isRestorable(tab?.url))
          .slice(0, MAX_TABS)
          .map((tab) => ({ url: tab.url, title: String(tab.title || "") }))
      : [];
    return {
      tabs,
      activeIndex: Math.min(Math.max(0, Number(parsed.activeIndex) || 0), Math.max(0, tabs.length - 1)),
      collectorOpen: Boolean(parsed.collectorOpen),
    };
  } catch {
    return { tabs: [], activeIndex: 0, collectorOpen: false };
  }
}

// 每次浏览器状态广播都会安排一次落盘，但加载开始/结束、前进后退可用性这些
// 变化并不进会话文件，序列化结果没变就不用再动磁盘。
function writeSession(payload) {
  const text = JSON.stringify(payload, null, 2);
  if (text === lastWritten) {
    return;
  }
  try {
    writeFileAtomic(sessionPath(), text);
    lastWritten = text;
  } catch {
    // 会话恢复只是锦上添花，写不进去也不该影响浏览
  }
}

// 标签页状态变化很频繁（加载、标题更新、切换），攒一下再落盘。
function scheduleSave(collect) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSession(collect());
  }, SAVE_DEBOUNCE_MS);
}

function flushSave(collect) {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeSession(collect());
}

// 关窗途中还会广播几次状态，每次都会再安排一次落盘。等那个定时器真的到点，
// 标签页早就拆完了，收集到的是一份空会话，写下去等于把用户的标签页全丢掉。
function cancelSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
}

module.exports = {
  readSession,
  scheduleSave,
  flushSave,
  cancelSave,
};
