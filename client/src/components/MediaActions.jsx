import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

// ---------------------------------------------------------------- toasts

/** Show a short message at the bottom of the window. */
export function toast(message, tone = 'default') {
  window.dispatchEvent(new CustomEvent('shelf:toast', { detail: { message, tone } }));
}

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let n = 0;
    const onToast = (e) => {
      const id = ++n;
      setItems((list) => [...list.slice(-2), { id, ...e.detail }]);
      setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4500);
    };
    window.addEventListener('shelf:toast', onToast);
    return () => window.removeEventListener('shelf:toast', onToast);
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[60] grid max-w-sm gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'danger' ? 'alert' : 'status'}
          className={`rounded-card border px-4 py-2.5 text-[13px] shadow-2xl backdrop-blur-xl ${
            t.tone === 'danger'
              ? 'border-danger/40 bg-surface/95 text-danger'
              : 'border-edge bg-surface/95 text-ink'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- playing

export async function playTarget(target, label) {
  try {
    const r = await api.play(target);
    toast(`Opening ${label || 'video'}${r.player !== 'default' ? ` in ${r.player}` : ''}`);
  } catch (err) {
    toast(err.message, 'danger');
  }
}

export async function revealTarget(target) {
  try {
    await api.reveal(target);
  } catch (err) {
    toast(err.message, 'danger');
  }
}

function PlayGlyph({ className = '' }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={className}>
      <path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.7-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

function FolderGlyph({ className = '' }) {
  return (
    <svg viewBox="0 0 14 12" aria-hidden="true" className={className}>
      <path d="M1 2.2c0-.6.5-1.1 1.1-1.1h3l1.3 1.4h5.5c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.1c-.6 0-1.1-.5-1.1-1.1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Primary "Play" button for heroes. */
export function PlayButton({ target, label, children, className = '' }) {
  return (
    <button className={`${primaryBtn} inline-flex items-center gap-2 ${className}`} onClick={() => playTarget(target, label)}>
      <PlayGlyph className="h-3 w-3" />
      {children || 'Play'}
    </button>
  );
}

const rowBtn =
  'grid h-7 min-w-7 place-items-center rounded border border-transparent px-1.5 text-ink-dim transition hover:border-edge hover:bg-surface-2 hover:text-ink focus-visible:border-accent/60';

/** Compact play / subtitles / folder controls for a list row. */
export function RowActions({ target, label, subtitles = [], onSubtitles }) {
  return (
    <div className="flex items-center gap-0.5">
      <button onClick={() => playTarget(target, label)} aria-label={`Play ${label}`} title="Play" className={`${rowBtn} text-accent`}>
        <PlayGlyph className="h-3 w-3" />
      </button>
      <button
        onClick={onSubtitles}
        aria-label={`Subtitles for ${label}`}
        title={subtitles.length ? `Subtitles: ${subtitles.join(', ')}` : 'Find subtitles'}
        className={`${rowBtn} whitespace-nowrap font-mono text-[9.5px] font-semibold tracking-wide ${subtitles.length ? 'text-good' : ''}`}
      >
        CC{subtitles.length ? ` ${String(subtitles[0]).toUpperCase()}${new Set(subtitles).size > 1 ? `+${new Set(subtitles).size - 1}` : ''}` : ''}
      </button>
      <button onClick={() => revealTarget(target)} aria-label={`Show ${label} in folder`} title="Show in folder" className={rowBtn}>
        <FolderGlyph className="h-3 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- subtitles

export function SubtitleDialog({ target, title, onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [languages, setLanguages] = useState('');
  const [data, setData] = useState(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);

  async function search(langs) {
    setSearching(true);
    setError(null);
    try {
      setData(await api.searchSubtitles(target, langs));
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    (async () => {
      const s = await api.subtitleSettings();
      setSettings(s);
      setLanguages(s.languages);
      if (s.configured) search(s.languages);
    })().catch((err) => setError(err.message));
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function download(r) {
    setSaving(r.file_id);
    setError(null);
    try {
      const res = await api.downloadSubtitle(target, r.file_id, r.language);
      setSaved(res);
      setData((d) => ({ ...d, existing: res.existing }));
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="subs-title"
        className="flex max-h-[82vh] w-full max-w-2xl flex-col rounded-card border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-edge px-6 pb-4 pt-5">
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Subtitles</div>
          <h3 id="subs-title" className="display mt-1.5 truncate text-[22px] uppercase leading-tight text-ink">
            {title}
          </h3>
          {data?.video && <div className="mono mt-1 truncate text-[11px] text-ink-dim">{data.video}</div>}

          {data?.existing?.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-ink-dim">Already here:</span>
              {data.existing.map((s) => (
                <Badge key={s.name} tone="good" title={s.name}>
                  {(s.lang || s.format).toUpperCase()}
                </Badge>
              ))}
            </div>
          )}

          {settings?.configured && (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                search(languages);
              }}
            >
              <input
                value={languages}
                onChange={(e) => setLanguages(e.target.value)}
                aria-label="Languages"
                placeholder="en, si, ta"
                className="mono w-40 rounded border border-edge bg-bg px-3 py-1.5 text-[12px] outline-none focus:border-accent/50"
              />
              <button type="submit" disabled={searching} className={ghostBtn}>
                {searching ? 'Searching' : 'Search'}
              </button>
              <span className="self-center text-[11px] text-ink-dim">Language codes, comma separated</span>
            </form>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!settings ? (
            <Spinner />
          ) : !settings.configured ? (
            <div className="text-[13.5px] leading-relaxed text-ink-dim">
              <p>
                Shelf finds subtitles on OpenSubtitles.com. Create a free account there, make an API
                key under <span className="text-ink">API consumers</span>, and paste it in{' '}
                <Link to="/settings" onClick={onClose} className="text-accent underline-offset-2 hover:underline">
                  Settings → Subtitles
                </Link>
                .
              </p>
              <p className="mt-2">
                Subtitle files you already have next to the video are picked up automatically.
              </p>
            </div>
          ) : searching && !data ? (
            <div className="flex items-center gap-2 text-[13px] text-ink-dim">
              <Spinner /> Searching OpenSubtitles
            </div>
          ) : data && !data.results.length ? (
            <p className="text-[13px] text-ink-dim">
              No subtitles found for {data.languages.toUpperCase()}.
              {data.hidden_machine > 0 && ` ${data.hidden_machine} machine-translated result${data.hidden_machine === 1 ? ' is' : 's are'} hidden.`}
            </p>
          ) : data ? (
            <ul className="grid gap-1.5">
              {data.results.map((r) => (
                <li key={r.file_id} className="flex items-center gap-3 rounded border border-edge/70 px-3 py-2">
                  <Badge tone="accent">{r.language?.toUpperCase()}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[11.5px] text-ink" title={r.release}>{r.release}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-dim">
                      {r.hash_match && <Badge tone="good" title="Made for this exact file, so it should be in sync">exact match</Badge>}
                      {r.trusted && <Badge>trusted</Badge>}
                      {r.hearing_impaired && <Badge title="Includes sound descriptions">HI</Badge>}
                      {r.machine && <Badge tone="warn">machine translated</Badge>}
                      <span className="mono">{r.downloads.toLocaleString()} downloads</span>
                    </div>
                  </div>
                  <button onClick={() => download(r)} disabled={saving !== null} className={ghostBtn}>
                    {saving === r.file_id ? 'Saving' : 'Download'}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
        </div>

        <div className="flex items-center gap-3 border-t border-edge px-6 py-3">
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-dim" role="status">
            {saved
              ? `Saved as ${saved.saved}${saved.remaining != null ? ` · ${saved.remaining} downloads left today` : ''}`
              : settings?.configured && !settings.signed_in
                ? 'Not signed in: 5 downloads a day. Sign in under Settings for more.'
                : ''}
          </span>
          <button onClick={onClose} className={saved ? primaryBtn : ghostBtn}>
            {saved ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
