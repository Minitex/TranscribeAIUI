import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { transcribeImageGemini, cancelGeminiRequest } from './geminiImage.js';
import {
  transcribeImageMistral,
  submitMistralBatchJob,
  fetchMistralBatchJobStatus,
  downloadMistralBatchResults,
  cancelMistralRequest,
  isMistralSupported
} from './mistralImage.js';
import { transcribeAudioGemini, transcribeAudioMistral, cancelAudioRequest } from './audioTranscribe.js';
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
  audioInputPath?: string;
  audioOutputDir?: string;
  imageInputPath?: string;
  imageOutputDir?: string;
  activeMode?: 'audio' | 'image';
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

interface MistralBatchJobRecord {
  id: string;
  inputPath: string;
  outputDir: string;
  modelName: string;
  files: string[];
  batchOrder: number;
  createdAtMs: number;
  status: string;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  outputFileId: string | null;
  lastProgressCount: number;
  lastProgressAtMs: number;
  writtenAtMs: number | null;
  lastError: string | null;
}

interface MistralBatchStateFile {
  version: number;
  jobs: MistralBatchJobRecord[];
}

interface MistralBatchFolderStats {
  inputPath: string;
  uploaded: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

interface MistralBatchQueueRow extends MistralBatchFolderStats {
  outputDir: string;
  modelName: string;
  oldestPendingStartMs: number | null;
  checkBackAtMs: number | null;
}

const MISTRAL_BATCH_STATE_VERSION = 1;
const MISTRAL_BATCH_AVG_COMPLETION_MS = 2 * 60 * 60 * 1000;

function getMistralBatchStatePath(cacheDir: string): string {
  return path.join(cacheDir, 'batch-jobs.json');
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeCount(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function normalizeJobRecord(raw: any): MistralBatchJobRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (typeof raw.inputPath !== 'string' || typeof raw.outputDir !== 'string') return null;
  const createdAtMs = normalizeTimestamp(raw.createdAtMs, Date.now());
  const lastProgressCount = normalizeCount(raw.lastProgressCount);
  const totalRequests = Math.max(normalizeCount(raw.totalRequests), 0);
  const succeededRequests = normalizeCount(raw.succeededRequests);
  const failedRequests = normalizeCount(raw.failedRequests);
  const lastProgressAtFallback = createdAtMs;
  return {
    id: raw.id.trim(),
    inputPath: raw.inputPath,
    outputDir: raw.outputDir,
    modelName: typeof raw.modelName === 'string' ? raw.modelName : '',
    files: Array.isArray(raw.files) ? raw.files.filter((item: unknown): item is string => typeof item === 'string') : [],
    batchOrder: Math.max(normalizeCount(raw.batchOrder), 1),
    createdAtMs,
    status: typeof raw.status === 'string' ? raw.status : 'QUEUED',
    totalRequests,
    succeededRequests,
    failedRequests,
    outputFileId: typeof raw.outputFileId === 'string' && raw.outputFileId ? raw.outputFileId : null,
    lastProgressCount,
    lastProgressAtMs: normalizeTimestamp(raw.lastProgressAtMs, lastProgressAtFallback),
    writtenAtMs: raw.writtenAtMs === null || raw.writtenAtMs === undefined
      ? null
      : normalizeTimestamp(raw.writtenAtMs, createdAtMs),
    lastError: typeof raw.lastError === 'string' && raw.lastError ? raw.lastError : null
  };
}

async function readMistralBatchState(cacheDir: string): Promise<MistralBatchStateFile> {
  const statePath = getMistralBatchStatePath(cacheDir);
  try {
    const text = await fs.promises.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(text);
    const rawJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    const jobs: MistralBatchJobRecord[] = rawJobs
      .map((entry: unknown) => normalizeJobRecord(entry))
      .filter((entry: MistralBatchJobRecord | null): entry is MistralBatchJobRecord => Boolean(entry));
    return {
      version: Number(parsed?.version) === MISTRAL_BATCH_STATE_VERSION
        ? MISTRAL_BATCH_STATE_VERSION
        : MISTRAL_BATCH_STATE_VERSION,
      jobs
    };
  } catch {
    return { version: MISTRAL_BATCH_STATE_VERSION, jobs: [] };
  }
}

async function writeMistralBatchState(cacheDir: string, state: MistralBatchStateFile): Promise<void> {
  const statePath = getMistralBatchStatePath(cacheDir);
  await fs.promises.mkdir(cacheDir, { recursive: true }).catch(() => {});
  await fs.promises.writeFile(
    statePath,
    JSON.stringify({ version: MISTRAL_BATCH_STATE_VERSION, jobs: state.jobs }, null, 2),
    'utf-8'
  );
}

function partitionFiles(files: string[], chunkSize: number): string[][] {
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += normalizedChunkSize) {
    chunks.push(files.slice(i, i + normalizedChunkSize));
  }
  return chunks;
}

function isTerminalBatchStatus(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}

function shouldResumeBatchJob(job: MistralBatchJobRecord): boolean {
  if (job.writtenAtMs !== null) return false;
  return job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'SUCCESS';
}

function matchesBatchScope(
  job: MistralBatchJobRecord,
  inputPath: string,
  outputDir: string,
  modelName: string
): boolean {
  return (
    path.resolve(job.inputPath) === path.resolve(inputPath) &&
    path.resolve(job.outputDir) === path.resolve(outputDir) &&
    job.modelName === modelName
  );
}

function sortBatchJobsInOrder(a: MistralBatchJobRecord, b: MistralBatchJobRecord): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  if (a.batchOrder !== b.batchOrder) return a.batchOrder - b.batchOrder;
  return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
}

function matchesInputScope(job: MistralBatchJobRecord, inputPath: string): boolean {
  return path.resolve(job.inputPath) === path.resolve(inputPath);
}

function matchesStatsScope(
  job: MistralBatchJobRecord,
  inputPath: string,
  outputDir?: string,
  modelName?: string
): boolean {
  if (!matchesInputScope(job, inputPath)) return false;
  if (outputDir && path.resolve(job.outputDir) !== path.resolve(outputDir)) return false;
  if (modelName && job.modelName !== modelName) return false;
  return true;
}

function computeMistralBatchStats(
  jobs: MistralBatchJobRecord[],
  inputPath: string
): MistralBatchFolderStats {
  let uploaded = 0;
  let processing = 0;
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    if (job.writtenAtMs !== null) {
      completed += 1;
      continue;
    }
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
      failed += 1;
      continue;
    }
    if (job.status === 'QUEUED') {
      uploaded += 1;
      continue;
    }
    processing += 1;
  }

  return {
    inputPath,
    uploaded,
    processing,
    completed,
    failed,
    total: jobs.length
  };
}

function formatLocalDateTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

function buildMistralBatchQueueRows(jobs: MistralBatchJobRecord[]): MistralBatchQueueRow[] {
  const groups = new Map<string, MistralBatchJobRecord[]>();
  for (const job of jobs) {
    const key = `${path.resolve(job.inputPath)}::${path.resolve(job.outputDir)}::${job.modelName}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(job);
    } else {
      groups.set(key, [job]);
    }
  }

  const rows: MistralBatchQueueRow[] = [];
  for (const groupedJobs of groups.values()) {
    if (!groupedJobs.length) continue;
    groupedJobs.sort(sortBatchJobsInOrder);
    const sample = groupedJobs[0];
    const pending = groupedJobs.filter(job => shouldResumeBatchJob(job));
    const oldestPendingStartMs = pending.length ? pending[0].createdAtMs : null;
    const stats = computeMistralBatchStats(groupedJobs, sample.inputPath);
    rows.push({
      ...stats,
      outputDir: sample.outputDir,
      modelName: sample.modelName,
      oldestPendingStartMs,
      checkBackAtMs: oldestPendingStartMs === null
        ? null
        : oldestPendingStartMs + MISTRAL_BATCH_AVG_COMPLETION_MS
    });
  }

  return rows.sort((a, b) => {
    const aKey = a.oldestPendingStartMs ?? Number.MAX_SAFE_INTEGER;
    const bKey = b.oldestPendingStartMs ?? Number.MAX_SAFE_INTEGER;
    if (aKey !== bKey) return aKey - bKey;
    return a.inputPath.localeCompare(b.inputPath, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function csvEscape(value: string): string {
  const text = `${value ?? ''}`;
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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

ipcMain.handle('get-audio-input-path', () => store.get('audioInputPath') || '');
ipcMain.handle('set-audio-input-path', (_e, value: string) => {
  if (typeof value !== 'string') return;
  store.set('audioInputPath', value);
});
ipcMain.handle('get-audio-output-dir', () => store.get('audioOutputDir') || '');
ipcMain.handle('set-audio-output-dir', (_e, value: string) => {
  if (typeof value !== 'string') return;
  store.set('audioOutputDir', value);
});
ipcMain.handle('get-image-input-path', () => store.get('imageInputPath') || '');
ipcMain.handle('set-image-input-path', (_e, value: string) => {
  if (typeof value !== 'string') return;
  store.set('imageInputPath', value);
});
ipcMain.handle('get-image-output-dir', () => store.get('imageOutputDir') || '');
ipcMain.handle('set-image-output-dir', (_e, value: string) => {
  if (typeof value !== 'string') return;
  store.set('imageOutputDir', value);
});

ipcMain.handle(
  'get-mistral-batch-stats',
  async (
    _e,
    payload: { inputPath?: string; outputDir?: string; modelName?: string }
  ): Promise<MistralBatchFolderStats> => {
    const rawInputPath = typeof payload?.inputPath === 'string' ? payload.inputPath.trim() : '';
    if (!rawInputPath) {
      return { inputPath: '', uploaded: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    }

    const inputPath = path.resolve(rawInputPath);
    const outputDir = typeof payload?.outputDir === 'string' && payload.outputDir.trim()
      ? path.resolve(payload.outputDir.trim())
      : undefined;
    const modelName = typeof payload?.modelName === 'string' && payload.modelName.trim()
      ? payload.modelName.trim()
      : undefined;

    const cacheDir = path.join(app.getPath('userData'), 'temp', 'mistral_cache');
    const state = await readMistralBatchState(cacheDir);
    const scoped = state.jobs.filter(job => matchesStatsScope(job, inputPath, outputDir, modelName));
    return computeMistralBatchStats(scoped, inputPath);
  }
);

ipcMain.handle('get-mistral-batch-queue', async (): Promise<MistralBatchQueueRow[]> => {
  const cacheDir = path.join(app.getPath('userData'), 'temp', 'mistral_cache');
  const state = await readMistralBatchState(cacheDir);
  return buildMistralBatchQueueRows(state.jobs);
});

ipcMain.handle(
  'select-mistral-batch-folder',
  async (
    _e,
    payload: { inputPath?: string; outputDir?: string }
  ): Promise<{ ok: boolean; error?: string }> => {
    const rawInputPath = typeof payload?.inputPath === 'string' ? payload.inputPath.trim() : '';
    const rawOutputDir = typeof payload?.outputDir === 'string' ? payload.outputDir.trim() : '';
    if (!rawInputPath || !rawOutputDir) {
      return { ok: false, error: 'Missing input/output folder path.' };
    }

    const inputPath = path.resolve(rawInputPath);
    const outputDir = path.resolve(rawOutputDir);

    store.set('imageInputPath', inputPath);
    store.set('imageOutputDir', outputDir);
    store.set('activeMode', 'image');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mistral-batch-folder-selected', inputPath, outputDir);
    }
    return { ok: true };
  }
);

ipcMain.handle('get-active-mode', () => store.get('activeMode') || '');
ipcMain.handle('set-active-mode', (_e, value: string) => {
  if (value !== 'audio' && value !== 'image') return;
  store.set('activeMode', value);
});

ipcMain.handle('list-transcripts-subtitles', async (_e, folder: string) => {
  const files = await fs.promises.readdir(folder);
  return files
    .filter(f => f.endsWith('.txt') || f.endsWith('.srt'))
    .map(f => ({ name: f, path: path.join(folder, f) }));
});

ipcMain.handle(
  'export-transcript-list',
  async (_e, payload: {
    mode?: string;
    items?: { name: string; confidence?: number; reason?: string }[];
    filters?: Record<string, unknown>;
  }) => {
    try {
      const items = Array.isArray(payload?.items) ? payload?.items : [];
      if (!items.length) {
        return { canceled: true, error: 'No files to export' };
      }
      const modeLabel = (payload?.mode || 'transcripts').trim() || 'transcripts';
      const defaultName = `transcribeai-${modeLabel}-list.csv`;
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (canceled || !filePath) return { canceled: true };
      const lines: string[] = [];
      if (payload?.filters && typeof payload.filters === 'object') {
        const filterLine = `# export_filters=${JSON.stringify(payload.filters)}`;
        lines.push(filterLine);
      }
      lines.push('name,confidence,reason');
      for (const item of items) {
        const name = csvEscape(item?.name ?? '');
        const confidence = csvEscape(
          item?.confidence === undefined || item?.confidence === null
            ? ''
            : String(item.confidence)
        );
        const reason = csvEscape(item?.reason ?? '');
        lines.push(`${name},${confidence},${reason}`);
      }
      await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
      return { canceled: false, filePath, count: items.length };
    } catch (error: any) {
      return { canceled: true, error: error?.message || String(error) };
    }
  }
);

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

ipcMain.handle('export-logs', async (_e, payload: { mode?: string }) => {
  try {
    const mode = (payload?.mode || 'logs').trim() || 'logs';
    let content = '';
    try {
      content = await fs.promises.readFile(getLogPath(mode), 'utf-8');
    } catch {
      content = '';
    }
    if (!content) {
      return { canceled: true, error: 'No logs to export' };
    }
    const defaultName = `transcribeai-${mode}-logs.txt`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.promises.writeFile(filePath, content, 'utf-8');
    const count = content.split(/\r?\n/).filter(Boolean).length;
    return { canceled: false, filePath, count };
  } catch (error: any) {
    return { canceled: true, error: error?.message || String(error) };
  }
});

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
    ? [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
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

// ── Updated run-transcription to pass flags ──────────────────────────
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

    const win = BrowserWindow.getAllWindows()[0];
    const modelName = mode === 'audio'
      ? (store.get('audioModel') as string)
      : (store.get('imageModel') as string);
    const modelNameLower = (modelName || '').toLowerCase();
    const useMistral = mode !== 'audio' && modelNameLower.includes('mistral');
    const useVoxtralAudio = mode === 'audio' && modelNameLower.includes('voxtral');
    let geminiApiKey = '';
    let mistralApiKey = '';

    if (mode === 'audio') {
      if (useVoxtralAudio) {
        mistralApiKey = (store.get('mistralApiKey') || '').trim();
        if (!mistralApiKey) {
          throw new Error('Mistral API key not set. Please enter it in Settings.');
        }
      } else {
        geminiApiKey = (store.get('apiKey') || '').trim();
        if (!geminiApiKey) {
          throw new Error('Gemini API key not set. Please enter it in Settings.');
        }
        process.env.GOOGLE_API_KEY = geminiApiKey;
      }

      const rawAudioPrompt = (promptArg || (store.get('audioPrompt') as string) || '').trim();
      if (!rawAudioPrompt && !useVoxtralAudio) {
        const msg = 'Audio prompt not set. Aborting transcription.';
        await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${msg}\n`);
        throw new Error(msg);
      }
      const audioMistralCacheDir = useVoxtralAudio
        ? path.join(app.getPath('userData'), 'temp', 'mistral_cache', 'audio')
        : '';
      if (useVoxtralAudio) {
        await fs.promises.mkdir(audioMistralCacheDir, { recursive: true }).catch(() => {});
        await fs.promises.appendFile(
          getLogPath('audio'),
          `[INFO] Mistral temp audio files will be cached at: ${audioMistralCacheDir}\n`,
          'utf-8'
        ).catch(() => {});
      }

      // support single file or directory of audio files
      let audioFiles: string[] = [];
      try {
        const stat = await fs.promises.stat(inputPath);
        if (stat.isDirectory()) {
          const names = (await fs.promises.readdir(inputPath))
            .filter(f => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f))
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
          if (useVoxtralAudio) {
            await transcribeAudioMistral(file, {
              outputDir,
              modelName,
              apiKey: mistralApiKey,
              rawPrompt: rawAudioPrompt,
              interviewMode,
              subtitles: generateSubtitles,
              tempDir: audioMistralCacheDir,
              signal: activeAudioAbort.signal,
              logger: async (msg: string) => {
                await fs.promises.appendFile(getLogPath('audio'), `${msg}\n`, 'utf-8').catch(() => {});
              }
            });
          } else {
            await transcribeAudioGemini(file, {
              outputDir,
              modelName,
              apiKey: geminiApiKey,
              rawPrompt: rawAudioPrompt,
              interviewMode,
              subtitles: generateSubtitles,
              signal: activeAudioAbort.signal,
              logger: async (msg: string) => {
                await fs.promises.appendFile(getLogPath('audio'), `${msg}\n`, 'utf-8').catch(() => {});
              }
            });
          }
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Done');
          await fs.promises.appendFile(getLogPath('audio'), `[OK] ${name}\n`, 'utf-8');
        } catch (err: any) {
          const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError' || err?.signal === 'SIGTERM';
          win.webContents.send('transcription-progress', name, i + 1, audioFiles.length,
            cancelled ? 'Cancelled' : 'Error'
          );
          if (cancelled) {
            await fs.promises.appendFile(getLogPath('audio'), `[WARN] ${name}: Cancelled by user\n`, 'utf-8').catch(() => {});
            throw new Error('terminated by user');
          }
          const detail = err?.message || err?.toString?.() || 'Unknown error';
          await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${name}: ${detail}\n`, 'utf-8').catch(() => {});
          throw err;
        }
      }

      activeAudioAbort = null;
      return `[OK] Processed ${audioFiles.length} audio file(s)`;
    } else {
      const imageModel = modelName || 'gemini-2.5-flash';
      const rawImagePrompt = ((store.get('imagePrompt') as string) || '').trim();
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
        const normalizedInputPath = path.resolve(inputPath);
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
          if (batchSelected) {
            const state = await readMistralBatchState(cacheDir);
            const nextJobs = state.jobs.filter(
              job => !matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName)
            );
            if (nextJobs.length !== state.jobs.length) {
              state.jobs = nextJobs;
              await writeMistralBatchState(cacheDir, state);
              await logInfo('Removed cached batch-job stats for completed folder.');
            }
          }
          return `[OK] All transcripts already exist for ${files.length} file(s)`;
        }

        let processedCount = 0;
        const totalWork = workFiles.length;
        if (batchSelected) {
          const activeFileSet = new Set(workFiles.map(file => path.resolve(file)));
          const unresolvedFiles = new Set(workFiles.map(file => path.resolve(file)));

          const makeBatchProgressLabel = (jobIndex: number, totalJobs: number): string => {
            const percentage = totalWork > 0 ? Math.round((processedCount / totalWork) * 100) : 100;
            return `${collectionName} - batch job ${jobIndex}/${totalJobs} - images processed ${processedCount}/${totalWork} (${percentage}%)`;
          };
          const markResolved = (filePath: string) => {
            const abs = path.resolve(filePath);
            if (!unresolvedFiles.has(abs)) return;
            unresolvedFiles.delete(abs);
            processedCount = totalWork - unresolvedFiles.size;
          };

          let state = await readMistralBatchState(cacheDir);
          const scopedJobs = state.jobs
            .filter(job => matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName))
            .sort(sortBatchJobsInOrder);
          const trackedFiles = new Set(
            scopedJobs
              .filter(job => shouldResumeBatchJob(job))
              .flatMap(job => job.files.map(file => path.resolve(file)))
          );
          const filesToSubmit = workFiles.filter(file => !trackedFiles.has(path.resolve(file)));
          const newChunks = partitionFiles(filesToSubmit, batchSize);
          let nextBatchOrder = scopedJobs.reduce((maxValue, job) => Math.max(maxValue, job.batchOrder), 0);

          if (newChunks.length) {
            await logInfo(`Submitting ${newChunks.length} batch job(s) before one status check...`);
          } else {
            await logInfo('No new batch jobs to submit. Resuming existing queued/running jobs.');
          }

          for (let idx = 0; idx < newChunks.length; idx++) {
            if (cancelRequested) {
              cancelMistralRequest();
              throw new Error('terminated by user');
            }

            const chunk = newChunks[idx].map(file => path.resolve(file));
            nextBatchOrder += 1;
            const queueLabel = makeBatchProgressLabel(idx + 1, newChunks.length);
            window?.webContents.send(
              'transcription-progress',
              queueLabel,
              processedCount,
              totalWork,
              `Submitting batch ${idx + 1}/${newChunks.length} (${chunk.length} file(s))...`
            );
            await logInfo(`Submitting batch ${idx + 1}/${newChunks.length} with ${chunk.length} file(s)`);

            try {
              const submission = await submitMistralBatchJob(chunk, mistralKey, modelName, {
                baseInput: inputPath,
                logger: logInfo,
                cacheDir,
                tempRoot: path.join(app.getPath('userData'), 'temp')
              });
              const nowMs = Date.now();
              const record: MistralBatchJobRecord = {
                id: submission.jobId,
                inputPath: normalizedInputPath,
                outputDir: normalizedOutputDir,
                modelName,
                files: chunk,
                batchOrder: nextBatchOrder,
                createdAtMs: nowMs,
                status: 'QUEUED',
                totalRequests: Math.max(submission.totalRequests, chunk.length),
                succeededRequests: 0,
                failedRequests: 0,
                outputFileId: null,
                lastProgressCount: 0,
                lastProgressAtMs: nowMs,
                writtenAtMs: null,
                lastError: null
              };
              state.jobs.push(record);
              await writeMistralBatchState(cacheDir, state);
              window?.webContents.send(
                'transcription-progress',
                queueLabel,
                processedCount,
                totalWork,
                `Queued batch ${idx + 1}/${newChunks.length} (job ${submission.jobId})`
              );
              await logInfo(`Queued batch job ${submission.jobId} (${chunk.length} request(s))`);
            } catch (err: any) {
              const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError';
              const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
              await fs.promises.appendFile(getLogPath('image'), `[ERR] batch submit ${idx + 1} - ${msg}\n`, 'utf-8').catch(() => {});
              if (cancelled) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }
              throw err;
            }
          }

          const persistJobUpdate = async (job: MistralBatchJobRecord) => {
            const existingIndex = state.jobs.findIndex(entry => entry.id === job.id);
            if (existingIndex >= 0) {
              state.jobs[existingIndex] = job;
            } else {
              state.jobs.push(job);
            }
            await writeMistralBatchState(cacheDir, state);
          };

          const moveScopedQueuedJobsToProcessing = async (): Promise<number> => {
            let movedCount = 0;
            const nowMs = Date.now();
            state.jobs = state.jobs.map(entry => {
              if (!matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName)) return entry;
              if (entry.writtenAtMs !== null) return entry;
              if (entry.status !== 'QUEUED') return entry;
              movedCount += 1;
              return {
                ...entry,
                status: 'RUNNING',
                lastProgressAtMs: entry.lastProgressAtMs > 0 ? entry.lastProgressAtMs : nowMs
              };
            });
            if (movedCount > 0) {
              await writeMistralBatchState(cacheDir, state);
            }
            return movedCount;
          };

          const jobsToProcess = state.jobs
            .filter(job => matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName))
            .filter(job => shouldResumeBatchJob(job))
            .map(job => ({
              ...job,
              files: job.files.map(file => path.resolve(file)).filter(file => activeFileSet.has(file))
            }))
            .filter(job => job.files.length > 0)
            .sort(sortBatchJobsInOrder);

          if (!jobsToProcess.length) {
            state.jobs = state.jobs.filter(
              job => !matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName)
            );
            await writeMistralBatchState(cacheDir, state);
            await logInfo('Removed cached batch-job stats for completed folder.');
            return `[OK] All transcripts already exist for ${files.length} file(s)`;
          }

          let completedJobsThisRun = 0;
          while (true) {
            const pendingJobs = state.jobs
              .filter(entry => matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName))
              .filter(entry => shouldResumeBatchJob(entry))
              .map(entry => ({
                ...entry,
                files: entry.files.map(file => path.resolve(file)).filter(file => activeFileSet.has(file))
              }))
              .filter(entry => entry.files.length > 0)
              .sort(sortBatchJobsInOrder);

            if (!pendingJobs.length) {
              state.jobs = state.jobs.filter(
                entry => !matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName)
              );
              await writeMistralBatchState(cacheDir, state);
              await logInfo('All batch jobs completed. Removed cached batch-job stats for this folder.');
              if (completedJobsThisRun > 0) {
                return `[OK] Completed ${completedJobsThisRun} batch job(s) in this run and finished batch queue for ${collectionName}.`;
              }
              return `[OK] Finished batch queue for ${collectionName}.`;
            }

            let targetJobIndex = pendingJobs.findIndex(entry =>
              entry.files.some(file => unresolvedFiles.has(path.resolve(file)))
            );
            if (targetJobIndex < 0) {
              for (const pendingJob of pendingJobs) {
                if (pendingJob.writtenAtMs !== null) continue;
                await persistJobUpdate({
                  ...pendingJob,
                  writtenAtMs: Date.now(),
                  status: 'SUCCESS',
                  lastError: null
                });
              }
              state.jobs = state.jobs.filter(
                entry => !matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName)
              );
              await writeMistralBatchState(cacheDir, state);
              await logInfo('All batch jobs already had outputs. Removed cached batch-job stats for this folder.');
              return `[OK] All transcripts already exist for ${files.length} file(s)`;
            }

            let job = pendingJobs[targetJobIndex];
            const jobPosition = targetJobIndex + 1;
            const totalJobs = pendingJobs.length;
            const unresolvedInJob = job.files.filter(file => unresolvedFiles.has(path.resolve(file)));

            if (cancelRequested) {
              cancelMistralRequest();
              throw new Error('terminated by user');
            }

            const polled = await fetchMistralBatchJobStatus(job.id, mistralKey);
            const doneRequests = polled.succeededRequests + polled.failedRequests;
            const totalRequests = Math.max(polled.totalRequests, job.totalRequests, unresolvedInJob.length, 1);
            const nowMs = Date.now();
            const progressed = doneRequests > job.lastProgressCount;
            const nextProgressAtMs = progressed ? nowMs : (job.lastProgressAtMs > 0 ? job.lastProgressAtMs : nowMs);
            job = {
              ...job,
              status: polled.status,
              totalRequests,
              succeededRequests: polled.succeededRequests,
              failedRequests: polled.failedRequests,
              outputFileId: polled.outputFileId,
              lastProgressCount: progressed ? doneRequests : job.lastProgressCount,
              lastProgressAtMs: nextProgressAtMs
            };
            await persistJobUpdate(job);
            const movedToProcessing = await moveScopedQueuedJobsToProcessing();
            if (movedToProcessing > 0) {
              if (job.status === 'QUEUED') {
                job = { ...job, status: 'RUNNING' };
              }
              await logInfo(`Moved ${movedToProcessing} queued batch job(s) to processing after oldest-job check.`);
            }

            const progressLabel = makeBatchProgressLabel(jobPosition, totalJobs);
            const statusMessage = `Checking oldest batch ${jobPosition}/${totalJobs} - ${job.status} ${doneRequests}/${totalRequests}`;
            window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, statusMessage);
            await logInfo(`Checked batch job ${job.id} once: status=${job.status} ${doneRequests}/${totalRequests}`);

            if (!isTerminalBatchStatus(job.status)) {
              const checkBackAt = job.createdAtMs + MISTRAL_BATCH_AVG_COMPLETION_MS;
              const checkBackLabel = formatLocalDateTime(checkBackAt);
              const msg = completedJobsThisRun > 0
                ? `Completed ${completedJobsThisRun} batch job(s) in this run. Next pending job ${job.id} is ${job.status} (${doneRequests}/${totalRequests}). Check back at ${checkBackLabel}.`
                : `Batch job ${job.id} is still ${job.status} (${doneRequests}/${totalRequests}). Check back at ${checkBackLabel}.`;
              window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, msg);
              await logInfo(msg);
              return `[INFO] ${msg}`;
            }

            if (job.status !== 'SUCCESS') {
              const msg = `Batch job ${job.id} ended with status ${job.status}.`;
              job = { ...job, lastError: msg };
              await persistJobUpdate(job);
              await fs.promises.appendFile(getLogPath('image'), `[ERR] ${msg}\n`, 'utf-8').catch(() => {});
              throw new Error(msg);
            }
            if (!job.outputFileId) {
              const msg = `Batch job ${job.id} succeeded but output file id is missing.`;
              job = { ...job, lastError: msg };
              await persistJobUpdate(job);
              await fs.promises.appendFile(getLogPath('image'), `[ERR] ${msg}\n`, 'utf-8').catch(() => {});
              throw new Error(msg);
            }

            window?.webContents.send(
              'transcription-progress',
              progressLabel,
              processedCount,
              totalWork,
              `Downloading results for oldest batch ${jobPosition}/${totalJobs}...`
            );
            const batchResults = await downloadMistralBatchResults(job.outputFileId, mistralKey);
            await logInfo(`Downloaded ${batchResults.size} result(s) for batch job ${job.id}`);

            for (const file of unresolvedInJob) {
              if (cancelRequested) {
                cancelMistralRequest();
                throw new Error('terminated by user');
              }
              const absFile = path.resolve(file);
              if (!unresolvedFiles.has(absFile)) continue;

              const name = path.basename(file);
              const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);
              markResolved(file);
              const percentage = totalWork > 0 ? Math.round((processedCount / totalWork) * 100) : 100;
              const writeLabel = `${collectionName} - batch job ${jobPosition}/${totalJobs} - images processed ${processedCount}/${totalWork} (${percentage}%)`;

              if (fs.existsSync(txtOut)) {
                window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Skipped');
                continue;
              }

              window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, `Writing ${name}...`);
              const relKey = baseIsFile
                ? path.basename(file)
                : path.relative(inputPath, file).split(path.sep).join('/');
              const text = batchResults.get(relKey);
              if (typeof text !== 'string') {
                const msg = `Missing OCR result for ${relKey}`;
                await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Error');
                throw new Error(msg);
              }

              await fs.promises.mkdir(path.dirname(txtOut), { recursive: true }).catch(() => {});
              await fs.promises.writeFile(txtOut, text, 'utf-8');
              window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Done');
              await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8');
            }

            job = { ...job, writtenAtMs: Date.now(), lastError: null };
            await persistJobUpdate(job);
            completedJobsThisRun += 1;

            const remainingJobs = state.jobs
              .filter(entry => matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName))
              .filter(entry => shouldResumeBatchJob(entry))
              .sort(sortBatchJobsInOrder);
            if (!remainingJobs.length) {
              state.jobs = state.jobs.filter(
                entry => !matchesBatchScope(entry, normalizedInputPath, normalizedOutputDir, modelName)
              );
              await writeMistralBatchState(cacheDir, state);
              await logInfo('All batch jobs completed. Removed cached batch-job stats for this folder.');
              return `[OK] Completed ${completedJobsThisRun} batch job(s) in this run and finished batch queue for ${collectionName}.`;
            }

            await logInfo(`Completed batch job ${job.id}. Checking next oldest pending batch immediately...`);
          }
        }

        for (let i = 0; i < workFiles.length; i++) {
          if (cancelRequested) {
            cancelMistralRequest();
            throw new Error('terminated by user');
          }
          const file = workFiles[i];
          const name = path.basename(file);
          const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);

          processedCount += 1;
          const percentage = Math.round((processedCount / totalWork) * 100);
          const progressLabel = `${collectionName} - images processed ${processedCount}/${totalWork} (${percentage}%)`;

          if (fs.existsSync(txtOut)) {
            window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, 'Skipped');
            continue;
          }

          window?.webContents.send('transcription-progress', progressLabel, processedCount, totalWork, `Transcribing ${name}...`);
          try {
            const text = await transcribeImageMistral(file, mistralKey, modelName);
            await fs.promises.mkdir(path.dirname(txtOut), { recursive: true }).catch(() => {});
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

        return `[OK] Processed ${workFiles.length} file(s) via Mistral OCR`;
      }

      geminiApiKey = (store.get('apiKey') || '').trim();
      if (!geminiApiKey) {
        throw new Error('Gemini API key not set. Please enter it in Settings.');
      }
      process.env.GOOGLE_API_KEY = geminiApiKey;

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
          // Call Gemini directly from TypeScript
          try {
            const out = await transcribeImageGemini(file, rawPrompt, imageModel, geminiApiKey, {
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

ipcMain.handle('open-batch-queue', () => {
  const parent = BrowserWindow.getAllWindows()[0];
  const parentBounds = parent.getBounds();

  const width = Math.floor(parentBounds.width * 0.72);
  const height = Math.floor(parentBounds.height * 0.7);

  const child = new BrowserWindow({
    width,
    height,
    minWidth: Math.floor(parentBounds.width * 0.5),
    minHeight: Math.floor(parentBounds.height * 0.5),
    parent,
    modal: true,
    resizable: true,
    backgroundColor: '#16161f',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  if (isDev()) {
    child.loadURL('http://localhost:5123/#/batch-queue');
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    const indexURL = pathToFileURL(indexPath).toString() + '#/batch-queue';
    child.loadURL(indexURL);
  }

  child.center();
});

ipcMain.handle('scan-quality', async (_e, folder: string, threshold: number) => {
  // clear any previous quality logs
  const qualityLog = getLogPath('quality');
  await fs.promises.writeFile(qualityLog, '', 'utf-8');
  const result = await scanQualityFolder(folder, threshold, {
    onProgress: async ({ processed, total, file, blankCount }) => {
      const percent = total > 0 ? Math.round((processed / total) * 100) : 100;
      _e.sender.send('quality-scan-progress', {
        processed,
        total,
        percent,
        file,
        blankCount
      });
    }
  });
  return result;
});
