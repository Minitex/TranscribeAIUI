import { FaCog } from 'react-icons/fa';
import { ipcRenderer } from '../electron';

/** Fixed settings-gear button (top-right) with an optional "new version" badge. */
export default function SettingsGearBadge({ newVersionAvailable }: { newVersionAvailable: boolean }) {
  return (
    <div style={{ position: 'fixed', top: 50, right: 12, zIndex: 20 }}>
      <button
        type="button"
        className="settings-gear"
        aria-label="Open settings"
        onClick={() => ipcRenderer.invoke('open-settings')}
      >
        <FaCog />
      </button>
      {newVersionAvailable && (
        <span className="settings-gear-badge" aria-label="New version available" title="New version available">
          1
        </span>
      )}
    </div>
  );
}
