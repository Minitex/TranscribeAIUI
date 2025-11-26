import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { transcribeImageGemini, cancelGeminiRequest } from './geminiImage.js';
import { transcribeImageMistral, transcribeImageMistralBatch, cancelMistralRequest, isMistralSupported } from './mistralImage.js';
import { transcribeAudioGemini, cancelAudioRequest } from './audioTranscribe.js';
import { scanQualityFolder } from './qualityCheck.js';
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
  mistralApiKey?: string;
  folderFavorites?: string[];
}
const store = new Store<StoreSchema>();

// Track running state
let mainWindow: BrowserWindow | null = null;
let cancelRequested = false;
let activeAudioAbort: AbortController | null = null;

const IMAGE_EXT_RE = /\.(pdf|png|jpe?g|tif{1,2}|bmp|gif)$/i;

async function collectImageFiles(root: string, recursive: boolean): Promise<string[]> {
  const statInfo = await fs.promises.stat(root);
  if (statInfo.isFile()) {
    if (!IMAGE_EXT_RE.test(path.basename(root))) {
      return [];
    }
    return [root];
  }

  const results: string[] = [];
  
  // For large directories, use streaming approach to avoid memory issues
  const walk = async (dir: string) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      
      // Process in chunks to avoid blocking the event loop
      const chunkSize = 100;
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        
        for (const entry of chunk) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (recursive) {
              await walk(full);
            }
          } else if (IMAGE_EXT_RE.test(entry.name)) {
            results.push(full);
          }
        }
        
        // Yield control periodically for large directories
        if (entries.length > 1000 && i % (chunkSize * 10) === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not read directory ${dir}:`, error);
    }
  };

  if (recursive) {
    await walk(root);
  } else {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    
    // Process in chunks for large flat directories
    const chunkSize = 200;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      
      for (const entry of chunk) {
        if (entry.isDirectory()) continue;
        if (IMAGE_EXT_RE.test(entry.name)) {
          results.push(path.join(root, entry.name));
        }
      }
      
      // Yield control for very large directories
      if (entries.length > 2000 && i % (chunkSize * 5) === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  // For very large collections, sort in chunks to avoid blocking
  if (results.length > 5000) {
    console.log(`Sorting ${results.length} files in chunks...`);
    const sortChunkSize = 1000;
    const sortedChunks = [];
    
    for (let i = 0; i < results.length; i += sortChunkSize) {
      const chunk = results.slice(i, i + sortChunkSize);
      chunk.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      sortedChunks.push(chunk);
      
      // Yield control during sorting
      if (sortedChunks.length % 10 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    // Merge sorted chunks
    return mergeSortedArrays(sortedChunks);
  } else {
    results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return results;
  }
}

// Helper function to merge sorted arrays efficiently
function mergeSortedArrays(sortedChunks: string[][]): string[] {
  if (sortedChunks.length === 0) return [];
  if (sortedChunks.length === 1) return sortedChunks[0];
  
  let result = sortedChunks[0];
  for (let i = 1; i < sortedChunks.length; i++) {
    result = mergeTwoSorted(result, sortedChunks[i]);
  }
  return result;
}

function mergeTwoSorted(a: string[], b: string[]): string[] {
  const result: string[] = [];
  let i = 0, j = 0;
  
  while (i < a.length && j < b.length) {
    if (a[i].localeCompare(b[j], undefined, { numeric: true, sensitivity: 'base' }) <= 0) {
      result.push(a[i++]);
    } else {
      result.push(b[j++]);
    }
  }
  
  while (i < a.length) result.push(a[i++]);
  while (j < b.length) result.push(b[j++]);
  
  return result;
}

function transcriptPathFor(
  filePath: string,
  inputRoot: string,
  inputIsFile: boolean,
  outputDir: string | null
): string {
  const base = path.basename(filePath, path.extname(filePath));
  if (!outputDir) {
    return path.join(path.dirname(filePath), `${base}.txt`);
  }
  if (inputIsFile) {
    return path.join(outputDir, `${base}.txt`);
  }
  const rel = path.relative(inputRoot, filePath);
  const relDir = path.dirname(rel);
  const relFolder = relDir === '.' ? '' : relDir;
  return path.join(outputDir, relFolder, `${base}.txt`);
}

// ── IPC HANDLERS ──────────────────────────────────────────────────────────────
ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-app-data-path', () => app.getPath('userData'));

ipcMain.handle('get-audio-model', () => store.get('audioModel') || 'gemini-2.5-flash');
ipcMain.handle('set-audio-model', (_e, m: string) => { store.set('audioModel', m); });

ipcMain.handle('get-image-model', () => store.get('imageModel') || 'gemini-2.5-flash');
ipcMain.handle('set-image-model', (_e, m: string) => { store.set('imageModel', m); });

ipcMain.handle('get-audio-prompt', () => store.get('audioPrompt') || '');
ipcMain.handle('set-audio-prompt', (_e, p: string) => { store.set('audioPrompt', p); });

ipcMain.handle('get-image-prompt', () => store.get('imagePrompt') || '');
ipcMain.handle('set-image-prompt', (_e, p: string) => { store.set('imagePrompt', p); });

ipcMain.handle('get-mistral-key', () => store.get('mistralApiKey') || '');
ipcMain.handle('set-mistral-key', (_e, key: string) => { store.set('mistralApiKey', key); });

ipcMain.handle('get-folder-favorites', () => store.get('folderFavorites') || []);
ipcMain.handle('set-folder-favorites', (_e, favorites: string[]) => {
  if (!Array.isArray(favorites)) return;
  const sanitized = favorites.filter(item => typeof item === 'string' && item.trim());
  store.set('folderFavorites', sanitized);
});

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

ipcMain.handle('clear-temp-files', async () => {
  try {
    const tempDir = path.join(app.getPath('userData'), 'temp');
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      return { success: true, message: 'Temporary files cleared successfully' };
    } else {
      return { success: true, message: 'No temporary files to clear' };
    }
  } catch (error: any) {
    return { success: false, message: `Failed to clear temp files: ${error.message}` };
  }
});

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
  cancelRequested = true;
  if (activeAudioAbort) {
    activeAudioAbort.abort();
    activeAudioAbort = null;
  }
  cancelGeminiRequest();
  cancelAudioRequest();
  cancelMistralRequest();
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
    interviewMode: boolean,
    extraOptions: { recursive?: boolean; batch?: boolean; batchSize?: number } = {}
  ) => {
    cancelRequested = false;
    // keep existing logs; trim if oversized
    try {
      const logPath = getLogPath(mode);
      const stat = await fs.promises.stat(logPath).catch(() => null);
      if (stat && stat.size > 2 * 1024 * 1024) { // 2MB
        const data = await fs.promises.readFile(logPath, 'utf-8').catch(() => '');
        const lines = data.split('\n');
        const keep = lines.slice(-5000); // keep last 5k lines
        await fs.promises.writeFile(logPath, keep.join('\n'), 'utf-8');
      }
    } catch {}

    const apiKey = (store.get('apiKey') || '').trim();
    if (!apiKey) throw new Error('API key not set. Please enter it in Settings.');
    process.env.GOOGLE_API_KEY = apiKey;

    const win = BrowserWindow.getAllWindows()[0];
    const modelName = mode === 'audio'
      ? (store.get('audioModel') as string)
      : (store.get('imageModel') as string);

    if (mode === 'audio') {
      const rawAudioPrompt = (promptArg || (store.get('audioPrompt') as string) || '').trim();
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
        if (cancelRequested) {
          cancelAudioRequest();
          throw new Error('terminated by user');
        }
        const file = audioFiles[i];
        const name = path.basename(file);
        const base = path.basename(file, path.extname(file));
        const transcriptOut = path.join(outputDir, `${base}.txt`);

        if (fs.existsSync(transcriptOut)) {
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Skipped');
          continue;
        }

        win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Transcribing…');
        try {
          await fs.promises.appendFile(getLogPath('audio'), `[INFO] Starting ${name} with model ${modelName}\n`, 'utf-8').catch(() => {});
          if (!activeAudioAbort) activeAudioAbort = new AbortController();
          if (cancelRequested) {
            activeAudioAbort.abort();
            throw new Error('terminated by user');
          }
          await transcribeAudioGemini(file, {
            outputDir,
            modelName,
            apiKey,
            rawPrompt: rawAudioPrompt,
            interviewMode,
            subtitles: generateSubtitles,
            signal: activeAudioAbort.signal,
            logger: async (msg: string) => {
              await fs.promises.appendFile(getLogPath('audio'), `${msg}\n`, 'utf-8').catch(() => {});
            }
          });
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Done');
          await fs.promises.appendFile(getLogPath('audio'), `[OK] ${name}\n`, 'utf-8');
        } catch (err: any) {
          const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError' || err?.signal === 'SIGTERM';
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length,
            cancelled ? 'Cancelled' : 'Error'
          );
          const detail = err?.message || err?.toString?.() || 'Unknown error';
          await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${name}: ${detail}\n`, 'utf-8').catch(() => {});
          if (cancelled) throw new Error('terminated by user');
          throw err;
        }
      }

      activeAudioAbort = null;
      return `[OK] Processed ${audioFiles.length} audio file(s)`;
    } else {
      const imageModel = modelName || 'gemini-2.5-flash';
      const rawImagePrompt = ((store.get('imagePrompt') as string) || '').trim();
      const useMistral = imageModel.toLowerCase().includes('mistral');
      const recursiveSelected = Boolean(extraOptions?.recursive);
      const batchSelected = Boolean(extraOptions?.batch);
      const batchSize = extraOptions?.batchSize || 10;

      if (!useMistral && !rawImagePrompt) {
        const msg = 'Image prompt not set. Aborting transcription.';
        await fs.promises.appendFile(getLogPath('image'), `[ERR] ${msg}\n`);
        throw new Error(msg);
          }
          await fs.promises.appendFile(getLogPath('image'), `[INFO] Starting image transcription (${modelName})\n`, 'utf-8');
          const appTempDir = path.join(app.getPath('userData'), 'temp');
          await fs.promises.mkdir(appTempDir, { recursive: true }).catch(() => {});
          if (!useMistral) {
            const cacheDir = path.join(appTempDir, 'gemini_cache');
            await fs.promises.mkdir(cacheDir, { recursive: true }).catch(() => {});
            await fs.promises.appendFile(getLogPath('image'), `[INFO] Gemini temp images will be cached at: ${cacheDir}\n`, 'utf-8').catch(() => {});
          } else {
            const cacheDir = path.join(appTempDir, 'mistral_cache');
            await fs.promises.mkdir(cacheDir, { recursive: true }).catch(() => {});
            await fs.promises.appendFile(getLogPath('image'), `[INFO] Mistral temp images will be cached at: ${cacheDir}\n`, 'utf-8').catch(() => {});
          }

      const stat = await fs.promises.stat(inputPath);

      if (useMistral) {
        const mistralKey = (store.get('mistralApiKey') as string | undefined)?.trim() || '';
        if (!mistralKey) {
          throw new Error('Mistral API key not set. Please enter it in Settings.');
        }
        if (batchSelected && !stat.isDirectory()) {
          throw new Error('Batch mode requires selecting a folder for Mistral OCR.');
        }

        const normalizedOutputDir = path.resolve(outputDir);
        const appTempDir = path.join(app.getPath('userData'), 'temp');
        const cacheDir = path.join(appTempDir, 'mistral_cache');
        await fs.promises.mkdir(cacheDir, { recursive: true }).catch(() => {});

        const baseIsFile = stat.isFile();

        const files: string[] = [];
        if (stat.isFile()) {
          files.push(inputPath);
        } else {
          const names = (await fs.promises.readdir(inputPath)).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
          );
          for (const n of names) {
            const full = path.join(inputPath, n);
            if (isMistralSupported(full)) files.push(full);
          }
        }

        if (!files.length) {
          throw new Error('No supported image/PDF files found for Mistral OCR.');
        }

        const window = BrowserWindow.getAllWindows()[0];
        const collectionName = stat.isDirectory() ? path.basename(inputPath) : path.basename(path.dirname(inputPath));
        const logInfo = async (msg: string) => {
          await fs.promises.appendFile(getLogPath('image'), `[INFO] ${msg}\n`, 'utf-8').catch(() => {});
        };

        const workFiles = batchSelected
          ? files.filter(f => !fs.existsSync(transcriptPathFor(f, inputPath, baseIsFile, normalizedOutputDir)))
          : files;
        if (!workFiles.length) {
          return `[OK] All transcripts already exist for ${files.length} file(s)`;
        }

        let processedCount = 0;
        const totalWork = workFiles.length;

        const processChunk = async (chunk: string[], chunkIndex: number, totalChunks: number) => {
          if (batchSelected) {
            try {
              if (cancelRequested) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }
              await logInfo(`Starting batch ${chunkIndex}/${totalChunks} with ${chunk.length} file(s)`);
              const pending = chunk.filter(file => {
                const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);
                return !fs.existsSync(txtOut);
              });

              const baseLabel = `${collectionName} - batch ${chunkIndex}/${totalChunks} - images processed ${processedCount}/${totalWork} (${Math.round((processedCount / totalWork) * 100)}%)`;
              window?.webContents.send(
                'transcription-progress',
                baseLabel,
                processedCount,
                files.length,
                pending.length ? `Submitting batch ${chunkIndex}/${totalChunks}...` : 'Skipped'
              );

              if (cancelRequested) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }

              let batchResults = new Map<string, string>();
              if (pending.length) {
                batchResults = await transcribeImageMistralBatch(pending, mistralKey, modelName, {
                  baseInput: inputPath,
                  logger: logInfo,
                  cacheDir,
                  tempRoot: path.join(app.getPath('userData'), 'temp')
                });
              }
              await logInfo(`Batch ${chunkIndex}/${totalChunks} completed (received ${batchResults.size} result(s))`);

              for (const file of chunk) {
                if (cancelRequested) {
                  cancelMistralRequest();
                  throw new Error('terminated by user');
                }
                const name = path.basename(file);
                const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);

                processedCount += 1;
                const percentage = Math.round((processedCount / totalWork) * 100);
                const progressLabel = `${collectionName} - batch ${chunkIndex}/${totalChunks} - images processed ${processedCount}/${totalWork} (${percentage}%)`;

                if (fs.existsSync(txtOut)) {
                  window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Skipped');
                  continue;
                }

                window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, `Writing ${name}...`);
                const relKey = baseIsFile
                  ? path.basename(file)
                  : path.relative(inputPath, file).split(path.sep).join('/');
                const text = batchResults.get(relKey);

                if (typeof text !== 'string') {
                  const msg = `Missing OCR result for ${relKey}`;
                  await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                  window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Error');
                  throw new Error(msg);
                }

                await fs.promises.writeFile(txtOut, text, 'utf-8');
                window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Done');
                await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8');
              }

              return;
            } catch (err: any) {
              const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError';
              const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
              await fs.promises.appendFile(getLogPath('image'), `[ERR] batch ${chunkIndex} - ${msg}\n`, 'utf-8').catch(() => {});
              if (cancelled) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }
              throw err;
            }
          }

          for (let i = 0; i < chunk.length; i++) {
            if (cancelRequested) {
              cancelMistralRequest();
              throw new Error('terminated by user');
            }
            const file = chunk[i];
            const name = path.basename(file);
            const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);

            processedCount += 1;
            const percentage = Math.round((processedCount / totalWork) * 100);
            const progressLabel = batchSelected
              ? `${collectionName} - batch ${chunkIndex}/${totalChunks} - images processed ${processedCount}/${totalWork} (${percentage}%)`
              : `${collectionName} - images processed ${processedCount}/${totalWork} (${percentage}%)`;

            if (fs.existsSync(txtOut)) {
              window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Skipped');
              continue;
            }

            window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, `Transcribing ${name}...`);
            try {
              const text = await transcribeImageMistral(file, mistralKey, modelName);
              await fs.promises.writeFile(txtOut, text, 'utf-8');
              window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Done');
              await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8');
            } catch (err: any) {
              const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError';
              const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
              await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
              window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, cancelled ? 'Cancelled' : 'Error');
              if (cancelled) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }
              throw err;
            }
          }
        };

        if (batchSelected && stat.isDirectory()) {
          const chunks: string[][] = [];
          for (let i = 0; i < workFiles.length; i += batchSize) {
            chunks.push(workFiles.slice(i, i + batchSize));
          }
          for (let c = 0; c < chunks.length; c++) {
            await processChunk(chunks[c], c + 1, chunks.length);
          }
        } else {
          await processChunk(workFiles, 1, 1);
        }

        return `[OK] Processed ${workFiles.length} file(s) via Mistral OCR`;
      }

      const rawPrompt = rawImagePrompt;
      const imageExtRe = /\.(png|jpe?g|tif{1,2})$/i;
      let files: string[];
      
      if (stat.isDirectory()) {
        // Show scanning progress for large directories
        const window = BrowserWindow.getAllWindows()[0];
        if (window) {
          window.webContents.send('transcription-progress', 'Scanning directory...', 0, 1, 'Please wait...');
        }
        
        const names = (await fs.promises.readdir(inputPath)).filter(name => imageExtRe.test(name));
        
        // Sort in chunks for very large directories
        if (names.length > 5000) {
          console.log(`Sorting ${names.length} files in chunks...`);
          const chunkSize = 1000;
          const sortedChunks = [];
          
          for (let i = 0; i < names.length; i += chunkSize) {
            const chunk = names.slice(i, i + chunkSize);
            chunk.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
            sortedChunks.push(chunk);
            
            // Yield control during sorting
            if (sortedChunks.length % 10 === 0) {
              await new Promise(resolve => setImmediate(resolve));
            }
          }
          
          // Merge sorted chunks using the helper function defined above
          const sortedNames = mergeSortedArrays(sortedChunks);
          files = sortedNames.map(name => path.join(inputPath, name));
        } else {
          names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          files = names.map(name => path.join(inputPath, name));
        }
        
        // Show collection summary
        if (window) {
          const collectionName = path.basename(inputPath);
          window.webContents.send('transcription-progress', 
            `Found ${files.length} images in ${collectionName}`, 
            0, files.length, 
            'Preparing transcription...'
          );
        }
      } else {
        if (!imageExtRe.test(path.basename(inputPath))) {
          throw new Error('Unsupported file type for Gemini OCR. Please select an image.');
        }
        files = [inputPath];
      }

      let aggregate = '';
      const collectionName = stat.isDirectory() ? path.basename(inputPath) : path.basename(path.dirname(inputPath));
      
      // Throttle progress updates for large collections to improve performance
      const shouldThrottleProgress = files.length > 1000;
      const progressUpdateInterval = shouldThrottleProgress ? Math.max(1, Math.floor(files.length / 100)) : 1;
      
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const name = path.basename(file);
          const base = path.basename(file, path.extname(file));
          
          const txtOut = path.join(outputDir, `${base}.txt`);

          const processed = i + 1;
          const percentage = Math.round((processed / files.length) * 100);
          const progressLabel = `${collectionName} - images processed ${processed}/${files.length} (${percentage}%)`;

          // Only send progress updates at intervals for large collections
          const shouldUpdateProgress = !shouldThrottleProgress || (i % progressUpdateInterval === 0) || processed === files.length;

          if (cancelRequested) {
            win.webContents.send('transcription-progress', progressLabel, processed, files.length, 'Cancelled');
            cancelGeminiRequest();
            throw new Error('terminated by user');
          }

          // Skip if transcription already exists
          if (fs.existsSync(txtOut)) {
            if (shouldUpdateProgress) {
              win.webContents.send('transcription-progress', progressLabel, processed, files.length, 'Skipped');
            }
            continue;
          }

          if (shouldUpdateProgress) {
            win.webContents.send('transcription-progress', progressLabel, processed, files.length, `Transcribing ${name}...`);
          }
          // Call Gemini directly from TypeScript (no Python wrapper)
          try {
            const out = await transcribeImageGemini(file, rawPrompt, imageModel, apiKey, {
              cacheDir: path.join(app.getPath('userData'), 'temp', 'gemini_cache'),
              tempRoot: path.join(app.getPath('userData'), 'temp'),
              logger: async (msg: string) => {
                await fs.promises.appendFile(getLogPath('image'), `${msg}\n`, 'utf-8').catch(() => {});
              }
            });
            await fs.promises.writeFile(txtOut, out, 'utf-8');
            await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8');
            aggregate += out;
          } catch (err: any) {
            const cancelled = cancelRequested || err?.name === 'AbortError';
            const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
            await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
            win.webContents.send('transcription-progress', progressLabel, processed, files.length, cancelled ? 'Cancelled' : 'Error');
            if (cancelled) {
              cancelGeminiRequest();
              throw new Error('terminated by user');
            }
            throw err;
          }

          if (shouldUpdateProgress) {
            win.webContents.send('transcription-progress', progressLabel, processed, files.length, 'Done');
          }
        }

        return aggregate;
      } catch (err: any) {
        if (err.killed || err.signal === 'SIGTERM' || err.cancelled || cancelRequested || err?.name === 'AbortError') {
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
    width: Math.min(1400, Math.floor(workAreaSize.width * 0.85)),
    height: Math.min(1250, Math.floor(workAreaSize.height * 0.92)),
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#16161f',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  mainWindow = win;

  if (isDev()) {
    win.loadURL('http://localhost:5123');
    win.webContents.openDevTools();
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    win.loadFile(indexPath);
  }

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
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
  const result = await scanQualityFolder(folder, threshold);
  return result;
});
