import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, session } from "electron";
import { mouse, keyboard, Button, Key, Point } from "@nut-tree-fork/nut-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

mouse.config.mouseSpeed = 2200;
keyboard.config.autoDelayMs = 0;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 520,
    minHeight: 650,
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

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
