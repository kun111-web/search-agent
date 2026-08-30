const { app, BaseWindow, WebContentsView, ipcMain, session, Menu, dialog, desktopCapturer } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { TabManager } = require("./tabs");
const { DEFAULT_SITES } = require("./default-sites");
const { OrbWindow } = require("./orb");
const { readSession, scheduleSave, flushSave, cancelSave } = require("./session-store");
const { PageScraper } = require("./agent/scraper");
const { readSettings, writeSettings, publicSettings } = require("./agent/settings");
const { testConnection } = require("./agent/llm");
const filterCache = require("./agent/filter-cache");
const archive = require("./agent/archive");
const { buildExport, formatFromPath } = require("./agent/archive-export");

app.setName("Search Agent");

// 两个实例会各自往同一份归档、采集池、判定缓存和会话里整份覆盖写，谁后写谁把
// 对方的内容盖掉。第二次启动直接把已经开着的那个叫到前面来。
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
}

// 采集经常连着跑好几个小时。主进程里任何一处没接住的异常，默认都会让整个程序当场消失，
// 正在攒的采集池、会话、未读列表跟着一起没——用户看到的就是"自己关掉了"，还查不出原因。
// 宁可让出问题的那一步失败，也别把程序带走；出事留一行到 error.log，事后能对。
// 有的异常是每一轮都会抛的，采集连着跑几天就能把这个文件堆到几百兆。到了上限就留一份
// 上一轮的、从头写起：出事时有价值的是最近这些记录。
const ERROR_LOG_MAX = 2 * 1024 * 1024;

async function rollErrorLog(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (stat && stat.size > ERROR_LOG_MAX) {
    await fs.rename(file, `${file}.old`).catch(() => {});
  }
}

function logFailure(scope, error) {
  const line = `${new Date().toISOString()} [${scope}] ${error?.stack || error}\n`;
  console.error(line.trimEnd());
  const file = path.join(app.getPath("userData"), "error.log");
  void rollErrorLog(file)
    .then(() => fs.appendFile(file, line))
    .catch(() => {});
}

process.on("uncaughtException", (error) => logFailure("uncaughtException", error));
process.on("unhandledRejection", (reason) => logFailure("unhandledRejection", reason));

// 缩成悬浮球后主窗口是隐藏的，必须阻止 Chromium 给被遮挡的窗口降频，
// 否则页面里的定时器和 MutationObserver 会被节流，采集就断了。
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// 悬浮球靠抓屏做毛玻璃。Windows 的 WGC 捕获器在程序以管理员身份运行时会被系统拒绝
// （0x80070005），回退到旧捕获器就没有这个限制，抓一小块低分辨率画面性能也够用。
app.commandLine.appendSwitch("disable-features", "AllowWgcScreenCapturer,AllowWgcDesktopCapturer");

let mainWindow = null;
let chromeView = null;
let tabManager = null;
let collectorView = null;
let agentRunner = null;
let orb = null;
let lastAgentRunning = false;
let quitting = false;

function createIsolatedView() {
  return new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

function sendToPanels(channel, payload) {
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send(channel, payload);
  }
  if (collectorView && !collectorView.webContents.isDestroyed()) {
    collectorView.webContents.send(channel, payload);
  }
}


function minimizeToOrb() {
  if (!orb || !mainWindow) {
    return { ok: false };
  }
  orb.show();
  // 球没立起来就把主窗口藏了，屏幕上会一个窗口都不剩，看着就是程序自己关了。
  if (!orb.isOpen()) {
    return { ok: false };
  }
  mainWindow.hide();
  return { ok: true };
}

function restoreFromOrb() {
  orb?.hide();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  return { ok: true };
}

function agentIsRunning() {
  return Boolean(agentRunner?.running || agentRunner?.agentRunning);
}

function browserState() {
  return {
    ...(tabManager ? tabManager.getState() : {}),
    agentRunning: agentIsRunning(),
  };
}

function collectSession() {
  return tabManager ? tabManager.serializeSession() : { tabs: [], activeIndex: 0, collectorOpen: false };
}

function emitBrowserState() {
  sendToPanels("browser:state", browserState());
  if (tabManager) {
    scheduleSave(collectSession);
  }
}

// 采集时 agent 事件每秒都有好几条，但浏览器状态里只有 agentRunning 会跟着变，
// 每条都重播一次等于把整份标签页状态和会话落盘的节奏绑到采集频率上。
function emitAgent(event) {
  sendToPanels("agent:event", event);
  // 悬浮球只要新命中的消息和运行指示灯。采集步骤、原始条目这些每秒好几条的事件不必
  // 跨进程序列化一份送过去；重新采集/重新筛选时送来的空列表也不理——主窗口的面板画
  // 的是"这次运行筛出什么"，球上那份是"我还没看的"，只该由「已读」清空。
  if (event.type === "articles") {
    if (event.fresh?.length) {
      orb?.addUnread(event.fresh);
    }
  } else if (event.type === "sources") {
    // 球上按这份列表分块，顺序也照它来——按消息先后猜的话，哪个站先出结果哪块就在上面，
    // 每次缩起来看到的排布都可能不一样。
    orb?.setSources(event.sources);
  } else if (event.type === "status" || event.type === "agent-status" || event.type === "filtering") {
    // 球上那条状态栏要的就是这三样：采集在干什么、模型在干什么、这批筛到哪儿了。
    orb?.applyAgentEvent(event);
  }
  const running = agentIsRunning();
  if (running !== lastAgentRunning) {
    lastAgentRunning = running;
    emitBrowserState();
  }
}

// WebContentsView 的 webContents 不会跟着窗口一起销毁，标签页和两个面板的渲染进程
// 会一直挂到主进程真正退出。窗口都没了还留着一串渲染进程，退出因此要多花好几秒，
// 而那几秒里用户想重开一个，就会被单实例锁挡在门外、看着像点了没反应。
// 会话得在这之前落盘：拆完就读不到每个标签页的地址了。
function closeViews() {
  tabManager?.destroy();
  for (const view of [chromeView, collectorView]) {
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  }
}

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1360,
    height: 880,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#f6f7f9",
    show: false,
    autoHideMenuBar: true,
    title: "Search Agent",
    ...(process.platform === "win32"
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: "#eef0f4",
            symbolColor: "#3b4152",
            height: 40,
          },
        }
      : {
          titleBarStyle: "hiddenInset",
        }),
  });

  chromeView = createIsolatedView();
  collectorView = createIsolatedView();
  mainWindow.contentView.addChildView(chromeView);
  chromeView.webContents.loadFile(path.join(__dirname, "../src/chrome.html"));
  collectorView.webContents.loadFile(path.join(__dirname, "../src/collector.html"));

  tabManager = new TabManager(mainWindow, chromeView);
  tabManager.attachCollector(collectorView);
  tabManager.setBroadcast(() => emitBrowserState());
  tabManager.setCollectHandler((snapshot) => sendToPanels("page:collected", snapshot));
  agentRunner = new PageScraper(tabManager, emitAgent);
  lastAgentRunning = false;
  orb = new OrbWindow(() => restoreFromOrb());

  chromeView.webContents.once("did-finish-load", () => {
    tabManager.layout();
    tabManager.restoreSession(readSession());
    mainWindow.show();
  });

  mainWindow.on("resize", () => tabManager.layout());
  // tabManager 在 closed 里就被清掉了，会话必须赶在 close 阶段落盘。
  mainWindow.on("close", () => {
    flushSave(collectSession);
    session.fromPartition("persist:search-agent").flushStorageData();
    closeViews();
  });
  mainWindow.on("closed", () => {
    agentRunner?.stop();
    cancelSave();
    orb?.hide();
    mainWindow = null;
    chromeView = null;
    tabManager = null;
    collectorView = null;
    agentRunner = null;
    orb = null;
  });
}

// 传日期就导出那一天，不传就导出全部。文件格式跟着用户在保存框里选的扩展名走。
async function exportArchive(rawDate) {
  const date = String(rawDate || "");
  const days = date ? [archive.readDay(date)] : archive.readAll();
  if (!days.some((day) => day.items.length)) {
    return { ok: false, message: "没有可导出的内容" };
  }

  const options = {
    title: "导出归档",
    defaultPath: date ? `采集归档-${date}.md` : `采集归档-全部-${archive.today()}.md`,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "CSV 表格", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
    ],
  };
  const { canceled, filePath } = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) {
    return { canceled: true };
  }

  try {
    const { content, itemCount, dayCount } = buildExport({
      days,
      format: formatFromPath(filePath),
      scope: date ? `${date} 这一天` : `全部 ${days.length} 天`,
    });
    await fs.writeFile(filePath, content, "utf8");
    return { ok: true, path: filePath, itemCount, dayCount };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function probeModel(settings) {
  try {
    return { ok: await testConnection(settings), model: settings.model };
  } catch (error) {
    return { ok: false, model: settings.model, message: error.message };
  }
}

// 删数据是不可撤销的，全部走系统弹窗二次确认。默认按钮和回车都落在"取消"上，
// 免得顺手一敲就把归档清了。
async function confirmDelete({ message, detail, confirmLabel }) {
  const options = {
    type: "warning",
    buttons: ["取消", confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "确认删除",
    message,
    detail,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

// 主窗口关掉后 tabManager / agentRunner 会被清空，但渲染进程可能还有请求在路上。
function onTabs(fn) {
  return (...args) => (tabManager ? fn(...args) : browserState());
}

function onAgent(fn) {
  return (...args) => {
    if (!agentRunner) {
      return { ok: false };
    }
    fn(...args);
    return { ok: true };
  };
}

function registerIpc() {
  ipcMain.handle("browser:ready", () => browserState());
  ipcMain.handle("tabs:create", onTabs((_event, url) => tabManager.createTab(url)));
  ipcMain.handle("tabs:close", onTabs((_event, id) => tabManager.closeTab(id)));
  ipcMain.handle("tabs:activate", onTabs((_event, id) => tabManager.activateTab(id)));
  ipcMain.handle("tabs:navigate", onTabs((_event, url) => tabManager.navigateActive(url)));
  ipcMain.handle("nav:back", onTabs(() => tabManager.goBack()));
  ipcMain.handle("nav:forward", onTabs(() => tabManager.goForward()));
  ipcMain.handle("nav:reload", onTabs(() => tabManager.reload()));
  ipcMain.handle("nav:home", onTabs(() => tabManager.goHome()));
  ipcMain.handle("nav:zoom-in", onTabs(() => tabManager.zoom(0.1)));
  ipcMain.handle("nav:zoom-out", onTabs(() => tabManager.zoom(-0.1)));
  ipcMain.handle("nav:zoom-reset", onTabs(() => tabManager.resetZoom()));
  ipcMain.handle("page:collect", () => tabManager?.collectActivePage({ wait: true }) ?? null);
  ipcMain.handle("collector:toggle", onTabs(() => tabManager.toggleCollector()));
  ipcMain.handle("sites:default", () => DEFAULT_SITES);
  ipcMain.handle("chrome:devtools", () => {
    chromeView?.webContents.openDevTools({ mode: "detach" });
  });
  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:save", (_event, partial) => publicSettings(writeSettings(partial)));
  ipcMain.handle("settings:test", async () => {
    const settings = readSettings();
    // 接口格式得跟着一起传：少了它这里就按 chat 那套去打，选了 responses 的人会看到
    // 一个假的失败。
    const main = await probeModel({
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      apiFormat: settings.apiFormat,
    });
    // 备用模型不测一遍等于没有：真到主模型断线那天才发现备用的 Key 也是错的就晚了。
    const fallback = settings.fallbackApiKey
      ? await probeModel({
          baseUrl: settings.fallbackBaseUrl,
          model: settings.fallbackModel,
          apiKey: settings.fallbackApiKey,
          apiFormat: settings.fallbackApiFormat,
        })
      : null;
    return { ok: main.ok, main, fallback };
  });
  ipcMain.handle("cache:stats", () => ({ size: filterCache.size() }));
  ipcMain.handle("cache:clear", () => {
    const { ok } = filterCache.clear();
    return { ok, size: filterCache.size() };
  });
  ipcMain.handle("archive:days", () => archive.listDays());
  ipcMain.handle("archive:day", (_event, date) => archive.readDay(String(date || "")));
  ipcMain.handle("archive:remove-day", async (_event, rawDate) => {
    const date = String(rawDate || "");
    const { items } = archive.readDay(date);
    if (!items.length) {
      return { ok: false, message: "这天没有内容" };
    }
    const confirmed = await confirmDelete({
      message: `删除 ${date} 这一天的归档？`,
      detail: `这天存了 ${items.length} 条内容，删掉之后没法恢复。`,
      confirmLabel: "删除这天",
    });
    if (!confirmed) {
      return { ok: false, cancelled: true };
    }
    return archive.removeDay(date);
  });
  ipcMain.handle("archive:remove-item", async (_event, rawDate, rawId) => {
    const date = String(rawDate || "");
    const id = String(rawId || "");
    const target = archive.readDay(date).items.find((item) => item.id === id);
    const confirmed = await confirmDelete({
      message: "删除这一条？",
      detail: `${(target?.title || target?.summary || "").slice(0, 120) || "这一条"}\n\n删掉之后没法恢复。`,
      confirmLabel: "删除",
    });
    if (!confirmed) {
      return { ok: false, cancelled: true };
    }
    return archive.removeItem(date, id);
  });
  ipcMain.handle("archive:clear", async () => {
    const days = archive.listDays();
    const total = days.reduce((sum, day) => sum + day.count, 0);
    const confirmed = await confirmDelete({
      message: "清空全部数据？",
      detail:
        `会一次删掉三样东西，删完没法恢复：\n` +
        `· 归档里 ${days.length} 天共 ${total} 条筛选结果\n` +
        `· 采集池里全部原始条目（采集留下的原文底稿）\n` +
        `· 本地判定缓存（里面存着模型写的标题和摘要）`,
      confirmLabel: "全部删除",
    });
    if (!confirmed) {
      return { ok: false, cancelled: true };
    }
    // 判定缓存里存着模型生成的标题和摘要，不清就等于内容还留了一份。
    const archiveResult = archive.clearAll();
    const cacheResult = filterCache.clear();
    // 数据都删了，面板和悬浮球上还挂着卡片会让人以为没删干净。
    agentRunner?.clearOutputs();
    return { ok: archiveResult.ok && cacheResult.ok, cleared: true, days: days.length, total };
  });
  ipcMain.handle("archive:export", (_event, date) => exportArchive(date));
  ipcMain.handle(
    "agent:state",
    () =>
      agentRunner?.getPublicState() ?? {
        running: false,
        agentRunning: false,
        steps: [],
        articles: [],
        rawItems: [],
        rawTotal: 0,
        summary: "",
        pending: 0,
      },
  );
  ipcMain.handle(
    "collect:start",
    onAgent((_event, task, tabIds) => {
      void agentRunner.start(task, readSettings(), tabIds).catch(() => {});
    }),
  );
  ipcMain.handle("collect:stop", onAgent(() => agentRunner.stopCollect()));
  ipcMain.handle(
    "filter:start",
    onAgent((_event, task) => agentRunner.startFilter(task, readSettings())),
  );
  ipcMain.handle("filter:stop", onAgent(() => agentRunner.stopFilter()));
  ipcMain.handle("orb:minimize", () => minimizeToOrb());
  ipcMain.handle("orb:restore", () => restoreFromOrb());
  ipcMain.handle("orb:expanded", (_event, expanded) => {
    orb?.setExpanded(Boolean(expanded));
    return { ok: true };
  });
  ipcMain.handle("orb:drag-start", () => {
    orb?.startDrag();
    return { ok: true };
  });
  ipcMain.handle("orb:drag-end", () => {
    orb?.stopDrag();
    return { ok: true };
  });
  ipcMain.handle("orb:mark-read", () => {
    orb?.clearUnread();
    return { ok: true };
  });
  ipcMain.handle("orb:interactive", (_event, interactive) => {
    orb?.setInteractive(Boolean(interactive));
    return { ok: true };
  });
  ipcMain.handle("orb:font-step", (_event, direction) => {
    orb?.nudgeFont(Number(direction) || 0);
    return { ok: true };
  });
  ipcMain.handle("orb:resize-start", () => {
    orb?.startResize();
    return { ok: true };
  });
  ipcMain.handle("orb:resize-end", () => {
    orb?.stopResize();
    return { ok: true };
  });
}

function registerSession() {
  const browserSession = session.fromPartition("persist:search-agent");

  browserSession.on("will-download", (_event, item) => {
    item.setSavePath(path.join(app.getPath("downloads"), item.getFilename()));
  });

  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);
    callback(allowed.has(permission));
  });

  // 悬浮球要抓所在那块屏幕做毛玻璃，直接给源，不弹系统选择框。
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          const wanted = sources.find((item) => String(item.display_id) === String(orb?.displayId));
          callback({ video: wanted || sources[0] });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}

function registerShortcuts() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新标签页", accelerator: "CmdOrCtrl+T", click: () => tabManager?.createTab() },
        { label: "关闭标签页", accelerator: "CmdOrCtrl+W", click: () => tabManager?.closeTab(tabManager.activeTabId) },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "查看",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => tabManager?.reload() },
        { label: "强制重新加载", accelerator: "CmdOrCtrl+Shift+R", click: () => tabManager?.getActiveTab()?.view.webContents.reloadIgnoringCache() },
        { type: "separator" },
        { label: "放大", accelerator: "CmdOrCtrl+=", click: () => tabManager?.zoom(0.1) },
        { label: "缩小", accelerator: "CmdOrCtrl+-", click: () => tabManager?.zoom(-0.1) },
        { label: "重置缩放", accelerator: "CmdOrCtrl+0", click: () => tabManager?.resetZoom() },
        { type: "separator" },
        { label: "采集当前页", accelerator: "CmdOrCtrl+Shift+C", click: () => tabManager?.collectActivePage() },
        { label: "打开 Agent 面板", accelerator: "CmdOrCtrl+Shift+A", click: () => tabManager?.showCollector() },
        { label: "缩为悬浮球", accelerator: "CmdOrCtrl+Shift+M", click: () => minimizeToOrb() },
        { label: "页面开发者工具", accelerator: "CmdOrCtrl+Shift+I", click: () => tabManager?.getActiveTab()?.view.webContents.openDevTools({ mode: "detach" }) },
      ],
    },
    {
      label: "导航",
      submenu: [
        { label: "后退", accelerator: "Alt+Left", click: () => tabManager?.goBack() },
        { label: "前进", accelerator: "Alt+Right", click: () => tabManager?.goForward() },
        { label: "主页", accelerator: "Alt+Home", click: () => tabManager?.goHome() },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (hasInstanceLock) {
  app.on("second-instance", () => {
    // 已经在退出的路上了就别再开窗口：这时候建出来的窗口会连着一个正在拆的
    // 会话，落到用户眼里就是一个点不动的空壳。锁在退出一开始就放开了，
    // 那个新实例自己能起来。
    if (quitting) {
      return;
    }
    if (mainWindow) {
      restoreFromOrb();
      return;
    }
    createWindow();
  });

  app.whenReady().then(() => {
    registerSession();
    // 采集池只增不减，趁启动把超过保留期的旧底稿收掉，归档不动（见 archive.js 的 prunePool）。
    archive.prunePool();
    registerIpc();
    registerShortcuts();
    createWindow();

    app.on("activate", () => {
      if (BaseWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
  if (tabManager) {
    flushSave(collectSession);
  }
  // 采集池是攒批落盘的，退出前冲一次，不然最后几条采到的内容就没留下底稿。
  archive.flushPool();
  // 判定缓存同理，攒着没写的那批下次还得再花一次 token 才能判出来。
  filterCache.flush();
  // 剩下的时间都花在等渲染进程收尸上，那几秒里用户点图标想重开一个会被锁挡掉，
  // 看着就像点了没反应。该落盘的都写完了，这时候就可以把门让开。
  app.releaseSingleInstanceLock();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
