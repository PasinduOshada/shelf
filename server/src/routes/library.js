import { Router } from 'express';
import { startProbe } from '../mediainfo.js';
import { setSecret, secretsEncrypted } from '../secrets.js';
import multer from 'multer';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, setSetting, getSetting, sortTitle } from '../db.js';
import { UPLOADS_DIR } from '../paths.js';
import { scanLibraries, addLibrary } from '../scanner/scan.js';
import * as q from '../queries.js';
import {
  startEnrich, enrichStatus, enrichShow, enrichMovie, listOrderings,
  searchShowRaw, searchMovieRaw, hasApiKey, verifyApiKey,
} from '../tmdb.js';

const router = Router();

// Poster uploads: extension comes from a strict MIME allowlist, never from
// the client-supplied filename.
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype];
      cb(ext ? null : new Error('Unsupported image type'), randomUUID() + (ext || ''));
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, Boolean(EXT_BY_MIME[file.mimetype])),
});

// ---------------------------------------------------------------- libraries

router.get('/libraries', (_req, res) => {
  res.json(db.prepare('SELECT * FROM libraries ORDER BY kind, label').all());
});

router.post('/libraries', (req, res) => {
  const { path, kind, label } = req.body || {};
  if (!path || !['tv', 'movie'].includes(kind)) {
    return res.status(400).json({ error: 'path and kind (tv|movie) are required' });
  }
  if (!existsSync(path)) return res.status(400).json({ error: 'Folder not found on disk' });
  res.status(201).json(addLibrary({ path, kind, label: label || null }));
});

router.delete('/libraries/:id', (req, res) => {
  db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/scan', (req, res) => {
  try {
    res.json(scanLibraries({ libraryId: req.body?.libraryId ?? null }));
    // New or changed files: read their real stream details in the background.
    startProbe();
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Browse the filesystem so the UI can pick library folders.
router.get('/browse', (req, res) => {
  const target = req.query.path;
  try {
    if (!target) {
      // Windows drive roots; POSIX starts at /
      const roots = process.platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`).filter(existsSync)
        : ['/'];
      return res.json({ path: null, parent: null, dirs: roots.map((p) => ({ name: p, path: p })) });
    }
    const dirs = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(target, e.name) }));
    res.json({ path: target, dirs });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------- shows

router.get('/shows', (req, res) => {
  res.json(q.listShows({
    search: req.query.search || '',
    status: req.query.status || null,
    sort: req.query.sort || 'title',
  }));
});

router.get('/shows/:id', (req, res) => {
  const show = q.getShow(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json(show);
});

router.patch('/shows/:id', (req, res) => {
  const allowed = ['title', 'icon_emoji', 'accent_color', 'is_favorite', 'user_status', 'user_rating', 'notes', 'tags'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      sets.push(`${k} = ?`);
      vals.push(k === 'tags' ? JSON.stringify(req.body[k] ?? []) : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  if ('title' in req.body) {
    const title = String(req.body.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'A title cannot be empty' });
    vals[sets.indexOf('title = ?')] = title;
    // Keep alphabetical order in step with the new name.
    sets.push('sort_title = ?');
    vals.push(sortTitle(title));
  }
  vals.push(req.params.id);
  db.prepare(`UPDATE shows SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
  res.json(q.getShow(req.params.id));
});

router.post('/shows/:id/poster', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE shows SET custom_poster = ? WHERE id = ?').run(url, req.params.id);
  res.json({ custom_poster: url });
});

router.delete('/shows/:id/poster', (req, res) => {
  db.prepare('UPDATE shows SET custom_poster = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- movies

router.get('/movies', (req, res) => {
  res.json(q.listMovies({ search: req.query.search || '', sort: req.query.sort || 'title' }));
});

router.get('/movies/:id', (req, res) => {
  const movie = q.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  res.json(movie);
});

router.patch('/movies/:id', (req, res) => {
  const allowed = ['title', 'icon_emoji', 'accent_color', 'is_favorite', 'user_rating', 'notes', 'tags'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      // `title` is the key the scanner re-finds a film by, so a rename is
      // stored as the display title instead of changing it.
      sets.push(`${k === 'title' ? 'tmdb_title' : k} = ?`);
      vals.push(k === 'tags' ? JSON.stringify(req.body[k] ?? []) : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE movies SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
  res.json(q.getMovie(req.params.id));
});

router.post('/movies/:id/poster', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE movies SET custom_poster = ? WHERE id = ?').run(url, req.params.id);
  res.json({ custom_poster: url });
});

router.delete('/movies/:id/poster', (req, res) => {
  db.prepare('UPDATE movies SET custom_poster = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/collections', (_req, res) => {
  res.json(db.prepare(`
    SELECT c.*, COUNT(m.id) AS movie_count
    FROM collections c LEFT JOIN movies m ON m.collection_id = c.id
    GROUP BY c.id ORDER BY c.name
  `).all());
});

// ---------------------------------------------------------------- tmdb

router.get('/tmdb/status', (_req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  res.json({
    configured: hasApiKey(),
    encrypted: secretsEncrypted(),
    lastEnrich: getSetting('tmdb.lastEnrich'),
    unmatched: {
      shows: count('SELECT COUNT(*) c FROM shows WHERE tmdb_id IS NULL'),
      movies: count('SELECT COUNT(*) c FROM movies WHERE tmdb_id IS NULL'),
    },
    failed: {
      shows: count("SELECT COUNT(*) c FROM shows WHERE tmdb_status = 'failed'"),
      movies: count("SELECT COUNT(*) c FROM movies WHERE tmdb_status = 'failed'"),
    },
  });
});

router.post('/tmdb/key', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Key is required' });
  try {
    if (!(await verifyApiKey(key))) {
      return res.status(400).json({ error: 'TMDB rejected that key. Paste the API Key or the Read Access Token from themoviedb.org/settings/api.' });
    }
  } catch (err) {
    // Surface the real cause: a generic "could not reach" once hid what failed.
    const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    console.error('TMDB key verification failed:', err);
    return res.status(502).json({ error: `Could not reach TMDB (${cause}). Check your internet connection and try again.` });
  }
  setSecret('tmdb.apiKey', key);
  res.json({ ok: true, configured: true });
});

// Enrichment runs as a background job; the client polls GET for progress.
router.get('/tmdb/enrich', (_req, res) => {
  res.json(enrichStatus());
});

router.post('/tmdb/enrich', (req, res) => {
  const status = startEnrich({
    retryFailed: req.body?.retryFailed === true,
    refresh: req.body?.refresh === true,
  });
  res.status(status.running ? 202 : 400).json(status);
});

// Alternative season layouts TMDB offers, scored against the files on disk.
router.get('/shows/:id/orderings', async (req, res) => {
  if (!hasApiKey()) return res.status(400).json({ error: 'Add a TMDB API key in Settings first.' });
  try {
    const data = await listOrderings(req.params.id);
    if (!data) return res.status(404).json({ error: 'This show is not matched to TMDB yet.' });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

router.post('/shows/:id/ordering', async (req, res) => {
  const show = db.prepare('SELECT tmdb_id FROM shows WHERE id = ?').get(req.params.id);
  if (!show?.tmdb_id) return res.status(404).json({ error: 'This show is not matched to TMDB yet.' });
  const groupId = req.body?.groupId;
  if (groupId != null && !/^[a-f0-9]{24}$/i.test(String(groupId))) {
    return res.status(400).json({ error: 'Invalid episode group id' });
  }
  try {
    const r = await enrichShow(req.params.id, show.tmdb_id, { groupId: groupId ?? 'default' });
    if (!r.ok) return res.status(404).json(r);
    res.json(q.getShow(req.params.id));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Manual match: search TMDB, then bind a specific id.
router.get('/tmdb/search', async (req, res) => {
  const { q: query, kind = 'tv' } = req.query;
  if (!query) return res.status(400).json({ error: 'q is required' });
  if (!hasApiKey()) return res.status(400).json({ error: 'Add a TMDB API key in Settings first.' });
  try {
    const data = kind === 'movie' ? await searchMovieRaw(query) : await searchShowRaw(query);
    res.json((data?.results || []).slice(0, 18));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

router.post('/shows/:id/match', async (req, res) => {
  const tmdbId = Number(req.body?.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId is required' });
  try {
    const r = await enrichShow(req.params.id, tmdbId);
    if (!r.ok) return res.status(404).json(r);
    res.json(q.getShow(req.params.id));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

router.post('/movies/:id/match', async (req, res) => {
  const tmdbId = Number(req.body?.tmdbId);
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId is required' });
  try {
    const r = await enrichMovie(req.params.id, tmdbId);
    if (!r.ok) return res.status(404).json(r);
    res.json(q.getMovie(req.params.id));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

export default router;
