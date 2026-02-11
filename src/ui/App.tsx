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
  FaDownload,
  FaCopy,
} from 'react-icons/fa';
import './App.css';

const { ipcRenderer } = (window as any).require('electron');
const fs = (window as any).require('fs') as typeof import('fs');
const os = (window as any).require('os') as typeof import('os');
const pathModule = (window as any).require('path') as typeof import('path');

const AUDIO_MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'voxtral-mini-latest'
];

const IMAGE_MODEL_OPTIONS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'mistral-ocr-latest'
];

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.pdf'];

type QualityEntry = {
  confidence: number;
  blankTranscript?: boolean;
  nonWhitespaceChars?: number;
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
  blank_transcript?: boolean;
  non_whitespace_chars?: number;
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
  target: 'audio-input' | 'audio-output' | 'image-input' | 'image-output' | 'copy-images';
  allowFiles: boolean;
};

type MistralBatchStats = {
  inputPath: string;
  uploaded: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
};

type MistralBatchQueueRow = MistralBatchStats & {
  outputDir: string;
  modelName: string;
  oldestPendingStartMs: number | null;
  checkBackAtMs: number | null;
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
      placeholder: 'Required for Mistral OCR and Voxtral audio',
      helper: 'Required to use Mistral OCR and Voxtral audio transcription.',
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
              <div className="model-select">
                <select
                  id="audio-model"
                  className="model-select-input"
                  value={audioModel}
                  onChange={e => setAudioModel(e.target.value)}
                >
                  {AUDIO_MODEL_OPTIONS.map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <FaChevronDown className="model-select-caret" aria-hidden="true" />
              </div>
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
              <div className="model-select">
                <select
                  id="image-model"
                  className="model-select-input"
                  value={imageModel}
                  onChange={e => setImageModel(e.target.value)}
                >
                  {IMAGE_MODEL_OPTIONS.map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <FaChevronDown className="model-select-caret" aria-hidden="true" />
              </div>
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

function sortTranscripts(list: Transcript[]): Transcript[] {
  return [...list].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

function resolveImageForTranscript(transcriptName: string, imageInputPath: string): string | null {
  if (!imageInputPath) return null;
  let baseDir = imageInputPath;
  try {
    if (fs.statSync(imageInputPath).isFile()) {
      baseDir = pathModule.dirname(imageInputPath);
    }
  } catch {
    return null;
  }
  const nameNoExt = transcriptName.replace(/\.(txt|srt)$/i, '');
  const directCandidate = pathModule.join(baseDir, nameNoExt);
  if (fs.existsSync(directCandidate)) return directCandidate;
  for (const ext of IMAGE_EXTS) {
    const candidate = pathModule.join(baseDir, `${nameNoExt}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureUniquePath(destDir: string, baseName: string): string {
  const ext = pathModule.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let candidate = pathModule.join(destDir, baseName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    const nextName = `${stem}_${counter}${ext}`;
    candidate = pathModule.join(destDir, nextName);
    counter += 1;
  }
  return candidate;
}

function BatchQueueView() {
  const [rows, setRows] = useState<MistralBatchQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');

  const loadRows = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const queue = await ipcRenderer.invoke('get-mistral-batch-queue') as MistralBatchQueueRow[];
      setRows(Array.isArray(queue) ? queue : []);
      setError('');
    } catch (err: any) {
      setRows([]);
      setError(err?.message || 'Failed to load batch queue.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows(true);
    const onFocus = () => {
      void loadRows(false);
    };
    const intervalId = window.setInterval(() => {
      void loadRows(false);
    }, 5000);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadRows]);

  const selectFolder = useCallback(
    async (row: MistralBatchQueueRow) => {
      const key = `${row.inputPath}::${row.outputDir}`;
      setSelectedKey(key);
      setError('');
      try {
        const result = await ipcRenderer.invoke('select-mistral-batch-folder', {
          inputPath: row.inputPath,
          outputDir: row.outputDir
        }) as { ok?: boolean; error?: string };
        if (!result?.ok) {
          setError(result?.error || 'Failed to select queue item.');
          return;
        }
        window.close();
      } catch (err: any) {
        setError(err?.message || 'Failed to select queue item.');
      } finally {
        setSelectedKey('');
      }
    },
    []
  );

  const formatTime = (timestampMs: number | null) => {
    if (!timestampMs) return '—';
    return new Date(timestampMs).toLocaleString();
  };

  const summary = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.uploaded += row.uploaded;
        acc.processing += row.processing;
        acc.completed += row.completed;
        acc.failed += row.failed;
        return acc;
      },
      { uploaded: 0, processing: 0, completed: 0, failed: 0 }
    );
  }, [rows]);

  return (
    <div className="settings-container batch-queue-page">
      <h2 className="batch-queue-title">Mistral Batch Queue</h2>
      <div className="settings-scroll">
        {!!rows.length && (
          <div className="batch-queue-summary">
            <div className="batch-queue-summary-card">
              <span>Collections</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Uploaded</span>
              <strong>{summary.uploaded}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Processing</span>
              <strong>{summary.processing}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Completed</span>
              <strong>{summary.completed}</strong>
            </div>
          </div>
        )}

        {error && <div className="batch-queue-error">{error}</div>}

        {!rows.length && !loading && (
          <div className="batch-queue-empty">
            No saved batch folders.
          </div>
        )}

        <div className="batch-queue-list">
          {rows.map(row => {
            const key = `${row.inputPath}::${row.outputDir}`;
            const selecting = selectedKey === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => selectFolder(row)}
                disabled={selecting}
                className="batch-queue-item"
                title="Load this folder pair in Image mode"
              >
                <div className="batch-queue-item-top">
                  <span className="batch-queue-model">{row.modelName}</span>
                  <span className="batch-queue-open-hint">
                    {selecting ? 'Opening…' : 'Click to open'}
                  </span>
                </div>
                <div className="batch-queue-path-row">
                  <span>Input</span>
                  <code>{row.inputPath}</code>
                </div>
                <div className="batch-queue-path-row">
                  <span>Output</span>
                  <code>{row.outputDir}</code>
                </div>
                <div className="batch-queue-pill-row">
                  <span className="batch-queue-pill uploaded">{`Uploaded ${row.uploaded}`}</span>
                  <span className="batch-queue-pill processing">{`Processing ${row.processing}`}</span>
                  <span className="batch-queue-pill completed">{`Completed ${row.completed}`}</span>
                  {row.failed > 0 && <span className="batch-queue-pill failed">{`Failed ${row.failed}`}</span>}
                </div>
                <div className="batch-queue-times">
                  <div>
                    <span>Oldest start</span>
                    <strong>{formatTime(row.oldestPendingStartMs)}</strong>
                  </div>
                  <div>
                    <span>Check back</span>
                    <strong>{formatTime(row.checkBackAtMs)}</strong>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {!!rows.length && summary.failed > 0 && (
          <div className="batch-queue-footnote">
            Failed jobs remain in the queue until retried or cleared from temp files.
          </div>
        )}
      </div>
      <div className="settings-buttons batch-queue-actions">
        <div className="batch-queue-help-tooltip">
          <button
            type="button"
            className="batch-queue-help-trigger"
            aria-label="Why are my batches taking so long to process?"
          >
            <FaInfoCircle size={13} />
            <span>Why are my batches taking so long to process?</span>
          </button>
          <div className="batch-queue-help-box" role="tooltip">
            Batch processing is designed for non-urgent work and runs when servers have spare capacity. Batches typically complete in around 2 hours, but can take up to 24 hours. In the meantime, you can work on another image collection and check back later.
          </div>
        </div>
        <button className="btn cancel" onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const isSettings = window.location.hash === '#/settings';
  const isBatchQueue = window.location.hash === '#/batch-queue';

  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<'audio' | 'image'>('audio');

  const [audioInputPath, setAudioInputPath] = useState('');
  const [audioOutputDir, setAudioOutputDir] = useState('');
  const [audioTranscripts, setAudioTranscripts] = useState<Transcript[]>([]);

  const [imageModelName, setImageModelName] = useState<string>(
    localStorage.getItem('imageModel') || IMAGE_MODEL_OPTIONS[0]
  );
  const [imageInputPath, setImageInputPath] = useState('');
  const [imageOutputDir, setImageOutputDir] = useState('');
  const [imageTranscripts, setImageTranscripts] = useState<Transcript[]>([]);
  const [imageRecursive, setImageRecursive] = useState(false);
  const [imageBatchSize, setImageBatchSize] = useState<number>(50);
  const [imageBatchEnabled, setImageBatchEnabled] = useState(false);
  const [mistralBatchStats, setMistralBatchStats] = useState<MistralBatchStats | null>(null);
  const [mistralQueueCollectionCount, setMistralQueueCollectionCount] = useState(0);

  const [threshold, setThreshold] = useState<number>(85);
  const [qualityScores, setQualityScores] = useState<Record<string, QualityEntry>>({});

  const [isScanningQuality, setIsScanningQuality] = useState(false);
  const [isRemediating, setIsRemediating] = useState(false);
  const [scanResults, setScanResults] = useState<ScanResultEntry[]>([]);

  const [filter, setFilter] = useState('');
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    transcript: Transcript;
  } | null>(null);
  const [pathPicker, setPathPicker] = useState<PathPickerTarget | null>(null);
  const [fileTypeFilter, setFileTypeFilter] = useState<'all' | 'transcript' | 'subtitle'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'clean' | 'issues'>('all');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [showFilters, setShowFilters] = useState(false);
  const [folderFavorites, setFolderFavorites] = useState<string[]>([]);
  const favoritesLoadedRef = useRef(false);
  const pathsLoadedRef = useRef(false);
  const modeLoadedRef = useRef(false);
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
  const refreshMistralBatchStats = useCallback(async () => {
    if (!imageInputPath || !imageInputIsDirectory || !isMistralImageModel) {
      setMistralBatchStats(null);
      return;
    }
    try {
      const stats = await ipcRenderer.invoke('get-mistral-batch-stats', {
        inputPath: imageInputPath,
        outputDir: imageOutputDir || undefined,
        modelName: imageModelName
      }) as MistralBatchStats;
      setMistralBatchStats(stats);
    } catch {
      setMistralBatchStats(null);
    }
  }, [imageInputPath, imageInputIsDirectory, imageOutputDir, imageModelName, isMistralImageModel]);
  const refreshMistralQueueCollectionCount = useCallback(async () => {
    try {
      const rows = await ipcRenderer.invoke('get-mistral-batch-queue') as MistralBatchQueueRow[];
      setMistralQueueCollectionCount(Array.isArray(rows) ? rows.length : 0);
    } catch {
      setMistralQueueCollectionCount(0);
    }
  }, []);

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
    refreshMistralBatchStats();
  }, [refreshMistralBatchStats]);

  useEffect(() => {
    refreshMistralQueueCollectionCount();
    window.addEventListener('focus', refreshMistralQueueCollectionCount);
    return () => window.removeEventListener('focus', refreshMistralQueueCollectionCount);
  }, [refreshMistralQueueCollectionCount]);

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
    const readLocal = () => {
      try {
        return (localStorage.getItem('activeMode') as 'audio' | 'image' | null) || '';
      } catch {
        return '';
      }
    };
    const setIfValid = (value: unknown) => {
      if (cancelled) return;
      if (value === 'audio' || value === 'image') {
        setMode(value);
        return;
      }
      const fallback = readLocal();
      if (fallback === 'audio' || fallback === 'image') {
        setMode(fallback);
      }
    };
    const loadMode = async () => {
      try {
        const stored = await ipcRenderer.invoke('get-active-mode');
        setIfValid(stored);
      } catch {
        setIfValid(undefined);
      } finally {
        if (!cancelled) {
          modeLoadedRef.current = true;
        }
      }
    };
    loadMode();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!modeLoadedRef.current) return;
    const persist = async () => {
      try {
        await ipcRenderer.invoke('set-active-mode', mode);
      } catch {
      }
      try {
        localStorage.setItem('activeMode', mode);
      } catch {
      }
    };
    persist();
  }, [mode]);

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
          setAudioInputPath(resolveValue(audioInput, 'audioInputPath'));
          setAudioOutputDir(resolveValue(audioOutput, 'audioOutputDir'));
          setImageInputPath(resolveValue(imageInput, 'imageInputPath'));
          setImageOutputDir(resolveValue(imageOutput, 'imageOutputDir'));
          hydrated = true;
        }
      } catch {
      } finally {
        if (!cancelled) {
          if (!hydrated) {
            setAudioInputPath(readLocal('audioInputPath'));
            setAudioOutputDir(readLocal('audioOutputDir'));
            setImageInputPath(readLocal('imageInputPath'));
            setImageOutputDir(readLocal('imageOutputDir'));
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
      try {
        await ipcRenderer.invoke('set-audio-input-path', audioInputPath);
      } catch {
      }
      try {
        await ipcRenderer.invoke('set-audio-output-dir', audioOutputDir);
      } catch {
      }
      try {
        await ipcRenderer.invoke('set-image-input-path', imageInputPath);
      } catch {
      }
      try {
        await ipcRenderer.invoke('set-image-output-dir', imageOutputDir);
      } catch {
      }
      try {
        localStorage.setItem('audioInputPath', audioInputPath);
        localStorage.setItem('audioOutputDir', audioOutputDir);
        localStorage.setItem('imageInputPath', imageInputPath);
        localStorage.setItem('imageOutputDir', imageOutputDir);
      } catch {
      }
    };
    persist();
  }, [audioInputPath, audioOutputDir, imageInputPath, imageOutputDir]);

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
      }
      try {
        localStorage.setItem('folderFavorites', JSON.stringify(folderFavorites));
      } catch {
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

  useEffect(() => {
    ipcRenderer.invoke('read-logs', mode).then(setLogs);
  }, [mode]);

  useEffect(() => {
    if (!isTranscribing) return;

    const refreshInterval = setInterval(async () => {
      try {
        const logs = await ipcRenderer.invoke('read-logs', mode);
        setLogs(logs);

        if (mode === 'image' && imageOutputDir) {
          const list = await ipcRenderer.invoke('list-transcripts-subtitles', imageOutputDir) as Transcript[];
          setImageTranscripts(sortTranscripts(list));
        }
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
    const handler = (_: any, file: string, _idx: number, _total: number, msg: string) => {
      const label = (file || '').trim();
      const detail = (msg || '').trim();
      setStatus(label && detail ? `${label} | ${detail}` : (label || detail));
      if (mode === 'image') {
        refreshMistralBatchStats();
        refreshMistralQueueCollectionCount();
      }
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
  }, [mode, audioOutputDir, imageOutputDir, refreshMistralBatchStats, refreshMistralQueueCollectionCount]);

  useEffect(() => {
    const handler = async (_: any, nextInputPath: string, nextOutputDir: string) => {
      if (typeof nextInputPath === 'string') {
        setImageInputPath(nextInputPath);
      }
      if (typeof nextOutputDir === 'string') {
        setImageOutputDir(nextOutputDir);
        try {
          const list = await ipcRenderer.invoke('list-transcripts-subtitles', nextOutputDir) as Transcript[];
          setImageTranscripts(sortTranscripts(list));
        } catch {
          setImageTranscripts([]);
        }
      }
      setMode('image');
      setStatus(`Loaded queue folder ${pathModule.basename(nextInputPath || '')}`);
      refreshMistralQueueCollectionCount();
    };
    ipcRenderer.on('mistral-batch-folder-selected', handler);
    return () => {
      ipcRenderer.removeListener('mistral-batch-folder-selected', handler);
    };
  }, [refreshMistralQueueCollectionCount]);

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

  const scanQuality = useCallback(async () => {
    const dir = mode === 'audio' ? audioOutputDir : imageOutputDir;
    if (!dir) return;
    setIsScanningQuality(true);
    setStatus('ℹ️ Checking quality...');
    const progressHandler = (
      _: any,
      payload: {
        processed?: number;
        total?: number;
        percent?: number;
        file?: string;
        blankCount?: number;
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
    };
    ipcRenderer.on('quality-scan-progress', progressHandler);
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
          blankTranscript: Boolean(entry.blank_transcript),
          nonWhitespaceChars: typeof entry.non_whitespace_chars === 'number' ? entry.non_whitespace_chars : undefined,
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

  const clearTranscriptWarnings = useCallback((name: string) => {
    setQualityScores(prev => {
      const entry = prev[name];
      if (!entry || !entry.issues || !entry.issues.length) return prev;
      return { ...prev, [name]: { ...entry, issues: undefined } };
    });
    setScanResults(prev =>
      prev.map(entry => (entry.file === name ? { ...entry, issues: undefined } : entry))
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
      scanResults.some(
        entry =>
          entry.remove_intro_text ||
          entry.remove_outro_text ||
          (entry.markdown_artifacts && entry.markdown_artifacts.length)
      ),
    [scanResults]
  );

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

  const openBatchQueueWindow = useCallback(() => {
    ipcRenderer.invoke('open-batch-queue');
  }, []);

  const toggleLogs = useCallback(() => {
    setShowLogs(s => !s);
  }, []);

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

  const copyImagesToDestination = useCallback(
    async (destDir: string) => {
      try {
        const sourcePaths = filtered.map(item => item.path);
        if (!sourcePaths.length) {
          setToast('No files found for the current list.');
          setTimeout(() => setToast(null), 6000);
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
        setToast(parts.join(' • '));
        setTimeout(() => setToast(null), 6000);
      } catch (error: any) {
        setToast(`❌ Copy failed: ${error?.message || error}`);
        setTimeout(() => setToast(null), 6000);
      }
    },
    [filtered, imageInputPath]
  );

  const copyImagesToFolder = useCallback(() => {
    if (!filtered.length) {
      setToast('No files to copy');
      setTimeout(() => setToast(null), 6000);
      return;
    }
    setPathPicker({
      target: 'copy-images',
      allowFiles: false
    });
  }, [filtered, imageInputPath]);

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
        case 'copy-images':
          if (!selection.isDirectory) return;
          await copyImagesToDestination(selection.path);
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
      const result = await ipcRenderer.invoke(
        'run-transcription',
        'image',
        imageInputPath,
        imageOutputDir,
        '',
        false,
        false,
        { recursive: false, batch: imageBatchEnabled, batchSize: imageBatchSize }
      ) as string;
      
      if (imageOutputDir) {
        const list = await ipcRenderer.invoke('list-transcripts-subtitles', imageOutputDir) as Transcript[];
        setImageTranscripts(sortTranscripts(list));
      }
      const logs = await ipcRenderer.invoke('read-logs', 'image');
      setLogs(logs);

      const normalized = typeof result === 'string' ? result.trim() : '';
      const detail = normalized.replace(/^\[[A-Z]+\]\s*/, '');
      const isInfo = normalized.startsWith('[INFO]');
      const statusText = detail || 'Done';
      setStatus(isInfo ? `ℹ️ ${statusText}` : `✅ ${statusText}`);
      setToast(isInfo ? `ℹ️ ${statusText}` : '✅ Done');
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
      await refreshMistralBatchStats();
      await refreshMistralQueueCollectionCount();
      setIsTranscribing(false);
    }
  }, [
    imageInputPath,
    imageOutputDir,
    imageBatchEnabled,
    imageBatchSize,
    imageRecursive,
    imageInputIsDirectory,
    refreshMistralBatchStats,
    refreshMistralQueueCollectionCount
  ]);

  const cancel = useCallback(async () => {
    await ipcRenderer.invoke('cancel-transcription');
    setStatus('❌ Cancelled by user');
    setIsTranscribing(false);
  }, []);

  const openTranscript = useCallback((p: string) => ipcRenderer.invoke('open-transcript', p), []);
  const openImageForTranscript = useCallback(
    async (transcript: Transcript) => {
      if (!imageInputPath) {
        setToast('Set an image input folder first.');
        setTimeout(() => setToast(null), 6000);
        return;
      }
      const imagePath = resolveImageForTranscript(transcript.name, imageInputPath);
      if (!imagePath) {
        setToast(`No matching image found for ${transcript.name}`);
        setTimeout(() => setToast(null), 6000);
        return;
      }
      try {
        const err = await ipcRenderer.invoke('open-transcript', imagePath);
        if (err) {
          setToast(`❌ ${err}`);
          setTimeout(() => setToast(null), 6000);
        }
      } catch (error: any) {
        setToast(`❌ Failed to open image: ${error?.message || error}`);
        setTimeout(() => setToast(null), 6000);
      }
    },
    [imageInputPath]
  );
  const clearLogs = useCallback(async () => {
    await ipcRenderer.invoke('clear-logs', mode);
    setLogs('');
  }, [mode]);
  const exportLogs = useCallback(async () => {
    if (!logs || !logs.trim()) {
      setToast('No logs to export');
      setTimeout(() => setToast(null), 6000);
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
        setToast(`❌ ${result.error}`);
        setTimeout(() => setToast(null), 6000);
        return;
      }
      const count = result?.count;
      setToast(
        typeof count === 'number'
          ? `Exported ${count} log line${count === 1 ? '' : 's'}`
          : 'Exported logs'
      );
      setTimeout(() => setToast(null), 6000);
    } catch (error: any) {
      setToast(`❌ Export failed: ${error?.message || error}`);
      setTimeout(() => setToast(null), 6000);
    }
  }, [logs, mode]);

  const contextIssues = contextMenu
    ? qualityScores[contextMenu.transcript.name]?.issues
    : undefined;
  const canClearContextWarning = Boolean(contextIssues && contextIssues.length);
  const canViewContextImage = Boolean(imageInputPath);

  const exportTranscriptList = useCallback(async () => {
    if (!filtered.length) {
      setToast('No files to export');
      setTimeout(() => setToast(null), 6000);
      return;
    }
    try {
      const outputDir = mode === 'audio' ? audioOutputDir : imageOutputDir;
      const result = await ipcRenderer.invoke('export-transcript-list', {
        mode,
        items: filtered.map(item => {
          const entry = qualityScores[item.name];
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
        setToast(`❌ ${result.error}`);
        setTimeout(() => setToast(null), 6000);
        return;
      }
      const count = result?.count ?? filtered.length;
      setToast(`Exported ${count} file${count === 1 ? '' : 's'}`);
      setTimeout(() => setToast(null), 6000);
    } catch (error: any) {
      setToast(`❌ Export failed: ${error?.message || error}`);
      setTimeout(() => setToast(null), 6000);
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
    qualityScores
  ]);

  const resetFilters = useCallback(() => {
    setFilter('');
    setFileTypeFilter('all');
    setIssueFilter('all');
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
    <div className={`app-shell${isResizing ? ' resizing' : ''}`}>
      <div style={{ position: 'fixed', top: 50, right: 12, zIndex: 20 }}>
        <FaCog className="settings-gear" onClick={() => ipcRenderer.invoke('open-settings')} />
        {newVersionAvailable && (
          <span
            style={{
              position: 'absolute',
              top: -10,
              right: 6,
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
                      if (['e','E','+','-','.'].includes(e.key)) e.preventDefault();
                    }}
                    onChange={e => {
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
                <InfoTooltip text="Enter the minimum acceptable confidence (0–100). Confidence is 100% when no [unsure]/[blank] markers are present, and 0% when all tokens are placeholders. Empty transcripts are marked as Blank and treated as 0% confidence. Colors: green for ≥99%, yellow between the threshold and 99%, red below the threshold." />
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
              <div style={{ display: 'flex', alignItems: 'stretch', gap: '0.5rem' }}>
                <input
                  className="filter-input"
                  placeholder="Filter transcripts, subtitles…"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
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
                    borderRadius: '4px',
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
          <span style={{ marginLeft: 'auto' }} />
          <button
            className="btn"
            onClick={exportTranscriptList}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85rem',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px',
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
        </div>
        <ul className="transcript-list">
          {filtered.map(t => {
            const entry = qualityScores[t.name];
            const issues = entry?.issues;
            const issueSummary = issues?.length ? `• ${issues.join('\n• ')}` : null;
            let confidenceNode: React.ReactNode = null;
            if (entry) {
              if (entry.blankTranscript) {
                confidenceNode = (
                  <span className="transcript-score transcript-score-blank" title="Transcript appears blank">
                    Blank
                  </span>
                );
              } else {
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
            }
            return (
              <li
                key={t.path}
                className="transcript-item"
                onContextMenu={(event) => onTranscriptContextMenu(event, t)}
              >
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
              borderRadius: '6px',
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
          >
            <button
              className="transcript-context-item"
              onClick={() => {
                openImageForTranscript(contextMenu.transcript);
                closeContextMenu();
              }}
              disabled={!canViewContextImage}
            >
              View image
            </button>
            <button
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
        <div className="logo">TranscribeAI</div>

        <div
          className={`mode-toggle ${mode}`}
          onClick={() => setMode(m => (m === 'audio' ? 'image' : 'audio'))}
        >
          <div className={mode === 'audio' ? 'label active' : 'label'}>Audio</div>
          <div className={mode === 'image' ? 'label active' : 'label'}>Image</div>
          <div className="toggle-thumb" />
        </div>

        {mode === 'audio' ? (
          <AudioTranscriber
            inputPath={audioInputPath}
            outputDir={audioOutputDir}
            isTranscribing={isTranscribing}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onClearInput={clearAudioInputPath}
            onClearOutput={clearAudioOutputDir}
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
            batchStats={mistralBatchStats}
            onSelectInput={selectInput}
            onSelectOutput={selectOutput}
            onClearInput={clearImageInputPath}
            onClearOutput={clearImageOutputDir}
            onToggleRecursive={() => setImageRecursive(v => !v)}
            onToggleBatch={() => setImageBatchEnabled(v => !v)}
            onBatchSizeChange={(size: number) => setImageBatchSize(size)}
            onOpenBatchQueue={openBatchQueueWindow}
            queueCollectionCount={mistralQueueCollectionCount}
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
                className="logs-export"
                onClick={e => {
                  e.stopPropagation();
                  exportLogs();
                }}
                title="Export logs"
                aria-label="Export logs"
              >
                <FaDownload />
              </button>
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
    </div>
  );
}
