import { useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

/**
 * Choose how a show's episodes are grouped into seasons. Streaming services
 * often number episodes differently from the original broadcast, and the files
 * on disk follow whichever version was downloaded.
 */
export default function OrderingDialog({ showId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .showOrderings(showId)
      .then((d) => {
        setData(d);
        setSelected(d.current);
      })
      .catch((err) => setError(err.message));
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showId]);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await api.setShowOrdering(showId, selected);
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const bestFit = data ? Math.max(...data.orderings.map((o) => o.fit)) : 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ordering-title"
        className="flex max-h-[84vh] w-full max-w-xl flex-col rounded-card border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge p-5">
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Episode order</div>
          <h3 id="ordering-title" className="display mt-1.5 text-[24px] uppercase leading-none text-ink">
            Match your files
          </h3>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-dim">
            Some shows are split into seasons differently on streaming services than on TV. Pick the
            version your files follow — it decides episode titles and what counts as missing.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <div className="mb-3 text-[12.5px] text-danger">{error}</div>}
          {!data ? (
            !error && (
              <div className="flex items-center gap-2 text-sm text-ink-dim">
                <Spinner /> Checking TMDB
              </div>
            )
          ) : (
            <div className="grid gap-2" role="radiogroup" aria-label="Episode order">
              {data.orderings.map((o) => {
                const on = selected === o.id;
                return (
                  <label
                    key={o.id ?? 'default'}
                    className={`flex cursor-pointer items-center gap-3 rounded border px-4 py-3 transition ${
                      on ? 'border-accent bg-accent/10' : 'border-edge hover:border-accent/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="ordering"
                      checked={on}
                      onChange={() => setSelected(o.id)}
                      className="accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-medium text-ink">{o.name}</span>
                        {data.current === o.id && (
                          <span className="mono text-[10px] uppercase tracking-wider text-accent">current</span>
                        )}
                      </div>
                      <div className="mono mt-0.5 text-[10.5px] text-ink-dim">
                        {o.seasons} {o.seasons === 1 ? 'season' : 'seasons'} · {o.episodes} episodes
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={`display text-[18px] leading-none tnum ${
                          o.fit === bestFit && o.fit > 0 ? 'text-good' : 'text-ink-dim'
                        }`}
                      >
                        {o.fit}/{data.owned}
                      </div>
                      <div className="mono mt-0.5 text-[10px] text-ink-dim">files fit</div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2.5 border-t border-edge px-5 py-3">
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!data || busy || selected === data.current}
            className={primaryBtn}
          >
            {busy ? 'Applying' : 'Use this order'}
          </button>
        </div>
      </div>
    </div>
  );
}
