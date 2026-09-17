import { useEffect, useRef, useState } from 'react';
import { primaryBtn, ghostBtn } from './DetailHero';

/** Change the name Shelf shows for a title. Files and folders on disk are untouched. */
export default function RenameDialog({ label, initial = '', onSave, onReset, onClose }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        className="w-full max-w-md rounded-card border border-edge bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const next = value.trim();
          if (next) run(() => onSave(next));
        }}
      >
        <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Rename</div>
        <h3 id="rename-title" className="display mt-2 text-[22px] uppercase leading-tight text-ink">
          Name this {label}
        </h3>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${label} name`}
          className="mt-4 w-full rounded border border-edge bg-bg px-3 py-2 text-[14px] outline-none transition focus:border-accent/50"
        />
        <p className="mt-2.5 text-[12px] text-ink-dim">
          Only changes the name shown in Shelf. Files and folders on disk keep their names.
        </p>
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        <div className="mt-6 flex items-center gap-2.5">
          {onReset && (
            <button
              type="button"
              onClick={() => run(onReset)}
              disabled={busy}
              className="mr-auto text-[11.5px] text-ink-dim transition hover:text-ink disabled:opacity-40"
            >
              Use name from file
            </button>
          )}
          <button type="button" onClick={onClose} className={`${ghostBtn} ${onReset ? '' : 'ml-auto'}`}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !value.trim()} className={primaryBtn}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
