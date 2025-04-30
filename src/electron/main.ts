// src/electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, ChildProcess } from 'child_process';
import Store from 'electron-store';
import { isDev } from './util.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { getLogPath } from './logHelpers.js';

// Shim __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store for API key
const store = new Store<{ apiKey?: string }>();

// Track running process
let currentExec: ChildProcess | null = null;

// ── RECURSIVE SEARCH FOR SCRIPTS ──────────────────────────────────────────────
const ext = process.platform === 'win32' ? '.exe' : '';
const targetBinary = `audio_transcribe${ext}`;

function findScriptsDir(dir: string): string | null {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === targetBinary) {
        return dir;
      }
      if (entry.isDirectory()) {
        const found = findScriptsDir(full);
        if (found) return found;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

let scriptsDir: string;
if (isDev()) {
  scriptsDir = path.join(process.cwd(), 'python', 'dist');
} else {
  const base = path.join(app.getAppPath(), '..', 'app.asar.unpacked', 'python', 'dist');
  const found = findScriptsDir(base);
  if (!found) {
    dialog.showErrorBox(
      'Missing binaries',
      `Could not find "${targetBinary}" under:\n${base}\nPlease include python/dist in builder config.`
    );
    app.quit();
    process.exit(1);
  }
  scriptsDir = found;
}

const audioBin = path.join(scriptsDir, `audio_transcribe${ext}`);
const preprocessFn = path.join(scriptsDir, `preprocess_to_jpeg${ext}`);
const flashFn = path.join(scriptsDir, `flash_process_local_dir${ext}`);

for (const p of [audioBin, preprocessFn, flashFn]) {
  if (!fs.existsSync(p)) {
    dialog.showErrorBox('Missing binary', `Expected to find:\n${p}`);
    app.quit();
    process.exit(1);
  }
}

function runCommand(cmd: string, mode: string): Promise<string> {
  return new Promise((resolve, reject) => {
    currentExec = exec(cmd, { env: process.env }, async (err, stdout, stderr) => {
      if (stdout) await fs.promises.appendFile(getLogPath(mode), `[OUT] ${stdout}`);
      if (stderr) await fs.promises.appendFile(getLogPath(mode), `[ERR] ${stderr}`);
      currentExec = null;
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ── IPC HANDLERS ──────────────────────────────────────────────────────────────
ipcMain.handle('list-transcripts', async (_e, folder: string) => {
  const files = await fs.promises.readdir(folder);
  return files.filter(f => f.endsWith('.txt')).map(f => ({ name: f, path: path.join(folder, f) }));
});
ipcMain.handle('open-transcript', (_e, file: string) => shell.openPath(file));
ipcMain.handle('read-logs', async (_e, mode: string) => {
  try {
    return await fs.promises.readFile(getLogPath(mode), 'utf-8');
  } catch {
    return '';
  }
});
ipcMain.handle('clear-logs', (_e, mode: string) =>
  fs.promises.writeFile(getLogPath(mode), '', 'utf-8')
);
ipcMain.handle('cancel-transcription', () => {
  if (currentExec) {
    currentExec.kill();
    currentExec = null;
  }
});
ipcMain.handle('select-input-file', async (_e, mode: string = 'audio') => {
  const filters: Electron.FileFilter[] = mode === 'audio'
    ? [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a'] }]
    : [{ name: 'Image & PDF', extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'pdf'] }];
  const properties: Electron.OpenDialogOptions['properties'] =
    mode === 'audio' ? ['openFile'] : ['openFile', 'openDirectory'];
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties, filters });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('select-output-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('run-transcription', async (_e, mode: string, inputPath: string, outputDir: string) => {
  // clear previous logs
  await fs.promises.writeFile(getLogPath(mode), '', 'utf-8');

  const apiKey = (store.get('apiKey') || '').trim();
  if (!apiKey) throw new Error('API key not set. Please enter it in Settings.');
  process.env.GOOGLE_API_KEY = apiKey;

  const win = BrowserWindow.getAllWindows()[0];

  if (mode === 'audio') {
    const filename = path.basename(inputPath);
    win.webContents.send('transcription-progress', filename, 1, 1, 'Transcribing…');
    const cmd = `"${audioBin}" --input "${inputPath}" --output_dir "${outputDir}"`;
    try {
      const out = await runCommand(cmd, 'audio');
      win.webContents.send('transcription-progress', filename, 1, 1, 'Done');
      return out;
    } catch (err: any) {
      const cancelled = err.killed || err.signal === 'SIGTERM';
      win.webContents.send('transcription-progress', filename, 1, 1, cancelled ? 'Cancelled' : 'Error');
      if (cancelled) throw new Error('terminated by user');
      throw err;
    }
  }

  // IMAGE MODE WITH RESUME SUPPORT
  const stat = await fs.promises.stat(inputPath);
  const files = stat.isDirectory()
    ? (await fs.promises.readdir(inputPath))
      .filter(f => /\.(png|jpe?g|tif{1,2})$/i.test(f))
      .map(f => path.join(inputPath, f))
    : [inputPath];

  let aggregate = '';
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = path.basename(file);
      const base = path.basename(file, path.extname(file));
      const pngOut = path.join(outputDir, `${base}.png`);
      const txtOut = path.join(outputDir, `${base}.txt`);

      // skip already done
      if (fs.existsSync(txtOut) && !fs.existsSync(pngOut)) {
        win.webContents.send('transcription-progress', name, i + 1, files.length, 'Skipped');
        continue;
      }
      // clean up partial
      if (fs.existsSync(pngOut)) await fs.promises.unlink(pngOut);

      win.webContents.send('transcription-progress', name, i + 1, files.length, 'Preprocessing…');
      await runCommand(`"${preprocessFn}" "${file}" "${outputDir}"`, 'image');

      win.webContents.send('transcription-progress', name, i + 1, files.length, 'Transcribing…');
      const out = await runCommand(`"${flashFn}" "${pngOut}" "${outputDir}"`, 'image');
      aggregate += out;

      win.webContents.send('transcription-progress', name, i + 1, files.length, 'Done');
    }

    return aggregate;

  } catch (err: any) {
    if (err.killed || err.signal === 'SIGTERM') {
      const lastIndex = Math.max(0, files.indexOf(err.file || '') + 1);
      const lastName = path.basename(files[lastIndex] || '');
      win.webContents.send('transcription-progress', lastName, lastIndex, files.length, 'Cancelled');
      throw new Error('terminated by user');
    }
    const last = files[0];
    win.webContents.send('transcription-progress', path.basename(last), 1, files.length, 'Error');
    throw err;
  }
}
);

function createMainWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: Math.floor(workAreaSize.width * 0.9),
    height: Math.floor(workAreaSize.height * 0.9),
    minWidth: 1200,
    minHeight: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  // In your createMainWindow(), replace the entire production branch with:
  if (isDev()) {
    win.loadURL('http://localhost:5123');
    win.webContents.openDevTools();
  } else {
    // Production (Windows, macOS, Linux) — dist-react is packaged inside the ASAR
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    win.loadFile(indexPath);
  }
}

app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// settings handlers
ipcMain.handle('get-api-key', () => store.get('apiKey') || '');
ipcMain.handle('set-api-key', (_e, key: string) => { store.set('apiKey', key); });
ipcMain.handle('open-settings', () => {
  const parent = BrowserWindow.getAllWindows()[0];
  const child = new BrowserWindow({ width: 500, height: 300, parent, modal: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  if (isDev()) child.loadURL('http://localhost:5123/#/settings');
  else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    const indexURL = pathToFileURL(indexPath).toString() + '#/settings';
    child.loadURL(indexURL);
  }
});
