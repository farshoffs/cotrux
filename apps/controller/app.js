const $ = selector => document.querySelector(selector);
const DEFAULT_SIGNAL_URL = "wss://cotrux-production.up.railway.app/ws";

const els = {
  connectView: $("#connectView"),
  remoteView: $("#remoteView"),
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
  hostName: $("#hostName"),
  connectionInfo: $("#connectionInfo"),
  screenFrame: $("#screenFrame"),
  remoteVideo: $("#remoteVideo"),
  emptyScreen: $("#emptyScreen"),
  keyboardBtn: $("#keyboardBtn"),
  mobileKeyboard: $("#mobileKeyboard"),
  clipboardBtn: $("#clipboardBtn"),
  fullscreenBtn: $("#fullscreenBtn"),
  stopBtn: $("#stopBtn")
};

let ws;
let pc;
let controlChannel;
let pendingCandidates = [];
let pointerMoveTimer = 0;
let sessionActive = false;
let currentConnection = null;

const controllerId = localStorage.getItem("cotrux.controllerId") || crypto.randomUUID();
localStorage.setItem("cotrux.controllerId", controllerId);

const saved = JSON.parse(localStorage.getItem("cotrux.controller.settings") || "{}");
els.signalUrl.value = saved.signalUrl || DEFAULT_SIGNAL_URL;
els.turnUrl.value = saved.turnUrl || "";
els.turnUser.value = saved.turnUser || "";
els.turnPass.value = saved.turnPass || "";

function setStatus(text, state = "idle") {
  els.statusText.textContent = text;
  els.statusPill.dataset.state = state;
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

function teardownPeer() {
  sessionActive = false;
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
}

function showConnect(message = "Ready", state = "idle") {
  teardownPeer();
  currentConnection = null;
  els.remoteView.classList.add("hidden");
  els.connectView.classList.remove("hidden");
  setStatus(message, state);
}

function showRemote(hostName = "Remote computer", unattended = false) {
  els.connectView.classList.add("hidden");
  els.remoteView.classList.remove("hidden");
  els.hostName.textContent = hostName;
  els.connectionInfo.textContent = unattended
    ? "Trusted connection · preparing encrypted session…"
    : "Preparing encrypted WebRTC session…";
  setStatus("Connecting", "pending");
}

async function createPeer() {
  teardownPeer();
  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.onicecandidate = event => {
    if (event.candidate) sendWs({ type: "signal", data: { candidate: event.candidate } });
  };

  pc.ontrack = event => {
    const [stream] = event.streams;
    if (stream) {
      els.remoteVideo.srcObject = stream;
      els.emptyScreen.classList.add("hidden");
      els.connectionInfo.textContent = currentConnection?.unattended
        ? "Live desktop · trusted access"
        : "Live desktop · controls active";
    }
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
      els.connectionInfo.textContent = currentConnection?.unattended
        ? "Live desktop · trusted access"
        : "Live desktop · controls active";
      els.screenFrame.focus();
    } else if (["failed", "disconnected"].includes(state)) {
      setStatus("Connection lost", "error");
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
    els.connectionInfo.textContent = currentConnection?.unattended
      ? "Live desktop · trusted access"
      : "Live desktop · controls active";
  };

  controlChannel.onmessage = event => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload?.kind === "cotrux-trust-grant") {
      storeTrustedHost(payload);
    }
  };

  controlChannel.onclose = () => {
    sessionActive = false;
    setStatus("Control closed", "error");
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
  const url = (els.signalUrl.value.trim() || DEFAULT_SIGNAL_URL);
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

      if (["TRUST_DISABLED", "TRUST_INVALID"].includes(msg.code) && currentConnection?.deviceId) {
        setStatus(errors[msg.code], "error");
        els.remoteView.classList.add("hidden");
        els.connectView.classList.remove("hidden");
        return;
      }

      showConnect(errors[msg.code] || "Connection error", "error");
    }
  };

  ws.onerror = () => setStatus("Cotrux service connection failed", "error");
  ws.onclose = () => {
    if (!sessionActive && !els.remoteView.classList.contains("hidden")) {
      setStatus("Service disconnected", "error");
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

function videoPoint(clientX, clientY) {
  const rect = els.remoteVideo.getBoundingClientRect();
  const vw = els.remoteVideo.videoWidth || 16;
  const vh = els.remoteVideo.videoHeight || 9;
  const boxRatio = rect.width / rect.height;
  const videoRatio = vw / vh;

  let shownWidth = rect.width;
  let shownHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (boxRatio > videoRatio) {
    shownWidth = rect.height * videoRatio;
    offsetX = (rect.width - shownWidth) / 2;
  } else {
    shownHeight = rect.width / videoRatio;
    offsetY = (rect.height - shownHeight) / 2;
  }

  const x = (clientX - rect.left - offsetX) / shownWidth;
  const y = (clientY - rect.top - offsetY) / shownHeight;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function pointerMove(event) {
  if (!sessionActive || pointerMoveTimer) return;
  const point = videoPoint(event.clientX, event.clientY);
  if (!point) return;

  pointerMoveTimer = requestAnimationFrame(() => {
    pointerMoveTimer = 0;
    sendControl({ kind: "move", ...point });
  });
}

els.screenFrame.addEventListener("pointermove", pointerMove);
els.screenFrame.addEventListener("pointerdown", event => {
  if (!sessionActive) return;
  els.screenFrame.setPointerCapture?.(event.pointerId);
  els.screenFrame.focus();
  const point = videoPoint(event.clientX, event.clientY);
  if (point) sendControl({ kind: "move", ...point });
  sendControl({
    kind: "mouse",
    action: "down",
    button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left"
  });
  event.preventDefault();
});

els.screenFrame.addEventListener("pointerup", event => {
  if (!sessionActive) return;
  sendControl({
    kind: "mouse",
    action: "up",
    button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left"
  });
  event.preventDefault();
});

els.screenFrame.addEventListener("contextmenu", event => event.preventDefault());
els.screenFrame.addEventListener("wheel", event => {
  if (!sessionActive) return;
  sendControl({ kind: "wheel", dy: event.deltaY });
  event.preventDefault();
}, { passive: false });

function keyboardHandler(event) {
  if (!sessionActive || document.activeElement === els.mobileKeyboard) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" && document.activeElement !== els.screenFrame) return;

  sendControl({
    kind: "key",
    action: event.type === "keydown" ? "down" : "up",
    key: event.key,
    code: event.code
  });

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
  if (event.key === "Backspace") sendControl({ kind: "key", action: "tap", key: "Backspace", code: "Backspace" });
  if (event.key === "Enter") sendControl({ kind: "key", action: "tap", key: "Enter", code: "Enter" });
});

els.keyboardBtn.addEventListener("click", () => els.mobileKeyboard.focus());

els.clipboardBtn.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = window.prompt("Paste text to send to the remote clipboard:") || "";
  }
  if (text) {
    sendControl({ kind: "clipboard", text: text.slice(0, 100000) });
    setStatus("Clipboard sent", "connected");
  }
});

els.fullscreenBtn.addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await els.screenFrame.requestFullscreen();
    else await document.exitFullscreen();
  } catch {}
});

els.stopBtn.addEventListener("click", () => {
  sendWs({ type: "session-end" });
  try { ws?.close(); } catch {}
  showConnect("Session ended", "idle");
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
}
