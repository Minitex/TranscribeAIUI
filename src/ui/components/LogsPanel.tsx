import React from 'react';
import { FaChevronDown, FaChevronUp, FaInfoCircle, FaDownload, FaTrash } from 'react-icons/fa';

/** Collapsible activity-log panel shown at the bottom of the main content area. */
export default function LogsPanel({
  logs,
  showLogs,
  onToggle,
  onExport,
  onClear,
  logsBodyRef
}: {
  logs: string;
  showLogs: boolean;
  onToggle: () => void;
  onExport: () => void;
  onClear: () => void;
  logsBodyRef: React.RefObject<HTMLPreElement | null>;
}) {
  return (
    <section className={`logs-panel ${showLogs ? 'open' : 'collapsed'}`}>
      <div
        className="logs-header"
        role="button"
        tabIndex={0}
        aria-expanded={showLogs}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
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
          <span className="logs-indicator" aria-label={showLogs ? 'Hide logs' : 'Show logs'}>
            {showLogs ? <FaChevronUp /> : <FaChevronDown />}
          </span>
          <button
            className="logs-export"
            onClick={e => {
              e.stopPropagation();
              onExport();
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
              onClear();
            }}
            title="Clear logs"
            aria-label="Clear logs"
          >
            <FaTrash />
          </button>
        </div>
      </div>
      {showLogs && (
        <pre className="logs-body" ref={logsBodyRef}>
          {logs || '— no logs —'}
        </pre>
      )}
    </section>
  );
}
