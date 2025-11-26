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
const flashScript   = path.join(scriptsDir, 'image_transcribe.py');

[flashScript].forEach(p => {
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
  
  // Use app data directory for temp files, similar to Mistral
  const appDataPath = app.getPath('userData');
  const tempDir = path.join(appDataPath, 'temp');
  
  // Create collection-style temp directory name
  const inputDir = path.dirname(inputPath);
  const collectionName = path.basename(inputDir);
  const tempCollectionDir = path.join(tempDir, `_temp${collectionName}_gemini`);
  
  // Ensure temp directory exists
  await fs.promises.mkdir(tempCollectionDir, { recursive: true });
  
  const pngOut = path.join(tempCollectionDir, `${base}.png`);
  let result = '';

  // Preprocessing is now handled directly by image_transcribe.py
  result = await runCommand(
    `"${pythonCmd}" "${flashScript}" "${pngOut}" "${outputDir}"`,
    mode
  );

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
    const collectionName = path.basename(folder);
    
    for (let i = 0; i < imgs.length; i++) {
      const f = imgs[i];
      try {
        // Send progress update with Mistral-style format
        const window = BrowserWindow.getAllWindows()[0];
        const processed = i + 1;
        const total = imgs.length;
        const percentage = Math.round((processed / total) * 100);
        
        if (window) {
          window.webContents.send('transcription-progress', 
            `${collectionName} - images processed ${processed}/${total} (${percentage}%)`, 
            processed, 
            total, 
            `Processing ${f}...`
          );
        }
        
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