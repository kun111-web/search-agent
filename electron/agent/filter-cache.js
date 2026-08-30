const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const { writeFileAtomic } = require("../atomic-write");

const FILE = "filter-cache.json";
const MAX_ENTRIES = 4000;
const SAVE_DEBOUNCE_MS = 2000;

// key -> 命中要求的文章对象，或 null 表示模型判过"不符合"。
// 取不到（undefined）才需要真的去问模型。
let entries = null;
let saveTimer = null;
let dirty = false;

function cachePath() {
  return path.join(app.getPath("userData"), FILE);
}

function load() {
  if (entries) {
    return entries;
  }
  entries = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (Array.isArray(parsed.entries)) {
      for (const [key, value] of parsed.entries) {
        entries.set(key, value);
      }
    }
  } catch {
    // 缓存没了最多是多花一次 token，不该拦住启动
  }
  return entries;
}

function save() {
  dirty = false;
  try {
    writeFileAtomic(cachePath(), JSON.stringify({ entries: [...load()] }));
  } catch {
    // 同上
  }
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

// 退出时把攒着的判定写下去。丢了不影响正确性，但这几批的 token 下次得重新花。
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (dirty) {
    save();
  }
}

// 换了要求或换了模型，之前的判定就不作数了，用指纹把它们隔在不同命名空间里。
function scopeOf(requirement, model) {
  return crypto
    .createHash("sha1")
    .update(`${requirement || ""}\u0000${model || ""}`)
    .digest("hex")
    .slice(0, 12);
}

function read(scope, itemKey) {
  const map = load();
  const key = `${scope}:${itemKey}`;
  if (!map.has(key)) {
    return undefined;
  }
  // 命中就挪到末尾，容量满时优先淘汰最久没用到的。
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return value;
}

function write(scope, itemKey, value) {
  const map = load();
  const key = `${scope}:${itemKey}`;
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) {
    map.delete(map.keys().next().value);
  }
  scheduleSave();
}

function size() {
  return load().size;
}

function clear() {
  clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  entries = new Map();
  try {
    fs.rmSync(cachePath(), { force: true });
    return { ok: true };
  } catch {
    // 文件被占用或没权限删掉时，只清内存是不够的：用户清完直接退出，
    // 下次启动又会把整份旧判定读回来，看起来就像清空按钮没生效。
    try {
      writeFileAtomic(cachePath(), JSON.stringify({ entries: [] }));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }
}

module.exports = {
  scopeOf,
  read,
  write,
  size,
  clear,
  flush,
};
