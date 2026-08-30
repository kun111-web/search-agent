const { WebContentsView, Menu, clipboard } = require("electron");
const path = require("node:path");
const { normalizeNavigationInput, normalizeExternalUrl, isInternalNewTab } = require("./navigation");
const { DEFAULT_SITES } = require("./default-sites");
const { INSTALL_SCRIPT, READY_SCRIPT, DRAIN_SCRIPT, REFRESH_SCRIPT, UNINSTALL_SCRIPT } = require("./live-probe");

const CHROME_HEIGHT = 88;
const COLLECTOR_WIDTH = 500;
// 崩溃后自救的次数上限，以及"连着崩"的判定窗口：窗口一过就重新计数，
// 免得跑上一整天的标签页把偶发的几次崩溃攒够数、之后再也不自动恢复。
const CRASH_RELOAD_MAX = 3;
const CRASH_WINDOW_MS = 60000;
const CRASH_RELOAD_DELAY_MS = 600;
const NEW_TAB_FILE = path.join(__dirname, "../src/newtab.html");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 会被序列化后注入页面执行，不能引用模块作用域里的任何东西。
function extractPageMain(linkLimit) {
  const readText = (node) => (node && node.innerText ? node.innerText.trim() : "");
  const noisy = /nav|header|footer|sidebar|comment|recommend|related|share|advert|menu|toolbar|login/i;
  const selectors = [
    "article",
    "[itemprop='articleBody']",
    ".article-content",
    ".article__content",
    ".article-body",
    ".post-content",
    ".Post-RichText",
    ".rich_media_content",
    "#js_content",
    ".entry-content",
    ".content-article",
    ".syl-article-base",
    "main",
    "[role='main']",
  ];

  let text = "";
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (noisy.test(`${node.className} ${node.id}`)) {
        continue;
      }
      const candidate = readText(node);
      if (candidate.length > text.length) {
        text = candidate;
      }
    }
    if (text.length > 400) {
      break;
    }
  }

  if (text.length < 200) {
    const joined = Array.from(document.querySelectorAll("p"))
      .map((node) => readText(node))
      .filter((item) => item.length > 40)
      .join("\n");
    if (joined.length > text.length) {
      text = joined;
    }
  }

  if (text.length < 80) {
    text = document.body ? document.body.innerText : "";
  }

  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.href;
    if (!/^https?:/i.test(href) || seen.has(href)) {
      continue;
    }
    seen.add(href);
    links.push({ text: (anchor.innerText || "").trim().slice(0, 80), href });
    if (links.length >= linkLimit) {
      break;
    }
  }

  return {
    text,
    links,
    metaDescription: document.querySelector('meta[name="description"]')?.content || "",
    language: document.documentElement.lang || "",
  };
}

const EXTRACT_SOURCE = extractPageMain.toString();

class TabManager {
  constructor(window, chromeView) {
    this.window = window;
    this.chromeView = chromeView;
    this.tabs = new Map();
    this.activeTabId = null;
    this.nextId = 1;
    this.collectorOpen = false;
    this.collectorView = null;
    this.broadcast = () => {};
    this.onCollectResult = () => {};
  }

  setBroadcast(fn) {
    this.broadcast = fn;
  }

  setCollectHandler(fn) {
    this.onCollectResult = fn;
  }

  detachView(view) {
    if (!view) {
      return;
    }
    if (this.window.contentView.children.includes(view)) {
      this.window.contentView.removeChildView(view);
    }
  }

  // 建标签页但不激活。批量恢复会话时逐个激活会反复拆装 contentView 并重排版面。
  spawnTab(rawUrl) {
    const id = String(this.nextId++);
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:search-agent",
        backgroundThrottling: false,
      },
    });

    const tab = {
      id,
      view,
      title: "新标签页",
      url: "",
      displayUrl: "",
      favicon: "",
      loading: false,
      isNewTab: true,
      canGoBack: false,
      canGoForward: false,
      isSecure: false,
      crashes: 0,
      lastCrashAt: 0,
    };

    this.bindTabEvents(tab);
    this.tabs.set(id, tab);

    const target = rawUrl ? normalizeNavigationInput(rawUrl) : null;
    if (target) {
      view.webContents.loadURL(target);
    } else {
      view.webContents.loadFile(NEW_TAB_FILE);
    }

    return tab;
  }

  createTab(rawUrl) {
    const tab = this.spawnTab(rawUrl);
    this.activateTab(tab.id);
    return this.getState();
  }

  bindTabEvents(tab) {
    const { webContents } = tab.view;

    webContents.setWindowOpenHandler(({ url }) => {
      const target = normalizeExternalUrl(url);
      if (target) {
        this.createTab(target);
      }
      return { action: "deny" };
    });

    webContents.on("page-title-updated", (_event, title) => {
      tab.title = title || "新标签页";
      this.emitState();
    });

    webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons[0] || "";
      this.emitState();
    });

    webContents.on("did-start-loading", () => {
      tab.loading = true;
      this.emitState();
    });

    webContents.on("did-stop-loading", () => {
      tab.loading = false;
      this.refreshTabMeta(tab);
      this.emitState();
    });

    webContents.on("did-navigate", () => {
      this.refreshTabMeta(tab);
      this.emitState();
    });

    webContents.on("did-navigate-in-page", () => {
      this.refreshTabMeta(tab);
      this.emitState();
    });

    webContents.on("did-fail-load", (_event, errorCode, _description, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }
      tab.loading = false;
      tab.title = "无法打开页面";
      tab.displayUrl = validatedURL || tab.displayUrl;
      this.emitState();
    });

    // 渲染进程没了以后 webContents 还在，只是页面变成一片空白：采集循环会照旧
    // 转圈却再也拿不到内容，用户也只看到白屏。自己重载一次能救回大多数情况。
    webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") {
        return;
      }

      const now = Date.now();
      tab.crashes = now - tab.lastCrashAt > CRASH_WINDOW_MS ? 1 : tab.crashes + 1;
      tab.lastCrashAt = now;
      tab.loading = false;

      if (tab.crashes > CRASH_RELOAD_MAX) {
        tab.title = "页面反复崩溃";
        this.emitState();
        return;
      }

      tab.title = "页面崩溃了，正在重新加载";
      this.emitState();
      setTimeout(() => {
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.webContents.reload();
        }
      }, CRASH_RELOAD_DELAY_MS);
    });

    webContents.on("context-menu", (_event, params) => {
      const { navigationHistory } = webContents;
      const template = [
        { label: "后退", enabled: navigationHistory.canGoBack(), click: () => navigationHistory.goBack() },
        { label: "前进", enabled: navigationHistory.canGoForward(), click: () => navigationHistory.goForward() },
        { label: "重新加载", click: () => webContents.reload() },
        { type: "separator" },
        { label: "复制", role: "copy", enabled: Boolean(params.selectionText) },
        {
          label: "复制链接",
          enabled: Boolean(params.linkURL),
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: "separator" },
        { label: "在新标签打开链接", enabled: Boolean(params.linkURL), click: () => this.createTab(params.linkURL) },
        { type: "separator" },
        { label: "检查", click: () => webContents.openDevTools({ mode: "detach" }) },
      ];
      Menu.buildFromTemplate(template).popup({ window: this.window });
    });
  }

  refreshTabMeta(tab) {
    const { webContents } = tab.view;
    const url = webContents.getURL();
    const title = webContents.getTitle();
    tab.url = url;
    tab.isNewTab = isInternalNewTab(url);
    tab.displayUrl = tab.isNewTab ? "" : url;
    tab.title = tab.isNewTab ? "新标签页" : title || url;
    tab.canGoBack = webContents.navigationHistory.canGoBack();
    tab.canGoForward = webContents.navigationHistory.canGoForward();
    tab.isSecure = url.startsWith("https://") || url.startsWith("file://");
  }

  activateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) {
      return this.getState();
    }

    // 崩过或被外部关掉的页面留下的是个空壳，把它挂回窗口会直接抛错，那会让
    // 渲染层这次调用整个失败——按在用户眼里就是点了没反应。丢掉换下一个。
    if (tab.view.webContents.isDestroyed()) {
      this.tabs.delete(id);
      if (this.activeTabId === id) {
        this.activeTabId = null;
      }
      const next = this.tabs.keys().next();
      return next.done ? this.createTab() : this.activateTab(next.value);
    }

    for (const item of this.tabs.values()) {
      if (item.id !== id) {
        this.detachView(item.view);
      }
    }

    this.activeTabId = id;
    this.window.contentView.addChildView(tab.view);
    if (this.collectorOpen && this.collectorView) {
      this.window.contentView.addChildView(this.collectorView);
    }
    this.layout();
    this.refreshTabMeta(tab);
    this.emitState();
    return this.getState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) {
      return this.getState();
    }

    const order = [...this.tabs.keys()];
    const closedAt = order.indexOf(id);

    this.detachView(tab.view);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }
    this.tabs.delete(id);

    if (this.tabs.size === 0) {
      return this.createTab();
    }

    if (this.activeTabId === id) {
      // 接着看右边那个，右边没有了才回退到左边，别把焦点甩到标签条末尾去。
      // 两边都算不出来时兜到第一个：把 activeTabId 留在已经删掉的那个上，
      // 页面区域会空着，看着就像卡住了。
      const next = order[closedAt + 1] ?? order[closedAt - 1] ?? this.tabs.keys().next().value;
      this.activateTab(next);
    } else {
      this.emitState();
    }

    return this.getState();
  }

  navigateActive(rawUrl) {
    const tab = this.getActiveTab();
    if (!tab) {
      return this.createTab(rawUrl);
    }

    const target = normalizeNavigationInput(rawUrl);
    if (!target) {
      return this.getState();
    }

    tab.view.webContents.loadURL(target);
    return this.getState();
  }

  goBack() {
    const tab = this.getActiveTab();
    if (tab?.canGoBack) {
      tab.view.webContents.navigationHistory.goBack();
    }
    return this.getState();
  }

  goForward() {
    const tab = this.getActiveTab();
    if (tab?.canGoForward) {
      tab.view.webContents.navigationHistory.goForward();
    }
    return this.getState();
  }

  reload() {
    const tab = this.getActiveTab();
    if (!tab) {
      return this.getState();
    }
    if (tab.loading) {
      tab.view.webContents.stop();
    } else {
      tab.view.webContents.reload();
    }
    return this.getState();
  }

  goHome() {
    const tab = this.getActiveTab();
    if (!tab) {
      return this.createTab();
    }
    tab.view.webContents.loadFile(NEW_TAB_FILE);
    return this.getState();
  }

  zoom(delta) {
    const tab = this.getActiveTab();
    if (!tab) {
      return this.getState();
    }
    const current = tab.view.webContents.getZoomFactor();
    const next = Math.min(3, Math.max(0.5, Math.round((current + delta) * 10) / 10));
    tab.view.webContents.setZoomFactor(next);
    return this.getState();
  }

  resetZoom() {
    const tab = this.getActiveTab();
    tab?.view.webContents.setZoomFactor(1);
    return this.getState();
  }

  layout() {
    const { width, height } = this.window.getContentBounds();
    const side = this.collectorOpen ? COLLECTOR_WIDTH : 0;
    const pageWidth = Math.max(0, width - side);
    const pageHeight = Math.max(0, height - CHROME_HEIGHT);

    this.chromeView?.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });

    const tab = this.getActiveTab();
    tab?.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: pageWidth, height: pageHeight });

    if (this.collectorOpen && this.collectorView) {
      this.collectorView.setBounds({ x: pageWidth, y: CHROME_HEIGHT, width: side, height: pageHeight });
    }
  }

  attachCollector(view) {
    this.collectorView = view;
  }

  setCollectorOpen(open) {
    if (this.collectorOpen === open) {
      return this.getState();
    }
    this.collectorOpen = open;
    this.syncCollectorView();
    this.layout();
    this.emitState();
    return this.getState();
  }

  toggleCollector() {
    return this.setCollectorOpen(!this.collectorOpen);
  }

  showCollector() {
    return this.setCollectorOpen(true);
  }

  syncCollectorView() {
    if (!this.collectorView) {
      return;
    }
    if (this.collectorOpen) {
      this.window.contentView.addChildView(this.collectorView);
      return;
    }
    this.detachView(this.collectorView);
  }

  // 采集要盯住指定的那个标签页，不能跟着"用户正在看哪个"变：同时采两个页面时至多
  // 一个是活动页，另一个在后台也得照样出数。省略 tabId 就还是当前活动页。
  tabFor(tabId) {
    const tab = tabId ? this.tabs.get(String(tabId)) : this.getActiveTab();
    if (!tab || tab.view.webContents.isDestroyed()) {
      return null;
    }
    return tab;
  }

  async waitForIdle(timeoutMs = 7000, tabId = null) {
    const tab = this.tabFor(tabId);
    if (!tab) {
      return;
    }

    const { webContents } = tab.view;
    await sleep(80);
    if (!webContents.isLoading()) {
      await sleep(120);
      this.refreshTabMeta(tab);
      return;
    }

    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        webContents.removeListener("did-finish-load", finish);
        webContents.removeListener("did-fail-load", onFail);
        resolve();
      };
      const onFail = (_event, errorCode, _description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      webContents.once("did-finish-load", finish);
      webContents.on("did-fail-load", onFail);
    });

    await sleep(180);
    this.refreshTabMeta(tab);
  }

  // 页面随时可能在脚本执行途中跳转或销毁，那不是错误，只是这一轮没数据。
  async runInTab(code, tabId = null) {
    const tab = this.tabFor(tabId);
    if (!tab) {
      return null;
    }
    try {
      return await tab.view.webContents.executeJavaScript(code, true);
    } catch {
      return null;
    }
  }

  async extractPageData(linkLimit, excerptLimit, tabId = null) {
    const tab = this.tabFor(tabId);
    if (!tab) {
      return null;
    }

    const safeLinkLimit = Math.max(1, Number(linkLimit) || 20);
    const extracted = await this.runInTab(`(${EXTRACT_SOURCE})(${safeLinkLimit})`, tabId);
    if (!extracted) {
      return null;
    }

    this.refreshTabMeta(tab);
    const text = extracted.text || "";
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.view.webContents.getTitle(),
      isNewTab: tab.isNewTab,
      text,
      excerpt: text.replace(/\s+/g, " ").trim().slice(0, excerptLimit),
      textLength: text.length,
      links: extracted.links || [],
      metaDescription: extracted.metaDescription || "",
      language: extracted.language || "",
      collectedAt: Date.now(),
    };
  }

  async collectActivePage({ wait = false, excerptLimit = 6000 } = {}) {
    if (wait) {
      await this.waitForIdle();
    }
    const snapshot = await this.extractPageData(20, excerptLimit);
    if (!snapshot) {
      return null;
    }

    this.showCollector();
    this.onCollectResult(snapshot);
    return snapshot;
  }

  getTabUrl(tabId = null) {
    const tab = this.tabFor(tabId);
    return tab ? tab.view.webContents.getURL() : "";
  }

  // 采集要给每块内容标上是哪个站来的，标题比域名好认。
  getTabTitle(tabId = null) {
    const tab = this.tabFor(tabId);
    return tab ? tab.view.webContents.getTitle() : "";
  }

  async scrollToTop(tabId = null) {
    await this.runInTab("window.scrollTo(0, 0)", tabId);
  }

  navigateTab(tabId, rawUrl) {
    const tab = this.tabFor(tabId);
    const target = normalizeNavigationInput(rawUrl);
    if (!tab || !target) {
      return false;
    }
    tab.view.webContents.loadURL(target);
    return true;
  }

  reloadTab(tabId = null) {
    const tab = this.tabFor(tabId);
    if (!tab) {
      return false;
    }
    tab.view.webContents.reload();
    return true;
  }

  // 采集循环每轮都要在所有 frame 上跑一次探针脚本，逐个 await 会把一轮的耗时
  // 累成帧数乘以单次 IPC 往返，广告位多的页面上尤其明显，这里一起发出去等。
  async runInAllFrames(code, tabId = null) {
    const tab = this.tabFor(tabId);
    if (!tab) {
      return [];
    }

    const main = tab.view.webContents.mainFrame;
    if (!main) {
      return [];
    }

    const settled = await Promise.all(
      [...main.framesInSubtree].map(async (frame) => {
        try {
          // 装箱是为了把"这一帧没结果"和"脚本本身返回了空值"区分开。
          return { value: await frame.executeJavaScript(code, true) };
        } catch {
          return null; // 跨域限制或 frame 已经销毁
        }
      }),
    );
    return settled.filter(Boolean).map((item) => item.value);
  }

  // 采集循环每秒多次调用，先用一句话确认探针还在，避免反复重放上万字符的安装脚本。
  async ensureLiveProbe(tabId = null) {
    const ready = await this.runInAllFrames(READY_SCRIPT, tabId);
    if (ready.length && ready.every(Boolean)) {
      return ready.length;
    }
    const installed = await this.runInAllFrames(INSTALL_SCRIPT, tabId);
    return installed.filter((item) => item?.installed).length;
  }

  // 采集收工时把探针撤下来。页面可能已经关掉或跳走了，撤不成也不用管：那种情况下
  // 探针本来就跟着页面一起没了。
  async removeLiveProbe(tabId = null) {
    try {
      const gone = await this.runInAllFrames(UNINSTALL_SCRIPT, tabId);
      return gone.filter((item) => item?.removed).length;
    } catch {
      return 0;
    }
  }

  async drainLiveItems(tabId = null) {
    const chunks = await this.runInAllFrames(DRAIN_SCRIPT, tabId);
    const merged = [];
    const seen = new Set();
    for (const chunk of chunks) {
      if (!Array.isArray(chunk)) {
        continue;
      }
      for (const item of chunk) {
        if (!item || typeof item.text !== "string") {
          continue;
        }
        const key = `${item.time || ""}|${item.text.slice(0, 120)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push({
          text: item.text,
          time: String(item.time || ""),
          ts: Number(item.ts) || 0,
          seq: Number(item.seq) || 0,
        });
      }
    }
    return merged.sort((left, right) => right.ts - left.ts || right.seq - left.seq);
  }

  async clickRefreshControl(tabId = null) {
    const results = await this.runInAllFrames(REFRESH_SCRIPT, tabId);
    return results.find((item) => typeof item === "string" && item) || "";
  }

  getActiveTab() {
    return this.tabs.get(this.activeTabId) || null;
  }

  // 关窗时统一把标签页的渲染进程收掉，别让它们挂到主进程退出为止。
  destroy() {
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close();
      }
    }
    this.tabs.clear();
    this.activeTabId = null;
  }

  serializeSession() {
    const entries = [];
    let activeIndex = 0;
    for (const tab of this.tabs.values()) {
      const url = tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL();
      if (!/^https?:\/\//i.test(url)) {
        continue;
      }
      if (tab.id === this.activeTabId) {
        activeIndex = entries.length;
      }
      entries.push({ url, title: tab.title || "" });
    }
    return { tabs: entries, activeIndex, collectorOpen: this.collectorOpen };
  }

  restoreSession(payload) {
    // 上次开过什么就还是那些。一片空白时（头一回用、上次把标签页都关了）才按默认列表
    // 摆好要盯的那几个站，省得每次开程序都从一个空标签页开始手动打开。
    const entries = payload?.tabs?.length
      ? payload.tabs
      : DEFAULT_SITES.map((site) => ({ url: site.url, title: site.label }));

    // 默认列表要是被清空了，就还是给一个空标签页，别让窗口里什么都没有。
    if (!entries.length) {
      return this.createTab();
    }

    const ids = entries.map((entry) => {
      const tab = this.spawnTab(entry.url);
      tab.title = entry.title || tab.title;
      return tab.id;
    });

    if (payload?.collectorOpen) {
      this.collectorOpen = true;
      this.syncCollectorView();
    }
    this.activateTab(ids[payload?.activeIndex] ?? ids[0]);
    return this.getState();
  }

  getState() {
    const tab = this.getActiveTab();
    return {
      tabs: [...this.tabs.values()].map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        displayUrl: item.displayUrl,
        favicon: item.favicon,
        loading: item.loading,
        isNewTab: item.isNewTab,
      })),
      activeTabId: this.activeTabId,
      canGoBack: Boolean(tab?.canGoBack),
      canGoForward: Boolean(tab?.canGoForward),
      loading: Boolean(tab?.loading),
      isSecure: Boolean(tab?.isSecure),
      displayUrl: tab?.displayUrl || "",
      collectorOpen: this.collectorOpen,
    };
  }

  emitState() {
    this.broadcast(this.getState());
  }
}

module.exports = { TabManager };
