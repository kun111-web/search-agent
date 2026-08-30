const { app, BrowserWindow, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write");
const { byNewestFirst } = require("./agent/ordering");

const BALL = 64;
const GAP = 10;
// 两行状态浮在球正上方，不用展开就能看见。球窗口本来正好是球那么大，所以窗口得往上
// 长出这一条，收起时也得比球宽——64 像素放不下"正在筛 8 条 · deepseek-v4-pro"。
const STATUS_H = 46;
const STATUS_W = 232;
const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 260;
// 再小就装不下一张卡片的标题加摘要了，缩到那个程度不如收起来。
const PANEL_MIN_WIDTH = 220;
const PANEL_MIN_HEIGHT = 150;
const PANEL_FILE = "orb-panel.json";
// 消息字号的倍率。上限给到两倍：这面板能拖到铺满屏幕，隔着几步看也得认得出标题。
const FONT_MIN = 0.85;
const FONT_MAX = 2;
const FONT_STEP = 0.15;
const DRAG_TICK_MS = 16;
const KEEP_TOP_MS = 1500;
// 面板能拖到铺满屏幕，装得下的条数比早先固定 300×260 那会儿多得多。按来源各算一份：
// 合起来算的话，一个刷得勤的站几分钟就能把另一个站的消息全顶出去。
const UNREAD_PER_SOURCE = 60;

function panelPath() {
  return path.join(app.getPath("userData"), PANEL_FILE);
}

function clamp(value, min, max) {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, Math.round(max)));
}

// 字号倍率是小数，不能走上面那个会取整的 clamp。留两位是为了别让 0.15 的步进
// 累出一串浮点尾巴，那玩意儿会顺着 JSON 写进文件里。
function clampFont(value) {
  const scale = Number(value) || 1;
  return Math.round(Math.min(Math.max(scale, FONT_MIN), FONT_MAX) * 100) / 100;
}

// 判断"这条消息列表里已经有了没有"。raw 是探针采到的原文，最准；模型偶尔会吐出对不上
// 编号的条目，那种没有原文，退用标题加摘要。
function cardKey(item) {
  return item.raw || `${item.title}\u0000${item.summary}`;
}

// 上次拖成多大、字调成多大，就记着多大。文件读不出来或存着离谱的数就退回默认——
// 这些都只是使用习惯，不值得为它们拦住悬浮球出场。旧版本的文件里没有字号，那就是一倍。
function readPanelState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(panelPath(), "utf8"));
    return {
      width: clamp(Number(parsed.width) || PANEL_WIDTH, PANEL_MIN_WIDTH, 4000),
      height: clamp(Number(parsed.height) || PANEL_HEIGHT, PANEL_MIN_HEIGHT, 4000),
      fontScale: clampFont(parsed.fontScale),
    };
  } catch {
    return { width: PANEL_WIDTH, height: PANEL_HEIGHT, fontScale: 1 };
  }
}

class OrbWindow {
  // onDismissed：球被外面关掉时的退路，交给调用方把主窗口叫回来。
  constructor(onDismissed) {
    this.onDismissed = onDismissed;
    this.window = null;
    this.anchor = null;
    this.expanded = false;
    this.side = "right";
    this.dragTimer = null;
    this.dragOrigin = null;
    this.resizeTimer = null;
    this.topTimer = null;
    this.displayId = null;
    this.ballTop = 0;
    const saved = readPanelState();
    this.panel = { width: saved.width, height: saved.height };
    this.fontScale = saved.fontScale;
    this.unread = [];
    this.sources = [];
    // 采集和模型各一行。跟未读列表一样存在主进程：球是缩起来才建、点一下就销毁的，
    // 状态留在渲染层的话，每次缩回来都得等下一个事件才知道现在在干什么。
    this.status = {
      collect: "还没开始采集",
      model: "模型没在跑",
      collectRunning: false,
      modelRunning: false,
      modelWarn: false,
    };
  }

  // 采集那头的 status、筛选那头的 agent-status 和 filtering，在球上合成两行字。
  // 翻译放在这边而不是渲染层：球随时会被销毁重建，重建时得能直接把当前状态摆出来。
  applyAgentEvent(event) {
    if (event.type === "status") {
      this.status.collect = event.message || (event.running ? "采集中" : "采集已停止");
      this.status.collectRunning = Boolean(event.running);
    } else if (event.type === "agent-status") {
      this.status.model = event.message || (event.running ? "筛选中" : "筛选没在跑");
      this.status.modelRunning = Boolean(event.running);
      this.status.modelWarn = event.tone === "warn";
    } else if (event.type === "filtering") {
      const rest = Number(event.pending) || 0;
      const retry = Number(event.retry) || 0;
      if (event.active) {
        // 正在等模型回话。这时候把用的是哪个模型带上，切过备用之后一眼能看出来。
        //
        // 上一批是连不上的话，这一次是在重连，得写明白：跟平常筛选长着一副面孔的话，
        // 人只会觉得卡住了。重连期间接口还没证明自己好了，警示色留着。
        this.status.model = retry
          ? `正在重连（第 ${retry} 次）${event.model ? ` · ${event.model}` : ""}`
          : `正在筛 ${event.count} 条${rest ? `，还排着 ${rest} 条` : ""}${event.model ? ` · ${event.model}` : ""}`;
        this.status.modelRunning = true;
        this.status.modelWarn = retry > 0;
      } else if (!this.status.modelWarn) {
        // 出了岔子的那句话不能被这里冲掉。一批筛失败的收尾顺序是"先报重连、再报这批
        // 结束"，照抄下来的话，屏幕上永远看不到"正在等重连"，只剩一句"还排着 N 条"，
        // 看着就像卡死了。
        this.status.model = rest
          ? `还排着 ${rest} 条待筛`
          : `筛完了，等新内容${event.screened ? `（这轮已判 ${event.screened} 条）` : ""}`;
      }
    } else {
      return;
    }
    this.sendStatus();
  }

  sendStatus() {
    this.send("orb:status", this.status);
  }

  // 字号一步一步调。步进和上下限都留在这边算：渲染层只报"想大一点"还是"想小一点"，
  // 免得两处各存一份界限，改一处忘一处。到头了就把那个按钮按灰，省得白点。
  nudgeFont(direction) {
    const next = clampFont(this.fontScale + Math.sign(direction) * FONT_STEP);
    if (next === this.fontScale) {
      return;
    }
    this.fontScale = next;
    this.sendFont();
    this.savePanelState();
  }

  sendFont() {
    this.send("orb:font", {
      scale: this.fontScale,
      atMin: this.fontScale <= FONT_MIN,
      atMax: this.fontScale >= FONT_MAX,
    });
  }

  // 尺寸和字号在同一个文件里，谁变了都得把另一个原样带上，不然会互相抹掉。
  savePanelState() {
    try {
      writeFileAtomic(panelPath(), JSON.stringify({ ...this.panel, fontScale: this.fontScale }));
    } catch {
      // 记不住只是下次要再调一遍，不值得报错打断
    }
  }

  // 指针压在球或面板上时才收鼠标事件，其余时候（状态栏、圆球外的四角）一律放它过去。
  setInteractive(interactive) {
    if (!this.isOpen()) {
      return;
    }
    this.window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  // 这次在采哪几个页面。球上按这份列表分块，顺序也照它来，跟主窗口的面板对得上。
  setSources(sources) {
    this.sources = Array.isArray(sources) ? sources : [];
    this.sendCards();
  }

  // 球上那份"还没看的消息"存在主进程，不在渲染层：球窗口是缩起来才建、点一下就销毁的，
  // 列表要是跟着渲染层走，回主窗口再缩回来就空了。
  //
  // 球还没露面时筛出来的照样往里攒：不然在主窗口跑一会儿再缩成球，球上是空的。清空这份
  // 列表的入口只有「已读」一个。
  addUnread(fresh) {
    const known = new Set(this.unread.map(cardKey));
    const added = fresh.filter((item) => {
      const key = cardKey(item);
      if (known.has(key)) {
        return false;
      }
      known.add(key);
      return true;
    });
    // 重新筛选会把同一批消息再送一遍，整批都是旧的就别惊动面板了。
    if (!added.length) {
      return;
    }
    this.unread.push(...added);
    this.unread.sort(byNewestFirst);
    this.trimUnread();
    this.sendCards();
  }

  // 每个来源各留一截。列表已经按新到旧排好，从头数够数了就把这个来源后面的丢掉。
  trimUnread() {
    const counts = new Map();
    this.unread = this.unread.filter((item) => {
      const id = item.originId || "";
      const used = counts.get(id) || 0;
      if (used >= UNREAD_PER_SOURCE) {
        return false;
      }
      counts.set(id, used + 1);
      return true;
    });
  }

  clearUnread() {
    this.unread = [];
  }

  // 只送数据，不碰面板的开合。面板什么时候开、什么时候关，全凭用户点那个箭头——
  // 新消息到了也不自己弹出来，那会在别人正干活的时候盖住屏幕。要知道来了几条看徽标，
  // 要知道在干什么看球头顶那两行。
  sendCards() {
    this.send("orb:cards", { items: this.unread, sources: this.sources });
  }

  isOpen() {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  defaultAnchor() {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - BALL - 28, y: area.y + 140 };
  }

  // 球必须整个留在屏幕上。甩出屏幕外的球既看不见也点不着，而缩成球的时候主窗口是藏起来
  // 的，屏幕上于是什么都不剩——看着就跟程序自己关掉了一样，只能去任务管理器结束进程。
  // 屏幕外的点会归到最近那块屏，所以球最多贴在边上，不会凭空跳到别的显示器去。
  // 球不许贴到屏幕最上边：它头顶那条状态栏得有地方站。
  clampAnchor(anchor) {
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    return {
      x: clamp(anchor.x, area.x, area.x + area.width - BALL),
      y: clamp(anchor.y, area.y + STATUS_H, area.y + area.height - BALL),
    };
  }

  show() {
    if (this.isOpen()) {
      this.window.showInactive();
      return;
    }

    // 上次可能被拖到了屏幕边上，而屏幕可能已经拔掉或改了分辨率，摆出来之前先校一遍。
    this.anchor = this.clampAnchor(this.anchor || this.defaultAnchor());
    this.expanded = false;
    this.chooseSide();
    this.window = new BrowserWindow({
      x: this.side === "left" ? this.anchor.x + BALL - Math.max(BALL, STATUS_W) : this.anchor.x,
      y: this.anchor.y - STATUS_H,
      width: Math.max(BALL, STATUS_W),
      height: STATUS_H + BALL,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: "Search Agent",
      // 自己不要抢焦点。缩成球这个动作往往是"我先去干别的"，球一冒出来就把输入焦点
      // 从人正在打字的那个应用手里夺过去的话，那半句话就打飞了。摆好位置再 showInactive。
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "orb-preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    // 窗口的 bounds 上面已经按收起态摆好了，这里再走一遍是为了把 ballTop 算出来：
    // 球在窗口里不再顶着左上角，渲染层得知道该把它画在哪，不然会被状态栏压住。
    this.applyBounds();
    this.pinToTop();
    // 窗口现在比球大出一整条状态栏，那片地方是拿来看的、不是拿来点的：默认让鼠标穿过去，
    // 别把球周围一大片桌面点不着。指针真移到球或面板上时，渲染层会喊一声再放开。
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 球自己要抓屏做毛玻璃，必须先把自己从抓屏结果里排除，否则会拍到上一帧的自己。
    this.window.setContentProtection(true);
    this.window.showInactive();
    this.pinToTop();
    this.window.loadFile(path.join(__dirname, "../src/orb.html")).catch(() => {});
    this.window.webContents.once("did-finish-load", () => {
      this.emitLayout();
      this.sendStatus();
      this.sendFont();
      this.sendCards();
    });
    // 球是个透明窗口，页面没加载出来就是一块什么都没有的空气，而这会儿主窗口已经藏了：
    // 屏幕上一个窗口都不剩，程序就成了只能在任务管理器里看见的进程。加载不成就当球没
    // 立起来，照 Alt+F4 那条路把主窗口叫回来。
    this.window.webContents.on("did-fail-load", (_event, _code, _desc, _url, isMainFrame) => {
      if (isMainFrame) {
        this.onDismissed?.();
      }
    });
    this.window.on("blur", () => this.pinToTop());
    // hide() 走的是 destroy()，不触发 close，所以能落到这里的都是外面把球关掉了
    // （Alt+F4、系统结束会话之类）。这时候主窗口还藏着，屏幕上一个窗口都不剩，程序就成了
    // 一个只能在任务管理器里看见的进程——必须把主窗口叫回来，别让它变成隐形的。
    this.window.on("close", () => this.onDismissed?.());
    this.window.on("closed", () => {
      this.stopDrag();
      this.stopResize();
      this.stopKeepTop();
      this.window = null;
    });
    this.startKeepTop();
  }

  // 别的应用同样可以把自己设成置顶，谁后置顶谁在上面，所以要周期性把自己顶回最前。
  pinToTop() {
    if (!this.isOpen()) {
      return;
    }
    this.window.setAlwaysOnTop(true, "screen-saver", 1);
    this.window.moveTop();
  }

  startKeepTop() {
    this.stopKeepTop();
    this.topTimer = setInterval(() => this.pinToTop(), KEEP_TOP_MS);
  }

  stopKeepTop() {
    if (this.topTimer) {
      clearInterval(this.topTimer);
      this.topTimer = null;
    }
  }

  hide() {
    this.stopDrag();
    this.stopResize();
    this.stopKeepTop();
    if (this.isOpen()) {
      this.window.destroy();
    }
    this.window = null;
  }

  send(channel, payload) {
    if (this.isOpen()) {
      this.window.webContents.send(channel, payload);
    }
  }

  // 球的两侧各剩多宽。球在屏幕中间时两边都够，靠边时只有一边够。
  roomBySide() {
    const area = screen.getDisplayNearestPoint(this.anchor).workArea;
    return {
      right: area.x + area.width - (this.anchor.x + BALL + GAP),
      left: this.anchor.x - GAP - area.x,
    };
  }

  chooseSide() {
    const room = this.roomBySide();
    // 右边整块装得下就摆右边。装不下时要挑宽的那侧，不能一律摆左边：球贴在屏幕左沿时
    // 左边根本没地方，面板会整块滑出屏幕，连右下角那个缩放手柄一起点不到，从此拖不回来。
    this.side = room.right >= this.panel.width || room.right >= room.left ? "right" : "left";
  }

  // 渲染层要拿球在屏幕上的绝对位置，才能把抓来的屏幕画面对齐到球背后。
  emitLayout() {
    if (!this.isOpen() || !this.anchor) {
      return;
    }
    const display = screen.getDisplayNearestPoint(this.anchor);
    this.displayId = display.id;
    this.send("orb:layout", {
      side: this.side,
      ballSize: BALL,
      ballX: this.anchor.x,
      ballY: this.anchor.y,
      ballTop: this.ballTop,
      statusHeight: STATUS_H,
      displayId: display.id,
      display: display.bounds,
    });
  }

  // 面板最大能到多少。球贴着屏幕上下边时不能靠压高度来避免出屏，那会让球停在屏幕上半区
  // 时怎么也拖不高——改成整体挪回屏内，见 panelTop。
  //
  // 宽度按选中那侧实际剩的算：拿整屏宽减一个球去 clamp 的话，球在屏幕中间时算出来的
  // 上限比那侧真有的地方大出快一倍，面板就伸出屏幕了。高度要给状态栏留一条，它在窗口
  // 最顶上、不在面板里，忘了减的话窗口会比工作区高出那么多，底下的缩放手柄正好被顶出去。
  roomForPanel() {
    const area = screen.getDisplayNearestPoint(this.anchor).workArea;
    const room = this.roomBySide();
    const usable = this.side === "left" ? room.left : room.right;
    return {
      width: Math.max(PANEL_MIN_WIDTH, usable),
      height: Math.max(PANEL_MIN_HEIGHT, area.height - STATUS_H),
    };
  }

  // 记着的尺寸是在别的屏幕或别的分辨率下拖出来的，放不下就临时收一收。记着的那个数
  // 不动，回到装得下的地方还是那么大。
  panelSizeNow() {
    const room = this.roomForPanel();
    return {
      width: clamp(this.panel.width, PANEL_MIN_WIDTH, room.width),
      height: clamp(this.panel.height, PANEL_MIN_HEIGHT, room.height),
    };
  }

  // 面板尽量以球为中心，但整块不能越出屏幕——上边缘一出去，"已读""收起"就点不到了。
  // 挪的时候还得始终把球整个圈在窗口里，露到窗口外的部分会被窗口边界裁掉。
  // 上边还要给状态栏让出一条，它在整个窗口的最顶上。
  panelTop(height) {
    const area = screen.getDisplayNearestPoint(this.anchor).workArea;
    const lowest = Math.max(area.y + STATUS_H, this.anchor.y + BALL - height);
    const highest = Math.min(area.y + area.height - height, this.anchor.y);
    return clamp(this.anchor.y - (height - BALL) / 2, lowest, highest);
  }

  // 球的屏幕位置始终由 anchor 决定，展开时只是把窗口朝一侧撑开，
  // 这样面板出现和收起时球不会跳动。
  //
  // 窗口比球大：最顶上那条是状态栏，球和面板都在它下面。收起时窗口也得有状态栏那么宽，
  // 于是球不再顶着窗口左上角，横向偏多少跟着 side 走——球贴在屏幕右边时窗口朝左长，
  // 不然状态栏就伸到屏幕外面去了。
  applyBounds() {
    if (!this.isOpen()) {
      return;
    }

    const size = this.panelSizeNow();
    const width = this.expanded ? BALL + GAP + size.width : Math.max(BALL, STATUS_W);
    const height = STATUS_H + (this.expanded ? size.height : BALL);
    const y = (this.expanded ? this.panelTop(size.height) : this.anchor.y) - STATUS_H;
    const x = this.side === "left" ? this.anchor.x + BALL - width : this.anchor.x;
    // 面板被挪回屏内时球就不在窗口正中了，渲染层得知道该把球画在窗口里的哪个高度上。
    this.ballTop = this.anchor.y - y;
    this.window.setBounds({ x, y, width, height });
    this.emitLayout();
  }

  setExpanded(expanded) {
    if (!this.isOpen() || this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    if (expanded) {
      this.chooseSide();
    }
    this.applyBounds();
    this.pinToTop();
  }

  startDrag() {
    if (!this.isOpen() || this.dragTimer) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    this.dragOrigin = { cursor, anchor: { ...this.anchor } };
    // 轮询光标位置，指针移出小窗口时也能继续跟手。
    this.dragTimer = setInterval(() => {
      const now = screen.getCursorScreenPoint();
      this.anchor = this.clampAnchor({
        x: this.dragOrigin.anchor.x + (now.x - this.dragOrigin.cursor.x),
        y: this.dragOrigin.anchor.y + (now.y - this.dragOrigin.cursor.y),
      });
      this.applyBounds();
    }, DRAG_TICK_MS);
  }

  stopDrag() {
    if (this.dragTimer) {
      clearInterval(this.dragTimer);
      this.dragTimer = null;
    }
    this.dragOrigin = null;
    // 收起时窗口也比球宽，往哪边长同样得重新判一次：球拖到屏幕右边缘时状态栏要朝左让。
    if (this.isOpen()) {
      this.chooseSide();
      this.applyBounds();
    }
  }

  // 要让下边缘落在光标上，得反解出高度。面板通常垂直居中于球心，下边缘就在球心加半个
  // 高度处，于是高度是光标到球心距离的两倍；但面板一旦高到被 panelTop 压在屏幕上边，
  // 下边缘就改成从屏幕上边往下量了，得换另一个式子才跟得住手。两个分支的判据是同一个
  // 不等式，所以越过那个点时手感是连续的。下边缘不可能越过屏幕下边，那侧不用管。
  heightForBottom(bottom) {
    const area = screen.getDisplayNearestPoint(this.anchor).workArea;
    const centerY = this.anchor.y + BALL / 2;
    const centered = (bottom - centerY) * 2;
    return centerY - centered / 2 >= area.y ? centered : bottom - area.y;
  }

  // 拖手柄时让面板那个角跟着光标走，球留在原地不动。每一帧都拿光标的绝对位置重算，
  // 不是累加位移，中途丢一两帧也不会越拖越偏。
  startResize() {
    if (!this.isOpen() || !this.expanded || this.resizeTimer) {
      return;
    }
    this.resizeTimer = setInterval(() => {
      const cursor = screen.getCursorScreenPoint();
      const room = this.roomForPanel();
      const edge = this.side === "left" ? this.anchor.x - GAP - cursor.x : cursor.x - (this.anchor.x + BALL + GAP);
      this.panel = {
        width: clamp(edge, PANEL_MIN_WIDTH, room.width),
        height: clamp(this.heightForBottom(cursor.y), PANEL_MIN_HEIGHT, room.height),
      };
      this.applyBounds();
    }, DRAG_TICK_MS);
  }

  stopResize() {
    if (!this.resizeTimer) {
      return;
    }
    clearInterval(this.resizeTimer);
    this.resizeTimer = null;
    // 拖到贴边时朝球的另一侧翻面，翻完宽度还是这么宽。
    if (this.isOpen() && this.expanded) {
      this.chooseSide();
      this.applyBounds();
    }
    this.savePanelState();
  }
}

module.exports = { OrbWindow };
