// Watch state: one place that marks episodes and films watched, rates them,
// and remembers how far playback got. Used by the API, playback tracking,
// imports (TV Time) and Trakt sync.
import { randomUUID } from 'node:crypto';
import { db, transaction } from './db.js';

const nowIso = () => new Date().toISOString();

function logWatch({ kind, episodeId = null, movieId = null, showId = null, minutes = 0, isRewatch = false, at = null }) {
  db.prepare(
    `INSERT INTO watch_history (id, kind, episode_id, movie_id, show_id, minutes, is_rewatch, watched_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(randomUUID(), kind, episodeId, movieId, showId, Math.round(minutes) || 0, isRewatch ? 1 : 0, at || sqlNow());
}

// watch_history uses SQLite's "YYYY-MM-DD HH:MM:SS" (UTC), which stats group by.
function sqlNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function toSqlTime(value) {
  // Exports write UTC without a zone ("2024-03-01 20:00:00"); don't read it as local time.
  const s = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim())
    ? `${value.trim().replace(' ', 'T')}Z`
    : value;
  const d = s ? new Date(s) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Mark one episode watched or unwatched.
 * `at` backdates the watch (imports); `ifUnwatched` skips episodes already
 * watched, so re-importing a history never double-counts.
 */
export function setEpisodeWatched(episodeId, watched, { at = null, ifUnwatched = false } = {}) {
  const ep = db.prepare(`
    SELECT e.*, s.episode_runtime FROM episodes e
    JOIN shows s ON s.id = e.show_id WHERE e.id = ?
  `).get(episodeId);
  if (!ep) return null;
  const minutes = ep.runtime || ep.episode_runtime || 42;
  const when = toSqlTime(at);

  let changed = true;
  transaction(() => {
    const existing = db.prepare('SELECT * FROM episode_state WHERE episode_id = ?').get(ep.id);
    if (ifUnwatched && existing?.watched && watched) {
      changed = false;
      return;
    }
    if (existing) {
      db.prepare(
        `UPDATE episode_state SET watched = ?, watched_at = CASE WHEN ? THEN ? ELSE watched_at END,
         play_count = play_count + CASE WHEN ? THEN 1 ELSE 0 END,
         progress_seconds = CASE WHEN ? THEN NULL ELSE progress_seconds END
         WHERE episode_id = ?`
      ).run(watched ? 1 : 0, watched ? 1 : 0, when || nowIso(), watched ? 1 : 0, watched ? 1 : 0, ep.id);
    } else {
      db.prepare(
        `INSERT INTO episode_state (episode_id, show_id, watched, watched_at, play_count)
         VALUES (?,?,?,?,?)`
      ).run(ep.id, ep.show_id, watched ? 1 : 0, watched ? when || nowIso() : null, watched ? 1 : 0);
    }

    if (watched) {
      logWatch({
        kind: 'episode', episodeId: ep.id, showId: ep.show_id,
        minutes, isRewatch: Boolean(existing?.play_count), at: when,
      });
    } else {
      // Un-marking removes the most recent log entry for that episode.
      db.prepare(
        'DELETE FROM watch_history WHERE id = (SELECT id FROM watch_history WHERE episode_id = ? ORDER BY watched_at DESC LIMIT 1)'
      ).run(ep.id);
    }
  });
  return { ok: true, watched, minutes, changed, show_id: ep.show_id };
}

export function setMovieWatched(movieId, watched, { at = null, ifUnwatched = false } = {}) {
  const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);
  if (!movie) return null;
  const when = toSqlTime(at);

  let changed = true;
  transaction(() => {
    const existing = db.prepare('SELECT * FROM movie_state WHERE movie_id = ?').get(movie.id);
    if (ifUnwatched && existing?.watched && watched) {
      changed = false;
      return;
    }
    if (existing) {
      db.prepare(
        `UPDATE movie_state SET watched = ?, watched_at = CASE WHEN ? THEN ? ELSE watched_at END,
         play_count = play_count + CASE WHEN ? THEN 1 ELSE 0 END,
         progress_seconds = CASE WHEN ? THEN NULL ELSE progress_seconds END
         WHERE movie_id = ?`
      ).run(watched ? 1 : 0, watched ? 1 : 0, when || nowIso(), watched ? 1 : 0, watched ? 1 : 0, movie.id);
    } else {
      db.prepare(
        'INSERT INTO movie_state (movie_id, watched, watched_at, play_count) VALUES (?,?,?,?)'
      ).run(movie.id, watched ? 1 : 0, watched ? when || nowIso() : null, watched ? 1 : 0);
    }

    if (watched) {
      logWatch({
        kind: 'movie', movieId: movie.id, minutes: movie.runtime || 110,
        isRewatch: Boolean(existing?.play_count), at: when,
      });
    } else {
      db.prepare(
        'DELETE FROM watch_history WHERE id = (SELECT id FROM watch_history WHERE movie_id = ? ORDER BY watched_at DESC LIMIT 1)'
      ).run(movie.id);
    }
  });
  return { ok: true, watched, changed };
}

/** Mark a whole season (or show) watched in one action. Only episodes on disk. */
export function setShowWatched(showId, { season = null, watched = true } = {}) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
  if (!show) return null;

  // Everything that has aired, whether or not it is on this computer: people
  // mark a series watched because they watched it, not because they kept the
  // files. Episodes still to come are left alone.
  const eps = db.prepare(`
    SELECT e.* FROM episodes e
    WHERE e.show_id = ? ${season != null ? 'AND e.season_number = ?' : ''}
      AND (e.air_date IS NULL OR e.air_date <= date('now'))
  `).all(...(season != null ? [show.id, season] : [show.id]));

  transaction(() => {
    for (const ep of eps) {
      const existing = db.prepare('SELECT * FROM episode_state WHERE episode_id = ?').get(ep.id);
      if (existing) {
        db.prepare('UPDATE episode_state SET watched = ?, watched_at = ? WHERE episode_id = ?')
          .run(watched ? 1 : 0, watched ? nowIso() : existing.watched_at, ep.id);
      } else {
        db.prepare(
          'INSERT INTO episode_state (episode_id, show_id, watched, watched_at, play_count) VALUES (?,?,?,?,?)'
        ).run(ep.id, show.id, watched ? 1 : 0, watched ? nowIso() : null, watched ? 1 : 0);
      }
      if (watched && !existing?.watched) {
        logWatch({
          kind: 'episode', episodeId: ep.id, showId: show.id,
          minutes: ep.runtime || show.episode_runtime || 42,
        });
      }
    }
    if (!watched) {
      const ids = eps.map((e) => e.id);
      if (ids.length) {
        db.prepare(`DELETE FROM watch_history WHERE episode_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
    }
  });
  return { ok: true, affected: eps.length };
}

// ---------------------------------------------------------------- ratings and notes

const cleanRating = (r) => {
  if (r === null || r === undefined || r === '') return null;
  const n = Number(r);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error('Ratings go from 1 to 10'), { status: 400 });
  return n;
};
const cleanNote = (n) => {
  if (n === null || n === undefined) return null;
  const s = String(n).trim();
  if (s.length > 4000) throw Object.assign(new Error('Notes are limited to 4000 characters'), { status: 400 });
  return s || null;
};

/** Rate or annotate an episode. Only the fields given are changed. */
export function setEpisodeReview(episodeId, { rating, note } = {}) {
  const ep = db.prepare('SELECT id, show_id FROM episodes WHERE id = ?').get(episodeId);
  if (!ep) return null;
  db.prepare(
    `INSERT INTO episode_state (episode_id, show_id, watched, play_count) VALUES (?, ?, 0, 0)
     ON CONFLICT(episode_id) DO NOTHING`
  ).run(ep.id, ep.show_id);
  if (rating !== undefined) db.prepare('UPDATE episode_state SET rating = ? WHERE episode_id = ?').run(cleanRating(rating), ep.id);
  if (note !== undefined) db.prepare('UPDATE episode_state SET note = ? WHERE episode_id = ?').run(cleanNote(note), ep.id);
  return db.prepare('SELECT rating, note FROM episode_state WHERE episode_id = ?').get(ep.id);
}

export function setMovieReview(movieId, { rating, note } = {}) {
  const m = db.prepare('SELECT id FROM movies WHERE id = ?').get(movieId);
  if (!m) return null;
  db.prepare(
    `INSERT INTO movie_state (movie_id, watched, play_count) VALUES (?, 0, 0)
     ON CONFLICT(movie_id) DO NOTHING`
  ).run(m.id);
  if (rating !== undefined) db.prepare('UPDATE movie_state SET rating = ? WHERE movie_id = ?').run(cleanRating(rating), m.id);
  if (note !== undefined) db.prepare('UPDATE movie_state SET note = ? WHERE movie_id = ?').run(cleanNote(note), m.id);
  return db.prepare('SELECT rating, note FROM movie_state WHERE movie_id = ?').get(m.id);
}

export { cleanRating, cleanNote };

// ---------------------------------------------------------------- playback progress

/** Where playback stopped, so Play can resume. Cleared when marked watched. */
export function saveProgress({ episodeId = null, movieId = null, position, duration }) {
  const pos = Math.max(0, Math.round(position || 0));
  const dur = Math.max(0, Math.round(duration || 0));
  if (episodeId) {
    const ep = db.prepare('SELECT id, show_id FROM episodes WHERE id = ?').get(episodeId);
    if (!ep) return;
    db.prepare(
      `INSERT INTO episode_state (episode_id, show_id, watched, play_count, progress_seconds, duration_seconds, progress_at)
       VALUES (?, ?, 0, 0, ?, ?, ?)
       ON CONFLICT(episode_id) DO UPDATE SET progress_seconds = excluded.progress_seconds,
         duration_seconds = excluded.duration_seconds, progress_at = excluded.progress_at`
    ).run(ep.id, ep.show_id, pos, dur, nowIso());
  } else if (movieId) {
    db.prepare(
      `INSERT INTO movie_state (movie_id, watched, play_count, progress_seconds, duration_seconds, progress_at)
       VALUES (?, 0, 0, ?, ?, ?)
       ON CONFLICT(movie_id) DO UPDATE SET progress_seconds = excluded.progress_seconds,
         duration_seconds = excluded.duration_seconds, progress_at = excluded.progress_at`
    ).run(movieId, pos, dur, nowIso());
  }
}

export function getProgress({ episodeId = null, movieId = null }) {
  const row = episodeId
    ? db.prepare('SELECT progress_seconds, duration_seconds, watched FROM episode_state WHERE episode_id = ?').get(episodeId)
    : db.prepare('SELECT progress_seconds, duration_seconds, watched FROM movie_state WHERE movie_id = ?').get(movieId);
  return row || null;
}
