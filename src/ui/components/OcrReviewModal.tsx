import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fs, path, url, ipcRenderer } from '../electron';
import {
  alignWordsToBlocks,
  alignWordsToRawText,
  bboxToDisplayRect,
  CONFIDENCE_LEGEND,
  confidenceColor,
  confidenceLabel,
  confidenceTierRank,
  isLineBreakWord,
  isRenderableWord,
  readJpegOrientation
} from '../lib/ocrReview';
import { accessiblePdfPathForTranscript, ocrReviewSidecarPathForTranscript } from '../lib/paths';
import type { OcrReviewData, OcrReviewWord } from '../lib/types';

interface OcrReviewModalProps {
  isOpen: boolean;
  txtPath: string;
  data: OcrReviewData;
  onClose(): void;
  onSaved?(): void;
  reviewed?: boolean;
  onToggleReviewed?(): void;
}

// Below this, a word counts as "flagged" — needs a decision (confirm or
// fix) and counts toward the next/prev jump. Matches confidenceColor's
// yellow-or-worse boundary below, so anything colored is flaggable, not
// just the orange/red tail of it.
const FLAG_THRESHOLD = 0.97;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

// EXIF lives in the first APP1 segment, always near the top of a JPEG —
// well under this even with a large embedded thumbnail. Reading only this
// prefix (instead of the whole file) keeps orientation detection fast
// regardless of how large the actual scan is.
const EXIF_PREFIX_BYTES = 256 * 1024;

function readFilePrefix(filePath: string, maxBytes: number): Uint8Array {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

const OcrReviewModal: React.FC<OcrReviewModalProps> = ({
  isOpen,
  txtPath,
  data,
  onClose,
  onSaved,
  reviewed,
  onToggleReviewed
}) => {
  const [pageIndex, setPageIndex] = useState(0);
  const [activeBlockIndex, setActiveBlockIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [pdfStale, setPdfStale] = useState(false);
  const [rebuildingPdf, setRebuildingPdf] = useState(false);
  const [flagIndex, setFlagIndex] = useState(-1);
  // The page text as currently edited (may have unsaved word edits pending);
  // starts as, and is saved back to, the real file at txtPath.
  const [rawText, setRawText] = useState('');
  // Edited-in-place words: present here means the text was changed locally
  // (not yet necessarily saved), keyed by the OCR word object itself since
  // that's stable across renders and unique per occurrence.
  const [wordOverrides, setWordOverrides] = useState<Map<OcrReviewWord, string>>(new Map());
  // Flagged words the user checked and left as-is — no text change, just an
  // acknowledgement so they stop showing up as needing review.
  const [confirmedWords, setConfirmedWords] = useState<Set<OcrReviewWord>>(new Set());
  // A confirm/un-confirm click doesn't touch rawText, so isDirty can't rely
  // on the text diff alone to know a save is needed — this flags that case.
  const [resolvedDirty, setResolvedDirty] = useState(false);
  const [editingWord, setEditingWord] = useState<OcrReviewWord | null>(null);
  // A PDF-sourced review has no directly-renderable image (an <img> can't
  // show PDF bytes) — these hold the on-demand-rasterized per-page PNGs used
  // in its place, keyed by page index like data.pages itself.
  const [pdfPageImagePaths, setPdfPageImagePaths] = useState<string[] | null>(null);
  const [pdfRasterizeError, setPdfRasterizeError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const panOrigin = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  // The last-saved (or just-loaded) text, so isDirty and Save can tell what
  // actually needs writing.
  const savedTextRef = useRef('');
  const saveStatusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPageIndex(0);
    setActiveBlockIndex(null);
    setZoom(1);
    setSaveStatus('idle');
    setFlagIndex(-1);
    setPdfStale(false);
    setWordOverrides(new Map());
    setConfirmedWords(new Set());
    setResolvedDirty(false);
    setEditingWord(null);
    try {
      const text = fs.readFileSync(txtPath, 'utf-8');
      setRawText(text);
      savedTextRef.current = text;
    } catch {
      setRawText('');
    }
  }, [isOpen, txtPath]);

  // Drag-to-pan: only meaningful once zoomed past fit-to-pane. Listens on
  // window (not the pane) while dragging so the pan keeps tracking even if
  // the cursor leaves the pane mid-drag.
  useEffect(() => {
    if (!isPanning) return;
    const handleMove = (e: MouseEvent) => {
      const pane = paneRef.current;
      const origin = panOrigin.current;
      if (!pane || !origin) return;
      pane.scrollLeft = origin.scrollLeft - (e.clientX - origin.x);
      pane.scrollTop = origin.scrollTop - (e.clientY - origin.y);
    };
    const stopPanning = () => setIsPanning(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', stopPanning);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', stopPanning);
    };
  }, [isPanning]);

  const handlePaneMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    const pane = paneRef.current;
    if (!pane) return;
    panOrigin.current = { x: e.clientX, y: e.clientY, scrollLeft: pane.scrollLeft, scrollTop: pane.scrollTop };
    setIsPanning(true);
  };

  useEffect(() => {
    setActiveBlockIndex(null);
    setFlagIndex(-1);
    setEditingWord(null);
  }, [pageIndex]);

  const isDirty = rawText !== savedTextRef.current || resolvedDirty;

  // Escape closes the modal (matching the transcript context menu, which
  // already does); guarded by the same dirty check as the close button.
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
  }, [isOpen, rawText, resolvedDirty]);

  const isPdfSource = path.extname(data.sourceImagePath).toLowerCase() === '.pdf';

  // A PDF source has no directly-renderable image (an <img> can't show PDF
  // bytes, and this codebase has no PDF rasterization lib of its own) — ask
  // the main process to render each page to a cached PNG via Electron's own
  // Chromium/PDFium instead. Keyed on page *count*, not pageIndex, since this
  // renders every page up front so paging doesn't re-trigger it.
  useEffect(() => {
    setPdfPageImagePaths(null);
    setPdfRasterizeError(null);
    if (!isPdfSource) return;
    let cancelled = false;
    ipcRenderer.invoke('rasterize-pdf-pages', txtPath, data.sourceImagePath, data.pages.length)
      .then((result: { ok: boolean; pagePaths?: string[]; error?: string }) => {
        if (cancelled) return;
        if (result.ok && result.pagePaths) setPdfPageImagePaths(result.pagePaths);
        else setPdfRasterizeError(result.error || 'Failed to render PDF preview');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPdfRasterizeError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.sourceImagePath, txtPath, data.pages.length]);

  const page = data.pages[pageIndex];
  // For a PDF source, the current page's rasterized PNG stands in for
  // data.sourceImagePath below — same MIME lookup, dev-vs-packaged loading,
  // and EXIF/orientation handling either way, just on whichever path is
  // active (PDFs rasterize to plain PNGs, so orientation is always 1 there).
  const effectiveImagePath = isPdfSource ? (pdfPageImagePaths?.[pageIndex] ?? null) : data.sourceImagePath;
  // In the packaged app the renderer's own document is served from file://,
  // so Chromium is happy to load a file:// <img> directly — cheap and async,
  // unlike reading + base64-encoding the whole scan on this thread. In dev
  // the renderer loads over http://localhost instead, where Chromium blocks
  // file:// subresources from a non-file-origin document, so it falls back
  // to a data: URI there (dev-only; not a path real users hit).
  const sourceImage = useMemo(() => {
    if (!effectiveImagePath) return null; // no image yet: not a pdf, or still rasterizing
    const mime = MIME_BY_EXT[path.extname(effectiveImagePath).toLowerCase()];
    if (!mime) return null; // browser-unsupported formats like .tif
    try {
      if (import.meta.env.DEV) {
        const bytes = fs.readFileSync(effectiveImagePath);
        return {
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
          orientation: mime === 'image/jpeg' ? readJpegOrientation(bytes) : 1
        };
      }
      const orientation = mime === 'image/jpeg'
        ? readJpegOrientation(readFilePrefix(effectiveImagePath, EXIF_PREFIX_BYTES))
        : 1;
      return { dataUrl: url.pathToFileURL(effectiveImagePath).href, orientation };
    } catch {
      return null;
    }
  }, [effectiveImagePath]);

  const blockWordGroups = useMemo(
    () => alignWordsToBlocks(page.blocks, page.words),
    [page]
  );

  // Jumping "next" walks the reds first, then the oranges, then the yellows;
  // within a tier it follows reading order (block then word) so the cursor
  // moves down the page instead of hopping around by exact confidence.
  const flaggedWords = useMemo(() => {
    const flagged: { blockIndex: number; wordIndex: number; confidence: number }[] = [];
    blockWordGroups.forEach((words, bi) => {
      words.forEach((w, wi) => {
        const handled = wordOverrides.has(w) || confirmedWords.has(w);
        if (isRenderableWord(w) && !handled && Number.isFinite(w.confidence) && w.confidence < FLAG_THRESHOLD) {
          flagged.push({ blockIndex: bi, wordIndex: wi, confidence: w.confidence });
        }
      });
    });
    return flagged.sort((a, b) => {
      const tier = confidenceTierRank(a.confidence) - confidenceTierRank(b.confidence);
      if (tier !== 0) return tier;
      if (a.blockIndex !== b.blockIndex) return a.blockIndex - b.blockIndex;
      return a.wordIndex - b.wordIndex;
    });
  }, [blockWordGroups, wordOverrides, confirmedWords]);

  // Word offsets shift after every edit, so this is recomputed from the
  // latest rawText rather than tracked incrementally.
  const wordOffsets = useMemo(() => alignWordsToRawText(rawText, data.pages), [rawText, data]);

  // Writes the transcript text to disk and flashes a "Saved"/"Save failed"
  // status. Word edits are staged in rawText until this actually runs.
  const persistText = (text: string): boolean => {
    try {
      fs.writeFileSync(txtPath, text, 'utf-8');
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
    setSaveStatus('saved');
    setPdfStale(fs.existsSync(accessiblePdfPathForTranscript(txtPath)));
    if (saveStatusTimerRef.current) window.clearTimeout(saveStatusTimerRef.current);
    saveStatusTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 3000);
    onSaved?.();
    return true;
  };

  // A human has now looked at every edited or confirmed word, so treat them
  // as fully confident and fold that into the OCR sidecar's per-page average
  // — otherwise the confidence shown in the transcript list would stay
  // frozen at whatever the original OCR pass scored, even after review.
  const persistResolvedConfidence = () => {
    try {
      const pages = data.pages.map(p => {
        const words = p.words.map(w => (wordOverrides.has(w) || confirmedWords.has(w)) ? { ...w, confidence: 1 } : w);
        const scores = words.map(w => w.confidence).filter((c): c is number => Number.isFinite(c));
        return {
          ...p,
          words,
          averageConfidence: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : p.averageConfidence,
          minimumConfidence: scores.length ? Math.min(...scores) : p.minimumConfidence
        };
      });
      fs.writeFileSync(ocrReviewSidecarPathForTranscript(txtPath), JSON.stringify({ ...data, pages }), 'utf-8');
    } catch {
      // Best-effort — the saved transcript text is authoritative either way.
    }
  };

  const saveChanges = (): boolean => {
    if (!persistText(rawText)) return false;
    savedTextRef.current = rawText;
    persistResolvedConfidence();
    setResolvedDirty(false);
    return true;
  };

  const closeModal = () => {
    if (rawText === savedTextRef.current && !resolvedDirty) {
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

  const selectBlock = (bi: number) => {
    setActiveBlockIndex(bi);
    document.getElementById(`ocr-bbox-${bi}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    document.getElementById(`ocr-block-${bi}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const jumpToFlag = (delta: number) => {
    if (!flaggedWords.length) return;
    const next = (flagIndex + delta + flaggedWords.length) % flaggedWords.length;
    setFlagIndex(next);
    const target = flaggedWords[next];
    setActiveBlockIndex(target.blockIndex);
    document.getElementById(`ocr-bbox-${target.blockIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    document.getElementById(`ocr-word-${target.blockIndex}-${target.wordIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const commitWordEdit = (word: OcrReviewWord, newText: string) => {
    setEditingWord(null);
    const trimmed = newText.trim();
    const current = wordOverrides.get(word) ?? word.text.trim();
    if (trimmed === current) return;
    const offset = wordOffsets.get(word);
    if (!offset) return; // couldn't locate this word in the text — nothing safe to patch
    setRawText(rawText.slice(0, offset.start) + trimmed + rawText.slice(offset.end));
    setWordOverrides(prev => new Map(prev).set(word, trimmed));
    setConfirmedWords(prev => {
      if (!prev.has(word)) return prev;
      const next = new Set(prev);
      next.delete(word);
      return next;
    });
  };

  const toggleConfirmed = (word: OcrReviewWord) => {
    setResolvedDirty(true);
    setConfirmedWords(prev => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  };

  const handleRebuildPdf = async () => {
    setRebuildingPdf(true);
    try {
      const pdfPath = accessiblePdfPathForTranscript(txtPath);
      const result = await ipcRenderer.invoke('regenerate-searchable-pdf', txtPath, pdfPath) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error || 'Failed to rebuild PDF');
      setPdfStale(false);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuildingPdf(false);
    }
  };

  const renderWords = (words: OcrReviewWord[], blockIndex: number) => words.map((w, wi) => {
    if (isLineBreakWord(w)) return <br key={wi} />;
    if (!isRenderableWord(w)) return null;
    const edited = wordOverrides.has(w);
    const confirmed = !edited && confirmedWords.has(w);
    const resolved = edited || confirmed;
    const displayText = wordOverrides.get(w) ?? w.text.trim();
    const flagged = !resolved && Number.isFinite(w.confidence) && w.confidence < FLAG_THRESHOLD;
    const tierColor = !resolved && Number.isFinite(w.confidence) ? confidenceColor(w.confidence, '#111111') : null;
    const isCurrentFlag = flagIndex >= 0
      && flaggedWords[flagIndex]?.blockIndex === blockIndex
      && flaggedWords[flagIndex]?.wordIndex === wi;
    const editable = wordOffsets.has(w);
    // Right-click toggles "confirmed correct" — scoped to words that
    // actually need a decision, and kept off the primary click so a normal
    // left click on any word still scrolls the image pane (selectBlock).
    const canConfirm = flagged || confirmed;

    if (editingWord === w) {
      return (
        <input
          key={wi}
          className="ocr-review-word-input"
          // Not autoFocus: the double-click that opens this input also
          // fires the browser's native word-selection on the span
          // underneath, at the same instant this element mounts. Focusing
          // synchronously in that same tick has been reported to leave
          // Windows' Text Services Framework confused about which element
          // owns text-insertion routing (backspace/delete bypass TSF and
          // keep working; typed characters, which route through it, don't)
          // -- deferring the focus call by a tick lets that native-selection
          // event finish settling first.
          ref={node => {
            if (!node) return;
            const raf = requestAnimationFrame(() => node.focus());
            return () => cancelAnimationFrame(raf);
          }}
          defaultValue={displayText}
          size={Math.max(2, displayText.length + 1)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.value = displayText;
              e.currentTarget.blur();
            }
          }}
          onBlur={e => commitWordEdit(w, e.target.value)}
        />
      );
    }

    return (
      <span
        key={wi}
        id={`ocr-word-${blockIndex}-${wi}`}
        className={[
          'ocr-review-word',
          resolved && 'ocr-review-word-resolved',
          canConfirm && 'ocr-review-word-confirmable',
          editable && 'ocr-review-word-editable'
        ].filter(Boolean).join(' ')}
        style={
          tierColor
            ? isCurrentFlag
              // The jump highlight takes the word's own tier color (red/orange/
              // yellow) instead of the fixed accent, so it reflects severity.
              ? { color: tierColor, outline: `2px solid ${tierColor}`, background: `color-mix(in srgb, ${tierColor} 15%, transparent)` }
              : { color: tierColor }
            : undefined
        }
        title={
          confirmed ? `Right-click to un-confirm${editable ? ' · double-click to edit' : ''}`
          : flagged ? `${confidenceLabel(w.confidence)} (${Math.round(w.confidence * 100)}%) — right-click to confirm it's correct${editable ? ', double-click to fix' : ' (text unlocatable, so not directly editable)'}`
          : editable ? 'Double-click to edit'
          : undefined
        }
        onContextMenu={canConfirm ? (e => { e.preventDefault(); toggleConfirmed(w); }) : undefined}
        onDoubleClick={editable ? (e => { e.preventDefault(); e.stopPropagation(); setEditingWord(w); }) : undefined}
      >
        {displayText}{' '}
      </span>
    );
  });

  const pageWidth = page.dimensions.width;
  const pageHeight = page.dimensions.height;

  return (
    <div className="ocr-review-overlay" role="dialog" aria-modal="true">
      <div className="ocr-review-modal">
        <div className="ocr-review-header">
          <h3>OCR Review</h3>
          <div className="ocr-review-header-actions">
            {flaggedWords.length > 0 && (
              <div
                className="ocr-review-flag-nav"
                // Tint the counter with the current word's tier color so it
                // reads yellow/orange/red to match the word you jumped to,
                // instead of a fixed color. Neutral before the first jump.
                style={flagIndex >= 0 && flaggedWords[flagIndex] ? { color: confidenceColor(flaggedWords[flagIndex].confidence, '#111111') } : undefined}
              >
                <button type="button" onClick={() => jumpToFlag(-1)} title="Previous flagged word (worst first)">‹</button>
                <span>
                  {flagIndex >= 0 && flaggedWords[flagIndex]
                    ? `${flagIndex + 1}/${flaggedWords.length} · ${confidenceLabel(flaggedWords[flagIndex].confidence)}`
                    : `${flaggedWords.length} flagged`}
                </span>
                <button type="button" onClick={() => jumpToFlag(1)} title="Next flagged word (worst first)">›</button>
              </div>
            )}
            {data.pages.length > 1 && (
              <div className="ocr-review-pager">
                <button type="button" onClick={() => setPageIndex(i => i - 1)} disabled={pageIndex === 0}>‹</button>
                <span>Page {pageIndex + 1} / {data.pages.length}</span>
                <button
                  type="button"
                  onClick={() => setPageIndex(i => i + 1)}
                  disabled={pageIndex === data.pages.length - 1}
                >
                  ›
                </button>
              </div>
            )}
            {onToggleReviewed && (
              <button
                type="button"
                className={reviewed ? 'ocr-review-reviewed-toggle active' : 'ocr-review-reviewed-toggle'}
                onClick={onToggleReviewed}
              >
                {reviewed ? '✓ Reviewed' : 'Mark reviewed'}
              </button>
            )}
            <button type="button" className="primary" onClick={saveChanges} disabled={!isDirty}>Save</button>
            <button type="button" className="ocr-review-close" aria-label="Close" onClick={closeModal}>×</button>
          </div>
        </div>

        <div className="ocr-review-hint">
          <span>Right-click a highlighted word to confirm it&apos;s correct · double-click any word to fix it.</span>
          <span className="ocr-review-legend">
            {CONFIDENCE_LEGEND.map(tier => (
              <span key={tier.label} className="ocr-review-legend-item">
                <span className="ocr-review-legend-swatch" style={{ background: tier.color }} />
                {tier.label}
              </span>
            ))}
          </span>
        </div>
        {saveStatus === 'saved' && <div className="ocr-review-status ocr-review-status-ok">Saved</div>}
        {saveStatus === 'error' && <div className="ocr-review-status ocr-review-status-error">Save failed: {saveError}</div>}
        {pdfStale && (
          <div className="ocr-review-status ocr-review-status-warn">
            The generated PDF no longer matches this text.
            <button type="button" onClick={handleRebuildPdf} disabled={rebuildingPdf}>
              {rebuildingPdf ? 'Rebuilding…' : 'Rebuild PDF'}
            </button>
          </div>
        )}

        <div className={sourceImage || isPdfSource ? 'ocr-review-body two-pane' : 'ocr-review-body'}>
          {sourceImage ? (
            <div
              className="ocr-review-image-pane"
              ref={paneRef}
              onMouseDown={handlePaneMouseDown}
              style={{ cursor: zoom > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default' }}
            >
              <div className="ocr-review-zoom-controls">
                <button type="button" onClick={() => setZoom(z => Math.max(MIN_ZOOM, z - ZOOM_STEP))} disabled={zoom <= MIN_ZOOM}>−</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => setZoom(z => Math.min(MAX_ZOOM, z + ZOOM_STEP))} disabled={zoom >= MAX_ZOOM}>+</button>
                {zoom !== 1 && (
                  <button type="button" className="ocr-review-zoom-reset" onClick={() => setZoom(1)}>Reset</button>
                )}
              </div>
              {/* This wrapper's width drives the zoom: it's a % of the (fixed-width)
                  pane, the <img> is 100% of the wrapper, and the bbox overlays below
                  are % of the wrapper too — so wrapper, image, and boxes all scale
                  together and stay pixel-aligned at any zoom level with no JS math. */}
              <div className="ocr-review-image-inner" style={{ width: `${zoom * 100}%` }}>
                <img src={sourceImage.dataUrl} alt="Source scan" draggable={false} onDragStart={e => e.preventDefault()} />
                {pageWidth && pageHeight && page.blocks.map((block, i) => {
                  const rect = bboxToDisplayRect(block.bbox, pageWidth, pageHeight, sourceImage.orientation);
                  return (
                    <div
                      key={i}
                      id={`ocr-bbox-${i}`}
                      className={i === activeBlockIndex ? 'ocr-review-bbox active' : 'ocr-review-bbox'}
                      style={{
                        left: `${rect.left}%`,
                        top: `${rect.top}%`,
                        width: `${rect.width}%`,
                        height: `${rect.height}%`
                      }}
                      onClick={() => selectBlock(i)}
                    />
                  );
                })}
              </div>
            </div>
          ) : isPdfSource ? (
            <div className="ocr-review-image-pane ocr-review-image-pane-placeholder">
              <span className="ocr-review-empty">
                {pdfRasterizeError ? `Preview unavailable: ${pdfRasterizeError}` : 'Rendering preview…'}
              </span>
            </div>
          ) : null}

          <div className="ocr-review-text-pane">
            {page.blocks.length ? (
              blockWordGroups.map((blockWords, bi) => {
                const block = page.blocks[bi];
                const heavy = block.type === 'title' || block.type === 'header';
                return (
                  <p
                    key={bi}
                    id={`ocr-block-${bi}`}
                    className={bi === activeBlockIndex ? 'ocr-review-block active' : 'ocr-review-block'}
                    style={heavy ? { fontWeight: 600 } : undefined}
                    onClick={() => selectBlock(bi)}
                  >
                    {blockWords.some(isRenderableWord) ? (
                      renderWords(blockWords, bi)
                    ) : block.type === 'image' ? (
                      <span className="ocr-review-empty">[Image]</span>
                    ) : (
                      // Block text the word stream never covered (rare) —
                      // show it uncolored rather than dropping content.
                      <span>{block.text}</span>
                    )}
                  </p>
                );
              })
            ) : page.words.length ? (
              <p className="ocr-review-block">{renderWords(page.words, 0)}</p>
            ) : (
              <p className="ocr-review-empty">No confidence data for this page.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoized like its sibling transcriber/list components — App re-renders
// periodically while a batch runs in the background (progress polling), and
// without this every one of those ticks would rebuild this modal's full
// word tree even though none of its props changed.
export default React.memo(OcrReviewModal);
