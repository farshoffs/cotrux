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

The server rate-limits PIN attempts. Optional unattended access is device-specific, explicitly enabled on the host, and revocable from the Cotrux GUI.

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

- Explicit host approval for first-time pairing.
- Optional unattended access is disabled by default and granted per trusted controller.
- Trusted controllers can be revoked individually or all at once from the host GUI.
- Visible active-session UI and host-side stop control.
- Six-digit PIN rotates for normal pairing.
- Server-side PIN-attempt rate limiting.
- WebRTC DTLS/SRTP encryption for media and data channels.
- No shared permanent unattended password.
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



## Persistent Workspace

Cotrux Persistent Workspace is a real Hyper-V virtual machine rather than a disposable Windows Sandbox. The physical user can continue using the host desktop while the VM runs as an independent Windows computer with its own display, mouse, keyboard, applications and Cotrux identity.

The desktop GUI handles the lifecycle:

1. Enable Hyper-V from Cotrux. Windows may show a UAC approval prompt and may require one restart.
2. Choose a Windows installation ISO in the file picker.
3. Select **Create Persistent Workspace**.
4. Cotrux creates a Generation 2 VM with a dynamic 100 GB VHDX, virtual TPM, Secure Boot and networking.
5. Finish the one-time Windows installation in **Open locally**.
6. Install Cotrux inside that VM, enable **Unattended Access**, and enable **Start Cotrux with this computer** inside the VM.
7. Pair that VM once from the PWA. It then appears as a separate trusted computer.

Persistence behavior:

- The VHDX is never deleted by Cotrux.
- **Save & stop** saves the VM state instead of deleting or resetting it.
- Hyper-V is configured with **AutomaticStartAction = Start**.
- Hyper-V is configured with **AutomaticStopAction = Save** so host shutdown preserves the guest session.
- Installed applications, Windows configuration and files remain on the persistent VHDX.
- Cotrux intentionally provides no delete-workspace button.
- A Windows guest license/activation is separate from Cotrux.

Current host requirements are Windows Pro/Enterprise/Education-class Hyper-V support, hardware virtualization with SLAT, and enough memory for both the host and VM. Windows 11 guests use Generation 2, Secure Boot and virtual TPM settings.

## Stable Windows download

The desktop build workflow publishes a fixed latest Windows installer asset:

    https://github.com/farshoffs/cotrux/releases/download/desktop-latest/Cotrux-Setup.exe

The GitHub Pages controller exposes this as **Download Cotrux for Windows**. Each successful main-branch desktop build replaces the `desktop-latest` release so the button stays current.
