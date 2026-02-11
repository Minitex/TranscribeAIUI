// src/components/AudioTranscriber.tsx
import React, { useState, useCallback } from 'react';
import {
  FaFileAudio,
  FaFolderOpen,
  FaMicrophone,
  FaTimesCircle,
  FaQuestionCircle
} from 'react-icons/fa';

export type Transcript = { name: string; path: string };

interface AudioTranscriberProps {
  inputPath: string;
  outputDir: string;
  isTranscribing: boolean;
  onSelectInput(): void;
  onSelectOutput(): void;
  onClearInput(): void;
  onClearOutput(): void;
  onTranscribe(interviewMode: boolean, generateSubtitles: boolean): void;
  onCancel(): void;
}

const InfoTooltip: React.FC<{ text: string }> = ({ text }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div
      className="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <FaQuestionCircle size={14} />
      {visible && (
        <div className="tooltip-box">{text}</div>
      )}
    </div>
  );
};

export default function AudioTranscriber({
  inputPath,
  outputDir,
  isTranscribing,
  onSelectInput,
  onSelectOutput,
  onClearInput,
  onClearOutput,
  onTranscribe,
  onCancel
}: AudioTranscriberProps) {
  const [interviewMode, setInterviewMode] = useState(false);
  const [generateSubtitles, setGenerateSubtitles] = useState(false);
  const optionsDisabled = !inputPath || !outputDir;

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
        <div className="field-row">
          <button type="button" onClick={onSelectInput} aria-label="Select input audio">
            <FaFileAudio />
          </button>
          <div className="path-input-wrapper">
            <input
              readOnly
              value={inputPath}
              placeholder="Select audio file or folder…"
              aria-label="Input audio path"
            />
            <button
              type="button"
              onClick={onClearInput}
              aria-label="Clear input audio path"
              disabled={!inputPath}
              title="Clear input path"
              className="clear-path-btn"
            >
              <FaTimesCircle />
            </button>
          </div>
        </div>

        <div className="field-row">
          <button type="button" onClick={onSelectOutput} aria-label="Select output folder">
            <FaFolderOpen />
          </button>
          <div className="path-input-wrapper">
            <input
              readOnly
              value={outputDir}
              placeholder="Select output folder…"
              aria-label="Output directory"
            />
            <button
              type="button"
              onClick={onClearOutput}
              aria-label="Clear output folder"
              disabled={!outputDir}
              title="Clear output path"
              className="clear-path-btn"
            >
              <FaTimesCircle />
            </button>
          </div>
        </div>

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
          <div className="options-group">
            <label className={`option-item${optionsDisabled ? ' disabled' : ''}`}>
              <input
                type="checkbox"
                checked={interviewMode}
                onChange={handleInterviewChange}
                disabled={optionsDisabled}
              />
              Interview mode
              <InfoTooltip text="Formats transcript as Q&A with speaker labels." />
            </label>
            <label className={`option-item${optionsDisabled ? ' disabled' : ''}`}>
              <input
                type="checkbox"
                checked={generateSubtitles}
                onChange={handleSubtitlesChange}
                disabled={optionsDisabled}
              />
              Generate subtitles
              <InfoTooltip text="Generates an SRT subtitle file (SubRip Text) and a transcript file. Early-release: may have issues on recordings longer than 1 hour." />
            </label>
          </div>
        </div>
      </div>
    </>
  );
}
