import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { FaFolder, FaFileAlt, FaPlus, FaTimes } from 'react-icons/fa';

const fs = (window as any).require('fs') as typeof import('fs');
const path = (window as any).require('path') as typeof import('path');
const os = (window as any).require('os') as typeof import('os');

type PickerEntry = {
  name: string;
  fullPath: string;
  isDirectory: boolean;
};

interface FolderPickerModalProps {
  isOpen: boolean;
  title: string;
  allowFileSelection?: boolean;
  initialPath?: string;
  favorites: string[];
  onAddFavorite(path: string): void;
  onRemoveFavorite(path: string): void;
  onSelect(selection: { path: string; isDirectory: boolean }): void;
  onCancel(): void;
}

const ensureDirectoryPath = (target?: string) => {
  if (!target) return os.homedir();
  const normalized = path.resolve(target);
  try {
    const stats = fs.statSync(normalized);
    return stats.isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    return os.homedir();
  }
};

const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  isOpen,
  title,
  allowFileSelection = false,
  initialPath,
  favorites,
  onAddFavorite,
  onRemoveFavorite,
  onSelect,
  onCancel
}) => {
  const [currentPath, setCurrentPath] = useState(() => ensureDirectoryPath(initialPath));
  const [pendingPath, setPendingPath] = useState(currentPath);
  const [entries, setEntries] = useState<PickerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const next = ensureDirectoryPath(initialPath);
    setCurrentPath(next);
    setPendingPath(next);
  }, [initialPath, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fs.promises
      .readdir(currentPath, { withFileTypes: true })
      .then(dirents => {
        if (cancelled) return;
        const mapped: PickerEntry[] = dirents.map(entry => ({
          name: entry.name,
          fullPath: path.join(currentPath, entry.name),
          isDirectory: entry.isDirectory()
        }));
        mapped.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
        setEntries(mapped);
        setSelectedFile(null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || 'Unable to open folder');
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, isOpen]);

  const directories = useMemo(() => entries.filter(e => e.isDirectory), [entries]);
  const files = useMemo(() => entries.filter(e => !e.isDirectory), [entries]);

  const parentPath = useMemo(() => {
    const parent = path.dirname(currentPath);
    return parent === currentPath ? null : parent;
  }, [currentPath]);

  const goUp = () => {
    if (!parentPath) return;
    setCurrentPath(parentPath);
    setPendingPath(parentPath);
  };

  const enterDirectory = (dirPath: string) => {
    setCurrentPath(dirPath);
    setPendingPath(dirPath);
  };

  const applyPath = () => {
    const trimmed = pendingPath.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    try {
      const stats = fs.statSync(resolved);
      const next = stats.isDirectory() ? resolved : path.dirname(resolved);
      setCurrentPath(next);
      setPendingPath(next);
      setError(null);
    } catch {
      setError('Path not found or inaccessible');
    }
  };

  const handleSelectFolder = useCallback(() => {
    onSelect({ path: currentPath, isDirectory: true });
  }, [currentPath, onSelect]);

  const handleSelectFile = () => {
    if (!selectedFile) return;
    onSelect({ path: selectedFile, isDirectory: false });
  };

  const handleFavoriteSelect = (favPath: string) => {
    setCurrentPath(favPath);
    setPendingPath(favPath);
  };

  const handleAddFavorite = () => {
    onAddFavorite(currentPath);
  };

  if (!isOpen) return null;

  return (
    <div className="folder-picker-overlay" role="dialog" aria-modal="true">
      <div className="folder-picker-modal">
        <div className="folder-picker-body">
          <div className="folder-picker-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                className="folder-picker-up"
                onClick={goUp}
                disabled={!parentPath}
                aria-label="Go to parent folder"
              >
                <span className="folder-picker-up-arrow" aria-hidden="true">
                  ↑
                </span>
              </button>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h3>
            </div>
            <div className="folder-picker-path">
              <input
                value={pendingPath}
                onChange={e => setPendingPath(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyPath();
                  }
                }}
                aria-label="Current folder path"
              />
              <button type="button" onClick={applyPath}>
                Go
              </button>
            </div>
            <div className="folder-picker-favorites">
              <div className="folder-picker-favorites-header">
                <span>Favorites</span>
                <button type="button" onClick={handleAddFavorite}>
                  <FaPlus size={12} /> Save current
                </button>
              </div>
              {favorites.length ? (
                <div className="folder-picker-favorites-list">
                  {favorites.map(fav => (
                    <div key={fav} className="folder-picker-favorite-row">
                      <button
                        type="button"
                        className="favorite-jump"
                        onClick={() => handleFavoriteSelect(fav)}
                      >
                        {fav}
                      </button>
                      <button
                        type="button"
                        className="favorite-remove"
                        aria-label={`Remove ${fav} from favorites`}
                        onClick={() => onRemoveFavorite(fav)}
                      >
                        <FaTimes size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="folder-picker-empty">No favorites yet.</div>
              )}
            </div>
          </div>

          <div className="folder-picker-content">
            <div className="folder-picker-column">
              <h4>Folders</h4>
              <div className="folder-picker-list">
                {loading && <div className="folder-picker-empty">Loading…</div>}
                {!loading && directories.length === 0 && (
                  <div className="folder-picker-empty">No subfolders</div>
                )}
                {!loading &&
                  directories.map(dir => (
                    <button
                      key={dir.fullPath}
                      type="button"
                      className="folder-picker-row"
                      onDoubleClick={() => enterDirectory(dir.fullPath)}
                      onClick={() => enterDirectory(dir.fullPath)}
                    >
                      <FaFolder /> {dir.name}
                    </button>
                  ))}
              </div>
            </div>
            <div className="folder-picker-column">
              <h4>Files</h4>
              <div className="folder-picker-list">
                {loading && <div className="folder-picker-empty">Loading…</div>}
                {!loading && files.length === 0 && (
                  <div className="folder-picker-empty">No files</div>
                )}
                {!loading &&
                  files.map(file => (
                    <button
                      key={file.fullPath}
                      type="button"
                      className={
                        selectedFile === file.fullPath
                          ? 'folder-picker-row active'
                          : 'folder-picker-row'
                      }
                      disabled={!allowFileSelection}
                      onClick={() => allowFileSelection && setSelectedFile(file.fullPath)}
                    >
                      <FaFileAlt /> {file.name}
                    </button>
                  ))}
              </div>
            </div>
          </div>

          {error && <div className="folder-picker-error">{error}</div>}
        </div>

        <div className="folder-picker-footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          {allowFileSelection && (
            <button
              type="button"
              onClick={handleSelectFile}
              disabled={!selectedFile}
            >
              Select File
            </button>
          )}
          <button type="button" className="primary" onClick={handleSelectFolder}>
            Use This Folder
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderPickerModal;
