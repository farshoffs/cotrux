import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, nativeImage, screen, session, Tray } from "electron";
import { mouse, keyboard, Button, Key, Point } from "@nut-tree-fork/nut-js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SIGNAL_URL = "wss://cotrux-production.up.railway.app/ws";

mouse.config.mouseSpeed = 2200;
keyboard.config.autoDelayMs = 0;

let mainWindow;
let tray;
let quitting = false;

function configPath() {
  return path.join(app.getPath("userData"), "cotrux-config.json");
}

function readConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {}

  const next = {
    deviceId: typeof stored.deviceId === "string" && stored.deviceId ? stored.deviceId : crypto.randomUUID(),
    signalUrl: typeof stored.signalUrl === "string" && stored.signalUrl ? stored.signalUrl : DEFAULT_SIGNAL_URL,
    turnUrl: typeof stored.turnUrl === "string" ? stored.turnUrl : "",
    turnUser: typeof stored.turnUser === "string" ? stored.turnUser : "",
    turnPass: typeof stored.turnPass === "string" ? stored.turnPass : "",
    unattendedEnabled: Boolean(stored.unattendedEnabled),
    trustedDevices: Array.isArray(stored.trustedDevices) ? stored.trustedDevices.slice(0, 50) : []
  };

  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  }
  return next;
}

function saveConfigPatch(patch = {}) {
  const current = readConfig();
  const next = { ...current };

  for (const key of ["signalUrl", "turnUrl", "turnUser", "turnPass"]) {
    if (typeof patch[key] === "string") next[key] = patch[key].slice(0, key === "turnPass" ? 512 : 1024);
  }
  if (typeof patch.unattendedEnabled === "boolean") next.unattendedEnabled = patch.unattendedEnabled;

  if (Array.isArray(patch.trustedDevices)) {
    next.trustedDevices = patch.trustedDevices.slice(0, 50).map(item => ({
      controllerId: String(item?.controllerId || "").slice(0, 128),
      name: String(item?.name || "Trusted controller").slice(0, 80),
      tokenHash: String(item?.tokenHash || "").toLowerCase().slice(0, 64),
      addedAt: Number(item?.addedAt || Date.now())
    })).filter(item => item.controllerId && /^[a-f0-9]{64}$/.test(item.tokenHash));
  }

  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function startAtLoginSupported() {
  return process.platform === "win32" || process.platform === "darwin";
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

function createWindow() {
  const hiddenStartup = process.argv.includes("--hidden");
  mainWindow = new BrowserWindow({
    width: 680,
    height: 850,
    minWidth: 540,
    minHeight: 680,
    show: !hiddenStartup,
    backgroundColor: "#090b10",
    title: "Cotrux",
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
    if (quitting) return;
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

  ipcMain.handle("cotrux:get-config", () => ({
    ...readConfig(),
    computerName: os.hostname(),
    startup: getStartupState()
  }));

  ipcMain.handle("cotrux:save-config", (_event, patch) => saveConfigPatch(patch));
  ipcMain.handle("cotrux:set-startup", (_event, enabled) => setStartupState(enabled));
  ipcMain.handle("cotrux:show-window", showWindow);

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
  if (quitting) app.quit();
});
