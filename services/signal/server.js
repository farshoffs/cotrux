import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8787);
const hosts = new Map();
const socketMeta = new WeakMap();

function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, hosts: hosts.size }));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Cotrux signaling service\n");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", ws => {
  socketMeta.set(ws, { role: null, peer: null });
  send(ws, { type: "hello", service: "cotrux-signal" });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", code: "BAD_JSON" });
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
        deviceId: String(message.deviceId || ""),
        name: String(message.name || "Cotrux computer").slice(0, 80),
        pending: new Map()
      });
      socketMeta.set(ws, { role: "host", peer: null, pin });
      return send(ws, { type: "host-registered", pin });
    }

    if (message.type === "controller-join") {
      detachPeer(ws);
      const pin = String(message.pin || "").replace(/\D/g, "").slice(0, 6);
      const host = hosts.get(pin);
      if (!host || host.ws.readyState !== WebSocket.OPEN) {
        return send(ws, { type: "error", code: "HOST_NOT_FOUND" });
      }

      const requestId = crypto.randomUUID();
      host.pending.set(requestId, ws);
      socketMeta.set(ws, { role: "controller", peer: null, requestId, pin });
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

      if (message.type === "host-reject") return send(controller, { type: "rejected" });

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
      if (peer) send(peer, { type: "signal", data: message.data });
      return;
    }

    if (message.type === "session-end") detachPeer(ws, "session-ended");
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
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Cotrux signaling listening on :" + PORT);
});
