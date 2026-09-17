// Backup and restore of everything a person has put into Shelf: watch state,
// ratings and notes, history, favourites and customisations, organiser and
// playback settings. Files on disk are not included, and neither are secrets
// (API keys, sign-in tokens). Titles are keyed by TMDB id where possible, so a
// backup restores onto a library on another computer or drive.
import { db, getSetting, setSetting, transaction } from './db.js';

const FORMAT = 'shelf-backup';
const VERSION = 1;

const SECRET_KEYS = /^(tmdb\.apiKey|opensubtitles\.|trakt\.(clientSecret|accessToken|refreshToken|expiresAt))/;
const NOT_PORTABLE = /^(organize\.(autoLog|autoPending)|airing\.notified|tmdb\.last)/;

const showKey = (s) => (s.tmdb_id ? `tmdb:${s.tmdb_id}` : `name:${String(s.folder_name || s.title).toLowerCase()}`);
const movieKey = (m) => (m.tmdb_id ? `tmdb:${m.tmdb_id}` : `name:${String(m.title).toLowerCase()}|${m.year ?? ''}`);

export function exportBackup() {
  const shows = db.prepare('SELECT * FROM shows').all();
  const movies = db.prepare('SELECT * FROM movies').all();
  const showKeyById = new Map(shows.map((s) => [s.id, showKey(s)]));
  const movieKeyById = new Map(movies.map((m) => [m.id, movieKey(m)]));
  const epInfo = new Map(
    db.prepare('SELECT id, show_id, season_number, episode_number FROM episodes').all().map((e) => [e.id, e])
  );
  const epRef = (id) => {
    const e = epInfo.get(id);
    return e ? { show: showKeyById.get(e.show_id), season: e.season_number, episode: e.episode_number } : null;
  };

  return {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    shows: shows.map((s) => ({
      key: showKey(s), title: s.title, tmdb_id: s.tmdb_id, folder_name: s.folder_name,
      is_favorite: s.is_favorite, user_status: s.user_status, user_rating: s.user_rating, notes: s.notes,
      tags: s.tags, icon_emoji: s.icon_emoji, accent_color: s.accent_color, episode_group_id: s.episode_group_id,
    })),
    movies: movies.map((m) => ({
      key: movieKey(m), title: m.title, year: m.year, tmdb_id: m.tmdb_id, tmdb_title: m.tmdb_title,
      is_favorite: m.is_favorite, user_rating: m.user_rating, notes: m.notes, tags: m.tags,
      icon_emoji: m.icon_emoji, accent_color: m.accent_color,
    })),
    episode_state: db.prepare('SELECT * FROM episode_state').all()
      .map((r) => ({ ...epRef(r.episode_id), watched: r.watched, watched_at: r.watched_at, play_count: r.play_count,
        rating: r.rating, note: r.note, progress_seconds: r.progress_seconds, duration_seconds: r.duration_seconds }))
      .filter((r) => r.show),
    movie_state: db.prepare('SELECT * FROM movie_state').all()
      .map((r) => ({ movie: movieKeyById.get(r.movie_id), watched: r.watched, watched_at: r.watched_at,
        play_count: r.play_count, rating: r.rating, note: r.note, progress_seconds: r.progress_seconds,
        duration_seconds: r.duration_seconds }))
      .filter((r) => r.movie),
    history: db.prepare('SELECT * FROM watch_history').all().map((h) => ({
      kind: h.kind, watched_at: h.watched_at, minutes: h.minutes, is_rewatch: h.is_rewatch,
      ...(h.kind === 'movie' ? { movie: movieKeyById.get(h.movie_id) } : epRef(h.episode_id)),
    })).filter((h) => h.movie || h.show),
    libraries: db.prepare('SELECT path, kind, label FROM libraries').all(),
    settings: Object.fromEntries(
      db.prepare('SELECT key, value FROM settings').all()
        .filter((r) => !SECRET_KEYS.test(r.key) && !NOT_PORTABLE.test(r.key))
        .map((r) => [r.key, r.value])
    ),
  };
}

/**
 * Merge a backup into this library. Nothing is removed: a watch in either
 * place stays a watch, ratings and notes fill gaps (or replace, if asked),
 * and history entries are added once.
 */
export function importBackup(data, { overwrite = false, settings = true } = {}) {
  if (data?.format !== FORMAT) throw Object.assign(new Error('This is not a Shelf backup file'), { status: 400 });
  if (data.version > VERSION) throw Object.assign(new Error('This backup was made by a newer Shelf'), { status: 400 });

  const shows = db.prepare('SELECT * FROM shows').all();
  const movies = db.prepare('SELECT * FROM movies').all();
  const showByKey = new Map();
  for (const s of shows) {
    showByKey.set(showKey(s), s);
    showByKey.set(`name:${String(s.folder_name || s.title).toLowerCase()}`, s);
  }
  const movieByKey = new Map();
  for (const m of movies) {
    movieByKey.set(movieKey(m), m);
    movieByKey.set(`name:${String(m.title).toLowerCase()}|${m.year ?? ''}`, m);
  }
  const findShow = (k, title) => showByKey.get(k) || showByKey.get(`name:${String(title || '').toLowerCase()}`);
  const epRow = db.prepare('SELECT id, show_id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?');
  const pick = (mine, theirs) => (overwrite ? theirs ?? mine : mine ?? theirs);
  const counts = { shows: 0, movies: 0, episodes: 0, films_watched: 0, history: 0, skipped: 0 };

  transaction(() => {
    for (const b of data.shows || []) {
      const s = findShow(b.key, b.folder_name || b.title);
      if (!s) {
        counts.skipped++;
        continue;
      }
      db.prepare(`UPDATE shows SET is_favorite = ?, user_status = ?, user_rating = ?, notes = ?, tags = ?,
        icon_emoji = ?, accent_color = ? WHERE id = ?`).run(
        Math.max(s.is_favorite || 0, b.is_favorite || 0), pick(s.user_status, b.user_status),
        pick(s.user_rating, b.user_rating), pick(s.notes, b.notes), pick(s.tags, b.tags),
        pick(s.icon_emoji, b.icon_emoji), pick(s.accent_color, b.accent_color), s.id
      );
      counts.shows++;
    }
    for (const b of data.movies || []) {
      const m = movieByKey.get(b.key);
      if (!m) continue;
      db.prepare(`UPDATE movies SET is_favorite = ?, user_rating = ?, notes = ?, tags = ?, icon_emoji = ?,
        accent_color = ?, tmdb_title = COALESCE(tmdb_title, ?) WHERE id = ?`).run(
        Math.max(m.is_favorite || 0, b.is_favorite || 0), pick(m.user_rating, b.user_rating),
        pick(m.notes, b.notes), pick(m.tags, b.tags), pick(m.icon_emoji, b.icon_emoji),
        pick(m.accent_color, b.accent_color), b.tmdb_title ?? null, m.id
      );
      counts.movies++;
    }

    const epState = db.prepare('SELECT * FROM episode_state WHERE episode_id = ?');
    for (const b of data.episode_state || []) {
      const show = showByKey.get(b.show);
      const ep = show && epRow.get(show.id, b.season, b.episode);
      if (!ep) continue;
      const cur = epState.get(ep.id);
      db.prepare(`INSERT INTO episode_state (episode_id, show_id, watched, watched_at, play_count, rating, note,
          progress_seconds, duration_seconds)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(episode_id) DO UPDATE SET watched = excluded.watched, watched_at = excluded.watched_at,
          play_count = excluded.play_count, rating = excluded.rating, note = excluded.note,
          progress_seconds = excluded.progress_seconds, duration_seconds = excluded.duration_seconds`).run(
        ep.id, ep.show_id,
        Math.max(cur?.watched || 0, b.watched || 0),
        cur?.watched ? cur.watched_at : b.watched_at ?? cur?.watched_at ?? null,
        Math.max(cur?.play_count || 0, b.play_count || 0),
        pick(cur?.rating ?? null, b.rating ?? null), pick(cur?.note ?? null, b.note ?? null),
        cur?.progress_seconds ?? b.progress_seconds ?? null, cur?.duration_seconds ?? b.duration_seconds ?? null
      );
      counts.episodes++;
    }

    const mState = db.prepare('SELECT * FROM movie_state WHERE movie_id = ?');
    for (const b of data.movie_state || []) {
      const m = movieByKey.get(b.movie);
      if (!m) continue;
      const cur = mState.get(m.id);
      db.prepare(`INSERT INTO movie_state (movie_id, watched, watched_at, play_count, rating, note,
          progress_seconds, duration_seconds)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(movie_id) DO UPDATE SET watched = excluded.watched, watched_at = excluded.watched_at,
          play_count = excluded.play_count, rating = excluded.rating, note = excluded.note,
          progress_seconds = excluded.progress_seconds, duration_seconds = excluded.duration_seconds`).run(
        m.id, Math.max(cur?.watched || 0, b.watched || 0),
        cur?.watched ? cur.watched_at : b.watched_at ?? cur?.watched_at ?? null,
        Math.max(cur?.play_count || 0, b.play_count || 0),
        pick(cur?.rating ?? null, b.rating ?? null), pick(cur?.note ?? null, b.note ?? null),
        cur?.progress_seconds ?? b.progress_seconds ?? null, cur?.duration_seconds ?? b.duration_seconds ?? null
      );
      if (b.watched) counts.films_watched++;
    }

    const hasHistory = db.prepare(
      'SELECT 1 FROM watch_history WHERE kind = ? AND watched_at = ? AND IFNULL(episode_id, \'\') = ? AND IFNULL(movie_id, \'\') = ?'
    );
    const addHistory = db.prepare(`INSERT INTO watch_history (id, kind, episode_id, movie_id, show_id, watched_at, minutes, is_rewatch)
      VALUES (lower(hex(randomblob(16))),?,?,?,?,?,?,?)`);
    for (const h of data.history || []) {
      let episodeId = null;
      let movieId = null;
      let showId = null;
      if (h.kind === 'movie') {
        movieId = movieByKey.get(h.movie)?.id;
        if (!movieId) continue;
      } else {
        const show = showByKey.get(h.show);
        const ep = show && epRow.get(show.id, h.season, h.episode);
        if (!ep) continue;
        episodeId = ep.id;
        showId = ep.show_id;
      }
      if (hasHistory.get(h.kind, h.watched_at, episodeId || '', movieId || '')) continue;
      addHistory.run(h.kind, episodeId, movieId, showId, h.watched_at, h.minutes || 0, h.is_rewatch || 0);
      counts.history++;
    }

    if (settings) {
      for (const [k, v] of Object.entries(data.settings || {})) {
        if (SECRET_KEYS.test(k) || NOT_PORTABLE.test(k)) continue;
        // Folder paths belong to the other computer; keep this machine's.
        if (/^organize\.(auto|last)$|^player\.path$/.test(k) && getSetting(k)) continue;
        setSetting(k, v);
      }
    }
  });

  return {
    ...counts,
    libraries_in_backup: (data.libraries || []).map((l) => l.path),
  };
}
