// src/electron/imageHandlers.ts
import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec, ChildProcess } from 'child_process';
import { isDev } from './util.js';
import { getLogPath } from './logHelpers.js';

const VALID_EXTS = ['.png', '.jpg', '.jpeg', '.tif', '.tiff'];

let currentExec: ChildProcess | null = null;

// Where your Python scripts live
const pythonCmd     = process.platform === 'win32' ? 'python' : 'python3';
const scriptsDir    = isDev()
  ? path.join(process.cwd(), 'python')
  : path.join(process.resourcesPath, 'python');
const preprocessPy  = path.join(scriptsDir, 'preprocess_to_jpeg.py');
const flashScript   = path.join(scriptsDir, 'flash_process_local_dir.py');
const cleanupScript = path.join(scriptsDir, 'cleanup_temp.py');

// Sanity‐check presence
[preprocessPy, flashScript].forEach(p => {
  if (!fs.existsSync(p)) {
    dialog.showErrorBox(
      'Missing script',
      `Could not find ${p}\nHave you bundled your python folder via extraResources?`
    );
    app.quit();
  }
});

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

async function runSingleImage(mode: string, inputPath: string, outputDir: string): Promise<string> {
  const base = path.basename(inputPath, path.extname(inputPath));
  const pngOut = path.join(outputDir, `${base}.png`);
  let result = '';

  // 1) Preprocess → JPEG
  await runCommand(
    `"${pythonCmd}" "${preprocessPy}" --simple "${inputPath}" "${outputDir}"`,
    mode
  );

  // 2) Flash → text
  result = await runCommand(
    `"${pythonCmd}" "${flashScript}" "${pngOut}" "${outputDir}"`,
    mode
  );

  // 3) Cleanup (fire-and-forget)
  exec(`"${pythonCmd}" "${cleanupScript}" "${pngOut}"`, { env: process.env });

  return result;
}

export function registerImageHandlers() {
  ipcMain.handle('select-image-input', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images/PDF', extensions: VALID_EXTS.map(e => e.slice(1)).concat('pdf') }]
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('run-image-transcription', (_e, inputPath: string, outputDir: string) =>
    runSingleImage('image', inputPath, outputDir)
  );

  ipcMain.handle('run-image-folder', async (_e, folder: string, outputDir: string) => {
    const files = await fs.promises.readdir(folder);
    const imgs  = files.filter(f => VALID_EXTS.includes(path.extname(f).toLowerCase()));
    const results: Record<string,string> = {};
    for (const f of imgs) {
      try {
        await runSingleImage('image', path.join(folder, f), outputDir);
        results[f] = 'OK';
      } catch (err: any) {
        results[f] = `ERR: ${err.message}`;
      }
    }
    return results;
  });

  ipcMain.handle('cancel-image-transcription', () => {
    if (currentExec) currentExec.kill();
    currentExec = null;
  });
}