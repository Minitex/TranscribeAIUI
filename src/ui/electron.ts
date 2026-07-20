// Single typed access point for the nodeIntegration globals.
// Centralizing the bridge here means a future preload / context-isolation
// migration only has to touch this one file instead of every component.
const nodeRequire = (window as unknown as { require: NodeRequire }).require;

export const ipcRenderer: Electron.IpcRenderer = nodeRequire('electron').ipcRenderer;
export const fs = nodeRequire('fs') as typeof import('fs');
export const os = nodeRequire('os') as typeof import('os');
export const path = nodeRequire('path') as typeof import('path');
export const url = nodeRequire('url') as typeof import('url');
