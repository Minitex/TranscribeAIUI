import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import AudioTranscriber, { Transcript } from './components/AudioTranscriber';
import ImageTranscriber from './components/ImageTranscriber';
import FolderPickerModal from './components/FolderPickerModal';
import OcrReviewModal from './components/OcrReviewModal';
import AudioReviewModal from './components/AudioReviewModal';
import BatchFindReplaceModal from './components/BatchFindReplaceModal';
import InfoTooltip from './components/InfoTooltip';
import LogsPanel from './components/LogsPanel';
import SettingsGearBadge from './components/SettingsGearBadge';
import TranscriptListItem from './components/TranscriptListItem';
import SettingsView from './views/SettingsView';
import BatchQueueView from './views/BatchQueueView';
import { useIpcPersistedState } from './hooks/useIpcPersistedState';
import {
  DEFAULT_AUDIO_PROMPT,
  INTERVIEW_AUDIO_PROMPT,
  SUBTITLE_AUDIO_PROMPT
} from '../../defaultPrompts';
import { FaUndo, FaSpinner, FaSync, FaDownload, FaCopy } from 'react-icons/fa';
import './App.css';
import { ipcRenderer, fs, os, path as pathModule } from './electron';
import {
  DISPLAY_LOG_MAX_BYTES,
  LIVE_LOG_REFRESH_INTERVAL_MS,
  LIVE_TRANSCRIPT_REFRESH_INTERVAL_MS,
  LIVE_BATCH_UI_REFRESH_INTERVAL_MS,
  TOAST_DURATION_MS,
  LOG_SCROLL_DELAY_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  ROUTE_SETTINGS,
  ROUTE_BATCH_QUEUE,
  IMAGE_MODEL_OPTIONS,
  DEFAULT_IMAGE_MODEL,
  AUDIO_MODEL_OPTIONS,
  DEFAULT_AUDIO_MODEL,
  IMAGE_EXTS,
  AUDIO_EXTS
} from './lib/constants';
import { resolveSupportedModel } from './lib/models';
import { getErrorMessage, isCancellation } from './lib/errors';
import {
  normalizeLocalPath,
  resolveImageInputPathKind,
  sortTranscripts,
  transcriptListsEqual,
  resolveSourceFileForTranscript,
  ensureUniquePath,
  loadOcrReviewData,
  ocrReviewSidecarPathForTranscript,
  loadMistralQualityEntry,
  srtPathForTranscript,
  txtPathForTranscript,
  loadAudioReviewSegments
} from './lib/paths';
import { loadReviewStatus, saveReviewStatus } from './lib/reviewStatus';
import {
  toQualityEntry,
  removeWrappersFromContent,
  stripMarkdownArtifacts,
  decodeKnownHtmlEntities,
  getRemediationActions,
  hasRemediationActions,
  getIssueCodesToClear,
  isScanEntryRemediable,
  type QualityEntry,
  type ScanResultEntry,
  type SortOption
} from './lib/quality';
import type { AudioReviewData, BatchCostEstimateData, MistralBatchStats, MistralBatchQueueRow, OcrReviewData, PathPickerTarget } from './lib/types';

export default function App() {
  const isSettings = window.location.hash === ROUTE_SETTINGS;
  const isBatchQueue = window.location.hash === ROUTE_BATCH_QUEUE;
  const readStoredBoolean = (key: string, fallback: boolean = false): boolean => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'true') return true;
      if (raw === 'false') return false;
    } catch {
      /* localStorage unavailable; fall through to default */
    }
    return fallback;
  };

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const logsBodyRef = useRef<HTMLPreElement>(null);

  const [mode, setMode] = useIpcPersistedState<'audio' | 'image'>({
    getChannel: 'get-active-mode',
    setChannel: 'set-active-mode',
    storageKey: 'activeMode',
    initial: 'audio',
    parse: raw => (raw === 'audio' || raw === 'image' ? raw : undefined)
  });

  const [audioInputPath, setAudioInputPath] = useState('');
  const [audioOutputDir, setAudioOutputDir] = useState('');
  const [audioTranscripts, setAudioTranscripts] = useState<Transcript[]>([]);
  const [audioModelName, setAudioModelName] = useState<string>(() =>
    resolveSupportedModel(localStorage.getItem('audioModel'), AUDIO_MODEL_OPTIONS, DEFAULT_AUDIO_MODEL)
  );
  const [audioBatchSize, setAudioBatchSize] = useState<number>(25);
  const [audioBatchEnabled, setAudioBatchEnabled] = useIpcPersistedState<boolean>({
    getChannel: 'get-mistral-audio-batch-enabled',
    setChannel: 'set-mistral-audio-batch-enabled',
    storageKey: 'mistralAudioBatchEnabled',
    initial: readStoredBoolean('mistralAudioBatchEnabled'),
    parse: raw =>
      typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined
  });
  const [audioBatchStats, setAudioBatchStats] = useState<MistralBatchStats | null>(null);
  const [audioBatchCostEstimate, setAudioBatchCostEstimate] = useState<BatchCostEstimateData | null>(null);
  const [imageBatchCostEstimate, setImageBatchCostEstimate] = useState<BatchCostEstimateData | null>(null);

  const [imageModelName, setImageModelName] = useState<string>(() =>
    resolveSupportedModel(localStorage.getItem('imageModel'), IMAGE_MODEL_OPTIONS, DEFAULT_IMAGE_MODEL)
  );
  const [imageInputPath, setImageInputPath] = useState('');
  const [imageOutputDir, setImageOutputDir] = useState('');
  const [imageTranscripts, setImageTranscripts] = useState<Transcript[]>([]);
  const [imageBatchSize, setImageBatchSize] = useState<number>(50);
  const [imageBatchEnabled, setImageBatchEnabled] = useIpcPersistedState<boolean>({
    getChannel: 'get-mistral-batch-enabled',
    setChannel: 'set-mistral-batch-enabled',
    storageKey: 'mistralBatchEnabled',
    initial: readStoredBoolean('mistralBatchEnabled'),
    parse: raw =>
      typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : undefined
  });
  const [mistralOutputPdf, setMistralOutputPdf] = useState(false);
  const [mistralBatchStats, setMistralBatchStats] = useState<MistralBatchStats | null>(null);
  const [mistralQueueCollectionCount, setMistralQueueCollectionCount] = useState(0);

  const [threshold, setThreshold] = useState<number>(85);
  const [qualityScores, setQualityScores] = useState<Record<string, QualityEntry>>({});

  const [isScanningQuality, setIsScanningQuality] = useState(false);
  const [isRemediating, setIsRemediating] = useState(false);
  const [scanResults, setScanResults] = useState<ScanResultEntry[]>([]);

  const [filter, setFilter] = useState('');
  const [isFilterFocused, setIsFilterFocused] = useState(false);
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);
  const [showLogs, setShowLogs] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    transcript: Transcript;
  } | null>(null);
  const [pathPicker, setPathPicker] = useState<PathPickerTarget | null>(null);
  const [ocrReview, setOcrReview] = useState<{ txtPath: string; data: OcrReviewData } | null>(null);
  const [audioReview, setAudioReview] = useState<{ txtPath: string; srtPath: string; data: AudioReviewData } | null>(null);
  const [showBatchFindReplace, setShowBatchFindReplace] = useState(false);
  const [fileTypeFilter, setFileTypeFilter] = useState<'all' | 'transcript' | 'subtitle' | 'pdf'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'clean' | 'issues'>('all');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'all' | 'unreviewed' | 'reviewed'>('all');
  const [reviewedStatus, setReviewedStatus] = useState<Record<string, boolean>>({});
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [showFilters, setShowFilters] = useState(false);
  const [folderFavorites, setFolderFavorites] = useIpcPersistedState<string[]>({
    getChannel: 'get-folder-favorites',
    setChannel: 'set-folder-favorites',
    storageKey: 'folderFavorites',
    initial: [],
    serialize: JSON.stringify,
    parse: raw => {
      try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : undefined;
      } catch {
        return undefined;
      }
    }
  });
  const pathsLoadedRef = useRef(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const modeRef = useRef<'audio' | 'image'>('audio');
  const logRefreshInFlightRef = useRef(false);
  const transcriptRefreshInFlightRef = useRef<Record<'audio' | 'image', boolean>>({
    audio: false,
    image: false
  });
  const pendingTranscriptRefreshRef = useRef<Record<'audio' | 'image', boolean>>({
    audio: false,
    image: false
  });
  const lastLogRefreshAtRef = useRef(0);
  const lastTranscriptRefreshAtRef = useRef<Record<'audio' | 'image', number>>({
    audio: 0,
    image: 0
  });
  const lastBatchUiRefreshAtRef = useRef(0);
  const isMistralImageModel = useMemo(
    () => imageModelName.trim().toLowerCase().includes('mistral'),
    [imageModelName]
  );
  // Mistral OCR supplies real per-file confidence (see displayScores), so the
  // heuristic scan and its remediation actions are hidden in that mode.
  const hideHeuristicQualityTools = mode === 'image' && isMistralImageModel;
  const normalizedImageInputPath = useMemo(
    () => normalizeLocalPath(imageInputPath),
    [imageInputPath]
  );
  const [imageInputIsDirectory, setImageInputIsDirectory] = useState(false);
  useEffect(() => {
    if (!normalizedImageInputPath) {
      setImageInputIsDirectory(false);
      return;
    }
    // Debounce so we don't hit the filesystem on every keystroke while typing a path.
    const handle = setTimeout(() => {
      setImageInputIsDirectory(resolveImageInputPathKind(normalizedImageInputPath) === 'directory');
    }, 150);
    return () => clearTimeout(handle);
  }, [normalizedImageInputPath]);
  useEffect(() => {
    if (!imageInputIsDirectory || !isMistralImageModel || !imageBatchEnabled) {
      setImageBatchCostEstimate(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const estimate = await ipcRenderer.invoke('estimate-batch-cost', {
          mode: 'image',
          inputPath: imageInputPath
        }) as BatchCostEstimateData | null;
        if (!cancelled) setImageBatchCostEstimate(estimate);
      } catch {
        if (!cancelled) setImageBatchCostEstimate(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [imageInputPath, imageInputIsDirectory, isMistralImageModel, imageBatchEnabled]);

  const effectiveImageBatchEnabled = isMistralImageModel && imageInputIsDirectory && imageBatchEnabled;
  const mistralBatchStatsRequestIdRef = useRef(0);
  const refreshMistralBatchStats = useCallback(async () => {
    if (!imageInputPath || !imageInputIsDirectory || !isMistralImageModel) {
      setMistralBatchStats(null);
      return;
    }
    const requestId = ++mistralBatchStatsRequestIdRef.current;
    try {
      const stats = await ipcRenderer.invoke('get-mistral-batch-stats', {
        inputPath: imageInputPath,
        outputDir: imageOutputDir || undefined,
        modelName: imageModelName
      }) as MistralBatchStats;
      if (mistralBatchStatsRequestIdRef.current === requestId) setMistralBatchStats(stats);
    } catch {
      if (mistralBatchStatsRequestIdRef.current === requestId) setMistralBatchStats(null);
    }
  }, [imageInputPath, imageInputIsDirectory, imageOutputDir, imageModelName, isMistralImageModel]);
  const isMistralAudioModel = useMemo(
    () => audioModelName.trim().toLowerCase().includes('voxtral'),
    [audioModelName]
  );
  const normalizedAudioInputPath = useMemo(
    () => normalizeLocalPath(audioInputPath),
    [audioInputPath]
  );
  const [audioInputIsDirectory, setAudioInputIsDirectory] = useState(false);
  useEffect(() => {
    if (!normalizedAudioInputPath) {
      setAudioInputIsDirectory(false);
      return;
    }
    const handle = setTimeout(() => {
      setAudioInputIsDirectory(resolveImageInputPathKind(normalizedAudioInputPath) === 'directory');
    }, 150);
    return () => clearTimeout(handle);
  }, [normalizedAudioInputPath]);
  const effectiveAudioBatchEnabled = isMistralAudioModel && audioInputIsDirectory && audioBatchEnabled;
  useEffect(() => {
    if (!audioInputIsDirectory || !isMistralAudioModel || !audioBatchEnabled) {
      setAudioBatchCostEstimate(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const estimate = await ipcRenderer.invoke('estimate-batch-cost', {
          mode: 'audio',
          inputPath: audioInputPath
        }) as BatchCostEstimateData | null;
        if (!cancelled) setAudioBatchCostEstimate(estimate);
      } catch {
        if (!cancelled) setAudioBatchCostEstimate(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [audioInputPath, audioInputIsDirectory, isMistralAudioModel, audioBatchEnabled]);
  const audioBatchStatsRequestIdRef = useRef(0);
  const refreshAudioBatchStats = useCallback(async () => {
    if (!audioInputPath || !audioInputIsDirectory || !isMistralAudioModel) {
      setAudioBatchStats(null);
      return;
    }
    const requestId = ++audioBatchStatsRequestIdRef.current;
    try {
      const stats = await ipcRenderer.invoke('get-mistral-batch-stats', {
        inputPath: audioInputPath,
        outputDir: audioOutputDir || undefined,
        modelName: audioModelName
      }) as MistralBatchStats;
      if (audioBatchStatsRequestIdRef.current === requestId) setAudioBatchStats(stats);
    } catch {
      if (audioBatchStatsRequestIdRef.current === requestId) setAudioBatchStats(null);
    }
  }, [audioInputPath, audioInputIsDirectory, audioOutputDir, audioModelName, isMistralAudioModel]);
  const refreshMistralQueueCollectionCount = useCallback(async () => {
    try {
      const rows = await ipcRenderer.invoke('get-mistral-batch-queue') as MistralBatchQueueRow[];
      setMistralQueueCollectionCount(Array.isArray(rows) ? rows.length : 0);
    } catch {
      setMistralQueueCollectionCount(0);
    }
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const refreshVisibleLogs = useCallback(async (targetMode: 'audio' | 'image', force: boolean = false) => {
    const now = Date.now();
    if (!force && now - lastLogRefreshAtRef.current < LIVE_LOG_REFRESH_INTERVAL_MS) {
      return;
    }
    if (logRefreshInFlightRef.current) {
      return;
    }
    logRefreshInFlightRef.current = true;
    try {
      const nextLogs = await ipcRenderer.invoke('read-log-tail', {
        mode: targetMode,
        maxBytes: DISPLAY_LOG_MAX_BYTES
      });
      if (modeRef.current === targetMode && typeof nextLogs === 'string') {
        setLogs(nextLogs);
      }
      lastLogRefreshAtRef.current = Date.now();
    } catch (error) {
      console.error('Failed to refresh logs:', error);
    } finally {
      logRefreshInFlightRef.current = false;
    }
  }, []);

  const latestOutputDirRef = useRef({ audio: audioOutputDir, image: imageOutputDir });
  latestOutputDirRef.current = { audio: audioOutputDir, image: imageOutputDir };

  const refreshTranscriptListForMode = useCallback(async (targetMode: 'audio' | 'image', force: boolean = false) => {
    const now = Date.now();
    if (!force && now - lastTranscriptRefreshAtRef.current[targetMode] < LIVE_TRANSCRIPT_REFRESH_INTERVAL_MS) {
      return;
    }

    const dir = targetMode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) {
      return;
    }

    if (transcriptRefreshInFlightRef.current[targetMode]) {
      pendingTranscriptRefreshRef.current[targetMode] = true;
      return;
    }

    transcriptRefreshInFlightRef.current[targetMode] = true;
    try {
      const list = await ipcRenderer.invoke('list-transcripts-subtitles', dir) as Transcript[];
      const sorted = sortTranscripts(list);
      const activeDir = latestOutputDirRef.current[targetMode];

      if (activeDir === dir) {
        // Skip the update entirely when nothing actually changed, so an idle
        // background poll doesn't hand every row a new object identity and
        // blow past React.memo on the whole sidebar list every few seconds.
        if (targetMode === 'audio') {
          setAudioTranscripts(prev => (transcriptListsEqual(prev, sorted) ? prev : sorted));
        } else {
          setImageTranscripts(prev => (transcriptListsEqual(prev, sorted) ? prev : sorted));
        }
        lastTranscriptRefreshAtRef.current[targetMode] = Date.now();
      }
    } catch (error) {
      console.error('Failed to refresh transcript list:', error);
    } finally {
      transcriptRefreshInFlightRef.current[targetMode] = false;
      if (pendingTranscriptRefreshRef.current[targetMode]) {
        pendingTranscriptRefreshRef.current[targetMode] = false;
        void refreshTranscriptListForMode(targetMode, true);
      }
    }
  }, [audioOutputDir, imageOutputDir]);

  const refreshLiveImageBatchUi = useCallback((force: boolean = false) => {
    const now = Date.now();
    if (!force && now - lastBatchUiRefreshAtRef.current < LIVE_BATCH_UI_REFRESH_INTERVAL_MS) {
      return;
    }
    lastBatchUiRefreshAtRef.current = now;
    void refreshMistralBatchStats();
    void refreshAudioBatchStats();
    void refreshMistralQueueCollectionCount();
  }, [refreshMistralBatchStats, refreshAudioBatchStats, refreshMistralQueueCollectionCount]);

  const fetchCurrentVersion = useCallback(() => {
    ipcRenderer
      .invoke('get-app-version')
      .then((v: string) => setCurrentVersion((v || '').trim().replace(/^v/i, '')))
      .catch(() => setCurrentVersion(''));
  }, []);

  const fetchLatestVersion = useCallback(async () => {
    setCheckingUpdate(true);
    setUpdateError('');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.github.com/repos/Minitex/TranscribeAIUI/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Update check failed (${res.status})`);
      const data = await res.json();
      const tag = (data?.tag_name || '').trim().replace(/^v/i, '');
      setLatestVersion(tag);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setUpdateError('Update check timed out. Check your connection and try again.');
      } else {
        setUpdateError(`Could not check for updates: ${getErrorMessage(err)}`);
      }
    } finally {
      clearTimeout(timeout);
      setCheckingUpdate(false);
    }
  }, []);

  const openUpdatePage = useCallback(() => {
    ipcRenderer.invoke('open-external', 'https://github.com/Minitex/TranscribeAIUI/releases/latest');
  }, []);

  const openUpdateInstructions = useCallback(() => {
    ipcRenderer.invoke(
      'open-external',
      'https://github.com/Minitex/TranscribeAIUI#updating-to-a-new-version'
    );
  }, []);

  useEffect(() => {
    fetchCurrentVersion();
    fetchLatestVersion();
  }, [fetchCurrentVersion, fetchLatestVersion]);

  useEffect(() => {
    if (!currentVersion || !latestVersion) {
      setNewVersionAvailable(false);
      return;
    }
    setNewVersionAvailable(latestVersion !== currentVersion);
  }, [currentVersion, latestVersion]);

  useEffect(() => {
    refreshMistralBatchStats();
  }, [refreshMistralBatchStats]);

  useEffect(() => {
    refreshAudioBatchStats();
  }, [refreshAudioBatchStats]);

  useEffect(() => {
    refreshMistralQueueCollectionCount();
    window.addEventListener('focus', refreshMistralQueueCollectionCount);
    return () => window.removeEventListener('focus', refreshMistralQueueCollectionCount);
  }, [refreshMistralQueueCollectionCount]);

  // Batch-enabled load + persistence handled by useIpcPersistedState above.

  // Active-mode load + persistence handled by useIpcPersistedState above.

  useEffect(() => {
    let cancelled = false;
    const readLocal = (key: string) => {
      try {
        return localStorage.getItem(key) || '';
      } catch {
        return '';
      }
    };
    const resolveValue = (value: unknown, key: string) => {
      if (typeof value === 'string' && value) return value;
      return readLocal(key);
    };
    const loadPaths = async () => {
      let hydrated = false;
      try {
        const [audioInput, audioOutput, imageInput, imageOutput] = await Promise.all([
          ipcRenderer.invoke('get-audio-input-path'),
          ipcRenderer.invoke('get-audio-output-dir'),
          ipcRenderer.invoke('get-image-input-path'),
          ipcRenderer.invoke('get-image-output-dir')
        ]);
        if (!cancelled) {
          setAudioInputPath(normalizeLocalPath(resolveValue(audioInput, 'audioInputPath')));
          setAudioOutputDir(normalizeLocalPath(resolveValue(audioOutput, 'audioOutputDir')));
          setImageInputPath(normalizeLocalPath(resolveValue(imageInput, 'imageInputPath')));
          setImageOutputDir(normalizeLocalPath(resolveValue(imageOutput, 'imageOutputDir')));
          hydrated = true;
        }
      } catch {
        /* ipc unavailable; fall back to localStorage below */
      } finally {
        if (!cancelled) {
          if (!hydrated) {
            setAudioInputPath(normalizeLocalPath(readLocal('audioInputPath')));
            setAudioOutputDir(normalizeLocalPath(readLocal('audioOutputDir')));
            setImageInputPath(normalizeLocalPath(readLocal('imageInputPath')));
            setImageOutputDir(normalizeLocalPath(readLocal('imageOutputDir')));
          }
          pathsLoadedRef.current = true;
        }
      }
    };
    loadPaths();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pathsLoadedRef.current) return;
    const persist = async () => {
      const writes: Array<[string, string]> = [
        ['set-audio-input-path', audioInputPath],
        ['set-audio-output-dir', audioOutputDir],
        ['set-image-input-path', imageInputPath],
        ['set-image-output-dir', imageOutputDir]
      ];
      for (const [channel, value] of writes) {
        try {
          await ipcRenderer.invoke(channel, value);
        } catch (e) {
          console.error(`Failed to persist ${channel} via IPC`, e);
        }
      }
      try {
        localStorage.setItem('audioInputPath', audioInputPath);
        localStorage.setItem('audioOutputDir', audioOutputDir);
        localStorage.setItem('imageInputPath', imageInputPath);
        localStorage.setItem('imageOutputDir', imageOutputDir);
      } catch (e) {
        console.error('Failed to persist paths to localStorage', e);
      }
    };
    persist();
  }, [audioInputPath, audioOutputDir, imageInputPath, imageOutputDir]);

  // Folder-favorites load + persistence handled by useIpcPersistedState above.

  useEffect(() => {
    const loadImageModel = () => {
      ipcRenderer
        .invoke('get-image-model')
        .then((model: string) => {
          const next = resolveSupportedModel(
            model || localStorage.getItem('imageModel'),
            IMAGE_MODEL_OPTIONS,
            DEFAULT_IMAGE_MODEL
          );
          setImageModelName(next);
        })
        .catch(() => {
          const fallback = resolveSupportedModel(
            localStorage.getItem('imageModel'),
            IMAGE_MODEL_OPTIONS,
            DEFAULT_IMAGE_MODEL
          );
          setImageModelName(fallback);
        });
    };

    loadImageModel();
    window.addEventListener('focus', loadImageModel);
    return () => window.removeEventListener('focus', loadImageModel);
  }, []);

  useEffect(() => {
    const loadAudioModel = () => {
      ipcRenderer
        .invoke('get-audio-model')
        .then((model: string) => {
          setAudioModelName(resolveSupportedModel(
            model || localStorage.getItem('audioModel'),
            AUDIO_MODEL_OPTIONS,
            DEFAULT_AUDIO_MODEL
          ));
        })
        .catch(() => {
          setAudioModelName(resolveSupportedModel(
            localStorage.getItem('audioModel'),
            AUDIO_MODEL_OPTIONS,
            DEFAULT_AUDIO_MODEL
          ));
        });
    };

    loadAudioModel();
    window.addEventListener('focus', loadAudioModel);
    return () => window.removeEventListener('focus', loadAudioModel);
  }, []);

  useEffect(() => {
    void refreshVisibleLogs(mode, true);
  }, [mode, refreshVisibleLogs]);

  useEffect(() => {
    if (!isTranscribing) return;

    const refreshInterval = window.setInterval(() => {
      void refreshVisibleLogs(mode);
      void refreshTranscriptListForMode(mode);
      if (mode === 'image') {
        refreshLiveImageBatchUi();
      }
    }, 4000);

    return () => window.clearInterval(refreshInterval);
  }, [isTranscribing, mode, refreshLiveImageBatchUi, refreshTranscriptListForMode, refreshVisibleLogs]);

  useEffect(() => {
    if (!isTranscribing || !logs) return;

    const scrollToBottom = () => {
      const el = logsBodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };

    const timer = window.setTimeout(scrollToBottom, LOG_SCROLL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [logs, isTranscribing]);

  const getInitialPathForPicker = useCallback(
    (target: PathPickerTarget['target']) => {
      switch (target) {
        case 'audio-input':
          return audioInputPath || audioOutputDir || os.homedir();
        case 'audio-output':
          return audioOutputDir || audioInputPath || os.homedir();
        case 'image-input':
          return imageInputPath || imageOutputDir || os.homedir();
        case 'image-output':
          return imageOutputDir || imageInputPath || os.homedir();
        case 'copy-images':
          return imageOutputDir || imageInputPath || os.homedir();
        default:
          return os.homedir();
      }
    },
    [audioInputPath, audioOutputDir, imageInputPath, imageOutputDir]
  );

  const normalizeFavoritePath = useCallback((value: string) => {
    if (!value) return '';
    try {
      return pathModule.resolve(value);
    } catch {
      return value;
    }
  }, []);

  const addFavoritePath = useCallback(
    (value: string) => {
      const normalized = normalizeFavoritePath(value);
      if (!normalized) return;
      try {
        const stat = fs.statSync(normalized);
        if (!stat.isDirectory()) return;
      } catch {
        return;
      }
      setFolderFavorites(prev =>
        prev.includes(normalized) ? prev : [...prev, normalized]
      );
    },
    [normalizeFavoritePath]
  );

  const removeFavoritePath = useCallback(
    (value: string) => {
      const normalized = normalizeFavoritePath(value);
      setFolderFavorites(prev => prev.filter(item => item !== normalized));
    },
    [normalizeFavoritePath]
  );

  const clearAudioInputPath = useCallback(() => {
    setAudioInputPath('');
  }, []);

  const clearAudioOutputDir = useCallback(() => {
    setAudioOutputDir('');
    setAudioTranscripts([]);
  }, []);

  const clearImageInputPath = useCallback(() => {
    setImageInputPath('');
    setMistralBatchStats(null);
  }, []);

  const clearImageOutputDir = useCallback(() => {
    setImageOutputDir('');
    setImageTranscripts([]);
  }, []);

  useEffect(() => {
    const handler = (_event: Electron.IpcRendererEvent, file: string, _idx: number, _total: number, msg: string) => {
      const label = (file || '').trim();
      const detail = (msg || '').trim();
      setStatus(label && detail ? `${label} | ${detail}` : (label || detail));
      if (mode === 'image') {
        refreshLiveImageBatchUi();
      }
      void refreshVisibleLogs(mode);
      if (detail === 'Done' || detail === 'Skipped' || detail === 'Error') {
        void refreshTranscriptListForMode(mode);
      }
    };
    ipcRenderer.on('transcription-progress', handler);
    return () => {
      ipcRenderer.removeListener('transcription-progress', handler);
    };
  }, [mode, refreshLiveImageBatchUi, refreshTranscriptListForMode, refreshVisibleLogs]);

  useEffect(() => {
    const handler = async (
      _event: Electron.IpcRendererEvent,
      nextInputPath: string,
      nextOutputDir: string,
      folderMode: 'audio' | 'image' = 'image'
    ) => {
      const setInputPath = folderMode === 'audio' ? setAudioInputPath : setImageInputPath;
      const setOutputDir = folderMode === 'audio' ? setAudioOutputDir : setImageOutputDir;
      const setTranscripts = folderMode === 'audio' ? setAudioTranscripts : setImageTranscripts;
      if (typeof nextInputPath === 'string') {
        setInputPath(normalizeLocalPath(nextInputPath));
      }
      if (typeof nextOutputDir === 'string') {
        setOutputDir(normalizeLocalPath(nextOutputDir));
        try {
          const list = await ipcRenderer.invoke(
            'list-transcripts-subtitles',
            normalizeLocalPath(nextOutputDir)
          ) as Transcript[];
          setTranscripts(sortTranscripts(list));
        } catch {
          setTranscripts([]);
        }
      }
      setMode(folderMode);
      setStatus(`Loaded queue folder ${pathModule.basename(nextInputPath || '')}`);
      refreshMistralQueueCollectionCount();
    };
    ipcRenderer.on('mistral-batch-folder-selected', handler);
    return () => {
      ipcRenderer.removeListener('mistral-batch-folder-selected', handler);
    };
  }, [refreshMistralQueueCollectionCount]);

  const refreshTranscriptList = useCallback(async () => {
    await refreshTranscriptListForMode(mode, true);
  }, [mode, refreshTranscriptListForMode]);

  useEffect(() => {
    if (isSettings || isBatchQueue) return;
    void refreshTranscriptList();
  }, [isSettings, isBatchQueue, refreshTranscriptList]);

  const cleanupWrappers = useCallback(
    async (entries: ScanResultEntry[], dir: string): Promise<string[]> => {
      let transcripts = mode === 'audio' ? audioTranscripts : imageTranscripts;
      if (!transcripts.length) {
        try {
          const fetched: Transcript[] = await ipcRenderer.invoke(
            'list-transcripts-subtitles',
            dir
          );
          const sorted = sortTranscripts(fetched);
          transcripts = sorted;
          if (mode === 'audio') {
            setAudioTranscripts(sorted);
          } else {
            setImageTranscripts(sorted);
          }
        } catch (error) {
          console.error('Failed to load transcripts for cleanup', error);
          return [];
        }
      }
      const lookup = new Map(transcripts.map(t => [t.name, t.path]));

      const cleanedFiles: Array<{
        name: string;
        path: string;
        intro?: string;
        outro?: string;
        markdownArtifacts?: string[];
        decodedEntityCounts?: Record<string, number>;
        decodedEntityTotal?: number;
      }> = [];
      // Capped concurrency — "Remediate all" on a large batch (hundreds of
      // flagged files) would otherwise fire that many concurrent file
      // reads/writes at once and stall the app, especially on slower disks.
      const CLEANUP_CONCURRENCY = 6;
      for (let i = 0; i < entries.length; i += CLEANUP_CONCURRENCY) {
        const chunk = entries.slice(i, i + CLEANUP_CONCURRENCY);
        await Promise.all(
          chunk.map(async entry => {
            const intro = entry.remove_intro_text;
            const outro = entry.remove_outro_text;
            const hasMarkdown = Boolean(entry.markdown_artifacts && entry.markdown_artifacts.length);
            const hasEncodedEntities = Number(entry.html_entity_count ?? entry.html_amp_count ?? 0) > 0;
            if (!intro && !outro && !hasMarkdown && !hasEncodedEntities) return;
            const filePath = lookup.get(entry.file);
            if (!filePath) return;

            try {
              const original = await fs.promises.readFile(filePath, 'utf-8');
              let cleaned = removeWrappersFromContent(original, intro, outro);
              if (hasMarkdown) {
                cleaned = stripMarkdownArtifacts(cleaned);
              }
              let decodedEntityTotal = 0;
              let decodedEntityCounts: Record<string, number> | undefined;
              if (hasEncodedEntities) {
                const decoded = decodeKnownHtmlEntities(cleaned);
                cleaned = decoded.decoded;
                decodedEntityTotal = decoded.total;
                decodedEntityCounts = decoded.total > 0 ? decoded.counts : undefined;
              }
              if (cleaned === original) return;
              await fs.promises.writeFile(filePath, cleaned, 'utf-8');
              cleanedFiles.push({
                name: entry.file,
                path: filePath,
                intro: intro?.trim(),
                outro: outro?.trim(),
                markdownArtifacts: hasMarkdown ? entry.markdown_artifacts : undefined,
                decodedEntityTotal: decodedEntityTotal || undefined,
                decodedEntityCounts
              });
            } catch (error) {
              console.error('Failed to strip wrappers from', filePath, error);
            }
          })
        );
      }

      if (cleanedFiles.length) {
        const logLines = cleanedFiles
          .map(({ path, intro, outro, markdownArtifacts, decodedEntityCounts, decodedEntityTotal }) => {
            const parts: string[] = [];
            if (intro) {
              const snippet = intro.replace(/\s+/g, ' ');
              parts.push(`[OUT] [OK] Removed intro chatter: ${snippet}`);
            }
            if (outro) {
              const snippet = outro.replace(/\s+/g, ' ');
              parts.push(`[OUT] [OK] Removed outro chatter: ${snippet}`);
            }
            if (markdownArtifacts && markdownArtifacts.length) {
              const kinds = markdownArtifacts.join(', ');
              parts.push(`[OUT] [OK] Stripped markdown artifacts (${kinds}).`);
            }
            if (decodedEntityTotal && decodedEntityCounts) {
              const details = Object.entries(decodedEntityCounts)
                .map(([entity, count]) => `${entity} x${count}`)
                .join(', ');
              parts.push(`[OUT] [OK] Decoded ${decodedEntityTotal} HTML entity token(s): ${details}.`);
            }
            if (!parts.length) {
              parts.push('[OUT] [OK] Updated transcript content.');
            }
            return parts.join('\n') + `\n[OUT] [OK] Cleaned file: ${path}`;
          })
          .concat(
            `[OUT] [OK] Remediation cleaned ${cleanedFiles.length} file(s).`
          )
          .join('\n');
        try {
          await ipcRenderer.invoke('append-log', {
            mode,
            message: logLines
          });
          await refreshVisibleLogs(mode, true);
        } catch (error) {
          console.error(`Failed to write ${mode} log entry`, error);
        }

        const message =
          cleanedFiles.length === 1
            ? `Remediated ${cleanedFiles[0].name}`
            : `Remediated ${cleanedFiles.length} files`;
        showToast(message);
      }
      return cleanedFiles.map(file => file.name);
    },
    [mode, audioTranscripts, imageTranscripts]
  );

  const scanQuality = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    setIsScanningQuality(true);
    setStatus('ℹ️ Checking quality...');
    // Reset so this scan starts from a clean slate: entries stream in below via
    // progressHandler instead of arriving as one big array at the very end.
    setScanResults([]);
    setQualityScores({});
    const progressHandler = (
      _event: Electron.IpcRendererEvent,
      payload: {
        processed?: number;
        total?: number;
        percent?: number;
        file?: string;
        blankCount?: number;
        entry?: ScanResultEntry;
      }
    ) => {
      const processed = Math.max(0, Number(payload?.processed || 0));
      const total = Math.max(0, Number(payload?.total || 0));
      const percent = Math.max(0, Math.min(100, Number(payload?.percent ?? (total > 0 ? Math.round((processed / total) * 100) : 100))));
      const fileLabel = typeof payload?.file === 'string' && payload.file ? pathModule.basename(payload.file) : '';
      const blankCount = Math.max(0, Number(payload?.blankCount || 0));
      const blankPart = blankCount > 0 ? ` • blank ${blankCount}` : '';
      const filePart = fileLabel ? ` • ${fileLabel}` : '';
      setStatus(`ℹ️ Checking quality ${processed}/${total} (${percent}%)${blankPart}${filePart}`);
      // Stream each computed entry into state as it arrives so large folders (hundreds-1000+
      // files) render progressively instead of waiting for the final IPC round-trip.
      const entry = payload?.entry;
      if (entry) {
        setScanResults(prev => [...prev, entry]);
        setQualityScores(prev => ({ ...prev, [entry.file]: toQualityEntry(entry) }));
      }
    };
    ipcRenderer.on('quality-scan-progress', progressHandler);
    try {
      const result: { all: ScanResultEntry[] } = await ipcRenderer.invoke(
        'scan-quality',
        dir,
        threshold
      );
      const entries = result?.all ?? [];
      // Authoritative reconcile: replace the streamed-in state with the final result so the
      // outcome is identical to a single non-streamed response, regardless of any streaming
      // edge cases (dropped/out-of-order progress events, etc).
      setScanResults(entries);
      const map = entries.reduce<Record<string, QualityEntry>>((acc, entry) => {
        acc[entry.file] = toQualityEntry(entry);
        return acc;
      }, {});
      setQualityScores(map);
      const blankCount = entries.filter(entry => Boolean(entry.blank_transcript)).length;
      const flaggedCount = entries.filter(entry => Array.isArray(entry.issues) && entry.issues.length > 0).length;
      const summaryParts = [`Quality check complete (${entries.length} file${entries.length === 1 ? '' : 's'})`];
      if (blankCount > 0) summaryParts.push(`${blankCount} blank`);
      if (flaggedCount > 0) summaryParts.push(`${flaggedCount} flagged`);
      setStatus(`✅ ${summaryParts.join(' • ')}`);
    } catch (err) {
      console.error(err);
      setScanResults([]);
      const message = err instanceof Error ? err.message : 'Failed to scan quality';
      setStatus(`❌ ${message}`);
    } finally {
      ipcRenderer.removeListener('quality-scan-progress', progressHandler);
      setIsScanningQuality(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, threshold]);

  const applyRemediationState = useCallback((actionable: ScanResultEntry[]) => {
    const remediationMap = new Map(
      actionable
        .map(entry => [entry.file, getRemediationActions(entry)] as const)
        .filter(([, actions]) => hasRemediationActions(actions))
    );
    if (!remediationMap.size) return;

    setScanResults(prev =>
      prev.map(entry => {
        const actions = remediationMap.get(entry.file);
        if (!actions) return entry;
        const next: ScanResultEntry = { ...entry };
        if (actions.clearIntro) {
          next.remove_intro_text = undefined;
        }
        if (actions.clearOutro) {
          next.remove_outro_text = undefined;
        }
        if (actions.clearMarkdown) {
          next.markdown_artifacts = [];
        }
        if (actions.clearEntities) {
          next.html_entity_count = 0;
          next.html_entity_counts = {};
          next.html_amp_count = 0;
        }
        const codesToClear = getIssueCodesToClear(actions);
        if (entry.issue_details && entry.issue_details.length) {
          const remainingDetails = entry.issue_details.filter(detail => !codesToClear.has(detail.code));
          next.issue_details = remainingDetails.length ? remainingDetails : undefined;
          next.issues = remainingDetails.length
            ? remainingDetails.map(detail => detail.message)
            : undefined;
        }
        return next;
      })
    );
    setQualityScores(prev => {
      const next = { ...prev };
      remediationMap.forEach((actions, file) => {
        const entry = next[file];
        if (!entry) return;
        const updated: QualityEntry = { ...entry };
        if (actions.clearIntro) {
          updated.removeIntroText = undefined;
        }
        if (actions.clearOutro) {
          updated.removeOutroText = undefined;
        }
        if (actions.clearMarkdown) {
          updated.markdownArtifacts = [];
        }
        if (actions.clearEntities) {
          updated.htmlEntityCount = 0;
          updated.htmlEntityCounts = {};
          updated.htmlAmpCount = 0;
        }
        const codesToClear = getIssueCodesToClear(actions);
        if (entry.issueDetails && entry.issueDetails.length) {
          const remainingDetails = entry.issueDetails.filter(detail => !codesToClear.has(detail.code));
          updated.issueDetails = remainingDetails.length ? remainingDetails : undefined;
          updated.issues = remainingDetails.length
            ? remainingDetails.map(detail => detail.message)
            : undefined;
        }
        next[file] = updated;
      });
      return next;
    });
  }, []);

  const remediateDocuments = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    const actionable = scanResults.filter(isScanEntryRemediable);
    if (!actionable.length) return;
    setIsRemediating(true);
    try {
      const changedFiles = new Set(await cleanupWrappers(actionable, dir));
      if (!changedFiles.size) return;
      applyRemediationState(actionable.filter(entry => changedFiles.has(entry.file)));
    } catch (err) {
      console.error(err);
    } finally {
      setIsRemediating(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, scanResults, cleanupWrappers, applyRemediationState]);

  const remediateSingleDocument = useCallback(
    async (name: string) => {
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (!dir) return;
      const entry = scanResults.find(item => item.file === name);
      if (!entry || !isScanEntryRemediable(entry)) {
        showToast(`No remediation available for ${name}`);
        return;
      }

      setIsRemediating(true);
      try {
        const changedFiles = await cleanupWrappers([entry], dir);
        if (!changedFiles.includes(entry.file)) return;
        applyRemediationState([entry]);
      } catch (err) {
        console.error(err);
      } finally {
        setIsRemediating(false);
      }
    },
    [mode, audioOutputDir, imageOutputDir, scanResults, cleanupWrappers, applyRemediationState]
  );

  useEffect(() => {
    setQualityScores({});
    setScanResults([]);
  }, [mode, audioOutputDir, imageOutputDir]);

  useEffect(() => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    setReviewedStatus(dir ? loadReviewStatus(dir) : {});
  }, [mode, audioOutputDir, imageOutputDir]);

  useEffect(() => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    saveReviewStatus(dir, reviewedStatus);
  }, [reviewedStatus, mode, audioOutputDir, imageOutputDir]);

  const toggleReviewed = useCallback(
    (name: string) => {
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (!dir) return;
      setReviewedStatus(prev => ({ ...prev, [name]: !prev[name] }));
    },
    [mode, audioOutputDir, imageOutputDir]
  );

  // Stable across unrelated App re-renders (e.g. the 4s background-batch
  // poll) so OcrReviewModal's React.memo can actually skip re-rendering its
  // full word tree while a batch runs behind an open review.
  const closeOcrReview = useCallback(() => setOcrReview(null), []);
  const toggleOcrReviewReviewed = useCallback(() => {
    if (ocrReview) toggleReviewed(pathModule.basename(ocrReview.txtPath));
  }, [ocrReview, toggleReviewed]);
  const closeAudioReview = useCallback(() => setAudioReview(null), []);
  const toggleAudioReviewReviewed = useCallback(() => {
    if (audioReview) toggleReviewed(pathModule.basename(audioReview.txtPath));
  }, [audioReview, toggleReviewed]);

  useEffect(() => {
    const relevantList = mode === 'audio' ? audioTranscripts : imageTranscripts;
    const validNames = new Set(relevantList.map(item => item.name));
    setQualityScores(prev => {
      let changed = false;
      const next = { ...prev };
      Object.keys(next).forEach(name => {
        if (!validNames.has(name)) {
          changed = true;
          delete next[name];
        }
      });
      return changed ? next : prev;
    });
    setScanResults(prev => {
      const filtered = prev.filter(entry => validNames.has(entry.file));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [audioTranscripts, imageTranscripts, mode]);

  const clearTranscriptWarnings = useCallback((name: string) => {
    setQualityScores(prev => {
      const entry = prev[name];
      if (!entry || !entry.issues || !entry.issues.length) return prev;
      return { ...prev, [name]: { ...entry, issueDetails: undefined, issues: undefined } };
    });
    setScanResults(prev =>
      prev.map(entry => (entry.file === name ? { ...entry, issue_details: undefined, issues: undefined } : entry))
    );
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const onTranscriptContextMenu = useCallback(
    (event: React.MouseEvent, transcript: Transcript) => {
      event.preventDefault();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        transcript
      });
    },
    []
  );

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('scroll', handleClick, true);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('scroll', handleClick, true);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const canRemediate = useMemo(
    () =>
      scanResults.some(isScanEntryRemediable),
    [scanResults]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const max = window.innerWidth - SIDEBAR_MIN_WIDTH;
      setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(e.clientX, max)));
    };
    const onUp = () => setIsResizing(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizing]);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const removeFile = useCallback(
    async (filePath: string) => {
      const fileName = pathModule.basename(filePath);
      try {
        await ipcRenderer.invoke('delete-transcript', filePath);
      } catch (error) {
        showToast(`❌ Failed to delete ${fileName}: ${getErrorMessage(error)}`);
        return;
      }
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (!dir) return;
      const rawList: Transcript[] = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
      const sorted = sortTranscripts(rawList);
      if (mode === 'audio') {
        setAudioTranscripts(sorted);
      } else {
        setImageTranscripts(sorted);
      }
      setQualityScores(prev => {
        if (!prev[fileName]) return prev;
        const next = { ...prev };
        delete next[fileName];
        return next;
      });
      setScanResults(prev => {
        const filtered = prev.filter(entry => entry.file !== fileName);
        return filtered.length === prev.length ? prev : filtered;
      });
    },
    [mode, audioOutputDir, imageOutputDir]
  );

  const applyOutputSelection = useCallback(
    async (dir: string, targetMode: 'audio' | 'image') => {
      if (!dir) return;
      if (targetMode === 'audio') {
        setAudioOutputDir(dir);
        const rawList: Transcript[] = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
        setAudioTranscripts(sortTranscripts(rawList));
      } else {
        setImageOutputDir(dir);
        const rawList: Transcript[] = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
        setImageTranscripts(sortTranscripts(rawList));
      }
    },
    []
  );

  const selectInput = useCallback(() => {
    const isAudio = mode === 'audio';
    setPathPicker({
      target: isAudio ? 'audio-input' : 'image-input',
      allowFiles: isAudio
    });
  }, [mode]);

  const selectOutput = useCallback(() => {
    setPathPicker({
      target: mode === 'audio' ? 'audio-output' : 'image-output',
      allowFiles: false
    });
  }, [mode]);

  const openBatchQueueWindow = useCallback(() => {
    ipcRenderer.invoke('open-batch-queue');
  }, []);

  const toggleMistralOutputPdf = useCallback(() => {
    setMistralOutputPdf(v => !v);
  }, []);

  const toggleImageBatch = useCallback(() => {
    setImageBatchEnabled(v => !v);
  }, []);

  const toggleAudioBatch = useCallback(() => {
    setAudioBatchEnabled(v => !v);
  }, []);

  const toggleLogs = useCallback(() => {
    setShowLogs(s => !s);
  }, []);

  const currentList = useMemo(
    () => (mode === 'audio' ? audioTranscripts : imageTranscripts),
    [mode, audioTranscripts, imageTranscripts]
  );
  // Mistral OCR results carry the model's own average confidence in their
  // .ocrmeta.json sidecar; that real score overrides the heuristic scan
  // wherever a sidecar exists. Other files keep the scan-based entry.
  // Loaded async (statSync/readFileSync per file would block the UI thread
  // on every list refresh for large output folders on a slow disk).
  const [mistralQualityOverrides, setMistralQualityOverrides] = useState<Record<string, QualityEntry>>({});
  const mistralQualityOverridesRef = useRef(mistralQualityOverrides);
  mistralQualityOverridesRef.current = mistralQualityOverrides;
  useEffect(() => {
    if (mode !== 'image' || imageTranscripts.length === 0) {
      setMistralQualityOverrides({});
      return;
    }
    const pending = imageTranscripts.filter(t => !(t.name in mistralQualityOverridesRef.current));
    if (pending.length === 0) return;
    let cancelled = false;
    // Capped concurrency, same rationale/limit as cleanupWrappers above —
    // avoid firing hundreds of concurrent sidecar reads on a large batch.
    const MISTRAL_QUALITY_CONCURRENCY = 6;
    (async () => {
      const next: Record<string, QualityEntry> = {};
      for (let i = 0; i < pending.length; i += MISTRAL_QUALITY_CONCURRENCY) {
        if (cancelled) return;
        const chunk = pending.slice(i, i + MISTRAL_QUALITY_CONCURRENCY);
        const pairs = await Promise.all(
          chunk.map(async t => [t.name, await loadMistralQualityEntry(t)] as const)
        );
        for (const [name, entry] of pairs) {
          if (entry) next[name] = entry;
        }
      }
      if (cancelled) return;
      setMistralQualityOverrides(prev => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, imageTranscripts]);
  const displayScores = useMemo(() => {
    if (mode !== 'image') return qualityScores;
    return { ...qualityScores, ...mistralQualityOverrides };
  }, [mode, qualityScores, mistralQualityOverrides]);
  const nameFilter = useMemo(() => filter.toLowerCase(), [filter]);
  const filtered = useMemo(
    () =>
      [...currentList]
        .filter(t => t.name.toLowerCase().includes(nameFilter))
        .filter(t => {
          if (fileTypeFilter === 'all') return true;
          const lowerName = t.name.toLowerCase();
          const isTranscript = lowerName.endsWith('.txt');
          const isSubtitle = lowerName.endsWith('.srt');
          const isPdf = lowerName.endsWith('.pdf') || lowerName.endsWith('.html');
          if (fileTypeFilter === 'transcript') return isTranscript;
          if (fileTypeFilter === 'subtitle') return isSubtitle;
          return isPdf;
        })
        .filter(t => {
          if (issueFilter === 'all') return true;
          const entry = displayScores[t.name];
          if (!entry) return false;
          const hasIssues = Boolean(entry.issues && entry.issues.length);
          return issueFilter === 'issues' ? hasIssues : !hasIssues;
        })
        .filter(t => {
          if (reviewStatusFilter === 'all') return true;
          const isReviewed = Boolean(reviewedStatus[t.name]);
          return reviewStatusFilter === 'reviewed' ? isReviewed : !isReviewed;
        })
        .sort((a, b) => {
          switch (sortOption) {
            case 'name-asc':
              return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            case 'name-desc':
              return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
            case 'confidence-asc': {
              const aScore = displayScores[a.name]?.confidence ?? Number.POSITIVE_INFINITY;
              const bScore = displayScores[b.name]?.confidence ?? Number.POSITIVE_INFINITY;
              if (aScore !== bScore) return aScore - bScore;
              return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            }
            case 'confidence-desc': {
              const aScore = displayScores[a.name]?.confidence ?? Number.NEGATIVE_INFINITY;
              const bScore = displayScores[b.name]?.confidence ?? Number.NEGATIVE_INFINITY;
              if (aScore !== bScore) return bScore - aScore;
              return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            }
            default:
              return 0;
          }
        }),
    [currentList, nameFilter, fileTypeFilter, issueFilter, reviewStatusFilter, reviewedStatus, displayScores, sortOption]
  );

  const copyImagesToDestination = useCallback(
    async (destDir: string) => {
      try {
        const sourcePaths = filtered.map(item => item.path);
        if (!sourcePaths.length) {
          showToast('No files found for the current list.');
          return;
        }
        let copied = 0;
        let skipped = 0;
        for (const src of sourcePaths) {
          try {
            const target = ensureUniquePath(destDir, pathModule.basename(src));
            await fs.promises.copyFile(src, target);
            copied += 1;
          } catch {
            skipped += 1;
          }
        }
        const parts = [`Copied ${copied} file${copied === 1 ? '' : 's'}`];
        if (skipped) parts.push(`${skipped} skipped`);
        showToast(parts.join(' • '));
      } catch (error) {
        showToast(`❌ Copy failed: ${getErrorMessage(error)}`);
      }
    },
    [filtered]
  );

  const copyImagesToFolder = useCallback(() => {
    if (!filtered.length) {
      showToast('No files to copy');
      return;
    }
    setPathPicker({
      target: 'copy-images',
      allowFiles: false
    });
  }, [filtered]);

  const handlePathPickerSelect = useCallback(
    async (selection: { path: string; isDirectory: boolean }) => {
      if (!pathPicker) return;
      switch (pathPicker.target) {
        case 'audio-input':
          setAudioInputPath(normalizeLocalPath(selection.path));
          break;
        case 'image-input':
          if (!selection.isDirectory) return;
          setImageInputPath(normalizeLocalPath(selection.path));
          break;
        case 'audio-output':
          if (!selection.isDirectory) return;
          await applyOutputSelection(normalizeLocalPath(selection.path), 'audio');
          break;
        case 'image-output':
          if (!selection.isDirectory) return;
          await applyOutputSelection(normalizeLocalPath(selection.path), 'image');
          break;
        case 'copy-images':
          if (!selection.isDirectory) return;
          await copyImagesToDestination(normalizeLocalPath(selection.path));
          break;
        default:
          break;
      }
      setPathPicker(null);
    },
    [applyOutputSelection, copyImagesToDestination, pathPicker]
  );

  const closePathPicker = useCallback(() => setPathPicker(null), []);

  const transcribeAudio = useCallback(
    async (interviewMode: boolean, generateSubtitles: boolean) => {
      if (!audioInputPath || !audioOutputDir) return;
      setStatus('');
      setIsTranscribing(true);

      let promptToUse = DEFAULT_AUDIO_PROMPT;
      if (generateSubtitles) {
        promptToUse = SUBTITLE_AUDIO_PROMPT;
      } else if (interviewMode) {
        promptToUse = INTERVIEW_AUDIO_PROMPT;
      }

      try {
        const result = await ipcRenderer.invoke(
          'run-transcription',
          'audio',
          audioInputPath,
          audioOutputDir,
          promptToUse,
          generateSubtitles,
          interviewMode,
          {
            batch: effectiveAudioBatchEnabled,
            batchSize: audioBatchSize
          }
        ) as string;
        await refreshTranscriptListForMode('audio', true);
        await refreshVisibleLogs('audio', true);
        await refreshAudioBatchStats();
        await refreshMistralQueueCollectionCount();
        const normalized = typeof result === 'string' ? result.trim() : '';
        const detail = normalized.replace(/^\[[A-Z]+\]\s*/, '');
        setStatus(detail ? `✅ ${detail}` : '✅ Batch complete');
        showToast('✅ Done');
      } catch (err: unknown) {
        const cancelled = isCancellation(err);
        const msg = cancelled ? '❌ Cancelled by user' : `❌ ${getErrorMessage(err)}`;
        setStatus(msg);
        if (!cancelled) {
          showToast(msg);
        }
      } finally {
        setIsTranscribing(false);
      }
    },
    [
      audioInputPath,
      audioOutputDir,
      effectiveAudioBatchEnabled,
      audioBatchSize,
      refreshTranscriptListForMode,
      refreshVisibleLogs,
      refreshAudioBatchStats,
      refreshMistralQueueCollectionCount
    ]
  );

  const transcribeImage = useCallback(async () => {
    if (!imageInputPath || !imageOutputDir) return;

    setStatus('');
    setIsTranscribing(true);
    try {
      const result = await ipcRenderer.invoke(
        'run-transcription',
        'image',
        imageInputPath,
        imageOutputDir,
        '',
        false,
        false,
        {
          recursive: false,
          batch: effectiveImageBatchEnabled,
          batchSize: imageBatchSize,
          outputPdf: isMistralImageModel && mistralOutputPdf
        }
      ) as string;
      
      if (imageOutputDir) {
        await refreshTranscriptListForMode('image', true);
      }
      await refreshVisibleLogs('image', true);

      const normalized = typeof result === 'string' ? result.trim() : '';
      const detail = normalized.replace(/^\[[A-Z]+\]\s*/, '');
      const isInfo = normalized.startsWith('[INFO]');
      const statusText = detail || 'Done';
      setStatus(isInfo ? `ℹ️ ${statusText}` : `✅ ${statusText}`);
      showToast(isInfo ? `ℹ️ ${statusText}` : '✅ Done');
    } catch (err: unknown) {
      const cancelled = isCancellation(err);
      const msg = cancelled ? '❌ Cancelled by user' : `❌ ${getErrorMessage(err)}`;
      setStatus(msg);
      if (!cancelled) {
        showToast(msg);
      }
    } finally {
      await refreshMistralBatchStats();
      await refreshMistralQueueCollectionCount();
      setIsTranscribing(false);
    }
  }, [
    imageInputPath,
    imageOutputDir,
    effectiveImageBatchEnabled,
    imageBatchSize,
    isMistralImageModel,
    mistralOutputPdf,
    refreshMistralBatchStats,
    refreshMistralQueueCollectionCount,
    refreshTranscriptListForMode,
    refreshVisibleLogs
  ]);

  const cancel = useCallback(async () => {
    await ipcRenderer.invoke('cancel-transcription');
    setStatus('❌ Cancelled by user');
    setIsTranscribing(false);
  }, []);

  // Double-click always opens the plain text file. OCR Review is a separate,
  // opt-in action from the right-click menu (openOcrReview).
  const openTranscript = useCallback((p: string) => {
    return ipcRenderer.invoke('open-transcript', p);
  }, []);
  const openOcrReview = useCallback((p: string) => {
    const reviewData = loadOcrReviewData(p);
    if (reviewData) setOcrReview({ txtPath: p, data: reviewData });
    else showToast('No OCR review data for this file.');
  }, [showToast]);
  const openAudioReview = useCallback((transcript: Transcript) => {
    const srtPath = srtPathForTranscript(transcript.path);
    const segments = loadAudioReviewSegments(srtPath);
    if (!segments || !segments.length) {
      showToast('No timestamp data for this file.');
      return;
    }
    const txtPath = txtPathForTranscript(transcript.path);
    const sourceAudioPath = resolveSourceFileForTranscript(transcript, audioInputPath, audioOutputDir, AUDIO_EXTS);
    setAudioReview({ txtPath, srtPath, data: { sourceAudioPath, segments } });
  }, [showToast, audioInputPath, audioOutputDir]);
  const refreshCurrentTranscriptList = useCallback(async () => {
    await refreshTranscriptListForMode(mode, true);
  }, [mode, refreshTranscriptListForMode]);
  const openSourceFileForTranscript = useCallback(
    async (transcript: Transcript) => {
      if (!imageInputPath) {
        showToast('Set an input file or folder first.');
        return;
      }
      const sourcePath = resolveSourceFileForTranscript(transcript, imageInputPath, imageOutputDir, IMAGE_EXTS);
      if (!sourcePath) {
        showToast(`No matching original file found for ${transcript.name}`);
        return;
      }
      try {
        const err = await ipcRenderer.invoke('open-transcript', sourcePath);
        if (err) {
          showToast(`❌ ${err}`);
        }
      } catch (error) {
        showToast(`❌ Failed to open original file: ${getErrorMessage(error)}`);
      }
    },
    [imageInputPath, imageOutputDir]
  );
  const deleteGeneratedFileFamily = useCallback(
    async (transcript: Transcript) => {
      if (!/\.(pdf|html)$/i.test(transcript.name)) {
        showToast('Select a generated PDF or HTML file.');
        return;
      }
      try {
        const result = await ipcRenderer.invoke('delete-generated-family', transcript.path) as {
          ok?: boolean;
          deletedNames?: string[];
          count?: number;
          error?: string;
        };
        if (!result?.ok) {
          throw new Error(result?.error || 'Failed to delete generated files');
        }
        await refreshCurrentTranscriptList();
        const deletedNames = Array.isArray(result.deletedNames) ? result.deletedNames : [];
        if (deletedNames.length) {
          setQualityScores(prev => {
            const next = { ...prev };
            for (const name of deletedNames) {
              delete next[name];
            }
            return next;
          });
          setScanResults(prev => prev.filter(entry => !deletedNames.includes(entry.file)));
        }
        const count = typeof result.count === 'number' ? result.count : deletedNames.length;
        showToast(`Deleted ${count} generated file${count === 1 ? '' : 's'}`);
      } catch (error) {
        showToast(`❌ Failed to delete generated files: ${getErrorMessage(error)}`);
      }
    },
    [refreshCurrentTranscriptList]
  );
  const clearLogs = useCallback(async () => {
    await ipcRenderer.invoke('clear-logs', mode);
    setLogs('');
  }, [mode]);
  const exportLogs = useCallback(async () => {
    if (!logs || !logs.trim()) {
      showToast('No logs to export');
      return;
    }
    try {
      const result = await ipcRenderer.invoke('export-logs', { mode }) as {
        canceled?: boolean;
        filePath?: string;
        count?: number;
        error?: string;
      };
      if (result?.canceled) return;
      if (result?.error) {
        showToast(`❌ ${result.error}`);
        return;
      }
      const count = result?.count;
      showToast(
        typeof count === 'number'
          ? `Exported ${count} log line${count === 1 ? '' : 's'}`
          : 'Exported logs'
      );
    } catch (error) {
      showToast(`❌ Export failed: ${getErrorMessage(error)}`);
    }
  }, [logs, mode]);

  const contextIssues = contextMenu
    ? displayScores[contextMenu.transcript.name]?.issues
    : undefined;
  const contextScanEntry = contextMenu
    ? scanResults.find(entry => entry.file === contextMenu.transcript.name)
    : undefined;
  const canClearContextWarning = Boolean(contextIssues && contextIssues.length);
  const canOpenContextSourceFile = Boolean(imageInputPath);
  const canRemediateContextFile = Boolean(contextScanEntry && isScanEntryRemediable(contextScanEntry));
  const canDeleteGeneratedContextFamily = Boolean(contextMenu && /\.(pdf|html)$/i.test(contextMenu.transcript.name));
  // Cheap existence stat (not a full sidecar read) — the OCR Review item only
  // appears for Mistral image transcripts, which are the ones with a sidecar.
  const canOcrReviewContextFile = Boolean(
    contextMenu && fs.existsSync(ocrReviewSidecarPathForTranscript(contextMenu.transcript.path))
  );
  // Same cheap existence check as OCR Review's sidecar gate — Audio Review
  // only works for transcripts that have a sibling .srt (only written when
  // "Generate subtitles" was checked at transcribe time).
  const canAudioReviewContextFile = Boolean(
    contextMenu && mode === 'audio' && fs.existsSync(srtPathForTranscript(contextMenu.transcript.path))
  );

  const exportTranscriptList = useCallback(async () => {
    if (!filtered.length) {
      showToast('No files to export');
      return;
    }
    try {
      const outputDir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      const result = await ipcRenderer.invoke('export-transcript-list', {
        mode,
        items: filtered.map(item => {
          const entry = displayScores[item.name];
          const confidence = entry?.confidence;
          const issues = entry?.issues?.length ? entry.issues.join('; ') : '';
          return {
            name: item.name,
            confidence,
            reason: issues
          };
        }),
        filters: {
          mode,
          outputDir,
          search: filter,
          fileType: fileTypeFilter,
          issues: issueFilter,
          sort: sortOption,
          total: currentList.length,
          exported: filtered.length
        }
      }) as { canceled?: boolean; filePath?: string; count?: number; error?: string };
      if (result?.canceled) return;
      if (result?.error) {
        showToast(`❌ ${result.error}`);
        return;
      }
      const count = result?.count ?? filtered.length;
      showToast(`Exported ${count} file${count === 1 ? '' : 's'}`);
    } catch (error) {
      showToast(`❌ Export failed: ${getErrorMessage(error)}`);
    }
  }, [
    filtered,
    mode,
    filter,
    fileTypeFilter,
    issueFilter,
    sortOption,
    currentList.length,
    audioOutputDir,
    imageOutputDir,
    displayScores
  ]);

  const resetFilters = useCallback(() => {
    setFilter('');
    setFileTypeFilter('all');
    setIssueFilter('all');
    setReviewStatusFilter('all');
    setSortOption('name-asc');
  }, []);

  if (isSettings) {
    return (
      <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
        <main className="content" style={{ padding: 0 }}>
          <SettingsView
            currentVersion={currentVersion}
            latestVersion={latestVersion}
            checkingUpdate={checkingUpdate}
            updateError={updateError}
            onCheckLatest={fetchLatestVersion}
            onOpenUpdatePage={openUpdatePage}
            onOpenUpdateInstructions={openUpdateInstructions}
          />
        </main>
      </div>
    );
  }

  if (isBatchQueue) {
    return (
      <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
        <main className="content" style={{ padding: 0 }}>
          <BatchQueueView />
        </main>
      </div>
    );
  }

  return (
    <div className={`app-shell${isResizing ? ' resizing' : ''}`} data-mode={mode}>
      <SettingsGearBadge newVersionAvailable={newVersionAvailable} />

      <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
        {!hideHeuristicQualityTools && (
          <div className="controls">
            <div className="field-row quality-scan-row">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <div style={{ position: 'relative', display: 'inline-block' }}>
                    <input
                      className="scan-input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      step={1}
                      value={threshold}
                      onKeyDown={e => {
                        if (['e','E','+','-','.'].includes(e.key)) e.preventDefault();
                      }}
                      onChange={e => {
                        const raw = e.target.value.trim();
                        // Allow the field to be empty mid-edit instead of snapping to 0.
                        if (raw === '') {
                          setThreshold(0);
                          return;
                        }
                        const parsed = parseInt(raw.replace(/^0+(?=\d)/, ''), 10);
                        if (Number.isNaN(parsed)) return; // ignore non-numeric input; keep last valid value
                        setThreshold(Math.min(100, Math.max(0, parsed)));
                      }}
                      onBlur={e => {
                        const parsed = parseInt(e.target.value, 10);
                        setThreshold(Number.isNaN(parsed) ? 0 : Math.min(100, Math.max(0, parsed)));
                      }}
                      title="Minimum confidence (0–100). Files below this value are flagged in red."
                      style={{ paddingRight: '1.5ch' }}
                    />
                    <span style={{ position: 'absolute', right: '0.5ch', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-light)' }}>%</span>
                  </div>
                  <button
                    className="scan-btn btn"
                    onClick={scanQuality}
                    disabled={isScanningQuality || !(audioOutputDir || imageOutputDir)}
                    aria-label="Scan transcripts to compute confidence"
                  >
                    {isScanningQuality ? <FaSpinner className="spin" /> : 'Check Quality'}
                  </button>
                  <InfoTooltip text="Enter the minimum acceptable confidence (0–100). Confidence combines placeholder density, repetition, AI boilerplate, unusual token density, wrapper/artifact signals (intro/outro chatter, markdown, encoded entities), and SRT timestamp validation penalties. Empty transcripts are marked as Blank and treated as 0% confidence. Colors: green for ≥99%, yellow between the threshold and 99%, red below the threshold." />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <button
                    className="scan-btn btn"
                    onClick={remediateDocuments}
                    disabled={
                      isRemediating ||
                      !canRemediate ||
                      !(audioOutputDir || imageOutputDir)
                    }
                    aria-label="Apply remediation suggestions from the last scan"
                    style={{ flexShrink: 0 }}
                  >
                    {isRemediating ? <FaSpinner className="spin" /> : 'Remediate'}
                  </button>
                  <InfoTooltip text="Uses the last scan’s intro/outro suggestions to clean affected transcripts. Re-scan afterwards if you want fresh confidence scores." />
                </div>
              </div>
            </div>
          </div>
        )}
        <div style={{ marginTop: '0rem' }}>
          <button
            type="button"
            className="btn filter-toggle"
            aria-expanded={showFilters}
            onClick={() => setShowFilters(prev => !prev)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.55rem 0.9rem',
              fontWeight: 500
            }}
          >
            <span>{showFilters ? 'Hide Filters' : 'Show Filters'}</span>
            <span
              style={{
                display: 'inline-block',
                transform: showFilters ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
                fontSize: '1.25rem',
                lineHeight: 1
              }}
            >
              ›
            </span>
          </button>
          {showFilters && (
            <div
              className="filter-panel"
              style={{
                marginTop: '0.75rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                background: 'rgba(21, 24, 34, 0.95)',
                borderRadius: 'var(--radius-lg)',
                padding: '1rem',
                boxShadow: '0 10px 20px rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'stretch', gap: '0.5rem' }}>
                <input
                  className="filter-input"
                  placeholder={isFilterFocused ? '' : 'Filter transcripts, subtitles…'}
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  onFocus={() => setIsFilterFocused(true)}
                  onBlur={() => setIsFilterFocused(false)}
                  style={{ width: '100%', marginBottom: 0, height: '32px' }}
                />
                <button
                  type="button"
                  onClick={resetFilters}
                  title="Reset filters and sorting to defaults"
                  aria-label="Reset filters and sorting to defaults"
                  style={{
                    padding: 0,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-light)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '32px',
                    width: '32px'
                  }}
                >
                  <FaUndo size={14} />
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr',
                  gap: '0.75rem'
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.9rem' }}>
                  <span>Type</span>
                  <select
                    value={fileTypeFilter}
                    onChange={e => setFileTypeFilter(e.target.value as 'all' | 'transcript' | 'subtitle' | 'pdf')}
                    style={{ width: '100%', padding: '0.45rem 0.6rem' }}
                  >
                    <option value="all">All files</option>
                    <option value="transcript">Transcripts (.txt)</option>
                    <option value="subtitle">Subtitles (.srt)</option>
                    <option value="pdf">Documents (.pdf, .html)</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.9rem' }}>
                  <span>Sort</span>
                  <select
                    value={sortOption}
                    onChange={e => setSortOption(e.target.value as SortOption)}
                    style={{ width: '100%', padding: '0.45rem 0.6rem' }}
                  >
                    <option value="name-asc">Alphabetical ↑ (default)</option>
                    <option value="name-desc">Alphabetical ↓</option>
                    <option value="confidence-desc">Confidence ↓</option>
                    <option value="confidence-asc">Confidence ↑</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.9rem' }}>
                  <span>Flags</span>
                  <select
                    value={issueFilter}
                    onChange={e => setIssueFilter(e.target.value as 'all' | 'clean' | 'issues')}
                    style={{ width: '100%', padding: '0.45rem 0.6rem' }}
                  >
                    <option value="all">All statuses</option>
                    <option value="issues">Needs review (has issues)</option>
                    <option value="clean">No issues</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.9rem' }}>
                  <span>Review</span>
                  <select
                    value={reviewStatusFilter}
                    onChange={e => setReviewStatusFilter(e.target.value as 'all' | 'unreviewed' | 'reviewed')}
                    style={{ width: '100%', padding: '0.45rem 0.6rem' }}
                  >
                    <option value="all">All files</option>
                    <option value="unreviewed">Unreviewed</option>
                    <option value="reviewed">Reviewed</option>
                  </select>
                </label>
              </div>
            </div>
          )}
        </div>
        
        {/* File count and refresh section */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0.75rem 0',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          marginTop: '0.75rem',
          gap: '0.25rem'
        }}>
          <span style={{
            fontSize: '0.9rem',
            color: 'var(--text-light)',
            fontWeight: 500
          }}>
            {filtered.length} file{filtered.length !== 1 ? 's' : ''}
            {filtered.length !== (mode === 'audio' ? audioTranscripts : imageTranscripts).length && 
              ` (${(mode === 'audio' ? audioTranscripts : imageTranscripts).length} total)`
            }
          </span>
          <button
            className="btn"
            onClick={refreshTranscriptList}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85rem',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              transition: 'all 0.2s ease'
            }}
            title="Refresh the list"
          >
            <FaSync size={12} />
          </button>
          <span style={{ marginLeft: 'auto' }} />
          <button
            className="btn"
            onClick={exportTranscriptList}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85rem',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              transition: 'all 0.2s ease'
            }}
            title="Export this list as CSV"
          >
            <FaDownload size={12} /> Export
          </button>
          <button
            className="btn"
            onClick={() => setShowBatchFindReplace(true)}
            disabled={!filtered.length}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85rem',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
            title="Find and replace text across every listed transcript"
          >
            Find &amp; Replace
          </button>
        </div>
        <ul className="transcript-list">
          {filtered.map(t => (
            <TranscriptListItem
              key={t.path}
              transcript={t}
              entry={displayScores[t.name]}
              threshold={threshold}
              reviewed={Boolean(reviewedStatus[t.name])}
              onOpen={openTranscript}
              onRemove={removeFile}
              onToggleReviewed={toggleReviewed}
              onContextMenu={onTranscriptContextMenu}
            />
          ))}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.75rem' }}>
          <button
            className="btn"
            onClick={copyImagesToFolder}
            style={{
              padding: '0.6rem 0.8rem',
              width: '100%',
              fontSize: '0.85rem',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              transition: 'all 0.2s ease'
            }}
            title="Copy the files shown in this list to a folder you choose"
          >
            <FaCopy size={12} /> Copy to Folder
          </button>
        </div>
        {contextMenu && (
          <div
            className="transcript-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            role="menu"
            aria-label="Transcript actions"
            ref={el => {
              if (el && !el.contains(document.activeElement)) {
                (el.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
              }
            }}
            onKeyDown={e => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              );
              if (!items.length) return;
              const idx = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                e.key === 'ArrowDown'
                  ? items[(idx + 1) % items.length]
                  : items[(idx - 1 + items.length) % items.length];
              next.focus();
            }}
          >
            <button
              role="menuitem"
              className="transcript-context-item"
              onClick={() => {
                openSourceFileForTranscript(contextMenu.transcript);
                closeContextMenu();
              }}
              disabled={!canOpenContextSourceFile}
            >
              Open original file
            </button>
            {canOcrReviewContextFile && (
              <button
                role="menuitem"
                className="transcript-context-item"
                onClick={() => {
                  openOcrReview(contextMenu.transcript.path);
                  closeContextMenu();
                }}
              >
                Open in OCR Review
              </button>
            )}
            {canAudioReviewContextFile && (
              <button
                role="menuitem"
                className="transcript-context-item"
                onClick={() => {
                  openAudioReview(contextMenu.transcript);
                  closeContextMenu();
                }}
              >
                Open in Audio Review
              </button>
            )}
            {canDeleteGeneratedContextFamily && (
              <button
                role="menuitem"
                className="transcript-context-item"
                onClick={() => {
                  void deleteGeneratedFileFamily(contextMenu.transcript);
                  closeContextMenu();
                }}
                disabled={isTranscribing}
              >
                Delete generated files
              </button>
            )}
            <button
              role="menuitem"
              className="transcript-context-item"
              onClick={() => {
                void remediateSingleDocument(contextMenu.transcript.name);
                closeContextMenu();
              }}
              disabled={!canRemediateContextFile || isRemediating}
            >
              Remediate file
            </button>
            <button
              role="menuitem"
              className="transcript-context-item"
              onClick={() => {
                clearTranscriptWarnings(contextMenu.transcript.name);
                closeContextMenu();
              }}
              disabled={!canClearContextWarning}
            >
              Clear warning
            </button>
          </div>
        )}
        <div className="sidebar-resizer" onMouseDown={onMouseDown} />
      </aside>

      <main className="content">
        <div className="logo">
          TranscribeAI
          <span className="logo-tagline">Audio &amp; Document Transcription</span>
        </div>

        <button
          type="button"
          className={`mode-toggle ${mode}`}
          role="switch"
          aria-checked={mode === 'image'}
          aria-label="Transcription mode: Audio or Image"
          onClick={() => setMode(m => (m === 'audio' ? 'image' : 'audio'))}
          onKeyDown={e => {
            if (e.key === 'ArrowLeft' || e.key === 'Home') {
              e.preventDefault();
              setMode('audio');
            } else if (e.key === 'ArrowRight' || e.key === 'End') {
              e.preventDefault();
              setMode('image');
            }
          }}
        >
          <span className={mode === 'audio' ? 'label active' : 'label'}>Audio</span>
          <span className={mode === 'image' ? 'label active' : 'label'}>Image</span>
          <span className="toggle-thumb" />
        </button>

        {mode === 'audio' ? (
          <AudioTranscriber
            inputPath={audioInputPath}
            outputDir={audioOutputDir}
            isTranscribing={isTranscribing}
            mistralVoxtralMode={isMistralAudioModel}
            batchEnabled={effectiveAudioBatchEnabled}
            batchSize={audioBatchSize}
            inputIsDirectory={audioInputIsDirectory}
            batchStats={audioBatchStats}
            costEstimate={audioBatchCostEstimate}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onClearInput={clearAudioInputPath}
            onClearOutput={clearAudioOutputDir}
            onToggleBatch={toggleAudioBatch}
            onBatchSizeChange={setAudioBatchSize}
            onOpenBatchQueue={openBatchQueueWindow}
            queueCollectionCount={mistralQueueCollectionCount}
            onTranscribe={transcribeAudio}
            onCancel={cancel}
          />
        ) : (
          <ImageTranscriber
            inputPath={imageInputPath}
            outputDir={imageOutputDir}
            isTranscribing={isTranscribing}
            mistralMode={isMistralImageModel}
            outputPdfEnabled={mistralOutputPdf}
            batchEnabled={effectiveImageBatchEnabled}
            batchSize={imageBatchSize}
            inputIsDirectory={imageInputIsDirectory}
            batchStats={mistralBatchStats}
            costEstimate={imageBatchCostEstimate}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onClearInput={clearImageInputPath}
            onClearOutput={clearImageOutputDir}
            onToggleOutputPdf={toggleMistralOutputPdf}
            onToggleBatch={toggleImageBatch}
            onBatchSizeChange={setImageBatchSize}
            onOpenBatchQueue={openBatchQueueWindow}
            queueCollectionCount={mistralQueueCollectionCount}
            onTranscribe={transcribeImage}
            onCancel={cancel}
          />
        )}

        {status && (
          <div className="status-bar" role="status" aria-live="polite">
            {status}
          </div>
        )}

        <LogsPanel
          logs={logs}
          showLogs={showLogs}
          onToggle={toggleLogs}
          onExport={exportLogs}
          onClear={clearLogs}
          logsBodyRef={logsBodyRef}
        />
      </main>

      {toast && (
        <div className="toast" role="status" aria-live="polite" aria-atomic="true">
          {toast}
        </div>
      )}

      {pathPicker && (
        <FolderPickerModal
          isOpen
          title={
            {
              'audio-input': 'Select Audio Input',
              'audio-output': 'Select Audio Output Folder',
              'image-input': 'Select Image Input',
              'image-output': 'Select Image Output Folder',
              'copy-images': 'Select Destination Folder'
            }[pathPicker.target]
          }
          allowFileSelection={pathPicker.allowFiles}
          initialPath={getInitialPathForPicker(pathPicker.target)}
          favorites={folderFavorites}
          onAddFavorite={addFavoritePath}
          onRemoveFavorite={removeFavoritePath}
          onSelect={handlePathPickerSelect}
          onCancel={closePathPicker}
        />
      )}

      {ocrReview && (
        <OcrReviewModal
          isOpen
          txtPath={ocrReview.txtPath}
          data={ocrReview.data}
          onClose={closeOcrReview}
          onSaved={refreshCurrentTranscriptList}
          reviewed={Boolean(reviewedStatus[pathModule.basename(ocrReview.txtPath)])}
          onToggleReviewed={toggleOcrReviewReviewed}
        />
      )}

      {audioReview && (
        <AudioReviewModal
          isOpen
          txtPath={audioReview.txtPath}
          srtPath={audioReview.srtPath}
          data={audioReview.data}
          onClose={closeAudioReview}
          onSaved={refreshCurrentTranscriptList}
          reviewed={Boolean(reviewedStatus[pathModule.basename(audioReview.txtPath)])}
          onToggleReviewed={toggleAudioReviewReviewed}
        />
      )}

      <BatchFindReplaceModal
        isOpen={showBatchFindReplace}
        files={filtered}
        onClose={() => setShowBatchFindReplace(false)}
        onDone={refreshCurrentTranscriptList}
      />
    </div>
  );
}
