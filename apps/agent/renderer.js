const $ = selector => document.querySelector(selector);

const els = {
  statePill: $("#statePill"),
  stateText: $("#stateText"),
  computerName: $("#computerName"),
  workspaceCard: $("#workspaceCard"),
  workspaceBadge: $("#workspaceBadge"),
  workspaceReady: $("#workspaceReady"),
  workspaceSetup: $("#workspaceSetup"),
  workspaceRequirement: $("#workspaceRequirement"),
  workspaceStateText: $("#workspaceStateText"),
  workspaceDataPath: $("#workspaceDataPath"),
  workspaceIsoTools: $("#workspaceIsoTools"),
  workspaceIsoName: $("#workspaceIsoName"),
  startWorkspaceBtn: $("#startWorkspaceBtn"),
  resumeWorkspaceBtn: $("#resumeWorkspaceBtn"),
  chooseWorkspaceIsoBtn: $("#chooseWorkspaceIsoBtn"),
  downloadWindowsBtn: $("#downloadWindowsBtn"),
  openWorkspaceBtn: $("#openWorkspaceBtn"),
  repairWorkspaceBootBtn: $("#repairWorkspaceBootBtn"),
  stopWorkspaceBtn: $("#stopWorkspaceBtn"),
  windowsFeaturesBtn: $("#windowsFeaturesBtn"),
  workspaceProvision: $("#workspaceProvision"),
  workspaceProvisionTitle: $("#workspaceProvisionTitle"),
  workspaceProvisionText: $("#workspaceProvisionText"),
  workspaceProvisionBadge: $("#workspaceProvisionBadge"),
  workspaceGuestUser: $("#workspaceGuestUser"),
  workspaceGuestPass: $("#workspaceGuestPass"),
  provisionWorkspaceBtn: $("#provisionWorkspaceBtn"),
  prepareGuestSetupBtn: $("#prepareGuestSetupBtn"),
  workspacePairing: $("#workspacePairing"),
  workspacePairingPin: $("#workspacePairingPin"),
  accessCard: $("#accessCard"),
  pin: $("#pin"),
  newPinBtn: $("#newPinBtn"),
  copyPinBtn: $("#copyPinBtn"),
  unattendedToggle: $("#unattendedToggle"),
  startupToggle: $("#startupToggle"),
  trustedSummary: $("#trustedSummary"),
  trustedList: $("#trustedList"),
  revokeAllBtn: $("#revokeAllBtn"),
  requestCard: $("#requestCard"),
  requestName: $("#requestName"),
  trustRequestRow: $("#trustRequestRow"),
  trustRequest: $("#trustRequest"),
  rejectBtn: $("#rejectBtn"),
  acceptBtn: $("#acceptBtn"),
  sessionCard: $("#sessionCard"),
  sessionTitle: $("#sessionTitle"),
  sessionText: $("#sessionText"),
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
let reconnectTimer;
let workspacePollTimer;
let currentPin = "";
let pendingRequestId = "";
let pendingControllerId = "";
let pendingControllerName = "";
let pendingCandidates = [];
let sessionActive = false;
let shuttingDown = false;
let config;
let pendingTrustGrant = null;

function generatePin() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1000000).padStart(6, "0");
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function setState(text, state = "idle") {
  els.stateText.textContent = text;
  els.statePill.dataset.state = state;
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

function syncHostSettings() {
  sendWs({
    type: "host-settings",
    unattendedEnabled: config.unattendedEnabled,
    trustedDevices: config.trustedDevices
  });
}

function registerHost() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  sendWs({
    type: "host-register",
    pin: currentPin,
    deviceId: config.deviceId,
    name: config.computerName || "Cotrux computer",
    unattendedEnabled: config.unattendedEnabled,
    trustedDevices: config.trustedDevices
  });
}

function renderPin() {
  els.pin.textContent = currentPin.slice(0, 3) + " " + currentPin.slice(3);
}

async function rotatePin() {
  currentPin = generatePin();
  renderPin();

  if (config.backgroundWorkspace) {
    config = {
      ...config,
      ...(await window.cotrux.saveConfig({ pairingPin: currentPin }))
    };
  }

  registerHost();
}

function renderTrustedDevices() {
  const devices = config.trustedDevices || [];
  els.trustedSummary.textContent = devices.length ? devices.length + (devices.length === 1 ? " trusted device" : " trusted devices") : "None yet";
  els.revokeAllBtn.disabled = devices.length === 0;

  if (!devices.length) {
    els.trustedList.innerHTML = '<div class="empty-trusted">Approve a controller once and tick “Trust this controller” to add it here.</div>';
    return;
  }

  els.trustedList.innerHTML = "";
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "trusted-device";

    const meta = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.name || "Trusted controller";
    const added = document.createElement("span");
    added.textContent = device.addedAt ? "Trusted " + new Date(device.addedAt).toLocaleDateString() : "Trusted controller";
    meta.append(name, added);

    const button = document.createElement("button");
    button.className = "ghost compact";
    button.type = "button";
    button.textContent = "Revoke";
    button.addEventListener("click", async () => {
      config.trustedDevices = config.trustedDevices.filter(item => item.controllerId !== device.controllerId);
      config = { ...config, ...(await window.cotrux.saveConfig({ trustedDevices: config.trustedDevices })) };
      renderTrustedDevices();
      syncHostSettings();
      setState("Access revoked", "ready");
    });

    row.append(meta, button);
    els.trustedList.append(row);
  }
}

async function renderWorkspaceStatus(status) {
  if (!status || config.workspaceMode) {
    els.workspaceCard.classList.add("hidden");
    return;
  }

  els.workspaceCard.classList.remove("hidden");

  if (!status.supported) {
    els.workspaceBadge.dataset.state = "unsupported";
    els.workspaceBadge.textContent = "UNAVAILABLE";
    els.workspaceReady.classList.add("hidden");
    els.workspaceSetup.classList.remove("hidden");
    els.workspaceRequirement.textContent = status.error || status.reason || "Persistent Workspace is unavailable on this computer.";
    els.windowsFeaturesBtn.classList.add("hidden");
    els.workspaceIsoTools.classList.add("hidden");
    return;
  }

  if (!status.hypervEnabled) {
    els.workspaceBadge.dataset.state = "unsupported";
    els.workspaceBadge.textContent = "SETUP";
    els.workspaceReady.classList.add("hidden");
    els.workspaceSetup.classList.remove("hidden");
    els.workspaceRequirement.textContent = status.message || status.reason || "Enable Hyper-V to create a persistent workspace.";
    els.windowsFeaturesBtn.classList.remove("hidden");
    els.workspaceIsoTools.classList.add("hidden");
    return;
  }

  if (!status.configured) {
    els.workspaceBadge.dataset.state = "off";
    els.workspaceBadge.textContent = "NEW";
    els.workspaceReady.classList.add("hidden");
    els.workspaceSetup.classList.remove("hidden");
    els.workspaceRequirement.textContent = status.error || status.reason || "Choose a Windows ISO to create the workspace.";
    els.windowsFeaturesBtn.classList.add("hidden");
    els.workspaceIsoTools.classList.remove("hidden");
    els.workspaceIsoName.textContent = status.isoPath ? status.isoPath.split(/[\\/]/).pop() : "No ISO selected";
    els.startWorkspaceBtn.disabled = !status.isoPath;
    return;
  }

  els.workspaceSetup.classList.add("hidden");
  els.workspaceReady.classList.remove("hidden");
  els.workspaceBadge.dataset.state = status.running ? "on" : "off";
  els.workspaceBadge.textContent = status.running ? "RUNNING" : String(status.state || "SAVED").toUpperCase();
  els.workspaceStateText.textContent = status.running
    ? "Workspace is running in the background"
    : "Workspace is preserved and currently stopped";
  els.workspaceDataPath.textContent = "Persistent disk: " + (status.dataPath || "Cotrux VHDX");
  els.resumeWorkspaceBtn.classList.toggle("hidden", Boolean(status.running));
  els.openWorkspaceBtn.disabled = false;
  els.stopWorkspaceBtn.disabled = !status.running;

  els.workspaceProvision.classList.remove("hidden");
  els.workspaceGuestUser.value = status.guestUsername || els.workspaceGuestUser.value || "";
  els.workspaceProvisionBadge.textContent = status.provisioned ? "READY" : "SETUP";
  els.workspaceProvisionBadge.dataset.state = status.provisioned ? "ready" : "setup";
  els.workspaceProvisionTitle.textContent = status.provisioned
    ? "Cotrux is provisioned inside the workspace"
    : "Provision Cotrux automatically";
  els.workspaceProvisionText.textContent = status.provisioned
    ? "Cotrux is configured in the VM. Re-enter the real account password only if you want to reinstall/update it."
    : status.bootstrapPrepared
      ? "Guest setup is ready. Open the VM and double-click “Finish Cotrux Setup” on its desktop. No Windows password is required for this fallback."
      : "Use the actual Windows account password, not the Windows Hello PIN. If you only use a PIN or have no password, choose the fallback button below.";
  els.provisionWorkspaceBtn.textContent = status.provisioned
    ? "Reinstall / Update Cotrux"
    : "Install & Configure Cotrux";

  const pin = String(status.pairingPin || "");
  els.workspacePairing.classList.toggle("hidden", !(status.provisioned || status.bootstrapPrepared) || !/^\d{6}$/.test(pin));
  if (/^\d{6}$/.test(pin)) {
    els.workspacePairingPin.textContent = pin.slice(0, 3) + " " + pin.slice(3);
  }
}

async function refreshWorkspaceStatus() {
  if (config?.workspaceMode) return;
  try {
    const status = await window.cotrux.workspaceStatus();
    await renderWorkspaceStatus(status);
  } catch (error) {
    console.error(error);
  }
}

async function saveNetworkSettings(reconnect = false) {
  config = {
    ...config,
    ...(await window.cotrux.saveConfig({
      signalUrl: els.signalUrl.value.trim(),
      turnUrl: els.turnUrl.value.trim(),
      turnUser: els.turnUser.value.trim(),
      turnPass: els.turnPass.value
    }))
  };
  setState("Settings saved", "ready");
  if (reconnect) connectSignal();
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSignal();
  }, 4000);
}

function connectSignal() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  teardownPeer();

  try { ws?.close(); } catch {}

  const url = els.signalUrl.value.trim();
  if (!url) {
    setState("Server address missing", "error");
    return;
  }

  setState("Connecting", "pending");

  try {
    ws = new WebSocket(url);
  } catch {
    setState("Bad server address", "error");
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setState(config.unattendedEnabled ? "Ready · unattended on" : "Ready", "ready");
    registerHost();
  };

  ws.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "host-registered") {
      setState(config.unattendedEnabled ? "Ready · unattended on" : "Ready", "ready");
      return;
    }

    if (msg.type === "controller-request") {
      if (sessionActive) {
        sendWs({ type: "host-reject", requestId: msg.requestId });
        return;
      }

      pendingRequestId = msg.requestId;
      pendingControllerId = msg.controllerId || "";
      pendingControllerName = msg.controllerName || "Cotrux controller";
      els.requestName.textContent = pendingControllerName;
      els.trustRequest.checked = Boolean(config.unattendedEnabled && msg.wantsTrust && pendingControllerId);
      els.trustRequestRow.classList.toggle("hidden", !config.unattendedEnabled || !pendingControllerId);
      els.requestCard.classList.remove("hidden");
      setState("Approval needed", "pending");

      if (config.backgroundWorkspace && config.unattendedEnabled && pendingControllerId) {
        els.trustRequest.checked = true;
        els.acceptBtn.click();
      }
      return;
    }

    if (msg.type === "paired") {
      els.requestCard.classList.add("hidden");
      pendingRequestId = "";

      if (msg.unattended) {
        els.sessionTitle.textContent = "Trusted controller connected";
        els.sessionText.textContent = (msg.controllerName || "A trusted controller") + " connected using unattended access.";
      } else {
        els.sessionTitle.textContent = config.backgroundWorkspace ? "Background workspace connected" : "Remote control is on";
        els.sessionText.textContent = config.backgroundWorkspace
          ? "This isolated workspace is being controlled without affecting the physical desktop."
          : "Your primary display is being shared. Mouse, keyboard and clipboard commands can be received.";
      }

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
        await rotatePin();
      } else {
        setState(msg.code || "Signal error", "error");
      }
    }
  };

  ws.onerror = () => setState("Server connection problem", "error");
  ws.onclose = () => {
    if (!shuttingDown) {
      if (!sessionActive) setState("Reconnecting…", "pending");
      scheduleReconnect();
    }
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

    if (pendingTrustGrant) {
      controlChannel.send(JSON.stringify({
        kind: "cotrux-trust-grant",
        deviceId: config.deviceId,
        hostName: config.computerName || "Cotrux computer",
        controllerId: pendingTrustGrant.controllerId,
        token: pendingTrustGrant.token
      }));
      pendingTrustGrant = null;
    }
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
    video: { frameRate: { ideal: 30, max: 60 } },
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
  els.unattendedToggle.disabled = true;
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

async function stopSession(notify = true) {
  if (notify) sendWs({ type: "session-end" });
  teardownPeer();
  pendingTrustGrant = null;
  els.sessionCard.classList.add("hidden");
  els.requestCard.classList.add("hidden");
  els.newPinBtn.disabled = false;
  els.unattendedToggle.disabled = false;
  setState(
    ws?.readyState === WebSocket.OPEN
      ? (config.unattendedEnabled ? "Ready · unattended on" : "Ready")
      : "Reconnecting…",
    ws?.readyState === WebSocket.OPEN ? "ready" : "pending"
  );

  await rotatePin();
}

els.acceptBtn.addEventListener("click", async () => {
  if (!pendingRequestId) return;

  const requestId = pendingRequestId;
  els.acceptBtn.disabled = true;
  setState("Preparing share", "pending");

  try {
    await prepareCapture();

    let trustedController;
    if (config.unattendedEnabled && els.trustRequest.checked && pendingControllerId) {
      const token = generateToken();
      const tokenHash = await hashToken(token);
      const trustedRecord = {
        controllerId: pendingControllerId,
        name: pendingControllerName,
        tokenHash,
        addedAt: Date.now()
      };

      config.trustedDevices = [
        ...config.trustedDevices.filter(item => item.controllerId !== pendingControllerId),
        trustedRecord
      ].slice(-50);

      config = { ...config, ...(await window.cotrux.saveConfig({ trustedDevices: config.trustedDevices })) };
      renderTrustedDevices();
      pendingTrustGrant = { controllerId: pendingControllerId, token };
      trustedController = trustedRecord;
    }

    sendWs({
      type: "host-accept",
      requestId,
      trustedController
    });
  } catch (error) {
    console.error("Screen capture cancelled", error);
    sendWs({ type: "host-reject", requestId });
    pendingRequestId = "";
    pendingTrustGrant = null;
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
  pendingControllerId = "";
  pendingTrustGrant = null;
  els.requestCard.classList.add("hidden");
  setState(config.unattendedEnabled ? "Ready · unattended on" : "Ready", "ready");
});

els.stopBtn.addEventListener("click", () => stopSession(true));
els.newPinBtn.addEventListener("click", () => rotatePin());

els.copyPinBtn.addEventListener("click", async () => {
  await window.cotrux.control({ kind: "clipboard", text: currentPin });
  setState("PIN copied", "ready");
});

els.unattendedToggle.addEventListener("change", async () => {
  config.unattendedEnabled = els.unattendedToggle.checked;
  config = { ...config, ...(await window.cotrux.saveConfig({ unattendedEnabled: config.unattendedEnabled })) };
  syncHostSettings();
  setState(config.unattendedEnabled ? "Unattended access on" : "Unattended access off", "ready");
});

els.startupToggle.addEventListener("change", async () => {
  const startup = await window.cotrux.setStartup(els.startupToggle.checked);
  els.startupToggle.checked = Boolean(startup.enabled);
  if (!startup.supported) setState("Startup setting not supported on this OS", "error");
  else setState(startup.enabled ? "Starts with computer" : "Startup disabled", "ready");
});

els.revokeAllBtn.addEventListener("click", async () => {
  if (!config.trustedDevices.length) return;
  if (!window.confirm("Revoke unattended access for all trusted controllers?")) return;
  config.trustedDevices = [];
  config = { ...config, ...(await window.cotrux.saveConfig({ trustedDevices: [] })) };
  renderTrustedDevices();
  syncHostSettings();
  setState("All trusted access revoked", "ready");
});

els.startWorkspaceBtn.addEventListener("click", async () => {
  els.startWorkspaceBtn.disabled = true;
  els.startWorkspaceBtn.textContent = "Creating persistent workspace…";
  const status = await window.cotrux.workspaceStart();
  await renderWorkspaceStatus(status);
  els.startWorkspaceBtn.textContent = "Create Persistent Workspace";
  setState(status.running ? "Persistent workspace running" : (status.error || "Workspace setup needs attention"), status.running ? "ready" : "error");
});

els.resumeWorkspaceBtn.addEventListener("click", async () => {
  els.resumeWorkspaceBtn.disabled = true;
  const status = await window.cotrux.workspaceStart();
  await renderWorkspaceStatus(status);
  els.resumeWorkspaceBtn.disabled = false;
  setState(status.running ? "Persistent workspace running" : (status.error || "Workspace could not start"), status.running ? "ready" : "error");
});

els.chooseWorkspaceIsoBtn.addEventListener("click", async () => {
  const status = await window.cotrux.workspaceChooseIso();
  await renderWorkspaceStatus(status);
  if (status.error) setState(status.error, "error");
  else if (status.isoPath) setState("Windows ISO validated", "ready");
});

els.repairWorkspaceBootBtn.addEventListener("click", async () => {
  els.repairWorkspaceBootBtn.disabled = true;
  const oldText = els.repairWorkspaceBootBtn.textContent;
  els.repairWorkspaceBootBtn.textContent = "Validating & repairing…";
  setState("Checking Windows ISO and repairing VM boot", "pending");

  try {
    const status = await window.cotrux.workspaceRepairBoot();
    await renderWorkspaceStatus(status);

    if (status.repairResult?.ok && !status.error) {
      setState("Boot repaired · Windows installer should start now", "ready");
    } else if (status.error) {
      setState(status.error, "error");
    } else {
      setState("Boot repair cancelled", "ready");
    }
  } catch (error) {
    setState(String(error?.message || error || "Boot repair failed"), "error");
  } finally {
    els.repairWorkspaceBootBtn.disabled = false;
    els.repairWorkspaceBootBtn.textContent = oldText;
  }
});

els.downloadWindowsBtn.addEventListener("click", async () => {
  await window.cotrux.workspaceDownloadWindows();
});

els.stopWorkspaceBtn.addEventListener("click", async () => {
  els.stopWorkspaceBtn.disabled = true;
  const status = await window.cotrux.workspaceStop();
  await renderWorkspaceStatus(status);
  els.stopWorkspaceBtn.disabled = false;
  setState(status.running ? "Workspace still running" : "Workspace saved · data preserved", status.running ? "error" : "ready");
});

els.provisionWorkspaceBtn.addEventListener("click", async () => {
  const username = els.workspaceGuestUser.value.trim();
  const password = els.workspaceGuestPass.value;

  if (!username || !password) {
    setState("Use the Windows account password — Windows Hello PIN will not work. Or choose the PIN/no-password fallback.", "error");
    els.workspaceGuestPass.focus();
    return;
  }

  els.provisionWorkspaceBtn.disabled = true;
  const previousText = els.provisionWorkspaceBtn.textContent;
  els.provisionWorkspaceBtn.textContent = "Installing inside workspace…";
  setState("Provisioning Cotrux in workspace", "pending");

  try {
    const status = await window.cotrux.workspaceProvision({ username, password });
    els.workspaceGuestPass.value = "";
    await renderWorkspaceStatus(status);

    if (status.provisioned && !status.error) {
      setState("Workspace Cotrux ready · pair once with the PIN", "ready");
    } else {
      setState(status.error || status.provisionResult?.error || "Guest provisioning failed", "error");
    }
  } catch (error) {
    els.workspaceGuestPass.value = "";
    setState(String(error?.message || error || "Guest provisioning failed"), "error");
  } finally {
    els.provisionWorkspaceBtn.disabled = false;
    if (!els.provisionWorkspaceBtn.textContent || els.provisionWorkspaceBtn.textContent === "Installing inside workspace…") {
      els.provisionWorkspaceBtn.textContent = previousText;
    }
  }
});

els.prepareGuestSetupBtn.addEventListener("click", async () => {
  els.prepareGuestSetupBtn.disabled = true;
  const oldText = els.prepareGuestSetupBtn.textContent;
  els.prepareGuestSetupBtn.textContent = "Preparing one-click setup…";
  setState("Preparing guest setup without password", "pending");

  try {
    const status = await window.cotrux.workspacePrepareBootstrap();
    await renderWorkspaceStatus(status);

    if (status.bootstrapPrepared && !status.error) {
      setState("Open VM · double-click “Finish Cotrux Setup” on the Windows desktop", "ready");
    } else {
      setState(status.error || status.bootstrapResult?.error || "Could not prepare guest setup", "error");
    }
  } catch (error) {
    setState(String(error?.message || error || "Could not prepare guest setup"), "error");
  } finally {
    els.prepareGuestSetupBtn.disabled = false;
    els.prepareGuestSetupBtn.textContent = oldText;
  }
});

els.openWorkspaceBtn.addEventListener("click", async () => {
  const status = await window.cotrux.workspaceConnect();
  await renderWorkspaceStatus(status);
  if (!status.opened) setState(status.error || "Could not open workspace", "error");
});

els.windowsFeaturesBtn.addEventListener("click", async () => {
  els.windowsFeaturesBtn.disabled = true;
  els.windowsFeaturesBtn.textContent = "Enabling Hyper-V…";
  const status = await window.cotrux.workspaceEnableHyperV();
  await renderWorkspaceStatus(status);
  els.windowsFeaturesBtn.textContent = "Enable Hyper-V";
  els.windowsFeaturesBtn.disabled = false;
  if (status.restartNeeded) setState("Hyper-V enabled · restart Windows once", "pending");
  else if (status.hypervEnabled) setState("Hyper-V ready", "ready");
});

els.reconnectBtn.addEventListener("click", async () => {
  await saveNetworkSettings(false);
  connectSignal();
});

els.saveAdvancedBtn.addEventListener("click", () => saveNetworkSettings(false));

window.addEventListener("beforeunload", () => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearInterval(workspacePollTimer);
  try { sendWs({ type: "session-end" }); } catch {}
  teardownPeer();
});

async function init() {
  config = await window.cotrux.getConfig();
  config.trustedDevices = Array.isArray(config.trustedDevices) ? config.trustedDevices : [];

  els.computerName.textContent = config.computerName || "Desktop agent";
  els.signalUrl.value = config.signalUrl || "wss://cotrux-production.up.railway.app/ws";
  els.turnUrl.value = config.turnUrl || "";
  els.turnUser.value = config.turnUser || "";
  els.turnPass.value = config.turnPass || "";
  els.unattendedToggle.checked = Boolean(config.unattendedEnabled);
  els.startupToggle.checked = Boolean(config.startup?.enabled);
  els.startupToggle.disabled = config.startup?.supported === false;

  if (config.workspaceMode) {
    els.workspaceCard.classList.add("hidden");
    els.accessCard.classList.add("hidden");
  } else {
    await refreshWorkspaceStatus();
    workspacePollTimer = setInterval(refreshWorkspaceStatus, 15000);
  }

  renderTrustedDevices();

  if (config.backgroundWorkspace && /^\d{6}$/.test(String(config.pairingPin || ""))) {
    currentPin = String(config.pairingPin);
  } else {
    currentPin = generatePin();
    if (config.backgroundWorkspace) {
      config = { ...config, ...(await window.cotrux.saveConfig({ pairingPin: currentPin })) };
    }
  }

  renderPin();
  connectSignal();
}

init().catch(error => {
  console.error(error);
  setState("Startup failed", "error");
});
