import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controllerDir = path.resolve(__dirname, "../../apps/controller");
const hostsByPin = new Map();
const hostsByDevice = new Map();
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
  const maxAttempts = 40;
  const recent = (attemptsByIp.get(ip) || []).filter(ts => now - ts < windowMs);
  if (recent.length >= maxAttempts) {
    attemptsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  attemptsByIp.set(ip, recent);
  return true;
}

function cleanTrustedDevices(items) {
  const trusted = new Map();
  if (!Array.isArray(items)) return trusted;

  for (const item of items.slice(0, 50)) {
    const controllerId = String(item?.controllerId || "").slice(0, 128);
    const tokenHash = String(item?.tokenHash || "").toLowerCase();
    const name = String(item?.name || "Trusted controller").slice(0, 80);
    if (!controllerId || !/^[a-f0-9]{64}$/.test(tokenHash)) continue;
    trusted.set(controllerId, { tokenHash, name });
  }
  return trusted;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function safeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unregisterHost(ws) {
  for (const [pin, record] of hostsByPin) {
    if (record.ws === ws) hostsByPin.delete(pin);
  }
  for (const [deviceId, record] of hostsByDevice) {
    if (record.ws === ws) hostsByDevice.delete(deviceId);
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

function pair(host, controller, controllerMeta, options = {}) {
  detachPeer(host.ws);
  detachPeer(controller);

  const hostMeta = socketMeta.get(host.ws) || {};
  socketMeta.set(host.ws, { ...hostMeta, role: "host", peer: controller, pin: host.pin, deviceId: host.deviceId });

  socketMeta.set(controller, {
    ...controllerMeta,
    role: "controller",
    peer: host.ws,
    pin: host.pin,
    deviceId: host.deviceId
  });

  send(host.ws, {
    type: "paired",
    role: "host",
    unattended: Boolean(options.unattended),
    grantTrust: Boolean(options.grantTrust),
    controllerName: options.controllerName || "Cotrux controller",
    controllerId: options.controllerId || ""
  });

  send(controller, {
    type: "paired",
    role: "controller",
    unattended: Boolean(options.unattended),
    hostName: host.name,
    deviceId: host.deviceId
  });
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
    const noCache = filename === "sw.js" || filename === "index.html" || filename === "app.js";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": noCache ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
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
    return res.end(JSON.stringify({
      ok: true,
      hosts: hostsByDevice.size,
      service: "cotrux"
    }));
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
  send(ws, { type: "hello", service: "cotrux-signal", protocol: 2 });

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
      const deviceId = String(message.deviceId || "").slice(0, 128);
      if (pin.length !== 6) return send(ws, { type: "error", code: "BAD_PIN" });
      if (!deviceId) return send(ws, { type: "error", code: "BAD_DEVICE_ID" });

      const existingPin = hostsByPin.get(pin);
      if (existingPin && existingPin.ws !== ws && existingPin.ws.readyState === WebSocket.OPEN) {
        return send(ws, { type: "error", code: "PIN_IN_USE" });
      }

      const existingDevice = hostsByDevice.get(deviceId);
      if (existingDevice && existingDevice.ws !== ws && existingDevice.ws.readyState === WebSocket.OPEN) {
        try { existingDevice.ws.close(4001, "Host reconnected"); } catch {}
      }

      const host = {
        ws,
        pin,
        deviceId,
        name: String(message.name || "Cotrux computer").slice(0, 80),
        unattendedEnabled: Boolean(message.unattendedEnabled),
        trusted: cleanTrustedDevices(message.trustedDevices),
        pending: new Map()
      };

      hostsByPin.set(pin, host);
      hostsByDevice.set(deviceId, host);
      socketMeta.set(ws, { role: "host", peer: null, pin, deviceId, ip });

      return send(ws, {
        type: "host-registered",
        pin,
        deviceId,
        unattendedEnabled: host.unattendedEnabled,
        trustedCount: host.trusted.size
      });
    }

    if (message.type === "host-settings") {
      const meta = socketMeta.get(ws);
      if (meta?.role !== "host") return;
      const host = hostsByDevice.get(meta.deviceId);
      if (!host || host.ws !== ws) return;

      host.unattendedEnabled = Boolean(message.unattendedEnabled);
      host.trusted = cleanTrustedDevices(message.trustedDevices);
      return send(ws, {
        type: "host-settings-saved",
        unattendedEnabled: host.unattendedEnabled,
        trustedCount: host.trusted.size
      });
    }

    if (message.type === "controller-join") {
      if (!allowJoin(ip)) return send(ws, { type: "error", code: "RATE_LIMITED" });

      detachPeer(ws);
      const pin = String(message.pin || "").replace(/\D/g, "").slice(0, 6);
      const host = hostsByPin.get(pin);

      if (!host || host.ws.readyState !== WebSocket.OPEN) {
        return send(ws, { type: "error", code: "HOST_NOT_FOUND" });
      }

      if (socketMeta.get(host.ws)?.peer) {
        return send(ws, { type: "error", code: "HOST_BUSY" });
      }

      if (host.pending.size >= 8) {
        return send(ws, { type: "error", code: "HOST_BUSY" });
      }

      const requestId = crypto.randomUUID();
      const controllerId = String(message.controllerId || "").slice(0, 128);
      const controllerName = String(message.name || "Web controller").slice(0, 80);
      host.pending.set(requestId, ws);
      socketMeta.set(ws, {
        role: "controller",
        peer: null,
        requestId,
        pin,
        deviceId: host.deviceId,
        controllerId,
        controllerName,
        ip
      });

      send(ws, {
        type: "pending",
        requestId,
        hostName: host.name,
        unattendedAvailable: host.unattendedEnabled
      });

      return send(host.ws, {
        type: "controller-request",
        requestId,
        controllerId,
        controllerName,
        wantsTrust: Boolean(message.wantsTrust)
      });
    }

    if (message.type === "trusted-join") {
      if (!allowJoin(ip)) return send(ws, { type: "error", code: "RATE_LIMITED" });

      detachPeer(ws);
      const deviceId = String(message.deviceId || "").slice(0, 128);
      const controllerId = String(message.controllerId || "").slice(0, 128);
      const token = String(message.token || "").slice(0, 256);
      const host = hostsByDevice.get(deviceId);

      if (!host || host.ws.readyState !== WebSocket.OPEN) {
        return send(ws, { type: "error", code: "TRUST_HOST_OFFLINE" });
      }
      if (!host.unattendedEnabled) {
        return send(ws, { type: "error", code: "TRUST_DISABLED" });
      }
      if (socketMeta.get(host.ws)?.peer) {
        return send(ws, { type: "error", code: "HOST_BUSY" });
      }

      const trusted = host.trusted.get(controllerId);
      const suppliedHash = hashToken(token);
      if (!trusted || !safeHashEqual(trusted.tokenHash, suppliedHash)) {
        return send(ws, { type: "error", code: "TRUST_INVALID" });
      }

      const controllerName = String(message.name || trusted.name || "Trusted controller").slice(0, 80);
      const controllerMeta = {
        role: "controller",
        peer: null,
        deviceId,
        controllerId,
        controllerName,
        ip
      };
      socketMeta.set(ws, controllerMeta);

      return pair(host, ws, controllerMeta, {
        unattended: true,
        controllerName,
        controllerId
      });
    }

    if (message.type === "host-accept" || message.type === "host-reject") {
      const hostMeta = socketMeta.get(ws);
      if (hostMeta?.role !== "host") return;

      const host = hostsByDevice.get(hostMeta.deviceId);
      const controller = host?.pending.get(message.requestId);
      if (!host || !controller) return;

      host.pending.delete(message.requestId);
      if (message.type === "host-reject") {
        return send(controller, { type: "rejected" });
      }

      const controllerMeta = socketMeta.get(controller) || {};
      let grantTrust = false;

      if (host.unattendedEnabled && message.trustedController && controllerMeta.controllerId) {
        const incomingId = String(message.trustedController.controllerId || "").slice(0, 128);
        const tokenHash = String(message.trustedController.tokenHash || "").toLowerCase();
        const name = String(message.trustedController.name || controllerMeta.controllerName || "Trusted controller").slice(0, 80);

        if (incomingId === controllerMeta.controllerId && /^[a-f0-9]{64}$/.test(tokenHash)) {
          host.trusted.set(incomingId, { tokenHash, name });
          grantTrust = true;
        }
      }

      return pair(host, controller, controllerMeta, {
        unattended: false,
        grantTrust,
        controllerName: controllerMeta.controllerName,
        controllerId: controllerMeta.controllerId
      });
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
      const host = hostsByDevice.get(meta.deviceId);
      if (host?.ws === ws) {
        for (const controller of host.pending.values()) {
          send(controller, { type: "error", code: "HOST_DISCONNECTED" });
        }
      }
      unregisterHost(ws);
    } else if (meta?.requestId) {
      hostsByPin.get(meta.pin)?.pending.delete(meta.requestId);
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
