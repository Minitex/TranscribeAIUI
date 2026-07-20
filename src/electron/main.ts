import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import {
  prepareImageForGemini,
  transcribePreparedImageGemini,
  cancelGeminiRequest
} from './geminiImage.js';
import {
  prepareImageForMistral,
  transcribePreparedImageMistralDetailed,
  submitMistralBatchJob,
  submitMistralAudioBatchJob,
  fetchMistralBatchJobStatus,
  downloadMistralBatchErrors,
  downloadMistralBatchResultsDetailed,
  cancelMistralRequest,
  isMistralSupported,
  type MistralOcrPageResult
} from './mistralImage.js';
import {
  transcribeAudioGemini,
  transcribeAudioMistral,
  cancelAudioRequest,
  downloadMistralAudioBatchResultsDetailed,
  writeMistralAudioBatchResult,
  estimateAudioBatchDurationMinutes
} from './audioTranscribe.js';
import { scanQualityFolder } from './qualityCheck.js';
import { rasterizePdfPages } from './pdfRasterize.js';
import Store from 'electron-store';
import { isDev } from './util.js';
import { pathToFileURL } from 'url';
import { getLogPath } from './logHelpers.js';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream
} from 'pdf-lib';
import {
  callMarkdownWorker,
  escapeHtml,
  sanitizeLanguageTag,
  resolveAccessibleDocumentTitle,
  type AccessiblePdfPageContent,
  type RenderMarkdownOptions
} from './markdownRenderWorker.js';

interface StoreSchema {
  apiKey?: string;
  audioModel?: string;
  imageModel?: string;
  audioPrompt?: string;
  imagePrompt?: string;
  mistralAudioContextBias?: string;
  mistralAudioLanguage?: string;
  mistralApiKey?: string;
  mistralBatchEnabled?: boolean;
  mistralAudioBatchEnabled?: boolean;
  mistralBatchPreprocessWorkers?: number;
  mistralBatchUploadWorkers?: number;
  folderFavorites?: string[];
  audioInputPath?: string;
  audioOutputDir?: string;
  imageInputPath?: string;
  imageOutputDir?: string;
  activeMode?: 'audio' | 'image';
}
const store = new Store<StoreSchema>();

// Some Macs hit a Chromium GPU-compositor bug here ("SharedImageManager::
// ProduceOverlay ... non-existent mailbox") that leaves the whole window
// permanently blank after a GPU-process hiccup, with no way to recover
// short of quitting. This is a pure text/table UI with nothing that needs
// GPU compositing, so trading it away avoids the crash class entirely.
// disableHardwareAcceleration() alone still leaves a GPU process running
// (just without compositing), which can still log the mailbox error below;
// the explicit switch prevents that process from starting at all.
// Must run before app is ready.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let mainWindow: BrowserWindow | null = null;
let cancelRequested = false;
let activeAudioAbort: AbortController | null = null;
let activeImageAbort: AbortController | null = null;

const ACCESSIBLE_PDF_PREFIX = 'ACCESSIBLE_';
// Hash routes (mirrored in src/ui/App.tsx)
const ROUTE_SETTINGS = '#/settings';
const ROUTE_BATCH_QUEUE = '#/batch-queue';
const AUDIO_MODEL_OPTIONS = [
  'voxtral-mini-latest',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash'
];
const IMAGE_MODEL_OPTIONS = [
  'mistral-ocr-latest',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash'
];
const DEFAULT_AUDIO_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash';
const MIN_MISTRAL_BATCH_WORKERS = 1;
const MAX_MISTRAL_BATCH_WORKERS = 5;
const DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS = 2;
const DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS = 2;
// Log file is trimmed to the last LOG_TRIM_KEEP_LINES lines once it exceeds this size.
const LOG_TRIM_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2MB
const LOG_TRIM_KEEP_LINES = 5000;
const DEFAULT_IMAGE_BATCH_SIZE = 10;
const DEFAULT_AUDIO_BATCH_SIZE = 25;

function normalizeSupportedModel(
  value: unknown,
  options: readonly string[],
  fallback: string
): string {
  if (typeof value === 'string' && options.includes(value)) {
    return value;
  }
  return fallback;
}

function normalizeMistralBatchWorkerCount(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MISTRAL_BATCH_WORKERS, Math.max(MIN_MISTRAL_BATCH_WORKERS, Math.floor(parsed)));
}

function createCancelledError(): Error {
  const err: any = new Error('terminated by user');
  err.cancelled = true;
  return err;
}

function isCancellationError(error: any, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted
    || error?.cancelled
    || error?.name === 'AbortError'
    || error?.signal === 'SIGTERM'
    || String(error?.message || '').includes('terminated by user')
  );
}

function createConcurrencyLimiter(limit: number) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (activeCount >= normalizedLimit) return;
    const nextTask = queue.shift();
    if (!nextTask) return;
    activeCount += 1;
    nextTask();
  };

  return async function schedule<T>(task: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const execute = () => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeCount = Math.max(0, activeCount - 1);
            runNext();
          });
      };
      queue.push(execute);
      runNext();
    });
  };
}

function formatImageProgressLabel(collectionName: string, processedCount: number, totalCount: number): string {
  const percentage = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 100;
  return `${collectionName} - images processed ${processedCount}/${totalCount} (${percentage}%)`;
}

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

function mistralPdfPathForTranscript(txtPath: string): string {
  const dir = path.dirname(txtPath);
  const base = path.basename(txtPath, path.extname(txtPath));
  return path.join(dir, `${ACCESSIBLE_PDF_PREFIX}${base}.pdf`);
}

function accessibleHtmlPathForPdf(pdfPath: string): string {
  const dir = path.dirname(pdfPath);
  const base = path.basename(pdfPath, path.extname(pdfPath));
  return path.join(dir, `${base}.html`);
}

// Kept in its own subfolder (rather than loose next to the .txt) so an output folder
// browsed in Finder/Explorer only shows the user's actual transcripts.
const OCR_METADATA_SUBDIR = '.mistral_ocr_meta';

function ocrReviewSidecarPathForTranscript(txtPath: string): string {
  const dir = path.dirname(txtPath);
  const base = path.basename(txtPath, path.extname(txtPath));
  return path.join(dir, OCR_METADATA_SUBDIR, `${base}.ocrmeta.json`);
}

// Sidecar is only written when Mistral actually returned confidence/blocks data
// (OCR 4+). Older responses or Gemini results simply produce no sidecar, and the review
// modal's double-click handler falls back to opening the file externally, same as today.
async function writeOcrReviewSidecar(txtPath: string, sourceImagePath: string, pages: MistralOcrPageResult[]): Promise<void> {
  const hasReviewData = pages.some(p => p.confidence || p.blocks);
  if (!hasReviewData) return;
  const sidecarPath = ocrReviewSidecarPathForTranscript(txtPath);
  const metaDir = path.dirname(sidecarPath);
  await fs.promises.mkdir(metaDir, { recursive: true }).catch(() => {});
  // A leading dot only hides a folder from Finder on macOS/Linux; Windows Explorer
  // needs the actual hidden file attribute set to match that behavior.
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => execFile('attrib', ['+h', metaDir], () => resolve()));
  }
  const payload = {
    sourceImagePath,
    pages: pages.map(p => ({
      index: p.index,
      dimensions: p.dimensions,
      blocks: p.blocks ?? [],
      words: p.confidence?.words ?? [],
      averageConfidence: p.confidence?.averagePageConfidenceScore,
      minimumConfidence: p.confidence?.minimumPageConfidenceScore
    }))
  };
  await fs.promises.writeFile(sidecarPath, JSON.stringify(payload), 'utf-8').catch(() => {});
}

function generatedSourceBaseName(fileName: string): string {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.srt')) {
    return fileName.replace(/\.(txt|srt)$/i, '');
  }
  if (
    lowerName.startsWith(ACCESSIBLE_PDF_PREFIX.toLowerCase())
    && (lowerName.endsWith('.pdf') || lowerName.endsWith('.html'))
  ) {
    return fileName.slice(ACCESSIBLE_PDF_PREFIX.length, lowerName.endsWith('.html') ? -5 : -4);
  }
  if (lowerName.endsWith('.pdf') || lowerName.endsWith('.html')) {
    return fileName.slice(0, lowerName.endsWith('.html') ? -5 : -4);
  }
  return fileName;
}

async function rebuildAccessiblePdfFromExistingHtml(pdfPath: string): Promise<boolean> {
  const htmlPath = accessibleHtmlPathForPdf(pdfPath);
  const hasHtml = await fs.promises.stat(htmlPath).then(() => true).catch(() => false);
  if (!hasHtml) return false;
  await compileAccessiblePdfFromHtml(htmlPath, pdfPath);
  return true;
}

// renderMarkdownLikeHtml (and its helper functions/types) used to live here
// as a large, synchronous, regex-heavy markdown-to-HTML renderer. A single
// big OCR export could take long enough on that single-pass regex chain to
// freeze the whole Electron app (every window, all IPC) while it ran on the
// main process's event loop. It now lives in markdownRenderWorker.ts and
// runs on a dedicated worker thread via callMarkdownWorker(), reused lazily
// across calls, so it can never block the main process regardless of input
// size.
async function renderMarkdownLikeHtml(
  markdown: string,
  minimumHeadingLevelOrOptions: number | RenderMarkdownOptions = 2
): Promise<string> {
  return callMarkdownWorker<string>('renderMarkdownLikeHtml', [markdown, minimumHeadingLevelOrOptions]);
}

function wrapUnmarkedContentAsArtifacts(streamText: string): string {
  const lines = streamText.split('\n');
  const output: string[] = [];
  let markedDepth = 0;
  let artifactOpen = false;

  const closeArtifact = () => {
    if (!artifactOpen) return;
    output.push('EMC');
    artifactOpen = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }

    const opensMarkedContent = trimmed === 'BMC'
      || trimmed === 'BDC'
      || trimmed.endsWith(' BMC')
      || trimmed.endsWith(' BDC');
    const closesMarkedContent = trimmed === 'EMC' || trimmed.endsWith(' EMC');

    if (opensMarkedContent) {
      closeArtifact();
      output.push(line);
      markedDepth += 1;
      continue;
    }

    if (closesMarkedContent) {
      output.push(line);
      markedDepth = Math.max(0, markedDepth - 1);
      continue;
    }

    if (markedDepth === 0) {
      if (!artifactOpen) {
        output.push('/Artifact BMC');
        artifactOpen = true;
      }
      output.push(line);
      continue;
    }

    output.push(line);
  }

  closeArtifact();
  return output.join('\n');
}

function replacePageContentStreamsWithArtifacts(pdfDoc: PDFDocument): void {
  const context = pdfDoc.context;

  const rewriteStream = (stream: PDFRawStream) => {
    const decodedBytes = decodePDFRawStream(stream).decode();
    const decodedText = Buffer.from(decodedBytes).toString('latin1');
    const rewrittenText = wrapUnmarkedContentAsArtifacts(decodedText);
    return context.flateStream(rewrittenText, {});
  };

  for (const page of pdfDoc.getPages()) {
    const contents = page.node.lookup(PDFName.of('Contents'));
    if (contents instanceof PDFArray) {
      for (let idx = 0; idx < contents.size(); idx++) {
        const stream = contents.lookup(idx);
        if (!(stream instanceof PDFRawStream)) continue;
        const replacementRef = context.register(rewriteStream(stream));
        contents.set(idx, replacementRef);
      }
      continue;
    }

    const stream = page.node.lookup(PDFName.of('Contents'));
    if (!(stream instanceof PDFRawStream)) continue;
    const replacementRef = context.register(rewriteStream(stream));
    page.node.set(PDFName.of('Contents'), replacementRef);
  }
}

function walkStructTree(node: PDFDict | undefined, visit: (node: PDFDict) => void, seen: Set<PDFDict> = new Set()): void {
  if (!(node instanceof PDFDict) || seen.has(node)) return;
  seen.add(node);
  visit(node);

  const kids = node.lookup(PDFName.of('K'));
  if (kids instanceof PDFArray) {
    for (let idx = 0; idx < kids.size(); idx++) {
      const child = kids.lookup(idx);
      if (child instanceof PDFDict) {
        walkStructTree(child, visit, seen);
      }
    }
    return;
  }

  if (kids instanceof PDFDict) {
    walkStructTree(kids, visit, seen);
  }
}

function countTableCells(rowNode: PDFDict): number {
  const kids = rowNode.lookup(PDFName.of('K'));
  if (!(kids instanceof PDFArray)) return 0;
  let count = 0;
  for (let idx = 0; idx < kids.size(); idx++) {
    const cell = kids.lookup(idx);
    if (!(cell instanceof PDFDict)) continue;
    const role = cell.lookup(PDFName.of('S'));
    const roleName = role instanceof PDFName ? role.decodeText() : '';
    if (roleName === 'TH' || roleName === 'TD') count += 1;
  }
  return count;
}

function getStructChildNodes(node: PDFDict): PDFDict[] {
  const kids = node.lookup(PDFName.of('K'));
  if (kids instanceof PDFArray) {
    const children: PDFDict[] = [];
    for (let idx = 0; idx < kids.size(); idx++) {
      const child = kids.lookup(idx);
      if (child instanceof PDFDict) children.push(child);
    }
    return children;
  }
  if (kids instanceof PDFDict) return [kids];
  return [];
}

function buildIndirectRefMap(pdfDoc: PDFDocument): Map<PDFDict, PDFRef> {
  const refMap = new Map<PDFDict, PDFRef>();
  for (const [ref, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) {
      refMap.set(obj, ref);
    }
  }
  return refMap;
}

function ensureRowKidsArray(context: PDFDocument['context'], rowNode: PDFDict): PDFArray {
  const kids = rowNode.lookup(PDFName.of('K'));
  if (kids instanceof PDFArray) return kids;
  const kidsArray = context.obj([]);
  if (kids instanceof PDFDict) kidsArray.push(kids);
  rowNode.set(PDFName.of('K'), kidsArray);
  return kidsArray;
}

function getTableAttributeDicts(cellNode: PDFDict): PDFDict[] {
  const attrs = cellNode.lookup(PDFName.of('A'));
  if (attrs instanceof PDFArray) {
    const dicts: PDFDict[] = [];
    for (let idx = 0; idx < attrs.size(); idx++) {
      const attr = attrs.lookup(idx);
      if (!(attr instanceof PDFDict)) continue;
      const owner = attr.lookup(PDFName.of('O'));
      if (owner instanceof PDFName && owner.decodeText() === 'Table') {
        dicts.push(attr);
      }
    }
    return dicts;
  }
  if (attrs instanceof PDFDict) {
    const owner = attrs.lookup(PDFName.of('O'));
    if (owner instanceof PDFName && owner.decodeText() === 'Table') return [attrs];
  }
  return [];
}

function getNonTableAttributeDicts(cellNode: PDFDict): PDFDict[] {
  const attrs = cellNode.lookup(PDFName.of('A'));
  if (attrs instanceof PDFArray) {
    const dicts: PDFDict[] = [];
    for (let idx = 0; idx < attrs.size(); idx++) {
      const attr = attrs.lookup(idx);
      if (!(attr instanceof PDFDict)) continue;
      const owner = attr.lookup(PDFName.of('O'));
      if (!(owner instanceof PDFName) || owner.decodeText() !== 'Table') {
        dicts.push(attr);
      }
    }
    return dicts;
  }
  if (attrs instanceof PDFDict) {
    const owner = attrs.lookup(PDFName.of('O'));
    if (!(owner instanceof PDFName) || owner.decodeText() !== 'Table') return [attrs];
  }
  return [];
}

function getCellColSpan(cellNode: PDFDict): number {
  const tableAttrs = getTableAttributeDicts(cellNode);
  let colSpan = 1;
  for (const attr of tableAttrs) {
    const value = attr.lookup(PDFName.of('ColSpan'));
    if (value && 'asNumber' in value && typeof value.asNumber === 'function') {
      colSpan = Math.max(colSpan, value.asNumber());
    }
  }
  return Math.max(colSpan, 1);
}

function inferPreferredCellRole(rowNode: PDFDict, rowIndex: number): 'TH' | 'TD' {
  const kids = getStructChildNodes(rowNode);
  if (kids.length) {
    let sawTd = false;
    let sawTh = false;
    for (const child of kids) {
      const role = child.lookup(PDFName.of('S'));
      if (!(role instanceof PDFName)) continue;
      const roleName = role.decodeText();
      if (roleName === 'TH') sawTh = true;
      if (roleName === 'TD') sawTd = true;
    }
    if (sawTh && !sawTd) return 'TH';
    if (sawTd) return 'TD';
  }
  return rowIndex === 0 ? 'TH' : 'TD';
}

function upsertCellGridAttributes(
  context: PDFDocument['context'],
  cellNode: PDFDict,
  colIndex: number,
  rowIndex: number,
  colSpan: number,
  rowSpan: number
): void {
  const preservedAttrs = getNonTableAttributeDicts(cellNode);
  const attrArray = context.obj([]);
  const gridAttr = context.obj({});
  gridAttr.set(PDFName.of('O'), PDFName.of('Table'));
  gridAttr.set(PDFName.of('ADBE_ColIndex'), context.obj(colIndex));
  gridAttr.set(PDFName.of('ADBE_RowIndex'), context.obj(rowIndex));
  gridAttr.set(PDFName.of('ColSpan'), context.obj(colSpan));
  gridAttr.set(PDFName.of('RowSpan'), context.obj(rowSpan));
  attrArray.push(gridAttr);
  for (const attr of preservedAttrs) attrArray.push(attr);
  cellNode.set(PDFName.of('A'), attrArray);
}

function buildEmptyTableCell(
  context: PDFDocument['context'],
  rowRef: PDFRef,
  roleName: 'TH' | 'TD'
): PDFDict {
  const cell = context.obj({});
  cell.set(PDFName.of('Type'), PDFName.of('StructElem'));
  cell.set(PDFName.of('S'), PDFName.of(roleName));
  cell.set(PDFName.of('P'), rowRef);
  cell.set(PDFName.of('K'), context.obj([]));
  cell.set(PDFName.of('A'), context.obj([]));
  return cell;
}

function ensureRegularTableRows(pdfDoc: PDFDocument): void {
  const context = pdfDoc.context;
  const refMap = buildIndirectRefMap(pdfDoc);
  const structTreeRoot = pdfDoc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
  const rootNode = structTreeRoot.lookup(PDFName.of('K'), PDFDict);

  walkStructTree(rootNode, (node) => {
    const role = node.lookup(PDFName.of('S'));
    if (!(role instanceof PDFName) || role.decodeText() !== 'Table') return;

    const kids = node.lookup(PDFName.of('K'));
    if (!(kids instanceof PDFArray)) return;

    const rowNodes = getStructChildNodes(node).filter(child => {
      const childRole = child.lookup(PDFName.of('S'));
      return childRole instanceof PDFName && childRole.decodeText() === 'TR';
    });

    if (!rowNodes.length) return;

    const maxCells = rowNodes.reduce((max, rowNode) => {
      const effectiveColumns = getStructChildNodes(rowNode).reduce((sum, cellNode) => {
        const role = cellNode.lookup(PDFName.of('S'));
        if (!(role instanceof PDFName)) return sum;
        const roleName = role.decodeText();
        if (roleName !== 'TH' && roleName !== 'TD') return sum;
        return sum + getCellColSpan(cellNode);
      }, 0);
      return Math.max(max, effectiveColumns);
    }, 0);
    if (maxCells <= 0) return;

    rowNodes.forEach((rowNode, rowIndex) => {
      const initialCells = getStructChildNodes(rowNode).filter(cellNode => {
        const role = cellNode.lookup(PDFName.of('S'));
        return role instanceof PDFName && ['TH', 'TD'].includes(role.decodeText());
      });
      if (!initialCells.length) return;

      let effectiveColumns = initialCells.reduce((sum, cellNode) => sum + getCellColSpan(cellNode), 0);
      const preferredRole = inferPreferredCellRole(rowNode, rowIndex);

      if (effectiveColumns < maxCells && initialCells.length === 1) {
        initialCells[0].set(PDFName.of('S'), PDFName.of('TH'));
        upsertCellGridAttributes(context, initialCells[0], 0, rowIndex, maxCells, 1);
        effectiveColumns = maxCells;
      }

      if (effectiveColumns >= maxCells) {
        let colIndex = 0;
        for (const cellNode of initialCells) {
          const colSpan = getCellColSpan(cellNode);
          upsertCellGridAttributes(context, cellNode, colIndex, rowIndex, colSpan, 1);
          colIndex += colSpan;
        }
        return;
      }

      const rowRef = refMap.get(rowNode);
      if (!rowRef) return;

      const kidsArray = ensureRowKidsArray(context, rowNode);
      for (let current = effectiveColumns; current < maxCells; current++) {
        const emptyCell = buildEmptyTableCell(context, rowRef, preferredRole);
        const emptyCellRef = context.register(emptyCell);
        kidsArray.push(emptyCellRef);
      }

      const normalizedCells = getStructChildNodes(rowNode).filter(cellNode => {
        const role = cellNode.lookup(PDFName.of('S'));
        return role instanceof PDFName && ['TH', 'TD'].includes(role.decodeText());
      });

      let colIndex = 0;
      for (const cellNode of normalizedCells) {
        const colSpan = getCellColSpan(cellNode);
        upsertCellGridAttributes(context, cellNode, colIndex, rowIndex, colSpan, 1);
        colIndex += colSpan;
      }
    });
  });
}

function ensureTableSummaryAttributes(pdfDoc: PDFDocument): void {
  const context = pdfDoc.context;
  const structTreeRoot = pdfDoc.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
  const rootNode = structTreeRoot.lookup(PDFName.of('K'), PDFDict);

  walkStructTree(rootNode, (node) => {
    const role = node.lookup(PDFName.of('S'));
    if (!(role instanceof PDFName) || role.decodeText() !== 'Table') return;

    const kids = node.lookup(PDFName.of('K'));
    if (!(kids instanceof PDFArray)) return;

    const rowNodes: PDFDict[] = [];
    for (let idx = 0; idx < kids.size(); idx++) {
      const child = kids.lookup(idx);
      if (!(child instanceof PDFDict)) continue;
      const childRole = child.lookup(PDFName.of('S'));
      if (childRole instanceof PDFName && childRole.decodeText() === 'TR') {
        rowNodes.push(child);
      }
    }

    if (!rowNodes.length) return;

    const colCount = rowNodes.reduce((max, rowNode) => Math.max(max, countTableCells(rowNode)), 0);
    const headerRowCount = rowNodes[0] ? 1 : 0;
    const dataRowCount = Math.max(0, rowNodes.length - headerRowCount);
    const summaryText = `Data table with ${Math.max(colCount, 1)} columns and ${dataRowCount} rows.`;

    const existingAttributes = node.lookup(PDFName.of('A'));
    const newSummaryAttr = context.obj({
      O: PDFName.of('Table'),
      Summary: PDFString.of(summaryText)
    });

    if (existingAttributes instanceof PDFArray) {
      let hasSummary = false;
      for (let idx = 0; idx < existingAttributes.size(); idx++) {
        const attr = existingAttributes.lookup(idx);
        if (!(attr instanceof PDFDict)) continue;
        const owner = attr.lookup(PDFName.of('O'));
        const summary = attr.lookup(PDFName.of('Summary'));
        if (owner instanceof PDFName && owner.decodeText() === 'Table' && summary) {
          hasSummary = true;
          break;
        }
      }
      if (!hasSummary) existingAttributes.push(newSummaryAttr);
      return;
    }

    if (existingAttributes instanceof PDFDict) {
      const owner = existingAttributes.lookup(PDFName.of('O'));
      const summary = existingAttributes.lookup(PDFName.of('Summary'));
      if (owner instanceof PDFName && owner.decodeText() === 'Table' && summary) return;
      const attrArray = context.obj([]);
      attrArray.push(existingAttributes);
      attrArray.push(newSummaryAttr);
      node.set(PDFName.of('A'), attrArray);
      return;
    }

    const attrArray = context.obj([]);
    attrArray.push(newSummaryAttr);
    node.set(PDFName.of('A'), attrArray);
  });
}

async function remediateAccessiblePdf(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  replacePageContentStreamsWithArtifacts(pdfDoc);
  ensureRegularTableRows(pdfDoc);
  ensureTableSummaryAttributes(pdfDoc);
  const outlines = pdfDoc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
  if (outlines instanceof PDFDict) {
    pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  }
  return await pdfDoc.save({ useObjectStreams: false });
}

async function buildSearchablePdfHtml(
  title: string,
  text: string,
  pages: AccessiblePdfPageContent[] = [],
  language: string = 'en'
): Promise<string> {
  const safeTitle = escapeHtml(title || 'OCR Transcript');
  const safeLanguage = escapeHtml(sanitizeLanguageTag(language));
  const hasPages = pages.length > 0;
  const pageBlocks = hasPages
    ? (await Promise.all(pages.map(async (page, idx) => {
      const pageNumber = page.index || (idx + 1);
      const pageId = `ocr-page-${pageNumber}`;
      const contentHtml = await renderMarkdownLikeHtml(page.markdownWithImages || '', { minimumHeadingLevel: 1, renderMode: 'pdf' });
      return `<article class="ocr-page ocr-page-content" id="${pageId}" data-page="${pageNumber}"><p class="ocr-page-meta">Page ${pageNumber}</p>${contentHtml}</article>`;
    }))).join('')
    : '';
  const fallbackHtml = await renderMarkdownLikeHtml(text || '', { minimumHeadingLevel: 1, renderMode: 'pdf' });
  return `<!doctype html>
<html lang="${safeLanguage}" xml:lang="${safeLanguage}">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Language" content="${safeLanguage}" />
    <meta name="description" content="OCR transcript rendered as an accessible PDF." />
    <meta name="generator" content="TranscribeAI OCR" />
    <title>${safeTitle}</title>
    <style>
      @page {
        size: A4;
        margin: 16mm;
      }
      body {
        margin: 0;
        color: #111;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: 11pt;
        line-height: 1.45;
      }
      .fallback-text {
        word-wrap: break-word;
      }
      .ocr-page {
        box-sizing: border-box;
        padding: 0;
        margin: 0;
        page-break-after: always;
        break-after: page;
        overflow: visible;
      }
      .ocr-page:last-child {
        page-break-after: auto;
        break-after: auto;
      }
      .ocr-page-meta {
        font-size: 9pt;
        color: #666;
        margin: 0 0 0.35rem 0;
      }
      .ocr-page-content {
        white-space: normal;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }
      .ocr-page-content p { margin: 0 0 0.5rem 0; }
      .ocr-page-content h1, .ocr-page-content h2, .ocr-page-content h3,
      .ocr-page-content h4, .ocr-page-content h5, .ocr-page-content h6 {
        margin: 0.8rem 0 0.4rem 0;
        line-height: 1.25;
      }
      .ocr-page-content ul, .ocr-page-content ol {
        margin: 0.35rem 0 0.5rem 1.2rem;
        padding-left: 1.2rem;
      }
      .ocr-page-content .ocr-unordered-list {
        list-style: disc outside;
      }
      .ocr-page-content .ocr-ordered-list {
        list-style: decimal outside;
      }
      .ocr-page-content blockquote {
        margin: 0.5rem 0;
        padding: 0;
      }
      .ocr-page-content pre {
        margin: 0.6rem 0;
        padding: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocr-page-content code {
        font-family: "SFMono-Regular", Menlo, Consolas, monospace;
      }
      .ocr-page-content .ocr-math-inline {
        display: inline-block;
        vertical-align: middle;
      }
      .ocr-page-content .ocr-math-inline math {
        display: inline;
      }
      .ocr-page-content .ocr-math-display {
        margin: 0.5rem 0;
      }
      .ocr-page-content .ocr-math-display math {
        display: block;
      }
      .ocr-page-content .ocr-math-fallback {
        margin: 0.5rem 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocr-page-content table {
        border-collapse: collapse;
        width: 100%;
        margin: 0.6rem 0;
      }
      .ocr-page-content caption {
        text-align: left;
        margin-bottom: 0.3rem;
      }
      .ocr-page-content th, .ocr-page-content td {
        border: 0;
        padding: 0.2rem 0.3rem;
        vertical-align: top;
        text-align: left;
      }
      .ocr-page-content img {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 4mm auto;
        page-break-inside: avoid;
        break-inside: avoid-page;
        clear: both;
      }
      .ocr-page-content .ocr-inline-image {
        display: block;
      }
      .ocr-page-content a {
        color: inherit;
        text-decoration: none;
      }
      .ocr-page-content .ocr-image-note {
        display: block;
        margin: 0.5rem 0;
        color: #444;
      }
    </style>
  </head>
  <body>${hasPages ? pageBlocks : `<article class="fallback-text ocr-page-content">${fallbackHtml}</article>`}</body>
</html>`;
}

async function buildAccessibleHtmlSidecar(
  title: string,
  text: string,
  pages: AccessiblePdfPageContent[] = [],
  language: string = 'en'
): Promise<string> {
  const safeTitle = escapeHtml(title || 'OCR Transcript');
  const safeLanguage = escapeHtml(sanitizeLanguageTag(language));
  const hasPages = pages.length > 0;
  const pageCount = hasPages ? pages.length : 1;
  const fallbackHtml = await renderMarkdownLikeHtml(text || '', { minimumHeadingLevel: 2, renderMode: 'sidecar' });
  const pageNav = pageCount > 1
    ? `<nav class="page-nav" aria-labelledby="page-nav-heading">
      <span class="sr-only" id="page-nav-heading">On this page</span>${pages.map((page, idx) => {
      const pageNumber = page.index || (idx + 1);
      return `<a class="page-chip" href="#ocr-page-section-${pageNumber}">Page ${pageNumber}</a>`;
    }).join('')}</nav>`
    : '';
  const pageSections = hasPages
    ? (await Promise.all(pages.map(async (page, idx) => {
      const pageNumber = page.index || (idx + 1);
      const pageHeadingId = `ocr-page-heading-${pageNumber}`;
      const contentHtml = await renderMarkdownLikeHtml(page.markdownWithImages || '', { minimumHeadingLevel: 3, renderMode: 'sidecar' });
      return `<section class="page-card" id="ocr-page-section-${pageNumber}" aria-labelledby="${pageHeadingId}">
        <div class="page-card-header">
          <div>
            <h2 class="page-section-label" id="${pageHeadingId}">Page ${pageNumber}</h2>
          </div>
          <a class="page-jump" href="#top">Back to top</a>
        </div>
        <article class="ocr-page-content" data-page="${pageNumber}">${contentHtml}</article>
      </section>`;
    }))).join('')
    : `<section class="page-card" id="ocr-page-section-1" aria-labelledby="ocr-page-heading-1">
      <div class="page-card-header">
        <div>
          <h2 class="page-section-label" id="ocr-page-heading-1">Document content</h2>
        </div>
        <a class="page-jump" href="#top">Back to top</a>
      </div>
      <article class="ocr-page-content fallback-text">${fallbackHtml}</article>
    </section>`;

  return `<!doctype html>
<html lang="${safeLanguage}" xml:lang="${safeLanguage}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Language" content="${safeLanguage}" />
    <meta name="description" content="Accessible OCR transcript exported by TranscribeAI." />
    <meta name="generator" content="TranscribeAI OCR" />
    <title>${safeTitle}</title>
    <style>
      :root {
        color-scheme: light;
        --page-bg: #f4f6f8;
        --panel-bg: #ffffff;
        --panel-border: #d9e0e7;
        --panel-shadow: 0 10px 28px rgba(12, 32, 56, 0.08);
        --text: #142033;
        --muted: #566273;
        --accent: #0d6a8a;
        --accent-soft: #e7f4f8;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        color: var(--text);
        background: linear-gradient(180deg, #eef5f7 0%, var(--page-bg) 22%, var(--page-bg) 100%);
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: 16px;
        line-height: 1.6;
      }
      .skip-link {
        position: absolute;
        left: 16px;
        top: 16px;
        z-index: 20;
        padding: 10px 14px;
        border-radius: 10px;
        background: #0b4f67;
        color: #fff;
        text-decoration: none;
        transform: translateY(-180%);
      }
      .skip-link:focus {
        transform: translateY(0);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
      .shell {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      .doc-header {
        margin-bottom: 18px;
        padding: 24px 24px 18px;
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        background: var(--panel-bg);
        box-shadow: var(--panel-shadow);
      }
      .doc-header h1 {
        margin: 0;
        font-size: clamp(1.8rem, 3vw, 2.8rem);
        line-height: 1.15;
      }
      .doc-summary {
        margin: 10px 0 0;
        color: var(--muted);
        max-width: 72ch;
      }
      .page-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 0 0 20px;
      }
      .page-chip {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.88);
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
      }
      .document-body {
        display: grid;
        gap: 20px;
      }
      .page-card {
        padding: 24px;
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        background: var(--panel-bg);
        box-shadow: var(--panel-shadow);
      }
      .page-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
        padding-bottom: 14px;
        border-bottom: 1px solid #edf1f4;
      }
      .page-card-header h2 {
        margin: 0;
        font-size: 1.35rem;
        line-height: 1.2;
      }
      .page-section-label {
        font-size: 0.95rem;
        font-weight: 500;
        color: var(--muted);
        line-height: 1.2;
      }
      .page-jump {
        color: var(--accent);
        font-weight: 600;
        text-decoration: underline;
        text-underline-offset: 0.16em;
        white-space: nowrap;
      }
      .fallback-text {
        word-wrap: break-word;
      }
      .ocr-page-content {
        white-space: normal;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }
      .ocr-page-content p {
        margin: 0 0 0.75rem 0;
      }
      .ocr-page-content h1, .ocr-page-content h2, .ocr-page-content h3,
      .ocr-page-content h4, .ocr-page-content h5, .ocr-page-content h6 {
        margin: 1.1rem 0 0.5rem 0;
        line-height: 1.25;
      }
      .ocr-page-content ul, .ocr-page-content ol {
        margin: 0.35rem 0 0.8rem 1.25rem;
        padding-left: 1.2rem;
      }
      .ocr-page-content .ocr-unordered-list,
      .ocr-page-content .ocr-ordered-list {
        margin-left: 0;
      }
      .ocr-page-content .ocr-unordered-list {
        list-style: disc outside;
      }
      .ocr-page-content .ocr-ordered-list {
        list-style: decimal outside;
      }
      .ocr-page-content blockquote {
        margin: 0.9rem 0;
        padding: 0.1rem 0 0.1rem 1rem;
        border-left: 4px solid #cddae6;
        color: #334155;
      }
      .ocr-page-content pre {
        margin: 0.8rem 0;
        padding: 0.9rem 1rem;
        border-radius: 12px;
        background: #f7fafc;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocr-page-content code {
        font-family: "SFMono-Regular", Menlo, Consolas, monospace;
      }
      .ocr-page-content .ocr-math-inline {
        display: inline-block;
        vertical-align: middle;
      }
      .ocr-page-content .ocr-math-inline math {
        display: inline;
      }
      .ocr-page-content .ocr-math-display {
        margin: 0.7rem 0;
      }
      .ocr-page-content .ocr-math-display math {
        display: block;
      }
      .ocr-page-content .ocr-math-fallback {
        margin: 0.7rem 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocr-page-content table {
        width: 100%;
        margin: 1rem 0;
        border-collapse: collapse;
        border-radius: 14px;
        overflow: hidden;
      }
      .ocr-page-content caption {
        margin-bottom: 0.5rem;
        text-align: left;
        font-weight: 700;
      }
      .ocr-page-content th,
      .ocr-page-content td {
        padding: 0.7rem 0.8rem;
        border: 1px solid #dbe4ec;
        vertical-align: top;
        text-align: left;
      }
      .ocr-page-content th {
        background: #eef6fa;
      }
      .ocr-page-content img {
        display: block;
        max-width: min(100%, 860px);
        height: auto;
        margin: 1rem auto;
        border: 1px solid #dbe4ec;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
      }
      .ocr-page-content .ocr-figure {
        margin: 1rem 0 1.25rem;
      }
      .ocr-page-content .ocr-figure-caption {
        margin-top: 0.65rem;
        color: var(--muted);
      }
      .ocr-page-content a {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 0.16em;
      }
      .ocr-page-content .ocr-image-note {
        display: block;
        margin: 0.75rem 0;
        color: var(--muted);
      }
      @page {
        size: A4;
        margin: 16mm;
      }
      @media print {
        body {
          background: #fff;
          color: #111;
          font-size: 10pt;
          line-height: 1.45;
        }
        .skip-link,
        .page-nav,
        .page-jump {
          display: none !important;
        }
        .shell {
          max-width: none;
          margin: 0;
          padding: 0;
        }
        .doc-header,
        .page-card {
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
        }
        .doc-header {
          margin-bottom: 0.75rem;
        }
        .page-card {
          margin: 0;
          page-break-after: always;
          break-after: page;
        }
        .page-card:last-child {
          page-break-after: auto;
          break-after: auto;
        }
        .page-card-header {
          display: block;
          margin-bottom: 0.5rem;
          padding-bottom: 0;
          border-bottom: 0;
        }
        .page-section-label {
          font-size: 9pt;
          font-weight: 500;
          color: #666;
          line-height: 1.2;
        }
        .ocr-page-content table {
          margin: 0.6rem 0;
        }
        .ocr-page-content th,
        .ocr-page-content td {
          border: 0.5pt solid #c7d5e0;
          padding: 0.2rem 0.3rem;
        }
        .ocr-page-content th {
          background: #eef6fa;
        }
        .ocr-page-content img {
          max-width: 100%;
          margin: 4mm auto;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
          page-break-inside: avoid;
          break-inside: avoid-page;
        }
        .ocr-page-content a {
          color: inherit;
          text-decoration: none;
        }
      }
      a:focus-visible {
        outline: 3px solid #0b4f67;
        outline-offset: 3px;
        border-radius: 8px;
      }
      @media (max-width: 760px) {
        .shell {
          padding: 20px 14px 32px;
        }
        .doc-header,
        .page-card {
          padding: 18px;
          border-radius: 16px;
        }
        .page-card-header {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <div class="shell">
      <header class="doc-header" id="top">
        <h1>${safeTitle}</h1>
      </header>
      ${pageNav}
      <main class="document-body" id="main-content" tabindex="-1">${pageSections}</main>
    </div>
  </body>
</html>`;
}

// Each call spins up a hidden Chromium renderer (BrowserWindow) to print the
// PDF. That's fine one at a time, but the OCR batch pool runs up to
// MAX_MISTRAL_BATCH_WORKERS of these concurrently, which on weak/integrated
// GPUs can spike memory and stall the main window. Cap it independently,
// well below the batch worker count.
const PDF_EXPORT_CONCURRENCY = 2;
const pdfExportLimiter = createConcurrencyLimiter(PDF_EXPORT_CONCURRENCY);

async function compileAccessiblePdfFromHtml(
  htmlPath: string,
  outPath: string
): Promise<void> {
  return pdfExportLimiter(() => compileAccessiblePdfFromHtmlUnthrottled(htmlPath, outPath));
}

async function compileAccessiblePdfFromHtmlUnthrottled(
  htmlPath: string,
  outPath: string
): Promise<void> {
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    await pdfWindow.loadFile(htmlPath);
    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      generateTaggedPDF: true,
      generateDocumentOutline: true
    });
    const remediatedPdfBuffer = await remediateAccessiblePdf(pdfBuffer);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
    await fs.promises.writeFile(outPath, remediatedPdfBuffer);
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
  }
}

async function writeSearchablePdfFromText(
  text: string,
  outPath: string,
  title: string,
  pages: AccessiblePdfPageContent[] = [],
  language: string = 'en'
): Promise<void> {
  const htmlOutPath = accessibleHtmlPathForPdf(outPath);
  const resolvedTitle = resolveAccessibleDocumentTitle(title, text, pages);
  const sidecarHtml = await buildAccessibleHtmlSidecar(resolvedTitle, text, pages, language);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
  await fs.promises.writeFile(htmlOutPath, sidecarHtml, 'utf-8');
  await compileAccessiblePdfFromHtml(htmlOutPath, outPath);
}

function toAccessiblePdfPages(pages: MistralOcrPageResult[]): AccessiblePdfPageContent[] {
  if (!Array.isArray(pages) || pages.length === 0) return [];
  return pages.map((page, idx) => ({
    index: typeof page?.index === 'number' && page.index > 0 ? page.index : idx + 1,
    markdownWithImages: typeof page?.markdownWithImages === 'string'
      ? page.markdownWithImages
      : (typeof page?.markdown === 'string' ? page.markdown : ''),
    dimensions: {
      width: page?.dimensions?.width,
      height: page?.dimensions?.height,
      dpi: page?.dimensions?.dpi
    }
  }));
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
  subtitles?: boolean;
  interviewMode?: boolean;
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

async function readLogTail(mode: string, maxBytes: number = 256 * 1024): Promise<string> {
  const normalizedMaxBytes = Math.min(1024 * 1024, Math.max(8 * 1024, Math.floor(Number(maxBytes) || 0)));
  const logPath = getLogPath(mode);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(logPath, 'r');
    const stat = await handle.stat();
    if (!stat.size) return '';

    const bytesToRead = Math.min(normalizedMaxBytes, stat.size);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);

    let text = buffer.toString('utf-8');
    if (stat.size > bytesToRead) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      }
    }

    return text;
  } catch {
    return '';
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
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
  const outputFileId = typeof raw.outputFileId === 'string' && raw.outputFileId ? raw.outputFileId : null;
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'QUEUED';
  const normalizedStatus = rawStatus === 'SUCCESS' && outputFileId === null && failedRequests > 0
    ? 'FAILED'
    : rawStatus;
  return {
    id: raw.id.trim(),
    inputPath: raw.inputPath,
    outputDir: raw.outputDir,
    modelName: typeof raw.modelName === 'string' ? raw.modelName : '',
    files: Array.isArray(raw.files) ? raw.files.filter((item: unknown): item is string => typeof item === 'string') : [],
    batchOrder: Math.max(normalizeCount(raw.batchOrder), 1),
    createdAtMs,
    status: normalizedStatus,
    totalRequests,
    succeededRequests,
    failedRequests,
    outputFileId,
    lastProgressCount,
    lastProgressAtMs: normalizeTimestamp(raw.lastProgressAtMs, lastProgressAtFallback),
    writtenAtMs: raw.writtenAtMs === null || raw.writtenAtMs === undefined
      ? null
      : normalizeTimestamp(raw.writtenAtMs, createdAtMs),
    lastError: typeof raw.lastError === 'string' && raw.lastError ? raw.lastError : null,
    subtitles: typeof raw.subtitles === 'boolean' ? raw.subtitles : undefined,
    interviewMode: typeof raw.interviewMode === 'boolean' ? raw.interviewMode : undefined
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

ipcMain.handle(
  'get-audio-model',
  () => normalizeSupportedModel(store.get('audioModel'), AUDIO_MODEL_OPTIONS, DEFAULT_AUDIO_MODEL)
);
ipcMain.handle('set-audio-model', (_e, m: string) => {
  store.set('audioModel', normalizeSupportedModel(m, AUDIO_MODEL_OPTIONS, DEFAULT_AUDIO_MODEL));
});

ipcMain.handle(
  'get-image-model',
  () => normalizeSupportedModel(store.get('imageModel'), IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL)
);
ipcMain.handle('set-image-model', (_e, m: string) => {
  store.set('imageModel', normalizeSupportedModel(m, IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL));
});

ipcMain.handle('get-audio-prompt', () => store.get('audioPrompt') || '');
ipcMain.handle('set-audio-prompt', (_e, p: string) => { store.set('audioPrompt', p); });

ipcMain.handle('get-mistral-audio-context-bias', () => store.get('mistralAudioContextBias') || '');
ipcMain.handle('set-mistral-audio-context-bias', (_e, v: string) => { store.set('mistralAudioContextBias', v); });

ipcMain.handle('get-mistral-audio-language', () => store.get('mistralAudioLanguage') || '');
ipcMain.handle('set-mistral-audio-language', (_e, v: string) => { store.set('mistralAudioLanguage', v); });

ipcMain.handle('get-image-prompt', () => store.get('imagePrompt') || '');
ipcMain.handle('set-image-prompt', (_e, p: string) => { store.set('imagePrompt', p); });

ipcMain.handle('get-mistral-key', () => store.get('mistralApiKey') || '');
ipcMain.handle('set-mistral-key', (_e, key: string) => { store.set('mistralApiKey', key); });

ipcMain.handle('get-mistral-batch-enabled', () => store.get('mistralBatchEnabled') ?? false);
ipcMain.handle('set-mistral-batch-enabled', (_e, value: boolean) => {
  if (typeof value !== 'boolean') return;
  store.set('mistralBatchEnabled', value);
});

ipcMain.handle('get-mistral-audio-batch-enabled', () => store.get('mistralAudioBatchEnabled') ?? false);
ipcMain.handle('set-mistral-audio-batch-enabled', (_e, value: boolean) => {
  if (typeof value !== 'boolean') return;
  store.set('mistralAudioBatchEnabled', value);
});
ipcMain.handle(
  'get-mistral-batch-preprocess-workers',
  () => normalizeMistralBatchWorkerCount(
    store.get('mistralBatchPreprocessWorkers'),
    DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS
  )
);
ipcMain.handle('set-mistral-batch-preprocess-workers', (_e, value: number) => {
  store.set(
    'mistralBatchPreprocessWorkers',
    normalizeMistralBatchWorkerCount(value, DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS)
  );
});
ipcMain.handle(
  'get-mistral-batch-upload-workers',
  () => normalizeMistralBatchWorkerCount(
    store.get('mistralBatchUploadWorkers'),
    DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
  )
);
ipcMain.handle('set-mistral-batch-upload-workers', (_e, value: number) => {
  store.set(
    'mistralBatchUploadWorkers',
    normalizeMistralBatchWorkerCount(value, DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS)
  );
});

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
  'remove-mistral-batch-folder',
  async (
    _e,
    payload: { inputPath?: string; outputDir?: string; modelName?: string }
  ): Promise<{ ok: boolean; error?: string }> => {
    const rawInputPath = typeof payload?.inputPath === 'string' ? payload.inputPath.trim() : '';
    const rawOutputDir = typeof payload?.outputDir === 'string' ? payload.outputDir.trim() : '';
    const modelName = typeof payload?.modelName === 'string' ? payload.modelName.trim() : '';
    if (!rawInputPath || !rawOutputDir || !modelName) {
      return { ok: false, error: 'Missing input/output folder path.' };
    }

    const inputPath = path.resolve(rawInputPath);
    const outputDir = path.resolve(rawOutputDir);
    const cacheDir = path.join(app.getPath('userData'), 'temp', 'mistral_cache');
    const state = await readMistralBatchState(cacheDir);
    state.jobs = state.jobs.filter(job => !matchesBatchScope(job, inputPath, outputDir, modelName));
    await writeMistralBatchState(cacheDir, state);
    return { ok: true };
  }
);

// Rough pre-submit estimate shown before a batch run: image cost approximates
// pages as file count (most scans are one page; multi-page PDFs will
// undercount — no cheaper way to know page count without OCRing first).
// Audio cost sums real probed durations, so that side is exact.
ipcMain.handle(
  'estimate-batch-cost',
  async (_e, payload: { mode?: 'audio' | 'image'; inputPath?: string }): Promise<{ unit: 'page' | 'minute'; fileCount: number; quantity: number } | null> => {
    const inputPath = typeof payload?.inputPath === 'string' ? payload.inputPath.trim() : '';
    if (!inputPath) return null;
    try {
      const stat = await fs.promises.stat(inputPath);
      if (!stat.isDirectory()) return null;
      const names = await fs.promises.readdir(inputPath);
      if (payload?.mode === 'audio') {
        const files = names
          .filter(f => /\.(mp3|mp4|wav|m4a|aac|flac|ogg|avi)$/i.test(f))
          .map(f => path.join(inputPath, f));
        const totalMinutes = await estimateAudioBatchDurationMinutes(files);
        return { unit: 'minute', fileCount: files.length, quantity: totalMinutes };
      }
      const files = names.filter(f => isMistralSupported(path.join(inputPath, f)));
      return { unit: 'page', fileCount: files.length, quantity: files.length };
    } catch {
      return null;
    }
  }
);

ipcMain.handle(
  'select-mistral-batch-folder',
  async (
    _e,
    payload: { inputPath?: string; outputDir?: string; modelName?: string }
  ): Promise<{ ok: boolean; error?: string }> => {
    const rawInputPath = typeof payload?.inputPath === 'string' ? payload.inputPath.trim() : '';
    const rawOutputDir = typeof payload?.outputDir === 'string' ? payload.outputDir.trim() : '';
    if (!rawInputPath || !rawOutputDir) {
      return { ok: false, error: 'Missing input/output folder path.' };
    }

    const inputPath = path.resolve(rawInputPath);
    const outputDir = path.resolve(rawOutputDir);
    const mode: 'audio' | 'image' = String(payload?.modelName || '').toLowerCase().includes('voxtral')
      ? 'audio'
      : 'image';

    if (mode === 'audio') {
      store.set('audioInputPath', inputPath);
      store.set('audioOutputDir', outputDir);
    } else {
      store.set('imageInputPath', inputPath);
      store.set('imageOutputDir', outputDir);
    }
    store.set('activeMode', mode);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mistral-batch-folder-selected', inputPath, outputDir, mode);
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
    .filter(f => {
      const lowerName = f.toLowerCase();
      return lowerName.endsWith('.txt')
        || lowerName.endsWith('.srt')
        || lowerName.endsWith('.pdf')
        || lowerName.endsWith('.html');
    })
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

// Rebuilds a searchable PDF straight from the current .txt content after a
// manual edit in the review modal. Uses an empty pages[] (an already-supported
// fallback in writeSearchablePdfFromText) since the edited plain text no
// longer maps onto the original OCR's per-page markdown/image structure —
// the rebuilt PDF is plain-text-searchable but won't re-embed figures.
ipcMain.handle('regenerate-searchable-pdf', async (_e, txtPath: string, pdfPath: string) => {
  try {
    const text = await fs.promises.readFile(txtPath, 'utf-8');
    const title = path.basename(txtPath, path.extname(txtPath));
    await writeSearchablePdfFromText(text, pdfPath, title, []);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
});

// The OCR review modal has no way to preview a PDF-sourced scan directly (an
// <img> can't render PDF bytes, and this codebase has no PDF rasterization
// lib) — this renders each page to a cached PNG next to the OCR sidecar so
// the modal can show it through the same <img>-based preview pane as an
// image-sourced review.
ipcMain.handle('rasterize-pdf-pages', async (_e, txtPath: string, pdfPath: string, pageCount: number) => {
  try {
    const sidecarPath = ocrReviewSidecarPathForTranscript(txtPath);
    const base = path.basename(sidecarPath, '.ocrmeta.json');
    // Scoped by this transcript's own basename -- the sidecar directory
    // (.mistral_ocr_meta) is shared across every file in the output folder,
    // so an unscoped 'pdf-pages' subfolder would collide page-1.png,
    // page-2.png, etc. across different PDFs batched into the same folder,
    // serving one document's cached pages for another.
    const outDir = path.join(path.dirname(sidecarPath), 'pdf-pages', base);
    const pagePaths = await rasterizePdfPages(pdfPath, outDir, pageCount);
    return { ok: true, pagePaths };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('delete-generated-family', async (_e, filePath: string) => {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: 'Missing file path' };
    }
    const targetPath = path.resolve(filePath);
    const targetName = path.basename(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    if (ext !== '.pdf' && ext !== '.html') {
      return { ok: false, error: 'Selected file is not a generated PDF or HTML file' };
    }
    const isFile = await fs.promises.stat(targetPath).then(stat => stat.isFile()).catch(() => false);
    if (!isFile) {
      return { ok: false, error: 'File not found' };
    }
    const dir = path.dirname(targetPath);
    const familyBase = generatedSourceBaseName(targetName);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const deletableExts = new Set(['.txt', '.srt', '.pdf', '.html']);
    const matches = entries
      .filter(entry => entry.isFile())
      .filter(entry => deletableExts.has(path.extname(entry.name).toLowerCase()))
      .filter(entry => generatedSourceBaseName(entry.name) === familyBase)
      .map(entry => path.join(dir, entry.name));

    if (!matches.length) {
      return { ok: false, error: 'No generated files found for that source' };
    }

    for (const candidate of matches) {
      await fs.promises.rm(candidate, { force: true }).catch(() => {});
    }
    // The family always includes the source .txt, so its OCR review sidecar (if any) is
    // orphaned too — clean it up alongside the family rather than leaving it behind.
    await fs.promises.rm(path.join(dir, OCR_METADATA_SUBDIR, `${familyBase}.ocrmeta.json`), { force: true }).catch(() => {});

    return {
      ok: true,
      deletedPaths: matches,
      deletedNames: matches.map(candidate => path.basename(candidate)),
      count: matches.length
    };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('read-logs', async (_e, mode: string) => {
  try {
    return await fs.promises.readFile(getLogPath(mode), 'utf-8');
  } catch {
    return '';
  }
});

ipcMain.handle('read-log-tail', async (_e, payload: string | { mode?: string; maxBytes?: number }) => {
  const mode = typeof payload === 'string' ? payload : (payload?.mode || '');
  const maxBytes = typeof payload === 'object' ? payload?.maxBytes : undefined;
  return await readLogTail(mode, maxBytes);
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
  if (activeImageAbort) {
    activeImageAbort.abort();
    activeImageAbort = null;
  }
  cancelGeminiRequest();
  cancelAudioRequest();
  cancelMistralRequest();
});

ipcMain.handle('delete-transcript', async (_e, filePath: string) => {
  try {
    await fs.promises.unlink(filePath);
    // Only the .txt owns an OCR review sidecar; deleting a sibling .srt/.pdf/.html
    // row should leave it in place since the .txt (and its badge) still exists.
    if (path.extname(filePath).toLowerCase() === '.txt') {
      await fs.promises.rm(ocrReviewSidecarPathForTranscript(filePath), { force: true }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle(
  'run-transcription',
  async (_e,
    mode: string,
    inputPath: string,
    outputDir: string,
    promptArg: string,
    generateSubtitles: boolean,
    interviewMode: boolean,
    extraOptions: { recursive?: boolean; batch?: boolean; batchSize?: number; outputPdf?: boolean } = {}
  ) => {
    cancelRequested = false;
    // keep existing logs; trim if oversized
    try {
      const logPath = getLogPath(mode);
      const stat = await fs.promises.stat(logPath).catch(() => null);
      if (stat && stat.size > LOG_TRIM_THRESHOLD_BYTES) {
        const data = await fs.promises.readFile(logPath, 'utf-8').catch(() => '');
        const lines = data.split('\n');
        const keep = lines.slice(-LOG_TRIM_KEEP_LINES);
        await fs.promises.writeFile(logPath, keep.join('\n'), 'utf-8');
      }
    } catch {}

    const win = BrowserWindow.getAllWindows()[0];
    const modelName = mode === 'audio'
      ? normalizeSupportedModel(store.get('audioModel'), AUDIO_MODEL_OPTIONS, DEFAULT_AUDIO_MODEL)
      : normalizeSupportedModel(store.get('imageModel'), IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL);
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
      }

      const rawAudioPrompt = (promptArg || (store.get('audioPrompt') as string) || '').trim();
      if (!rawAudioPrompt && !useVoxtralAudio) {
        const msg = 'Audio prompt not set. Aborting transcription.';
        await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${msg}\n`);
        throw new Error(msg);
      }
      // Voxtral-only accuracy levers (docs.mistral.ai/studio-api/audio/speech_to_text/offline_transcription).
      const mistralContextBias = useVoxtralAudio
        ? (store.get('mistralAudioContextBias') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100)
        : undefined;
      const mistralAudioLanguage = useVoxtralAudio
        ? (store.get('mistralAudioLanguage') || '').trim() || undefined
        : undefined;
      const audioCacheDir = path.join(
        app.getPath('userData'),
        'temp',
        useVoxtralAudio ? 'mistral_cache' : 'gemini_cache',
        'audio'
      );
      await fs.promises.mkdir(audioCacheDir, { recursive: true }).catch(() => {});
      // Batch-job state (batch-jobs.json) lives in the mistral_cache root, not the
      // audio subfolder above — that's the same file the image/OCR batch path and
      // the Batch Queue UI's get-mistral-batch-queue/get-mistral-batch-stats
      // handlers read from. audioCacheDir is only for this run's temp/manifest
      // files; using it for state too would silently hide audio batch jobs from
      // the UI (which only ever reads the root file).
      const mistralBatchStateDir = path.join(app.getPath('userData'), 'temp', 'mistral_cache');
      if (useVoxtralAudio) {
        await fs.promises.appendFile(
          getLogPath('audio'),
          `[INFO] Mistral temp audio files will be cached at: ${audioCacheDir}\n`,
          'utf-8'
        ).catch(() => {});
      } else {
        await fs.promises.appendFile(
          getLogPath('audio'),
          `[INFO] Gemini temp audio files will be cached at: ${audioCacheDir}\n`,
          'utf-8'
        ).catch(() => {});
      }

      let audioFiles: string[] = [];
      try {
        const stat = await fs.promises.stat(inputPath);
        if (stat.isDirectory()) {
          const names = (await fs.promises.readdir(inputPath))
            .filter(f => /\.(mp3|mp4|wav|m4a|aac|flac|ogg|avi)$/i.test(f))
            .sort((a, b) =>
              a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
            );
          for (const f of names) {
            const full = path.join(inputPath, f);
            const fstat = await fs.promises.stat(full).catch(() => null);
            if (!fstat || !fstat.isFile() || fstat.size === 0) continue;
            audioFiles.push(full);
          }
        } else {
          audioFiles = [inputPath];
        }
      } catch {
        audioFiles = [inputPath];
      }

      // Batch audio transcription: same submit/poll/write-once-per-invocation
      // pattern as the image OCR batch branch below, reusing the same
      // MistralBatchJobRecord state file and helpers (job scoping already
      // separates audio from image via modelName, e.g. 'voxtral-mini-latest'
      // vs 'mistral-ocr-latest' — no schema change needed).
      if (useVoxtralAudio && Boolean(extraOptions?.batch)) {
        const inputStat = await fs.promises.stat(inputPath);
        if (!inputStat.isDirectory()) {
          throw new Error('Batch mode requires selecting a folder for Mistral audio transcription.');
        }
        const normalizedOutputDir = path.resolve(outputDir);
        const normalizedInputPath = path.resolve(inputPath);
        const baseIsFile = false;
        const batchSize = extraOptions?.batchSize || DEFAULT_AUDIO_BATCH_SIZE;
        const mistralBatchUploadWorkers = normalizeMistralBatchWorkerCount(
          store.get('mistralBatchUploadWorkers'),
          DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
        );
        const collectionName = path.basename(inputPath);
        const logInfo = async (msg: string) => {
          await fs.promises.appendFile(getLogPath('audio'), `[INFO] ${msg}\n`, 'utf-8').catch(() => {});
        };

        // Async (not fs.existsSync) so a large folder doesn't block the whole
        // app for the duration of the scan — each await yields to the event
        // loop between files instead of running as one uninterrupted loop.
        const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
        const hasRequiredOutput = async (filePath: string): Promise<boolean> => {
          const base = path.basename(filePath, path.extname(filePath));
          return exists(path.join(outputDir, `${base}.txt`));
        };

        const workFiles: string[] = [];
        for (const f of audioFiles) {
          if (!(await hasRequiredOutput(f))) workFiles.push(f);
        }

        if (!workFiles.length) {
          const state = await readMistralBatchState(mistralBatchStateDir);
          const nextJobs = state.jobs.filter(
            job => !matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName)
          );
          if (nextJobs.length !== state.jobs.length) {
            state.jobs = nextJobs;
            await writeMistralBatchState(mistralBatchStateDir, state);
            await logInfo('Removed cached batch-job stats for completed folder.');
          }
          return `[OK] All transcripts already exist for ${audioFiles.length} file(s)`;
        }

        let processedCount = 0;
        const totalWork = workFiles.length;
        const activeFileSet = new Set(workFiles.map(f => path.resolve(f)));
        const unresolvedFiles = new Set(workFiles.map(f => path.resolve(f)));
        const markResolved = (filePath: string) => {
          const abs = path.resolve(filePath);
          if (!unresolvedFiles.has(abs)) return;
          unresolvedFiles.delete(abs);
          processedCount = totalWork - unresolvedFiles.size;
        };
        const progressLabelFor = (jobIndex: number, totalJobs: number) => {
          const pct = totalWork > 0 ? Math.round((processedCount / totalWork) * 100) : 100;
          return `${collectionName} - batch job ${jobIndex}/${totalJobs} - audio processed ${processedCount}/${totalWork} (${pct}%)`;
        };

        let state = await readMistralBatchState(mistralBatchStateDir);
        const scopedJobs = state.jobs
          .filter(job => matchesBatchScope(job, normalizedInputPath, normalizedOutputDir, modelName))
          .sort(sortBatchJobsInOrder);
        const trackedFiles = new Set(
          scopedJobs.filter(shouldResumeBatchJob).flatMap(job => job.files.map(f => path.resolve(f)))
        );
        const filesToSubmit = workFiles.filter(f => !trackedFiles.has(path.resolve(f)));
        const newChunks = partitionFiles(filesToSubmit, batchSize);
        let nextBatchOrder = scopedJobs.reduce((m, j) => Math.max(m, j.batchOrder), 0);

        const persistJobUpdate = async (job: MistralBatchJobRecord) => {
          const idx = state.jobs.findIndex(e => e.id === job.id);
          if (idx >= 0) state.jobs[idx] = job; else state.jobs.push(job);
          await writeMistralBatchState(mistralBatchStateDir, state);
        };

        if (newChunks.length) {
          await logInfo(`Submitting ${newChunks.length} audio batch job(s) before one status check...`);
        }

        for (let idx = 0; idx < newChunks.length; idx++) {
          if (cancelRequested) {
            cancelMistralRequest();
            throw new Error('terminated by user');
          }
          const chunk = newChunks[idx].map(f => path.resolve(f));
          nextBatchOrder += 1;
          const label = progressLabelFor(idx + 1, newChunks.length);
          win?.webContents.send('transcription-progress', label, processedCount, totalWork, `Submitting batch ${idx + 1}/${newChunks.length} (${chunk.length} file(s))...`);
          try {
            const submission = await submitMistralAudioBatchJob(chunk, mistralApiKey, modelName, {
              baseInput: inputPath,
              logger: logInfo,
              cacheDir: audioCacheDir,
              tempRoot: path.join(app.getPath('userData'), 'temp'),
              uploadWorkers: mistralBatchUploadWorkers,
              interviewMode,
              subtitles: generateSubtitles,
              contextBias: mistralContextBias,
              language: mistralAudioLanguage
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
              status: submission.status || 'QUEUED',
              totalRequests: Math.max(submission.totalRequests, chunk.length),
              succeededRequests: submission.succeededRequests,
              failedRequests: submission.failedRequests,
              outputFileId: submission.outputFileId,
              lastProgressCount: submission.succeededRequests + submission.failedRequests,
              lastProgressAtMs: nowMs,
              writtenAtMs: null,
              lastError: null,
              subtitles: generateSubtitles,
              interviewMode
            };
            state.jobs.push(record);
            await writeMistralBatchState(mistralBatchStateDir, state);
            await logInfo(`Submitted audio batch job ${submission.jobId} (${chunk.length} request(s)) with status ${record.status}`);
          } catch (err: any) {
            const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError';
            await fs.promises.appendFile(getLogPath('audio'), `[ERR] batch submit ${idx + 1} - ${cancelled ? 'Cancelled' : (err?.message || err)}\n`, 'utf-8').catch(() => {});
            if (cancelled) {
              cancelMistralRequest();
              throw new Error('terminated by user');
            }
            throw err;
          }
        }

        while (true) {
          const pendingJobs = state.jobs
            .filter(e => matchesBatchScope(e, normalizedInputPath, normalizedOutputDir, modelName))
            .filter(shouldResumeBatchJob)
            .map(e => ({ ...e, files: e.files.map(f => path.resolve(f)).filter(f => activeFileSet.has(f)) }))
            .filter(e => e.files.length > 0)
            .sort(sortBatchJobsInOrder);

          if (!pendingJobs.length) {
            state.jobs = state.jobs.filter(e => !matchesBatchScope(e, normalizedInputPath, normalizedOutputDir, modelName));
            await writeMistralBatchState(mistralBatchStateDir, state);
            await logInfo('All batch jobs completed. Removed cached batch-job stats for this folder.');
            return `[OK] Finished batch queue for ${collectionName}.`;
          }

          const targetIdx = pendingJobs.findIndex(e => e.files.some(f => unresolvedFiles.has(path.resolve(f))));
          if (targetIdx < 0) {
            state.jobs = state.jobs.filter(e => !matchesBatchScope(e, normalizedInputPath, normalizedOutputDir, modelName));
            await writeMistralBatchState(mistralBatchStateDir, state);
            return `[OK] All transcripts already exist for ${audioFiles.length} file(s)`;
          }

          let job = pendingJobs[targetIdx];
          const jobPosition = targetIdx + 1;
          const totalJobs = pendingJobs.length;
          const unresolvedInJob = job.files.filter(f => unresolvedFiles.has(path.resolve(f)));

          if (cancelRequested) {
            cancelMistralRequest();
            throw new Error('terminated by user');
          }

          const polled = await fetchMistralBatchJobStatus(job.id, mistralApiKey);
          const doneRequests = polled.succeededRequests + polled.failedRequests;
          const totalRequests = Math.max(polled.totalRequests, job.totalRequests, unresolvedInJob.length, 1);
          job = {
            ...job,
            status: polled.status,
            totalRequests,
            succeededRequests: polled.succeededRequests,
            failedRequests: polled.failedRequests,
            outputFileId: polled.outputFileId
          };
          await persistJobUpdate(job);

          const label = progressLabelFor(jobPosition, totalJobs);
          const statusMessage = `Checking oldest batch ${jobPosition}/${totalJobs} - ${job.status} ${doneRequests}/${totalRequests}`;
          win?.webContents.send('transcription-progress', label, processedCount, totalWork, statusMessage);
          await logInfo(`Checked batch job ${job.id} once: status=${job.status} ${doneRequests}/${totalRequests}`);

          if (!isTerminalBatchStatus(job.status)) {
            const checkBackAt = job.createdAtMs + MISTRAL_BATCH_AVG_COMPLETION_MS;
            const msg = `Batch job ${job.id} is still ${job.status} (${doneRequests}/${totalRequests}). Check back at ${formatLocalDateTime(checkBackAt)}.`;
            win?.webContents.send('transcription-progress', label, processedCount, totalWork, msg);
            await logInfo(msg);
            return `[INFO] ${msg}`;
          }

          if (job.status !== 'SUCCESS') {
            const msg = `Batch job ${job.id} ended with status ${job.status}.`;
            await persistJobUpdate({ ...job, lastError: msg });
            await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${msg}\n`, 'utf-8').catch(() => {});
            throw new Error(msg);
          }
          if (!job.outputFileId) {
            let detail = '';
            if (polled.errorFileId) {
              try {
                const requestErrors = await downloadMistralBatchErrors(polled.errorFileId, mistralApiKey);
                const sampleErrors = requestErrors.slice(0, 3).map(e => `${e.customId ? `${e.customId}: ` : ''}${e.message}`);
                if (sampleErrors.length) {
                  const extra = Math.max(0, requestErrors.length - sampleErrors.length);
                  detail = ` ${sampleErrors.join('; ')}${extra > 0 ? ` (+${extra} more)` : ''}`;
                }
              } catch {
                if (polled.errorMessages.length) detail = ` ${polled.errorMessages.join('; ')}`;
              }
            }
            const msg = `Batch job ${job.id} completed without an output file.${detail}`.trim();
            await persistJobUpdate({ ...job, status: polled.failedRequests > 0 ? 'FAILED' : job.status, lastError: msg });
            await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${msg}\n`, 'utf-8').catch(() => {});
            throw new Error(msg);
          }

          win?.webContents.send('transcription-progress', label, processedCount, totalWork, `Downloading results for oldest batch ${jobPosition}/${totalJobs}...`);
          const batchResults = await downloadMistralAudioBatchResultsDetailed(job.outputFileId, mistralApiKey);
          await logInfo(`Downloaded ${batchResults.size} result(s) for batch job ${job.id}`);

          for (const file of unresolvedInJob) {
            if (cancelRequested) {
              cancelMistralRequest();
              throw new Error('terminated by user');
            }
            const absFile = path.resolve(file);
            if (!unresolvedFiles.has(absFile)) continue;
            const name = path.basename(file);
            const base = path.basename(file, path.extname(file));
            markResolved(file);
            const relKey = baseIsFile ? path.basename(file) : path.relative(inputPath, file).split(path.sep).join('/');
            const resultEntry = batchResults.get(relKey);
            if (!resultEntry) {
              const msg = `Missing audio transcription result for ${relKey}`;
              await fs.promises.appendFile(getLogPath('audio'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
              win?.webContents.send('transcription-progress', label, processedCount, totalWork, 'Error');
              throw new Error(msg);
            }
            await writeMistralAudioBatchResult(
              outputDir,
              base,
              resultEntry,
              job.subtitles ?? generateSubtitles,
              job.interviewMode ?? interviewMode
            );
            win?.webContents.send('transcription-progress', label, processedCount, totalWork, 'Done');
            await fs.promises.appendFile(getLogPath('audio'), `[OK] ${name}\n`, 'utf-8').catch(() => {});
          }

          await persistJobUpdate({ ...job, writtenAtMs: Date.now(), lastError: null });

          const remaining = state.jobs
            .filter(e => matchesBatchScope(e, normalizedInputPath, normalizedOutputDir, modelName))
            .filter(shouldResumeBatchJob);
          if (!remaining.length) {
            state.jobs = state.jobs.filter(e => !matchesBatchScope(e, normalizedInputPath, normalizedOutputDir, modelName));
            await writeMistralBatchState(mistralBatchStateDir, state);
            await logInfo('All batch jobs completed. Removed cached batch-job stats for this folder.');
            return `[OK] Completed batch queue for ${collectionName}.`;
          }
        }
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
          win?.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Skipped');
          continue;
        }

        win?.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Transcribing…');
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
              tempDir: audioCacheDir,
              signal: activeAudioAbort.signal,
              contextBias: mistralContextBias,
              language: mistralAudioLanguage,
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
              tempDir: audioCacheDir,
              signal: activeAudioAbort.signal,
              logger: async (msg: string) => {
                await fs.promises.appendFile(getLogPath('audio'), `${msg}\n`, 'utf-8').catch(() => {});
              }
            });
          }
          win?.webContents.send('transcription-progress', name, i + 1, audioFiles.length, 'Done');
          await fs.promises.appendFile(getLogPath('audio'), `[OK] ${name}\n`, 'utf-8');
        } catch (err: any) {
          const cancelled = cancelRequested || err?.cancelled || err?.name === 'AbortError' || err?.signal === 'SIGTERM';
          win?.webContents.send('transcription-progress', name, i + 1, audioFiles.length,
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
      const imageModel = modelName || DEFAULT_IMAGE_MODEL;
      const rawImagePrompt = ((store.get('imagePrompt') as string) || '').trim();
      const batchSelected = Boolean(extraOptions?.batch);
      const batchSize = extraOptions?.batchSize || DEFAULT_IMAGE_BATCH_SIZE;
      const outputPdfSelected = useMistral && Boolean(extraOptions?.outputPdf);
      const mistralBatchPreprocessWorkers = normalizeMistralBatchWorkerCount(
        store.get('mistralBatchPreprocessWorkers'),
        DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS
      );
      const mistralBatchUploadWorkers = normalizeMistralBatchWorkerCount(
        store.get('mistralBatchUploadWorkers'),
        DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
      );

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
        await fs.promises.appendFile(getLogPath('image'), `[INFO] Gemini temp images will be created under: ${appTempDir}\n`, 'utf-8').catch(() => {});
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
            if (!isMistralSupported(full)) continue;
            const fstat = await fs.promises.stat(full).catch(() => null);
            if (!fstat || !fstat.isFile() || fstat.size === 0) continue;
            files.push(full);
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

        // Async (not fs.existsSync) so a large folder doesn't block the whole
        // app for the duration of the scan — each await yields to the event
        // loop between files instead of running as one uninterrupted loop.
        const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);
        const hasRequiredOutputs = async (filePath: string): Promise<boolean> => {
          const txtOut = transcriptPathFor(filePath, inputPath, baseIsFile, normalizedOutputDir);
          if (!(await exists(txtOut))) return false;
          if (!outputPdfSelected) return true;
          return exists(mistralPdfPathForTranscript(txtOut));
        };

        let workFiles = [...files];
        if (batchSelected) {
          workFiles = [];
          for (const f of files) {
            if (!(await hasRequiredOutputs(f))) workFiles.push(f);
          }
        }

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
                tempRoot: path.join(app.getPath('userData'), 'temp'),
                includeImageBase64: outputPdfSelected,
                includeImageDescriptions: outputPdfSelected,
                preprocessWorkers: mistralBatchPreprocessWorkers,
                uploadWorkers: mistralBatchUploadWorkers
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
                status: submission.status || 'QUEUED',
                totalRequests: Math.max(submission.totalRequests, chunk.length),
                succeededRequests: submission.succeededRequests,
                failedRequests: submission.failedRequests,
                outputFileId: submission.outputFileId,
                lastProgressCount: submission.succeededRequests + submission.failedRequests,
                lastProgressAtMs: nowMs,
                writtenAtMs: null,
                lastError: null
              };
              state.jobs.push(record);
              await writeMistralBatchState(cacheDir, state);
              const submittedStatusLabel = record.status === 'RUNNING' ? 'Processing' : 'Queued';
              window?.webContents.send(
                'transcription-progress',
                queueLabel,
                processedCount,
                totalWork,
                `${submittedStatusLabel} batch ${idx + 1}/${newChunks.length} (job ${submission.jobId})`
              );
              await logInfo(
                `Submitted batch job ${submission.jobId} (${chunk.length} request(s)) with status ${record.status}`
              );
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
              let detail = '';
              if (polled.errorFileId) {
                try {
                  const requestErrors = await downloadMistralBatchErrors(polled.errorFileId, mistralKey);
                  const sampleErrors = requestErrors
                    .slice(0, 3)
                    .map(entry => {
                      const prefix = entry.customId ? `${entry.customId}: ` : '';
                      return `${prefix}${entry.message}`;
                    });
                  if (sampleErrors.length > 0) {
                    const extraCount = Math.max(0, requestErrors.length - sampleErrors.length);
                    detail = ` ${sampleErrors.join('; ')}${extraCount > 0 ? ` (+${extraCount} more)` : ''}`;
                  }
                } catch {
                  if (polled.errorMessages.length > 0) {
                    detail = ` ${polled.errorMessages.join('; ')}`;
                  }
                }
              } else if (polled.errorMessages.length > 0) {
                detail = ` ${polled.errorMessages.join('; ')}`;
              }
              const requestSummary = polled.failedRequests > 0
                ? ` ${polled.failedRequests}/${totalRequests} request(s) failed.`
                : '';
              const msg = `Batch job ${job.id} completed without an output file.${requestSummary}${detail}`.trim();
              job = {
                ...job,
                status: polled.failedRequests > 0 ? 'FAILED' : job.status,
                lastError: msg
              };
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
            const batchResults = await downloadMistralBatchResultsDetailed(job.outputFileId, mistralKey);
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
              const pdfOut = outputPdfSelected ? mistralPdfPathForTranscript(txtOut) : null;
              markResolved(file);
              const percentage = totalWork > 0 ? Math.round((processedCount / totalWork) * 100) : 100;
              const writeLabel = `${collectionName} - batch job ${jobPosition}/${totalJobs} - images processed ${processedCount}/${totalWork} (${percentage}%)`;

              const hasTxtOutput = fs.existsSync(txtOut);
              const hasPdfOutput = Boolean(pdfOut && fs.existsSync(pdfOut));
              const hasHtmlOutput = Boolean(pdfOut && fs.existsSync(accessibleHtmlPathForPdf(pdfOut)));

              if (hasTxtOutput && (!outputPdfSelected || hasPdfOutput)) {
                window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Skipped');
                continue;
              }
              if (outputPdfSelected && pdfOut && hasTxtOutput && !hasPdfOutput && hasHtmlOutput) {
                window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, `Rebuilding PDF from saved HTML for ${name}...`);
                try {
                  await rebuildAccessiblePdfFromExistingHtml(pdfOut);
                  window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Done');
                  await fs.promises.appendFile(getLogPath('image'), `[OK] ${name} - rebuilt PDF from HTML\n`, 'utf-8').catch(() => {});
                  continue;
                } catch (err: any) {
                  const msg = `Error rebuilding PDF from HTML: ${err?.message || err}`;
                  await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                  window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Error');
                  throw err;
                }
              }

              window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, `Writing ${name}...`);
              const relKey = baseIsFile
                ? path.basename(file)
                : path.relative(inputPath, file).split(path.sep).join('/');
              const resultEntry = batchResults.get(relKey);
              if (typeof resultEntry?.text !== 'string') {
                const msg = `Missing OCR result for ${relKey}`;
                await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                window?.webContents.send('transcription-progress', writeLabel, processedCount, totalWork, 'Error');
                throw new Error(msg);
              }
              const text = resultEntry.text;

              await fs.promises.mkdir(path.dirname(txtOut), { recursive: true }).catch(() => {});
              await fs.promises.writeFile(txtOut, text, 'utf-8');
              if (outputPdfSelected && pdfOut) {
                const pages = toAccessiblePdfPages(resultEntry.pages);
                await writeSearchablePdfFromText(text, pdfOut, `${name} OCR`, pages);
              }
              await writeOcrReviewSidecar(txtOut, file, resultEntry.pages);
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

        const imageSignalController = new AbortController();
        activeImageAbort = imageSignalController;
        const imageSignal = imageSignalController.signal;
        const pendingOcrFiles: string[] = [];
        const preprocessLimit = createConcurrencyLimiter(mistralBatchPreprocessWorkers);
        const uploadLimit = createConcurrencyLimiter(mistralBatchUploadWorkers);
        const ocrTasks: Array<Promise<void> | undefined> = new Array(workFiles.length);
        let preprocessTasks: Promise<void>[] = [];

        try {
          for (const file of workFiles) {
            if (cancelRequested || imageSignal.aborted) {
              throw createCancelledError();
            }

            const name = path.basename(file);
            const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);
            const pdfOut = outputPdfSelected ? mistralPdfPathForTranscript(txtOut) : null;
            const hasTxtOutput = fs.existsSync(txtOut);
            const hasPdfOutput = Boolean(pdfOut && fs.existsSync(pdfOut));
            const hasHtmlOutput = Boolean(pdfOut && fs.existsSync(accessibleHtmlPathForPdf(pdfOut)));

            if (hasTxtOutput && (!outputPdfSelected || hasPdfOutput)) {
              processedCount += 1;
              window?.webContents.send(
                'transcription-progress',
                formatImageProgressLabel(collectionName, processedCount, totalWork),
                processedCount,
                totalWork,
                'Skipped'
              );
              continue;
            }

            if (outputPdfSelected && pdfOut && hasTxtOutput && !hasPdfOutput && hasHtmlOutput) {
              window?.webContents.send(
                'transcription-progress',
                formatImageProgressLabel(collectionName, processedCount, totalWork),
                processedCount,
                totalWork,
                `Rebuilding PDF from saved HTML for ${name}...`
              );
              try {
                await rebuildAccessiblePdfFromExistingHtml(pdfOut);
                processedCount += 1;
                window?.webContents.send(
                  'transcription-progress',
                  formatImageProgressLabel(collectionName, processedCount, totalWork),
                  processedCount,
                  totalWork,
                  'Done'
                );
                await fs.promises.appendFile(getLogPath('image'), `[OK] ${name} - rebuilt PDF from HTML\n`, 'utf-8').catch(() => {});
                continue;
              } catch (err: any) {
                processedCount += 1;
                const msg = `Error rebuilding PDF from HTML: ${err?.message || err}`;
                await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                window?.webContents.send(
                  'transcription-progress',
                  formatImageProgressLabel(collectionName, processedCount, totalWork),
                  processedCount,
                  totalWork,
                  'Error'
                );
                throw err;
              }
            }

            pendingOcrFiles.push(file);
          }

          if (!pendingOcrFiles.length) {
            return `[OK] Processed ${workFiles.length} file(s) via Mistral OCR`;
          }

          await logInfo(
            `Processing ${pendingOcrFiles.length} non-batch file(s) with ${mistralBatchPreprocessWorkers} preprocess worker(s) and ${mistralBatchUploadWorkers} request worker(s).`
          );

          preprocessTasks = pendingOcrFiles.map((file, index) =>
            preprocessLimit(async () => {
              const name = path.basename(file);
              const txtOut = transcriptPathFor(file, inputPath, baseIsFile, normalizedOutputDir);
              const pdfOut = outputPdfSelected ? mistralPdfPathForTranscript(txtOut) : null;
              let cleanup: (() => Promise<void>) | null = null;
              let preparedPath = file;

              try {
                if (cancelRequested || imageSignal.aborted) {
                  throw createCancelledError();
                }

                const prepared = await prepareImageForMistral(file, cacheDir, normalizedInputPath, appTempDir);
                preparedPath = prepared.path;
                cleanup = prepared.cleanup;

                const ocrTask = uploadLimit(async () => {
                  try {
                    if (cancelRequested || imageSignal.aborted) {
                      throw createCancelledError();
                    }

                    window?.webContents.send(
                      'transcription-progress',
                      formatImageProgressLabel(collectionName, processedCount, totalWork),
                      processedCount,
                      totalWork,
                      `Transcribing ${name}...`
                    );

                    const detailed = await transcribePreparedImageMistralDetailed(preparedPath, mistralKey, modelName, {
                      includeImageBase64: outputPdfSelected,
                      includeImageDescriptions: outputPdfSelected,
                      signal: imageSignal,
                      logger: logInfo
                    });
                    const text = detailed.text;
                    const pages = outputPdfSelected ? toAccessiblePdfPages(detailed.pages) : [];

                    await fs.promises.mkdir(path.dirname(txtOut), { recursive: true }).catch(() => {});
                    await fs.promises.writeFile(txtOut, text, 'utf-8');
                    if (outputPdfSelected && pdfOut) {
                      await writeSearchablePdfFromText(text, pdfOut, `${name} OCR`, pages);
                    }
                    await writeOcrReviewSidecar(txtOut, file, detailed.pages);
                    await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8').catch(() => {});

                    processedCount += 1;
                    window?.webContents.send(
                      'transcription-progress',
                      formatImageProgressLabel(collectionName, processedCount, totalWork),
                      processedCount,
                      totalWork,
                      'Done'
                    );
                  } catch (err: any) {
                    processedCount += 1;
                    const cancelled = cancelRequested || isCancellationError(err, imageSignal);
                    const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
                    await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                    window?.webContents.send(
                      'transcription-progress',
                      formatImageProgressLabel(collectionName, processedCount, totalWork),
                      processedCount,
                      totalWork,
                      cancelled ? 'Cancelled' : 'Error'
                    );
                    if (cancelled) {
                      throw createCancelledError();
                    }
                    throw err;
                  } finally {
                    if (cleanup) {
                      cleanup().catch(() => {});
                    }
                  }
                });

                ocrTask.catch(() => {});
                ocrTasks[index] = ocrTask;
              } catch (err: any) {
                if (cleanup) {
                  cleanup().catch(() => {});
                }
                processedCount += 1;
                const cancelled = cancelRequested || isCancellationError(err, imageSignal);
                const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
                await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                window?.webContents.send(
                  'transcription-progress',
                  formatImageProgressLabel(collectionName, processedCount, totalWork),
                  processedCount,
                  totalWork,
                  cancelled ? 'Cancelled' : 'Error'
                );
                if (cancelled) {
                  throw createCancelledError();
                }
                throw err;
              }
            })
          );

          await Promise.all(preprocessTasks);
          const readyOcrTasks = ocrTasks.filter((task): task is Promise<void> => Boolean(task));
          await Promise.all(readyOcrTasks);
        } catch (err: any) {
          imageSignalController.abort();
          await Promise.allSettled(preprocessTasks);
          await Promise.allSettled(ocrTasks.filter((task): task is Promise<void> => Boolean(task)));
          if (cancelRequested || isCancellationError(err, imageSignal)) {
            cancelMistralRequest();
            throw new Error('terminated by user');
          }
          throw err;
        } finally {
          if (activeImageAbort === imageSignalController) {
            activeImageAbort = null;
          }
        }

        return `[OK] Processed ${workFiles.length} file(s) via Mistral OCR`;
      }

      geminiApiKey = (store.get('apiKey') || '').trim();
      if (!geminiApiKey) {
        throw new Error('Gemini API key not set. Please enter it in Settings.');
      }

      const rawPrompt = rawImagePrompt;
      const imageExtRe = /\.(png|jpe?g|jp2|tif{1,2})$/i;
      let files: string[];
      
      if (stat.isDirectory()) {
        const window = BrowserWindow.getAllWindows()[0];
        if (window) {
          window?.webContents.send('transcription-progress', 'Scanning directory...', 0, 1, 'Please wait...');
        }
        
        const allNames = (await fs.promises.readdir(inputPath)).filter(name => imageExtRe.test(name));
        const names: string[] = [];
        for (const name of allNames) {
          const fstat = await fs.promises.stat(path.join(inputPath, name)).catch(() => null);
          if (fstat && fstat.isFile() && fstat.size > 0) names.push(name);
        }
        
        if (names.length > 5000) {
          console.log(`Sorting ${names.length} files in chunks...`);
          const chunkSize = 1000;
          const sortedChunks = [];
          
          for (let i = 0; i < names.length; i += chunkSize) {
            const chunk = names.slice(i, i + chunkSize);
            chunk.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
            sortedChunks.push(chunk);
            
            if (sortedChunks.length % 10 === 0) {
              await new Promise(resolve => setImmediate(resolve));
            }
          }
          
          const sortedNames = mergeSortedArrays(sortedChunks);
          files = sortedNames.map(name => path.join(inputPath, name));
        } else {
          names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          files = names.map(name => path.join(inputPath, name));
        }
        
        if (window) {
          const collectionName = path.basename(inputPath);
          window?.webContents.send('transcription-progress', 
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

      const collectionName = stat.isDirectory() ? path.basename(inputPath) : path.basename(path.dirname(inputPath));
      const shouldThrottleProgress = files.length > 1000;
      const progressUpdateInterval = shouldThrottleProgress ? Math.max(1, Math.floor(files.length / 100)) : 1;
      const shouldEmitProgress = (processed: number, force: boolean = false): boolean => {
        if (force || !shouldThrottleProgress) return true;
        return processed === files.length || processed % progressUpdateInterval === 0;
      };

      const imageSignalController = new AbortController();
      activeImageAbort = imageSignalController;
      const imageSignal = imageSignalController.signal;
      const preprocessLimit = createConcurrencyLimiter(mistralBatchPreprocessWorkers);
      const uploadLimit = createConcurrencyLimiter(mistralBatchUploadWorkers);
      const pendingFiles: string[] = [];
      const ocrTasks: Array<Promise<void> | undefined> = new Array(files.length);
      let preprocessTasks: Promise<void>[] = [];
      let processedCount = 0;

      try {
        await fs.promises.appendFile(
          getLogPath('image'),
          `[INFO] Processing ${files.length} Gemini file(s) with ${mistralBatchPreprocessWorkers} preprocess worker(s) and ${mistralBatchUploadWorkers} request worker(s)\n`,
          'utf-8'
        ).catch(() => {});

        for (const file of files) {
          if (cancelRequested || imageSignal.aborted) {
            throw createCancelledError();
          }

          const name = path.basename(file);
          const base = path.basename(file, path.extname(file));
          const txtOut = path.join(outputDir, `${base}.txt`);

          if (fs.existsSync(txtOut)) {
            processedCount += 1;
            if (shouldEmitProgress(processedCount)) {
              win?.webContents.send(
                'transcription-progress',
                formatImageProgressLabel(collectionName, processedCount, files.length),
                processedCount,
                files.length,
                'Skipped'
              );
            }
            continue;
          }

          pendingFiles.push(file);
        }

        preprocessTasks = pendingFiles.map((file, index) =>
          preprocessLimit(async () => {
            const name = path.basename(file);
            const base = path.basename(file, path.extname(file));
            const txtOut = path.join(outputDir, `${base}.txt`);
            let cleanup: (() => Promise<void>) | null = null;
            let preparedPath = file;
            let preparedMime = 'application/octet-stream';

            try {
              if (cancelRequested || imageSignal.aborted) {
                throw createCancelledError();
              }

              const prepared = await prepareImageForGemini(file, undefined, appTempDir);
              preparedPath = prepared.path;
              preparedMime = prepared.mime;
              cleanup = prepared.cleanup;

              const ocrTask = uploadLimit(async () => {
                try {
                  if (cancelRequested || imageSignal.aborted) {
                    throw createCancelledError();
                  }

                  if (shouldEmitProgress(processedCount + 1)) {
                    win?.webContents.send(
                      'transcription-progress',
                      formatImageProgressLabel(collectionName, processedCount, files.length),
                      processedCount,
                      files.length,
                      `Transcribing ${name}...`
                    );
                  }

                  const out = await transcribePreparedImageGemini(preparedPath, preparedMime, rawPrompt, imageModel, geminiApiKey, {
                    signal: imageSignal
                  });
                  await fs.promises.writeFile(txtOut, out, 'utf-8');
                  await fs.promises.appendFile(getLogPath('image'), `[OK] ${name}\n`, 'utf-8').catch(() => {});

                  processedCount += 1;
                  if (shouldEmitProgress(processedCount)) {
                    win?.webContents.send(
                      'transcription-progress',
                      formatImageProgressLabel(collectionName, processedCount, files.length),
                      processedCount,
                      files.length,
                      'Done'
                    );
                  }
                } catch (err: any) {
                  processedCount += 1;
                  const cancelled = cancelRequested || isCancellationError(err, imageSignal);
                  const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
                  await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
                  win?.webContents.send(
                    'transcription-progress',
                    formatImageProgressLabel(collectionName, processedCount, files.length),
                    processedCount,
                    files.length,
                    cancelled ? 'Cancelled' : 'Error'
                  );
                  if (cancelled) {
                    throw createCancelledError();
                  }
                  throw err;
                } finally {
                  if (cleanup) {
                    cleanup().catch(() => {});
                  }
                }
              });

              ocrTask.catch(() => {});
              ocrTasks[index] = ocrTask;
            } catch (err: any) {
              if (cleanup) {
                cleanup().catch(() => {});
              }
              processedCount += 1;
              const cancelled = cancelRequested || isCancellationError(err, imageSignal);
              const msg = cancelled ? 'Cancelled' : `Error: ${err?.message || err}`;
              await fs.promises.appendFile(getLogPath('image'), `[ERR] ${name} - ${msg}\n`, 'utf-8').catch(() => {});
              win?.webContents.send(
                'transcription-progress',
                formatImageProgressLabel(collectionName, processedCount, files.length),
                processedCount,
                files.length,
                cancelled ? 'Cancelled' : 'Error'
              );
              if (cancelled) {
                throw createCancelledError();
              }
              throw err;
            }
          })
        );

        await Promise.all(preprocessTasks);
        await Promise.all(ocrTasks.filter((task): task is Promise<void> => Boolean(task)));
        return `[OK] Processed ${files.length} file(s) via Gemini OCR`;
      } catch (err: any) {
        imageSignalController.abort();
        await Promise.allSettled(preprocessTasks);
        await Promise.allSettled(ocrTasks.filter((task): task is Promise<void> => Boolean(task)));
        if (cancelRequested || isCancellationError(err, imageSignal)) {
          cancelGeminiRequest();
          throw new Error('terminated by user');
        }
        const last = files[0];
        win?.webContents.send('transcription-progress', path.basename(last), 1, files.length, 'Error');
        throw err;
      } finally {
        if (activeImageAbort === imageSignalController) {
          activeImageAbort = null;
        }
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
    backgroundColor: '#0e0f16',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  mainWindow = win;

  // Belt-and-suspenders alongside disableHardwareAcceleration above: if the
  // renderer still goes down (GPU hiccup, OOM, etc.) reload it in place
  // instead of leaving a permanently blank window with no way back short of
  // force-quitting the app. Crash-only ('killed'/'oom' etc.) — a clean
  // renderer exit doesn't need this.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    if (win.isDestroyed()) return;
    win.reload();
  });

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
    backgroundColor: '#0e0f16',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  if (isDev()) {
    child.loadURL(`http://localhost:5123/${ROUTE_SETTINGS}`);
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    const indexURL = pathToFileURL(indexPath).toString() + ROUTE_SETTINGS;
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
    backgroundColor: '#0e0f16',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  if (isDev()) {
    child.loadURL(`http://localhost:5123/${ROUTE_BATCH_QUEUE}`);
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist-react', 'index.html');
    const indexURL = pathToFileURL(indexPath).toString() + ROUTE_BATCH_QUEUE;
    child.loadURL(indexURL);
  }

  child.center();
});

ipcMain.handle('scan-quality', async (_e, folder: string, threshold: number) => {
  const qualityLog = getLogPath('quality');
  await fs.promises.writeFile(qualityLog, '', 'utf-8');
  const result = await scanQualityFolder(folder, threshold, {
    onProgress: async ({ processed, total, file, blankCount, entry }) => {
      const percent = total > 0 ? Math.round((processed / total) * 100) : 100;
      _e.sender.send('quality-scan-progress', {
        processed,
        total,
        percent,
        file,
        blankCount,
        entry
      });
    }
  });
  return result;
});
