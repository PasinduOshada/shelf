import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import * as q from '../queries.js';
import * as stats from '../stats.js';
import * as watch from '../watch.js';
import { hasApiKey } from '../tmdb.js';
import { duplicateGroups } from '../duplicates.js';

const router = Router();

// ---------------------------------------------------------------- discovery

router.get('/continue-watching', (req, res) => {
  res.json(q.continueWatching(Number(req.query.limit) || 24));
});

router.get('/upcoming', (req, res) => {
  res.json(q.upcoming(Number(req.query.days) || 90));
});

router.get('/missing', (_req, res) => {
  res.json(q.missingReport());
});

// The same report /duplicates/groups serves: one answer to one question, and
// it covers films, which the old episode-only query never did.
router.get('/duplicates', (_req, res) => {
  res.json(duplicateGroups());
});

/** Weighted random pick, optionally filtered. Powers "pick something for me". */
router.get('/surprise', (req, res) => {
  const { kind = 'any', unwatched = 'true' } = req.query;
  const onlyUnwatched = unwatched !== 'false';

  const pool = [];
  if (kind === 'any' || kind === 'movie') {
    const rows = db.prepare(`
      SELECT m.id, COALESCE(m.tmdb_title, m.title) AS title, m.year, m.poster_path, m.custom_poster, m.runtime, m.overview,
             COALESCE(ms.watched,0) watched
      FROM movies m
      LEFT JOIN movie_state ms ON ms.movie_id = m.id
      WHERE EXISTS (SELECT 1 FROM files f WHERE f.movie_id = m.id AND f.is_missing = 0)
    `).all();
    for (const r of rows) {
      if (onlyUnwatched && r.watched) continue;
      pool.push({ kind: 'movie', ...r, poster: r.custom_poster || (r.poster_path ? `tmdb:${r.poster_path}` : null) });
    }
  }
  if (kind === 'any' || kind === 'show') {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.year, s.poster_path, s.custom_poster, s.overview,
             (SELECT COUNT(*) FROM episode_state es WHERE es.show_id = s.id AND es.watched = 1) watched_count
      FROM shows s
      WHERE EXISTS (SELECT 1 FROM files f WHERE f.show_id = s.id AND f.is_missing = 0)
    `).all();
    for (const r of rows) {
      if (onlyUnwatched && r.watched_count > 0) continue;
      pool.push({ kind: 'show', ...r, poster: r.custom_poster || (r.poster_path ? `tmdb:${r.poster_path}` : null) });
    }
  }

  if (!pool.length) return res.json(null);
  res.json(pool[Math.floor(Math.random() * pool.length)]);
});

// ---------------------------------------------------------------- watching

const fail = (res, err) => res.status(err.status || 400).json({ error: String(err?.message || err) });

router.post('/episodes/:id/watch', (req, res) => {
  const r = watch.setEpisodeWatched(req.params.id, req.body?.watched !== false);
  if (!r) return res.status(404).json({ error: 'Episode not found' });
  res.json(r);
});

/** Mark a whole season (or show) watched in one action. */
router.post('/shows/:id/watch', (req, res) => {
  const { season = null, watched = true } = req.body || {};
  const r = watch.setShowWatched(req.params.id, { season, watched });
  if (!r) return res.status(404).json({ error: 'Show not found' });
  res.json(r);
});

router.post('/movies/:id/watch', (req, res) => {
  const r = watch.setMovieWatched(req.params.id, req.body?.watched !== false);
  if (!r) return res.status(404).json({ error: 'Movie not found' });
  res.json(r);
});

// Ratings (1-10) and personal notes.
router.patch('/episodes/:id/review', (req, res) => {
  try {
    const r = watch.setEpisodeReview(req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Episode not found' });
    res.json(r);
  } catch (err) {
    fail(res, err);
  }
});

router.patch('/movies/:id/review', (req, res) => {
  try {
    const r = watch.setMovieReview(req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Movie not found' });
    res.json(r);
  } catch (err) {
    fail(res, err);
  }
});

router.get('/history', (req, res) => {
  res.json(db.prepare(`
    SELECT h.*, s.title AS show_title, COALESCE(m.tmdb_title, m.title) AS movie_title,
           e.season_number, e.episode_number, e.title AS episode_title
    FROM watch_history h
    LEFT JOIN shows s ON s.id = h.show_id
    LEFT JOIN movies m ON m.id = h.movie_id
    LEFT JOIN episodes e ON e.id = h.episode_id
    ORDER BY h.watched_at DESC LIMIT ?
  `).all(Number(req.query.limit) || 100));
});

// ---------------------------------------------------------------- stats

router.get('/stats/overview', (_req, res) => res.json(stats.overview()));
router.get('/stats/activity', (req, res) => res.json(stats.activity(Number(req.query.days) || 90)));
router.get('/stats/summaries', (_req, res) => res.json(stats.summaries()));
router.get('/stats/streaks', (_req, res) => res.json(stats.streaks()));
router.get('/stats/composition', (_req, res) => res.json(stats.composition()));
router.get('/stats/periods', (req, res) =>
  res.json(stats.periods(req.query.unit === 'month' ? 'month' : 'week', Number(req.query.count) || 12)));
router.get('/stats/wrapped', (req, res) => {
  res.json(stats.wrapped(Number(req.query.year) || new Date().getFullYear()));
});

// ---------------------------------------------------------------- settings

router.get('/settings', (_req, res) => {
  res.json({
    excludes: JSON.parse(getSetting('scan.excludes', '[]')),
    theme: getSetting('ui.theme', 'dark'),
    accent: getSetting('ui.accent', 'violet'),
    tmdbConfigured: hasApiKey(),
  });
});

router.patch('/settings', (req, res) => {
  const { excludes, theme, accent } = req.body || {};
  if (Array.isArray(excludes)) setSetting('scan.excludes', JSON.stringify(excludes));
  if (theme) setSetting('ui.theme', theme);
  if (accent) setSetting('ui.accent', accent);
  res.json({ ok: true });
});

export default router;
