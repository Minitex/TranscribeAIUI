import React, { useState, useCallback, useEffect } from 'react';
import { FaFileAudio, FaFolderOpen, FaListUl, FaMicrophone, FaTimesCircle } from 'react-icons/fa';
import InfoTooltip from './InfoTooltip';
import PathField from './PathField';
import Stepper from './Stepper';
import { buildBatchModeTooltip } from './BatchCostEstimate';
import { MISTRAL_AUDIO_PRICE_PER_MINUTE_DIRECT, MISTRAL_AUDIO_PRICE_PER_MINUTE_BATCH, BATCH_MODE_INFO } from '../lib/constants';
import type { BatchCostEstimateData } from '../lib/types';

export type Transcript = { name: string; path: string };

interface AudioTranscriberProps {
  inputPath: string;
  outputDir: string;
  isTranscribing: boolean;
  mistralVoxtralMode: boolean;
  batchEnabled: boolean;
  batchSize: number;
  inputIsDirectory: boolean;
  batchStats: {
    uploaded: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
  } | null;
  costEstimate: BatchCostEstimateData | null;
  onSelectInput(): void;
  onSelectOutput(): void;
  onClearInput(): void;
  onClearOutput(): void;
  onToggleBatch(): void;
  onBatchSizeChange(size: number): void;
  onOpenBatchQueue(): void;
  queueCollectionCount: number;
  onTranscribe(interviewMode: boolean, generateSubtitles: boolean): void;
  onCancel(): void;
}

// Mirrors ImageTranscriber's batch size increments (10/25/50/100 steps, 10-500 range).
const getBatchSizeIncrement = (currentSize: number): number => {
  if (currentSize < 50) return 10;
  if (currentSize < 100) return 25;
  if (currentSize < 200) return 50;
  return 100;
};
const getNextBatchSize = (currentSize: number): number => Math.min(500, currentSize + getBatchSizeIncrement(currentSize));
const getPrevBatchSize = (currentSize: number): number => Math.max(10, currentSize - getBatchSizeIncrement(currentSize - 1));

function AudioTranscriber({
  inputPath,
  outputDir,
  isTranscribing,
  mistralVoxtralMode,
  batchEnabled,
  batchSize,
  inputIsDirectory,
  batchStats,
  costEstimate,
  onSelectInput,
  onSelectOutput,
  onClearInput,
  onClearOutput,
  onToggleBatch,
  onBatchSizeChange,
  onOpenBatchQueue,
  queueCollectionCount,
  onTranscribe,
  onCancel
}: AudioTranscriberProps) {
  const [interviewMode, setInterviewMode] = useState(false);
  const [generateSubtitles, setGenerateSubtitles] = useState(false);
  const optionsDisabled = !inputPath || !outputDir;
  // Mistral's batch endpoint doesn't return speaker labels (diarization is
  // sync-only), so interview mode silently degrades to plain timestamps there.
  const interviewModeUnavailable = mistralVoxtralMode && batchEnabled;

  useEffect(() => {
    if (interviewModeUnavailable) setInterviewMode(false);
  }, [interviewModeUnavailable]);

  const handleInterviewChange = useCallback(() => {
    setInterviewMode(im => {
      if (!im) { setGenerateSubtitles(false); }
      return !im;
    });
  }, []);

  const handleSubtitlesChange = useCallback(() => {
    setGenerateSubtitles(gs => {
      if (!gs) { setInterviewMode(false); }
      return !gs;
    });
  }, []);

  const start = () => onTranscribe(interviewMode, generateSubtitles);

  return (
    <>
      <div className="controls">
        <PathField
          icon={<FaFileAudio />}
          value={inputPath}
          placeholder="Select audio file or folder…"
          onSelect={onSelectInput}
          onClear={onClearInput}
          selectAriaLabel="Select input audio"
          inputAriaLabel="Input audio path"
          clearTitle="Clear input path"
          clearAriaLabel="Clear input audio path"
        />

        <PathField
          icon={<FaFolderOpen />}
          value={outputDir}
          placeholder="Select output folder…"
          onSelect={onSelectOutput}
          onClear={onClearOutput}
          selectAriaLabel="Select output folder"
          inputAriaLabel="Output directory"
          clearTitle="Clear output path"
          clearAriaLabel="Clear output folder"
        />

        <div className="options-row">
          <div className="action-buttons">
            {!isTranscribing ? (
              <button
                type="button"
                className="transcribe-btn"
                onClick={start}
                disabled={!inputPath || !outputDir}
                aria-label="Start transcription"
              >
                <FaMicrophone /> Transcribe
              </button>
            ) : (
              <button
                type="button"
                className="cancel-btn"
                onClick={onCancel}
                aria-label="Cancel transcription"
              >
                <FaTimesCircle /> Cancel
              </button>
            )}
          </div>
          <div className="options-group options-group-column">
            <div className="options-group">
              <label className={`option-item${optionsDisabled ? ' disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={generateSubtitles}
                  onChange={handleSubtitlesChange}
                  disabled={optionsDisabled}
                />
                Generate subtitles
                <InfoTooltip text="Generates an SRT subtitle file (SubRip Text) and a transcript file." />
              </label>
              <label className={`option-item${(optionsDisabled || interviewModeUnavailable) ? ' disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={interviewMode}
                  onChange={handleInterviewChange}
                  disabled={optionsDisabled || interviewModeUnavailable}
                />
                Interview mode
                <InfoTooltip text={interviewModeUnavailable
                  ? 'Unavailable with Batch mode on: Mistral\'s batch endpoint doesn\'t return speaker labels, only direct (non-batch) requests do.'
                  : 'Formats transcript as Q&A with speaker labels.'} />
              </label>
            </div>
            {mistralVoxtralMode && (
              <div className="options-group options-group-column">
                <label className="option-item" style={{ opacity: inputIsDirectory ? 1 : 0.6 }}>
                  <input
                    type="checkbox"
                    checked={batchEnabled}
                    onChange={onToggleBatch}
                    disabled={!inputIsDirectory || isTranscribing}
                  />
                  Batch mode
                  <InfoTooltip text={buildBatchModeTooltip(BATCH_MODE_INFO, costEstimate && {
                    fileCount: costEstimate.fileCount,
                    quantity: costEstimate.quantity,
                    unit: costEstimate.unit,
                    directPricePerUnit: MISTRAL_AUDIO_PRICE_PER_MINUTE_DIRECT,
                    batchPricePerUnit: MISTRAL_AUDIO_PRICE_PER_MINUTE_BATCH
                  })} />
                </label>
                {batchEnabled && (
                  <div className="batch-controls-inline" style={{ opacity: inputIsDirectory ? 1 : 0.6 }}>
                    <div className="batch-size-controls">
                      <span className="batch-size-label">Size</span>
                      <Stepper
                        value={batchSize}
                        label="batch size"
                        onDecrement={() => onBatchSizeChange(getPrevBatchSize(batchSize))}
                        onIncrement={() => onBatchSizeChange(getNextBatchSize(batchSize))}
                        decrementDisabled={batchSize <= 10 || !inputIsDirectory || isTranscribing}
                        incrementDisabled={batchSize >= 500 || !inputIsDirectory || isTranscribing}
                      />
                    </div>
                    {inputIsDirectory && (
                      <div className="batch-mini-stats">
                        <div className="batch-mini-stat">
                          <span>Uploaded</span>
                          <strong>{batchStats?.uploaded ?? 0}</strong>
                        </div>
                        <div className="batch-mini-stat">
                          <span>Processing</span>
                          <strong>{batchStats?.processing ?? 0}</strong>
                        </div>
                        <div className="batch-mini-stat">
                          <span>Completed</span>
                          <strong>{batchStats?.completed ?? 0}</strong>
                        </div>
                        {(batchStats?.failed ?? 0) > 0 && (
                          <div className="batch-mini-stat failed">
                            <span>Failed</span>
                            <strong>{batchStats?.failed ?? 0}</strong>
                          </div>
                        )}
                      </div>
                    )}
                    {inputIsDirectory && (
                      <button
                        type="button"
                        className="batch-queue-open-btn"
                        onClick={onOpenBatchQueue}
                        disabled={isTranscribing}
                        aria-label="Open saved Mistral batch queue"
                      >
                        <FaListUl className="batch-queue-icon" aria-hidden="true" />
                        <span className="batch-queue-tooltip" role="tooltip">Open batch queue</span>
                        {queueCollectionCount > 0 && (
                          <span className="batch-queue-count-badge" aria-label={`${queueCollectionCount} saved collections`}>
                            {queueCollectionCount > 99 ? '99+' : queueCollectionCount}
                          </span>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default React.memo(AudioTranscriber);
