import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatBytes } from '../api';
import { Badge, EmptyState, ProgressBar, SectionTitle, Spinner } from '../components/Bits';
import { FigureStrip, primaryBtn, ghostBtn } from '../components/DetailHero';
import FolderPicker from '../components/FolderPicker';
import AutoOrganize from '../components/AutoOrganize';

const RULES = ['Preview first', 'Never overwrites', 'Every batch can be undone'];

// ---------------------------------------------------------------- naming preview
// Mirrors the server's naming so the example updates as options change.

const pad2 = (n) => String(n).padStart(2, '0');

function sampleEpisode(o) {
  const show = o.tv.showYear ? 'Severance (2022)' : 'Severance';
  const season = o.tv.seasonPad ? 'Season 01' : 'Season 1';
  const parts = ['Severance', `S${pad2(1)}E${pad2(2)}`];
  if (o.tv.episodeTitle) parts.push('Half Loop');
  if (o.tv.quality) parts.push('1080p');
  const file = o.rename ? `${parts.join(' - ')}.mkv` : 'Severance.S01E02.1080p.WEB.H264-GROUP.mkv';
  return [show, season, file];
}

function sampleFilm(o) {
  const base = o.movie.year ? 'Dune Part Two (2024)' : 'Dune Part Two';
  const file = o.rename
    ? `${o.movie.quality ? `${base} - 2160p` : base}.mkv`
    : 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265.mkv';
  return o.movie.folder ? [base, file] : [file];
}

const sepOf = (p) => (p && p.includes('/') && !p.includes('\\') ? '/' : '\\');
const tail = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');

/** Path under a root, shown as "Root\a\b\" + file. */
function splitTarget(to, root) {
  const sep = sepOf(to);
  const rel = root && to.toLowerCase().startsWith(root.toLowerCase()) ? to.slice(root.length).replace(/^[\\/]/, '') : to;
  const parts = rel.split(/[\\/]/);
  const file = parts.pop();
  return { dir: [tail(root), ...parts].filter(Boolean).join(sep) + sep, file };
}

/** A film named without a year: its title (even from TMDB) is only a guess. */
const needsCheck = (i) => i.kind === 'movie' && i.confidence !== 'high';

function relFrom(path, roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const root = list.find((r) => r && path.toLowerCase().startsWith(r.toLowerCase()));
  if (!root) return path;
  const rel = path.slice(root.length).replace(/^[\\/]/, '');
  // With several sources, say which one the file came from.
  return list.length > 1 ? `${tail(root)}${sepOf(path)}${rel}` : rel;
}

// ---------------------------------------------------------------- small pieces

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`flex items-start gap-2.5 py-1 ${disabled ? 'opacity-45' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="block text-[11.5px] leading-snug text-ink-dim">{hint}</span>}
      </span>
    </label>
  );
}

function PathField({ label, value, onChange, onBrowse, placeholder, disabled }) {
  return (
    <div className={disabled ? 'opacity-45' : ''}>
      <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-dim">{label}</div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck="false"
          aria-label={label}
          className="mono min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[12px] text-ink outline-none transition placeholder:text-ink-dim/50 focus:border-accent/50"
        />
        <button onClick={onBrowse} disabled={disabled} className={ghostBtn}>
          Browse
        </button>
      </div>
    </div>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded border border-edge p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-[3px] px-3.5 py-1.5 text-[12px] transition ${
            value === o.value ? 'bg-accent text-accent-ink' : 'text-ink-dim hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ExamplePath({ root, parts }) {
  const sep = sepOf(root);
  const file = parts[parts.length - 1];
  return (
    <div className="mono break-all rounded border border-edge/70 bg-bg px-3 py-2 text-[11px] leading-relaxed">
      <span className="text-ink-dim">{tail(root) || '…'}{sep}{parts.slice(0, -1).map((p) => `${p}${sep}`).join('')}</span>
      <span className="text-ink">{file}</span>
    </div>
  );
}

function Card({ title, children, className = '' }) {
  return (
    <section className={`rounded-card border border-edge bg-surface/60 p-5 ${className}`}>
      <h2 className="display mb-4 text-[13px] uppercase tracking-[0.14em] text-ink-dim">{title}</h2>
      {children}
    </section>
  );
}

function JobProgress({ job }) {
  const pct = job.total_bytes
    ? (job.bytes / job.total_bytes) * 100
    : job.total ? (job.done / job.total) * 100 : null;
  return (
    <div role="status" aria-live="polite" className="rounded-card border border-accent/30 bg-accent/5 px-5 py-4">
      <div className="flex items-center gap-3 text-[13px] text-ink">
        <Spinner />
        <span className="font-medium">{job.phase}</span>
        {job.total > 0 && (
          <span className="mono ml-auto text-[11px] text-ink-dim">
            {job.done}/{job.total}
            {job.total_bytes ? ` · ${formatBytes(job.bytes)} of ${formatBytes(job.total_bytes)}` : ''}
          </span>
        )}
      </div>
      {job.current && <div className="mono mt-1.5 truncate text-[11px] text-ink-dim">{job.current}</div>}
      {pct !== null && <ProgressBar value={pct} className="mt-3" />}
    </div>
  );
}

const TABS = [
  { id: 'ready', label: 'Ready' },
  { id: 'blocked', label: 'Needs attention' },
  { id: 'unknown', label: 'Not recognised' },
];

// ---------------------------------------------------------------- page

export default function OrganizePage() {
  const [form, setForm] = useState(null);
  const [tmdbReady, setTmdbReady] = useState(false);
  const [picking, setPicking] = useState(null);
  const [job, setJob] = useState(null);
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [tab, setTab] = useState('ready');
  // `open` holds the groups toggled away from the default state.
  const [open, setOpen] = useState(() => new Set());
  const [expandAll, setExpandAll] = useState(true);
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  // Long previews render in pages of groups to stay responsive.
  const [shown, setShown] = useState(60);
  const [history, setHistory] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  // Opened from an automatic-run notification: offer that batch's undo up front.
  const [params, setParams] = useSearchParams();
  const batchParam = params.get('batch');

  const opts = form?.options;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setOpt = (path, value) =>
    setForm((f) => {
      const options = structuredClone(f.options);
      const keys = path.split('.');
      let node = options;
      for (const k of keys.slice(0, -1)) node = node[k];
      node[keys[keys.length - 1]] = value;
      return { ...f, options };
    });

  async function loadHistory() {
    setHistory(await api.organizeHistory().catch(() => []));
  }

  async function loadPlan() {
    const p = await api.organizePlan();
    setPlan(p);
    // Guesses start unticked; everything else that is ready starts ticked.
    setSelected(new Set(p.items.filter((i) => i.status === 'ok' && !needsCheck(i)).map((i) => i.id)));
    setOpen(new Set());
    // Big previews start collapsed so the page stays quick.
    setExpandAll(p.items.length + p.unidentified.length <= 120);
    setTab(p.items.some((i) => i.status === 'ok') ? 'ready' : p.items.length ? 'blocked' : 'unknown');
  }

  // Follow a background job until it ends.
  function follow() {
    clearTimeout(pollRef.current);
    const tick = async () => {
      try {
        const j = await api.organizeJob();
        setJob(j);
        if (j.running) {
          pollRef.current = setTimeout(tick, 700);
          return;
        }
        if (j.error) setError(j.error);
        else if (j.type === 'preview') await loadPlan();
        else if (j.type === 'auto-organize') {
          window.dispatchEvent(new CustomEvent('shelf:auto-changed'));
          window.dispatchEvent(new CustomEvent('shelf:refresh'));
        } else if (j.type === 'organize' || j.type === 'undo') {
          setResult({ type: j.type, ...j.result });
          setPlan(null);
          window.dispatchEvent(new CustomEvent('shelf:refresh'));
        }
        loadHistory();
      } catch (err) {
        setError(err.message);
      }
    };
    tick();
  }

  useEffect(() => {
    (async () => {
      const [defaults, tmdb, j] = await Promise.all([
        api.organizeDefaults(),
        api.tmdbStatus().catch(() => ({ configured: false })),
        api.organizeJob(),
      ]);
      setForm(defaults);
      setTmdbReady(Boolean(tmdb.configured));
      setJob(j);
      if (j.running) follow();
      else if (j.plan_id) await loadPlan().catch(() => {});
      loadHistory();
    })().catch((err) => setError(err.message));
    return () => clearTimeout(pollRef.current);
  }, []);

  useEffect(() => {
    if (!confirming) return undefined;
    const onKey = (e) => e.key === 'Escape' && setConfirming(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirming]);

  function pickFolder(title) {
    if (window.shelf?.pickFolder) return window.shelf.pickFolder(title);
    return new Promise((resolve) => setPicking({ title, resolve }));
  }

  async function choose(field, title) {
    const path = await pickFolder(title);
    if (!path) return;
    if (field === 'dest') {
      const sep = sepOf(path);
      const base = path.replace(/[\\/]+$/, '');
      set({ tvRoot: `${base}${sep}TV Series`, movieRoot: `${base}${sep}Movies` });
    } else {
      set({ [field]: path });
    }
  }

  // One-click previews that don't touch the form: watched folders, and the
  // library itself (new episodes that landed outside their season folder).
  async function quickPreview(body) {
    setError(null);
    setResult(null);
    setPlan(null);
    try {
      setJob(await api.organizePreview({ ...body, remember: false }));
      follow();
      document.getElementById('organize-results')?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    }
  }

  function reviewWatched(config) {
    quickPreview({ sources: config.folders, tvRoot: config.tvRoot, movieRoot: config.movieRoot, options: config.options });
  }

  async function tidyLibrary() {
    const libs = (await api.libraries()).filter((l) => l.enabled);
    const tv = libs.find((l) => l.kind === 'tv');
    const film = libs.find((l) => l.kind === 'movie');
    if (!libs.length) {
      setError('Add a library in Settings first.');
      return;
    }
    quickPreview({
      sources: libs.map((l) => l.path),
      tvRoot: tv?.path,
      movieRoot: film?.path,
      options: { ...opts, include: { tv: Boolean(tv), movies: Boolean(film) } },
    });
  }

  async function preview() {
    setError(null);
    setResult(null);
    setPlan(null);
    try {
      setJob(await api.organizePreview(form));
      follow();
    } catch (err) {
      setError(err.message);
    }
  }

  async function apply() {
    setConfirming(false);
    setError(null);
    try {
      setJob(await api.organizeApply(plan.id, [...selected]));
      follow();
    } catch (err) {
      setError(err.message);
    }
  }

  async function undo(batchId) {
    setError(null);
    try {
      setJob(await api.organizeUndo(batchId));
      follow();
    } catch (err) {
      setError(err.message);
    }
  }

  const buckets = useMemo(() => {
    const items = plan?.items || [];
    return {
      ready: items.filter((i) => i.status === 'ok'),
      blocked: items.filter((i) => i.status !== 'ok'),
      unknown: plan?.unidentified || [],
    };
  }, [plan]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map();
    for (const i of tab === 'unknown' ? [] : buckets[tab]) {
      if (kindFilter !== 'all' && i.kind !== kindFilter) continue;
      if (q && !i.title.toLowerCase().includes(q) && !i.from.toLowerCase().includes(q)) continue;
      const k = `${i.kind}:${i.title}`;
      if (!map.has(k)) map.set(k, { key: k, kind: i.kind, title: i.title, year: i.year, source: i.source, items: [] });
      map.get(k).items.push(i);
    }
    return [...map.values()];
  }, [buckets, tab, filter, kindFilter]);

  useEffect(() => setShown(60), [tab, filter, kindFilter, plan]);

  const chosen = buckets.ready.filter((i) => selected.has(i.id));
  const chosenBytes = chosen.reduce((n, i) => n + (i.size_bytes || 0), 0);
  const running = Boolean(job?.running);
  const verb = plan?.options.mode === 'copy' ? 'Copy' : plan?.options.mode === 'rename' ? 'Rename' : 'Move';

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(items, on) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of items) {
        if (on) next.add(i.id);
        else next.delete(i.id);
      }
      return next;
    });
  }

  if (!form) {
    return error ? (
      <div className="text-sm text-danger">{error}</div>
    ) : (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Loading
      </div>
    );
  }

  const [epShow, epSeason, epFile] = sampleEpisode(opts);

  return (
    <div className="pb-24">
      <header className="mb-7">
        <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">File organizer</div>
        <h1 className="display mt-2 text-[42px] uppercase leading-none text-ink">Organize</h1>
        <p className="mt-2.5 max-w-[66ch] text-[13px] leading-relaxed text-ink-dim">
          Point Shelf at any folder or drive. It works out what each video is from its name and
          folders, previews a tidy layout, and only touches the files you approve.
        </p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {RULES.map((rule) => (
            <li
              key={rule}
              className="mono flex items-center gap-2 rounded-full border border-edge px-3 py-1 text-[10.5px] text-ink-dim"
            >
              <span className="h-1 w-1 rounded-full bg-accent" />
              {rule}
            </li>
          ))}
        </ul>
      </header>

      {batchParam && (() => {
        const batch = history.find((h) => h.batch_id === batchParam);
        if (!batch) return null;
        return (
          <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-card border border-accent/35 bg-accent/10 px-4 py-3 text-[13px] text-ink">
            <span>
              {batch.active
                ? `Shelf organized ${batch.active} file${batch.active === 1 ? '' : 's'} from your watched folders.`
                : 'That automatic batch has already been undone.'}
            </span>
            {batch.active > 0 && (
              <button onClick={() => undo(batch.batch_id)} disabled={running} className={ghostBtn}>
                Undo it
              </button>
            )}
            <button onClick={() => setParams({})} className="ml-auto text-[12px] text-ink-dim hover:text-ink">
              Dismiss
            </button>
          </div>
        );
      })()}

      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <button onClick={tidyLibrary} disabled={running} className={ghostBtn} title="Find episodes and films in your libraries that are not where they belong">
          Tidy my library
        </button>
        <span className="text-[12px] text-ink-dim">
          Checks your libraries with the naming below; existing folders are kept.
        </span>
      </div>

      <div className="mb-8">
        <AutoOrganize
          form={form}
          pickFolder={pickFolder}
          onReview={reviewWatched}
          onChanged={loadHistory}
          busy={running}
        />
      </div>

      <h2 className="display mb-3 text-[13px] uppercase tracking-[0.14em] text-ink-dim">Organize a folder now</h2>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Folders">
          <div className="grid gap-4">
            <PathField
              label="Organize files from"
              value={form.source}
              onChange={(v) => set({ source: v })}
              onBrowse={() => choose('source', 'Choose the folder or drive to organize')}
              placeholder="E:\Downloads"
              disabled={running}
            />
            {opts.mode === 'rename' ? (
              <div className="border-t border-edge/70 pt-4 text-[12.5px] text-ink-dim">
                No destination needed. Every file stays in the folder it is in now, and only its
                name changes, using the naming you choose on the right.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-t border-edge/70 pt-4">
                  <span className="text-[12.5px] text-ink-dim">Into one destination:</span>
                  <button
                    onClick={() => choose('dest', 'Choose where organized files should go')}
                    disabled={running}
                    className={ghostBtn}
                  >
                    Choose destination
                  </button>
                </div>
                <PathField
                  label="TV series go to"
                  value={form.tvRoot}
                  onChange={(v) => set({ tvRoot: v })}
                  onBrowse={() => choose('tvRoot', 'Choose where TV series should go')}
                  placeholder="E:\Media\TV Series"
                  disabled={running || !opts.include.tv}
                />
                <PathField
                  label="Films go to"
                  value={form.movieRoot}
                  onChange={(v) => set({ movieRoot: v })}
                  onBrowse={() => choose('movieRoot', 'Choose where films should go')}
                  placeholder="E:\Media\Movies"
                  disabled={running || !opts.include.movies}
                />
              </>
            )}
            <div className="flex flex-wrap gap-x-6 border-t border-edge/70 pt-3">
              <Toggle checked={opts.include.tv} onChange={(v) => setOpt('include.tv', v)} label="TV series" disabled={running} />
              <Toggle checked={opts.include.movies} onChange={(v) => setOpt('include.movies', v)} label="Films" disabled={running} />
            </div>
          </div>
        </Card>

        <Card title="How">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="What to do with the files"
              value={opts.mode}
              onChange={(v) => setOpt('mode', v)}
              options={[
                { value: 'move', label: 'Move' },
                { value: 'copy', label: 'Copy' },
                { value: 'rename', label: 'Rename only' },
              ]}
            />
            <span className="text-[11.5px] text-ink-dim">
              {opts.mode === 'move'
                ? 'Files leave the source folder.'
                : opts.mode === 'copy'
                  ? 'Originals stay where they are; needs free space.'
                  : 'Nothing moves. Every file keeps its folder and only its name changes.'}
            </span>
          </div>

          <div className="mt-4 border-t border-edge/70 pt-3">
            <Toggle
              checked={opts.rename}
              onChange={(v) => setOpt('rename', v)}
              label="Rename files"
              hint="Off keeps the original file names and only sorts them into folders."
            />
            <Toggle
              checked={opts.useTmdb && tmdbReady}
              disabled={!tmdbReady}
              onChange={(v) => setOpt('useTmdb', v)}
              label="Use official titles and episode names from TMDB"
              hint={tmdbReady ? 'Fixes typos in names. Titles only; nothing is uploaded.' : 'Add a TMDB key in Settings to turn this on.'}
            />
          </div>

          <div className="mt-3 grid gap-x-6 gap-y-1 border-t border-edge/70 pt-3 sm:grid-cols-2">
            <div className={opts.include.tv ? '' : 'opacity-45'}>
              <div className="mono mb-1 text-[10px] uppercase tracking-[0.16em] text-ink-dim">TV series</div>
              <Toggle checked={opts.tv.showYear} onChange={(v) => setOpt('tv.showYear', v)} label="Year on the show folder" />
              <Toggle checked={opts.tv.seasonPad} onChange={(v) => setOpt('tv.seasonPad', v)} label={'"Season 01" (not "Season 1")'} />
              <Toggle checked={opts.tv.episodeTitle} disabled={!opts.rename} onChange={(v) => setOpt('tv.episodeTitle', v)} label="Episode title in the name" />
              <Toggle checked={opts.tv.quality} disabled={!opts.rename} onChange={(v) => setOpt('tv.quality', v)} label="Quality in the name" />
            </div>
            <div className={opts.include.movies ? '' : 'opacity-45'}>
              <div className="mono mb-1 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Films</div>
              <Toggle checked={opts.movie.folder} onChange={(v) => setOpt('movie.folder', v)} label="A folder for each film" />
              <Toggle checked={opts.movie.year} onChange={(v) => setOpt('movie.year', v)} label="Year in the name" />
              <Toggle checked={opts.movie.quality} disabled={!opts.rename} onChange={(v) => setOpt('movie.quality', v)} label="Quality in the name" />
            </div>
          </div>

          <div className="mt-4 grid gap-2 border-t border-edge/70 pt-4">
            <div className="mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">Example</div>
            {opts.include.tv && <ExamplePath root={form.tvRoot || 'TV Series'} parts={[epShow, epSeason, epFile]} />}
            {opts.include.movies && <ExamplePath root={form.movieRoot || 'Movies'} parts={sampleFilm(opts)} />}
          </div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={preview} disabled={running || !form.source} className={primaryBtn}>
          {plan ? 'Preview again' : 'Preview'}
        </button>
        <span className="text-[12px] text-ink-dim">Reads folder and file names only. Nothing changes yet.</span>
      </div>

      <div id="organize-results" className="mt-6 grid scroll-mt-20 gap-4">
        {error && (
          <div role="alert" className="rounded-card border border-danger/35 bg-danger/10 px-4 py-3 text-[13px] text-danger">
            {error}
          </div>
        )}
        {running && <JobProgress job={job} />}
        {result && !running && <ResultBanner result={result} onUndo={undo} />}
      </div>

      {plan && !running && (
        <section className="mt-8">
          <FigureStrip
            items={[
              { label: 'Videos found', value: plan.summary.scanned },
              { label: 'Series · episodes', value: `${plan.summary.shows} · ${plan.summary.episodes}` },
              { label: 'Films', value: plan.summary.movies },
              { label: 'Selected', value: `${chosen.length} · ${formatBytes(chosenBytes)}`, tone: chosen.length ? 'accent' : null },
              { label: 'Needs attention', value: buckets.blocked.length + buckets.unknown.length, tone: buckets.blocked.length + buckets.unknown.length ? 'warn' : null },
            ]}
          />

          {plan.summary.already_tidy > 0 && (
            <p className="-mt-5 mb-5 text-[12px] text-ink-dim">
              {plan.summary.already_tidy} file{plan.summary.already_tidy === 1 ? ' is' : 's are'} already where they belong.
              {plan.summary.truncated && ' Stopped after 25,000 videos; choose a smaller folder to see the rest.'}
              {plan.summary.tmdb_errors > 0 && ` ${plan.summary.tmdb_errors} TMDB lookups failed; those use names from the files.`}
            </p>
          )}

          <SectionTitle
            action={
              <div role="tablist" aria-label="Preview sections" className="flex gap-1">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={`rounded px-3 py-1.5 text-[12px] transition ${
                      tab === t.id ? 'bg-accent/10 text-accent' : 'text-ink-dim hover:text-ink'
                    }`}
                  >
                    {t.label} <span className="mono text-[10.5px] opacity-70">{buckets[t.id].length}</span>
                  </button>
                ))}
              </div>
            }
          >
            Preview
          </SectionTitle>

          {tab !== 'unknown' && buckets[tab].length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by title or file name"
                aria-label="Filter the preview"
                className="w-full max-w-xs rounded border border-edge bg-surface px-3 py-1.5 text-[12.5px] outline-none transition placeholder:text-ink-dim/60 focus:border-accent/50"
              />
              <Segmented
                label="Show"
                value={kindFilter}
                onChange={setKindFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'tv', label: 'Series' },
                  { value: 'movie', label: 'Films' },
                ]}
              />
              {groups.length > 0 && (
                <button
                  onClick={() => {
                    setExpandAll(!expandAll);
                    setOpen(new Set());
                  }}
                  className="text-[12px] text-ink-dim hover:text-ink"
                >
                  {expandAll ? 'Collapse all' : 'Expand all'}
                </button>
              )}
              {(filter || kindFilter !== 'all') && (
                <span className="mono text-[11px] text-ink-dim">
                  {groups.reduce((n, g) => n + g.items.length, 0)} shown
                </span>
              )}
            </div>
          )}

          {tab === 'unknown' ? (
            buckets.unknown.length ? (
              <div className="overflow-hidden rounded-card border border-edge">
                {buckets.unknown.map((u) => (
                  <div key={u.from} className="flex items-center gap-4 border-b border-edge/60 px-4 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="mono truncate text-[11.5px] text-ink">{relFrom(u.from, plan.sources || plan.source)}</div>
                      <div className="text-[11px] text-ink-dim">
                        {u.reason}. Left where it is.
                        {u.embedded_title && !u.reason.includes(u.embedded_title) && (
                          <span> Title inside the file: <span className="text-ink">{u.embedded_title}</span>.</span>
                        )}
                      </div>
                    </div>
                    <span className="mono text-[11px] text-ink-dim">{formatBytes(u.size_bytes)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="✓" title="Everything recognised" />
            )
          ) : !groups.length ? (
            <EmptyState
              icon="✓"
              title={tab === 'ready' ? 'Nothing to do' : 'No problems'}
              hint={tab === 'ready' ? 'Every recognised video is already where it belongs.' : undefined}
            />
          ) : (
            <div className="grid gap-2.5">
              {groups.slice(0, shown).map((g) => {
                const expanded = expandAll ? !open.has(g.key) : open.has(g.key);
                const on = g.items.filter((i) => selected.has(i.id)).length;
                const root = g.kind === 'tv' ? plan.tvRoot : plan.movieRoot;
                return (
                  <div key={g.key} className="overflow-hidden rounded-card border border-edge">
                    <div className="flex items-center gap-3 bg-surface/60 px-4 py-2.5">
                      {tab === 'ready' && (
                        <input
                          type="checkbox"
                          aria-label={`Select all of ${g.title}`}
                          checked={on === g.items.length}
                          ref={(el) => el && (el.indeterminate = on > 0 && on < g.items.length)}
                          onChange={(e) => toggleGroup(g.items, e.target.checked)}
                          className="h-3.5 w-3.5 accent-accent"
                        />
                      )}
                      <button
                        onClick={() => setOpen((s) => {
                          const n = new Set(s);
                          if (n.has(g.key)) n.delete(g.key);
                          else n.add(g.key);
                          return n;
                        })}
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <span className={`text-[10px] text-ink-dim transition ${expanded ? 'rotate-90' : ''}`}>▶</span>
                        <span className="display truncate text-[13.5px] uppercase tracking-wide text-ink">
                          {g.title}
                          {g.year ? <span className="text-ink-dim"> {g.year}</span> : null}
                        </span>
                        <Badge>{g.kind === 'tv' ? 'Series' : 'Film'}</Badge>
                        {g.source === 'tmdb' && <Badge tone="good" title="Name checked against TMDB">TMDB</Badge>}
                      </button>
                      <span className="mono shrink-0 text-[10.5px] text-ink-dim">
                        {g.kind === 'tv' ? `${g.items.length} ep` : ''} {formatBytes(g.items.reduce((n, i) => n + (i.size_bytes || 0), 0))}
                      </span>
                    </div>

                    {expanded && g.items.map((i) => {
                      const target = splitTarget(i.to, root);
                      return (
                        <label
                          key={i.id}
                          className={`grid grid-cols-[14px_minmax(0,1fr)_64px] items-start gap-3 border-t border-edge/60 px-4 py-2 ${
                            tab === 'ready' ? 'cursor-pointer hover:bg-surface/50' : ''
                          }`}
                        >
                          {tab === 'ready' ? (
                            <input
                              type="checkbox"
                              checked={selected.has(i.id)}
                              onChange={() => toggle(i.id)}
                              className="mt-0.5 h-3.5 w-3.5 accent-accent"
                            />
                          ) : (
                            <span className="mt-1 h-2 w-2 rounded-full bg-warn" aria-hidden="true" />
                          )}
                          <div className="min-w-0">
                            <div className="mono truncate text-[11px] text-ink-dim" title={i.from}>
                              {relFrom(i.from, plan.sources || plan.source)}
                            </div>
                            <div className="mono mt-0.5 truncate text-[11.5px]" title={i.to}>
                              <span className="text-accent">→ </span>
                              <span className="text-ink-dim">{target.dir}</span>
                              <span className="text-ink">{target.file}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {i.note && <Badge tone="warn">{i.note}</Badge>}
                              {i.hint === 'folder' && <Badge title="Named from the folder it was in">from folder</Badge>}
                              {needsCheck(i) && (
                                <Badge tone="warn" title="The file name has no year, so this title is a guess. Tick it if it is right.">
                                  check title
                                </Badge>
                              )}
                              {i.sidecars?.length > 0 && (
                                <Badge tone="accent">+{i.sidecars.length} subtitle{i.sidecars.length === 1 ? '' : 's'}</Badge>
                              )}
                              {i.creates_folder && <Badge>new folder</Badge>}
                            </div>
                          </div>
                          <span className="mono text-right text-[11px] text-ink-dim">
                            {i.size_bytes ? formatBytes(i.size_bytes) : '—'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
              {groups.length > shown && (
                <button onClick={() => setShown((n) => n + 60)} className={`${ghostBtn} justify-self-center`}>
                  Show {Math.min(60, groups.length - shown)} more of {groups.length - shown}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="mt-11">
          <SectionTitle>History</SectionTitle>
          <div className="overflow-hidden rounded-card border border-edge">
            {history.map((h) => (
              <div key={h.batch_id} className="flex items-center gap-4 border-b border-edge/60 px-4 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink">
                    {h.operations} file{h.operations === 1 ? '' : 's'} {h.copies === h.operations ? 'copied' : 'moved'}
                    {h.failed > 0 && <span className="text-danger"> · {h.failed} failed</span>}
                  </div>
                  <div className="mono truncate text-[10.5px] text-ink-dim">
                    {h.created_at} {h.sample_to ? `· ${h.sample_to}` : ''}
                  </div>
                </div>
                {h.undone > 0 && <Badge>{h.undone} undone</Badge>}
                {h.active > 0 && (
                  <button onClick={() => undo(h.batch_id)} disabled={running} className={ghostBtn}>
                    Undo {h.active}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {plan && !running && tab === 'ready' && buckets.ready.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-bg/90 backdrop-blur-xl lg:left-[196px]">
          <div className="flex flex-wrap items-center gap-3 gutter-x py-3">
            <span className="text-[13px] text-ink">
              {chosen.length} of {buckets.ready.length} selected
              <span className="mono text-ink-dim"> · {formatBytes(chosenBytes)}</span>
            </span>
            <button onClick={() => setSelected(new Set(buckets.ready.map((i) => i.id)))} className="text-[12px] text-accent hover:underline">
              All
            </button>
            <button onClick={() => setSelected(new Set())} className="text-[12px] text-ink-dim hover:text-ink">
              None
            </button>
            <button onClick={() => setConfirming(true)} disabled={!chosen.length} className={`${primaryBtn} ml-auto`}>
              {verb} {chosen.length} file{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={() => setConfirming(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="w-full max-w-md rounded-card border border-edge bg-surface p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Confirm</div>
            <h3 id="confirm-title" className="display mt-2 text-[24px] uppercase leading-tight text-ink">
              {verb} {chosen.length} file{chosen.length === 1 ? '' : 's'}?
            </h3>
            <p className="mt-3 text-[13.5px] leading-relaxed text-ink-dim">
              {formatBytes(chosenBytes)}
              {plan.options.mode === 'copy'
                ? ' will be copied. The originals stay where they are.'
                : ' will move. Across drives that means copy, check, then remove the original.'}
              {plan.options.rename ? ' Files are renamed as previewed.' : ' File names stay as they are.'} Nothing
              is overwritten, and the batch can be undone from History.
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button onClick={() => setConfirming(false)} className={ghostBtn}>
                Cancel
              </button>
              <button autoFocus onClick={apply} className={primaryBtn}>
                {verb} files
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <FolderPicker
          title={picking.title}
          onPick={(path) => {
            picking.resolve(path);
            setPicking(null);
          }}
          onClose={() => {
            picking.resolve(null);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function ResultBanner({ result, onUndo }) {
  if (result.type === 'undo') {
    return (
      <div role="status" className="rounded-card border border-accent/35 bg-accent/10 px-4 py-3 text-[13px] text-ink">
        Put back {result.reverted} file{result.reverted === 1 ? '' : 's'}
        {result.skipped ? ` · ${result.skipped} skipped` : ''}
        {result.failed ? ` · ${result.failed} failed` : ''}
      </div>
    );
  }
  const verb = result.mode === 'copy' ? 'Copied' : result.mode === 'rename' ? 'Renamed' : 'Moved';
  return (
    <div role="status" className="rounded-card border border-accent/35 bg-accent/10 px-4 py-3 text-[13px] text-ink">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          {verb} {result.done} file{result.done === 1 ? '' : 's'}
          {result.sidecars ? ` and ${result.sidecars} subtitle${result.sidecars === 1 ? '' : 's'}` : ''}
          {result.skipped ? ` · ${result.skipped} skipped` : ''}
          {result.failed ? ` · ${result.failed} failed` : ''}
        </span>
        {result.done > 0 && (
          <button onClick={() => onUndo(result.batch_id)} className="ml-auto text-accent underline-offset-2 hover:underline">
            Undo this batch
          </button>
        )}
      </div>
      {result.errors?.length > 0 && (
        <ul className="mono mt-2 grid gap-0.5 text-[11px] text-danger">
          {result.errors.slice(0, 8).map((e) => (
            <li key={e.file} className="truncate">{e.file}: {e.message}</li>
          ))}
        </ul>
      )}
      {result.warnings?.length > 0 && (
        <ul className="mono mt-2 grid gap-0.5 text-[11px] text-warn">
          {result.warnings.slice(0, 8).map((w) => (
            <li key={w.file} className="truncate">{w.file}: {w.message}</li>
          ))}
        </ul>
      )}
      {result.empty_folders?.length > 0 && (
        <details className="mt-2 text-[12px] text-ink-dim">
          <summary className="cursor-pointer">
            {result.empty_folders.length} source folder{result.empty_folders.length === 1 ? ' has' : 's have'} no videos left
          </summary>
          <p className="mt-1">Shelf leaves them in place. Delete them yourself if you no longer need them.</p>
          <ul className="mono mt-1 grid gap-0.5 text-[11px]">
            {result.empty_folders.slice(0, 30).map((f) => (
              <li key={f.path} className="truncate">
                {f.path}
                {f.leftover_files ? ` (${f.leftover_files} other file${f.leftover_files === 1 ? '' : 's'})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
