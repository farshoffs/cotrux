import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, nativeImage, screen, session, Tray } from "electron";
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
const isBackgroundWorkspace = process.argv.includes("--background-workspace");
const dataDirArg = process.argv.find(arg => arg.startsWith("--data-dir="));

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

function generatePairingPin() {
  const bytes = crypto.randomBytes(4);
  return String(bytes.readUInt32BE(0) % 1000000).padStart(6, "0");
}

function workspaceRoot() {
  return path.join(app.getPath("userData"), "BackgroundWorkspace");
}

function workspaceDataDir() {
  return path.join(workspaceRoot(), "Data");
}

function workspaceConfigPath() {
  return path.join(workspaceDataDir(), "cotrux-config.json");
}

function workspaceStatePath() {
  return path.join(workspaceRoot(), "workspace-state.json");
}

function ensureWorkspaceState() {
  const existing = readJsonFile(workspaceStatePath(), {});
  const state = {
    sandboxId: typeof existing.sandboxId === "string" ? existing.sandboxId : "",
    deviceId: typeof existing.deviceId === "string" && existing.deviceId ? existing.deviceId : crypto.randomUUID(),
    pairingPin: /^\d{6}$/.test(String(existing.pairingPin || "")) ? String(existing.pairingPin) : generatePairingPin(),
    createdAt: Number(existing.createdAt || Date.now())
  };
  writeJsonFile(workspaceStatePath(), state);
  return state;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function hasWindowsSandboxCli() {
  if (process.platform !== "win32" || isBackgroundWorkspace) return false;
  try {
    await execFileAsync("wsb.exe", ["--help"], {
      windowsHide: true,
      timeout: 7000,
      encoding: "utf8"
    });
    return true;
  } catch {
    return false;
  }
}

function syncWorkspaceConfig() {
  const hostConfig = readConfig();
  const state = ensureWorkspaceState();
  const existing = readJsonFile(workspaceConfigPath(), {});

  const workspaceConfig = {
    ...existing,
    deviceId: state.deviceId,
    signalUrl: hostConfig.signalUrl || DEFAULT_SIGNAL_URL,
    turnUrl: hostConfig.turnUrl || "",
    turnUser: hostConfig.turnUser || "",
    turnPass: hostConfig.turnPass || "",
    unattendedEnabled: true,
    trustedDevices: Array.isArray(existing.trustedDevices) ? existing.trustedDevices : [],
    backgroundWorkspace: true,
    pairingPin: /^\d{6}$/.test(String(existing.pairingPin || ""))
      ? String(existing.pairingPin)
      : state.pairingPin,
    displayName: "Background Workspace"
  };

  state.pairingPin = workspaceConfig.pairingPin;
  writeJsonFile(workspaceStatePath(), state);
  writeJsonFile(workspaceConfigPath(), workspaceConfig);
  return { state, workspaceConfig };
}

async function getBackgroundWorkspaceStatus() {
  if (isBackgroundWorkspace) {
    return {
      supported: false,
      running: false,
      workspaceMode: true,
      reason: "Background Workspace is already running inside the isolated session."
    };
  }

  if (process.platform !== "win32") {
    return {
      supported: false,
      running: false,
      reason: "Background Workspace is currently available on Windows only."
    };
  }

  if (!app.isPackaged) {
    return {
      supported: false,
      running: false,
      reason: "Install a packaged Cotrux desktop build to use Background Workspace."
    };
  }

  const cliAvailable = await hasWindowsSandboxCli();
  if (!cliAvailable) {
    return {
      supported: false,
      running: false,
      reason: "Requires Windows 11 24H2 or newer with Windows Sandbox enabled."
    };
  }

  const { state, workspaceConfig } = syncWorkspaceConfig();
  let running = false;

  if (state.sandboxId) {
    try {
      const { stdout = "" } = await execFileAsync("wsb.exe", ["list", "--raw"], {
        windowsHide: true,
        timeout: 10000,
        encoding: "utf8"
      });
      running = String(stdout).toLowerCase().includes(state.sandboxId.toLowerCase());
    } catch {
      running = false;
    }
  }

  if (!running && state.sandboxId) {
    state.sandboxId = "";
    writeJsonFile(workspaceStatePath(), state);
  }

  return {
    supported: true,
    running,
    sandboxId: running ? state.sandboxId : "",
    deviceId: state.deviceId,
    pairingPin: workspaceConfig.pairingPin,
    name: workspaceConfig.displayName || "Background Workspace"
  };
}

function extractSandboxId(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    const stack = [parsed];
    while (stack.length) {
      const item = stack.pop();
      if (typeof item === "string") {
        const match = item.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (match) return match[0];
      } else if (item && typeof item === "object") {
        stack.push(...Object.values(item));
      }
    }
  } catch {}

  return raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";
}

async function startBackgroundWorkspace() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.supported) return status;
  if (status.running) return status;

  const { state, workspaceConfig } = syncWorkspaceConfig();
  const appDir = path.dirname(process.execPath);
  const root = workspaceRoot();
  fs.mkdirSync(workspaceDataDir(), { recursive: true });

  const configXml = [
    "<Configuration>",
    "  <Networking>Enable</Networking>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    "      <HostFolder>" + xmlEscape(appDir) + "</HostFolder>",
    "      <SandboxFolder>C:\\CotruxApp</SandboxFolder>",
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    "      <HostFolder>" + xmlEscape(root) + "</HostFolder>",
    "      <SandboxFolder>C:\\CotruxWorkspace</SandboxFolder>",
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    "    <Command>C:\\CotruxApp\\Cotrux.exe --background-workspace --data-dir=C:\\CotruxWorkspace\\Data --hidden</Command>",
    "  </LogonCommand>",
    "  <MemoryInMB>4096</MemoryInMB>",
    "</Configuration>"
  ].join("");

  try {
    const { stdout = "" } = await execFileAsync("wsb.exe", [
      "start",
      "--config",
      configXml,
      "--raw"
    ], {
      windowsHide: true,
      timeout: 45000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });

    const sandboxId = extractSandboxId(stdout);
    if (!sandboxId) {
      return {
        ...status,
        running: false,
        error: "Windows Sandbox started but Cotrux could not read its session ID."
      };
    }

    state.sandboxId = sandboxId;
    state.pairingPin = workspaceConfig.pairingPin;
    writeJsonFile(workspaceStatePath(), state);

    return {
      supported: true,
      running: true,
      sandboxId,
      deviceId: state.deviceId,
      pairingPin: workspaceConfig.pairingPin,
      name: workspaceConfig.displayName || "Background Workspace"
    };
  } catch (error) {
    return {
      ...status,
      running: false,
      error: String(error?.stderr || error?.message || error).slice(0, 800)
    };
  }
}

async function stopBackgroundWorkspace() {
  const state = ensureWorkspaceState();
  if (!state.sandboxId) return getBackgroundWorkspaceStatus();

  try {
    await execFileAsync("wsb.exe", ["stop", "--id", state.sandboxId, "--raw"], {
      windowsHide: true,
      timeout: 30000,
      encoding: "utf8"
    });
  } catch (error) {
    const current = await getBackgroundWorkspaceStatus();
    if (current.running) {
      return { ...current, error: String(error?.stderr || error?.message || error).slice(0, 800) };
    }
  }

  state.sandboxId = "";
  writeJsonFile(workspaceStatePath(), state);
  return getBackgroundWorkspaceStatus();
}

async function connectBackgroundWorkspace() {
  const status = await getBackgroundWorkspaceStatus();
  if (!status.running || !status.sandboxId) return { ...status, opened: false };

  try {
    const child = spawn("wsb.exe", ["connect", "--id", status.sandboxId], {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return { ...status, opened: true };
  } catch (error) {
    return { ...status, opened: false, error: String(error?.message || error).slice(0, 800) };
  }
}

function openWindowsFeatures() {
  if (process.platform !== "win32") return { ok: false };
  try {
    const child = spawn("OptionalFeatures.exe", [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false };
  }
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
  ipcMain.handle("cotrux:windows-features", openWindowsFeatures);

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
