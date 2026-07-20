import React from 'react';
import type { Transcript } from './AudioTranscriber';
import { buildConfidenceTitle, type QualityEntry } from '../lib/quality';
import { splitTranscriptNameForMiddleEllipsis } from '../lib/paths';
import { confidenceColor } from '../lib/ocrReview';

interface TranscriptListItemProps {
  transcript: Transcript;
  entry: QualityEntry | undefined;
  threshold: number;
  reviewed: boolean;
  onOpen(path: string): void;
  onRemove(path: string): void;
  onToggleReviewed(name: string): void;
  onContextMenu(event: React.MouseEvent, transcript: Transcript): void;
}

/**
 * One row in the sidebar transcript list. Memoized so a filter keystroke or a
 * single delete doesn't re-render every row — only items whose transcript,
 * quality entry, or threshold actually changed re-render.
 */
function TranscriptListItem({
  transcript,
  entry,
  threshold,
  reviewed,
  onOpen,
  onRemove,
  onToggleReviewed,
  onContextMenu
}: TranscriptListItemProps) {
  const displayName = splitTranscriptNameForMiddleEllipsis(transcript.name);
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
      const color = entry.mistralConfidence
        ? confidenceColor(confidence / 100, 'var(--text)')
        : confidence < threshold ? 'red' : confidence >= 99 ? 'green' : 'yellow';
      const display = confidence
        .toFixed(2)
        .replace(/\.00$/, '')
        .replace(/(\.\d)0$/, '$1');
      confidenceNode = (
        <span className="transcript-score" style={{ color }} title={buildConfidenceTitle(entry, display)}>
          {display}%
        </span>
      );
    }
  }

  return (
    <li className="transcript-item" onContextMenu={event => onContextMenu(event, transcript)}>
      <div className="transcript-main">
        {issueSummary && <span className="issue-dot" aria-label={issueSummary} title={issueSummary} />}
        <span
          className="transcript-name"
          role="button"
          tabIndex={0}
          title={transcript.name}
          aria-label={`Open transcript ${transcript.name}`}
          onDoubleClick={() => onOpen(transcript.path)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen(transcript.path);
            }
          }}
        >
          {displayName.end ? (
            <>
              <span className="transcript-name-start">{displayName.start}</span>
              <span className="transcript-name-end">{displayName.end}</span>
            </>
          ) : (
            transcript.name
          )}
        </span>
        {confidenceNode}
      </div>
      <button
        className={reviewed ? 'transcript-reviewed-toggle active' : 'transcript-reviewed-toggle'}
        onClick={() => onToggleReviewed(transcript.name)}
        aria-label={reviewed ? `Mark ${transcript.name} unreviewed` : `Mark ${transcript.name} reviewed`}
        aria-pressed={reviewed}
        title={reviewed ? 'Reviewed' : 'Mark reviewed'}
      >
        ✓
      </button>
      <button
        className="transcript-delete"
        onClick={() => {
          if (window.confirm(`Delete ${transcript.name}? This cannot be undone.`)) {
            onRemove(transcript.path);
          }
        }}
        aria-label={`Remove ${transcript.name}`}
        title="Remove"
      >
        ×
      </button>
    </li>
  );
}

export default React.memo(TranscriptListItem);
