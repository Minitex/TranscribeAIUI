import { useState, useEffect, useMemo } from 'react';
import { FaChevronDown, FaChevronUp, FaUndo, FaSpinner, FaTrash } from 'react-icons/fa';
import InfoTooltip from '../components/InfoTooltip';
import Stepper from '../components/Stepper';
import { ipcRenderer } from '../electron';
import { DEFAULT_AUDIO_PROMPT, DEFAULT_IMAGE_PROMPT } from '../../../defaultPrompts';
import {
  AUDIO_MODEL_OPTIONS,
  DEFAULT_AUDIO_MODEL,
  IMAGE_MODEL_OPTIONS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS,
  DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS,
  MIN_MISTRAL_BATCH_WORKERS,
  MAX_MISTRAL_BATCH_WORKERS,
  SAVED_BADGE_DURATION_MS,
  TEMP_FILES_SUCCESS_MS,
  TEMP_FILES_ERROR_MS
} from '../lib/constants';
import {
  resolveSupportedModel,
  resolveWorkerCount,
  getNextWorkerCount,
  getPrevWorkerCount
} from '../lib/models';
import { getErrorMessage } from '../lib/errors';

// Load one persisted setting: read from ipc, fall back to localStorage via the
// caller's `pick`. Never rejects — on ipc failure it calls pick(undefined),
// mirroring the previous per-field .catch() behavior.
async function loadSetting<T>(channel: string, pick: (ipcValue: unknown) => T): Promise<T> {
  try {
    return pick(await ipcRenderer.invoke(channel));
  } catch {
    return pick(undefined);
  }
}

type SettingsProps = {
  currentVersion: string;
  latestVersion: string;
  checkingUpdate: boolean;
  updateError: string;
  onCheckLatest: () => void;
  onOpenUpdatePage: () => void;
  onOpenUpdateInstructions: () => void;
};

export default function SettingsView({
  currentVersion,
  latestVersion,
  checkingUpdate,
  updateError,
  onCheckLatest,
  onOpenUpdatePage,
  onOpenUpdateInstructions
}: SettingsProps) {
  const [key, setKey] = useState('');
  const [audioModel, setAudioModel] = useState(DEFAULT_AUDIO_MODEL);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [mistralKey, setMistralKey] = useState('');
  const [audioPrompt, setAudioPrompt] = useState<string>(DEFAULT_AUDIO_PROMPT);
  const [imagePrompt, setImagePrompt] = useState<string>(DEFAULT_IMAGE_PROMPT);
  const [mistralAudioContextBias, setMistralAudioContextBias] = useState<string>('');
  const [mistralAudioLanguage, setMistralAudioLanguage] = useState<string>('');
  const [mistralBatchPreprocessWorkers, setMistralBatchPreprocessWorkers] = useState<number>(
    DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS
  );
  const [mistralBatchUploadWorkers, setMistralBatchUploadWorkers] = useState<number>(
    DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
  );
  const [saved, setSaved] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  // Mistral models (Voxtral for audio, OCR for images) take no prompt, so the
  // prompt editors are hidden while one is selected. The saved prompt text is
  // kept and reappears when switching back to a Gemini model.
  const isMistralAudioModel = audioModel.toLowerCase().includes('voxtral');
  const isMistralImageModel = imageModel.toLowerCase().includes('mistral');
  const [clearingTempFiles, setClearingTempFiles] = useState(false);
  const [tempFilesMessage, setTempFilesMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [
        nextKey,
        nextAudioModel,
        nextImageModel,
        nextMistralKey,
        nextAudioPrompt,
        nextImagePrompt,
        nextPreprocessWorkers,
        nextUploadWorkers,
        nextMistralAudioContextBias,
        nextMistralAudioLanguage
      ] = await Promise.all([
        loadSetting('get-api-key', v => (v as string) || localStorage.getItem('apiKey') || ''),
        loadSetting('get-audio-model', v =>
          resolveSupportedModel(
            (v as string) || localStorage.getItem('audioModel'),
            AUDIO_MODEL_OPTIONS,
            DEFAULT_AUDIO_MODEL
          )
        ),
        loadSetting('get-image-model', v =>
          resolveSupportedModel(
            (v as string) || localStorage.getItem('imageModel'),
            IMAGE_MODEL_OPTIONS,
            DEFAULT_IMAGE_MODEL
          )
        ),
        loadSetting('get-mistral-key', v => (v as string) || localStorage.getItem('mistralKey') || ''),
        loadSetting('get-audio-prompt', v =>
          (v as string) || (localStorage.getItem('audioPrompt') as string) || DEFAULT_AUDIO_PROMPT
        ),
        loadSetting('get-image-prompt', v =>
          (v as string) || (localStorage.getItem('imagePrompt') as string) || DEFAULT_IMAGE_PROMPT
        ),
        loadSetting('get-mistral-batch-preprocess-workers', v =>
          resolveWorkerCount(
            (v as number) ?? localStorage.getItem('mistralBatchPreprocessWorkers'),
            DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS
          )
        ),
        loadSetting('get-mistral-batch-upload-workers', v =>
          resolveWorkerCount(
            (v as number) ?? localStorage.getItem('mistralBatchUploadWorkers'),
            DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
          )
        ),
        loadSetting('get-mistral-audio-context-bias', v =>
          (v as string) || (localStorage.getItem('mistralAudioContextBias') as string) || ''
        ),
        loadSetting('get-mistral-audio-language', v =>
          (v as string) || (localStorage.getItem('mistralAudioLanguage') as string) || ''
        )
      ]);
      if (cancelled) return;
      setKey(nextKey);
      setAudioModel(nextAudioModel);
      setImageModel(nextImageModel);
      setMistralKey(nextMistralKey);
      setAudioPrompt(nextAudioPrompt);
      setImagePrompt(nextImagePrompt);
      setMistralBatchPreprocessWorkers(nextPreprocessWorkers);
      setMistralBatchUploadWorkers(nextUploadWorkers);
      setMistralAudioContextBias(nextMistralAudioContextBias);
      setMistralAudioLanguage(nextMistralAudioLanguage);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const saveSetting = async (channel: string, storageKey: string, value: unknown) => {
      try {
        await ipcRenderer.invoke(channel, value);
      } catch {
        try {
          localStorage.setItem(storageKey, typeof value === 'string' ? value : String(value));
        } catch {
          /* localStorage unavailable */
        }
      }
    };

    await Promise.all([
      saveSetting('set-api-key', 'apiKey', key),
      saveSetting('set-mistral-key', 'mistralKey', mistralKey),
      saveSetting('set-audio-model', 'audioModel', audioModel),
      saveSetting('set-image-model', 'imageModel', imageModel),
      saveSetting('set-audio-prompt', 'audioPrompt', audioPrompt),
      saveSetting('set-image-prompt', 'imagePrompt', imagePrompt),
      saveSetting('set-mistral-batch-preprocess-workers', 'mistralBatchPreprocessWorkers', mistralBatchPreprocessWorkers),
      saveSetting('set-mistral-batch-upload-workers', 'mistralBatchUploadWorkers', mistralBatchUploadWorkers),
      saveSetting('set-mistral-audio-context-bias', 'mistralAudioContextBias', mistralAudioContextBias),
      saveSetting('set-mistral-audio-language', 'mistralAudioLanguage', mistralAudioLanguage)
    ]);

    setSaved(true);
    setTimeout(() => setSaved(false), SAVED_BADGE_DURATION_MS);
  };

  const revertAudioPrompt = () => setAudioPrompt(DEFAULT_AUDIO_PROMPT);
  const revertImagePrompt = () => setImagePrompt(DEFAULT_IMAGE_PROMPT);

  const clearTempFiles = async () => {
    setClearingTempFiles(true);
    setTempFilesMessage('');
    try {
      const result = await ipcRenderer.invoke('clear-temp-files');
      setTempFilesMessage(result.message);
      setTimeout(() => setTempFilesMessage(''), TEMP_FILES_SUCCESS_MS);
    } catch (error) {
      setTempFilesMessage(`Error: ${getErrorMessage(error)}`);
      setTimeout(() => setTempFilesMessage(''), TEMP_FILES_ERROR_MS);
    } finally {
      setClearingTempFiles(false);
    }
  };
  const apiKeyFields = useMemo(
    () => [
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
    ],
    [key, mistralKey]
  );

  return (
    <div className="settings-container" style={{ position: 'relative' }}>
      <h2 style={{ flexShrink: 0 }}>Settings</h2>

      <div className="settings-scroll">
        <div className="settings-body">
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
                <div style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{updateError}</div>
              )}
              {latestVersion && currentVersion && latestVersion !== currentVersion && (
                <div style={{ color: 'var(--success)', fontSize: '0.9rem' }}>
                  Download from the latest release to update.{' '}
                  <a
                    href="#"
                    onClick={e => {
                      e.preventDefault();
                      onOpenUpdateInstructions();
                    }}
                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
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
                    border: '2px solid var(--success)'
                  }}
                  title="Open the latest release page on GitHub"
                >
                  New version available
                </button>
              )}
            </div>
          </div>

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
            {!isMistralAudioModel && (
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
            )}
            {isMistralAudioModel && (
            <div className="prompt-group">
              <div className="prompt-header" style={{ alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label htmlFor="audio-context-bias" style={{ margin: 0 }}>
                    Context Bias
                  </label>
                  <InfoTooltip text="Optional, comma-separated names/terms/jargon (up to 100) to steer Voxtral toward correct spellings, e.g. names of people or places that come up often in your audio." />
                </div>
              </div>
              <input
                id="audio-context-bias"
                type="text"
                placeholder="e.g. Chicago, Joplin, Boston"
                value={mistralAudioContextBias}
                onChange={e => setMistralAudioContextBias(e.target.value)}
              />
              <div className="prompt-header" style={{ alignItems: 'flex-start', marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label htmlFor="audio-language" style={{ margin: 0 }}>
                    Language Hint
                  </label>
                  <InfoTooltip text="Optional language code (e.g. en, es, fr) to pin the audio's language instead of auto-detecting. Ignored for Subtitles/Interview mode, which use their own timestamped format." />
                </div>
              </div>
              <input
                id="audio-language"
                type="text"
                placeholder="e.g. en"
                value={mistralAudioLanguage}
                onChange={e => setMistralAudioLanguage(e.target.value)}
              />
            </div>
            )}
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
            {!isMistralImageModel && (
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
            )}
          </div>
        </div>

        <div
          className="clear-temp-section"
          style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: '8px' }}
        >
          <div style={{ marginBottom: '0.9rem' }}>
            <h3 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', fontWeight: '500' }}>Batch Workers</h3>
            <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.8 }}>
              Control how many files preprocess and send requests in parallel for Mistral batch, regular Mistral, and Gemini image runs. Upload/request workers are also used by Mistral audio batch transcription.
            </p>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '1rem'
            }}
          >
            <div className="model-group" style={{ marginBottom: 0 }}>
              <label htmlFor="mistral-batch-preprocess-workers">Preprocess Workers</label>
              <div
                className="batch-size-controls"
                role="group"
                aria-labelledby="mistral-batch-preprocess-workers"
                style={{ width: 'fit-content' }}
              >
                <Stepper
                  value={mistralBatchPreprocessWorkers}
                  label="preprocess workers"
                  liveValue
                  onDecrement={() => setMistralBatchPreprocessWorkers(getPrevWorkerCount(mistralBatchPreprocessWorkers))}
                  onIncrement={() => setMistralBatchPreprocessWorkers(getNextWorkerCount(mistralBatchPreprocessWorkers))}
                  decrementDisabled={mistralBatchPreprocessWorkers <= MIN_MISTRAL_BATCH_WORKERS}
                  incrementDisabled={mistralBatchPreprocessWorkers >= MAX_MISTRAL_BATCH_WORKERS}
                />
              </div>
              <small style={{ display: 'block', marginTop: 6, opacity: 0.75 }}>
                Controls JP2/TIFF conversion and image resize work before each OCR request.
              </small>
            </div>
            <div className="model-group" style={{ marginBottom: 0 }}>
              <label htmlFor="mistral-batch-upload-workers">Upload / Request Workers</label>
              <div
                className="batch-size-controls"
                role="group"
                aria-labelledby="mistral-batch-upload-workers"
                style={{ width: 'fit-content' }}
              >
                <Stepper
                  value={mistralBatchUploadWorkers}
                  label="upload workers"
                  liveValue
                  onDecrement={() => setMistralBatchUploadWorkers(getPrevWorkerCount(mistralBatchUploadWorkers))}
                  onIncrement={() => setMistralBatchUploadWorkers(getNextWorkerCount(mistralBatchUploadWorkers))}
                  decrementDisabled={mistralBatchUploadWorkers <= MIN_MISTRAL_BATCH_WORKERS}
                  incrementDisabled={mistralBatchUploadWorkers >= MAX_MISTRAL_BATCH_WORKERS}
                />
              </div>
              <small style={{ display: 'block', marginTop: 6, opacity: 0.75 }}>
                Higher values are faster, but can increase socket resets, API throttling, or request failures.
              </small>
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
                backgroundColor: 'var(--danger)',
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
              backgroundColor: tempFilesMessage.includes('Error') ? 'rgba(var(--danger-rgb), 0.1)' : 'rgba(var(--success-rgb), 0.1)',
              color: tempFilesMessage.includes('Error') ? 'var(--danger)' : 'var(--success)',
              border: `1px solid ${tempFilesMessage.includes('Error') ? 'rgba(var(--danger-rgb), 0.3)' : 'rgba(var(--success-rgb), 0.3)'}`
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
