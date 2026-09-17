import { useEffect, useRef, useState } from 'react';
import { api, tmdbImg } from '../api';
import { Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

/**
 * Search TMDB and bind a title to a specific result. Used when automatic
 * matching picked the wrong entry, or found nothing at all.
 */
export default function MatchDialog({ kind, id, initialQuery = '', onClose, onMatched }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const label = kind === 'show' ? 'series' : 'film';

  async function search(q) {
    const term = String(q ?? query).trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await api.tmdbSearch(term, kind === 'show' ? 'tv' : 'movie'));
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    inputRef.current?.focus();
    search(initialQuery);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function choose(result) {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'show') await api.matchShow(id, result.id);
      else await api.matchMovie(id, result.id);
      onMatched();
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-title"
        className="flex max-h-[84vh] w-full max-w-3xl flex-col rounded-card border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge p-5">
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">TMDB</div>
          <h3 id="match-title" className="display mt-1.5 text-[24px] uppercase leading-none text-ink">
            Find the right {label}
          </h3>
          <form
            className="mt-4 flex gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search TMDB"
              placeholder={`Search for a ${label}`}
              className="min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[13px] outline-none transition focus:border-accent/50"
            />
            <button type="submit" disabled={busy || !query.trim()} className={primaryBtn}>
              Search
            </button>
          </form>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <div className="mb-4 text-[12.5px] text-danger">{error}</div>}

          {results === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-dim">
              <Spinner /> Searching
            </div>
          ) : !results.length ? (
            !error && (
              <p className="text-[13px] text-ink-dim">
                No matches. Try the original title, or fewer words.
              </p>
            )
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-x-4 gap-y-5">
              {results.map((r) => {
                const name = r.name || r.title;
                const date = r.first_air_date || r.release_date;
                const img = tmdbImg(r.poster_path, 'w342');
                return (
                  <button
                    key={r.id}
                    onClick={() => choose(r)}
                    disabled={busy}
                    className="group text-left disabled:opacity-50"
                  >
                    <div className="aspect-[2/3] overflow-hidden rounded-card bg-surface-2 ring-1 ring-edge transition group-hover:ring-2 group-hover:ring-accent">
                      {img ? (
                        <img src={img} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="grid h-full place-items-center p-2 text-center text-[11px] text-ink-dim">
                          No poster
                        </div>
                      )}
                    </div>
                    <div className="mt-2 line-clamp-2 text-[12.5px] font-medium text-ink group-hover:text-accent">
                      {name}
                    </div>
                    <div className="mono text-[10px] text-ink-dim">
                      {date ? date.slice(0, 4) : '—'}
                      {r.original_language ? ` · ${r.original_language}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-3">
          <span className="text-[11.5px] text-ink-dim">
            Choosing a result replaces this {label}’s poster, details
            {kind === 'show' ? ' and episode list' : ''}.
          </span>
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
