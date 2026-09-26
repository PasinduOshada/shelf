import { useEffect, useState } from 'react';
import Mark from '../components/Mark';
import { Link, useNavigate } from 'react-router-dom';
import { api, plural, scanWithProgress } from '../api';
import { Badge, ProgressBar, Spinner } from '../components/Bits';
import { primaryBtn, ghostBtn } from '../components/DetailHero';
import FolderPicker from '../components/FolderPicker';

function Step({ number, title, done, optional, children }) {
  return (
    <li className="grid grid-cols-[34px_minmax(0,1fr)] gap-4 border-b border-edge/70 py-6 last:border-b-0">
      <span
        aria-hidden="true"
        className={`display grid h-[34px] w-[34px] place-items-center rounded-full border text-[14px] ${
          done ? 'border-accent bg-accent text-accent-ink' : 'border-edge text-ink-dim'
        }`}
      >
        {done ? '✓' : number}
      </span>
      <div className="min-w-0">
        <h2 className="display flex flex-wrap items-center gap-2 text-[17px] uppercase tracking-wide text-ink">
          {title}
          {optional && <Badge>optional</Badge>}
        </h2>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}

/**
 * First run: nothing is indexed yet. Walks through choosing folders, the
 * optional TMDB key, and the first scan, then hands over to the library.
 */
export default function WelcomePage() {
  const navigate = useNavigate();
  const [libraries, setLibraries] = useState([]);
  const [tmdb, setTmdb] = useState(null);
  const [key, setKey] = useState('');
  const [picking, setPicking] = useState(null);
  const [phase, setPhase] = useState('setup'); // setup | scanning | matching | done
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(false);

  async function load() {
    const [libs, t] = await Promise.all([api.libraries(), api.tmdbStatus()]);
    setLibraries(libs);
    setTmdb(t);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function addLibrary(path, kind) {
    setError(null);
    try {
      await api.addLibrary({ path, kind, label: path.split(/[\\/]/).filter(Boolean).pop() });
      await load();
    } catch (err) {
      setError(err.message);
    }
    setPicking(null);
  }

  async function choose(kind) {
    if (window.shelf?.pickFolder) {
      const path = await window.shelf.pickFolder();
      if (path) await addLibrary(path, kind);
      return;
    }
    setPicking(kind);
  }

  async function removeLibrary(id) {
    await api.removeLibrary(id);
    await load();
  }

  async function saveKey() {
    setSavingKey(true);
    setError(null);
    try {
      await api.setTmdbKey(key.trim());
      setKey('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingKey(false);
    }
  }

  async function start() {
    setError(null);
    setPhase('scanning');
    try {
      setScan(await scanWithProgress(setScanning));
      if (tmdb?.configured) {
        setJob(await api.enrich());
        setPhase('matching');
      } else {
        setPhase('done');
      }
    } catch (err) {
      setError(err.message);
      setPhase('setup');
    }
  }

  // Follow the metadata job. If a scheduled refresh happened to be running,
  // start the matching job once it ends.
  useEffect(() => {
    if (phase !== 'matching') return undefined;
    let timer;
    let cancelled = false;
    let restarted = false;
    const tick = async () => {
      try {
        const status = await api.enrichStatus();
        if (cancelled) return;
        setJob(status);
        if (status.running) {
          timer = setTimeout(tick, 1000);
        } else if (status.mode !== 'match' && !restarted) {
          restarted = true;
          setJob(await api.enrich());
          timer = setTimeout(tick, 1000);
        } else {
          setPhase('done');
        }
      } catch {
        timer = setTimeout(tick, 2000);
      }
    };
    timer = setTimeout(tick, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase]);

  const hasTv = libraries.some((l) => l.kind === 'tv');
  const hasFilms = libraries.some((l) => l.kind === 'movie');
  const working = phase === 'scanning' || phase === 'matching';

  return (
    <div className="relative flex min-h-screen flex-col justify-center overflow-hidden bg-bg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(55% 70% at 12% 8%, rgb(var(--accent) / 0.2), transparent 70%), radial-gradient(40% 60% at 95% 100%, rgb(var(--accent) / 0.08), transparent 70%)',
        }}
      />

      <div className="relative mx-auto grid max-w-6xl gap-14 px-8 py-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
        <header>
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded bg-accent text-accent-ink">
              <Mark className="h-6 w-6" />
            </div>
            <div className="display text-[18px] uppercase tracking-[0.08em] text-ink">Shelf</div>
          </div>
          <div className="mono mt-12 text-[10px] uppercase tracking-[0.24em] text-accent">First run</div>
          <h1 className="display mt-3 text-[clamp(40px,5.6vw,68px)] uppercase leading-[0.9] text-ink">
            Point Shelf at your films and shows
          </h1>
          <p className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-ink-dim">
            Shelf reads the folders you choose and builds your library: what you own, what you’ve
            watched, and what’s missing. It never moves, renames or deletes a file unless you ask
            it to in Organize.
          </p>
          <p className="mono mt-8 text-[11px] leading-relaxed text-ink-dim">
            Everything stays on this computer.
            <br />
            You can change all of this later in Settings.
          </p>
        </header>

        <section className="rounded-card border border-edge bg-surface/80 px-7 py-2 shadow-2xl backdrop-blur">
          <ol>
            <Step number="1" title="Choose folders" done={libraries.length > 0}>
              <p className="text-[13px] text-ink-dim">
                Add the folder that holds your TV shows and the one that holds your films. Each
                show should be in its own folder.
              </p>
              {libraries.length > 0 && (
                <ul className="mt-3 overflow-hidden rounded border border-edge">
                  {libraries.map((lib) => (
                    <li
                      key={lib.id}
                      className="flex items-center gap-3 border-b border-edge/60 px-3 py-2 last:border-b-0"
                    >
                      <Badge tone={lib.kind === 'tv' ? 'accent' : 'default'}>
                        {lib.kind === 'tv' ? 'TV' : 'FILMS'}
                      </Badge>
                      {/* rtl so a long path loses its start, not the folder name */}
                      <span
                        dir="rtl"
                        title={lib.path}
                        className="mono min-w-0 flex-1 truncate text-left text-[11.5px] text-ink"
                      >
                        <bdi dir="ltr">{lib.path}</bdi>
                      </span>
                      {!working && phase !== 'done' && (
                        <button
                          onClick={() => removeLibrary(lib.id)}
                          className="text-[11px] text-ink-dim transition hover:text-danger"
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2.5">
                <button onClick={() => choose('tv')} disabled={working} className={hasTv ? ghostBtn : primaryBtn}>
                  {hasTv ? 'Add another TV folder' : 'Add TV folder'}
                </button>
                <button onClick={() => choose('movie')} disabled={working} className={ghostBtn}>
                  {hasFilms ? 'Add another film folder' : 'Add film folder'}
                </button>
              </div>
            </Step>

            <Step number="2" title="Posters & episode lists" done={tmdb?.configured} optional>
              {tmdb?.configured ? (
                <p className="text-[13px] text-ink-dim">
                  TMDB is connected. Posters, official titles and full episode lists will be fetched
                  after the scan.
                </p>
              ) : (
                <>
                  <p className="text-[13px] leading-relaxed text-ink-dim">
                    A free{' '}
                    <a
                      href="https://www.themoviedb.org/settings/api"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      TMDB API key
                    </a>{' '}
                    adds artwork, air dates and accurate missing-episode detection. Without one,
                    Shelf still works and estimates gaps from your file names.
                  </p>
                  <div className="mt-3 flex gap-2.5">
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck="false"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      disabled={working}
                      placeholder="Paste the API Key or Read Access Token"
                      aria-label="TMDB API key"
                      className="mono min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[12px] outline-none transition focus:border-accent/50"
                    />
                    <button
                      onClick={saveKey}
                      disabled={!key.trim() || savingKey || working}
                      className={ghostBtn}
                    >
                      {savingKey ? 'Checking' : 'Save key'}
                    </button>
                  </div>
                </>
              )}
            </Step>

            <Step number="3" title="Build your library" done={phase === 'done'}>
              {phase === 'setup' && (
                <>
                  <p className="text-[13px] text-ink-dim">
                    {libraries.length
                      ? 'Shelf reads every folder you added. Large libraries take a few seconds.'
                      : 'Add at least one folder first.'}
                  </p>
                  <button onClick={start} disabled={!libraries.length} className={`${primaryBtn} mt-3`}>
                    Scan my library
                  </button>
                </>
              )}

              {phase === 'scanning' && (
                <div role="status" className="flex items-center gap-2.5 text-[13px] text-ink">
                  <Spinner />
                  {scanning?.total
                    ? `Reading your folders — ${scanning.done} of ${scanning.total}${scanning.current ? `, ${scanning.current}` : ''}`
                    : 'Reading your folders'}
                </div>
              )}

              {phase === 'matching' && (
                <div role="status" aria-live="polite">
                  {scan && (
                    <p className="mono text-[11px] text-ink-dim">
                      Found {plural(scan.shows, 'show')} and {plural(scan.movies, 'film')} · {plural(scan.files, 'file')}
                    </p>
                  )}
                  <div className="mb-2 mt-3 flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="min-w-0 truncate text-ink">
                      Fetching posters {job?.current ? `· ${job.current}` : ''}
                    </span>
                    <span className="mono shrink-0 text-ink-dim">
                      {job?.done ?? 0}/{job?.total ?? '…'}
                    </span>
                  </div>
                  <ProgressBar value={job?.total ? (job.done / job.total) * 100 : 0} />
                </div>
              )}

              {phase === 'done' && (
                <div role="status">
                  <p className="text-[14px] text-ink">
                    {scan
                      ? `Found ${scan.shows} shows and ${scan.movies} films in ${scan.files} files.`
                      : 'Your library is ready.'}
                    {job?.mode === 'match' &&
                      ` Matched ${job.shows + job.movies} with TMDB${job.failed ? `; ${job.failed} can be fixed later` : ''}.`}
                  </p>
                  <button onClick={() => navigate('/', { replace: true })} className={`${primaryBtn} mt-4`}>
                    Open my library
                  </button>
                </div>
              )}
            </Step>
          </ol>

          {error && <div className="mb-4 text-[12.5px] text-danger">{error}</div>}
        </section>
      </div>

      {phase === 'setup' && (
        <div className="relative pb-10 text-center">
          <Link to="/settings" className="text-[12px] text-ink-dim transition hover:text-ink">
            Skip setup for now
          </Link>
        </div>
      )}

      {picking && (
        <FolderPicker onPick={(path) => addLibrary(path, picking)} onClose={() => setPicking(null)} />
      )}
    </div>
  );
}
