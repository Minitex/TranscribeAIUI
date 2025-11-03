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

interface StoreSchema {
  apiKey?: string;
  audioModel?: string;
  imageModel?: string;
  audioPrompt?: string;
  imagePrompt?: string;
}
const store = new Store<StoreSchema>();

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
const preprocessFn = path.join(scriptsDir, `preprocess_to_png${ext}`);
const imageBin = path.join(scriptsDir, `image_transcribe${ext}`);
const qualityScanScript = path.join(scriptsDir, `transcript_quality_check${ext}`);

for (const p of [audioBin, preprocessFn, imageBin, qualityScanScript]) {
  if (!fs.existsSync(p)) {
    dialog.showErrorBox('Missing binary', `Expected to find:\n${p}`);
    app.quit();
    process.exit(1);
  }
}

// run shell commands with logging and optional extra env
function runCommand(cmd: string, mode: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    currentExec = exec(cmd, { env }, async (err, stdout, stderr) => {
      if (stdout) await fs.promises.appendFile(getLogPath(mode), `[OUT] ${stdout}`);
      if (stderr) await fs.promises.appendFile(getLogPath(mode), `[ERR] ${stderr}`);
      currentExec = null;
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ── IPC HANDLERS ──────────────────────────────────────────────────────────────
ipcMain.handle('get-audio-model', () => store.get('audioModel') || 'gemini-2.5-flash');
ipcMain.handle('set-audio-model', (_e, m: string) => { store.set('audioModel', m); });

ipcMain.handle('get-image-model', () => store.get('imageModel') || 'gemini-2.5-flash');
ipcMain.handle('set-image-model', (_e, m: string) => { store.set('imageModel', m); });

ipcMain.handle('get-audio-prompt', () => store.get('audioPrompt') || '');
ipcMain.handle('set-audio-prompt', (_e, p: string) => { store.set('audioPrompt', p); });

ipcMain.handle('get-image-prompt', () => store.get('imagePrompt') || '');
ipcMain.handle('set-image-prompt', (_e, p: string) => { store.set('imagePrompt', p); });

ipcMain.handle('list-transcripts-subtitles', async (_e, folder: string) => {
  const files = await fs.promises.readdir(folder);
  return files
    .filter(f => f.endsWith('.txt') || f.endsWith('.srt'))
    .map(f => ({ name: f, path: path.join(folder, f) }));
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

ipcMain.handle(
  'append-log',
  async (_e, payload: { mode: string; message: string }) => {
    const { mode, message } = payload || {};
    const allowed = new Set(['audio', 'image', 'quality']);
    if (!mode || !allowed.has(mode)) {
      throw new Error(`Unsupported log mode: ${mode}`);
    }
    if (!message) return;
    await fs.promises.appendFile(getLogPath(mode), `${message.endsWith('\n') ? message : `${message}\n`}`, 'utf-8');
  }
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
    mode === 'audio' ? ['openFile', 'openDirectory'] : ['openFile', 'openDirectory'];
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties, filters });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-input-folder', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('select-output-dir', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('get-parent-dir', async (_e, filePath: string) => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      return filePath;
    }
    return path.dirname(filePath);
  } catch {
    return null;
  }
});

ipcMain.handle('delete-transcript', async (_e, filePath: string) => {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch {
    return false;
  }
});

// ── Updated run-transcription to pass flags to Python ──────────────────────────
ipcMain.handle(
  'run-transcription',
  async (_e,
    mode: string,
    inputPath: string,
    outputDir: string,
    promptArg: string,
    generateSubtitles: boolean,
    interviewMode: boolean) => {
    // clear previous logs
    await fs.promises.writeFile(getLogPath(mode), '', 'utf-8');

    const apiKey = (store.get('apiKey') || '').trim();
    if (!apiKey) throw new Error('API key not set. Please enter it in Settings.');
    process.env.GOOGLE_API_KEY = apiKey;

    const win = BrowserWindow.getAllWindows()[0];
    const modelName = mode === 'audio'
      ? (store.get('audioModel') as string)
      : (store.get('imageModel') as string);

    if (mode === 'audio') {
      const rawAudioPrompt = ((store.get('audioPrompt') as string) || '').trim();
      if (!rawAudioPrompt) {
        const msg = 'Audio prompt not set. Aborting transcription.';
        await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${msg}\n`);
        throw new Error(msg);
      }

      // support single file or directory of audio files
      let audioFiles: string[] = [];
      try {
        const stat = await fs.promises.stat(inputPath);
        if (stat.isDirectory()) {
          const names = (await fs.promises.readdir(inputPath))
            .filter(f => /\.(mp3|wav|m4a)$/i.test(f))
            .sort((a, b) =>
              a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
            );
          audioFiles = names.map(f => path.join(inputPath, f));
        } else {
          audioFiles = [inputPath];
        }
      } catch {
        audioFiles = [inputPath];
      }

      for (let i = 0; i < audioFiles.length; i++) {
        const file = audioFiles[i];
        const name = path.basename(file);
        const base = path.basename(file, path.extname(file));
        const transcriptOut = path.join(outputDir, `${base}.txt`);

        if (fs.existsSync(transcriptOut)) {
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Skipped');
          continue;
        }

        win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Transcribing…');
        let cmd = `"${audioBin}" --input "${file}" --model "${modelName}" --output_dir "${outputDir}"`;
        if (interviewMode) cmd += ' --interview';
        if (generateSubtitles) cmd += ' --subtitles';

        try {
          await runCommand(cmd,
            'audio',
            { AUDIO_PROMPT: promptArg, GOOGLE_API_KEY: apiKey }
          );
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Done');
        } catch (err: any) {
          const cancelled = err.killed || err.signal === 'SIGTERM';
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length,
            cancelled ? 'Cancelled' : 'Error'
          );
          if (cancelled) throw new Error('terminated by user');
        }
      }

      return `[OK] Processed ${audioFiles.length} audio file(s)`;
    } else {
      const rawImagePrompt = ((store.get('imagePrompt') as string) || '').trim();
      if (!rawImagePrompt) {
        const msg = 'Image prompt not set. Aborting transcription.';
        await fs.promises.appendFile(getLogPath('image'), `[ERR] ${msg}\n`);
        throw new Error(msg);
      }

      const stat = await fs.promises.stat(inputPath);

      let files: string[];
      if (stat.isDirectory()) {
        const names = (await fs.promises.readdir(inputPath))
          .filter(f => /\.(png|jpe?g|tif{1,2})$/i.test(f));

        names.sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        );

        files = names.map(f => path.join(inputPath, f));
      } else {
        files = [inputPath];
      }

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
          const out = await runCommand(
            `"${imageBin}" --model "${modelName}" "${pngOut}" "${outputDir}"`,
            'image',
            { IMAGE_PROMPT: rawImagePrompt, GOOGLE_API_KEY: apiKey }
          );
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
  });

function createMainWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: Math.floor(workAreaSize.width * 0.9),
    height: Math.floor(workAreaSize.height * 0.9),
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#16161f',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  if (isDev()) {
    win.loadURL('http://localhost:5123');
    win.webContents.openDevTools();
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    win.loadFile(indexPath);
  }
}

app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => {
  app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// settings handlers
ipcMain.handle('get-api-key', () => store.get('apiKey') || '');
ipcMain.handle('set-api-key', (_e, key: string) => { store.set('apiKey', key); });
ipcMain.handle('open-settings', () => {
  const parent = BrowserWindow.getAllWindows()[0];
  const parentBounds = parent.getBounds();

  const width = Math.floor(parentBounds.width * 0.85);
  const height = Math.floor(parentBounds.height * 0.85);

  const child = new BrowserWindow({
    width,
    height,
    minWidth: Math.floor(parentBounds.width * 0.6),
    minHeight: Math.floor(parentBounds.height * 0.6),
    parent,
    modal: true,
    resizable: false,
    backgroundColor: '#16161f',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  if (isDev()) {
    child.loadURL('http://localhost:5123/#/settings');
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    const indexURL = pathToFileURL(indexPath).toString() + '#/settings';
    child.loadURL(indexURL);
  }

  child.center();
});

ipcMain.handle('scan-quality', async (_e, folder: string, threshold: number) => {
  // clear any previous quality logs
  const qualityLog = getLogPath('quality');
  await fs.promises.writeFile(qualityLog, '', 'utf-8');
  let cmd = `"${qualityScanScript}" --folder "${folder}" --log "${qualityLog}"`;
  if (threshold != null) cmd += ` --threshold ${threshold}`;
  const stdout = await runCommand(cmd, 'quality');
  return JSON.parse(stdout);
});
