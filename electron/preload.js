const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("browser", {
  ready: () => ipcRenderer.invoke("browser:ready"),
  createTab: (url) => ipcRenderer.invoke("tabs:create", url),
  closeTab: (id) => ipcRenderer.invoke("tabs:close", id),
  activateTab: (id) => ipcRenderer.invoke("tabs:activate", id),
  navigate: (url) => ipcRenderer.invoke("tabs:navigate", url),
  goBack: () => ipcRenderer.invoke("nav:back"),
  goForward: () => ipcRenderer.invoke("nav:forward"),
  reload: () => ipcRenderer.invoke("nav:reload"),
  goHome: () => ipcRenderer.invoke("nav:home"),
  zoomIn: () => ipcRenderer.invoke("nav:zoom-in"),
  zoomOut: () => ipcRenderer.invoke("nav:zoom-out"),
  resetZoom: () => ipcRenderer.invoke("nav:zoom-reset"),
  collect: () => ipcRenderer.invoke("page:collect"),
  toggleCollector: () => ipcRenderer.invoke("collector:toggle"),
  getDefaultSites: () => ipcRenderer.invoke("sites:default"),
  openChromeDevTools: () => ipcRenderer.invoke("chrome:devtools"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (partial) => ipcRenderer.invoke("settings:save", partial),
  testSettings: () => ipcRenderer.invoke("settings:test"),
  getCacheStats: () => ipcRenderer.invoke("cache:stats"),
  clearCache: () => ipcRenderer.invoke("cache:clear"),
  getArchiveDays: () => ipcRenderer.invoke("archive:days"),
  getArchiveDay: (date) => ipcRenderer.invoke("archive:day", date),
  removeArchiveDay: (date) => ipcRenderer.invoke("archive:remove-day", date),
  removeArchiveItem: (date, id) => ipcRenderer.invoke("archive:remove-item", date, id),
  clearArchive: () => ipcRenderer.invoke("archive:clear"),
  exportArchive: (date) => ipcRenderer.invoke("archive:export", date),
  getAgentState: () => ipcRenderer.invoke("agent:state"),
  minimizeToOrb: () => ipcRenderer.invoke("orb:minimize"),
  startCollect: (task, tabIds) => ipcRenderer.invoke("collect:start", task, tabIds),
  stopCollect: () => ipcRenderer.invoke("collect:stop"),
  startFilter: (task) => ipcRenderer.invoke("filter:start", task),
  stopFilter: () => ipcRenderer.invoke("filter:stop"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onCollect: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("page:collected", listener);
    return () => ipcRenderer.removeListener("page:collected", listener);
  },
  onAgent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
