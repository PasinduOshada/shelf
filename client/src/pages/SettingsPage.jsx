import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, SectionTitle, Spinner, EmptyState, ProgressBar } from '../components/Bits';
import { primaryBtn, ghostBtn } from '../components/DetailHero';
import ThemePanel from '../components/ThemePanel';
import FolderPicker from '../components/FolderPicker';
import { PlayerSettings, SubtitleSettings } from '../components/MediaSettings';
import { LibraryCare, ImportSync, BackupRestore, Updates } from '../components/SettingsExtras';
import About from '../components/About';

export default function SettingsPage() {
  const [libraries, setLibraries] = useState([]);
  const [settings, setSettings] = useState(null);
  const [tmdb, setTmdb] = useState(null);
  const [key, setKey] = useState('');
  const [picking, setPicking] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [excludeText, setExcludeText] = useState('');

  async function load() {
    const [libs, s, t] = await Promise.all([api.libraries(), api.settings(), api.tmdbStatus()]);
    setLibraries(libs);
    setSettings(s);
    setTmdb(t);
    setExcludeText((s.excludes || []).join('\n'));
  }

  useEffect(() => {
    load();
  }, []);

  async function addLibrary(path, kind) {
    try {
      await api.addLibrary({ path, kind, label: path.split(/[\\/]/).filter(Boolean).pop() });
      setMessage({ text: `Added ${path}. Run a scan to index it.` });
    } catch (err) {
      setMessage({ text: err.message, error: true });
    }
    setPicking(null);
    await load();
  }

  /** Desktop build gets the OS dialog; the browser falls back to the in-app picker. */
  async function choose(kind) {
    if (window.shelf?.pickFolder) {
      const path = await window.shelf.pickFolder();
      if (path) await addLibrary(path, kind);
      return;
    }
    setPicking(kind);
  }

  async function runScan() {
    setBusy('scan');
    setMessage(null);
    try {
      const stats = await api.scan();
      const skipped = stats.skipped
        ? ` ${stats.skipped} clip${stats.skipped === 1 ? '' : 's'} left out.`
        : '';
      setMessage({
        text: `Scanned ${stats.files} files — ${stats.shows} shows and ${stats.movies} films in ${stats.durationMs} ms.${skipped}`,
      });
      window.dispatchEvent(new CustomEvent('shelf:refresh'));
      await load();
    } catch (err) {
      setMessage({ text: err.message, error: true });
    } finally {
      setBusy('');
    }
  }

  async function saveKey() {
    setBusy('key');
    setMessage(null);
    try {
      await api.setTmdbKey(key.trim());
      setKey('');
      setMessage({ text: 'TMDB key saved. Fetch metadata to add posters and episode lists.' });
      await load();
    } catch (err) {
      setMessage({ text: err.message, error: true });
    } finally {
      setBusy('');
    }
  }

  const [job, setJob] = useState(null);

  // Poll the background metadata job. Also picks up a run that was started
  // before this page was opened.
  useEffect(() => {
    let timer;
    let cancelled = false;
    async function poll() {
      try {
        const status = await api.enrichStatus();
        if (cancelled) return;
        setJob(status);
        if (status.running) {
          timer = setTimeout(poll, 1000);
        } else if (status.finishedAt) {
          window.dispatchEvent(new CustomEvent('shelf:refresh'));
          load();
        }
      } catch {
        /* server restarting; the next page load picks it up */
      }
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job?.startedAt]);

  async function enrich(retryFailed = false) {
    setMessage(null);
    try {
      setJob(await api.enrich(retryFailed));
    } catch (err) {
      setMessage({ text: err.message, error: true });
    }
  }

  async function saveExcludes() {
    const list = excludeText.split('\n').map((s) => s.trim()).filter(Boolean);
    await api.updateSettings({ excludes: list });
    setMessage({ text: 'Ignored folders saved. Rescan to apply them.' });
    await load();
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Loading
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <header className="mb-9">
        <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Preferences</div>
        <h1 className="display mt-2 text-[42px] uppercase leading-none text-ink">Settings</h1>
      </header>

      {message && (
        <div
          role="status"
          className={`mb-8 rounded-card border px-4 py-3 text-[13px] ${
            message.error ? 'border-danger/35 bg-danger/10 text-danger' : 'border-accent/35 bg-accent/10 text-ink'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-12">
        <ThemePanel />

        <section>
          <SectionTitle
            action={
              <button onClick={runScan} disabled={busy === 'scan'} className={primaryBtn}>
                {busy === 'scan' ? 'Scanning' : 'Scan now'}
              </button>
            }
          >
            Libraries
          </SectionTitle>

          {!libraries.length ? (
            <EmptyState
              icon="▦"
              title="No libraries yet"
              hint="Point Shelf at the folders that hold your TV shows and films."
            />
          ) : (
            <div className="overflow-hidden rounded-card border border-edge">
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  className="grid grid-cols-[64px_minmax(0,1fr)_auto_auto] items-center gap-4 border-b border-edge/60 px-4 py-3 last:border-b-0"
                >
                  <Badge tone={lib.kind === 'tv' ? 'accent' : 'default'}>
                    {lib.kind === 'tv' ? 'TV' : 'FILMS'}
                  </Badge>
                  <div className="min-w-0">
                    <div className="display truncate text-[14px] uppercase tracking-wide text-ink">
                      {lib.label || lib.path}
                    </div>
                    <div className="mono truncate text-[10.5px] text-ink-dim">{lib.path}</div>
                  </div>
                  <span className="mono text-[10.5px] text-ink-dim">
                    {lib.last_scan ? `scanned ${lib.last_scan.slice(0, 16)}` : 'never scanned'}
                  </span>
                  <button
                    onClick={async () => {
                      await api.removeLibrary(lib.id);
                      load();
                    }}
                    title="Removes it from Shelf. Your files stay exactly where they are."
                    className="text-[11px] text-ink-dim transition hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2.5">
            <button onClick={() => choose('tv')} className={ghostBtn}>
              Add TV folder
            </button>
            <button onClick={() => choose('movie')} className={ghostBtn}>
              Add film folder
            </button>
          </div>
        </section>

        <section>
          <SectionTitle>Metadata</SectionTitle>
          <div className="rounded-card border border-edge bg-surface/50 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="display text-[14px] uppercase tracking-wide text-ink">TMDB</span>
              {tmdb?.configured ? <Badge tone="good">connected</Badge> : <Badge tone="warn">not connected</Badge>}
              {tmdb && (
                <span className="mono text-[10.5px] text-ink-dim">
                  {tmdb.unmatched.shows} shows · {tmdb.unmatched.movies} films without metadata
                </span>
              )}
            </div>

            <p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-ink-dim">
              Shelf works without a key: missing episodes are estimated from gaps in your file
              numbering. A free{' '}
              <a
                href="https://www.themoviedb.org/settings/api"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                TMDB API key
              </a>{' '}
              adds posters, backdrops, real episode lists, air dates and countdowns. The key stays on
              this computer{tmdb?.encrypted ? ', encrypted for your Windows account' : ''}.
            </p>

            <div className="mt-4 flex gap-2.5">
              <input
                type="password"
                autoComplete="off"
                spellCheck="false"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={tmdb?.configured ? 'Replace the saved key' : 'Paste your TMDB API key'}
                aria-label="TMDB API key"
                className="mono min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[12px] outline-none transition focus:border-accent/50"
              />
              <button onClick={saveKey} disabled={!key.trim() || busy === 'key'} className={primaryBtn}>
                {busy === 'key' ? 'Checking' : 'Save key'}
              </button>
            </div>

            {job?.running ? (
              <div className="mt-5" role="status" aria-live="polite">
                <div className="mb-2 flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-ink">
                    {job.mode === 'refresh' ? 'Refreshing' : 'Matching'}{' '}
                    {job.current ? `“${job.current}”` : '…'}
                  </span>
                  <span className="mono shrink-0 text-ink-dim">
                    {job.done}/{job.total}
                  </span>
                </div>
                <ProgressBar value={job.total ? (job.done / job.total) * 100 : 0} />
                <div className="mono mt-2 text-[10.5px] text-ink-dim">
                  {job.shows} shows · {job.movies} films matched · {job.failed} not found
                </div>
              </div>
            ) : (
              <>
                {job?.finishedAt && !job.error && (
                  <div className="mt-5 rounded border border-edge bg-bg/60 px-3.5 py-3 text-[12.5px] text-ink">
                    {job.mode === 'refresh'
                      ? `Refreshed ${job.shows} airing shows and ${job.movies} recent films.`
                      : `Matched ${job.shows} shows and ${job.movies} films.`}
                    {job.failed > 0 &&
                      (job.mode === 'refresh'
                        ? ` ${job.failed} couldn’t be refreshed this time; ${job.failed === 1 ? 'it keeps' : 'they keep'} the existing details and will retry automatically.`
                        : ` ${job.failed} weren’t found — open them and use “Fix match”, or retry below.`)}
                    {job.failures?.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[11.5px] text-ink-dim">
                          Show titles that weren’t found
                        </summary>
                        <div className="mono mt-2 max-h-40 overflow-y-auto text-[11px] leading-relaxed text-ink-dim">
                          {job.failures.join(' · ')}
                        </div>
                      </details>
                    )}
                  </div>
                )}
                {job?.error && <div className="mt-5 text-[12.5px] text-danger">{job.error}</div>}
                <div className="mt-4 flex flex-wrap gap-2.5">
                  <button
                    onClick={() => enrich(false)}
                    disabled={!tmdb?.configured}
                    className={primaryBtn}
                  >
                    Fetch posters &amp; metadata
                  </button>
                  <button
                    onClick={() => enrich({ refresh: true })}
                    disabled={!tmdb?.configured}
                    className={ghostBtn}
                    title="Airing shows also refresh on their own every few hours"
                  >
                    Refresh airing shows
                  </button>
                  {(tmdb?.failed?.shows > 0 || tmdb?.failed?.movies > 0) && (
                    <button
                      onClick={() => enrich(true)}
                      disabled={!tmdb?.configured}
                      className={ghostBtn}
                    >
                      Retry {tmdb.failed.shows + tmdb.failed.movies} not found
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        <PlayerSettings />

        <SubtitleSettings />

        <LibraryCare />

        <ImportSync />

        <BackupRestore />

        <Updates />

        <section>
          <SectionTitle>Ignored folders</SectionTitle>
          <div className="rounded-card border border-edge bg-surface/50 p-5">
            <p className="max-w-[68ch] text-[13px] text-ink-dim">
              One folder name or path per line. Matches are skipped during scans — useful for
              screen recordings or work files that sit beside your media.
            </p>
            <textarea
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              rows={4}
              spellCheck="false"
              aria-label="Ignored folders"
              placeholder={'Screen recordings\nHome videos'}
              className="mono mt-3 w-full rounded border border-edge bg-bg px-3 py-2 text-[12px] outline-none transition focus:border-accent/50"
            />
            <button onClick={saveExcludes} className={`${ghostBtn} mt-3`}>
              Save ignored folders
            </button>
          </div>
        </section>

        <About />
      </div>

      {picking && (
        <FolderPicker onPick={(path) => addLibrary(path, picking)} onClose={() => setPicking(null)} />
      )}
    </div>
  );
}
