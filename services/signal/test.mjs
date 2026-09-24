import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const port = 18787;
const base = "http://127.0.0.1:" + port;
const wsUrl = "ws://127.0.0.1:" + port + "/ws";
const trustedToken = "test-unattended-token-32-bytes-minimum";
const trustedHash = crypto.createHash("sha256").update(trustedToken).digest("hex");

const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", chunk => { stderr += chunk.toString(); });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(base + "/health");
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Signal server did not start. " + stderr);
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 3000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once("error", reject);
  });
}

function waitFor(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for " + type));
    }, 3000);

    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== type) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(msg);
    }

    ws.on("message", onMessage);
  });
}

function send(ws, payload) {
  ws.send(JSON.stringify(payload));
}

let host;
let controller;
let trustedController;

try {
  await waitForServer();

  const health = await fetch(base + "/health").then(response => response.json());
  assert.equal(health.ok, true);

  const indexResponse = await fetch(base + "/");
  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /Cotrux/);

  host = await openClient();
  controller = await openClient();

  const hostRegistered = waitFor(host, "host-registered");
  send(host, {
    type: "host-register",
    pin: "123456",
    deviceId: "test-host",
    name: "Test Computer",
    unattendedEnabled: true,
    trustedDevices: []
  });
  await hostRegistered;

  const hostRequest = waitFor(host, "controller-request");
  const controllerPending = waitFor(controller, "pending");
  send(controller, {
    type: "controller-join",
    pin: "123456",
    controllerId: "test-controller",
    name: "Test Controller",
    wantsTrust: true
  });

  const [request] = await Promise.all([hostRequest, controllerPending]);

  const hostPaired = waitFor(host, "paired");
  const controllerPaired = waitFor(controller, "paired");
  send(host, {
    type: "host-accept",
    requestId: request.requestId,
    trustedController: {
      controllerId: "test-controller",
      tokenHash: trustedHash,
      name: "Test Controller"
    }
  });

  const [hostPairMessage] = await Promise.all([hostPaired, controllerPaired]);
  assert.equal(hostPairMessage.grantTrust, true);

  const relayed = waitFor(host, "signal");
  send(controller, {
    type: "signal",
    data: { description: { type: "offer", sdp: "test-sdp" } }
  });
  const signal = await relayed;
  assert.equal(signal.data?.description?.sdp, "test-sdp");

  const ended = waitFor(controller, "session-ended");
  send(host, { type: "session-end" });
  await ended;
  controller.close();

  trustedController = await openClient();
  const trustedHostPaired = waitFor(host, "paired");
  const trustedClientPaired = waitFor(trustedController, "paired");
  send(trustedController, {
    type: "trusted-join",
    deviceId: "test-host",
    controllerId: "test-controller",
    token: trustedToken,
    name: "Test Controller"
  });

  const [trustedHostMessage, trustedClientMessage] = await Promise.all([trustedHostPaired, trustedClientPaired]);
  assert.equal(trustedHostMessage.unattended, true);
  assert.equal(trustedClientMessage.unattended, true);
  assert.equal(trustedClientMessage.deviceId, "test-host");

  console.log("Cotrux signaling + unattended access integration test passed");
} finally {
  try { host?.close(); } catch {}
  try { controller?.close(); } catch {}
  try { trustedController?.close(); } catch {}
  server.kill("SIGTERM");
}
