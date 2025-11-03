import React, { useState, useRef, useEffect, useCallback } from 'react';
import AudioTranscriber, { Transcript } from './components/AudioTranscriber';
import ImageTranscriber from './components/ImageTranscriber';
import {
  DEFAULT_AUDIO_PROMPT,
  INTERVIEW_AUDIO_PROMPT,
  SUBTITLE_AUDIO_PROMPT,
  DEFAULT_IMAGE_PROMPT
} from '../../defaultPrompts';
import {
  FaCog,
  FaChevronDown,
  FaChevronUp,
  FaUndo,
  FaQuestionCircle,
  FaTimes,
  FaSpinner,
} from 'react-icons/fa';
import './App.css';

const { ipcRenderer } = (window as any).require('electron');
const fs = (window as any).require('fs') as typeof import('fs');

// ─── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

type QualityEntry = {
  confidence: number;
  removeIntroText?: string;
  removeOutroText?: string;
};

type ScanResultEntry = {
  file: string;
  confidence: number;
  remove_intro_text?: string;
  remove_outro_text?: string;
};

type SortOption = 'name-asc' | 'name-desc' | 'confidence-desc' | 'confidence-asc';

const stripOuterQuotes = (line: string) =>
  line.replace(/^[\"'“”‘’]+/, '').replace(/[\"'“”‘’]+$/, '');

const removeWrappersFromContent = (
  content: string,
  intro?: string,
  outro?: string
) => {
  if (!intro && !outro) return content;

  const endsWithNewline = /\r?\n$/.test(content);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  let startIdx = 0;
  while (startIdx < lines.length && !lines[startIdx].trim()) startIdx++;

  let workingLines = lines.slice();
  let removedIntro = false;
  let removedOutro = false;

  if (intro && startIdx < workingLines.length) {
    const firstLine = stripOuterQuotes(workingLines[startIdx]).trim();
    if (firstLine.toLowerCase().startsWith(intro.toLowerCase())) {
      workingLines = workingLines.slice(startIdx + 1);
      removedIntro = true;
    }
  }

  if (removedIntro) {
    while (workingLines.length && !workingLines[0].trim()) workingLines.shift();
  }

  if (outro && workingLines.length) {
    let endIdx = workingLines.length - 1;
    while (endIdx >= 0 && !workingLines[endIdx].trim()) endIdx--;
    if (endIdx >= 0) {
      const lastLine = stripOuterQuotes(workingLines[endIdx]).trim();
      if (lastLine.toLowerCase().startsWith(outro.toLowerCase())) {
        workingLines = workingLines.slice(0, endIdx);
        removedOutro = true;
      }
    }
  }

  if (removedOutro) {
    while (workingLines.length && !workingLines[workingLines.length - 1].trim()) {
      workingLines.pop();
    }
  }

  if (!removedIntro && !removedOutro) return content;

  const cleaned = workingLines.join(newline);
  if (!cleaned) return '';
  return endsWithNewline ? `${cleaned}${newline}` : cleaned;
};

// Simple tooltip component
const InfoTooltip: React.FC<{ text: string }> = ({ text }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: 6,
      }}
    >
      <div
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        aria-label="More info"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'default',
          padding: 4,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
        }}
      >
        <FaQuestionCircle size={14} />
      </div>
      {visible && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: '110%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#1f2330',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.3,
            width: 240,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 100,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
};

// ─── Settings View ──────────────────────────────────────────────────────────────
function SettingsView() {
  const [key, setKey] = useState('');
  const [audioModel, setAudioModel] = useState(MODEL_OPTIONS[0]);
  const [imageModel, setImageModel] = useState(MODEL_OPTIONS[1]);
  const [audioPrompt, setAudioPrompt] = useState<string>(DEFAULT_AUDIO_PROMPT);
  const [imagePrompt, setImagePrompt] = useState<string>(DEFAULT_IMAGE_PROMPT);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipcRenderer
      .invoke('get-api-key')
      .then((k: string) => setKey(k || localStorage.getItem('apiKey') || ''))
      .catch(() => setKey(localStorage.getItem('apiKey') || ''));

    ipcRenderer
      .invoke('get-audio-model')
      .then((m: string) =>
        setAudioModel(m || (localStorage.getItem('audioModel') || MODEL_OPTIONS[0]))
      )
      .catch(() =>
        setAudioModel((localStorage.getItem('audioModel') as string) || MODEL_OPTIONS[0])
      );

    ipcRenderer
      .invoke('get-image-model')
      .then((m: string) =>
        setImageModel(m || (localStorage.getItem('imageModel') || MODEL_OPTIONS[1]))
      )
      .catch(() =>
        setImageModel((localStorage.getItem('imageModel') as string) || MODEL_OPTIONS[1])
      );

    ipcRenderer
      .invoke('get-audio-prompt')
      .then((p: string) =>
        setAudioPrompt(
          p || (localStorage.getItem('audioPrompt') as string) || DEFAULT_AUDIO_PROMPT
        )
      )
      .catch(() =>
        setAudioPrompt((localStorage.getItem('audioPrompt') as string) || DEFAULT_AUDIO_PROMPT)
      );

    ipcRenderer
      .invoke('get-image-prompt')
      .then((p: string) =>
        setImagePrompt(
          p || (localStorage.getItem('imagePrompt') as string) || DEFAULT_IMAGE_PROMPT
        )
      )
      .catch(() =>
        setImagePrompt((localStorage.getItem('imagePrompt') as string) || DEFAULT_IMAGE_PROMPT)
      );
  }, []);

  const save = async () => {
    try {
      await ipcRenderer.invoke('set-api-key', key);
    } catch {
      localStorage.setItem('apiKey', key);
    }

    try {
      await ipcRenderer.invoke('set-audio-model', audioModel);
    } catch {
      localStorage.setItem('audioModel', audioModel);
    }
    try {
      await ipcRenderer.invoke('set-image-model', imageModel);
    } catch {
      localStorage.setItem('imageModel', imageModel);
    }

    try {
      await ipcRenderer.invoke('set-audio-prompt', audioPrompt);
    } catch {
      localStorage.setItem('audioPrompt', audioPrompt);
    }
    try {
      await ipcRenderer.invoke('set-image-prompt', imagePrompt);
    } catch {
      localStorage.setItem('imagePrompt', imagePrompt);
    }

    // show saved feedback instead of closing
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const revertAudioPrompt = () => setAudioPrompt(DEFAULT_AUDIO_PROMPT);
  const revertImagePrompt = () => setImagePrompt(DEFAULT_IMAGE_PROMPT);

  return (
    <div className="settings-container" style={{ position: 'relative' }}>
      {/* X close button top-right */}
      <button
        aria-label="Close settings"
        onClick={() => window.close()}
        style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 6,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-light)',
          fontSize: '1.2rem',
        }}
        title="Close"
      >
        <FaTimes />
      </button>

      <h2>Settings</h2>

      <label htmlFor="api-key">Gemini API Key</label>
      <input
        id="api-key"
        type="password"
        value={key}
        placeholder="Enter your API key"
        onChange={e => setKey(e.target.value)}
      />

      <div
        className="model-prompt-row"
        style={{
          display: 'flex',
          gap: '2rem',
          flexWrap: 'nowrap',
          alignItems: 'flex-start',
          width: '100%',
          marginTop: '1rem',
        }}
      >
        {/* Audio */}
        <div
          className="model-with-prompt"
          style={{ flex: '1 1 0', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="model-group">
            <label htmlFor="audio-model">Audio Model</label>
            <select
              id="audio-model"
              value={audioModel}
              onChange={e => setAudioModel(e.target.value)}
            >
              {MODEL_OPTIONS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="prompt-group">
            <div
              className="prompt-header"
              style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="audio-prompt" style={{ margin: 0 }}>
                  Audio Prompt
                </label>
                <InfoTooltip text="Editing this changes the instructions sent to the model for transcription. Click the revert icon to restore the recommended default prompt." />
              </div>
              <button
                type="button"
                className="revert-btn"
                onClick={revertAudioPrompt}
                aria-label="Revert to default prompt"
                style={{
                  background: 'rgba(0,0,0,0.6)',
                  border: 'none',
                  padding: '10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <FaUndo size={18} />
              </button>
            </div>
            <textarea
              id="audio-prompt"
              value={audioPrompt}
              onChange={e => setAudioPrompt(e.target.value)}
              style={{ resize: 'none' }}
            />
          </div>
        </div>

        {/* Image */}
        <div
          className="model-with-prompt"
          style={{ flex: '1 1 0', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="model-group">
            <label htmlFor="image-model">Image Model</label>
            <select
              id="image-model"
              value={imageModel}
              onChange={e => setImageModel(e.target.value)}
            >
              {MODEL_OPTIONS.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="prompt-group">
            <div
              className="prompt-header"
              style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="image-prompt" style={{ margin: 0 }}>
                  Image Prompt
                </label>
                <InfoTooltip text="Editing this changes the instructions sent to the model for transcription. Click the revert icon to restore the recommended default prompt." />
              </div>
              <button
                type="button"
                className="revert-btn"
                onClick={revertImagePrompt}
                aria-label="Revert to default prompt"
                style={{
                  background: 'rgba(0,0,0,0.6)',
                  border: 'none',
                  padding: '10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <FaUndo size={18} />
              </button>
            </div>
            <textarea
              id="image-prompt"
              value={imagePrompt}
              onChange={e => setImagePrompt(e.target.value)}
              style={{ resize: 'none' }}
            />
          </div>
        </div>
      </div>

      {/* buttons + saved feedback */}
      <div
        className="settings-buttons"
        style={{ position: 'relative', paddingTop: 12, flexWrap: 'nowrap' }}
      >
        {/* Saved badge positioned above without affecting layout */}
        {saved && (
          <div
            style={{
              position: 'absolute',
              top: -24,
              left: '50%',
              transform: 'translateX(-50%)',
              color: '#6dd36d',
              fontWeight: 500,
              fontSize: '0.95rem',
              whiteSpace: 'nowrap',
            }}
          >
            Saved!
          </div>
        )}

        <button className="btn cancel" onClick={() => window.close()}>
          Cancel
        </button>
        <button className="btn save" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

// ─── UTILITY: SORT transcripts alphanumerically ────────────────────────────────
function sortTranscripts(list: Transcript[]): Transcript[] {
  return [...list].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  // settings route
  if (window.location.hash === '#/settings') {
    return <SettingsView />;
  }

  // ─ Sidebar resizing ─────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // ─ Mode toggle ──────────────────────────────────────
  const [mode, setMode] = useState<'audio' | 'image'>('audio');

  // ─ Audio state ──────────────────────────────────────
  const [audioInputPath, setAudioInputPath] = useState('');
  const [audioOutputDir, setAudioOutputDir] = useState('');
  const [audioTranscripts, setAudioTranscripts] = useState<Transcript[]>([]);

  // ─ Image state ──────────────────────────────────────
  const [imageInputPath, setImageInputPath] = useState('');
  const [imageOutputDir, setImageOutputDir] = useState('');
  const [imageTranscripts, setImageTranscripts] = useState<Transcript[]>([]);

  // Quality scan state
  const [threshold, setThreshold] = useState<number>(85);
  const [qualityScores, setQualityScores] = useState<Record<string, QualityEntry>>({});

  const [isScanningQuality, setIsScanningQuality] = useState(false);

  // ─ Shared UI ───────────────────────────────────────
  const [filter, setFilter] = useState('');
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [fileTypeFilter, setFileTypeFilter] = useState<'all' | 'transcript' | 'subtitle'>('all');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [showFilters, setShowFilters] = useState(false);

  // Load logs whenever mode changes
  useEffect(() => {
    ipcRenderer.invoke('read-logs', mode).then(setLogs);
  }, [mode]);

  // Handle progress events
  useEffect(() => {
    const handler = (_: any, file: string, idx: number, total: number, msg: string) => {
      setStatus(`Transcribing ${file} (${idx}/${total})`);
      ipcRenderer.invoke('read-logs', mode).then(setLogs);
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (dir) {
        ipcRenderer.invoke('list-transcripts-subtitles', dir).then((list: Transcript[]) => {
          const sorted = sortTranscripts(list);
          if (mode === 'audio') {
            setAudioTranscripts(sorted);
          } else {
            setImageTranscripts(sorted);
          }
        });
      }
    };
    ipcRenderer.on('transcription-progress', handler);
    return () => {
      ipcRenderer.removeListener('transcription-progress', handler);
    };
  }, [mode, audioOutputDir, imageOutputDir]);

  const cleanupWrappers = useCallback(
    async (entries: ScanResultEntry[], dir: string) => {
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
          return;
        }
      }
      const lookup = new Map(transcripts.map(t => [t.name, t.path]));

      const cleanedFiles: Array<{
        name: string;
        path: string;
        intro?: string;
        outro?: string;
      }> = [];
      await Promise.all(
        entries.map(async entry => {
          const intro = entry.remove_intro_text;
          const outro = entry.remove_outro_text;
          if (!intro && !outro) return;
          const filePath = lookup.get(entry.file);
          if (!filePath) return;

          try {
            const original = await fs.promises.readFile(filePath, 'utf-8');
            const cleaned = removeWrappersFromContent(original, intro, outro);
            if (cleaned !== original) {
              await fs.promises.writeFile(filePath, cleaned, 'utf-8');
              cleanedFiles.push({
                name: entry.file,
                path: filePath,
                intro: intro?.trim(),
                outro: outro?.trim()
              });
            }
          } catch (error) {
            console.error('Failed to strip wrappers from', filePath, error);
          }
        })
      );

      if (cleanedFiles.length) {
        const logLines = cleanedFiles
          .map(({ path, intro, outro }) => {
            const parts: string[] = [];
            if (intro) {
              const snippet = intro.replace(/\s+/g, ' ');
              parts.push(`[OUT] [OK] Removed intro chatter: ${snippet}`);
            }
            if (outro) {
              const snippet = outro.replace(/\s+/g, ' ');
              parts.push(`[OUT] [OK] Removed outro chatter: ${snippet}`);
            }
            if (!parts.length) {
              parts.push('[OUT] [OK] Removed intro/outro chatter.');
            }
            return parts.join('\n') + `\n[OUT] [OK] Cleaned file: ${path}`;
          })
          .concat(
            `[OUT] [OK] Quality scan cleaned ${cleanedFiles.length} file(s).`
          )
          .join('\n');
        try {
          await ipcRenderer.invoke('append-log', {
            mode,
            message: logLines
          });
          const updatedLogs = await ipcRenderer.invoke('read-logs', mode);
          setLogs(updatedLogs);
        } catch (error) {
          console.error(`Failed to write ${mode} log entry`, error);
        }

        const message =
          cleanedFiles.length === 1
            ? `Removed intro/outro chatter from ${cleanedFiles[0].name}`
            : `Removed intro/outro chatter from ${cleanedFiles.length} files`;
        setToast(message);
        setTimeout(() => setToast(null), 6000);
      }
    },
    [mode, audioTranscripts, imageTranscripts]
  );

  // Handler to scan placeholder percentages via Python script
  const scanQuality = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    setIsScanningQuality(true);
    try {
      const result: { all: ScanResultEntry[] } = await ipcRenderer.invoke(
        'scan-quality',
        dir,
        threshold
      );
      await cleanupWrappers(result.all, dir);
      const map = result.all.reduce<Record<string, QualityEntry>>((acc, entry) => {
        acc[entry.file] = {
          confidence: entry.confidence,
          removeIntroText: entry.remove_intro_text,
          removeOutroText: entry.remove_outro_text
        };
        return acc;
      }, {});
      setQualityScores(map);
    } catch (err) {
      console.error(err);
    } finally {
      setIsScanningQuality(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, threshold, cleanupWrappers]);

  // Clear previous quality scores when output folder or mode changes
  useEffect(() => {
    setQualityScores({});
  }, [mode, audioOutputDir, imageOutputDir]);

  // Sidebar drag/resizing
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const MIN = 160;
      const max = window.innerWidth - MIN;
      setSidebarWidth(Math.max(MIN, Math.min(e.clientX, max)));
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
      await ipcRenderer.invoke('delete-transcript', filePath);
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (!dir) return;
      const rawList: Transcript[] = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
      const sorted = sortTranscripts(rawList);
      if (mode === 'audio') {
        setAudioTranscripts(sorted);
      } else {
        setImageTranscripts(sorted);
      }
    },
    [mode, audioOutputDir, imageOutputDir]
  );

  const selectInput = useCallback(async () => {
    if (mode === 'audio') {
      const file = await ipcRenderer.invoke('select-input-file', mode);
      if (!file) return;
      setAudioInputPath(file);
    } else {
      const folder = await ipcRenderer.invoke('select-input-folder');
      if (!folder) return;
      setImageInputPath(folder);
    }
  }, [mode]);

  const selectOutput = useCallback(async () => {
    const dir = await ipcRenderer.invoke('select-output-dir');
    if (!dir) return;
    if (mode === 'audio') {
      setAudioOutputDir(dir);
      const rawList = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
      setAudioTranscripts(sortTranscripts(rawList));
    } else {
      setImageOutputDir(dir);
      const rawList = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
      setImageTranscripts(sortTranscripts(rawList));
    }
  }, [mode]);

  // ─── Transcribe Audio ─────────────────────────────────────────────────────
  const transcribeAudio = useCallback(
    async (interviewMode: boolean, generateSubtitles: boolean) => {
      if (!audioInputPath || !audioOutputDir) return;
      setStatus('');
      setIsTranscribing(true);

      // choose prompt based on flags
      let promptToUse = DEFAULT_AUDIO_PROMPT;
      if (generateSubtitles) {
        promptToUse = SUBTITLE_AUDIO_PROMPT;
      } else if (interviewMode) {
        promptToUse = INTERVIEW_AUDIO_PROMPT;
      }

      try {
        await ipcRenderer.invoke(
          'run-transcription',
          'audio',
          audioInputPath,
          audioOutputDir,
          promptToUse,
          generateSubtitles,
          interviewMode
        );
        setStatus('✅ Batch complete');
        setToast('✅ Done');
        setTimeout(() => setToast(null), 6000);
      } catch (err: any) {
        const cancelled = err.message?.includes('terminated');
        const msg = cancelled
          ? '❌ Cancelled by user'
          : `❌ ${err.message || 'Unknown error'}`;
        setStatus(msg);
        if (!cancelled) {
          setToast(msg);
          setTimeout(() => setToast(null), 6000);
        }
      } finally {
        setIsTranscribing(false);
      }
    },
    [audioInputPath, audioOutputDir]
  );

  const transcribeImage = useCallback(async () => {
    if (!imageInputPath || !imageOutputDir) return;
    setStatus('');
    setIsTranscribing(true);
    try {
      await ipcRenderer.invoke('run-transcription', 'image', imageInputPath, imageOutputDir);
      setStatus('✅ Batch complete');
      setToast('✅ Done');
      setTimeout(() => setToast(null), 6000);
    } catch (err: any) {
      const cancelled = err.message?.includes('terminated');
      const msg = cancelled
        ? '❌ Cancelled by user'
        : `❌ ${err.message || 'Unknown error'}`;
      setStatus(msg);
      if (!cancelled) {
        setToast(msg);
        setTimeout(() => setToast(null), 6000);
      }
    } finally {
      setIsTranscribing(false);
    }
  }, [imageInputPath, imageOutputDir]);

  const cancel = useCallback(async () => {
    await ipcRenderer.invoke('cancel-transcription');
    setStatus('❌ Cancelled by user');
    setIsTranscribing(false);
  }, []);

  const openTranscript = useCallback((p: string) => ipcRenderer.invoke('open-transcript', p), []);
  const clearLogs = useCallback(async () => {
    await ipcRenderer.invoke('clear-logs', mode);
    setLogs('');
  }, [mode]);

  const currentList = mode === 'audio' ? audioTranscripts : imageTranscripts;
  const nameFilter = filter.toLowerCase();
  const filtered = [...currentList]
    .filter(t => t.name.toLowerCase().includes(nameFilter))
    .filter(t => {
      if (fileTypeFilter === 'all') return true;
      const isSubtitle = t.name.toLowerCase().endsWith('.srt');
      return fileTypeFilter === 'subtitle' ? isSubtitle : !isSubtitle;
    })
    .sort((a, b) => {
      switch (sortOption) {
        case 'name-asc':
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        case 'name-desc':
          return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
        case 'confidence-asc': {
          const aScore = qualityScores[a.name]?.confidence ?? Number.POSITIVE_INFINITY;
          const bScore = qualityScores[b.name]?.confidence ?? Number.POSITIVE_INFINITY;
          if (aScore !== bScore) return aScore - bScore;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        case 'confidence-desc': {
          const aScore = qualityScores[a.name]?.confidence ?? Number.NEGATIVE_INFINITY;
          const bScore = qualityScores[b.name]?.confidence ?? Number.NEGATIVE_INFINITY;
          if (aScore !== bScore) return bScore - aScore;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        default:
          return 0;
      }
    });

  return (
    <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
      <FaCog className="settings-gear" onClick={() => ipcRenderer.invoke('open-settings')} />

      <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
        <div className="controls">
          <div className="field-row quality-scan-row">
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
                  // Prevent invalid chars: no e, +, -, .
                  if (['e','E','+','-','.'].includes(e.key)) e.preventDefault();
                }}
                onChange={e => {
                  // Strip leading zeros (unless single zero)
                  let raw = e.target.value;
                  raw = raw.replace(/^0+(?=\d)/, '');
                  let v = parseInt(raw, 10);
                  if (isNaN(v)) v = 0;
                  if (v < 0) v = 0;
                  if (v > 100) v = 100;
                  setThreshold(v);
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
            <InfoTooltip text="Enter the minimum acceptable confidence (0–100). Confidence is 100% when no [unsure]/[blank] markers are present, and 0% when all tokens are placeholders. Colors: green for ≥99%, yellow between the threshold and 99%, red below the threshold." />
          </div>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
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
                borderRadius: 12,
                padding: '1rem',
                boxShadow: '0 10px 20px rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <input
                className="filter-input"
                placeholder="Filter transcripts, subtitles…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                style={{ width: '100%' }}
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '0.75rem'
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.9rem' }}>
                  <span>Type</span>
                  <select
                    value={fileTypeFilter}
                    onChange={e => setFileTypeFilter(e.target.value as 'all' | 'transcript' | 'subtitle')}
                    style={{ width: '100%', padding: '0.45rem 0.6rem' }}
                  >
                    <option value="all">All files</option>
                    <option value="transcript">Transcripts (.txt)</option>
                    <option value="subtitle">Subtitles (.srt)</option>
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
              </div>
            </div>
          )}
        </div>
        <ul className="transcript-list">
          {filtered.map(t => (
            <li key={t.path} className="transcript-item">
              <span
                className="transcript-name"
                title={t.name}
                onDoubleClick={() => openTranscript(t.path)}
              >
                {t.name}
              </span>
              {qualityScores[t.name] && (() => {
                const entry = qualityScores[t.name];
                const confidence = entry.confidence;
                const color =
                  confidence < threshold ? 'red' : confidence >= 99 ? 'green' : 'yellow';
                const display = confidence
                  .toFixed(2)
                  .replace(/\.00$/, '')
                  .replace(/(\.\d)0$/, '$1');
                return (
                  <span style={{ marginLeft: '0.5rem', color }}>
                    {display}%
                  </span>
                );
              })()}
              <button
                className="transcript-delete"
                onClick={() => removeFile(t.path)}
                title="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-resizer" onMouseDown={onMouseDown} />
      </aside>

      <main className="content">
        <div className="logo">TranscribeAI</div>

        <div
          className={`mode-toggle ${mode}`}
          onClick={() => setMode(m => (m === 'audio' ? 'image' : 'audio'))}
        >
          <div className={mode === 'audio' ? 'label active' : 'label'}>Audio</div>
          <div className={mode === 'image' ? 'label active' : 'label'}>Image/Page</div>
          <div className="toggle-thumb" />
        </div>

        {mode === 'audio' ? (
          <AudioTranscriber
            inputPath={audioInputPath}
            outputDir={audioOutputDir}
            isTranscribing={isTranscribing}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onTranscribe={transcribeAudio}
            onCancel={cancel}
          />
        ) : (
          <ImageTranscriber
            inputPath={imageInputPath}
            outputDir={imageOutputDir}
            isTranscribing={isTranscribing}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onTranscribe={transcribeImage}
            onCancel={cancel}
          />
        )}

        {status && <div className="status-bar">{status}</div>}

        <div className="logs-controls">
          <button className="logs-toggle" onClick={() => setShowLogs(s => !s)}>
            {showLogs ? <FaChevronUp /> : <FaChevronDown />}{' '}
            {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>
          <button className="logs-clear" onClick={clearLogs}>
            Clear Logs
          </button>
        </div>
        {showLogs && <pre className="logs">{logs || '— no logs —'}</pre>}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
