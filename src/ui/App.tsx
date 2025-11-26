import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import AudioTranscriber, { Transcript } from './components/AudioTranscriber';
import ImageTranscriber from './components/ImageTranscriber';
import FolderPickerModal from './components/FolderPickerModal';
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
  FaSpinner,
  FaTrash,
  FaInfoCircle,
  FaSync,
} from 'react-icons/fa';
import './App.css';

const { ipcRenderer } = (window as any).require('electron');
const fs = (window as any).require('fs') as typeof import('fs');
const os = (window as any).require('os') as typeof import('os');
const pathModule = (window as any).require('path') as typeof import('path');

// ─── Model options ─────────────────────────────────────────────────────────────
const AUDIO_MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];

const IMAGE_MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'mistral-ocr-latest'
];

type QualityEntry = {
  confidence: number;
  removeIntroText?: string;
  removeOutroText?: string;
  issues?: string[];
  placeholderCount?: number;
  placeholderRatio?: number;
  tokenCount?: number;
  repetitionRatio?: number;
  markdownArtifacts?: string[];
};

type ScanResultEntry = {
  file: string;
  confidence: number;
  remove_intro_text?: string;
  remove_outro_text?: string;
  issues?: string[];
  placeholder_count?: number;
  placeholder_ratio?: number;
  token_count?: number;
  repetition_ratio?: number;
  markdown_artifacts?: string[];
};

type SortOption = 'name-asc' | 'name-desc' | 'confidence-desc' | 'confidence-asc';

type PathPickerTarget = {
  target: 'audio-input' | 'audio-output' | 'image-input' | 'image-output';
  allowFiles: boolean;
};

type SettingsProps = {
  currentVersion: string;
  latestVersion: string;
  checkingUpdate: boolean;
  updateError: string;
  onCheckLatest: () => void;
  onOpenUpdatePage: () => void;
  onOpenUpdateInstructions: () => void;
};

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

const stripMarkdownArtifacts = (content: string) => {
  if (!content) return '';
  const endsWithNewline = /\r?\n$/.test(content);
  let cleaned = content;
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/```([\s\S]*?)```/g, (_, inner) => {
    const trimmed = inner.trim();
    return trimmed ? `\n${trimmed}\n` : '\n';
  });
  cleaned = cleaned.replace(/~~~([\s\S]*?)~~~/g, (_, inner) => {
    const trimmed = inner.trim();
    return trimmed ? `\n${trimmed}\n` : '\n';
  });
  cleaned = cleaned.replace(/`([^`\n]+)`/g, '$1');
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  ['**', '__', '*', '_'].forEach(marker => {
    const escaped = marker.replace(/([.*+?^${}()|\[\]\\])/g, '\\$1');
    const pattern = new RegExp(`${escaped}([\\s\\S]*?)${escaped}`, 'g');
    cleaned = cleaned.replace(pattern, '$1');
  });
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  const trimmed = cleaned.trim();
  if (!trimmed) return '';
  return endsWithNewline ? `${trimmed}\n` : trimmed;
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
function SettingsView({
  currentVersion,
  latestVersion,
  checkingUpdate,
  updateError,
  onCheckLatest,
  onOpenUpdatePage,
  onOpenUpdateInstructions
}: SettingsProps) {
  const [key, setKey] = useState('');
  const [audioModel, setAudioModel] = useState(AUDIO_MODEL_OPTIONS[0]);
  const [imageModel, setImageModel] = useState(IMAGE_MODEL_OPTIONS[0]);
  const [mistralKey, setMistralKey] = useState('');
  const [audioPrompt, setAudioPrompt] = useState<string>(DEFAULT_AUDIO_PROMPT);
  const [imagePrompt, setImagePrompt] = useState<string>(DEFAULT_IMAGE_PROMPT);
  const [saved, setSaved] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [clearingTempFiles, setClearingTempFiles] = useState(false);
  const [tempFilesMessage, setTempFilesMessage] = useState('');

  useEffect(() => {
    ipcRenderer
      .invoke('get-api-key')
      .then((k: string) => setKey(k || localStorage.getItem('apiKey') || ''))
      .catch(() => setKey(localStorage.getItem('apiKey') || ''));

    ipcRenderer
      .invoke('get-audio-model')
        .then((m: string) =>
          setAudioModel(m || (localStorage.getItem('audioModel') || AUDIO_MODEL_OPTIONS[0]))
        )
      .catch(() =>
        setAudioModel((localStorage.getItem('audioModel') as string) || AUDIO_MODEL_OPTIONS[0])
      );

    ipcRenderer
      .invoke('get-image-model')
        .then((m: string) =>
          setImageModel(m || (localStorage.getItem('imageModel') || IMAGE_MODEL_OPTIONS[0]))
        )
      .catch(() =>
        setImageModel((localStorage.getItem('imageModel') as string) || IMAGE_MODEL_OPTIONS[0])
      );

    ipcRenderer
      .invoke('get-mistral-key')
      .then((val: string) => setMistralKey(val || localStorage.getItem('mistralKey') || ''))
      .catch(() => setMistralKey(localStorage.getItem('mistralKey') || ''));

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
      await ipcRenderer.invoke('set-mistral-key', mistralKey);
    } catch {
      localStorage.setItem('mistralKey', mistralKey);
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

  const clearTempFiles = async () => {
    setClearingTempFiles(true);
    setTempFilesMessage('');
    try {
      const result = await ipcRenderer.invoke('clear-temp-files');
      setTempFilesMessage(result.message);
      setTimeout(() => setTempFilesMessage(''), 3000);
    } catch (error: any) {
      setTempFilesMessage(`Error: ${error.message}`);
      setTimeout(() => setTempFilesMessage(''), 5000);
    } finally {
      setClearingTempFiles(false);
    }
  };
  const apiKeyFields = [
    {
      id: 'gemini',
      label: 'Gemini API Key',
      placeholder: 'Enter your API key',
      helper: 'Required for Gemini transcription and OCR models.',
      value: key,
      onChange: setKey
    },
    {
      id: 'mistral',
      label: 'Mistral API Key',
      placeholder: 'Only needed for Mistral OCR',
      helper: 'Required to use Mistral OCR.',
      value: mistralKey,
      onChange: setMistralKey
    }
  ];

  return (
    <div className="settings-container" style={{ position: 'relative' }}>
      <h2 style={{ flexShrink: 0 }}>Settings</h2>

      <div className="settings-scroll">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
            gap: '0.75rem',
            padding: '0.85rem 1rem',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontWeight: 600 }}>Software Updates</div>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-light)' }}>
              {checkingUpdate
                ? 'Checking for updates…'
                : latestVersion && currentVersion && latestVersion === currentVersion
                ? `You’re up to date on v${currentVersion}.`
                : latestVersion && currentVersion
                ? `New version v${latestVersion} available.`
                : currentVersion
                ? `Current v${currentVersion}`
                : 'Check for newer versions on GitHub releases.'}
            </div>
            {updateError && (
              <div style={{ color: '#ff8a80', fontSize: '0.85rem' }}>{updateError}</div>
            )}
            {latestVersion && currentVersion && latestVersion !== currentVersion && (
              <div style={{ color: '#6dd36d', fontSize: '0.9rem' }}>
                Download from the latest release to update.{' '}
                <a
                  href="#"
                  onClick={e => {
                    e.preventDefault();
                    onOpenUpdateInstructions();
                  }}
                  style={{ color: '#8dd3ff', textDecoration: 'underline' }}
                >
                  View instructions on our page.
                </a>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={onCheckLatest}
              disabled={checkingUpdate}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              title="Check GitHub for the latest release"
            >
              {checkingUpdate ? <FaSpinner className="spin" /> : 'Check'}
            </button>
            {latestVersion && currentVersion && latestVersion !== currentVersion && (
              <button
                className="btn save"
                onClick={onOpenUpdatePage}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  border: '2px solid #4caf50'
                }}
                title="Open the latest release page on GitHub"
              >
                New version available
              </button>
            )}
          </div>
        </div>

        <div className="settings-body">
          <div className="api-key-section">
            <button
              type="button"
              className="api-key-toggle"
              onClick={() => setShowApiKeys(prev => !prev)}
              aria-expanded={showApiKeys}
              aria-controls="api-keys-panel"
            >
              <div className="api-key-toggle-text">
                <span>Manage API Keys</span>
                <small>{showApiKeys ? 'Hide sensitive values' : 'Click to reveal & edit keys'}</small>
              </div>
              {showApiKeys ? <FaChevronUp /> : <FaChevronDown />}
            </button>
            {showApiKeys && (
              <div id="api-keys-panel" className="api-key-panel">
                <div className="api-key-list">
                  {apiKeyFields.map(field => (
                    <div key={field.id} className="api-key-item">
                      <label htmlFor={`${field.id}-api-key`}>{field.label}</label>
                      <input
                        id={`${field.id}-api-key`}
                        type="password"
                        value={field.value}
                        placeholder={field.placeholder}
                        onChange={e => field.onChange(e.target.value)}
                      />
                      {field.helper && <small className="api-key-helper">{field.helper}</small>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        <div
          className="model-prompt-row"
          style={{
            display: 'flex',
            gap: '2rem',
            flexWrap: 'wrap',
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
                {AUDIO_MODEL_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    {option}
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
                {IMAGE_MODEL_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    {option}
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

        {/* Clear Temp Files Section */}
        <div className="clear-temp-section" style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div>
              <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', fontWeight: '500' }}>Temporary Files</h3>
              <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.8 }}>Clear temporary image files created during processing</p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={clearTempFiles}
              disabled={clearingTempFiles}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: '#dc3545',
                border: 'none',
                color: 'white',
                padding: '0.5rem 1rem',
                borderRadius: '6px',
                fontSize: '0.875rem',
                cursor: clearingTempFiles ? 'not-allowed' : 'pointer',
                opacity: clearingTempFiles ? 0.6 : 1
              }}
            >
              {clearingTempFiles ? (
                <>
                  <FaSpinner className="spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <FaTrash />
                  Clear Temp Files
                </>
              )}
            </button>
          </div>
          {tempFilesMessage && (
            <div style={{
              marginTop: '0.5rem',
              padding: '0.5rem',
              borderRadius: '4px',
              fontSize: '0.875rem',
              backgroundColor: tempFilesMessage.includes('Error') ? 'rgba(220, 53, 69, 0.1)' : 'rgba(40, 167, 69, 0.1)',
              color: tempFilesMessage.includes('Error') ? '#dc3545' : '#28a745',
              border: `1px solid ${tempFilesMessage.includes('Error') ? 'rgba(220, 53, 69, 0.3)' : 'rgba(40, 167, 69, 0.3)'}`
            }}>
              {tempFilesMessage}
            </div>
          )}
        </div>
      </div> {/* end settings-body */}
      </div> {/* end settings-scroll */}

      {/* buttons + saved feedback */}
      <div className="settings-buttons" style={{ flexWrap: 'nowrap' }}>
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
  const isSettings = window.location.hash === '#/settings';

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
  const [imageModelName, setImageModelName] = useState<string>(
    localStorage.getItem('imageModel') || IMAGE_MODEL_OPTIONS[0]
  );
  const [imageInputPath, setImageInputPath] = useState('');
  const [imageOutputDir, setImageOutputDir] = useState('');
  const [imageTranscripts, setImageTranscripts] = useState<Transcript[]>([]);
  const [imageRecursive, setImageRecursive] = useState(false);
  const [imageBatchSize, setImageBatchSize] = useState<number>(50);
  const [imageBatchEnabled, setImageBatchEnabled] = useState(false);

  // Quality scan state
  const [threshold, setThreshold] = useState<number>(85);
  const [qualityScores, setQualityScores] = useState<Record<string, QualityEntry>>({});

  const [isScanningQuality, setIsScanningQuality] = useState(false);
  const [isRemediating, setIsRemediating] = useState(false);
  const [scanResults, setScanResults] = useState<ScanResultEntry[]>([]);

  // ─ Shared UI ───────────────────────────────────────
  const [filter, setFilter] = useState('');
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pathPicker, setPathPicker] = useState<PathPickerTarget | null>(null);
  const [fileTypeFilter, setFileTypeFilter] = useState<'all' | 'transcript' | 'subtitle'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'clean' | 'issues'>('all');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [showFilters, setShowFilters] = useState(false);
  const [folderFavorites, setFolderFavorites] = useState<string[]>([]);
  const favoritesLoadedRef = useRef(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const isMistralImageModel = useMemo(
    () => imageModelName.trim().toLowerCase().includes('mistral'),
    [imageModelName]
  );
  const imageInputIsDirectory = useMemo(() => {
    if (!imageInputPath) return false;
    try {
      return fs.statSync(imageInputPath).isDirectory();
    } catch {
      return false;
    }
  }, [imageInputPath]);

  const fetchCurrentVersion = useCallback(() => {
    ipcRenderer
      .invoke('get-app-version')
      .then((v: string) => setCurrentVersion((v || '').trim().replace(/^v/i, '')))
      .catch(() => setCurrentVersion(''));
  }, []);

  const fetchLatestVersion = useCallback(async () => {
    setCheckingUpdate(true);
    setUpdateError('');
    try {
      const res = await fetch('https://api.github.com/repos/Minitex/TranscribeAIUI/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error(`Update check failed (${res.status})`);
      const data = await res.json();
      const tag = (data?.tag_name || '').trim().replace(/^v/i, '');
      setLatestVersion(tag);
    } catch (err: any) {
      setUpdateError(err?.message || 'Could not check for updates.');
    } finally {
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
  if (!isMistralImageModel) {
      setImageRecursive(false);
      setImageBatchEnabled(false);
    } else if (imageInputIsDirectory) {
      setImageBatchEnabled(true);
    }
  }, [isMistralImageModel, imageInputIsDirectory]);

  useEffect(() => {
    if (!imageInputIsDirectory) {
      setImageRecursive(false);
      setImageBatchEnabled(false);
    } else if (isMistralImageModel) {
      setImageBatchEnabled(true);
    }
  }, [imageInputIsDirectory, isMistralImageModel]);

  useEffect(() => {
    let cancelled = false;
    const loadFavorites = async () => {
      const readLocal = () => {
        try {
          const saved = localStorage.getItem('folderFavorites');
          if (!saved) return [];
          const parsed = JSON.parse(saved);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      let hydrated = false;
      try {
        const stored: string[] = await ipcRenderer.invoke('get-folder-favorites');
        if (!cancelled && Array.isArray(stored)) {
          setFolderFavorites(stored);
          hydrated = true;
        }
      } catch {
        // fall back to local storage
      } finally {
        if (!cancelled) {
          if (!hydrated) {
            const fallback = readLocal();
            if (fallback.length) {
              setFolderFavorites(fallback);
            }
          }
          favoritesLoadedRef.current = true;
        }
      }
    };
    loadFavorites();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!favoritesLoadedRef.current) return;
    const persist = async () => {
      try {
        await ipcRenderer.invoke('set-folder-favorites', folderFavorites);
      } catch {
        // ignore store errors
      }
      try {
        localStorage.setItem('folderFavorites', JSON.stringify(folderFavorites));
      } catch {
        // ignore storage errors
      }
    };
    persist();
  }, [folderFavorites]);

  useEffect(() => {
    const loadImageModel = () => {
      ipcRenderer
        .invoke('get-image-model')
        .then((model: string) => {
          const next = model || localStorage.getItem('imageModel') || IMAGE_MODEL_OPTIONS[0];
          setImageModelName(next);
          if (next.toLowerCase().includes('mistral') && imageInputIsDirectory) {
            setImageBatchEnabled(true);
          }
        })
        .catch(() => {
          const fallback = localStorage.getItem('imageModel') || IMAGE_MODEL_OPTIONS[0];
          setImageModelName(fallback);
        });
    };

    loadImageModel();
    window.addEventListener('focus', loadImageModel);
    return () => window.removeEventListener('focus', loadImageModel);
  }, [imageInputIsDirectory]);

  // Load logs whenever mode changes
  useEffect(() => {
    ipcRenderer.invoke('read-logs', mode).then(setLogs);
  }, [mode]);

  // Auto-refresh logs and transcripts during transcription
  useEffect(() => {
    if (!isTranscribing) return;

    const refreshInterval = setInterval(async () => {
      try {
        // Refresh logs
        const logs = await ipcRenderer.invoke('read-logs', mode);
        setLogs(logs);

        // Refresh transcript list for image mode
        if (mode === 'image' && imageOutputDir) {
          const list = await ipcRenderer.invoke('list-transcripts-subtitles', imageOutputDir) as Transcript[];
          setImageTranscripts(sortTranscripts(list));
        }
        // Refresh transcript list for audio mode
        else if (mode === 'audio' && audioOutputDir) {
          const list = await ipcRenderer.invoke('list-transcripts-subtitles', audioOutputDir) as Transcript[];
          setAudioTranscripts(sortTranscripts(list));
        }
      } catch (error) {
        console.error('Error refreshing during transcription:', error);
      }
    }, 1000); // Refresh every second

    return () => clearInterval(refreshInterval);
  }, [isTranscribing, mode, imageOutputDir, audioOutputDir]);

  // Auto-scroll logs to bottom when content changes during transcription
  useEffect(() => {
    if (!isTranscribing || !logs) return;
    
    const scrollToBottom = () => {
      const logContainer = document.querySelector('.logs-body');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
        console.log('Auto-scrolled logs to bottom');
      } else {
        console.log('Could not find .logs-body element for auto-scroll');
      }
    };
    
    // Small delay to ensure DOM has updated
    setTimeout(scrollToBottom, 100);
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

  // Handle progress events
  useEffect(() => {
    const handler = (_: any, file: string, _idx: number, _total: number, _msg: string) => {
      setStatus(file);
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

  const refreshTranscriptList = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    
    try {
      const list: Transcript[] = await ipcRenderer.invoke('list-transcripts-subtitles', dir);
      const sorted = sortTranscripts(list);
      if (mode === 'audio') {
        setAudioTranscripts(sorted);
      } else {
        setImageTranscripts(sorted);
      }
    } catch (error) {
      console.error('Failed to refresh transcript list:', error);
    }
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
        markdownArtifacts?: string[];
      }> = [];
      await Promise.all(
        entries.map(async entry => {
          const intro = entry.remove_intro_text;
          const outro = entry.remove_outro_text;
          const hasMarkdown = Boolean(entry.markdown_artifacts && entry.markdown_artifacts.length);
          if (!intro && !outro && !hasMarkdown) return;
          const filePath = lookup.get(entry.file);
          if (!filePath) return;

          try {
            const original = await fs.promises.readFile(filePath, 'utf-8');
            let cleaned = removeWrappersFromContent(original, intro, outro);
            if (hasMarkdown) {
              cleaned = stripMarkdownArtifacts(cleaned);
            }
            if (cleaned === original) return;
            await fs.promises.writeFile(filePath, cleaned, 'utf-8');
            cleanedFiles.push({
              name: entry.file,
              path: filePath,
              intro: intro?.trim(),
              outro: outro?.trim(),
              markdownArtifacts: hasMarkdown ? entry.markdown_artifacts : undefined
            });
          } catch (error) {
            console.error('Failed to strip wrappers from', filePath, error);
          }
        })
      );

      if (cleanedFiles.length) {
        const logLines = cleanedFiles
          .map(({ path, intro, outro, markdownArtifacts }) => {
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
          const updatedLogs = await ipcRenderer.invoke('read-logs', mode);
          setLogs(updatedLogs);
        } catch (error) {
          console.error(`Failed to write ${mode} log entry`, error);
        }

        const message =
          cleanedFiles.length === 1
            ? `Remediated ${cleanedFiles[0].name}`
            : `Remediated ${cleanedFiles.length} files`;
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
      const entries = result?.all ?? [];
      setScanResults(entries);
      const map = entries.reduce<Record<string, QualityEntry>>((acc, entry) => {
        acc[entry.file] = {
          confidence: entry.confidence,
          removeIntroText: entry.remove_intro_text,
          removeOutroText: entry.remove_outro_text,
          issues: entry.issues,
          placeholderCount: entry.placeholder_count,
          placeholderRatio: entry.placeholder_ratio,
          tokenCount: entry.token_count,
          repetitionRatio: entry.repetition_ratio,
          markdownArtifacts: entry.markdown_artifacts
        };
        return acc;
      }, {});
      setQualityScores(map);
    } catch (err) {
      console.error(err);
      setScanResults([]);
    } finally {
      setIsScanningQuality(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, threshold]);

  const remediateDocuments = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    const actionable = scanResults.filter(
      entry =>
        entry.remove_intro_text ||
        entry.remove_outro_text ||
        (entry.markdown_artifacts && entry.markdown_artifacts.length)
    );
    if (!actionable.length) return;
    setIsRemediating(true);
    try {
      await cleanupWrappers(actionable, dir);
      const remediationMap = new Map(
        actionable.map(entry => [
          entry.file,
          {
            clearIntro: Boolean(entry.remove_intro_text),
            clearOutro: Boolean(entry.remove_outro_text),
            clearMarkdown: Boolean(entry.markdown_artifacts && entry.markdown_artifacts.length)
          }
        ])
      );
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
          if (entry.issues && entry.issues.length) {
            next.issues = entry.issues.filter(issue => {
              const lowered = issue.toLowerCase();
              if (actions.clearIntro && lowered.startsWith('intro chatter')) return false;
              if (actions.clearOutro && lowered.startsWith('outro chatter')) return false;
              if (actions.clearMarkdown && lowered.includes('markdown')) return false;
              return true;
            });
            if (next.issues && !next.issues.length) {
              next.issues = undefined;
            }
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
          if (entry.issues && entry.issues.length) {
            updated.issues = entry.issues.filter(issue => {
              const lowered = issue.toLowerCase();
              if (actions.clearIntro && lowered.startsWith('intro chatter')) return false;
              if (actions.clearOutro && lowered.startsWith('outro chatter')) return false;
              if (actions.clearMarkdown && lowered.includes('markdown')) return false;
              return true;
            });
            if (updated.issues && !updated.issues.length) {
              updated.issues = undefined;
            }
          }
          next[file] = updated;
        });
        return next;
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsRemediating(false);
    }
  }, [mode, audioOutputDir, imageOutputDir, scanResults, cleanupWrappers]);

  // Clear previous quality scores when output folder or mode changes
  useEffect(() => {
    setQualityScores({});
    setScanResults([]);
  }, [mode, audioOutputDir, imageOutputDir]);

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

  const canRemediate = useMemo(
    () =>
      scanResults.some(
        entry =>
          entry.remove_intro_text ||
          entry.remove_outro_text ||
          (entry.markdown_artifacts && entry.markdown_artifacts.length)
      ),
    [scanResults]
  );

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
      const fileName = pathModule.basename(filePath);
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

  const toggleLogs = useCallback(() => {
    setShowLogs(s => !s);
  }, []);

  const handlePathPickerSelect = useCallback(
    async (selection: { path: string; isDirectory: boolean }) => {
      if (!pathPicker) return;
      switch (pathPicker.target) {
        case 'audio-input':
          setAudioInputPath(selection.path);
          break;
        case 'image-input':
          if (!selection.isDirectory) return;
          setImageInputPath(selection.path);
          break;
        case 'audio-output':
          if (!selection.isDirectory) return;
          await applyOutputSelection(selection.path, 'audio');
          break;
        case 'image-output':
          if (!selection.isDirectory) return;
          await applyOutputSelection(selection.path, 'image');
          break;
        default:
          break;
      }
      setPathPicker(null);
    },
    [applyOutputSelection, pathPicker]
  );

  const closePathPicker = useCallback(() => setPathPicker(null), []);

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

    if (imageBatchEnabled && !imageInputIsDirectory) {
      const msg = 'Batch processing requires selecting a folder.';
      setStatus(`❌ ${msg}`);
      setToast(`❌ ${msg}`);
      setTimeout(() => setToast(null), 6000);
      return;
    }

    setStatus('');
    setIsTranscribing(true);
    try {
      await ipcRenderer.invoke(
        'run-transcription',
        'image',
        imageInputPath,
        imageOutputDir,
        '',
        false,
        false,
        { recursive: false, batch: imageBatchEnabled, batchSize: imageBatchSize }
      );
      
      // Force refresh the transcript list and logs after batch completion
      if (imageOutputDir) {
        const list = await ipcRenderer.invoke('list-transcripts-subtitles', imageOutputDir) as Transcript[];
        setImageTranscripts(sortTranscripts(list));
      }
      const logs = await ipcRenderer.invoke('read-logs', 'image');
      setLogs(logs);
      
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
  }, [
    imageInputPath,
    imageOutputDir,
    imageBatchEnabled,
    imageBatchSize,
    imageRecursive,
    imageInputIsDirectory
  ]);

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
    .filter(t => {
      if (issueFilter === 'all') return true;
      const entry = qualityScores[t.name];
      if (!entry) return false;
      const hasIssues = Boolean(entry.issues && entry.issues.length);
      return issueFilter === 'issues' ? hasIssues : !hasIssues;
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

  return (
    <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
      <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 20 }}>
        <FaCog className="settings-gear" onClick={() => ipcRenderer.invoke('open-settings')} />
        {newVersionAvailable && (
          <span
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              background: '#ff4d4f',
              color: '#fff',
              width: 16,
              height: 16,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 700,
              boxShadow: '0 0 0 2px rgba(0,0,0,0.35)'
            }}
            aria-label="New version available"
            title="New version available"
          >
            1
          </span>
        )}
      </div>

      <aside className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
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
          gap: '0.5rem'
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
              borderRadius: '6px',
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
        </div>
        
        <ul className="transcript-list">
          {filtered.map(t => {
            const entry = qualityScores[t.name];
            const issues = entry?.issues;
            const issueSummary = issues?.length ? `• ${issues.join('\n• ')}` : null;
            let confidenceNode: React.ReactNode = null;
            if (entry) {
              const confidence = entry.confidence;
              const color =
                confidence < threshold ? 'red' : confidence >= 99 ? 'green' : 'yellow';
              const display = confidence
                .toFixed(2)
                .replace(/\.00$/, '')
                .replace(/(\.\d)0$/, '$1');
              confidenceNode = (
                <span className="transcript-score" style={{ color }} title={`Confidence ${display}%`}>
                  {display}%
                </span>
              );
            }
            return (
              <li key={t.path} className="transcript-item">
                <div className="transcript-main">
                  {issueSummary && (
                    <span
                      className="issue-dot"
                      aria-label={issueSummary}
                      title={issueSummary}
                    />
                  )}
                  <span
                    className="transcript-name"
                    title={t.name}
                    onDoubleClick={() => openTranscript(t.path)}
                  >
                    {t.name}
                  </span>
                  {confidenceNode}
                </div>
                <button
                  className="transcript-delete"
                  onClick={() => removeFile(t.path)}
                  title="Remove"
                >
                  ×
                </button>
              </li>
            );
          })}
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
            mistralMode={isMistralImageModel}
            recursive={false}
            batchEnabled={imageBatchEnabled}
            batchSize={imageBatchSize}
            inputIsDirectory={imageInputIsDirectory}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onToggleRecursive={() => setImageRecursive(v => !v)}
            onToggleBatch={() => setImageBatchEnabled(v => !v)}
            onBatchSizeChange={(size: number) => setImageBatchSize(size)}
            onTranscribe={transcribeImage}
            onCancel={cancel}
          />
        )}

        {status && <div className="status-bar">{status}</div>}

        <section className={`logs-panel ${showLogs ? 'open' : 'collapsed'}`}>
          <div
            className="logs-header"
            role="button"
            tabIndex={0}
            aria-expanded={showLogs}
            onClick={toggleLogs}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleLogs();
              }
            }}
          >
            <div className="logs-title-group">
              <h3>Activity Logs</h3>
              <span className="logs-hint" aria-label="Activity log details">
                <FaInfoCircle />
                <span className="logs-hint-text">
                  Monitor recent transcription events and quality cleanups.
                </span>
              </span>
            </div>
            <div className="logs-actions">
              <span
                className="logs-indicator"
                aria-label={showLogs ? 'Hide logs' : 'Show logs'}
              >
                {showLogs ? <FaChevronUp /> : <FaChevronDown />}
              </span>
              <button
                className="logs-clear"
                onClick={e => {
                  e.stopPropagation();
                  clearLogs();
                }}
                title="Clear logs"
                aria-label="Clear logs"
              >
                <FaTrash />
              </button>
            </div>
          </div>
          {showLogs && <pre className="logs-body">{logs || '— no logs —'}</pre>}
        </section>
      </main>

      {toast && <div className="toast">{toast}</div>}

      {pathPicker && (
        <FolderPickerModal
          isOpen
          title={
            {
              'audio-input': 'Select Audio Input',
              'audio-output': 'Select Audio Output Folder',
              'image-input': 'Select Image Input',
              'image-output': 'Select Image Output Folder'
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
    </div>
  );
}
