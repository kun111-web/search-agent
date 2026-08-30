// 新标签页是 file:// 沙箱页，没有 preload 能共享主进程模块，这几条规则和
// electron/navigation.js 是同一套，改一处记得改另一处。
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;
const BLOCKED_SCHEMES = new Set(["javascript", "data", "blob", "vbscript", "filesystem"]);
const HOST_PORT_PATTERN = /^[\w-]+(?:\.[\w-]+)*:\d+(?:[/?#]|$)/;
const LOCAL_HOST_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?(?:[/?#]|$)/i;

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

function targetFor(value) {
  if (!looksLikeUrl(value)) {
    return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  }

  const scheme = (SCHEME_PATTERN.exec(value) || ["", ""])[1].toLowerCase();
  if (scheme && BLOCKED_SCHEMES.has(scheme)) {
    return "";
  }
  if (scheme && !HOST_PORT_PATTERN.test(value)) {
    return value;
  }
  return `${LOCAL_HOST_PATTERN.test(value) ? "http" : "https"}://${value}`;
}

document.querySelector("#search").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = document.querySelector("#query").value.trim();
  if (!value) {
    return;
  }

  const target = targetFor(value);
  if (target) {
    window.location.href = target;
  }
});
