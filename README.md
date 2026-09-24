# Cotrux

Cotrux is a consent-first remote desktop MVP: control a computer from a browser, installable PWA, or iPhone/iPad wrapper.

## Architecture

- Desktop Agent (Electron) — shares the primary display and applies mouse/keyboard input only after the person at the host accepts a connection.
- Controller (Web/PWA/iOS-ready) — receives the WebRTC stream and sends pointer/keyboard events over a WebRTC data channel.
- Signal service (Node + ws) — pairs a controller to a host using an ephemeral 6-digit PIN, then relays only WebRTC negotiation messages.
- TURN — optional but recommended for reliable connections across restrictive NAT/firewalls.

The signaling server does not relay desktop video in normal operation. WebRTC media/control traffic is peer-to-peer when networking allows.

## MVP security model

1. The host agent displays a fresh six-digit PIN.
2. A controller enters that PIN.
3. The host receives a visible connection request and must accept it.
4. The desktop agent remains visible while the session is active and includes a Stop session control.
5. PINs live only in server memory; no unattended access is enabled in this MVP.

Use Cotrux only on computers you own or are authorized to control.

## Run locally

Requirements: Node.js 20+.

    npm install

    # Terminal 1 - signaling
    npm run dev:signal

    # Terminal 2 - web controller
    npm run dev:controller

    # Terminal 3 - desktop host
    npm run dev:agent

The controller defaults to ws://localhost:8787/ws.

## PWA

Build the controller:

    npm run build:controller

apps/controller/dist is a static PWA and can be deployed to GitHub Pages, Cloudflare Pages, Netlify, etc. The included GitHub Pages workflow publishes it automatically after pushes to main.

For production, put the signaling service behind HTTPS/WSS and enter that WSS URL in Controller Settings.

## iOS

The web controller already works as an installable iOS PWA. A Capacitor wrapper is scaffolded too:

    npm install
    npm run build:controller
    cd apps/controller
    npm run ios:add
    npm run ios:sync
    npm run ios:open

Xcode will create/sign the native iOS project for your Apple team. The controller does not attempt to host/control iOS itself; iOS is the controlling device.

## Internet deployment

Build and deploy services/signal anywhere that supports long-lived WebSockets.

    docker build -t cotrux-signal services/signal
    docker run -p 8787:8787 -e PORT=8787 cotrux-signal

For difficult NATs, deploy a TURN server and configure iceServers in the controller/agent settings. infra/coturn/turnserver.conf.example is included as a starting point.

## Desktop permissions

- Windows: normal desktop input generally works after dependencies install.
- macOS: allow Screen Recording and Accessibility for Cotrux.
- Linux: X11 works best for the MVP. Wayland often blocks synthetic input by design unless compositor/portal-specific integration is added.

## Current scope

The first version includes screen streaming, mouse/touch control, keyboard input, clipboard-to-host text, reconnectable signaling settings, pairing approval, PWA installability, and iOS Capacitor scaffolding.

Next production steps would be authenticated accounts/devices, trusted-device unattended mode, encrypted persistent device keys, multi-monitor selection, file transfer, session audit logs, TURN credentials, auto-updates, code signing/notarization, and relay fallback.
