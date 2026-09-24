import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cotrux", {
  control: payload => ipcRenderer.invoke("cotrux:control", payload),
  displayInfo: () => ipcRenderer.invoke("cotrux:display-info")
});
