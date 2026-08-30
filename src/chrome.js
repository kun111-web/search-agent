const tabsEl = document.querySelector("#tabs");
const urlInput = document.querySelector("#url");
const backBtn = document.querySelector("#back");
const forwardBtn = document.querySelector("#forward");
const reloadBtn = document.querySelector("#reload");
const secureEl = document.querySelector("#secure");
const progressEl = document.querySelector("#progress");
const collectorBtn = document.querySelector("#toggle-collector");

let editingUrl = false;
let state = null;
let tabsSignature = "";

function signatureOf(nextState) {
  return nextState.tabs
    .map((tab) => [tab.id, tab.title, tab.favicon].join("\u0000"))
    .concat(nextState.activeTabId || "")
    .join("\u0001");
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...state.tabs.map((tab) => {
      const button = document.createElement("button");
      button.className = `tab${tab.id === state.activeTabId ? " active" : ""}`;
      button.type = "button";
      button.dataset.id = tab.id;

      if (tab.favicon) {
        const icon = document.createElement("img");
        icon.src = tab.favicon;
        icon.alt = "";
        icon.referrerPolicy = "no-referrer";
        button.append(icon);
      } else {
        const dot = document.createElement("i");
        dot.className = "dot";
        button.append(dot);
      }

      const title = document.createElement("span");
      title.textContent = tab.title || "新标签页";
      button.append(title);

      const close = document.createElement("button");
      close.className = "close";
      close.type = "button";
      close.dataset.close = tab.id;
      close.textContent = "×";
      button.append(close);
      return button;
    }),
  );
}

function render(nextState) {
  if (!nextState) {
    return;
  }
  state = nextState;

  // 加载进度、agent 心跳都会推状态过来，但标签条大多数时候没变，不值得整条重建。
  const signature = signatureOf(state);
  if (signature !== tabsSignature) {
    tabsSignature = signature;
    renderTabs();
  }

  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  reloadBtn.title = state.loading ? "停止" : "刷新";
  progressEl.hidden = !state.loading && !state.agentRunning;
  collectorBtn.textContent = state.agentRunning ? "运行中" : "Agent";
  secureEl.className = `secure${state.isSecure ? " ok" : state.displayUrl ? " warn" : ""}`;

  if (!editingUrl) {
    urlInput.value = state.displayUrl;
  }
}

tabsEl.addEventListener("click", async (event) => {
  const closeId = event.target.dataset.close;
  if (closeId) {
    event.stopPropagation();
    await window.browser.closeTab(closeId);
    return;
  }

  const tab = event.target.closest(".tab");
  if (tab?.dataset.id) {
    await window.browser.activateTab(tab.dataset.id);
  }
});

document.querySelector("#new-tab").addEventListener("click", () => window.browser.createTab());
document.querySelector("#back").addEventListener("click", () => window.browser.goBack());
document.querySelector("#forward").addEventListener("click", () => window.browser.goForward());
document.querySelector("#reload").addEventListener("click", () => window.browser.reload());
document.querySelector("#home").addEventListener("click", () => window.browser.goHome());
document.querySelector("#collect").addEventListener("click", () => window.browser.collect());
collectorBtn.addEventListener("click", () => window.browser.toggleCollector());

document.querySelector("#omnibox").addEventListener("submit", async (event) => {
  event.preventDefault();
  editingUrl = false;
  urlInput.blur();
  await window.browser.navigate(urlInput.value);
});

urlInput.addEventListener("focus", () => {
  editingUrl = true;
  urlInput.select();
});

urlInput.addEventListener("blur", () => {
  editingUrl = false;
  if (state) {
    urlInput.value = state.displayUrl;
  }
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    urlInput.focus();
    urlInput.select();
  }
});

window.browser.onState(render);
window.browser.ready().then(render);
