const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { writeFileAtomic } = require("../atomic-write");

// 地址、模型、Key 一律留空，得自己去设置里填。源码里不预置任何一家的接口，也就不会
// 把谁的地址或 Key 跟着代码一起发出去。
const DEFAULTS = {
  baseUrl: "",
  model: "",
  apiKey: "",
  // 接口格式：chat 是 /chat/completions 那套，responses 是 /responses 那套。
  apiFormat: "chat",
  // 主模型连不上时顶上来的那个。填了地址、模型和 Key 才算启用。
  // 筛选是个分类活，用便宜快的小模型就够（请求里本来就显式关掉了思考模式）。
  fallbackBaseUrl: "",
  fallbackModel: "",
  fallbackApiKey: "",
  fallbackApiFormat: "chat",
  maxMinutes: 0,
  refreshSeconds: 45,
  batchSize: 8,
};

const FORMATS = new Set(["chat", "responses"]);

function normalizeFormat(value) {
  const wanted = String(value || "").trim();
  return FORMATS.has(wanted) ? wanted : DEFAULTS.apiFormat;
}

// 配置文件是明文 JSON，Key 以前就这么躺着。现在改成 DPAPI 加密（safeStorage）：
// 密文打上 enc:v1: 前缀存盘，读出来再解。加密绑定当前 Windows 账户，
// 别的账户就算拿到这份文件也解不出 Key。
const ENC_PREFIX = "enc:v1:";

function looksEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

function decryptKey(value) {
  const raw = String(value || "");
  if (!raw || !looksEncrypted(raw)) {
    return raw;
  }
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice(ENC_PREFIX.length), "base64"));
  } catch {
    // 密文解不开多半是换系统、换账户了。留着前缀发出去只会让每次请求都 401
    // 还看不出原因，当没填更诚实——用户重填一次 Key 就好了。
    return "";
  }
}

function encryptKey(value) {
  const raw = String(value || "").trim();
  if (!raw || looksEncrypted(raw)) {
    return raw;
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(raw).toString("base64");
    }
  } catch {
    // 掉到下面的明文兜底
  }
  // 有些环境（不可用的 keyring）就是加不了密。能明文用总比没法用强，
  // 下次环境正常了写入时自然换成密文。
  return raw;
}

function toNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function settingsPath() {
  return path.join(app.getPath("userData"), "agent-settings.json");
}

// 配置读不出来时也得给一份能用的，但"文件还没建"和"文件坏了"得分开对待：后者拿默认值
// 顶上之后，用户随手改一项就会把整份文件按"默认值 + 那一项"盖掉，填了很久的 API Key
// 就此消失，看着像是程序自己把 Key 吃了。所以坏掉的原文先留一份在旁边。
function keepCorrupt(raw) {
  const backup = `${settingsPath()}.corrupt`;
  try {
    // 只留第一份：后面每次读都会再走一遍这里，覆盖的话就把唯一那份好数据也冲掉了。
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, raw);
    }
  } catch {
    // 备份不成也只能算了，不能因此让程序起不来
  }
}

function readSettings() {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath(), "utf8");
  } catch {
    // 还没存过配置，用默认的
    return { ...DEFAULTS };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      // 密文只能在这一层还原成明文。文件里躺着的、往外传的都过这一步，
      // 调用方拿到的永远是能直接用的 Key。
      apiKey: decryptKey(parsed.apiKey),
      fallbackApiKey: decryptKey(parsed.fallbackApiKey),
      apiFormat: normalizeFormat(parsed.apiFormat),
      fallbackApiFormat: normalizeFormat(parsed.fallbackApiFormat),
      maxMinutes: toNumber(parsed.maxMinutes, DEFAULTS.maxMinutes),
      refreshSeconds: toNumber(parsed.refreshSeconds, DEFAULTS.refreshSeconds),
      batchSize: toNumber(parsed.batchSize, DEFAULTS.batchSize),
    };
  } catch {
    keepCorrupt(raw);
    return { ...DEFAULTS };
  }
}

function writeSettings(partial) {
  const next = {
    ...readSettings(),
    ...partial,
  };
  next.maxMinutes = Math.min(1440, Math.max(0, Number(next.maxMinutes) || 0));
  next.refreshSeconds = Math.min(3600, Math.max(0, Number(next.refreshSeconds) || 0));
  next.batchSize = Math.round(Math.min(32, Math.max(1, Number(next.batchSize) || DEFAULTS.batchSize)));
  next.baseUrl = String(next.baseUrl || DEFAULTS.baseUrl).trim();
  next.model = String(next.model || DEFAULTS.model).trim();
  next.apiFormat = normalizeFormat(next.apiFormat);
  next.fallbackApiFormat = normalizeFormat(next.fallbackApiFormat);
  // Key 只在落盘这一刻才变成密文；内存里（readSettings 返回的）始终是明文。
  // 存进去已经是密文的不重复加密。
  next.apiKey = encryptKey(next.apiKey);
  next.fallbackApiKey = encryptKey(next.fallbackApiKey);
  next.fallbackBaseUrl = String(next.fallbackBaseUrl || DEFAULTS.fallbackBaseUrl).trim();
  next.fallbackModel = String(next.fallbackModel || DEFAULTS.fallbackModel).trim();
  writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2));
  // 落盘的这份里 Key 已是密文；返回给调用方（publicSettings 会接着把值透给渲染层）的还是
  // 明文那份，不然设置面板上会出现 "enc:v1:…"。
  return {
    ...next,
    apiKey: decryptKey(next.apiKey),
    fallbackApiKey: decryptKey(next.fallbackApiKey),
  };
}

function publicSettings(settings = readSettings()) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    apiFormat: settings.apiFormat,
    fallbackBaseUrl: settings.fallbackBaseUrl,
    fallbackModel: settings.fallbackModel,
    fallbackApiKey: settings.fallbackApiKey,
    fallbackApiFormat: settings.fallbackApiFormat,
    maxMinutes: settings.maxMinutes,
    refreshSeconds: settings.refreshSeconds,
    batchSize: settings.batchSize,
    hasKey: Boolean(settings.apiKey),
  };
}

module.exports = {
  DEFAULTS,
  readSettings,
  writeSettings,
  publicSettings,
};
