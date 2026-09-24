import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cotrux", {
  control: payload => ipcRenderer.invoke("cotrux:control", payload),
  displayInfo: () => ipcRenderer.invoke("cotrux:display-info"),
  getConfig: () => ipcRenderer.invoke("cotrux:get-config"),
  saveConfig: patch => ipcRenderer.invoke("cotrux:save-config", patch),
  setStartup: enabled => ipcRenderer.invoke("cotrux:set-startup", enabled),
  showWindow: () => ipcRenderer.invoke("cotrux:show-window"),
  workspaceStatus: () => ipcRenderer.invoke("cotrux:workspace-status"),
  workspaceStart: () => ipcRenderer.invoke("cotrux:workspace-start"),
  workspaceStop: () => ipcRenderer.invoke("cotrux:workspace-stop"),
  workspaceConnect: () => ipcRenderer.invoke("cotrux:workspace-connect"),
  openWindowsFeatures: () => ipcRenderer.invoke("cotrux:windows-features")
});
