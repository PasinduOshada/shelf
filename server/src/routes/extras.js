// Routes for the library tools: duplicates, episode corrections, media info,
// new-episode alerts, automatic subtitles, playback, imports, Trakt, backups.
import { Router } from 'express';
import multer from 'multer';
import { readFileSync } from 'node:fs';
import { db, setSetting } from '../db.js';
import { scanLibraries } from '../scanner/scan.js';
import { duplicateGroups, trashDuplicate } from '../duplicates.js';
import { probeStatus, startProbe } from '../mediainfo.js';
import { airingToday, airedBetween, airingEnabled } from '../airing.js';
import { autoSubtitleStatus, setAutoSubtitles, fetchSubtitlesFor } from '../autoSubtitles.js';
import { activeSessions } from '../playback.js';
import { setPlaybackSettings } from '../player.js';
import { previewImport, applyImport } from '../importers/tvtime.js';
import { traktStatus, setTraktApp, startDeviceLogin, disconnectTrakt, syncTrakt } from '../importers/trakt.js';
import { exportBackup, importBackup } from '../backup.js';

const router = Router();
// Uploads are read into memory, so keep them small: a TV Time export and a
// Shelf backup are both a few MB.
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024, files: 5 } });

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.status || 400).json({ error: String(err?.message || err) });
  }
};

// ---------------------------------------------------------------- duplicates

router.get('/duplicates/groups', handle(() => duplicateGroups()));

router.post('/files/:id/trash', handle(async (req) => {
  if (req.body?.confirm !== true) throw Object.assign(new Error('confirm: true is required'), { status: 400 });
  return trashDuplicate(req.params.id);
}));

// ---------------------------------------------------------------- episode corrections

/** Say which episode a file really is ({ season, episode }), or null to undo. */
router.patch('/files/:id/episode', handle((req) => {
  const f = db.prepare('SELECT f.*, s.library_id FROM files f JOIN shows s ON s.id = f.show_id WHERE f.id = ?').get(req.params.id);
  if (!f) throw Object.assign(new Error('Only files inside a series can be renumbered'), { status: 404 });
  const { season, episode } = req.body || {};
  const clear = season === null && episode === null;
  const ok = (n, min) => Number.isInteger(n) && n >= min && n <= 9999;
  if (!clear && (!ok(season, 0) || !ok(episode, 1))) {
    throw Object.assign(new Error('Season must be 0 or more and episode 1 or more'), { status: 400 });
  }
  db.prepare('UPDATE files SET manual_season = ?, manual_episode = ? WHERE id = ?')
    .run(clear ? null : season, clear ? null : episode, f.id);
  scanLibraries({ libraryId: f.library_id });
  return db.prepare('SELECT id, episode_id, manual_season, manual_episode FROM files WHERE id = ?').get(f.id);
}));

/** Every file behind one episode, with its details, for the episode panel. */
router.get('/episodes/:id/files', handle((req) => {
  return db.prepare(`
    SELECT id, path, filename, size_bytes, quality, manual_season, manual_episode, media_info
    FROM files WHERE episode_id = ? AND is_missing = 0 ORDER BY size_bytes DESC
  `).all(req.params.id).map(({ media_info: mi, ...f }) => ({ ...f, media: mi ? JSON.parse(mi) : null }));
}));

// ---------------------------------------------------------------- media info

router.get('/media/probe', handle(() => probeStatus()));
router.post('/media/probe', handle((req) => startProbe({ all: req.body?.all === true })));

// ---------------------------------------------------------------- airing

router.get('/airing', handle(() => {
  const d = (offset) => {
    const x = new Date(Date.now() + offset);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  return { enabled: airingEnabled(), today: airingToday(), recent: airedBetween(d(-7 * 86_400_000), d(-86_400_000)) };
}));

router.put('/airing', handle((req) => {
  setSetting('notify.airing', req.body?.enabled ? '1' : '0');
  return { enabled: airingEnabled() };
}));

// ---------------------------------------------------------------- automatic subtitles

router.get('/subtitles/auto', handle(() => autoSubtitleStatus()));
router.put('/subtitles/auto', handle((req) => {
  setAutoSubtitles(Boolean(req.body?.enabled));
  return autoSubtitleStatus();
}));

/** Fill in subtitles for a whole show, a season, or a film. */
router.post('/subtitles/auto/run', handle(async (req) => {
  const { showId, season, movieId } = req.body || {};
  let rows = [];
  if (showId) {
    rows = db.prepare(`
      SELECT f.path FROM files f JOIN episodes e ON e.id = f.episode_id
      WHERE e.show_id = ? ${season != null ? 'AND e.season_number = ?' : ''} AND f.is_missing = 0
      ORDER BY e.season_number, e.episode_number
    `).all(...(season != null ? [showId, season] : [showId]));
  } else if (movieId) {
    rows = db.prepare('SELECT path FROM files WHERE movie_id = ? AND is_missing = 0').all(movieId);
  }
  const job = fetchSubtitlesFor(rows.map((r) => r.path));
  if (!job) throw Object.assign(new Error('Turn on automatic subtitles and add an OpenSubtitles key first'), { status: 400 });
  return job;
}));

// ---------------------------------------------------------------- playback

router.get('/playback', handle(() => activeSessions()));
router.put('/playback/settings', handle((req) => setPlaybackSettings(req.body || {})));

// ---------------------------------------------------------------- TV Time import

router.post('/import/tvtime', memory.array('files'), handle((req) => {
  if (!req.files?.length) throw Object.assign(new Error('Choose the TV Time export file'), { status: 400 });
  return previewImport(req.files);
}));

router.post('/import/tvtime/:id/apply', handle((req) => applyImport(req.params.id)));

// ---------------------------------------------------------------- Trakt

router.get('/trakt', handle(() => traktStatus()));
router.put('/trakt/app', handle((req) => setTraktApp(req.body || {})));
router.post('/trakt/connect', handle(() => startDeviceLogin()));
router.post('/trakt/disconnect', handle(() => disconnectTrakt()));
router.post('/trakt/sync', handle(() => syncTrakt()));

// ---------------------------------------------------------------- licences

/** The notices file that ships with the app, for the About screen. */
router.get('/licenses', (_req, res) => {
  const file = new URL('../../../THIRD-PARTY-NOTICES.md', import.meta.url);
  try {
    res.type('text/plain').send(readFileSync(file, 'utf8'));
  } catch {
    res.status(404).json({ error: 'Notices file not found in this build' });
  }
});

// ---------------------------------------------------------------- backup

router.get('/backup/export', (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="shelf-backup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(exportBackup(), null, 1));
});

router.post('/backup/import', memory.single('file'), handle((req) => {
  if (!req.file) throw Object.assign(new Error('Choose a Shelf backup file'), { status: 400 });
  let data;
  try {
    data = JSON.parse(req.file.buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('That file is not a Shelf backup'), { status: 400 });
  }
  return importBackup(data, { overwrite: req.body?.overwrite === 'true', settings: req.body?.settings !== 'false' });
}));

export default router;
