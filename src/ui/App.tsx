// src/ui/App.tsx
import React, { useState, useRef, useEffect } from 'react';
import AudioTranscriber, { Transcript } from './components/AudioTranscriber';
import ImageTranscriber from './components/ImageTranscriber';
import { FaCog, FaChevronDown, FaChevronUp } from 'react-icons/fa';
import './App.css';

const { ipcRenderer } = (window as any).require('electron');

// ─── Model options ─────────────────────────────────────────────────────────────
const MODEL_OPTIONS = [
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.0-flash',
  'gemini-2.5-pro-preview-03-25',
];

// ─── Settings View ──────────────────────────────────────────────────────────────
function SettingsView() {
  const [key, setKey] = useState('');
  const [audioModel, setAudioModel] = useState(MODEL_OPTIONS[0]);
  const [imageModel, setImageModel] = useState(MODEL_OPTIONS[1]);

  useEffect(() => {
    ipcRenderer.invoke('get-api-key').then((k: string) => setKey(k || ''));
    ipcRenderer.invoke('get-audio-model').then((m: string) => setAudioModel(m));
    ipcRenderer.invoke('get-image-model').then((m: string) => setImageModel(m));
  }, []);

  const save = async () => {
    await ipcRenderer.invoke('set-api-key', key);
    await ipcRenderer.invoke('set-audio-model', audioModel);
    await ipcRenderer.invoke('set-image-model', imageModel);
    window.close();
  };

  return (
    <div className="settings-container">
      <h2>Settings</h2>

      <label htmlFor="api-key">Gemini API Key</label>
      <input
        id="api-key"
        type="password"
        value={key}
        placeholder="Enter your API key"
        onChange={e => setKey(e.target.value)}
      />

      <label htmlFor="audio-model">Audio Model</label>
      <select
        id="audio-model"
        value={audioModel}
        onChange={e => setAudioModel(e.target.value)}
      >
        {MODEL_OPTIONS.map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <label htmlFor="image-model">Image Model</label>
      <select
        id="image-model"
        value={imageModel}
        onChange={e => setImageModel(e.target.value)}
      >
        {MODEL_OPTIONS.map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>

      <div className="settings-buttons">
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

// ─── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  // If in settings route, show only SettingsView
  if (window.location.hash === '#/settings') {
    return <SettingsView />;
  }

  // ─ Sidebar resizing ─────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing]     = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // ─ Mode toggle ──────────────────────────────────────
  const [mode, setMode] = useState<'audio' | 'image'>('audio');

  // ─ Audio state ──────────────────────────────────────
  const [audioInputPath, setAudioInputPath]   = useState('');
  const [audioOutputDir, setAudioOutputDir]   = useState('');
  const [audioTranscripts, setAudioTranscripts] = useState<Transcript[]>([]);

  // ─ Image state ──────────────────────────────────────
  const [imageInputPath, setImageInputPath]     = useState('');
  const [imageOutputDir, setImageOutputDir]     = useState('');
  const [imageTranscripts, setImageTranscripts] = useState<Transcript[]>([]);

  // ─ Shared UI ────────────────────────────────────────
  const [filter, setFilter]       = useState('');
  const [logs, setLogs]           = useState('');
  const [status, setStatus]       = useState('');
  const [toast, setToast]         = useState<string | null>(null);
  const [showLogs, setShowLogs]   = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Load logs whenever mode changes
  useEffect(() => {
    ipcRenderer.invoke('read-logs', mode).then(setLogs);
  }, [mode]);

  // Handle progress events
  useEffect(() => {
    const handler = (_: any, file: string, idx: number, total: number, msg: string) => {
      setStatus(`Transcribing ${file} (${idx}/${total})`);
      // Reload only the new log text
      ipcRenderer.invoke('read-logs', mode).then(setLogs);
      // Refresh sidebar file list
      const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      if (dir) {
        ipcRenderer.invoke('list-transcripts', dir).then((list: Transcript[]) => {
          mode === 'audio'
            ? setAudioTranscripts(list)
            : setImageTranscripts(list);
        });
      }
    };
    ipcRenderer.on('transcription-progress', handler);
    return () => {
      ipcRenderer.removeListener('transcription-progress', handler);
    };
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

  // File pickers
  const selectInput = async () => {
    const file = await ipcRenderer.invoke('select-input-file', mode);
    if (!file) return;
    mode === 'audio'
      ? setAudioInputPath(file)
      : setImageInputPath(file);
  };
  const selectOutput = async () => {
    const dir = await ipcRenderer.invoke('select-output-dir');
    if (!dir) return;
    if (mode === 'audio') {
      setAudioOutputDir(dir);
      setAudioTranscripts(await ipcRenderer.invoke('list-transcripts', dir));
    } else {
      setImageOutputDir(dir);
      setImageTranscripts(await ipcRenderer.invoke('list-transcripts', dir));
    }
  };

  // Transcribe / Cancel
  const transcribe = async () => {
    const input  = mode === 'audio' ? audioInputPath : imageInputPath;
    const output = mode === 'audio' ? audioOutputDir   : imageOutputDir;
    if (!input || !output) return;

    // do *not* clear logs here—preserve existing!
    setStatus('');
    setIsTranscribing(true);

    try {
      await ipcRenderer.invoke('run-transcription', mode, input, output);
      setStatus('✅ Batch complete');
      setToast('✅ Done');
      setTimeout(() => setToast(null), 6000);
    } catch (err: any) {
      const cancelled = err.message.includes('terminated');
      const msg = cancelled
        ? '❌ Cancelled by user'
        : `❌ ${err.message}`;
      setStatus(msg);
      if (!cancelled) {
        setToast(msg);
        setTimeout(() => setToast(null), 6000);
      }
    } finally {
      setIsTranscribing(false);
    }
  };
  const cancel = async () => {
    await ipcRenderer.invoke('cancel-transcription');
    setStatus('❌ Cancelled by user');
    setIsTranscribing(false);
  };

  // Open / clear logs
  const openTranscript = (p: string) => ipcRenderer.invoke('open-transcript', p);
  const clearLogs     = async () => {
    await ipcRenderer.invoke('clear-logs', mode);
    setLogs('');
  };

  // Filter sidebar
  const currentList = mode === 'audio' ? audioTranscripts : imageTranscripts;
  const filtered = currentList.filter(t =>
    t.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
      <FaCog className="settings-gear" onClick={() => ipcRenderer.invoke('open-settings')} />

      <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
        <input
          className="filter-input"
          placeholder="Filter transcripts…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <ul className="transcript-list">
          {filtered.map(t => (
            <li key={t.path} title={t.name} onDoubleClick={() => openTranscript(t.path)}>
              {t.name}
            </li>
          ))}
        </ul>
        <div className="sidebar-resizer" onMouseDown={onMouseDown} />
      </aside>

      <main className="content">
        <div className="logo">TranscribeAI</div>

        <div className={`mode-toggle ${mode}`} onClick={() => setMode(m => m === 'audio' ? 'image' : 'audio')}>
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
            onTranscribe={transcribe}
            onCancel={cancel}
          />
        ) : (
          <ImageTranscriber
            inputPath={imageInputPath}
            outputDir={imageOutputDir}
            isTranscribing={isTranscribing}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onTranscribe={transcribe}
            onCancel={cancel}
          />
        )}

        {status && <div className="status-bar">{status}</div>}

        <div className="logs-controls">
          <button className="logs-toggle" onClick={() => setShowLogs(s => !s)}>
            {showLogs ? <FaChevronUp /> : <FaChevronDown />} {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>
          <button className="logs-clear" onClick={clearLogs}>Clear Logs</button>
        </div>
        {showLogs && <pre className="logs">{logs || '— no logs —'}</pre>}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}