import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (Math.abs(mins) < 1) return 'now';
  if (mins > 0) return mins < 60 ? `in ${mins} min` : `at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const ago = -mins;
  if (ago < 60) return `${ago} min ago`;
  if (ago < 1440) return `${Math.round(ago / 60)} h ago`;
  return d.toLocaleDateString();
}

const intervalLabel = (m) => (m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`);

function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[40px] shrink-0 rounded-full border transition disabled:opacity-40 ${
        checked ? 'border-accent bg-accent' : 'border-edge bg-surface-2'
      }`}
    >
      <span
        className={`absolute top-[2px] h-4 w-4 rounded-full transition-all ${
          checked ? 'left-[20px] bg-accent-ink' : 'left-[2px] bg-ink-dim'
        }`}
      />
    </button>
  );
}

/**
 * Watched folders: Shelf checks them on a schedule and organises new
 * downloads with the destination and naming chosen on this page.
 */
export default function AutoOrganize({ form, pickFolder, onReview, onChanged, busy }) {
  const [status, setStatus] = useState(null);
  const [desktop, setDesktop] = useState(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  async function load() {
    try {
      setStatus(await api.autoOrganize());
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    window.shelf?.getDesktop?.().then(setDesktop).catch(() => {});
    const onAuto = () => load();
    window.addEventListener('shelf:auto-changed', onAuto);
    const timer = setInterval(load, 30_000);
    return () => {
      window.removeEventListener('shelf:auto-changed', onAuto);
      clearInterval(timer);
    };
  }, []);

  async function save(patch, message) {
    setWorking('save');
    setError(null);
    setNote(null);
    try {
      setStatus(await api.setAutoOrganize(patch));
      if (message) setNote(message);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking('');
    }
  }

  // The watcher uses the destination and naming chosen in the form above.
  const profile = () => ({
    tvRoot: form.tvRoot,
    movieRoot: form.movieRoot,
    options: form.options,
  });

  async function addFolder() {
    const path = await pickFolder('Choose a folder to watch for new downloads');
    if (!path) return;
    const folders = [...(status.config.folders || []), path];
    await save({ folders });
  }

  async function toggle(enabled) {
    const c = status.config;
    // First switch-on: take the destination and naming from the form.
    const needsProfile = enabled && !c.tvRoot && !c.movieRoot;
    await save(
      { enabled, ...(needsProfile ? profile() : {}) },
      enabled ? 'Watching. New downloads are checked on the schedule below.' : 'Automatic organizing is off.'
    );
  }

  async function runNow() {
    setWorking('run');
    setError(null);
    setNote(null);
    try {
      const r = await api.runAutoOrganize();
      setStatus(r.status);
      const e = r.entry;
      setNote(
        e.error
          ? null
          : e.moved
            ? `Organized ${e.moved} file${e.moved === 1 ? '' : 's'}.`
            : e.waiting
              ? `Nothing moved; ${e.waiting} waiting for review.`
              : e.downloading
                ? `${e.downloading} still downloading; checking again later.`
                : 'Nothing new to organize.'
      );
      if (e.error) setError(e.error);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking('');
    }
  }

  async function setDesk(patch) {
    try {
      setDesktop(await window.shelf.setDesktop(patch));
    } catch (err) {
      setError(err.message);
    }
  }

  if (!status) {
    return (
      <div className="rounded-card border border-edge bg-surface/60 p-5">
        {error ? <span className="text-[13px] text-danger">{error}</span> : <Spinner />}
      </div>
    );
  }

  const c = status.config;
  const pending = status.pending;
  const sameAsForm =
    c.tvRoot === form.tvRoot && c.movieRoot === form.movieRoot &&
    JSON.stringify(c.options) === JSON.stringify(form.options);

  return (
    <section className="rounded-card border border-edge bg-surface/60">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
        <Switch checked={c.enabled} onChange={toggle} label="Organize new downloads automatically" disabled={working === 'save'} />
        <div className="min-w-0 flex-1">
          <div className="display text-[14px] uppercase tracking-wide text-ink">Automatic organizing</div>
          <div className="mt-0.5 text-[12px] text-ink-dim">
            {c.enabled
              ? `Watching ${c.folders.length} folder${c.folders.length === 1 ? '' : 's'} · every ${intervalLabel(c.intervalMinutes)}` +
                (status.running ? ' · checking now' : status.next_run ? ` · next check ${when(status.next_run)}` : '')
              : c.folders.length
                ? 'Off. Turn on to organize new downloads on a schedule.'
                : 'Watch a folder like Downloads and organize new files as they arrive.'}
          </div>
        </div>
        {pending?.count > 0 && (
          <button onClick={() => onReview(status.config)} disabled={busy} className={ghostBtn}>
            Review {pending.count} waiting
          </button>
        )}
        {c.folders.length > 0 && (
          <button onClick={runNow} disabled={busy || working === 'run' || status.running} className={ghostBtn}>
            {working === 'run' || status.running ? 'Checking…' : 'Check now'}
          </button>
        )}
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-[12px] text-accent hover:underline">
          {open ? 'Hide settings' : c.folders.length ? 'Settings' : 'Set up'}
        </button>
      </div>

      {(note || error) && (
        <p role={error ? 'alert' : 'status'} className={`border-t border-edge/70 px-5 py-2.5 text-[12.5px] ${error ? 'text-danger' : 'text-good'}`}>
          {error || note}
        </p>
      )}

      {open && (
        <div className="grid gap-6 border-t border-edge/70 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="mono mb-2 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Watched folders</div>
            {c.folders.length ? (
              <ul className="overflow-hidden rounded border border-edge">
                {c.folders.map((f) => (
                  <li key={f} className="flex items-center gap-3 border-b border-edge/60 px-3 py-2 last:border-b-0">
                    <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-ink" title={f}>{f}</span>
                    <button
                      onClick={() => save({ folders: c.folders.filter((x) => x !== f), ...(c.folders.length === 1 ? { enabled: false } : {}) })}
                      className="text-[11px] text-ink-dim hover:text-danger"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-dim">No folders yet. Add the folders your browser or download app saves to.</p>
            )}
            <button onClick={addFolder} className={`${ghostBtn} mt-2.5`}>
              Add folder
            </button>

            <div className="mono mb-2 mt-6 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Check every</div>
            <select
              value={c.intervalMinutes}
              onChange={(e) => save({ intervalMinutes: Number(e.target.value) })}
              aria-label="How often to check"
              className="rounded border border-edge bg-bg px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent/50"
            >
              {status.intervals.map((m) => (
                <option key={m} value={m}>{intervalLabel(m)}</option>
              ))}
            </select>

            <div className="mono mb-2 mt-6 text-[10px] uppercase tracking-[0.16em] text-ink-dim">When it finds new files</div>
            <div role="radiogroup" aria-label="When it finds new files" className="grid gap-1.5">
              {[
                {
                  value: 'confident',
                  label: 'Organize the ones it is sure about',
                  hint: status.tmdb
                    ? 'Sure means TMDB confirmed the title. Everything else waits for you.'
                    : 'Sure means the name is unambiguous (films need a year). Add a TMDB key for better matching.',
                },
                { value: 'review', label: 'Only tell me', hint: 'Nothing moves until you review it.' },
              ].map((o) => (
                <button
                  key={o.value}
                  role="radio"
                  aria-checked={c.mode === o.value}
                  onClick={() => save({ mode: o.value })}
                  className={`rounded border px-3 py-2 text-left transition ${
                    c.mode === o.value ? 'border-accent/60 bg-accent/10' : 'border-edge hover:border-accent/40'
                  }`}
                >
                  <span className="block text-[13px] text-ink">{o.label}</span>
                  <span className="block text-[11.5px] text-ink-dim">{o.hint}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-dim">
              Files that are still downloading, or changed in the last {c.settleMinutes} minutes, are left
              alone until the next check. Tip: choose Copy above if your torrent app is still seeding.
            </p>
          </div>

          <div>
            <div className="mono mb-2 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Where files go</div>
            <dl className="grid min-w-0 gap-1 overflow-hidden rounded border border-edge bg-bg px-3 py-2.5 text-[12px]">
              <div className="flex min-w-0 gap-2"><dt className="w-16 shrink-0 text-ink-dim">Series</dt><dd className="mono min-w-0 flex-1 truncate text-ink" title={c.tvRoot}>{c.options.include.tv ? c.tvRoot || '—' : 'not organized'}</dd></div>
              <div className="flex min-w-0 gap-2"><dt className="w-16 shrink-0 text-ink-dim">Films</dt><dd className="mono min-w-0 flex-1 truncate text-ink" title={c.movieRoot}>{c.options.include.movies ? c.movieRoot || '—' : 'not organized'}</dd></div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-ink-dim">How</dt>
                <dd className="text-ink">
                  {c.options.mode === 'copy' ? 'Copy' : 'Move'}
                  {c.options.rename ? ', rename' : ', keep names'}
                  {c.options.useTmdb && status.tmdb ? ', TMDB titles' : ''}
                </dd>
              </div>
            </dl>
            {!sameAsForm && (
              <button onClick={() => save(profile(), 'Now using the folders and naming chosen above.')} className={`${ghostBtn} mt-2.5`}>
                Use the folders and naming chosen above
              </button>
            )}

            {desktop && (
              <>
                <div className="mono mb-2 mt-6 text-[10px] uppercase tracking-[0.16em] text-ink-dim">While Shelf is closed</div>
                <label className="flex items-center gap-2.5 py-1 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={desktop.background}
                    onChange={(e) => setDesk({ background: e.target.checked })}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  Keep running in the system tray when the window is closed
                </label>
                {desktop.canStartAtLogin && (
                  <label className="flex items-center gap-2.5 py-1 text-[13px] text-ink">
                    <input
                      type="checkbox"
                      checked={desktop.openAtLogin}
                      onChange={(e) => setDesk({ openAtLogin: e.target.checked })}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    Start Shelf in the tray when Windows starts
                  </label>
                )}
              </>
            )}
            {!desktop && (
              <p className="mt-6 text-[11.5px] text-ink-dim">Checks run while Shelf is running.</p>
            )}

            <div className="mono mb-2 mt-6 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Recent checks</div>
            {status.log.length ? (
              <ul className="grid gap-1">
                {status.log.slice(0, 8).map((e) => (
                  <li key={e.at} className="flex items-start gap-3 text-[12px]">
                    <span className="mono w-20 shrink-0 text-ink-dim">{when(e.at)}</span>
                    <span className="min-w-0 flex-1 text-ink">
                      {e.error ? (
                        <span className="text-danger">{e.error}</span>
                      ) : e.moved ? (
                        <>
                          Organized {e.moved}
                          {e.titles?.length ? <span className="text-ink-dim"> · {e.titles.slice(0, 3).join(', ')}</span> : null}
                        </>
                      ) : (
                        <span className="text-ink-dim">Nothing moved</span>
                      )}
                      {e.waiting > 0 && <Badge tone="warn" className="ml-2">{e.waiting} waiting</Badge>}
                      {e.downloading > 0 && <Badge className="ml-1.5">{e.downloading} downloading</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-ink-dim">No checks yet.</p>
            )}
            {status.log.some((e) => e.batch_id) && (
              <p className="mt-2 text-[11.5px] text-ink-dim">Anything organized automatically can be undone from History below.</p>
            )}
          </div>
        </div>
      )}

      {!c.enabled && !c.folders.length && !open && (
        <div className="border-t border-edge/70 px-5 py-3">
          <button onClick={() => setOpen(true)} className={primaryBtn}>
            Watch a downloads folder
          </button>
        </div>
      )}
    </section>
  );
}
