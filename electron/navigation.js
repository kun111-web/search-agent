const NEW_TAB_MARKERS = ["newtab.html", "collector.html"];
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;
// 这几种协议在当前页上下文里执行或内联内容，地址栏和页面弹窗都不该放行。
const BLOCKED_SCHEMES = new Set(["javascript", "data", "blob", "vbscript", "filesystem"]);
const WEB_SCHEMES = new Set(["http", "https"]);
// localhost:3000、192.168.1.9:8080 这类写法前半截长得就像协议名，
// 必须先认出来补协议，否则会被当成 "localhost:" 协议扔给 loadURL。
const HOST_PORT_PATTERN = /^[\w-]+(?:\.[\w-]+)*:\d+(?:[/?#]|$)/;
// 本机和内网服务基本都只听 http，补 https 等于必然连不上。
const LOCAL_HOST_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?(?:[/?#]|$)/i;

function schemeOf(value) {
  const match = SCHEME_PATTERN.exec(value);
  return match ? match[1].toLowerCase() : "";
}

function isInternalNewTab(url) {
  if (!url) {
    return true;
  }
  return url.startsWith("file://") && NEW_TAB_MARKERS.some((marker) => url.includes(marker));
}

function looksLikeUrl(value) {
  if (SCHEME_PATTERN.test(value)) {
    return true;
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(value)) {
    return true;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|$)/.test(value)) {
    return true;
  }
  return /^[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$)/.test(value);
}

function normalizeNavigationInput(rawInput) {
  const value = String(rawInput || "").trim();
  if (!value) {
    return "";
  }

  if (looksLikeUrl(value)) {
    const scheme = schemeOf(value);
    if (scheme && BLOCKED_SCHEMES.has(scheme)) {
      return "";
    }
    if (scheme && !HOST_PORT_PATTERN.test(value)) {
      return value;
    }
    return `${LOCAL_HOST_PATTERN.test(value) ? "http" : "https"}://${value}`;
  }

  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

// 页面自己要求开新标签时，只认真正的网页地址：window.open("file:///...")
// 之类的请求不该由我们代为打开。
function normalizeExternalUrl(rawInput) {
  const value = String(rawInput || "").trim();
  return WEB_SCHEMES.has(schemeOf(value)) ? value : "";
}

module.exports = {
  isInternalNewTab,
  looksLikeUrl,
  normalizeNavigationInput,
  normalizeExternalUrl,
};
