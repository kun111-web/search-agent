// 原生窗口回归：截图保护、真实预加载复制按钮、Ctrl+C，以及截图浮层不会被抢走。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, ipcMain, clipboard, screen, desktopCapturer, BrowserWindow } = require("electron");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "orb-window-")));
const { OrbWindow } = require("./electron/orb");
const checks = [];
function check(name, ok) {
  checks.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const savedClipboard = { text: clipboard.readText(), html: clipboard.readHTML(),
    rtf: clipboard.readRTF(), image: clipboard.readImage() };
  const orb = new OrbWindow();
  let overlay;
  try {
    for (const [channel, method] of [["expanded", "setExpanded"], ["interactive", "setInteractive"],
      ["drag-start", "startDrag"], ["drag-end", "stopDrag"], ["resize-start", "startResize"],
      ["resize-end", "stopResize"], ["font-step", "nudgeFont"], ["mark-read", "clearUnread"], ["copy-text", "copyText"]]) {
      ipcMain.handle(`orb:${channel}`, (event, arg) =>
        event.sender === orb.window?.webContents ? orb[method](arg) : { ok: false });
    }
    orb.addUnread([{ title: "截图与复制测试", summary: "悬浮面板的完整内容可以选择、复制和截图。", time: "12:00", match: "测试消息" }]);
    orb.show();
    await new Promise(resolve => orb.window.webContents.once("did-finish-load", resolve));
    const win = orb.window;
    const run = code => win.webContents.executeJavaScript(code, true);
    await run('document.querySelector("#expand").click()');
    await pause(200);
    check("展开后允许截图", !win.isContentProtected());
    check("保持普通置顶", win.isAlwaysOnTop());
    await run('document.querySelector(".card-copy").click()');
    await pause(80);
    check("真实复制按钮写入完整消息", clipboard.readText().includes("截图与复制测试\n悬浮面板的完整内容"));
    await run('document.querySelector("#copy-all").click()');
    await pause(80);
    check("真实全部复制包含时间", clipboard.readText().includes("12:00"));
    win.setIgnoreMouseEvents(false);
    win.focus();
    await run(`(() => {const range=document.createRange();range.selectNodeContents(document.querySelector('.card strong'));
      const s=getSelection();s.removeAllRanges();s.addRange(range);})()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "C", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "C", modifiers: ["control"] });
    await pause(100);
    check("Ctrl+C 只复制选中文字", clipboard.readText() === "截图与复制测试");
    await run('getSelection().removeAllRanges()');
    const capture = await win.webContents.capturePage();
    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "out/orb-copy-panel.png"), capture.toPNG());
    // 截图工具的浮层处于更高层级，失焦和等待后悬浮窗都不应再次 moveTop。
    let movedToTop = 0;
    win.moveTop = () => { movedToTop += 1; };
    overlay = new BrowserWindow({ show: false, width: 200, height: 100, alwaysOnTop: true });
    overlay.setAlwaysOnTop(true, "screen-saver");
    await overlay.loadURL("data:text/html,<p>Screenshot overlay test</p>");
    overlay.show();
    overlay.focus();
    await pause(1700);
    check("失焦后不定时抢截图浮层", movedToTop === 0);
    overlay.destroy();
    overlay = null;
    const display = screen.getDisplayNearestPoint(orb.anchor);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } });
    const source = sources.find(s => String(s.display_id) === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error("Screen capture unavailable");
    const bounds = win.getBounds(), size = source.thumbnail.getSize();
    const sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
    const crop = source.thumbnail.crop({ x: Math.round((bounds.x-display.bounds.x)*sx), y: Math.round((bounds.y-display.bounds.y)*sy),
      width: Math.round(bounds.width*sx), height: Math.round(bounds.height*sy) });
    fs.writeFileSync(path.join(__dirname, "out/orb-screen-capture.png"), crop.toPNG());
    check("系统屏幕截图已生成，供视觉核对", !crop.isEmpty());
    await run('document.querySelector("#collapse").click()');
    await pause(60);
    check("收起后也允许截图", !win.isContentProtected());
  } finally {
    overlay?.destroy();
    orb.hide();
    clipboard.write(savedClipboard);
  }
  console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
  app.exit(checks.every(Boolean) ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
