const $ = selector => document.querySelector(selector);

const els = {
  connectView: $("#connectView"),
  remoteView: $("#remoteView"),
  connectForm: $("#connectForm"),
  pin: $("#pin"),
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
let currentPin = "";
let pointerMoveTimer = 0;
let sessionActive = false;

const saved = JSON.parse(localStorage.getItem("cotrux.controller.settings") || "{}");
const isGitHubPages = location.hostname.endsWith(".github.io");
const sameOriginSignal =
  !isGitHubPages && (location.protocol === "http:" || location.protocol === "https:")
    ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws"
    : "ws://localhost:8787/ws";
els.signalUrl.value = saved.signalUrl || sameOriginSignal;
els.turnUrl.value = saved.turnUrl || "";
els.turnUser.value = saved.turnUser || "";
els.turnPass.value = saved.turnPass || "";

function setStatus(text, state = "idle") {
  els.statusText.textContent = text;
  els.statusPill.dataset.state = state;
}

function saveSettings() {
  const settings = {
    signalUrl: els.signalUrl.value.trim(),
    turnUrl: els.turnUrl.value.trim(),
    turnUser: els.turnUser.value.trim(),
    turnPass: els.turnPass.value
  };
  localStorage.setItem("cotrux.controller.settings", JSON.stringify(settings));
  setStatus("Settings saved", "idle");
  return settings;
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
  els.remoteView.classList.add("hidden");
  els.connectView.classList.remove("hidden");
  setStatus(message, state);
}

function showRemote(hostName = "Remote computer") {
  els.connectView.classList.add("hidden");
  els.remoteView.classList.remove("hidden");
  els.hostName.textContent = hostName;
  els.connectionInfo.textContent = "Negotiating encrypted WebRTC session…";
  setStatus("Connecting", "pending");
}

async function createPeer() {
  teardownPeer();
  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.onicecandidate = event => {
    if (event.candidate) {
      sendWs({ type: "signal", data: { candidate: event.candidate } });
    }
  };

  pc.ontrack = event => {
    const [stream] = event.streams;
    if (stream) {
      els.remoteVideo.srcObject = stream;
      els.emptyScreen.classList.add("hidden");
      els.connectionInfo.textContent = "Live desktop · end-to-end WebRTC";
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
      els.connectionInfo.textContent = "Live desktop · controls active";
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
    els.connectionInfo.textContent = "Live desktop · controls active";
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

function connectToHost(pin) {
  const url = els.signalUrl.value.trim();
  if (!url) {
    setStatus("Add signaling URL", "error");
    els.signalUrl.focus();
    return;
  }

  saveSettings();
  currentPin = pin;
  setStatus("Connecting to service", "pending");

  if (ws) {
    try { ws.close(); } catch {}
  }

  try {
    ws = new WebSocket(url);
  } catch {
    setStatus("Invalid signaling URL", "error");
    return;
  }

  ws.onopen = () => {
    setStatus("Requesting host approval", "pending");
    sendWs({
      type: "controller-join",
      pin,
      name: navigator.userAgent.includes("iPhone") ? "Cotrux on iPhone" : "Cotrux web controller"
    });
  };

  ws.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "pending") {
      setStatus("Awaiting approval", "pending");
      return;
    }

    if (msg.type === "paired") {
      showRemote(msg.hostName || "Remote computer");
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
        BAD_PIN: "Invalid PIN"
      };
      showConnect(errors[msg.code] || "Connection error", "error");
    }
  };

  ws.onerror = () => setStatus("Signaling connection failed", "error");
  ws.onclose = () => {
    if (!sessionActive && !els.remoteView.classList.contains("hidden")) {
      setStatus("Service disconnected", "error");
    }
  };
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
  connectToHost(pin);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.error));
}
