import React, { useEffect, useRef, useState } from 'react';
import { fs, path, url } from '../electron';
import {
  AUDIO_MIME_BY_EXT,
  findActiveSegmentIndex,
  formatTranscriptTimestamp,
  segmentsToSrtText,
  segmentsToTranscriptText
} from '../lib/audioReview';
import type { AudioReviewData, AudioReviewSegment } from '../lib/types';

interface AudioReviewModalProps {
  isOpen: boolean;
  txtPath: string;
  srtPath: string;
  data: AudioReviewData;
  onClose(): void;
  onSaved?(): void;
  reviewed?: boolean;
  onToggleReviewed?(): void;
}

const AudioReviewModal: React.FC<AudioReviewModalProps> = ({
  isOpen,
  txtPath,
  srtPath,
  data,
  onClose,
  onSaved,
  reviewed,
  onToggleReviewed
}) => {
  const [segments, setSegments] = useState<AudioReviewSegment[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Points at the exact array last written to disk (or just loaded) — since
  // every edit replaces the array via setSegments, a plain reference compare
  // is enough to know whether anything unsaved exists, no diffing needed.
  const savedSegmentsRef = useRef<AudioReviewSegment[]>([]);
  const saveStatusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSegments(data.segments);
    savedSegmentsRef.current = data.segments;
    setEditingIndex(null);
    setActiveIndex(-1);
    setSaveStatus('idle');
  }, [isOpen, srtPath, data.segments]);

  // In the packaged app the renderer's own document is served from file://,
  // so Chromium loads a file:// <audio src> directly (same trick OcrReviewModal
  // uses for its image). In dev the renderer loads over http://localhost,
  // where file:// subresources are blocked — fall back to a Blob object URL
  // instead of OCR's base64 data: URI, since audio files are too large to
  // comfortably inline as base64.
  useEffect(() => {
    const srcPath = data.sourceAudioPath;
    if (!srcPath) {
      setAudioSrc(null);
      return;
    }
    if (!import.meta.env.DEV) {
      try {
        setAudioSrc(url.pathToFileURL(srcPath).href);
      } catch {
        setAudioSrc(null);
      }
      return;
    }
    let objectUrl: string | null = null;
    try {
      const mime = AUDIO_MIME_BY_EXT[path.extname(srcPath).toLowerCase()] || 'audio/mpeg';
      objectUrl = URL.createObjectURL(new Blob([fs.readFileSync(srcPath)], { type: mime }));
      setAudioSrc(objectUrl);
    } catch {
      setAudioSrc(null);
    }
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data.sourceAudioPath]);

  const isDirty = segments !== savedSegmentsRef.current;

  // Escape closes the modal (matches OcrReviewModal), guarded by the same
  // dirty check as the close button.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, segments]);

  const saveChanges = (): boolean => {
    try {
      fs.writeFileSync(srtPath, segmentsToSrtText(segments), 'utf-8');
      fs.writeFileSync(txtPath, segmentsToTranscriptText(segments), 'utf-8');
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
    savedSegmentsRef.current = segments;
    setSaveStatus('saved');
    if (saveStatusTimerRef.current) window.clearTimeout(saveStatusTimerRef.current);
    saveStatusTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 3000);
    onSaved?.();
    return true;
  };

  const closeModal = () => {
    if (!isDirty) {
      onClose();
      return;
    }
    if (window.confirm('Save changes before closing?')) {
      if (!saveChanges()) return; // stay open so the error is visible
      onClose();
      return;
    }
    if (window.confirm('Discard unsaved changes?')) onClose();
  };

  if (!isOpen) return null;

  const seekToSegment = (index: number) => {
    const audio = audioRef.current;
    const seg = segments[index];
    if (!audio || !seg) return;
    audio.currentTime = seg.startMs / 1000;
    void audio.play();
  };

  const commitSegmentEdit = (index: number, newText: string) => {
    setEditingIndex(null);
    const trimmed = newText.trim();
    if (trimmed === segments[index].text.trim()) return;
    setSegments(prev => prev.map((seg, i) => (i === index ? { ...seg, text: trimmed } : seg)));
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const idx = findActiveSegmentIndex(segments, audio.currentTime * 1000);
    if (idx === activeIndex) return;
    setActiveIndex(idx);
    if (idx >= 0) {
      document.getElementById(`audio-review-segment-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="audio-review-overlay" role="dialog" aria-modal="true">
      <div className="audio-review-modal">
        <div className="audio-review-header">
          <h3>Audio Review</h3>
          <div className="audio-review-header-actions">
            {onToggleReviewed && (
              <button
                type="button"
                className={reviewed ? 'audio-review-reviewed-toggle active' : 'audio-review-reviewed-toggle'}
                onClick={onToggleReviewed}
              >
                {reviewed ? '✓ Reviewed' : 'Mark reviewed'}
              </button>
            )}
            <button type="button" className="primary" onClick={saveChanges} disabled={!isDirty}>Save</button>
            <button type="button" className="audio-review-close" aria-label="Close" onClick={closeModal}>×</button>
          </div>
        </div>

        <div className="audio-review-hint">
          Click a line to play from there · double-click to edit · editing pauses playback.
        </div>
        {saveStatus === 'saved' && <div className="audio-review-status audio-review-status-ok">Saved</div>}
        {saveStatus === 'error' && <div className="audio-review-status audio-review-status-error">Save failed: {saveError}</div>}
        {!data.sourceAudioPath && (
          <div className="audio-review-status audio-review-status-warn">
            Original audio file not found — playback unavailable, transcript is still editable.
          </div>
        )}

        <div className={audioSrc ? 'audio-review-body two-pane' : 'audio-review-body'}>
          {audioSrc && (
            <div className="audio-review-player-pane">
              <audio ref={audioRef} src={audioSrc} controls className="audio-review-audio" onTimeUpdate={handleTimeUpdate} />
            </div>
          )}

          <div className="audio-review-text-pane">
            {segments.length ? segments.map((seg, i) => {
              if (editingIndex === i) {
                return (
                  <textarea
                    key={i}
                    id={`audio-review-segment-${i}`}
                    className="audio-review-segment-textarea"
                    autoFocus
                    defaultValue={seg.text}
                    onFocus={() => audioRef.current?.pause()}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        e.currentTarget.value = seg.text;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={e => commitSegmentEdit(i, e.target.value)}
                  />
                );
              }
              return (
                <p
                  key={i}
                  id={`audio-review-segment-${i}`}
                  className={i === activeIndex ? 'audio-review-segment active' : 'audio-review-segment'}
                  onClick={() => seekToSegment(i)}
                  onDoubleClick={e => { e.stopPropagation(); setEditingIndex(i); }}
                  title="Click to play from here · double-click to edit"
                >
                  <span className="audio-review-segment-time">{formatTranscriptTimestamp(seg.startMs)}</span>
                  {seg.text}
                </p>
              );
            }) : (
              <p className="audio-review-empty">No segments to review.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoized like OcrReviewModal — App re-renders periodically while a batch
// runs in the background (progress polling); this keeps that from rebuilding
// the whole segment list on every tick while a review is open.
export default React.memo(AudioReviewModal);
