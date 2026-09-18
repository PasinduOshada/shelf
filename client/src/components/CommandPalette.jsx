import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

const PAGES = [
  { label: 'Library', to: '/' },
  { label: 'Up Next', to: '/up-next' },
  { label: 'Missing', to: '/missing' },
  { label: 'Organize', to: '/organize' },
  { label: 'Stats', to: '/stats' },
  { label: 'Wrapped', to: '/wrapped' },
  { label: 'Settings', to: '/settings' },
];

// Earliest match first, then your own titles before the app's own commands,
// then A-Z. Someone typing "s" is far more often after a show than a setting.
const isLibrary = (item) => item.kind === 'show' || item.kind === 'film';

function rank(items, query) {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 8);
  const scored = [];
  for (const item of items) {
    const at = item.label.toLowerCase().indexOf(q);
    if (at === -1) continue;
    scored.push({ item, at });
  }
  scored.sort((a, b) =>
    a.at - b.at ||
    isLibrary(b.item) - isLibrary(a.item) ||
    a.item.label.localeCompare(b.item.label)
  );
  return scored.slice(0, 10).map((s) => s.item);
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [library, setLibrary] = useState(null);
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  // Ctrl+K, or Cmd+K on a Mac keyboard.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The library is read once per opening: enough to stay current, cheap enough
  // not to notice.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    let cancelled = false;
    Promise.all([api.shows(), api.movies()])
      .then(([shows, movies]) => {
        if (cancelled) return;
        setLibrary([
          ...shows.map((s) => ({ id: 's' + s.id, label: s.title, kind: 'show', to: `/show/${s.id}` })),
          ...movies.map((m) => ({ id: 'm' + m.id, label: m.title, kind: 'film', to: `/movie/${m.id}` })),
        ]);
      })
      .catch(() => setLibrary([]));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const results = useMemo(() => {
    const actions = [
      ...PAGES.map((p) => ({ id: 'p' + p.to, label: p.label, kind: 'page', to: p.to })),
      { id: 'a-scan', label: 'Scan library', kind: 'action', run: scan },
      { id: 'a-organize', label: 'Organize files', kind: 'action', to: '/organize' },
    ];
    return rank([...(library || []), ...actions], query);
    // `scan` is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, query]);

  useEffect(() => setActive(0), [query]);

  async function scan() {
    setRunning(true);
    try {
      await api.scan();
      window.dispatchEvent(new CustomEvent('shelf:refresh'));
    } finally {
      setRunning(false);
    }
  }

  function choose(item) {
    if (!item) return;
    close();
    if (item.run) item.run();
    else navigate(item.to);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-card border border-edge bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a show, film or page…"
          aria-label="Search shows, films and actions"
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          className="w-full border-b border-edge bg-transparent px-4 py-3.5 text-[14px] text-ink outline-none placeholder:text-ink-dim"
        />

        <ul id="palette-results" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-[13px] text-ink-dim">
              {library === null ? 'Reading your library…' : 'Nothing matched.'}
            </li>
          )}
          {results.map((item, i) => (
            <li key={item.id}>
              <button
                id={`palette-${item.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] transition ${
                  i === active ? 'bg-accent/12 text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="mono shrink-0 text-[10px] uppercase tracking-wider opacity-60">
                  {item.kind === 'action' && running ? 'running' : item.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mono flex items-center gap-3 border-t border-edge px-4 py-2 text-[10px] uppercase tracking-wider text-ink-dim">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
