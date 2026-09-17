// Automatic organising of watched folders (a Downloads folder, say).
//
// Every few minutes Shelf previews the watched folders with the user's saved
// destination and naming choices, then:
//   - "confident" mode moves the files it is sure about and leaves the rest
//     waiting for review;
//   - "review" mode moves nothing and only reports what is waiting.
// A file is "sure" when it is ready (no clash, not still downloading) and its
// title was confirmed by TMDB -- or, without a TMDB key, when its name alone
// is unambiguous. Files still being written are never touched.
import { EventEmitter } from 'node:events';
import { getSetting, setSetting } from './db.js';
import { hasApiKey } from './tmdb.js';
import { planImport, applyPlan, runJob, organizeBusy, normalizeOptions, sourceList } from './organizer.js';
import { scanLibraries } from './scanner/scan.js';
import { watch as watchFs } from 'node:fs';
import { fetchSubtitlesFor } from './autoSubtitles.js';
import { startProbe } from './mediainfo.js';

export const autoEvents = new EventEmitter();

const INTERVALS = [5, 15, 30, 60, 180, 360];
const LOG_LIMIT = 30;

const DEFAULTS = {
  enabled: false,
  folders: [],
  tvRoot: '',
  movieRoot: '',
  options: normalizeOptions(),
  intervalMinutes: 15,
  mode: 'confident',
  settleMinutes: 10,
};

export function autoConfig() {
  const saved = JSON.parse(getSetting('organize.auto', 'null') || 'null') || {};
  return { ...DEFAULTS, ...saved, options: normalizeOptions(saved.options) };
}

/** Validate and save. Paths are checked now so a typo fails here, not at 3 am. */
export function setAutoConfig(patch = {}) {
  const next = { ...autoConfig() };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.folders !== undefined) next.folders = patch.folders.length ? sourceList(null, patch.folders) : [];
  if (patch.tvRoot !== undefined) next.tvRoot = String(patch.tvRoot || '');
  if (patch.movieRoot !== undefined) next.movieRoot = String(patch.movieRoot || '');
  if (patch.options !== undefined) next.options = normalizeOptions(patch.options);
  if (patch.intervalMinutes !== undefined) {
    if (!INTERVALS.includes(Number(patch.intervalMinutes))) throw new Error('Unsupported interval');
    next.intervalMinutes = Number(patch.intervalMinutes);
  }
  if (patch.mode !== undefined) next.mode = patch.mode === 'review' ? 'review' : 'confident';
  if (patch.settleMinutes !== undefined) {
    next.settleMinutes = Math.min(Math.max(Number(patch.settleMinutes) || 10, 1), 120);
  }

  if (next.enabled) {
    if (!next.folders.length) throw new Error('Add at least one folder to watch');
    if (next.options.include.tv && !next.tvRoot) throw new Error('Choose where TV series should go');
    if (next.options.include.movies && !next.movieRoot) throw new Error('Choose where films should go');
    // A watched folder inside a destination would re-organise the library itself.
    for (const f of next.folders) {
      for (const root of [next.tvRoot, next.movieRoot].filter(Boolean)) {
        const a = f.toLowerCase().replace(/[\\/]+$/, '');
        const b = root.toLowerCase().replace(/[\\/]+$/, '');
        if (a === b || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`)) {
          throw new Error(`Don't watch ${f}: organised files go inside it, so they would be picked up again`);
        }
      }
    }
  }
  setSetting('organize.auto', JSON.stringify(next));
  schedule.nextAt = next.enabled ? Date.now() + 30_000 : null;
  refreshWatchers();
  return autoStatus();
}

// ---------------------------------------------------------------- state

const schedule = { nextAt: null, running: false, lastSignature: null };

function readLog() {
  return JSON.parse(getSetting('organize.autoLog', '[]') || '[]');
}

function writeLog(entry) {
  setSetting('organize.autoLog', JSON.stringify([entry, ...readLog()].slice(0, LOG_LIMIT)));
}

export function autoStatus() {
  const pending = JSON.parse(getSetting('organize.autoPending', 'null') || 'null');
  return {
    config: autoConfig(),
    intervals: INTERVALS,
    running: schedule.running,
    next_run: schedule.nextAt ? new Date(schedule.nextAt).toISOString() : null,
    tmdb: hasApiKey(),
    pending,
    log: readLog(),
  };
}

/**
 * Sure enough to move without asking? The name itself must be unambiguous (an
 * episode marker with a show name, or a film title with its year), and with a
 * TMDB key the title must also be confirmed. A yearless "grandma birthday.mp4"
 * once matched a real film on TMDB; it must wait for a person.
 */
export function isConfident(item, tmdbAvailable) {
  if (item.status !== 'ok' || item.confidence !== 'high') return false;
  // A title the library already confirmed counts as checked.
  if (item.source === 'library') return true;
  return tmdbAvailable ? item.source === 'tmdb' : true;
}

/**
 * One pass over the watched folders. Returns the log entry, or null when it
 * could not run (disabled, nothing to watch, or another organiser job busy).
 */
export async function runAutoOrganize({ manual = false } = {}) {
  const config = autoConfig();
  if (!config.folders.length || (!config.enabled && !manual)) return null;
  if (schedule.running || organizeBusy()) return null;

  schedule.running = true;
  const started = Date.now();
  try {
    let entry;
    await new Promise((resolve, reject) => {
      runJob('auto-organize', async (onProgress) => {
        try {
          entry = await pass(config, onProgress, manual);
          resolve();
          return entry;
        } catch (err) {
          reject(err);
          throw err;
        }
      });
    });
    return entry;
  } catch (err) {
    const entry = { at: new Date(started).toISOString(), manual, error: String(err?.message || err), moved: 0, waiting: 0 };
    writeLog(entry);
    autoEvents.emit('run', entry);
    return entry;
  } finally {
    schedule.running = false;
    schedule.nextAt = config.enabled ? Date.now() + config.intervalMinutes * 60_000 : null;
  }
}

async function pass(config, report, manual) {
  const at = new Date().toISOString();
  const onProgress = (p) => report(p.phase ? { ...p, phase: `Watched folders: ${p.phase.toLowerCase()}` } : p);
  const tmdbAvailable = config.options.useTmdb && hasApiKey();
  const plan = await planImport({
    sources: config.folders,
    tvRoot: config.tvRoot,
    movieRoot: config.movieRoot,
    options: config.options,
    settleMs: config.settleMinutes * 60_000,
    onProgress,
  });

  const sure = config.mode === 'confident' ? plan.items.filter((i) => isConfident(i, tmdbAvailable)) : [];
  const busy = plan.items.filter((i) => i.status === 'busy');
  const waitingItems = plan.items.filter((i) => i.status !== 'busy' && !sure.includes(i));
  const waiting = waitingItems.length + plan.unidentified.length;

  let result = null;
  if (sure.length) {
    result = await applyPlan(plan, sure.map((i) => i.id), { onProgress });
    // Paths changed on disk; bring the library up to date.
    scanLibraries();
    startProbe();
    fetchSubtitlesFor(result.moved_paths);
  }

  setSetting('organize.autoPending', JSON.stringify({
    at,
    count: waiting,
    downloading: busy.length,
    titles: [...new Set(waitingItems.map((i) => i.title))].slice(0, 12),
    unrecognised: plan.unidentified.length,
  }));

  // Quiet passes (nothing moved, nothing new) are not worth a log line.
  const signature = JSON.stringify([waiting, busy.length, result?.done ?? 0]);
  const idle = !waiting && !busy.length;
  const quiet = !manual && !result && (idle || signature === schedule.lastSignature);
  schedule.lastSignature = signature;

  const entry = {
    at,
    manual,
    moved: result?.done ?? 0,
    failed: result?.failed ?? 0,
    batch_id: result?.done ? result.batch_id : null,
    titles: [...new Set(sure.map((i) => i.title))].slice(0, 12),
    waiting,
    downloading: busy.length,
    errors: (result?.errors || []).slice(0, 5),
  };
  if (!quiet) {
    writeLog(entry);
    autoEvents.emit('run', entry);
  }
  return entry;
}

// ---------------------------------------------------------------- live watching

// Besides the schedule, a change inside a watched folder brings the next pass
// forward to just after the settle time, so a finished download is organised
// within minutes instead of at the next scheduled check.
const watchers = new Map();

function onFolderChange() {
  const config = autoConfig();
  if (!config.enabled) return;
  const soon = Date.now() + config.settleMinutes * 60_000 + 20_000;
  if (!schedule.nextAt || soon < schedule.nextAt) schedule.nextAt = soon;
}

export function refreshWatchers() {
  const config = autoConfig();
  const wanted = new Set(config.enabled ? config.folders : []);
  for (const [path, w] of watchers) {
    if (!wanted.has(path)) {
      w.close();
      watchers.delete(path);
    }
  }
  for (const path of wanted) {
    if (watchers.has(path)) continue;
    try {
      const w = watchFs(path, { recursive: true, persistent: false }, onFolderChange);
      w.on('error', () => {
        w.close();
        watchers.delete(path);
      });
      watchers.set(path, w);
    } catch {
      // Not every file system can be watched; the schedule still covers it.
    }
  }
}

export function watchedFolderCount() {
  return watchers.size;
}

let timer = null;

/** Check every half minute whether a pass is due. Timers never keep the process alive. */
export function scheduleAutoOrganize() {
  if (timer) return;
  refreshWatchers();
  const config = autoConfig();
  schedule.nextAt = config.enabled ? Date.now() + 45_000 : null;
  timer = setInterval(() => {
    if (!schedule.nextAt || Date.now() < schedule.nextAt) return;
    runAutoOrganize().catch(() => {});
  }, 30_000);
  timer.unref?.();
}
