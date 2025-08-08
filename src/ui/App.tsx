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

// ─── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

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
  const [threshold, setThreshold] = useState<number>(15);
  const [qualityScores, setQualityScores] = useState<Record<string, { percentage: number }>>({});

  const [isScanningQuality, setIsScanningQuality] = useState(false);

  // ─ Shared UI ───────────────────────────────────────
  const [filter, setFilter] = useState('');
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

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

  // Handler to scan placeholder percentages via Python script
  const scanQuality = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    setIsScanningQuality(true);
    try {
      const result: { all: Array<{ file: string; percentage: number }> } =
        await ipcRenderer.invoke('scan-quality', dir, threshold);
      const map = result.all.reduce<Record<string, { percentage: number }>>((acc, entry) => {
        acc[entry.file] = entry;
        return acc;
      }, {});
      setQualityScores(map);
    } catch (err) {
      console.error(err);
    } finally {
      setIsScanningQuality(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, threshold]);

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
  const filtered = currentList.filter(t =>
    t.name.toLowerCase().includes(filter.toLowerCase())
  );

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
                max={99}
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
                  if (v > 99) v = 99;
                  setThreshold(v);
                }}
                title="Minimum placeholder percentage to highlight"
                style={{ paddingRight: '1.5ch' }}
              />
              <span style={{ position: 'absolute', right: '0.5ch', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-light)' }}>%</span>
            </div>
            <button
              className="scan-btn btn"
              onClick={scanQuality}
              disabled={isScanningQuality || !(audioOutputDir || imageOutputDir)}
              aria-label="Scan transcripts for placeholder quality"
            >
              {isScanningQuality ? <FaSpinner className="spin" /> : 'Check Quality'}
            </button>
            <InfoTooltip text="Enter a minimum placeholder percentage (0–99) to highlight. The scan calculates the ratio of [unsure] and [blank] tokens in each files. Color codes: green = 0%, yellow = below the threshold, red = at or above the threshold." />
          </div>
        </div>
        <input
          className="filter-input"
          placeholder="Filter transcripts, subtitles…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
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
                const pct = qualityScores[t.name].percentage;
                const color = pct === 0 ? 'green' : pct >= threshold ? 'red' : 'yellow';
                return (
                  <span style={{ marginLeft: '0.5rem', color }}>
                    {pct}%
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
