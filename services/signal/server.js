import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controllerDir = path.resolve(__dirname, "../../apps/controller");
const hosts = new Map();
const socketMeta = new WeakMap();
const attemptsByIp = new Map();

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml; charset=utf-8"]]
]);

function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function allowJoin(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 30;
  const recent = (attemptsByIp.get(ip) || []).filter(ts => now - ts < windowMs);
  if (recent.length >= maxAttempts) {
    attemptsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  attemptsByIp.set(ip, recent);
  return true;
}

function unregisterHost(ws) {
  for (const [pin, record] of hosts) {
    if (record.ws === ws) hosts.delete(pin);
  }
}

function detachPeer(ws, reason = "peer-left") {
  const meta = socketMeta.get(ws);
  const peer = meta?.peer;
  if (peer) {
    const peerMeta = socketMeta.get(peer) || {};
    peerMeta.peer = null;
    socketMeta.set(peer, peerMeta);
    send(peer, { type: reason });
  }
  if (meta) {
    meta.peer = null;
    socketMeta.set(ws, meta);
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const entry = staticFiles.get(url.pathname);
  if (!entry) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
    return;
  }

  const [filename, contentType] = entry;
  try {
    const body = await fs.readFile(path.join(controllerDir, filename));
    const noCache = filename === "sw.js" || filename === "index.html";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": noCache ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY"
    });
    res.end(body);
  } catch (error) {
    console.error("Static file error", error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Controller assets unavailable\n");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    return res.end(JSON.stringify({ ok: true, hosts: hosts.size }));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    return res.end();
  }

  await serveStatic(req, res);
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 64 * 1024
});

wss.on("connection", (ws, req) => {
  const ip = getClientIp(req);
  socketMeta.set(ws, { role: null, peer: null, ip });
  send(ws, { type: "hello", service: "cotrux-signal" });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", code: "BAD_JSON" });
    }

    if (!message || typeof message.type !== "string") {
      return send(ws, { type: "error", code: "BAD_MESSAGE" });
    }

    if (message.type === "host-register") {
      unregisterHost(ws);
      detachPeer(ws);

      const pin = String(message.pin || "").replace(/\D/g, "").slice(0, 6);
      if (pin.length !== 6) return send(ws, { type: "error", code: "BAD_PIN" });

      const existing = hosts.get(pin);
      if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
        return send(ws, { type: "error", code: "PIN_IN_USE" });
      }

      hosts.set(pin, {
        ws,
        pin,
        deviceId: String(message.deviceId || "").slice(0, 128),
        name: String(message.name || "Cotrux computer").slice(0, 80),
        pending: new Map()
      });
      socketMeta.set(ws, { role: "host", peer: null, pin, ip });
      return send(ws, { type: "host-registered", pin });
    }

    if (message.type === "controller-join") {
      if (!allowJoin(ip)) {
        return send(ws, { type: "error", code: "RATE_LIMITED" });
      }

      detachPeer(ws);
      const pin = String(message.pin || "").replace(/\D/g, "").slice(0, 6);
      const host = hosts.get(pin);

      if (!host || host.ws.readyState !== WebSocket.OPEN) {
        return send(ws, { type: "error", code: "HOST_NOT_FOUND" });
      }

      if (host.pending.size >= 8) {
        return send(ws, { type: "error", code: "HOST_BUSY" });
      }

      const requestId = crypto.randomUUID();
      host.pending.set(requestId, ws);
      socketMeta.set(ws, { role: "controller", peer: null, requestId, pin, ip });

      send(ws, { type: "pending", requestId, hostName: host.name });
      return send(host.ws, {
        type: "controller-request",
        requestId,
        controllerName: String(message.name || "Web controller").slice(0, 80)
      });
    }

    if (message.type === "host-accept" || message.type === "host-reject") {
      const hostMeta = socketMeta.get(ws);
      if (hostMeta?.role !== "host") return;

      const host = hosts.get(hostMeta.pin);
      const controller = host?.pending.get(message.requestId);
      if (!controller) return;

      host.pending.delete(message.requestId);

      if (message.type === "host-reject") {
        return send(controller, { type: "rejected" });
      }

      detachPeer(ws);
      detachPeer(controller);

      socketMeta.set(ws, { ...hostMeta, peer: controller });
      const controllerMeta = socketMeta.get(controller) || {};
      socketMeta.set(controller, { ...controllerMeta, peer: ws });

      send(ws, { type: "paired", role: "host" });
      return send(controller, { type: "paired", role: "controller", hostName: host.name });
    }

    if (message.type === "signal") {
      const peer = socketMeta.get(ws)?.peer;
      if (peer && message.data && typeof message.data === "object") {
        send(peer, { type: "signal", data: message.data });
      }
      return;
    }

    if (message.type === "session-end") {
      detachPeer(ws, "session-ended");
    }
  });

  ws.on("close", () => {
    const meta = socketMeta.get(ws);

    if (meta?.role === "host") {
      const host = hosts.get(meta.pin);
      if (host) {
        for (const controller of host.pending.values()) {
          send(controller, { type: "error", code: "HOST_DISCONNECTED" });
        }
      }
      unregisterHost(ws);
    } else if (meta?.requestId) {
      hosts.get(meta.pin)?.pending.delete(meta.requestId);
    }

    detachPeer(ws);
  });

  ws.on("error", error => {
    console.error("WebSocket error", error.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Cotrux controller + signaling listening on :" + PORT);
});
