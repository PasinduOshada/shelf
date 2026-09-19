import { useEffect, useRef, useState } from 'react';
import { api, formatBytes } from '../api';
import { Badge, ProgressBar, SectionTitle } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

const card = 'rounded-card border border-edge bg-surface/50 p-5';
const input =
  'mono min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[12px] outline-none transition focus:border-accent/50';
const label = 'mono mb-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-dim';

function Note({ error, note }) {
  if (!error && !note) return null;
  return (
    <p role={error ? 'alert' : 'status'} className={`mt-3 text-[12.5px] ${error ? 'text-danger' : 'text-good'}`}>
      {error || note}
    </p>
  );
}

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

// ---------------------------------------------------------------- notifications + media info

export function LibraryCare() {
  const [airing, setAiring] = useState(null);
  const [probe, setProbe] = useState(null);
  const timer = useRef(null);

  const loadProbe = async () => {
    const p = await api.probeStatus().catch(() => null);
    setProbe(p);
    clearTimeout(timer.current);
    if (p?.running) timer.current = setTimeout(loadProbe, 1500);
  };

  useEffect(() => {
    api.airing().then(setAiring).catch(() => {});
    loadProbe();
    return () => clearTimeout(timer.current);
  }, []);

  return (
    <section>
      <SectionTitle>Alerts and file details</SectionTitle>
      <div className={`${card} grid gap-6 lg:grid-cols-2`}>
        <div>
          <div className={label}>New episodes</div>
          <label className="flex items-start gap-2.5 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={Boolean(airing?.enabled)}
              disabled={!airing}
              onChange={async (e) => setAiring({ ...airing, ...(await api.setAiring(e.target.checked)) })}
              className="mt-[3px] h-3.5 w-3.5 accent-accent"
            />
            <span>
              Tell me when a new episode of a show in my library airs
              <span className="block text-[11.5px] text-ink-dim">
                A desktop notification, once per episode. New episodes also appear on Up Next.
              </span>
            </span>
          </label>
        </div>

        <div>
          <div className={label}>File details</div>
          {!probe ? null : !probe.available ? (
            <p className="text-[12.5px] text-ink-dim">
              Reading resolution, HDR and languages needs ffprobe, which comes with the Windows app.
            </p>
          ) : (
            <>
              <p className="text-[12.5px] text-ink-dim">
                Shelf reads each file’s real resolution, HDR, length, and audio and subtitle languages.
                {` ${probe.probed} of ${probe.files} files read.`}
              </p>
              {probe.running ? (
                <div className="mt-3" role="status">
                  <div className="mono mb-1.5 text-[11px] text-ink-dim">Reading {probe.done}/{probe.total}</div>
                  <ProgressBar value={probe.total ? (probe.done / probe.total) * 100 : 0} />
                </div>
              ) : (
                <div className="mt-3 flex gap-2.5">
                  <button onClick={async () => { await api.startProbe(false); loadProbe(); }} className={ghostBtn} disabled={probe.probed >= probe.files}>
                    Read new files
                  </button>
                  <button onClick={async () => { await api.startProbe(true); loadProbe(); }} className={ghostBtn}>
                    Read all again
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- TV Time + Trakt

function TvTimeImport() {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  async function choose(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await api.importTvTime(files));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api.applyTvTime(preview.import_id);
      setResult(`Marked ${r.marked.episodes} episodes and ${r.marked.movies} films watched${r.already ? `; ${r.already} were already watched` : ''}.`);
      setPreview(null);
      window.dispatchEvent(new CustomEvent('shelf:refresh'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="display text-[14px] uppercase tracking-wide text-ink">TV Time</div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
        Bring your watch history from TV Time’s data export (the zip, or its
        <span className="mono"> tracking-prod-records</span> CSV files). Titles are matched to your library;
        nothing already watched here changes.
      </p>
      <input ref={fileRef} type="file" accept=".zip,.csv" multiple hidden onChange={choose} />
      <button onClick={() => fileRef.current?.click()} disabled={busy} className={`${ghostBtn} mt-3`}>
        {busy && !preview ? 'Reading…' : 'Choose the export'}
      </button>

      {preview && (
        <div className="mt-4 rounded border border-edge bg-bg px-4 py-3 text-[12.5px]">
          <p className="text-ink">
            Found {preview.found.episodes} episode and {preview.found.movies} film watches.{' '}
            <strong>{preview.matched.episodes}</strong> episodes and <strong>{preview.matched.movies}</strong> films match your library.
          </p>
          {preview.not_in_shelf > 0 && (
            <p className="mt-1 text-ink-dim">{preview.not_in_shelf} are episodes Shelf doesn’t list for those shows.</p>
          )}
          {preview.unmatched_shows.length > 0 && (
            <details className="mt-2 text-ink-dim">
              <summary className="cursor-pointer">{preview.unmatched_shows.length} shows aren’t in your library</summary>
              <p className="mt-1">{preview.unmatched_shows.map((s) => s.title).join(', ')}</p>
            </details>
          )}
          <div className="mt-3 flex gap-2.5">
            <button onClick={apply} disabled={busy || !(preview.matched.episodes + preview.matched.movies)} className={primaryBtn}>
              Import
            </button>
            <button onClick={() => setPreview(null)} className={ghostBtn}>Cancel</button>
          </div>
        </div>
      )}
      <Note error={error} note={result} />
    </div>
  );
}

function TraktSync() {
  const [t, setT] = useState(null);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const poll = useRef(null);

  const load = async () => {
    const s = await api.trakt().catch(() => null);
    setT(s);
    clearTimeout(poll.current);
    if (s?.device) poll.current = setTimeout(load, 3000);
  };

  useEffect(() => {
    load();
    return () => clearTimeout(poll.current);
  }, []);

  async function run(name, fn, done) {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const r = await fn();
      if (done) setNote(done(r));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (!t) return null;

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="display text-[14px] uppercase tracking-wide text-ink">Trakt</span>
        {t.connected ? <Badge tone="good">connected{t.username ? ` as ${t.username}` : ''}</Badge> : <Badge>not connected</Badge>}
      </div>

      {!t.configured ? (
        <>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
            Keeps watches in step with Trakt both ways. Create an API app on{' '}
            <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              trakt.tv
            </a>{' '}
            with the redirect URI <span className="mono">urn:ietf:wg:oauth:2.0:oob</span>, then paste its keys.
          </p>
          <form
            className="mt-3 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run('app', () => api.setTraktApp(id.trim(), secret.trim()), () => 'Saved. Now connect your account.');
            }}
          >
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID" aria-label="Trakt Client ID" className={input} autoComplete="off" />
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client Secret" aria-label="Trakt Client Secret" className={input} autoComplete="off" />
            <button type="submit" disabled={!id || !secret || busy === 'app'} className={`${ghostBtn} justify-self-start`}>
              Save app keys
            </button>
          </form>
        </>
      ) : t.device ? (
        <div className="mt-3 rounded border border-accent/40 bg-accent/5 px-4 py-3 text-[13px] text-ink" role="status">
          Open{' '}
          <a href={t.device.verification_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {t.device.verification_url}
          </a>{' '}
          and enter <span className="mono text-[18px] tracking-[0.2em] text-accent">{t.device.user_code}</span>
          <p className="mt-1 text-[11.5px] text-ink-dim">Waiting for you to approve Shelf on Trakt…</p>
        </div>
      ) : !t.connected ? (
        <button onClick={() => run('connect', () => api.traktConnect())} disabled={busy === 'connect'} className={`${primaryBtn} mt-3`}>
          Connect Trakt account
        </button>
      ) : (
        <>
          <p className="mt-2 text-[12.5px] text-ink-dim">
            Syncs every six hours. Last sync: {when(t.last_sync)}
            {t.last_result ? ` · ${t.last_result.pulled} in, ${t.last_result.pushed} out` : ''}.
          </p>
          {t.last_result?.skipped_orderings?.length > 0 && (
            <p className="mt-1 text-[11.5px] text-ink-dim">
              Not synced (custom episode order): {t.last_result.skipped_orderings.join(', ')}
            </p>
          )}
          <div className="mt-3 flex gap-2.5">
            <button
              onClick={() => run('sync', () => api.traktSync(), (r) => `Synced: ${r.pulled} watches in, ${r.pushed} out.`)}
              disabled={busy === 'sync'}
              className={primaryBtn}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button onClick={() => run('off', () => api.traktDisconnect())} className={ghostBtn}>Disconnect</button>
          </div>
        </>
      )}
      <Note error={error} note={note} />
    </div>
  );
}

export function ImportSync() {
  return (
    <section>
      <SectionTitle>Import and sync</SectionTitle>
      <div className={`${card} grid gap-8 lg:grid-cols-2`}>
        <TvTimeImport />
        <TraktSync />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- backup

export function BackupRestore() {
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const fileRef = useRef(null);

  async function restore(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.importBackup(file, { overwrite });
      setNote(`Restored ${r.episodes} episodes, ${r.movies} films and ${r.history} history entries${r.skipped ? `; ${r.skipped} shows aren’t in this library` : ''}.`);
      window.dispatchEvent(new CustomEvent('shelf:refresh'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <SectionTitle>Backup</SectionTitle>
      <div className={card}>
        <p className="max-w-[68ch] text-[13px] leading-relaxed text-ink-dim">
          One file with everything you’ve added: what you watched and when, ratings, notes,
          favourites, icons and settings. Keys and passwords are left out. Restoring merges into
          this library, even on another computer, and never removes anything.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <a href="/api/backup/export" download className={primaryBtn}>Save a backup</a>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={restore} />
          <button onClick={() => fileRef.current?.click()} disabled={busy} className={ghostBtn}>
            {busy ? 'Restoring…' : 'Restore from a backup'}
          </button>
          <label className="flex items-center gap-2 text-[12.5px] text-ink-dim">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
            Backup’s ratings and notes replace the ones here
          </label>
        </div>
        <Note error={error} note={note} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- updates (desktop)

export function Updates() {
  const [u, setU] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.shelf?.updates?.().then(setU).catch(() => {});
  }, []);

  if (!window.shelf?.updates || !u) return null;

  const text = {
    idle: 'Not checked yet.',
    checking: 'Checking…',
    current: 'Shelf is up to date.',
    downloading: `Downloading version ${u.version}${u.percent != null ? ` (${u.percent}%)` : ''}…`,
    ready: `Version ${u.version} is ready.`,
    unavailable: u.message,
    error: 'Couldn’t check for updates right now.',
  }[u.status];

  return (
    <section>
      <SectionTitle>Updates</SectionTitle>
      <div className={card}>
        <p className="text-[13px] text-ink">
          Version {u.current}. {text}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          {u.status === 'ready' ? (
            <button onClick={() => window.shelf.installUpdate()} className={primaryBtn}>Restart and update</button>
          ) : (
            <button
              onClick={async () => {
                setBusy(true);
                setU({ ...u, ...(await window.shelf.checkUpdates()) });
                setBusy(false);
              }}
              disabled={busy}
              className={ghostBtn}
            >
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
          )}
          <label className="flex items-center gap-2 text-[12.5px] text-ink-dim">
            <input
              type="checkbox"
              checked={u.enabled}
              onChange={async (e) => {
                await window.shelf.setAutoUpdate(e.target.checked);
                setU({ ...u, enabled: e.target.checked });
              }}
              className="h-3.5 w-3.5 accent-accent"
            />
            Download updates automatically
          </label>
        </div>
      </div>
    </section>
  );
}

/**
 * What Shelf costs in disk. It should be small next to the library it
 * describes, and anyone who wonders deserves a number rather than a promise.
 */
export function Storage() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [freed, setFreed] = useState(null);

  const load = () => api.storage().then(setInfo).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function tidy() {
    setBusy(true);
    try {
      const result = await api.tidyStorage();
      setInfo(result);
      setFreed(result.freed);
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;

  return (
    <section>
      <SectionTitle>Disk used by Shelf</SectionTitle>
      <div className="rounded-card border border-edge bg-surface/50 p-5">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <div className="display text-[32px] leading-none tnum text-ink">{formatBytes(info.total)}</div>
            <div className="mono mt-1 text-[10px] uppercase tracking-wider text-ink-dim">In total</div>
          </div>
          <div className="mono text-[11.5px] text-ink-dim">
            <div>{formatBytes(info.database)} library index and watch history</div>
            <div>
              {formatBytes(info.images)} artwork, {info.image_files} files
            </div>
            {info.uploads > 0 && <div>{formatBytes(info.uploads)} posters you uploaded</div>}
          </div>
        </div>

        <p className="mt-4 max-w-[68ch] text-[12.5px] text-ink-dim">
          Your videos are never copied — this is only the index, and artwork cached at the size
          it is shown. Tidying removes artwork for titles no longer in your library and compacts
          the database; nothing you have watched or rated is touched.
        </p>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={tidy} disabled={busy} className={ghostBtn}>
            {busy ? 'Tidying' : 'Tidy up'}
          </button>
          {freed != null && (
            <span className="text-[12.5px] text-ink-dim">
              {freed > 0 ? `Gave back ${formatBytes(freed)}.` : 'Nothing to give back.'}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
