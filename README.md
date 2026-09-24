# Cotrux

Cotrux is a consent-first remote desktop MVP for controlling a computer from a browser, installable PWA, iPhone/iPad, or another computer.

## What is included

- **Desktop Agent (Electron)** — captures the primary desktop and applies mouse/keyboard input.
- **Web/PWA Controller** — desktop video, mouse/touch, keyboard, scrolling, fullscreen and clipboard-to-host.
- **iOS-ready Controller** — the PWA installs directly from Safari, and the same UI has a Capacitor wrapper for a native App Store build.
- **WebRTC transport** — desktop media and control data travel over an encrypted WebRTC peer connection.
- **Cotrux Server** — one Node/WebSocket service serves the PWA and handles one-time PIN pairing/signaling.
- **TURN support** — optional credentials can be configured for networks where direct WebRTC connectivity fails.

Cotrux is intended only for computers you own or are authorized to control.

## Connection flow

1. Open the Cotrux desktop agent on the computer to be controlled.
2. The agent generates a six-digit one-time PIN.
3. Open the Cotrux web/PWA controller and enter that PIN.
4. The host computer shows a visible access request.
5. The host accepts it and the WebRTC desktop session starts.
6. Either side can end the session. The host then receives a fresh PIN.

The server rate-limits PIN attempts. This MVP does **not** enable hidden or unattended access.

## Run locally

Requires Node.js 22.12 or newer.

    npm install

Start Cotrux Server:

    npm run dev:signal

Then open:

    http://localhost:8787

Start the desktop agent in another terminal:

    npm run dev:agent

The agent defaults to:

    ws://localhost:8787/ws

You can also run the PWA with Vite during UI development:

    npm run dev:controller

## Deploy the web/PWA + signaling server

The server now serves the controller itself, so one public deployment is enough.

### Render Blueprint

A ready-to-use `render.yaml` is included. Create a Render Blueprint from this repository. It will:

- build `services/signal/Dockerfile` from the repository root,
- deploy in Render's Singapore region,
- health-check `/health`,
- publish the PWA and WebSocket endpoint on the same hostname,
- deploy new commits after CI checks pass.

After deployment, if your service URL is:

    https://your-cotrux-host.example

then:

    PWA:       https://your-cotrux-host.example
    Signaling: wss://your-cotrux-host.example/ws
    Health:    https://your-cotrux-host.example/health

Paste that WSS address into the desktop agent once and reconnect.

### Docker anywhere

Build from the repository root:

    docker build -f services/signal/Dockerfile -t cotrux .

Run:

    docker run --rm -p 8787:8787 -e PORT=8787 cotrux

For a reverse proxy, terminate TLS there and proxy WebSocket upgrades to the same service.

## TURN for reliable internet connections

WebRTC can connect directly on many networks. Corporate networks, carrier NAT, and strict firewalls may require TURN.

An example coturn configuration lives at:

    infra/coturn/turnserver.conf.example

Enter the deployed TURN URL, username and credential in both the host and controller network settings.

## iPhone / iPad

### PWA

Open the public Cotrux URL in Safari and use **Add to Home Screen**. The controller is standalone-capable and works with touch controls and the on-screen keyboard.

### Native iOS wrapper

The controller includes Capacitor scaffolding:

    npm install
    npm run build:controller
    cd apps/controller
    npm run ios:add
    npm run ios:sync
    npm run ios:open

Xcode is still required for Apple signing and App Store/TestFlight distribution.

## Desktop installers

GitHub Actions builds the Electron desktop agent for:

- Windows — NSIS installer
- macOS — Electron app package
- Linux — AppImage

The `Build Cotrux Desktop Agent` workflow uploads each platform build as a GitHub Actions artifact. Tagged releases beginning with `v` also trigger the build.

For a production macOS/Windows release, add proper code-signing/notarization credentials instead of distributing unsigned builds.

## GitHub Pages

The controller PWA is deployed at:

    https://farshoffs.github.io/cotrux/

GitHub Pages is static hosting, so it serves the controller UI but cannot run Cotrux's long-lived WebSocket signaling service. Enter your deployed `wss://...` Cotrux Server address in **Network settings**.

For the simplest production setup, deploy the included `render.yaml` (or the Docker image) so the PWA and `/ws` signaling endpoint live on one HTTPS hostname.

## Security model

- Explicit host approval for every session.
- Visible active-session UI and host-side stop control.
- Six-digit PIN rotates after sessions.
- Server-side PIN-attempt rate limiting.
- WebRTC DTLS/SRTP encryption for media and data channels.
- No persistent unattended-access password in this MVP.
- No hidden agent, stealth mode, key logging, or background surveillance behavior.
- WebSocket signaling payload is limited in size.
- Clipboard writes are bounded before being passed to the host.

For production use, add authenticated accounts, device public keys, short-lived signed pairing tokens, TURN time-limited credentials, audit logs, code signing, automatic updates and a security review.

## Verification

The `Validate Cotrux` GitHub Actions workflow performs:

- dependency installation,
- JavaScript syntax validation,
- an end-to-end signaling/pairing relay test,
- PWA build validation.

## Project layout

    apps/
      agent/         Electron host
      controller/    Web/PWA/iOS controller
    services/
      signal/        Web + WebSocket server
    infra/
      coturn/        TURN example
    .github/
      workflows/     CI, installer builds, optional Pages deploy


## Background Workspace

Cotrux can run a second, isolated Windows desktop while the person at the physical PC keeps using their normal desktop. In the desktop GUI choose **Start Background Workspace**. Cotrux launches a Windows Sandbox session in the background, starts a second Cotrux agent inside it, and gives the workspace its own pairing PIN and trusted-device identity.

The remote controller sees the workspace as a separate computer. After the first trusted pairing, it can be opened again without a PIN while the workspace is running. Remote mouse and keyboard events stay inside the sandbox and do not move the physical user's pointer.

Current requirements:

- Windows 11 24H2 or newer.
- Windows Sandbox enabled.
- A supported Windows edition (Pro, Enterprise, Education, or equivalent Sandbox-capable edition).
- Hardware virtualization available.
- One Background Workspace at a time because Windows Sandbox currently supports one running instance.

The desktop GUI checks support automatically and can open **Windows Features** for setup. No manual terminal or CMD commands are required.

For isolation, Cotrux disables clipboard, printer, microphone, and camera redirection for the background workspace. It maps only the installed Cotrux application read-only plus a dedicated Cotrux workspace-data folder. The sandbox itself is disposable; Cotrux trust/config data persists only in that dedicated mapped folder.
