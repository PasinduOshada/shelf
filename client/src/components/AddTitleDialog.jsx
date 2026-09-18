import { useEffect, useRef, useState } from 'react';
import { api, tmdbImg } from '../api';
import { Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

/**
 * Follow something that is not on this computer: a series or film you watched
 * elsewhere, or one you have since deleted. It joins the library as a title
 * with no files, and the watching you record against it is kept like any other.
 */
export default function AddTitleDialog({ onClose, onAdded, tmdbReady }) {
  const [kind, setKind] = useState('show');
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const label = kind === 'show' ? 'series' : 'film';

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A new search term says nothing about the old results.
  useEffect(() => setResults(null), [kind]);

  async function search(e) {
    e?.preventDefault();
    const term = query.trim();
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

  async function add(body) {
    setBusy(true);
    setError(null);
    try {
      const added = await api.addTracked({ kind, ...body });
      onAdded(added);
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
        aria-labelledby="add-title"
        className="flex max-h-[84vh] w-full max-w-3xl flex-col rounded-card border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge p-5">
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Track</div>
          <h3 id="add-title" className="display mt-1.5 text-[24px] uppercase leading-none text-ink">
            Add something you watched
          </h3>
          <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-dim">
            For a {label} that isn’t on this computer. It is kept with your library, and what you
            tick off stays even though there are no files.
          </p>

          <div className="mt-4 flex items-center gap-1" role="group" aria-label="What to add">
            {[
              { id: 'show', label: 'Series' },
              { id: 'movie', label: 'Film' },
            ].map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                aria-pressed={kind === k.id}
                className={`rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition ${
                  kind === k.id ? 'bg-accent/12 text-accent' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>

          {tmdbReady ? (
            <form className="mt-4 flex gap-2.5" onSubmit={search}>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Search TMDB for a ${label}`}
                placeholder={`Search for a ${label}`}
                className="min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[13px] outline-none transition focus:border-accent/50"
              />
              <button type="submit" disabled={busy || !query.trim()} className={primaryBtn}>
                Search
              </button>
            </form>
          ) : (
            <form
              className="mt-4 flex flex-wrap gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                add({ title: query.trim(), year: year.trim() ? Number(year) : null });
              }}
            >
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={`Name of the ${label}`}
                placeholder={`Name of the ${label}`}
                className="min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[13px] outline-none transition focus:border-accent/50"
              />
              <input
                value={year}
                onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                aria-label="Year"
                placeholder="Year"
                inputMode="numeric"
                className="w-24 rounded border border-edge bg-bg px-3 py-2 text-[13px] outline-none transition focus:border-accent/50"
              />
              <button type="submit" disabled={busy || !query.trim()} className={primaryBtn}>
                Add
              </button>
            </form>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <div className="mb-4 text-[12.5px] text-danger">{error}</div>}

          {!tmdbReady ? (
            <p className="text-[13px] text-ink-dim">
              Without a TMDB key a title is kept by name and year alone — enough to record that you
              watched it. Add a key in Settings to get posters, and episode lists you can tick off.
            </p>
          ) : results === null ? (
            <p className="text-[13px] text-ink-dim">Search for the {label} you want to follow.</p>
          ) : busy ? (
            <div className="flex items-center gap-2 text-sm text-ink-dim">
              <Spinner /> Adding
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
                    onClick={() => add({ tmdbId: r.id, title: name, year: date ? Number(date.slice(0, 4)) : null })}
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
                    <div className="mono text-[10px] text-ink-dim">{date ? date.slice(0, 4) : '—'}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-edge p-4">
          <button onClick={onClose} className={ghostBtn}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
