import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const port = 18787;
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"]
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Signal server did not start")), 5000);
    server.stdout.on("data", chunk => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error("Signal server exited early: " + code));
    });
  });
}

function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws");
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

try {
  await waitForServer();
  host = await openClient();
  controller = await openClient();

  const hostRegistered = waitFor(host, "host-registered");
  send(host, {
    type: "host-register",
    pin: "123456",
    deviceId: "test-host",
    name: "Test Computer"
  });
  await hostRegistered;

  const hostRequest = waitFor(host, "controller-request");
  const controllerPending = waitFor(controller, "pending");
  send(controller, {
    type: "controller-join",
    pin: "123456",
    name: "Test Controller"
  });

  const [request] = await Promise.all([hostRequest, controllerPending]);

  const hostPaired = waitFor(host, "paired");
  const controllerPaired = waitFor(controller, "paired");
  send(host, { type: "host-accept", requestId: request.requestId });
  await Promise.all([hostPaired, controllerPaired]);

  const relayed = waitFor(host, "signal");
  send(controller, {
    type: "signal",
    data: { description: { type: "offer", sdp: "test-sdp" } }
  });

  const signal = await relayed;
  if (signal.data?.description?.sdp !== "test-sdp") {
    throw new Error("Signaling payload was not relayed correctly");
  }

  const ended = waitFor(controller, "session-ended");
  send(host, { type: "session-end" });
  await ended;

  console.log("Cotrux signaling integration test passed");
} finally {
  try { host?.close(); } catch {}
  try { controller?.close(); } catch {}
  server.kill("SIGTERM");
}
