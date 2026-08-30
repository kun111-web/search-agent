const ball = document.querySelector("#ball");
const ring = document.querySelector("#ring");
const badge = document.querySelector("#badge");
const panel = document.querySelector("#panel");
const panelBody = document.querySelector("#panel-body");
const panelTitle = document.querySelector("#panel-title");
const collapseBtn = document.querySelector("#collapse");
const expandBtn = document.querySelector("#expand");
const markReadBtn = document.querySelector("#mark-read");
const fontDownBtn = document.querySelector("#font-down");
const fontUpBtn = document.querySelector("#font-up");
const resizeHandle = document.querySelector("#resize");
const glassVideo = document.querySelector("#glass-video");
const statusCollect = document.querySelector("#status-collect");
const statusModel = document.querySelector("#status-model");

const CLICK_SLOP = 5;
// 差这么几像素就当是停在顶上了：滚动位置常有零点几的小数，严格比零会把"没动过"判成"翻过"。
const TOP_SLOP = 4;

const cards = [];
// 这次在采的那一到两个页面，由主进程按勾选顺序给过来。分块的块序照它走。
let sources = [];
let expanded = false;
let drag = null;
let glassDisplayId = null;
// 窗口比球大出一条状态栏，那片地方是拿来看的、不是拿来点的：主进程默认让鼠标穿过去，
// 指针真压到球或面板上时才放开交互。这两个跟着交互走的状态得跟上面几个摆一处，
// 收起面板、拖动收尾时都要读它们。
let interactive = false;
let resizing = false;
// 上一次画的时候列表里都有哪些条目，用来认出这次新到的。null 是"还没画过"。
let seenCards = null;

// 徽标就是列表里攒着的条数：这两个数字必须是同一个，否则会出现"徽标写着 50、
// 点开只有 30 条"这种对不上账的情形。
function renderBadge() {
  badge.hidden = cards.length === 0;
  badge.textContent = cards.length > 99 ? "99+" : String(cards.length);
}

function buildCard(item, fresh) {
  const card = document.createElement("article");
  card.className = fresh ? "card fresh" : "card";
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名";
  card.append(title);
  if (item.summary) {
    const summary = document.createElement("p");
    summary.textContent = item.summary;
    card.append(summary);
  }
  const meta = [item.time, item.match].filter(Boolean).join(" · ");
  if (meta) {
    const line = document.createElement("div");
    line.className = "meta";
    line.textContent = meta;
    card.append(line);
  }
  return card;
}

function emptyLine(text) {
  return Object.assign(document.createElement("p"), { className: "empty", textContent: text });
}

function buildGroup(label, items, fresh) {
  const section = document.createElement("section");
  section.className = "group";
  const head = document.createElement("header");
  head.textContent = items.length ? `${label} · ${items.length}` : label;
  section.append(head);
  section.append(
    ...(items.length
      ? items.map((item) => buildCard(item, fresh.has(cardId(item))))
      : [emptyLine("这个站还没有命中的消息")]),
  );
  return section;
}

// 哪些是"这一次才出现的"。不能拿"排在最前面"当新的：球是缩起来才建、点开就销毁的窗口，
// 每次重建都会从主进程收到一份全量列表，那样一来最上面那条会永远挂着新消息的高亮，
// 看多少遍都还是新的。
//
// 上一次是空的就谁都不算新。球刚建出来时先画一次空列表，紧接着主进程补上攒着的那些——
// 那是之前的消息，人没看过不等于刚到，整屏高亮反倒把真正新到的那条淹了。清空已读之后
// 的第一条同理：一条消息不需要在一堆里指出哪个是新的，徽标已经说了。
function freshCards() {
  if (!seenCards?.size) {
    return new Set();
  }
  return new Set(cards.map(cardId).filter((id) => !seenCards.has(id)));
}

function cardId(item) {
  return `${item.originId || ""}\u0000${item.title || ""}\u0000${item.summary || ""}`;
}

// 只盯着一个页面时不分块：每条上面都顶一个同样的站名只是占地方。
function flatCards(fresh) {
  if (!cards.length) {
    return [emptyLine("还没有命中的消息")];
  }
  return cards.map((item) => buildCard(item, fresh.has(cardId(item))));
}

// 未读列表只由「已读」清空，所以里面可能还留着上一轮采别的页面时攒下的消息。那些条目
// 归不到现在这两块里，但不能就此从界面上消失，单独兜一块放它们。
function groupedCards(fresh) {
  const known = new Set(sources.map((source) => source.id));
  const groups = sources.map((source) =>
    buildGroup(
      source.label,
      cards.filter((item) => (item.originId || "") === source.id),
      fresh,
    ),
  );
  const leftover = cards.filter((item) => !known.has(item.originId || ""));
  if (leftover.length) {
    groups.push(buildGroup("之前采到的", leftover, fresh));
  }
  return groups;
}

function renderCards() {
  // 人往下翻着、正读到某一条的时候，新消息一到就把他甩回顶部是很讨嫌的：那条还没读完
  // 就找不着了。只有本来就停在顶上的才跟着新消息走。
  const wasAtTop = panelBody.scrollTop <= TOP_SLOP;
  const keptScroll = panelBody.scrollTop;
  const fresh = freshCards();

  panelTitle.textContent = cards.length ? `符合要求的消息 · ${cards.length}` : "符合要求的消息";
  markReadBtn.disabled = cards.length === 0;
  panelBody.replaceChildren(...(sources.length < 2 ? flatCards(fresh) : groupedCards(fresh)));
  panelBody.scrollTop = wasAtTop ? 0 : keptScroll;
  seenCards = new Set(cards.map(cardId));
}

function setExpanded(next) {
  if (expanded === next) {
    return;
  }
  expanded = next;
  panel.hidden = !next;
  document.body.dataset.expanded = next ? "1" : "0";
  window.orb.setExpanded(next);
  syncGlassStream();
  // 窗口大小跟着变了，刚才那次"指针压在什么上面"的判断就不作数了。收起面板时指针
  // 多半落到了窗口外面（面板没了那块地方），既收不到 mousemove 也收不到 mouseleave，
  // 不主动放开的话球周围一整片会一直挡着桌面上的点击。
  setInteractive(false);
}

// 面板只由人开关：点箭头开，点箭头或"收起"关。它不会自己关掉——上一版有个"十几秒
// 没动就收起"的钟，那是配合"新消息自动弹出"用的，弹出这件事去掉之后它就没有存在理由了，
// 反而会在人正在读的时候把面板收走。
function collapse() {
  setExpanded(false);
}

function toggleExpanded() {
  setExpanded(!expanded);
}

/** 清空这里攒着的未读列表。这是唯一会清空它的入口——重新采集、重新筛选都不动它，
 *  归档数据库和主窗口的采集面板也都不动。 */
function markRead() {
  if (!cards.length) {
    return;
  }
  cards.length = 0;
  renderCards();
  renderBadge();
  window.orb.markRead();
}

// 列表由主进程持有：球窗口是缩起来才建、点一下就销毁的，状态留在这边活不过一次来回。
// 去重、排序、条数上限都在那边做完了，这里照着画就行。
function showCards(payload) {
  cards.length = 0;
  cards.push(...(payload.items || []));
  sources = payload.sources || [];
  renderCards();
  renderBadge();
}

// 字号由主进程记着（跟面板尺寸存一处），这边只负责把倍率写进 CSS 变量，
// 并在到头时把按钮按灰。
function showFont(font) {
  document.body.style.setProperty("--font-scale", String(font.scale || 1));
  fontDownBtn.disabled = Boolean(font.atMin);
  fontUpBtn.disabled = Boolean(font.atMax);
}

// 状态文字是主进程那边合成好的，这里只负责摆上去。球缩起来重建时也会立刻收到一份，
// 所以状态栏不会有"要等下一个事件才有字"的空档。
function showStatus(status) {
  statusCollect.querySelector(".text").textContent = status.collect || "";
  statusModel.querySelector(".text").textContent = status.model || "";
  statusCollect.classList.toggle("on", Boolean(status.collectRunning));
  statusModel.classList.toggle("on", Boolean(status.modelRunning) && !status.modelWarn);
  statusModel.classList.toggle("warn", Boolean(status.modelWarn));
  // 光圈表示"这程序还在替我干活"，采集和筛选任一在跑都算。
  ring.classList.toggle("running", Boolean(status.collectRunning || status.modelRunning));
}

ball.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  ball.setPointerCapture(event.pointerId);
  drag = { x: event.screenX, y: event.screenY, moved: false };
  syncGlassStream();
  window.orb.dragStart();
});

ball.addEventListener("pointermove", (event) => {
  if (drag && (Math.abs(event.screenX - drag.x) > CLICK_SLOP || Math.abs(event.screenY - drag.y) > CLICK_SLOP)) {
    drag.moved = true;
  }
});

// 收尾要跟 pointerdown 对称只认左键：按住球的时候点一下右键，右键这一下的 pointerup
// 也会走到这里，"没挪动"于是成立，球当场弹回主窗口——而左键还按着。
ball.addEventListener("pointerup", (event) => {
  if (!drag || event.button !== 0) {
    return;
  }
  const moved = endDrag(event);
  // 没挪动就当成单击，回到主窗口。
  if (!moved) {
    window.orb.restore();
  }
});

// 拖动中被系统打断（触屏手势取消、切窗口、锁屏）时收不到 pointerup。不收尾的话主进程
// 那边每 16 毫秒照旧按光标位置挪窗口，球就一直粘着鼠标跑了。这里只收尾，不算单击。
ball.addEventListener("pointercancel", (event) => {
  if (drag) {
    endDrag(event);
  }
});

function endDrag(event) {
  const moved = drag.moved;
  drag = null;
  syncGlassStream();
  // capture 可能已经被隐式释放了，直接释放会抛，后面的收尾就都不做了
  if (ball.hasPointerCapture(event.pointerId)) {
    ball.releasePointerCapture(event.pointerId);
  }
  window.orb.dragEnd();
  // 拖到屏幕边上时球被钉住、光标继续往外走，松手时指针已经在窗口外了，之后既不会再有
  // 窗口内的 mousemove 也不会有 mouseleave——不主动放开的话，球周围那一片会一直吞掉
  // 落在桌面上的点击。指针要真还在球上，下一次 mousemove 立刻就会切回来。
  setInteractive(false);
  return moved;
}

collapseBtn.addEventListener("click", collapse);

fontDownBtn.addEventListener("click", () => window.orb.stepFont(-1));
fontUpBtn.addEventListener("click", () => window.orb.stepFont(1));

// 箭头长在球里面，指针事件必须挡住，否则会顺着冒泡触发球的"单击回主窗口"。
for (const type of ["pointerdown", "pointermove", "pointerup"]) {
  expandBtn.addEventListener(type, (event) => event.stopPropagation());
}

expandBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleExpanded();
});

markReadBtn.addEventListener("click", markRead);

// 尺寸由主进程算：它才知道球在屏幕上的绝对位置，也才能把窗口跟着光标撑开。这边只负责
// 报告"按下了"和"松手了"。
resizeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  event.stopPropagation();
  resizeHandle.setPointerCapture(event.pointerId);
  resizing = true;
  syncGlassStream();
  window.orb.resizeStart();
});

// pointercancel 也要收尾：拖动中被系统打断（切走窗口之类）时收不到 pointerup，
// 漏掉的话主进程那边会一直跟着光标改尺寸。
function endResize(event) {
  event.stopPropagation();
  resizing = false;
  syncGlassStream();
  if (resizeHandle.hasPointerCapture(event.pointerId)) {
    resizeHandle.releasePointerCapture(event.pointerId);
  }
  window.orb.resizeEnd();
  // 跟拖球一样：面板被屏幕边界挡住之后光标会跑到窗口外面松手，那之后收不到任何
  // 鼠标事件，穿透就卡在"不穿"这一侧，挡着底下的点击。
  setInteractive(false);
}

resizeHandle.addEventListener("pointerup", endResize);
resizeHandle.addEventListener("pointercancel", endResize);

// 拖动和调尺寸的过程中一律不切：那时候指针经常甩到窗口外面，半路切成穿透就收不到
// pointerup，主进程那边会一直跟着光标改位置、改尺寸。
function setInteractive(next) {
  if (next === interactive) {
    return;
  }
  interactive = next;
  // 也写进 dataset：穿透卡在哪一边是看不见的，出问题时得有个能一眼看出来的地方
  document.body.dataset.hit = next ? "1" : "0";
  syncGlassStream();
  window.orb.setInteractive(next);
}

document.addEventListener("mousemove", (event) => {
  if (drag || resizing) {
    return;
  }
  const under = document.elementFromPoint(event.clientX, event.clientY);
  setInteractive(Boolean(under?.closest(".ball, .panel")));
});

// 指针一口气甩出窗口时收不到窗口内的 mousemove，靠这个收尾，别让窗口一直挡着点击。
document.addEventListener("mouseleave", () => {
  if (!drag && !resizing) {
    setInteractive(false);
  }
});

// 抓整块屏幕，再用负偏移把「球背后那一小片」挪到球的位置上，配合圆形裁剪就是真毛玻璃。
function alignGlass(layout) {
  const { ballX, ballY, display } = layout;
  glassVideo.style.width = `${display.width}px`;
  glassVideo.style.height = `${display.height}px`;
  glassVideo.style.left = `${display.x - ballX}px`;
  glassVideo.style.top = `${display.y - ballY}px`;
}

async function startGlass() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // 反正要模糊：球就 64 像素大、整块画面还要高斯模糊，960 宽加两三帧绰绰有余。
      // 挂机时这条流可能一开就是几个小时，参数压狠一点省的是几个小时的编码开销。
      video: { frameRate: { ideal: 2, max: 3 }, width: { ideal: 960 } },
      audio: false,
    });
    glassVideo.srcObject = stream;
    await glassVideo.play();
    document.body.classList.add("glass-on");
    syncGlassStream();
  } catch (error) {
    // 抓不到屏就退回纯 CSS 磨砂，不影响使用
    console.error(`屏幕流启动失败: ${error.name} ${error.message}`);
    document.body.classList.remove("glass-on");
  }
}

function stopGlass() {
  clearTimeout(glassIdleTimer);
  const stream = glassVideo.srcObject;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    glassVideo.srcObject = null;
  }
  glassActive = true;
  document.body.classList.remove("glass-on");
}

// 收起来、指针也不在球上的时候，毛玻璃画面没有任何人细看。把视频轨关掉，
// Chromium 就会停掉那一路屏幕内容的采集和编码——球一挂几小时，省的就是这几小时。
// 展开面板或者指针压上来立即恢复，玻璃重新跟上桌面。
// 停要缓一缓：缩成球的瞬间主窗口才藏起来，头几帧抓到的还是窗口没消失时的桌面，
// 立刻冻结就把旧画面永久冻在球里了。
const GLASS_IDLE_MS = 45000;
let glassActive = true;
let glassIdleTimer = null;

function applyGlassActive(active) {
  if (!glassVideo.srcObject || active === glassActive) {
    return;
  }
  glassActive = active;
  for (const track of glassVideo.srcObject.getVideoTracks()) {
    track.enabled = active;
  }
}

function syncGlassStream() {
  if (!glassVideo.srcObject) {
    return;
  }
  clearTimeout(glassIdleTimer);
  const busy = Boolean(expanded || interactive || drag || resizing);
  if (busy) {
    applyGlassActive(true);
  } else {
    glassIdleTimer = setTimeout(() => applyGlassActive(false), GLASS_IDLE_MS);
  }
}

window.orb.onLayout((layout) => {
  document.body.dataset.side = layout.side;
  document.body.style.setProperty("--ball-top", `${layout.ballTop || 0}px`);
  document.body.style.setProperty("--status-h", `${layout.statusHeight || 0}px`);
  alignGlass(layout);
  // 球被拖到另一块屏幕时要重新抓那一块
  if (layout.displayId !== glassDisplayId) {
    glassDisplayId = layout.displayId;
    stopGlass();
    void startGlass();
  } else {
    syncGlassStream();
  }
});

window.orb.onStatus(showStatus);
window.orb.onCards(showCards);
window.orb.onFont(showFont);
document.body.dataset.expanded = "0";
// 跟主进程那边的初始值对上：球刚出来时鼠标是穿透的，等指针压上来再放开。
document.body.dataset.hit = "0";
renderCards();
renderBadge();
