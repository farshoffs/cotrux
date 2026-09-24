const $ = selector => document.querySelector(selector);

const els = {
  statePill: $("#statePill"),
  stateText: $("#stateText"),
  pin: $("#pin"),
  newPinBtn: $("#newPinBtn"),
  copyPinBtn: $("#copyPinBtn"),
  requestCard: $("#requestCard"),
  requestName: $("#requestName"),
  rejectBtn: $("#rejectBtn"),
  acceptBtn: $("#acceptBtn"),
  sessionCard: $("#sessionCard"),
  preview: $("#preview"),
  stopBtn: $("#stopBtn"),
  signalUrl: $("#signalUrl"),
  reconnectBtn: $("#reconnectBtn"),
  turnUrl: $("#turnUrl"),
  turnUser: $("#turnUser"),
  turnPass: $("#turnPass"),
  saveAdvancedBtn: $("#saveAdvancedBtn")
};

let ws;
let pc;
let controlChannel;
let captureStream;
let currentPin = "";
let pendingRequestId = "";
let pendingCandidates = [];
let sessionActive = false;

const settings = JSON.parse(localStorage.getItem("cotrux.agent.settings") || "{}");
const deviceId = localStorage.getItem("cotrux.deviceId") || crypto.randomUUID();
localStorage.setItem("cotrux.deviceId", deviceId);

els.signalUrl.value = settings.signalUrl || "ws://localhost:8787/ws";
els.turnUrl.value = settings.turnUrl || "";
els.turnUser.value = settings.turnUser || "";
els.turnPass.value = settings.turnPass || "";

function generatePin() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1000000).padStart(6, "0");
}

function setState(text, state = "idle") {
  els.stateText.textContent = text;
  els.statePill.dataset.state = state;
}

function saveSettings() {
  localStorage.setItem("cotrux.agent.settings", JSON.stringify({
    signalUrl: els.signalUrl.value.trim(),
    turnUrl: els.turnUrl.value.trim(),
    turnUser: els.turnUser.value.trim(),
    turnPass: els.turnPass.value
  }));
  setState("Settings saved", "ready");
}

function getIceServers() {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = els.turnUrl.value.trim();
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: els.turnUser.value.trim(),
      credential: els.turnPass.value
    });
  }
  return servers;
}

function sendWs(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function registerHost() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  sendWs({
    type: "host-register",
    pin: currentPin,
    deviceId,
    name: navigator.platform || "Cotrux computer"
  });
}

function renderPin() {
  els.pin.textContent = currentPin.slice(0, 3) + " " + currentPin.slice(3);
}

function newPin() {
  if (sessionActive) return;
  currentPin = generatePin();
  renderPin();
  registerHost();
}

function connectSignal() {
  saveSettings();
  teardownPeer();

  try { ws?.close(); } catch {}

  const url = els.signalUrl.value.trim();
  if (!url) {
    setState("Add signaling URL", "error");
    return;
  }

  setState("Connecting", "pending");

  try {
    ws = new WebSocket(url);
  } catch {
    setState("Bad signaling URL", "error");
    return;
  }

  ws.onopen = () => {
    setState("Online", "ready");
    registerHost();
  };

  ws.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "host-registered") {
      setState("Ready", "ready");
      return;
    }

    if (msg.type === "controller-request") {
      if (sessionActive) {
        sendWs({ type: "host-reject", requestId: msg.requestId });
        return;
      }
      pendingRequestId = msg.requestId;
      els.requestName.textContent = msg.controllerName || "Cotrux controller";
      els.requestCard.classList.remove("hidden");
      setState("Approval needed", "pending");
      return;
    }

    if (msg.type === "paired") {
      els.requestCard.classList.add("hidden");
      pendingRequestId = "";
      try {
        await startSession();
      } catch (error) {
        console.error(error);
        setState("Screen share failed", "error");
        sendWs({ type: "session-end" });
      }
      return;
    }

    if (msg.type === "signal") {
      try {
        await handleSignal(msg.data || {});
      } catch (error) {
        console.error(error);
        setState("WebRTC error", "error");
      }
      return;
    }

    if (["peer-left", "session-ended"].includes(msg.type)) {
      stopSession(false);
      return;
    }

    if (msg.type === "error") {
      if (msg.code === "PIN_IN_USE") {
        currentPin = generatePin();
        renderPin();
        registerHost();
      } else {
        setState(msg.code || "Signal error", "error");
      }
    }
  };

  ws.onerror = () => setState("Signal offline", "error");
  ws.onclose = () => {
    if (!sessionActive) setState("Offline", "error");
  };
}

async function createPeer() {
  if (pc) {
    try { pc.close(); } catch {}
  }

  pc = new RTCPeerConnection({ iceServers: getIceServers() });
  pendingCandidates = [];

  pc.onicecandidate = event => {
    if (event.candidate) sendWs({ type: "signal", data: { candidate: event.candidate } });
  };

  pc.onconnectionstatechange = () => {
    const state = pc?.connectionState;
    if (state === "connected") {
      sessionActive = true;
      setState("Live", "live");
    } else if (state === "failed") {
      setState("Peer failed", "error");
    }
  };

  controlChannel = pc.createDataChannel("control", { ordered: true });
  controlChannel.onopen = () => {
    sessionActive = true;
    setState("Live", "live");
  };
  controlChannel.onmessage = async event => {
    try {
      const payload = JSON.parse(event.data);
      await window.cotrux.control(payload);
    } catch (error) {
      console.error("Invalid control message", error);
    }
  };

  return pc;
}

async function prepareCapture() {
  if (captureStream?.active) return captureStream;

  captureStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 60 }
    },
    audio: false
  });

  captureStream.getVideoTracks()[0]?.addEventListener("ended", () => stopSession(true));
  els.preview.srcObject = captureStream;
  return captureStream;
}

async function startSession() {
  await createPeer();
  await prepareCapture();

  for (const track of captureStream.getTracks()) {
    pc.addTrack(track, captureStream);
  }

  els.sessionCard.classList.remove("hidden");
  els.newPinBtn.disabled = true;
  setState("Negotiating", "pending");

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({ type: "signal", data: { description: pc.localDescription } });
}

async function handleSignal(data) {
  if (!pc) return;

  if (data.description) {
    await pc.setRemoteDescription(data.description);
    while (pendingCandidates.length) {
      await pc.addIceCandidate(pendingCandidates.shift());
    }
    return;
  }

  if (data.candidate) {
    if (!pc.remoteDescription) pendingCandidates.push(data.candidate);
    else await pc.addIceCandidate(data.candidate);
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

  if (captureStream) {
    for (const track of captureStream.getTracks()) track.stop();
  }
  captureStream = null;
  els.preview.srcObject = null;
  pendingCandidates = [];
}

function stopSession(notify = true) {
  if (notify) sendWs({ type: "session-end" });
  teardownPeer();
  els.sessionCard.classList.add("hidden");
  els.requestCard.classList.add("hidden");
  els.newPinBtn.disabled = false;
  setState(ws?.readyState === WebSocket.OPEN ? "Ready" : "Offline", ws?.readyState === WebSocket.OPEN ? "ready" : "error");

  currentPin = generatePin();
  renderPin();
  registerHost();
}

els.acceptBtn.addEventListener("click", async () => {
  if (!pendingRequestId) return;

  const requestId = pendingRequestId;
  els.acceptBtn.disabled = true;
  setState("Preparing share", "pending");

  try {
    await prepareCapture();
    sendWs({ type: "host-accept", requestId });
  } catch (error) {
    console.error("Screen capture cancelled", error);
    sendWs({ type: "host-reject", requestId });
    pendingRequestId = "";
    els.requestCard.classList.add("hidden");
    setState("Ready", "ready");
  } finally {
    els.acceptBtn.disabled = false;
  }
});

els.rejectBtn.addEventListener("click", () => {
  if (!pendingRequestId) return;
  sendWs({ type: "host-reject", requestId: pendingRequestId });
  pendingRequestId = "";
  els.requestCard.classList.add("hidden");
  setState("Ready", "ready");
});

els.stopBtn.addEventListener("click", () => stopSession(true));
els.newPinBtn.addEventListener("click", newPin);
els.copyPinBtn.addEventListener("click", async () => {
  await window.cotrux.control({ kind: "clipboard", text: currentPin });
  setState("PIN copied", "ready");
});
els.reconnectBtn.addEventListener("click", connectSignal);
els.saveAdvancedBtn.addEventListener("click", saveSettings);

window.addEventListener("beforeunload", () => {
  try { sendWs({ type: "session-end" }); } catch {}
  teardownPeer();
});

currentPin = generatePin();
renderPin();
connectSignal();
