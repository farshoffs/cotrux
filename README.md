# Cotrux

Cotrux is a consent-first remote desktop platform for controlling authorized computers from a browser, installable PWA, iPhone/iPad, or another computer.

It combines a desktop host agent, a WebRTC controller, trusted unattended access, and an optional persistent Windows workspace that behaves like a separate computer running inside the physical client PC.

## Live links

- **Web / PWA controller:** https://farshoffs.github.io/cotrux/
- **Windows installer:** https://github.com/farshoffs/cotrux/releases/download/desktop-latest/Cotrux-Setup.exe
- **Latest desktop release:** https://github.com/farshoffs/cotrux/releases/tag/desktop-latest
- **Production signaling service:** `wss://cotrux-production.up.railway.app/ws`
- **Service health:** https://cotrux-production.up.railway.app/health

The Windows download uses a stable `desktop-latest` release asset. Successful main-branch desktop builds replace that release automatically, so the PWA download button stays current.

---

## What Cotrux includes

### Desktop Agent

The Electron desktop application provides:

- screen capture,
- mouse control,
- keyboard control,
- scrolling,
- clipboard-to-host,
- trusted unattended access,
- trusted-device revocation,
- start-with-Windows support,
- system tray/background operation,
- GUI network settings,
- Persistent Workspace management,
- automatic Cotrux guest provisioning.

Normal users do not need CMD or Terminal for regular Cotrux operation.

### Web / PWA Controller

The controller works from modern desktop browsers and mobile Safari/Chrome and can be installed as a PWA.

When a connection succeeds, the dashboard is replaced by a dedicated full-viewport remote session rather than keeping the desktop inside a small video card.

Remote controls currently include:

- full-screen remote workspace,
- portrait and landscape layouts,
- pinch-to-zoom,
- zoom from 50% to 400%,
- zoom +/- controls,
- Fit view,
- Fill view,
- 100% / remote-pixel view,
- pan and recenter,
- Direct Touch mode,
- Trackpad mode,
- Pan mode,
- left click,
- right click,
- drag-and-drop,
- two-finger scrolling in Trackpad mode,
- mouse-wheel scrolling,
- Ctrl/mouse-wheel local zoom on desktop browsers,
- mobile typing field,
- modifier keys,
- special keys,
- F1-F12,
- common Windows and application shortcuts,
- clipboard send,
- fullscreen,
- orientation control where supported.

### Keyboard and shortcut controls

The mobile keyboard drawer includes:

- Ctrl
- Alt
- Shift
- Windows / Meta
- Esc
- Tab
- Enter
- Backspace
- Delete
- Home / End
- Page Up / Page Down
- Arrow keys
- F1-F12

Built-in shortcut buttons include:

- Alt + Tab
- Win + D
- Win + E
- Win + R
- Ctrl + Shift + Esc
- Alt + F4
- Ctrl + C / V / X
- Ctrl + A
- Ctrl + Z / Y
- Ctrl + S
- Ctrl + F
- Ctrl + L
- Ctrl + T
- Ctrl + W
- Ctrl + Shift + T

Windows protects the Secure Attention Sequence, so synthetic **Ctrl + Alt + Delete** is not exposed yet. Supporting it properly will require a privileged Windows service rather than pretending a normal desktop process can send it.

---

## Connection modes

### One-time pairing

1. Open Cotrux on the computer to be controlled.
2. Cotrux shows a six-digit pairing PIN.
3. Open the Cotrux web/PWA controller.
4. Enter the PIN.
5. The host shows a visible access request.
6. Approve the session.
7. WebRTC negotiation begins and the full-screen controller opens.

The normal pairing PIN rotates after sessions.

### Trusted unattended access

Unattended access is optional and disabled until explicitly enabled on the host.

1. Enable **Unattended Access** in the Cotrux desktop GUI.
2. Connect once using the normal PIN.
3. Approve the controller with **Trust this controller** enabled.
4. The controller is saved under **Your Computers**.
5. Future connections from that trusted controller can start without re-entering the six-digit PIN.

Each trusted controller receives its own credential. Cotrux does not use one shared permanent unattended password.

The host can revoke individual trusted controllers or use **Revoke all**.

### Start with computer

On supported desktop platforms, Cotrux can start automatically with the computer and remain available from the system tray/background.

---

## Persistent Workspace

Persistent Workspace is Cotrux's "computer inside a computer" mode.

Instead of controlling the physical user's active desktop, Cotrux creates a separate Hyper-V Windows virtual machine. The person sitting at the physical PC can continue using their normal desktop while a remote Cotrux operator works inside the independent VM.

### What persists

The workspace uses a persistent VHDX rather than Windows Sandbox.

Cotrux preserves:

- Windows installation,
- installed applications,
- files,
- Windows settings,
- Cotrux guest configuration,
- Hyper-V saved VM state.

Cotrux intentionally does not provide a **Delete Workspace** button.

### VM configuration

The current setup creates:

- Generation 2 Hyper-V VM,
- dynamic 100 GB VHDX,
- Secure Boot,
- virtual TPM,
- Hyper-V networking,
- dynamic memory,
- at least 2 virtual CPUs.

Hyper-V is configured with:

- **AutomaticStartAction = Start**
- **AutomaticStopAction = Save**

That means the VM is configured to start with the host and save its running state when the host shuts down instead of being destroyed.

### Host requirements

Persistent Workspace currently targets supported Windows editions with Client Hyper-V, such as Windows Pro, Enterprise, Education, or equivalent Hyper-V-capable editions.

The host also needs:

- hardware virtualization enabled,
- SLAT support,
- enough RAM for both the physical host and VM,
- a Windows installation ISO for initial guest setup.

The Windows installation inside the VM requires its own valid licensing/activation.

---

## Automatic guest provisioning

After Windows is installed in the Persistent Workspace, Cotrux can bootstrap the guest agent from the host GUI.

1. Open the Persistent Workspace and finish Windows setup once.
2. Sign in to the Windows account inside the VM.
3. In host Cotrux, enter that guest Windows username and password.
4. Select **Install & Configure Cotrux**.

Cotrux then:

- connects from the Hyper-V host to the guest using PowerShell Direct,
- downloads the latest stable Cotrux installer on the host,
- transfers the installer into the VM,
- installs Cotrux silently inside the guest,
- creates a Cotrux guest logon task,
- configures the production Cotrux signaling server,
- enables unattended access for the guest instance,
- assigns a persistent first-pairing PIN,
- displays that pairing PIN in the host Cotrux GUI.

Use that workspace PIN once in the PWA. The VM then becomes a separate trusted Cotrux computer.

The guest password is used only during the provisioning operation and is not written to Cotrux workspace state.

PowerShell Direct requires the guest Windows installation to be running and a valid guest username/password.

---

## Architecture

```text
Controller
  Web / PWA / iPhone / iPad
        |
        | WebSocket signaling
        v
Cotrux Signaling Service
  Railway
        |
        | pairing + WebRTC negotiation
        v
Desktop Agent
  Electron
        |
        +---- Physical desktop
        |
        +---- Hyper-V Persistent Workspace
                |
                +---- separate Windows guest
                +---- separate Cotrux agent
```

Desktop media and control data use WebRTC peer connections. The signaling server coordinates pairing and SDP/ICE exchange but is not intended to relay the desktop video itself.

---

## WebRTC and TURN

Cotrux currently uses STUN for direct WebRTC connectivity.

An example coturn configuration is available at:

```text
infra/coturn/turnserver.conf.example
```

Some corporate networks, carrier NAT environments, and restrictive firewalls require TURN for reliable connectivity.

TURN credentials can be entered in both the Cotrux desktop agent and controller.

A production TURN deployment is still recommended before treating Cotrux as a TeamViewer-level internet connectivity solution.

---

## Production services

### Railway

The active Cotrux signaling/backend service is deployed on Railway.

```text
WebSocket:
wss://cotrux-production.up.railway.app/ws

Health:
https://cotrux-production.up.railway.app/health
```

The service:

- handles pairing,
- handles trusted-device reconnects,
- relays WebRTC signaling,
- rate-limits pairing attempts,
- serves controller assets when used directly,
- stores active host/session state in memory.

### GitHub Pages

The public controller PWA is deployed at:

```text
https://farshoffs.github.io/cotrux/
```

GitHub Pages provides the static PWA while the controller connects to the Railway WebSocket service.

The PWA also contains a permanent **Download Cotrux for Windows** button.

---

## Desktop installers

GitHub Actions builds the Cotrux desktop agent for:

- Windows — NSIS installer
- macOS — Electron application build
- Linux — AppImage

The Windows main-branch build is automatically republished as:

```text
https://github.com/farshoffs/cotrux/releases/download/desktop-latest/Cotrux-Setup.exe
```

The current desktop packages are unsigned. Proper Windows code signing and macOS signing/notarization are still required for polished public distribution.

---

## iPhone / iPad

### PWA

Open:

```text
https://farshoffs.github.io/cotrux/
```

in Safari and use **Add to Home Screen**.

The remote UI automatically adapts between portrait and landscape layouts.

### Native iOS wrapper

Capacitor scaffolding is included in `apps/controller`.

```bash
npm install
npm run build:controller
cd apps/controller
npm run ios:add
npm run ios:sync
npm run ios:open
```

Xcode and Apple signing are required for TestFlight/App Store distribution.

---

## Local development

Requires Node.js 22.12 or newer.

Install dependencies:

```bash
npm install
```

Run the signaling service:

```bash
npm run dev:signal
```

Run the controller:

```bash
npm run dev:controller
```

Run the Electron host:

```bash
npm run dev:agent
```

Build controller assets:

```bash
npm run build:controller
```

Build desktop packages:

```bash
npm run dist:agent
```

Run signaling tests:

```bash
npm run test:signal
```

---

## Docker deployment

The Cotrux web/signaling service can also be built from the repository root.

```bash
docker build -f services/signal/Dockerfile -t cotrux .
docker run --rm -p 8787:8787 -e PORT=8787 -e TRUST_PROXY=1 cotrux
```

A reverse proxy can terminate TLS and proxy WebSocket upgrades to `/ws`.

---

## Security model

Cotrux is intended for systems the operator owns or is authorized to control.

Current protections include:

- visible first-time pairing request,
- optional unattended access explicitly enabled by the host,
- per-controller trusted credentials,
- host-side trusted-device revocation,
- no shared permanent unattended password,
- host-side stop-session control,
- rotating normal pairing PIN,
- server-side PIN attempt rate limiting,
- bounded WebSocket message size,
- bounded clipboard and typed-text payloads,
- WebRTC DTLS/SRTP encryption,
- no keylogging,
- no hidden surveillance mode,
- no stealth installation workflow.

Persistent Workspace guest provisioning uses the supplied guest credential only for the provisioning session. Cotrux does not persist the guest password in its workspace state.

Before broad production deployment, Cotrux should still add authenticated user accounts, stronger device identity/public-key enrollment, audit logs, automatic updates, TURN time-limited credentials, installer signing, native privileged-service architecture, and a dedicated security review.

---

## Current limitations

Cotrux is still an evolving remote-desktop platform. Important current limitations include:

- TURN infrastructure is optional but not yet bundled as a production Cotrux relay service.
- Ctrl + Alt + Delete requires a future privileged Windows service.
- Multi-monitor selection is not yet exposed; the desktop agent currently targets the primary display.
- Remote audio is not implemented.
- File transfer is not implemented.
- Clipboard currently focuses on controller-to-host transfer.
- Native iOS packaging still requires Xcode/signing.
- Desktop installers are unsigned.
- Wayland may restrict synthetic input on some Linux systems.
- Persistent Workspace currently targets Hyper-V-capable Windows editions.
- The guest must have a usable interactive Windows session for the current Electron screen-control agent.

---

## Verification and CI

`Validate Cotrux` currently checks:

- dependency installation,
- JavaScript syntax,
- signaling integration,
- trusted unattended pairing,
- PWA build.

The desktop build workflow additionally:

- builds Windows/macOS/Linux packages,
- validates the Hyper-V PowerShell helper on a Windows runner,
- uploads desktop artifacts,
- republishes the stable `desktop-latest` Windows installer.

GitHub Pages deployment runs automatically for controller updates.

---

## Project layout

```text
apps/
  agent/
    Electron desktop host
    Hyper-V workspace management
    guest provisioning helper

  controller/
    Web/PWA remote controller
    iOS Capacitor scaffold

services/
  signal/
    HTTP + WebSocket signaling service

infra/
  coturn/
    TURN configuration example

.github/
  workflows/
    CI
    Pages deployment
    desktop builds
    stable Windows release publishing
```

---

## Project status

Cotrux currently has working implementations for:

- remote screen streaming,
- mouse and keyboard control,
- mobile/PWA controller,
- full-screen remote UI,
- zoom/pan/touch controls,
- keyboard shortcuts,
- trusted unattended access,
- persistent Hyper-V workspaces,
- automatic guest Cotrux provisioning,
- Railway signaling deployment,
- GitHub Pages controller deployment,
- automated Windows/macOS/Linux builds,
- stable Windows installer publishing.

The next major infrastructure milestone is a production TURN relay plus the Windows privileged service required for deeper system controls such as Secure Attention Sequence support.
