const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orb", {
  restore: () => ipcRenderer.invoke("orb:restore"),
  setExpanded: (expanded) => ipcRenderer.invoke("orb:expanded", expanded),
  dragStart: () => ipcRenderer.invoke("orb:drag-start"),
  dragEnd: () => ipcRenderer.invoke("orb:drag-end"),
  resizeStart: () => ipcRenderer.invoke("orb:resize-start"),
  resizeEnd: () => ipcRenderer.invoke("orb:resize-end"),
  markRead: () => ipcRenderer.invoke("orb:mark-read"),
  setInteractive: (interactive) => ipcRenderer.invoke("orb:interactive", interactive),
  // 只报方向，一步多大、到不到头由主进程说
  stepFont: (direction) => ipcRenderer.invoke("orb:font-step", direction),
  onCards: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("orb:cards", listener);
    return () => ipcRenderer.removeListener("orb:cards", listener);
  },
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("orb:status", listener);
    return () => ipcRenderer.removeListener("orb:status", listener);
  },
  onFont: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("orb:font", listener);
    return () => ipcRenderer.removeListener("orb:font", listener);
  },
  onLayout: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("orb:layout", listener);
    return () => ipcRenderer.removeListener("orb:layout", listener);
  },
});
