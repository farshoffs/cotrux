import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import { mouse, keyboard, Button, Key, Point } from "@nut-tree-fork/nut-js";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const DEFAULT_SIGNAL_URL = "wss://cotrux-production.up.railway.app/ws";
const LATEST_WINDOWS_INSTALLER = "https://github.com/farshoffs/cotrux/releases/download/desktop-latest/Cotrux-Setup.exe";
const isBackgroundWorkspace = process.argv.includes("--background-workspace");
const isWorkspaceBootstrap = process.argv.includes("--workspace-bootstrap");
const dataDirArg = process.argv.find(arg => arg.startsWith("--data-dir="));
const signalUrlArg = process.argv.find(arg => arg.startsWith("--signal-url="));
const pairingPinArg = process.argv.find(arg => arg.startsWith("--pairing-pin="));
const displayNameArg = process.argv.find(arg => arg.startsWith("--display-name="));

if (dataDirArg) {
  const customDataDir = decodeURIComponent(dataDirArg.slice("--data-dir=".length));
  if (customDataDir) {
    fs.mkdirSync(customDataDir, { recursive: true });
    app.setPath("userData", customDataDir);
  }
}

mouse.config.mouseSpeed = 2200;
keyboard.config.autoDelayMs = 0;

let mainWindow;
let tray;
let quitting = false;

function configPath() {
  return path.join(app.getPath("userData"), "cotrux-config.json");
}

function readJsonFile(filename, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function readConfig() {
  const stored = readJsonFile(configPath(), {});
  const next = {
    deviceId: typeof stored.deviceId === "string" && stored.deviceId ? stored.deviceId : crypto.randomUUID(),
    signalUrl: typeof stored.signalUrl === "string" && stored.signalUrl ? stored.signalUrl : DEFAULT_SIGNAL_URL,
    turnUrl: typeof stored.turnUrl === "string" ? stored.turnUrl : "",
    turnUser: typeof stored.turnUser === "string" ? stored.turnUser : "",
    turnPass: typeof stored.turnPass === "string" ? stored.turnPass : "",
    unattendedEnabled: Boolean(stored.unattendedEnabled),
    trustedDevices: Array.isArray(stored.trustedDevices) ? stored.trustedDevices.slice(0, 50) : [],
    backgroundWorkspace: Boolean(stored.backgroundWorkspace || isBackgroundWorkspace),
    pairingPin: /^\d{6}$/.test(String(stored.pairingPin || "")) ? String(stored.pairingPin) : "",
    displayName: typeof stored.displayName === "string" ? stored.displayName.slice(0, 80) : ""
  };

  if (JSON.stringify(next) !== JSON.stringify(stored)) writeJsonFile(configPath(), next);
  return next;
}

function saveConfigPatch(patch = {}) {
  const current = readConfig();
  const next = { ...current };

  for (const key of ["signalUrl", "turnUrl", "turnUser", "turnPass", "displayName"]) {
    if (typeof patch[key] === "string") next[key] = patch[key].slice(0, key === "turnPass" ? 512 : 1024);
  }

  if (typeof patch.unattendedEnabled === "boolean") next.unattendedEnabled = patch.unattendedEnabled;
  if (typeof patch.backgroundWorkspace === "boolean") next.backgroundWorkspace = patch.backgroundWorkspace;

  if (typeof patch.pairingPin === "string" && /^\d{6}$/.test(patch.pairingPin)) {
    next.pairingPin = patch.pairingPin;
  }

  if (Array.isArray(patch.trustedDevices)) {
    next.trustedDevices = patch.trustedDevices.slice(0, 50).map(item => ({
      controllerId: String(item?.controllerId || "").slice(0, 128),
      name: String(item?.name || "Trusted controller").slice(0, 80),
      tokenHash: String(item?.tokenHash || "").toLowerCase().slice(0, 64),
      addedAt: Number(item?.addedAt || Date.now())
    })).filter(item => item.controllerId && /^[a-f0-9]{64}$/.test(item.tokenHash));
  }

  writeJsonFile(configPath(), next);
  return next;
}

function startAtLoginSupported() {
  return !isBackgroundWorkspace && (process.platform === "win32" || process.platform === "darwin");
}

function getStartupState() {
  if (!startAtLoginSupported()) return { supported: false, enabled: false };
  try {
    return { supported: true, enabled: Boolean(app.getLoginItemSettings().openAtLogin) };
  } catch {
    return { supported: false, enabled: false };
  }
}

function setStartupState(enabled) {
  if (!startAtLoginSupported()) return getStartupState();
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    args: enabled && process.platform === "win32" ? ["--hidden"] : []
  });
  return getStartupState();
}

function workspaceRoot() {
  return path.join(app.getPath("home"), "Cotrux Workspaces", "Persistent Workspace");
}

function workspaceStatePath() {
  return path.join(workspaceRoot(), "workspace-state.json");
}

const WORKSPACE_VM_NAME = "Cotrux Persistent Workspace";

function generatePairingPin() {
  const bytes = crypto.randomBytes(4);
  return String(bytes.readUInt32BE(0) % 1000000).padStart(6, "0");
}

function ensureWorkspaceState() {
  const existing = readJsonFile(workspaceStatePath(), {});
  const state = {
    vmName: WORKSPACE_VM_NAME,
    isoPath: typeof existing.isoPath === "string" ? existing.isoPath : "",
    vhdPath: typeof existing.vhdPath === "string" && existing.vhdPath
      ? existing.vhdPath
      : path.join(workspaceRoot(), "Cotrux-Persistent-Workspace.vhdx"),
    pairingPin: /^\d{6}$/.test(String(existing.pairingPin || "")) ? String(existing.pairingPin) : "",
    guestUsername: typeof existing.guestUsername === "string" ? existing.guestUsername.slice(0, 120) : "",
    provisionedAt: Number(existing.provisionedAt || 0),
    bootstrapPreparedAt: Number(existing.bootstrapPreparedAt || 0),
    createdAt: Number(existing.createdAt || Date.now())
  };
  writeJsonFile(workspaceStatePath(), state);
  return state;
}

function hypervHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "hyperv-manager.ps1")
    : path.join(__dirname, "hyperv-manager.ps1");
}

async function runHyperVHelper(action, extra = {}) {
  const resultPath = path.join(app.getPath("temp"), "cotrux-hyperv-" + crypto.randomUUID() + ".json");
  const state = ensureWorkspaceState();
  const totalMemoryMB = Math.floor(os.totalmem() / 1024 / 1024);
  const startupMemoryMB = Math.max(4096, Math.min(8192, Math.floor(totalMemoryMB / 3)));
  const maxMemoryMB = Math.max(startupMemoryMB, Math.min(12288, Math.floor(totalMemoryMB / 2)));
  const processors = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2) || 2));

  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", hypervHelperPath(),
    "-Action", action,
    "-VmName", state.vmName,
    "-VhdPath", state.vhdPath,
    "-IsoPath", extra.isoPath ?? state.isoPath,
    "-MemoryMB", String(startupMemoryMB),
    "-MaxMemoryMB", String(maxMemoryMB),
    "-Processors", String(processors),
    "-ResultPath", resultPath
  ];

  if (typeof extra.guestUsername === "string" && extra.guestUsername) {
    args.push("-GuestUsername", extra.guestUsername);
  }
  if (typeof extra.signalUrl === "string" && extra.signalUrl) {
    args.push("-SignalUrl", extra.signalUrl);
  }
  if (typeof extra.pairingPin === "string" && extra.pairingPin) {
    args.push("-PairingPin", extra.pairingPin);
  }
  if (typeof extra.installerUrl === "string" && extra.installerUrl) {
    args.push("-InstallerUrl", extra.installerUrl);
  }

  try {
    await execFileAsync("powershell.exe", args, {
      windowsHide: true,
      timeout: action === "create" || action === "enable" || action === "provision" || action === "prepare-bootstrap"
        ? 15 * 60 * 1000
        : 90 * 1000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        COTRUX_GUEST_PASSWORD: typeof extra.guestPassword === "string" ? extra.guestPassword : ""
      }
    });
  } catch (error) {
    if (!fs.existsSync(resultPath)) {
      return { ok: false, error: String(error?.stderr || error?.message || error).slice(0, 1200) };
    }
  }

  try {
    return readJsonFile(resultPath, { ok: false, error: "Hyper-V helper returned no result." });
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch {}
  }
}

function editionSupportsHyperV(edition = "") {
  return /professional|enterprise|education|workstation|server/i.test(String(edition));
}

async function getBackgroundWorkspaceStatus() {
  if (isBackgroundWorkspace) {
    return { supported: false, configured: false, running: false, workspaceMode: true, reason: "This Cotrux instance is already running inside a workspace." };
  }
  if (process.platform !== "win32") {
    return { supported: false, configured: false, running: false, reason: "Persistent Workspace is currently available on Windows only." };
  }

  const state = ensureWorkspaceState();
  const hv = await runHyperVHelper("status");
  const editionSupported = editionSupportsHyperV(hv.edition);

  if (!hv.hypervEnabled) {
    return {
      supported: editionSupported,
      hypervEnabled: false,
      configured: false,
      running: false,
      isoPath: state.isoPath,
      dataPath: state.vhdPath,
      edition: hv.edition || "",
      reason: editionSupported
        ? "Hyper-V is not enabled yet. Cotrux can enable it with a Windows UAC prompt."
        : "This Windows edition does not provide Client Hyper-V. Windows Pro, Enterprise or Education is required."
    };
  }

  return {
    supported: true,
    hypervEnabled: true,
    configured: Boolean(hv.exists),
    running: Boolean(hv.running),
    state: hv.state || "Unknown",
    vmName: state.vmName,
    isoPath: state.isoPath,
    dataPath: state.vhdPath,
    automaticStartAction: hv.automaticStartAction || "",
    automaticStopAction: hv.automaticStopAction || "",
    edition: hv.edition || "",
    provisioned: Boolean(state.provisionedAt),
    provisionedAt: state.provisionedAt || 0,
    bootstrapPrepared: Boolean(state.bootstrapPreparedAt),
    bootstrapPreparedAt: state.bootstrapPreparedAt || 0,
    guestUsername: state.guestUsername || "",
    pairingPin: state.pairingPin || "",
    error: hv.ok === false ? hv.error : "",
    reason: hv.exists
      ? (hv.running ? "Persistent Workspace is running independently of the physical desktop." : "Persistent Workspace is saved. Its VHDX, apps and files are still intact.")
      : (state.isoPath ? "Ready to create the persistent VM." : "Choose a Windows ISO once, then Cotrux will create a persistent 100 GB VHDX workspace.")
  };
}

async function enableHyperV() {
  if (process.platform !== "win32") return getBackgroundWorkspaceStatus();
  const result = await runHyperVHelper("enable");
  return { ...(await getBackgroundWorkspaceStatus()), restartNeeded: Boolean(result.restartNeeded), message: result.message || result.error || "" };
}

async function chooseWorkspaceIso() {
  if (process.platform !== "win32") return getBackgroundWorkspaceStatus();
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Choose x64 Windows ISO for Cotrux Persistent Workspace",
    buttonLabel: "Validate & Use ISO",
    properties: ["openFile"],
    filters: [{ name: "Windows ISO", extensions: ["iso"] }]
  });

  if (!selected.canceled && selected.filePaths[0]) {
    const candidate = selected.filePaths[0];
    const validation = await runHyperVHelper("validate-iso", { isoPath: candidate });
    if (!validation.ok) {
      return {
        ...(await getBackgroundWorkspaceStatus()),
        isoValidation: validation,
        error: validation.error || "This ISO cannot boot the Cotrux workspace."
      };
    }

    const state = ensureWorkspaceState();
    state.isoPath = candidate;
    writeJsonFile(workspaceStatePath(), state);
  }

  return getBackgroundWorkspaceStatus();
}

async function repairWorkspaceBoot() {
  if (process.platform !== "win32") return getBackgroundWorkspaceStatus();

  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "Replace Windows ISO and Repair Workspace Boot",
    buttonLabel: "Repair Boot",
    properties: ["openFile"],
    filters: [{ name: "Windows ISO", extensions: ["iso"] }]
  });

  if (selected.canceled || !selected.filePaths[0]) return getBackgroundWorkspaceStatus();

  const candidate = selected.filePaths[0];
  const validation = await runHyperVHelper("validate-iso", { isoPath: candidate });
  if (!validation.ok) {
    return {
      ...(await getBackgroundWorkspaceStatus()),
      isoValidation: validation,
      error: validation.error || "This ISO cannot boot the Cotrux workspace."
    };
  }

  const state = ensureWorkspaceState();
  state.isoPath = candidate;
  writeJsonFile(workspaceStatePath(), state);

  const result = await runHyperVHelper("repair-boot", { isoPath: candidate });
  const updated = await getBackgroundWorkspaceStatus();
  return {
    ...updated,
    repairResult: result,
    error: result.ok ? "" : (result.error || "Workspace boot repair failed.")
  };
}

async function startBackgroundWorkspace() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.supported || !status.hypervEnabled) return status;
  const state = ensureWorkspaceState();

  if (!status.configured) {
    if (!state.isoPath || !fs.existsSync(state.isoPath)) return { ...status, error: "Choose a valid Windows ISO before creating the workspace." };
    const result = await runHyperVHelper("create", { isoPath: state.isoPath });
    return { ...(await getBackgroundWorkspaceStatus()), operation: result };
  }

  if (!status.running) {
    const result = await runHyperVHelper("start");
    return { ...(await getBackgroundWorkspaceStatus()), operation: result };
  }

  return status;
}

async function stopBackgroundWorkspace() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.configured || !status.running) return status;
  const result = await runHyperVHelper("save");
  return { ...(await getBackgroundWorkspaceStatus()), operation: result };
}

async function connectBackgroundWorkspace() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.configured) return { ...status, opened: false };
  try {
    if (!status.running) await runHyperVHelper("start");
    const child = spawn("vmconnect.exe", ["localhost", WORKSPACE_VM_NAME], { windowsHide: false, detached: true, stdio: "ignore" });
    child.unref();
    return { ...(await getBackgroundWorkspaceStatus()), opened: true };
  } catch (error) {
    return { ...status, opened: false, error: String(error?.message || error).slice(0, 800) };
  }
}

async function openWindowsDownload() {
  await shell.openExternal("https://www.microsoft.com/software-download/windows11");
  return { ok: true };
}

async function prepareWorkspaceGuestBootstrap() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.configured) return { ...status, error: "Create the Persistent Workspace first." };

  if (!status.running) {
    const started = await runHyperVHelper("start");
    if (!started.ok) return { ...status, error: started.error || "Could not start the workspace." };
  }

  const state = ensureWorkspaceState();
  const pairingPin = state.pairingPin || generatePairingPin();
  const hostConfig = readConfig();

  const result = await runHyperVHelper("prepare-bootstrap", {
    signalUrl: hostConfig.signalUrl || DEFAULT_SIGNAL_URL,
    pairingPin,
    installerUrl: LATEST_WINDOWS_INSTALLER
  });

  if (result.ok) {
    state.pairingPin = pairingPin;
    state.bootstrapPreparedAt = Date.now();
    writeJsonFile(workspaceStatePath(), state);
    try { await connectBackgroundWorkspace(); } catch {}
  }

  const updated = await getBackgroundWorkspaceStatus();
  return {
    ...updated,
    bootstrapResult: result,
    error: result.ok ? "" : (result.error || "Could not prepare guest setup.")
  };
}

async function provisionWorkspaceGuest(credentials = {}) {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.configured) return { ...status, error: "Create the Persistent Workspace first." };

  const guestUsername = String(credentials.username || "").trim().slice(0, 120);
  const guestPassword = String(credentials.password || "");
  if (!guestUsername || !guestPassword) {
    return { ...status, error: "Enter the Windows username and password used inside the workspace." };
  }

  if (!status.running) {
    const started = await runHyperVHelper("start");
    if (!started.ok) return { ...status, error: started.error || "Could not start the workspace." };
  }

  const state = ensureWorkspaceState();
  const pairingPin = state.pairingPin || generatePairingPin();
  const hostConfig = readConfig();

  const result = await runHyperVHelper("provision", {
    guestUsername,
    guestPassword,
    signalUrl: hostConfig.signalUrl || DEFAULT_SIGNAL_URL,
    pairingPin,
    installerUrl: LATEST_WINDOWS_INSTALLER
  });

  if (result.ok) {
    state.pairingPin = pairingPin;
    state.guestUsername = guestUsername;
    state.provisionedAt = Date.now();
    writeJsonFile(workspaceStatePath(), state);
  }

  const updated = await getBackgroundWorkspaceStatus();
  return {
    ...updated,
    provisionResult: result,
    error: result.ok ? "" : (result.error || "Guest provisioning failed.")
  };
}



function createWindow() {
  const hiddenStartup = process.argv.includes("--hidden") || isBackgroundWorkspace;
  mainWindow = new BrowserWindow({
    width: 700,
    height: 900,
    minWidth: 540,
    minHeight: 680,
    show: !hiddenStartup,
    backgroundColor: "#090b10",
    title: isBackgroundWorkspace ? "Cotrux Background Workspace" : "Cotrux",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile("index.html");

  mainWindow.on("close", event => {
    if (quitting || isBackgroundWorkspace) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (isBackgroundWorkspace) return;
  const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAhUlEQVR42mNgoBvgP4P///8ZGBj+M8AAQ4wMDAz/GRgY/jMwMDAwMjIy/GeAAQYGBob/DDAwMDD8Z2BgYGD4zwADDDEyMjL8Z4ABBhkZGRn+MzAwMDD8Z4ABhhgZGxn+MzAwMDD8ZwABDDEyMjL8Z4ABBhkZGRn+MzAwMDD8Z4ABBgYGhv8MAAAJtCEfOJLaewAAAABJRU5ErkJggg==";
  const icon = nativeImage.createFromDataURL("data:image/png;base64," + png);
  tray = new Tray(icon);
  tray.setToolTip("Cotrux Remote");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Cotrux", click: showWindow },
    { type: "separator" },
    {
      label: "Quit Cotrux",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", showWindow);
}

function buttonFromName(name) {
  if (name === "right") return Button.RIGHT;
  if (name === "middle") return Button.MIDDLE;
  return Button.LEFT;
}

function keyFromEvent(code, key) {
  const direct = {
    Enter: ["Enter", "Return"],
    NumpadEnter: ["Enter", "Return"],
    Backspace: ["Backspace"],
    Tab: ["Tab"],
    Escape: ["Escape"],
    Delete: ["Delete"],
    Space: ["Space"],
    ArrowUp: ["Up"],
    ArrowDown: ["Down"],
    ArrowLeft: ["Left"],
    ArrowRight: ["Right"],
    Home: ["Home"],
    End: ["End"],
    PageUp: ["PageUp"],
    PageDown: ["PageDown"],
    ShiftLeft: ["LeftShift", "Shift"],
    ShiftRight: ["RightShift", "Shift"],
    ControlLeft: ["LeftControl", "Control"],
    ControlRight: ["RightControl", "Control"],
    AltLeft: ["LeftAlt", "Alt"],
    AltRight: ["RightAlt", "Alt"],
    MetaLeft: ["LeftSuper", "Super", "Meta"],
    MetaRight: ["RightSuper", "Super", "Meta"]
  };

  const names = direct[code] || direct[key] || [];
  for (const name of names) {
    if (Key[name] !== undefined) return Key[name];
  }

  const letter = /^Key([A-Z])$/.exec(code || "");
  if (letter && Key[letter[1]] !== undefined) return Key[letter[1]];

  const digit = /^Digit([0-9])$/.exec(code || "");
  if (digit) {
    for (const name of ["Num" + digit[1], "D" + digit[1], digit[1]]) {
      if (Key[name] !== undefined) return Key[name];
    }
  }

  const functionKey = /^F([1-9]|1[0-2])$/.exec(code || "");
  if (functionKey && Key["F" + functionKey[1]] !== undefined) return Key["F" + functionKey[1]];

  return null;
}

async function applyControl(event) {
  if (!event || typeof event !== "object") return;

  if (event.kind === "move") {
    const display = screen.getPrimaryDisplay();
    const bounds = display.bounds;
    const x = Math.max(0, Math.min(1, Number(event.x)));
    const y = Math.max(0, Math.min(1, Number(event.y)));
    await mouse.setPosition(new Point(
      Math.round(bounds.x + x * Math.max(1, bounds.width - 1)),
      Math.round(bounds.y + y * Math.max(1, bounds.height - 1))
    ));
    return;
  }

  if (event.kind === "mouse") {
    const button = buttonFromName(event.button);
    if (event.action === "down") await mouse.pressButton(button);
    if (event.action === "up") await mouse.releaseButton(button);
    return;
  }

  if (event.kind === "wheel") {
    const amount = Math.max(1, Math.min(12, Math.round(Math.abs(Number(event.dy || 0)) / 60)));
    if (Number(event.dy) > 0) await mouse.scrollDown(amount);
    else await mouse.scrollUp(amount);
    return;
  }

  if (event.kind === "text") {
    const value = String(event.text || "").slice(0, 5000);
    if (value) await keyboard.type(value);
    return;
  }

  if (event.kind === "clipboard") {
    clipboard.writeText(String(event.text || "").slice(0, 100000));
    return;
  }

  if (event.kind === "key") {
    const mapped = keyFromEvent(String(event.code || ""), String(event.key || ""));
    if (mapped !== null) {
      if (event.action === "down") await keyboard.pressKey(mapped);
      if (event.action === "up") await keyboard.releaseKey(mapped);
      if (event.action === "tap") {
        await keyboard.pressKey(mapped);
        await keyboard.releaseKey(mapped);
      }
      return;
    }

    if (event.action === "down" && typeof event.key === "string" && event.key.length === 1) {
      await keyboard.type(event.key);
    }
  }
}

app.whenReady().then(() => {
  if (isWorkspaceBootstrap) {
    const bootstrapPatch = {
      unattendedEnabled: true,
      backgroundWorkspace: true,
      signalUrl: signalUrlArg ? decodeURIComponent(signalUrlArg.slice("--signal-url=".length)) : DEFAULT_SIGNAL_URL,
      pairingPin: pairingPinArg ? pairingPinArg.slice("--pairing-pin=".length) : "",
      displayName: displayNameArg ? decodeURIComponent(displayNameArg.slice("--display-name=".length)) : "Cotrux Persistent Workspace"
    };
    saveConfigPatch(bootstrapPatch);
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: ["--background-workspace", "--hidden"]
      });
    } catch {}
  }

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 }
    });

    const primaryId = String(screen.getPrimaryDisplay().id);
    const source = sources.find(item => item.display_id === primaryId) || sources[0];
    callback({ video: source });
  }, { useSystemPicker: false });

  ipcMain.handle("cotrux:control", async (_event, payload) => {
    try {
      await applyControl(payload);
      return { ok: true };
    } catch (error) {
      console.error("Control error", error);
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle("cotrux:display-info", () => {
    const display = screen.getPrimaryDisplay();
    return {
      id: display.id,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor
    };
  });

  ipcMain.handle("cotrux:get-config", () => {
    const config = readConfig();
    return {
      ...config,
      computerName: config.displayName || (isBackgroundWorkspace ? "Background Workspace" : os.hostname()),
      workspaceMode: isBackgroundWorkspace,
      startup: getStartupState()
    };
  });

  ipcMain.handle("cotrux:save-config", (_event, patch) => saveConfigPatch(patch));
  ipcMain.handle("cotrux:set-startup", (_event, enabled) => setStartupState(enabled));
  ipcMain.handle("cotrux:show-window", showWindow);
  ipcMain.handle("cotrux:workspace-status", getBackgroundWorkspaceStatus);
  ipcMain.handle("cotrux:workspace-start", startBackgroundWorkspace);
  ipcMain.handle("cotrux:workspace-stop", stopBackgroundWorkspace);
  ipcMain.handle("cotrux:workspace-connect", connectBackgroundWorkspace);
  ipcMain.handle("cotrux:workspace-enable-hyperv", enableHyperV);
  ipcMain.handle("cotrux:workspace-choose-iso", chooseWorkspaceIso);
  ipcMain.handle("cotrux:workspace-repair-boot", repairWorkspaceBoot);
  ipcMain.handle("cotrux:workspace-download-windows", openWindowsDownload);
  ipcMain.handle("cotrux:workspace-provision", (_event, credentials) => provisionWorkspaceGuest(credentials));
  ipcMain.handle("cotrux:workspace-prepare-bootstrap", prepareWorkspaceGuestBootstrap);

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (quitting || isBackgroundWorkspace) app.quit();
});
