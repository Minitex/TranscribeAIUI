// src/electron/audioHandlers.ts
import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, ChildProcess } from 'child_process';
import Store from 'electron-store';
import { getLogPath } from './logHelpers.js';
import { isDev } from './util.js';

const store = new Store<{ apiKey?: string }>();
let currentExec: ChildProcess | null = null;

// Determine python executable
const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

// Define scripts directory
const scriptsDir = isDev()
  ? path.join(process.cwd(), 'python')
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'python');

const audioScript = path.join(scriptsDir, 'audio_transcribe.py');

// Sanity check presence
if (!fs.existsSync(audioScript)) {
  dialog.showErrorBox(
    'Missing script',
    `Could not find:\n${audioScript}\nHave you bundled your python scripts via extraResources?`
  );
  app.quit();
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

export function registerAudioHandlers() {
  ipcMain.handle('select-audio-input', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a'] }]
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('run-audio-transcription', async (_e, input: string, outputDir: string) => {
    const apiKey = (store.get('apiKey') || '').trim();
    if (!apiKey) throw new Error('API key not set. Please enter it in Settings.');
    process.env.GOOGLE_API_KEY = apiKey;

    const cmd = `"${pythonCmd}" "${audioScript}" --input "${input}" --output_dir "${outputDir}"`;
    const win = BrowserWindow.getAllWindows()[0];

    // Notify UI that transcription has started
    win.webContents.send('transcription-progress', input, 1, 1, 'Transcribing…');

    try {
      const result = await runCommand(cmd, 'audio');
      // Notify UI that transcription is done
      win.webContents.send('transcription-progress', input, 1, 1, 'Done');
      return result;
    } catch (err) {
      // Notify UI that transcription failed
      win.webContents.send('transcription-progress', input, 1, 1, 'Error');
      throw err;
    }
  });

  ipcMain.handle('cancel-audio-transcription', () => {
    if (currentExec) {
      currentExec.kill();
      currentExec = null;
    }
  });
}