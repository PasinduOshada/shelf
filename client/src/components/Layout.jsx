import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { api, formatClock } from '../api';
import { Spinner } from './Bits';
import { applyTheme } from '../themes';
import { Toaster } from './MediaActions';
import CommandPalette from './CommandPalette';
import Mark from './Mark';

const NAV = [
  { to: '/', label: 'Library', end: true, key: 'l' },
  { to: '/up-next', label: 'Up Next', key: 'u' },
  { to: '/missing', label: 'Missing', key: 'm' },
  { to: '/organize', label: 'Organize', key: 'o' },
  { to: '/stats', label: 'Stats', key: 's' },
  { to: '/wrapped', label: 'Wrapped', key: 'r' },
  { to: '/settings', label: 'Settings', key: ',' },
];

const SHORTCUTS = [
  ['Ctrl K', 'Jump to anything'],
  ['/', 'Search'],
  ['p', 'Play the next episode (on a show or film page)'],
  ['w', 'Mark the next episode watched (on a show or film page)'],
  ...NAV.map((n) => [`g then ${n.key}`, `Go to ${n.label}`]),
  ['?', 'Show these shortcuts'],
];

const typing = (el) => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-7 w-7 place-items-center rounded bg-accent text-accent-ink">
        <Mark className="h-[18px] w-[18px]" />
      </div>
      <div className="display text-[15px] uppercase tracking-[0.08em]">Shelf</div>
    </div>
  );
}

/** What Shelf is playing in a tracked player, if anything. */
function NowPlaying() {
  const [sessions, setSessions] = useState([]);
  const marked = useRef(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const list = await api.playback().catch(() => []);
      if (!alive) return;
      // A session that ended or flipped to watched changes what pages show.
      const changed =
        list.length !== sessions.length ||
        list.some((s) => s.marked && !marked.current.has(s.id));
      for (const s of list) if (s.marked) marked.current.add(s.id);
      if (changed) window.dispatchEvent(new CustomEvent('shelf:refresh'));
      setSessions(list);
    };
    tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessions.length]);

  if (!sessions.length) return null;
  const s = sessions[0];
  return (
    <div
      role="status"
      className="mono hidden min-w-0 items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-[11px] text-ink sm:flex"
      title={s.marked ? 'Marked as watched' : 'Shelf follows this playback'}
    >
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="truncate">{s.label || 'Playing'}</span>
      {s.duration > 0 && (
        <span className="shrink-0 text-ink-dim">
          {formatClock(s.position)} / {formatClock(s.duration)}
        </span>
      )}
      {s.marked && <span className="shrink-0 text-good">✓</span>}
    </div>
  );
}

function ShortcutHelp({ onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        className="w-full max-w-md rounded-card border border-edge bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="keys-title" className="display text-[20px] uppercase text-ink">Keyboard shortcuts</h3>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-[13px]">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k} className="contents">
              <dt>
                {k.split(' ').map((part, i) =>
                  part === 'then' ? (
                    <span key={i} className="px-1 text-ink-dim">then</span>
                  ) : (
                    <kbd key={i} className="mono rounded border border-edge bg-bg px-1.5 py-0.5 text-[11px] text-ink">{part}</kbd>
                  )
                )}
              </dt>
              <dd className="text-ink-dim">{what}</dd>
            </div>
          ))}
        </dl>
        <button autoFocus onClick={onClose} className="mt-6 text-[12px] text-accent hover:underline">
          Close
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const searchRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  // The saved theme is applied in main.jsx before first paint; this follows
  // live changes from the theme builder.
  useEffect(() => {
    const onThemeChange = (e) => applyTheme(e.detail);
    window.addEventListener('shelf:theme', onThemeChange);
    return () => window.removeEventListener('shelf:theme', onThemeChange);
  }, []);

  // Nothing indexed yet: the library would be empty, so start the setup guide.
  useEffect(() => {
    setMenuOpen(false);
    if (location.pathname !== '/') return;
    api
      .libraries()
      .then((libs) => {
        if (!libs.length) navigate('/welcome', { replace: true });
      })
      .catch(() => {});
  }, [location.pathname]);

  // Downloads the automatic organizer left for review show as a badge.
  useEffect(() => {
    const load = () =>
      api
        .autoOrganize()
        .then((s) => setWaiting(s.config.folders.length ? s.pending?.count || 0 : 0))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener('shelf:auto-changed', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('shelf:auto-changed', load);
    };
  }, []);

  // Keyboard shortcuts. Pages listen for "shelf:shortcut" for p and w.
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[role="dialog"]') && e.key !== '?') return;
      const k = e.key;
      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const item = NAV.find((n) => n.key === k.toLowerCase());
        if (item) {
          e.preventDefault();
          navigate(item.to);
        }
        return;
      }
      if (k === 'g') pendingG = Date.now();
      else if (k === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (k === '?') setHelp((v) => !v);
      else if (k === 'p' || k === 'w') {
        window.dispatchEvent(new CustomEvent('shelf:shortcut', { detail: k }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  async function runScan() {
    setScanning(true);
    try {
      await api.scan();
      window.dispatchEvent(new CustomEvent('shelf:refresh'));
    } finally {
      setScanning(false);
    }
  }

  function submitSearch(e) {
    e.preventDefault();
    navigate(`/?search=${encodeURIComponent(search)}`);
  }

  const sidebar = (
    <>
      <div className="mb-8 px-2">
        <Brand />
      </div>

      <nav className="flex flex-col gap-px" aria-label="Main">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `relative rounded px-3 py-[7px] text-[13px] transition-colors ${
                isActive ? 'bg-accent/10 font-medium text-accent' : 'text-ink-dim hover:bg-surface hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" />}
                {item.label}
                {item.to === '/organize' && waiting > 0 && (
                  <span
                    title={`${waiting} download${waiting === 1 ? '' : 's'} waiting for review`}
                    className="mono absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-warn/20 px-1.5 text-[10px] text-warn"
                  >
                    {waiting}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto grid gap-2">
        <button
          onClick={() => setHelp(true)}
          className="rounded px-3 py-1.5 text-left text-[11.5px] text-ink-dim transition hover:text-ink"
        >
          Keyboard shortcuts <kbd className="mono ml-1 rounded border border-edge px-1 text-[10px]">?</kbd>
        </button>
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center justify-center gap-2 rounded border border-edge px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink-dim transition hover:border-accent/40 hover:text-ink disabled:opacity-50"
        >
          {scanning ? <Spinner /> : null}
          {scanning ? 'Scanning' : 'Rescan'}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-[196px] shrink-0 flex-col border-r border-edge bg-bg px-3 py-5 lg:flex">
        {sidebar}
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[240px] max-w-[85vw] flex-col border-r border-edge bg-bg px-3 py-5 shadow-2xl">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="gutter-x sticky top-0 z-30 flex items-center gap-3 border-b border-edge bg-bg/85 py-3 backdrop-blur-xl">
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="relative grid h-8 w-8 shrink-0 place-items-center rounded border border-edge text-ink lg:hidden"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {waiting > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-warn" />}
          </button>
          <form onSubmit={submitSearch} className="min-w-0 flex-1">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles  /"
              aria-label="Search your library"
              className="w-full max-w-sm rounded border border-edge bg-surface px-3 py-1.5 text-[13px] outline-none transition placeholder:text-ink-dim/60 focus:border-accent/50"
            />
          </form>
          <NowPlaying />
        </header>

        <main className="gutter-x py-8">
          <Outlet />
        </main>
        <Toaster />
      </div>

      <CommandPalette />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
