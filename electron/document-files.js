const { app, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

function header(headers, name) {
  const key = Object.keys(headers || {}).find((key) => key.toLowerCase() === name);
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? value.join("; ") : String(value || "");
}

function pdfResponse(details) {
  const mime = header(details.responseHeaders, "content-type").split(";")[0].trim().toLowerCase();
  return mime === "application/pdf" || mime === "application/x-pdf" ||
    (mime === "application/octet-stream" && /\.pdf(?:[?#]|$)/i.test(details.url));
}

function downloadReferrer(source, target) {
  try {
    const from = new URL(source), to = new URL(target);
    if (!/^https?:$/.test(from.protocol) || !/^https?:$/.test(to.protocol)) return "";
    if (from.protocol === "https:" && to.protocol === "http:") return "";
    from.hash = "";
    from.username = "";
    from.password = "";
    return from.origin === to.origin ? from.href : `${from.origin}/`;
  } catch { return ""; }
}

function safeName(value) {
  let name = path.win32.basename(String(value || "下载文件")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 160).replace(/[. ]+$/, "");
  if (!name || name === "." || name === "..") name = "下载文件";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function reservePath(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  const safe = safeName(name), ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
  for (let index = 0; index < 10000; index++) {
    const file = path.join(directory, index ? `${stem} (${index})${ext}` : safe);
    try {
      const fd = fs.openSync(file, "wx");
      fs.closeSync(fd);
      return file;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error("同名文件过多，请整理下载文件夹后重试");
}

function isPdfFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(1024);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, size).includes(Buffer.from("%PDF-"));
  } finally { fs.closeSync(fd); }
}

function edgeExecutable() {
  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
    if (!base) continue;
    const file = path.join(base, "Microsoft", "Edge", "Application", "msedge.exe");
    if (fs.existsSync(file)) return file;
  }
  throw new Error("未找到 Microsoft Edge。文件已保存，可从下载文件夹打开");
}

function openInEdge(file) {
  return new Promise((resolve, reject) => {
    // Edge 只收到本地文件 URL；Cookie、签名下载地址及请求头不写入启动参数。
    const child = spawn(edgeExecutable(), [pathToFileURL(file).href], { shell: false, stdio: "ignore", detached: true });
    child.once("error", () => reject(new Error("Edge 启动失败，文件仍保存在下载文件夹")));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".txt", ".csv", ".odt", ".ods", ".odp"]);

class DocumentFiles {
  constructor({ session, notify = () => {}, downloadsDirectory, openPdf = openInEdge, showMessage = dialog.showMessageBox } = {}) {
    this.session = session;
    this.notify = notify;
    this.directory = downloadsDirectory || path.join(app.getPath("downloads"), "Search Agent");
    this.openPdf = openPdf;
    this.showMessage = showMessage;
    this.current = new Map();
  }

  register() {
    this.session.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, done) => {
      if (details.statusCode < 200 || details.statusCode >= 300 || !pdfResponse(details)) return done({});
      // PDF.js 用 XHR/Fetch 读取的文件只记录入口，不改它的响应，避免破坏站内预览。
      if (details.webContentsId && details.method === "GET") {
        this.current.set(details.webContentsId, { url: details.url, referrer: details.referrer });
      }
      if (!["mainFrame", "subFrame"].includes(details.resourceType)) return done({});
      // 原始请求就地转为下载，保留 Cookie、Referer、POST 表单以及重定向，避免另发无凭据 GET。
      const headers = { ...details.responseHeaders };
      const disposition = header(headers, "content-disposition");
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "content-disposition") delete headers[name];
      headers["Content-Disposition"] = [disposition ? disposition.replace(/^[^;]*/, "attachment") : "attachment"];
      done({ responseHeaders: headers });
    });
    this.session.on("will-download", (event, item) => this.onDownload(event, item));
  }

  track(webContents) {
    webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.current.delete(webContents.id);
    });
    const id = webContents.id;
    webContents.once("destroyed", () => this.current.delete(id));
  }

  currentDocument(webContents) {
    if (!webContents || webContents.isDestroyed()) return null;
    const found = this.current.get(webContents.id);
    if (found) return found;
    const url = webContents.getURL();
    return /^https?:/i.test(url) && /\.pdf(?:[?#]|$)/i.test(url) ? { url, referrer: "" } : null;
  }

  downloadLink(webContents, url, referrer = webContents.getURL()) {
    if (!/^(https?:|blob:)/i.test(String(url)) || webContents.isDestroyed()) {
      this.notify({ state: "error", message: "此链接不能作为文件下载，请点击网页中的附件入口" });
      return;
    }
    const referer = downloadReferrer(referrer, url);
    this.notify({ state: "progress", message: "正在使用当前登录态请求文件…" });
    try {
      webContents.downloadURL(url, referer ? { headers: { Referer: referer } } : {});
    } catch {
      this.notify({ state: "error", message: "无法请求文件，请重新打开附件所在页面后重试" });
    }
  }

  async openBlobPdf(webContents, url) {
    // Blob 只能由创建它的页面读取；先检查类型，不能把 HTML/图片弹窗一律当作附件。
    try {
      if (!url.startsWith("blob:") || new URL(url).origin !== new URL(webContents.getURL()).origin) return false;
      const mime = await webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r => r.headers.get('content-type'))`);
      if (!/^application\/(?:pdf|x-pdf)(?:;|$)/i.test(mime || "")) return false;
      this.downloadLink(webContents, url);
      return true;
    } catch { return false; }
  }

  async savePage(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    this.notify({ state: "progress", message: "正在将当前网页保存为 PDF…" });
    let file;
    let saved = false;
    try {
      const data = await webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      file = reservePath(this.directory, `${safeName(webContents.getTitle())}.pdf`);
      await fs.promises.writeFile(file, data);
      saved = true;
      await this.openPdf(file);
      this.notify({ state: "completed", message: "当前网页已保存为 PDF，并已交给 Edge 打开" });
    } catch {
      if (file && !saved) { try { fs.rmSync(file, { force: true }); } catch {} }
      this.notify({ state: "error", message: saved ? "PDF 已保存，但未能打开 Edge，请查看下载文件夹" : "当前网页无法导出 PDF，请检查磁盘空间并等待页面加载完后重试" });
    }
  }

  onDownload(event, item) {
    const pdf = /^(application\/pdf|application\/x-pdf)$/i.test(item.getMimeType()) || /\.pdf$/i.test(item.getFilename());
    let name = item.getFilename();
    if (pdf && !/\.pdf$/i.test(name)) name = `${name || "文档"}.pdf`;
    let file;
    try { file = reservePath(this.directory, name); item.setSavePath(file); }
    catch {
      event.preventDefault();
      if (file) { try { fs.rmSync(file, { force: true }); } catch {} }
      this.notify({ state: "error", message: "无法保存文件，请检查下载文件夹权限或磁盘空间" });
      return;
    }
    this.notify({ state: "progress", message: `正在下载：${path.basename(file)}` });
    let interrupted = false;
    item.on("updated", (_event, state) => {
      // 没有断点续传界面，暂停的失败下载必须结束，不能一直显示“正在下载”。
      if (state === "interrupted") { interrupted = true; item.cancel(); }
    });
    item.once("done", (_event, state) => {
      if (state !== "completed") {
        // 只清理由此下载保留的路径，不触碰同名的已有文件。
        try { fs.rmSync(file, { force: true }); } catch { /* file may be locked */ }
        this.notify({ state: "error", message: `文件下载${state === "cancelled" && !interrupted ? "已取消" : "失败"}，请检查登录状态或网络后重试` });
        return;
      }
      void this.completed(file, pdf).catch(() => {
        this.notify({ state: "error", message: "文件已保存，但打开失败，请查看下载文件夹" });
      });
    });
  }

  async completed(file, pdf) {
    if (pdf) {
      if (!isPdfFile(file)) {
        this.notify({ state: "error", message: "服务器返回的不是有效 PDF，可能是登录或权限提示。请回到网站确认登录后重试" });
        return;
      }
      await this.openPdf(file);
      this.notify({ state: "completed", message: `已在 Edge 中打开：${path.basename(file)}` });
      return;
    }
    this.notify({ state: "completed", message: `文件已保存：${path.basename(file)}` });
    // Edge 不负责打开 Office 文档。只为文档提供明确的打开按钮，其余下载不自动执行。
    if (DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      const result = await this.showMessage({ type: "info", title: "文件已下载", message: path.basename(file),
        detail: "文件已使用网站当前登录态下载。可使用系统关联的程序打开。", buttons: ["打开文件", "打开文件夹", "关闭"], defaultId: 0, cancelId: 2 });
      if (result.response === 0) {
        const error = await shell.openPath(file);
        if (error) throw new Error("无法打开文件");
      } else if (result.response === 1) shell.showItemInFolder(file);
    }
  }
}

module.exports = { DocumentFiles, pdfResponse, downloadReferrer, safeName, reservePath, isPdfFile, openInEdge };
