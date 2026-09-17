import { useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

/** In-app folder browser, used in the browser build where there is no OS dialog. */
export default function FolderPicker({ onPick, onClose, title = 'Choose a library folder' }) {
  const [node, setNode] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  async function go(path) {
    try {
      setError(null);
      setNode(await api.browse(path));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    go(undefined);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-card border border-edge bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="display mb-3 text-[15px] uppercase tracking-wide text-ink">{title}</div>
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => {
              const prev = history[history.length - 1];
              setHistory((h) => h.slice(0, -1));
              go(prev);
            }}
            disabled={!history.length}
            aria-label="Up one folder"
            className="rounded border border-edge px-2 py-1 text-xs text-ink-dim disabled:opacity-40"
          >
            ←
          </button>
          <div className="mono min-w-0 flex-1 truncate text-[11px] text-ink-dim">
            {node?.path || 'Drives'}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="px-2 py-3 text-[12px] text-danger">{error}</div>
          ) : !node ? (
            <Spinner />
          ) : (
            node.dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => {
                  setHistory((h) => [...h, node.path]);
                  go(d.path);
                }}
                className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-ink-dim hover:bg-surface-2 hover:text-ink"
              >
                <span className="h-2.5 w-3 shrink-0 rounded-[2px] border border-current opacity-60" />
                <span className="truncate">{d.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="mt-3 flex justify-end gap-2.5 border-t border-edge pt-3">
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button onClick={() => node?.path && onPick(node.path)} disabled={!node?.path} className={primaryBtn}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
