const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const DEFAULT_SIGNAL_URL = "wss://cotrux-production.up.railway.app/ws";

const els = {
  connectView: $("#connectView"),
  connectForm: $("#connectForm"),
  pin: $("#pin"),
  trustedHosts: $("#trustedHosts"),
  signalUrl: $("#signalUrl"),
  turnUrl: $("#turnUrl"),
  turnUser: $("#turnUser"),
  turnPass: $("#turnPass"),
  saveSettings: $("#saveSettings"),
  statusPill: $("#statusPill"),
  statusText: $("#statusText"),

  remoteView: $("#remoteView"),
  remoteStage: $("#remoteStage"),
  videoSurface: $("#videoSurface"),
  remoteVideo: $("#remoteVideo"),
  emptyScreen: $("#emptyScreen"),
  hostName: $("#hostName"),
  connectionInfo: $("#connectionInfo"),
  sessionStatusText: $("#sessionStatusText"),
  backBtn: $("#backBtn"),
  fullscreenBtn: $("#fullscreenBtn"),
  orientationBtn: $("#orientationBtn"),
  stopBtn: $("#stopBtn"),
  immersiveRestoreBtn: $("#immersiveRestoreBtn"),

  zoomHud: $("#zoomHud"),
  zoomOutBtn: $("#zoomOutBtn"),
  zoomValueBtn: $("#zoomValueBtn"),
  zoomInBtn: $("#zoomInBtn"),
  modeBadge: $("#modeBadge"),

  sessionDock: $("#sessionDock"),
  modeBtn: $("#modeBtn"),
  modeBtnLabel: $("#modeBtnLabel"),
  leftClickBtn: $("#leftClickBtn"),
  rightClickBtn: $("#rightClickBtn"),
  keyboardBtn: $("#keyboardBtn"),
  shortcutsBtn: $("#shortcutsBtn"),
  viewBtn: $("#viewBtn"),
  clipboardBtn: $("#clipboardBtn"),
  hideControlsBtn: $("#hideControlsBtn"),

  controlDrawer: $("#controlDrawer"),
  drawerTitle: $("#drawerTitle"),
  drawerSubtitle: $("#drawerSubtitle"),
  drawerCloseBtn: $("#drawerCloseBtn"),
  keyboardPanel: $("#keyboardPanel"),
  shortcutsPanel: $("#shortcutsPanel"),
  viewPanel: $("#viewPanel"),
  mobileKeyboard: $("#mobileKeyboard"),
  releaseModifiersBtn: $("#releaseModifiersBtn"),

  fitBtn: $("#fitBtn"),
  fillBtn: $("#fillBtn"),
  actualSizeBtn: $("#actualSizeBtn"),
  centerViewBtn: $("#centerViewBtn"),
  drawerZoomOutBtn: $("#drawerZoomOutBtn"),
  drawerZoomInBtn: $("#drawerZoomInBtn"),
  zoomRange: $("#zoomRange"),
  drawerZoomValue: $("#drawerZoomValue")
};

let ws;
let pc;
let controlChannel;
let pendingCandidates = [];
let sessionActive = false;
let currentConnection = null;
let pointerMoveFrame = 0;
let drawerName = "";
let interactionMode = "direct";
let controlsHidden = false;
let immersiveMode = false;
let remoteCursor = { x: 0.5, y: 0.5 };
let view = { zoom: 1, panX: 0, panY: 0, fitWidth: 16, fitHeight: 9 };
const activePointers = new Map();
let touchAction = null;
let gesture = null;
const heldModifiers = new Set();

const controllerId = localStorage.getItem("cotrux.controllerId") || crypto.randomUUID();
localStorage.setItem("cotrux.controllerId", controllerId);

const saved = JSON.parse(localStorage.getItem("cotrux.controller.settings") || "{}");
els.signalUrl.value = saved.signalUrl || DEFAULT_SIGNAL_URL;
els.turnUrl.value = saved.turnUrl || "";
els.turnUser.value = saved.turnUser || "";
els.turnPass.value = saved.turnPass || "";

const keyDefinitions = {
  ControlLeft: { key: "Control", code: "ControlLeft" },
  AltLeft: { key: "Alt", code: "AltLeft" },
  ShiftLeft: { key: "Shift", code: "ShiftLeft" },
  MetaLeft: { key: "Meta", code: "MetaLeft" }
};

const shortcutMap = {
  "alt-tab": [
    { key: "Alt", code: "AltLeft" },
    { key: "Tab", code: "Tab" }
  ],
  "win-d": [
    { key: "Meta", code: "MetaLeft" },
    { key: "d", code: "KeyD" }
  ],
  "win-e": [
    { key: "Meta", code: "MetaLeft" },
    { key: "e", code: "KeyE" }
  ],
  "win-r": [
    { key: "Meta", code: "MetaLeft" },
    { key: "r", code: "KeyR" }
  ],
  "ctrl-shift-esc": [
    { key: "Control", code: "ControlLeft" },
    { key: "Shift", code: "ShiftLeft" },
    { key: "Escape", code: "Escape" }
  ],
  "alt-f4": [
    { key: "Alt", code: "AltLeft" },
    { key: "F4", code: "F4" }
  ],
  "ctrl-c": [{ key: "Control", code: "ControlLeft" }, { key: "c", code: "KeyC" }],
  "ctrl-v": [{ key: "Control", code: "ControlLeft" }, { key: "v", code: "KeyV" }],
  "ctrl-x": [{ key: "Control", code: "ControlLeft" }, { key: "x", code: "KeyX" }],
  "ctrl-a": [{ key: "Control", code: "ControlLeft" }, { key: "a", code: "KeyA" }],
  "ctrl-z": [{ key: "Control", code: "ControlLeft" }, { key: "z", code: "KeyZ" }],
  "ctrl-y": [{ key: "Control", code: "ControlLeft" }, { key: "y", code: "KeyY" }],
  "ctrl-s": [{ key: "Control", code: "ControlLeft" }, { key: "s", code: "KeyS" }],
  "ctrl-f": [{ key: "Control", code: "ControlLeft" }, { key: "f", code: "KeyF" }],
  "ctrl-l": [{ key: "Control", code: "ControlLeft" }, { key: "l", code: "KeyL" }],
  "ctrl-t": [{ key: "Control", code: "ControlLeft" }, { key: "t", code: "KeyT" }],
  "ctrl-w": [{ key: "Control", code: "ControlLeft" }, { key: "w", code: "KeyW" }],
  "ctrl-shift-t": [
    { key: "Control", code: "ControlLeft" },
    { key: "Shift", code: "ShiftLeft" },
    { key: "t", code: "KeyT" }
  ]
};

function setStatus(text, state = "idle") {
  els.statusText.textContent = text;
  els.statusPill.dataset.state = state;
}

function setSessionStatus(text, connected = false) {
  els.sessionStatusText.textContent = text;
  els.remoteView.dataset.connected = connected ? "true" : "false";
}

function saveSettings() {
  const settings = {
    signalUrl: els.signalUrl.value.trim() || DEFAULT_SIGNAL_URL,
    turnUrl: els.turnUrl.value.trim(),
    turnUser: els.turnUser.value.trim(),
    turnPass: els.turnPass.value
  };
  localStorage.setItem("cotrux.controller.settings", JSON.stringify(settings));
  els.signalUrl.value = settings.signalUrl;
  setStatus("Settings saved", "idle");
  return settings;
}

function loadTrustedHosts() {
  try {
    const items = JSON.parse(localStorage.getItem("cotrux.trustedHosts") || "[]");
    return Array.isArray(items) ? items.filter(item => item?.deviceId && item?.token) : [];
  } catch {
    return [];
  }
}

function saveTrustedHosts(items) {
  localStorage.setItem("cotrux.trustedHosts", JSON.stringify(items.slice(0, 30)));
  renderTrustedHosts();
}

function storeTrustedHost(grant) {
  if (!grant?.deviceId || !grant?.token || grant.controllerId !== controllerId) return;
  const items = loadTrustedHosts().filter(item => item.deviceId !== grant.deviceId);
  items.unshift({
    deviceId: grant.deviceId,
    hostName: String(grant.hostName || "Cotrux computer").slice(0, 80),
    controllerId,
    token: grant.token,
    trustedAt: Date.now()
  });
  saveTrustedHosts(items);
  setStatus("Computer saved for one-tap access", "connected");
}

function renderTrustedHosts() {
  const items = loadTrustedHosts();
  els.trustedHosts.innerHTML = "";

  if (!items.length) {
    els.trustedHosts.innerHTML = '<div class="empty-hosts"><strong>No trusted computers yet</strong><span>Pair once with the PIN below, then trust this controller on the desktop app.</span></div>';
    return;
  }

  for (const host of items) {
    const row = document.createElement("div");
    row.className = "trusted-host";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = host.hostName || "Cotrux computer";
    const sub = document.createElement("span");
    sub.textContent = "Trusted · no PIN required";
    info.append(name, sub);

    const actions = document.createElement("div");
    actions.className = "trusted-actions";

    const connect = document.createElement("button");
    connect.className = "primary compact";
    connect.type = "button";
    connect.textContent = "Connect";
    connect.addEventListener("click", () => connectTrusted(host));

    const remove = document.createElement("button");
    remove.className = "ghost compact";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      saveTrustedHosts(loadTrustedHosts().filter(item => item.deviceId !== host.deviceId));
      setStatus("Saved computer removed", "idle");
    });

    actions.append(connect, remove);
    row.append(info, actions);
    els.trustedHosts.append(row);
  }
}

function getIceServers() {
  const settings = saveSettings();
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (settings.turnUrl) {
    servers.push({
      urls: settings.turnUrl,
      username: settings.turnUser,
      credential: settings.turnPass
    });
  }
  return servers;
}

function sendWs(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function sendControl(payload) {
  if (controlChannel?.readyState === "open") {
    controlChannel.send(JSON.stringify(payload));
  }
}

function sendKey(action, key, code) {
  sendControl({ kind: "key", action, key, code });
}

function tapKey(key, code) {
  sendKey("tap", key, code);
}

function sendCombo(sequence = []) {
  for (const item of sequence) sendKey("down", item.key, item.code);
  for (const item of [...sequence].reverse()) sendKey("up", item.key, item.code);
}

function releaseAllModifiers() {
  for (const code of heldModifiers) {
    const def = keyDefinitions[code];
    if (def) sendKey("up", def.key, def.code);
  }
  heldModifiers.clear();
  $$(".modifier-key").forEach(button => button.classList.remove("active"));
}

function teardownPeer() {
  sessionActive = false;
  releaseAllModifiers();

  if (controlChannel) {
    try { controlChannel.close(); } catch {}
  }
  controlChannel = null;

  if (pc) {
    try { pc.close(); } catch {}
  }
  pc = null;
  pendingCandidates = [];
  els.remoteVideo.srcObject = null;
  els.emptyScreen.classList.remove("hidden");
  activePointers.clear();
  touchAction = null;
  gesture = null;
  resetView();
}

function exitRemoteUi() {
  closeDrawer();
  immersiveMode = false;
  controlsHidden = false;
  document.body.classList.remove("remote-active", "remote-immersive", "remote-controls-hidden");
  els.remoteView.classList.add("hidden");
  if (location.hash === "#remote") {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function showConnect(message = "Ready", state = "idle") {
  teardownPeer();
  currentConnection = null;
  exitRemoteUi();
  setStatus(message, state);
}

function showRemote(hostName = "Remote computer", unattended = false) {
  document.body.classList.add("remote-active");
  els.remoteView.classList.remove("hidden");
  els.hostName.textContent = hostName;
  els.connectionInfo.textContent = unattended
    ? "Trusted connection · preparing encrypted session…"
    : "Preparing encrypted WebRTC session…";
  setSessionStatus("Connecting", false);
  setStatus("Connecting", "pending");

  if (location.hash !== "#remote") {
    history.pushState({ cotruxRemote: true }, "", "#remote");
  }

  requestAnimationFrame(updateVideoGeometry);
}

async function createPeer() {
  teardownPeer();
  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.onicecandidate = event => {
    if (event.candidate) sendWs({ type: "signal", data: { candidate: event.candidate } });
  };

  pc.ontrack = event => {
    const [stream] = event.streams;
    if (!stream) return;
    els.remoteVideo.srcObject = stream;
    els.emptyScreen.classList.add("hidden");
    els.connectionInfo.textContent = currentConnection?.unattended
      ? "Live desktop · trusted access"
      : "Live desktop · controls active";
    setTimeout(updateVideoGeometry, 50);
  };

  pc.ondatachannel = event => {
    controlChannel = event.channel;
    wireControlChannel();
  };

  pc.onconnectionstatechange = () => {
    const state = pc?.connectionState;
    if (state === "connected") {
      sessionActive = true;
      setStatus("Connected", "connected");
      setSessionStatus("Live", true);
      els.connectionInfo.textContent = currentConnection?.unattended
        ? "Live desktop · trusted access"
        : "Live desktop · controls active";
      els.remoteStage.focus({ preventScroll: true });
      updateVideoGeometry();
    } else if (["failed", "disconnected"].includes(state)) {
      setStatus("Connection lost", "error");
      setSessionStatus("Interrupted", false);
      els.connectionInfo.textContent = "Peer connection interrupted";
    }
  };

  return pc;
}

function wireControlChannel() {
  if (!controlChannel) return;

  controlChannel.onopen = () => {
    sessionActive = true;
    setStatus("Connected", "connected");
    setSessionStatus("Live", true);
    els.connectionInfo.textContent = currentConnection?.unattended
      ? "Live desktop · trusted access"
      : "Live desktop · controls active";
  };

  controlChannel.onmessage = event => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload?.kind === "cotrux-trust-grant") storeTrustedHost(payload);
  };

  controlChannel.onclose = () => {
    sessionActive = false;
    setStatus("Control closed", "error");
    setSessionStatus("Control closed", false);
  };
}

async function handleSignal(data) {
  if (data.description) {
    if (!pc) await createPeer();
    await pc.setRemoteDescription(data.description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: "signal", data: { description: pc.localDescription } });

    while (pendingCandidates.length) {
      await pc.addIceCandidate(pendingCandidates.shift());
    }
    return;
  }

  if (data.candidate) {
    if (!pc || !pc.remoteDescription) pendingCandidates.push(data.candidate);
    else await pc.addIceCandidate(data.candidate);
  }
}

function controllerName() {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return "Cotrux on iPhone";
  if (/Android/i.test(navigator.userAgent)) return "Cotrux on Android";
  return "Cotrux web controller";
}

function openSignal(joinPayload, context) {
  const url = els.signalUrl.value.trim() || DEFAULT_SIGNAL_URL;
  els.signalUrl.value = url;
  saveSettings();
  currentConnection = context;
  setStatus("Connecting to Cotrux", "pending");

  if (ws) {
    try { ws.close(); } catch {}
  }

  try {
    ws = new WebSocket(url);
  } catch {
    setStatus("Invalid server address", "error");
    return;
  }

  ws.onopen = () => {
    setStatus(context.unattended ? "Connecting to trusted computer" : "Requesting host approval", "pending");
    sendWs(joinPayload);
  };

  ws.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "pending") {
      currentConnection.hostName = msg.hostName || currentConnection.hostName;
      setStatus("Awaiting approval", "pending");
      return;
    }

    if (msg.type === "paired") {
      currentConnection.unattended = Boolean(msg.unattended);
      currentConnection.hostName = msg.hostName || currentConnection.hostName || "Remote computer";
      showRemote(currentConnection.hostName, currentConnection.unattended);
      return;
    }

    if (msg.type === "signal") {
      try {
        await handleSignal(msg.data || {});
      } catch (error) {
        console.error(error);
        setStatus("WebRTC negotiation failed", "error");
        setSessionStatus("Negotiation failed", false);
      }
      return;
    }

    if (msg.type === "rejected") {
      showConnect("Host rejected request", "error");
      return;
    }

    if (["peer-left", "session-ended"].includes(msg.type)) {
      showConnect("Session ended", "idle");
      return;
    }

    if (msg.type === "error") {
      const errors = {
        HOST_NOT_FOUND: "PIN not found",
        HOST_DISCONNECTED: "Host disconnected",
        BAD_PIN: "Invalid PIN",
        HOST_BUSY: "Computer is already in a session",
        RATE_LIMITED: "Too many attempts. Try again shortly.",
        TRUST_HOST_OFFLINE: "Trusted computer is offline",
        TRUST_DISABLED: "Unattended access is disabled on that computer",
        TRUST_INVALID: "Trusted access was revoked. Pair again with a PIN."
      };
      showConnect(errors[msg.code] || "Connection error", "error");
    }
  };

  ws.onerror = () => setStatus("Cotrux service connection failed", "error");
  ws.onclose = () => {
    if (!sessionActive && document.body.classList.contains("remote-active")) {
      setStatus("Service disconnected", "error");
      setSessionStatus("Offline", false);
    }
  };
}

function connectWithPin(pin) {
  openSignal({
    type: "controller-join",
    pin,
    controllerId,
    name: controllerName(),
    wantsTrust: true
  }, {
    unattended: false,
    hostName: "Remote computer"
  });
}

function connectTrusted(host) {
  openSignal({
    type: "trusted-join",
    deviceId: host.deviceId,
    controllerId,
    token: host.token,
    name: controllerName()
  }, {
    unattended: true,
    hostName: host.hostName || "Trusted computer",
    deviceId: host.deviceId
  });
}

/* View and zoom */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stageSize() {
  return {
    width: Math.max(1, els.remoteStage.clientWidth),
    height: Math.max(1, els.remoteStage.clientHeight)
  };
}

function updateVideoGeometry() {
  const { width: stageWidth, height: stageHeight } = stageSize();
  const videoWidth = els.remoteVideo.videoWidth || 1920;
  const videoHeight = els.remoteVideo.videoHeight || 1080;
  const ratio = videoWidth / videoHeight;
  const stageRatio = stageWidth / stageHeight;

  if (stageRatio > ratio) {
    view.fitHeight = stageHeight;
    view.fitWidth = stageHeight * ratio;
  } else {
    view.fitWidth = stageWidth;
    view.fitHeight = stageWidth / ratio;
  }

  els.videoSurface.style.width = view.fitWidth + "px";
  els.videoSurface.style.height = view.fitHeight + "px";
  clampPan();
  applyViewTransform();
}

function clampPan() {
  const { width: stageWidth, height: stageHeight } = stageSize();
  const scaledWidth = view.fitWidth * view.zoom;
  const scaledHeight = view.fitHeight * view.zoom;
  const maxX = Math.max(0, (scaledWidth - stageWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - stageHeight) / 2);
  view.panX = clamp(view.panX, -maxX, maxX);
  view.panY = clamp(view.panY, -maxY, maxY);
}

function applyViewTransform() {
  els.videoSurface.style.transform =
    "translate(-50%, -50%) translate3d(" + view.panX + "px," + view.panY + "px,0) scale(" + view.zoom + ")";
  const percentage = Math.round(view.zoom * 100) + "%";
  els.zoomValueBtn.textContent = percentage;
  els.drawerZoomValue.textContent = percentage;
  els.zoomRange.value = String(Math.round(view.zoom * 100));
}

function setZoom(newZoom, focusClientX = null, focusClientY = null) {
  const previous = view.zoom;
  const next = clamp(Number(newZoom) || 1, 0.5, 4);
  const rect = els.remoteStage.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  if (focusClientX !== null && focusClientY !== null && previous > 0) {
    const focusX = focusClientX - rect.left;
    const focusY = focusClientY - rect.top;
    const ratio = next / previous;
    view.panX = focusX - centerX - ratio * (focusX - centerX - view.panX);
    view.panY = focusY - centerY - ratio * (focusY - centerY - view.panY);
  }

  view.zoom = next;
  clampPan();
  applyViewTransform();
}

function zoomBy(delta, x = null, y = null) {
  setZoom(view.zoom + delta, x, y);
}

function resetView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  if (els.videoSurface) applyViewTransform();
}

function fillView() {
  const { width: stageWidth, height: stageHeight } = stageSize();
  if (!view.fitWidth || !view.fitHeight) return;
  const fillZoom = Math.max(stageWidth / view.fitWidth, stageHeight / view.fitHeight);
  view.panX = 0;
  view.panY = 0;
  setZoom(fillZoom);
}

function actualSizeView() {
  const videoWidth = els.remoteVideo.videoWidth || view.fitWidth;
  const videoHeight = els.remoteVideo.videoHeight || view.fitHeight;
  const scale = Math.max(videoWidth / Math.max(1, view.fitWidth), videoHeight / Math.max(1, view.fitHeight));
  view.panX = 0;
  view.panY = 0;
  setZoom(clamp(scale, 1, 4));
}

function videoPoint(clientX, clientY) {
  const rect = els.videoSurface.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/* Interaction modes */
function setControlsHidden(hidden) {
  controlsHidden = Boolean(hidden);
  document.body.classList.toggle("remote-controls-hidden", controlsHidden);
  if (controlsHidden) closeDrawer();
  requestAnimationFrame(updateVideoGeometry);
}

async function setImmersiveMode(enabled) {
  immersiveMode = Boolean(enabled);
  document.body.classList.toggle("remote-immersive", immersiveMode);
  setControlsHidden(immersiveMode || controlsHidden);

  if (immersiveMode) {
    const target = document.documentElement.requestFullscreen
      ? document.documentElement
      : els.remoteView.requestFullscreen
        ? els.remoteView
        : null;
    try {
      if (target && !document.fullscreenElement) await target.requestFullscreen();
    } catch {}
  } else {
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    } catch {}
    document.body.classList.remove("remote-controls-hidden");
    controlsHidden = false;
  }

  setTimeout(updateVideoGeometry, 80);
}

function setInteractionMode(mode) {
  if (!["direct", "trackpad", "pan"].includes(mode)) return;
  interactionMode = mode;
  const labels = {
    direct: ["Direct", "Direct touch", "◎"],
    trackpad: ["Trackpad", "Trackpad mode", "◉"],
    pan: ["Pan", "Pan screen", "✥"]
  };
  els.modeBtnLabel.textContent = labels[mode][0];
  els.modeBadge.textContent = labels[mode][1];
  els.modeBtn.querySelector(".dock-icon").textContent = labels[mode][2];
  $(".interaction-option").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));

  if (mode === "trackpad") {
    setTimeout(() => {
      if (interactionMode === "trackpad" && sessionActive && !drawerName) setControlsHidden(true);
    }, 220);
  }
}

function cycleInteractionMode() {
  const order = ["direct", "trackpad", "pan"];
  const index = order.indexOf(interactionMode);
  setInteractionMode(order[(index + 1) % order.length]);
}

function sendMouseClick(button = "left") {
  sendControl({ kind: "mouse", action: "down", button });
  sendControl({ kind: "mouse", action: "up", button });
}

function pointerCenter(points) {
  const items = [...points.values()];
  if (!items.length) return { x: 0, y: 0 };
  return {
    x: items.reduce((sum, item) => sum + item.x, 0) / items.length,
    y: items.reduce((sum, item) => sum + item.y, 0) / items.length
  };
}

function pointerDistance(points) {
  const items = [...points.values()];
  if (items.length < 2) return 0;
  return Math.hypot(items[0].x - items[1].x, items[0].y - items[1].y);
}

function startTwoFingerGesture() {
  const center = pointerCenter(activePointers);
  gesture = {
    type: "undecided",
    startCenter: center,
    lastCenter: center,
    startDistance: Math.max(1, pointerDistance(activePointers)),
    startZoom: view.zoom,
    startPanX: view.panX,
    startPanY: view.panY
  };

  if (touchAction?.dragging) {
    sendControl({ kind: "mouse", action: "up", button: "left" });
  }
  touchAction = null;
}

function updateTwoFingerGesture() {
  if (!gesture || activePointers.size < 2) return;
  const center = pointerCenter(activePointers);
  const distance = Math.max(1, pointerDistance(activePointers));
  const scaleChange = distance / gesture.startDistance;
  const centerMoveY = center.y - gesture.startCenter.y;
  const centerMoveX = center.x - gesture.startCenter.x;

  if (gesture.type === "undecided") {
    if (Math.abs(scaleChange - 1) > 0.045) gesture.type = "pinch";
    else if (Math.hypot(centerMoveX, centerMoveY) > 10) {
      gesture.type = interactionMode === "trackpad" ? "scroll" : "pinch";
    } else {
      return;
    }
  }

  if (gesture.type === "scroll") {
    const dy = center.y - gesture.lastCenter.y;
    if (Math.abs(dy) >= 1) sendControl({ kind: "wheel", dy: -dy * 2.2 });
    gesture.lastCenter = center;
    return;
  }

  const nextZoom = clamp(gesture.startZoom * scaleChange, 0.5, 4);
  const stageRect = els.remoteStage.getBoundingClientRect();
  const stageCenterX = stageRect.width / 2;
  const stageCenterY = stageRect.height / 2;
  const startFocusX = gesture.startCenter.x - stageRect.left;
  const startFocusY = gesture.startCenter.y - stageRect.top;
  const currentFocusX = center.x - stageRect.left;
  const currentFocusY = center.y - stageRect.top;
  const ratio = nextZoom / gesture.startZoom;

  view.zoom = nextZoom;
  view.panX = currentFocusX - stageCenterX - ratio * (startFocusX - stageCenterX - gesture.startPanX);
  view.panY = currentFocusY - stageCenterY - ratio * (startFocusY - stageCenterY - gesture.startPanY);
  clampPan();
  applyViewTransform();
}

function handlePointerDown(event) {
  if (!sessionActive) return;
  if (event.target.closest(".session-topbar, .session-dock, .control-drawer, .zoom-hud")) return;

  els.remoteStage.setPointerCapture?.(event.pointerId);
  els.remoteStage.focus({ preventScroll: true });
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });

  if (event.pointerType !== "touch") {
    if (interactionMode === "pan") {
      touchAction = { mode: "pan", lastX: event.clientX, lastY: event.clientY };
    } else {
      const point = videoPoint(event.clientX, event.clientY);
      if (point) {
        remoteCursor = point;
        sendControl({ kind: "move", ...point });
      }
      touchAction = {
        mode: "mouse-direct",
        button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left"
      };
      sendControl({
        kind: "mouse",
        action: "down",
        button: touchAction.button
      });
    }
    event.preventDefault();
    return;
  }

  if (activePointers.size === 2) {
    startTwoFingerGesture();
    event.preventDefault();
    return;
  }

  if (interactionMode === "pan") {
    touchAction = { mode: "pan", lastX: event.clientX, lastY: event.clientY };
  } else if (interactionMode === "trackpad") {
    touchAction = {
      mode: "trackpad",
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false
    };
  } else {
    const point = videoPoint(event.clientX, event.clientY);
    if (point) {
      remoteCursor = point;
      sendControl({ kind: "move", ...point });
    }
    touchAction = {
      mode: "direct",
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      dragging: false
    };
  }
  event.preventDefault();
}

function handlePointerMove(event) {
  if (!activePointers.has(event.pointerId)) {
    if (event.pointerType === "mouse" && sessionActive && interactionMode !== "pan" && !pointerMoveFrame) {
      const point = videoPoint(event.clientX, event.clientY);
      if (!point) return;
      pointerMoveFrame = requestAnimationFrame(() => {
        pointerMoveFrame = 0;
        remoteCursor = point;
        sendControl({ kind: "move", ...point });
      });
    }
    return;
  }

  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });

  if (activePointers.size >= 2) {
    updateTwoFingerGesture();
    event.preventDefault();
    return;
  }

  if (!touchAction) return;

  if (touchAction.mode === "pan") {
    view.panX += event.clientX - touchAction.lastX;
    view.panY += event.clientY - touchAction.lastY;
    touchAction.lastX = event.clientX;
    touchAction.lastY = event.clientY;
    clampPan();
    applyViewTransform();
    event.preventDefault();
    return;
  }

  if (touchAction.mode === "mouse-direct") {
    const point = videoPoint(event.clientX, event.clientY);
    if (point) {
      remoteCursor = point;
      sendControl({ kind: "move", ...point });
    }
    event.preventDefault();
    return;
  }

  if (touchAction.mode === "trackpad") {
    const dx = event.clientX - touchAction.lastX;
    const dy = event.clientY - touchAction.lastY;
    touchAction.lastX = event.clientX;
    touchAction.lastY = event.clientY;
    if (Math.hypot(event.clientX - touchAction.startX, event.clientY - touchAction.startY) > 5) touchAction.moved = true;

    const rect = els.videoSurface.getBoundingClientRect();
    const sensitivity = 1.25;
    remoteCursor.x = clamp(remoteCursor.x + (dx / Math.max(1, rect.width)) * sensitivity, 0, 1);
    remoteCursor.y = clamp(remoteCursor.y + (dy / Math.max(1, rect.height)) * sensitivity, 0, 1);
    sendControl({ kind: "move", ...remoteCursor });
    event.preventDefault();
    return;
  }

  if (touchAction.mode === "direct") {
    const distance = Math.hypot(event.clientX - touchAction.startX, event.clientY - touchAction.startY);
    const point = videoPoint(event.clientX, event.clientY);
    if (point) {
      remoteCursor = point;
      if (distance > 7 && !touchAction.dragging) {
        touchAction.dragging = true;
        touchAction.moved = true;
        sendControl({ kind: "mouse", action: "down", button: "left" });
      }
      sendControl({ kind: "move", ...point });
    }
    event.preventDefault();
  }
}

function handlePointerUp(event) {
  const wasTracked = activePointers.has(event.pointerId);
  activePointers.delete(event.pointerId);

  if (!wasTracked) return;

  if (activePointers.size >= 1 && gesture) {
    gesture = null;
    touchAction = null;
    event.preventDefault();
    return;
  }

  if (gesture) {
    gesture = null;
    touchAction = null;
    event.preventDefault();
    return;
  }

  if (event.pointerType !== "touch") {
    if (interactionMode !== "pan") {
      sendControl({
        kind: "mouse",
        action: "up",
        button: touchAction?.button || (event.button === 2 ? "right" : event.button === 1 ? "middle" : "left")
      });
    }
    touchAction = null;
    event.preventDefault();
    return;
  }

  if (touchAction?.mode === "direct") {
    if (touchAction.dragging) {
      sendControl({ kind: "mouse", action: "up", button: "left" });
    } else {
      const point = videoPoint(event.clientX, event.clientY);
      if (point) {
        remoteCursor = point;
        sendControl({ kind: "move", ...point });
        sendMouseClick("left");
      }
    }
  } else if (touchAction?.mode === "trackpad" && !touchAction.moved) {
    sendMouseClick("left");
  }

  touchAction = null;
  event.preventDefault();
}

function handlePointerCancel(event) {
  if (touchAction?.dragging) sendControl({ kind: "mouse", action: "up", button: "left" });
  activePointers.delete(event.pointerId);
  touchAction = null;
  gesture = null;
}

/* Drawer */
function openDrawer(name) {
  drawerName = name;
  els.controlDrawer.classList.remove("hidden");
  els.keyboardPanel.classList.toggle("hidden", name !== "keyboard");
  els.shortcutsPanel.classList.toggle("hidden", name !== "shortcuts");
  els.viewPanel.classList.toggle("hidden", name !== "view");

  const copy = {
    keyboard: ["Keyboard", "Type and send special keys"],
    shortcuts: ["Shortcuts", "Common Windows and app key combinations"],
    view: ["View & controls", "Zoom, fit, gestures and pointer mode"]
  };
  els.drawerTitle.textContent = copy[name][0];
  els.drawerSubtitle.textContent = copy[name][1];

  els.keyboardBtn.classList.toggle("active", name === "keyboard");
  els.shortcutsBtn.classList.toggle("active", name === "shortcuts");
  els.viewBtn.classList.toggle("active", name === "view");

  if (name === "keyboard") {
    setTimeout(() => els.mobileKeyboard.focus({ preventScroll: true }), 60);
  }
}

function closeDrawer() {
  drawerName = "";
  els.controlDrawer.classList.add("hidden");
  els.keyboardBtn.classList.remove("active");
  els.shortcutsBtn.classList.remove("active");
  els.viewBtn.classList.remove("active");
  els.mobileKeyboard.blur();
}

/* Events */
els.remoteVideo.addEventListener("loadedmetadata", updateVideoGeometry);
window.addEventListener("resize", () => requestAnimationFrame(updateVideoGeometry));
window.addEventListener("orientationchange", () => setTimeout(updateVideoGeometry, 200));

els.remoteStage.addEventListener("pointerdown", handlePointerDown);
els.remoteStage.addEventListener("pointermove", handlePointerMove);
els.remoteStage.addEventListener("pointerup", handlePointerUp);
els.remoteStage.addEventListener("pointercancel", handlePointerCancel);
els.remoteStage.addEventListener("contextmenu", event => event.preventDefault());

els.remoteStage.addEventListener("wheel", event => {
  if (!sessionActive) return;
  if (event.ctrlKey || event.metaKey) {
    zoomBy(event.deltaY < 0 ? 0.15 : -0.15, event.clientX, event.clientY);
  } else if (interactionMode === "pan" && view.zoom > 1) {
    view.panX -= event.deltaX;
    view.panY -= event.deltaY;
    clampPan();
    applyViewTransform();
  } else {
    sendControl({ kind: "wheel", dy: event.deltaY });
  }
  event.preventDefault();
}, { passive: false });

function keyboardHandler(event) {
  if (!sessionActive) return;
  if (document.activeElement === els.mobileKeyboard) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (event.repeat && event.type === "keyup") return;

  sendKey(event.type === "keydown" ? "down" : "up", event.key, event.code);

  if (["Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
    event.preventDefault();
  }
}
document.addEventListener("keydown", keyboardHandler);
document.addEventListener("keyup", keyboardHandler);

els.mobileKeyboard.addEventListener("input", () => {
  const value = els.mobileKeyboard.value;
  if (value) {
    sendControl({ kind: "text", text: value });
    els.mobileKeyboard.value = "";
  }
});
els.mobileKeyboard.addEventListener("keydown", event => {
  if (event.key === "Backspace") {
    tapKey("Backspace", "Backspace");
    event.preventDefault();
  } else if (event.key === "Enter") {
    tapKey("Enter", "Enter");
    event.preventDefault();
  } else if (event.key === "Tab") {
    tapKey("Tab", "Tab");
    event.preventDefault();
  }
});

$$(".key-button[data-key]").forEach(button => {
  button.addEventListener("click", () => tapKey(button.dataset.key, button.dataset.code || button.dataset.key));
});

$$(".modifier-key").forEach(button => {
  button.addEventListener("click", () => {
    const code = button.dataset.modifier;
    const def = keyDefinitions[code];
    if (!def) return;

    if (heldModifiers.has(code)) {
      heldModifiers.delete(code);
      sendKey("up", def.key, def.code);
      button.classList.remove("active");
    } else {
      heldModifiers.add(code);
      sendKey("down", def.key, def.code);
      button.classList.add("active");
    }
  });
});

els.releaseModifiersBtn.addEventListener("click", releaseAllModifiers);

$$(".shortcut-button[data-combo]").forEach(button => {
  button.addEventListener("click", () => {
    const sequence = shortcutMap[button.dataset.combo];
    if (sequence) sendCombo(sequence);
  });
});

els.modeBtn.addEventListener("click", cycleInteractionMode);
$$(".interaction-option").forEach(button => {
  button.addEventListener("click", () => setInteractionMode(button.dataset.mode));
});

els.leftClickBtn.addEventListener("click", () => sendMouseClick("left"));
els.rightClickBtn.addEventListener("click", () => sendMouseClick("right"));

els.keyboardBtn.addEventListener("click", () => drawerName === "keyboard" ? closeDrawer() : openDrawer("keyboard"));
els.shortcutsBtn.addEventListener("click", () => drawerName === "shortcuts" ? closeDrawer() : openDrawer("shortcuts"));
els.viewBtn.addEventListener("click", () => drawerName === "view" ? closeDrawer() : openDrawer("view"));
els.drawerCloseBtn.addEventListener("click", closeDrawer);

els.zoomOutBtn.addEventListener("click", () => zoomBy(-0.2));
els.zoomInBtn.addEventListener("click", () => zoomBy(0.2));
els.zoomValueBtn.addEventListener("click", () => {
  view.panX = 0;
  view.panY = 0;
  setZoom(1);
});
els.drawerZoomOutBtn.addEventListener("click", () => zoomBy(-0.2));
els.drawerZoomInBtn.addEventListener("click", () => zoomBy(0.2));
els.zoomRange.addEventListener("input", () => setZoom(Number(els.zoomRange.value) / 100));

els.fitBtn.addEventListener("click", () => {
  view.panX = 0;
  view.panY = 0;
  setZoom(1);
});
els.fillBtn.addEventListener("click", fillView);
els.actualSizeBtn.addEventListener("click", actualSizeView);
els.centerViewBtn.addEventListener("click", () => {
  view.panX = 0;
  view.panY = 0;
  applyViewTransform();
});

els.hideControlsBtn.addEventListener("click", () => setControlsHidden(true));
els.immersiveRestoreBtn.addEventListener("click", async () => {
  if (immersiveMode) await setImmersiveMode(false);
  else setControlsHidden(false);
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && immersiveMode) {
    immersiveMode = false;
    document.body.classList.remove("remote-immersive");
    document.body.classList.remove("remote-controls-hidden");
    controlsHidden = false;
    requestAnimationFrame(updateVideoGeometry);
  }
});

els.clipboardBtn.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = window.prompt("Paste text to send to the remote clipboard:") || "";
  }
  if (text) {
    sendControl({ kind: "clipboard", text: text.slice(0, 100000) });
    setSessionStatus("Clipboard sent", true);
    setTimeout(() => setSessionStatus("Live", true), 1200);
  }
});

els.fullscreenBtn.addEventListener("click", async () => {
  await setImmersiveMode(!immersiveMode);
});

els.orientationBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await els.remoteView.requestFullscreen();
    const portrait = window.matchMedia("(orientation: portrait)").matches;
    await screen.orientation?.lock?.(portrait ? "landscape" : "portrait");
  } catch {
    setSessionStatus("Rotate device manually", sessionActive);
    setTimeout(() => setSessionStatus(sessionActive ? "Live" : "Connecting", sessionActive), 1500);
  }
});

function endSession() {
  sendWs({ type: "session-end" });
  try { ws?.close(); } catch {}
  showConnect("Session ended", "idle");
}
els.stopBtn.addEventListener("click", endSession);
els.backBtn.addEventListener("click", endSession);

window.addEventListener("popstate", () => {
  if (document.body.classList.contains("remote-active")) endSession();
});

els.saveSettings.addEventListener("click", saveSettings);

els.pin.addEventListener("input", () => {
  const digits = els.pin.value.replace(/\D/g, "").slice(0, 6);
  els.pin.value = digits.length > 3 ? digits.slice(0, 3) + " " + digits.slice(3) : digits;
});

els.connectForm.addEventListener("submit", event => {
  event.preventDefault();
  const pin = els.pin.value.replace(/\D/g, "");
  if (pin.length !== 6) {
    setStatus("Enter 6-digit PIN", "error");
    return;
  }
  connectWithPin(pin);
});

renderTrustedHosts();
setInteractionMode("direct");
resetView();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
}
