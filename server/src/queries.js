import { db } from './db.js';
import { subtitleIndex } from './subtitles.js';

/** The few media facts an episode row shows: length, embedded subtitles, HDR. */
function mediaSummary(json) {
  if (!json) return { duration: null, embedded_subtitles: [], hdr: null };
  try {
    const m = JSON.parse(json);
    return {
      duration: m.duration,
      embedded_subtitles: [...new Set((m.subtitles || []).map((s) => s.lang).filter(Boolean))],
      hdr: m.hdr,
      audio_languages: [...new Set((m.audio || []).map((a) => a.lang).filter(Boolean))],
    };
  } catch {
    return { duration: null, embedded_subtitles: [], hdr: null };
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

function decorateShow(row) {
  return {
    ...row,
    genres: parseJson(row.genres, []),
    tags: parseJson(row.tags, []),
    poster: row.custom_poster || (row.poster_path ? `tmdb:${row.poster_path}` : null),
  };
}

function decorateMovie(row) {
  return {
    ...row,
    // Canonical TMDB title when matched; `title` stays the scan's lookup key.
    title: row.tmdb_title || row.title,
    file_title: row.title,
    genres: parseJson(row.genres, []),
    tags: parseJson(row.tags, []),
    poster: row.custom_poster || (row.poster_path ? `tmdb:${row.poster_path}` : null),
  };
}

// ---------------------------------------------------------------- shows

export function listShows({ search = '', status = null, sort = 'title' } = {}) {
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(DISTINCT f.episode_id) FROM files f
        WHERE f.show_id = s.id AND f.episode_id IS NOT NULL AND f.is_missing = 0) AS owned_episodes,
      (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS total_episodes,
      (SELECT COUNT(*) FROM episode_state es
        WHERE es.show_id = s.id AND es.watched = 1) AS watched_episodes,
      (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f WHERE f.show_id = s.id AND f.is_missing = 0) AS size_bytes
    FROM shows s
    ORDER BY s.sort_title
  `).all();

  // One definition of "missing" everywhere: the same report the Missing page uses.
  const missingByShow = new Map(missingReport().map((m) => [m.show_id, m.count]));

  let out = rows.map((r) => {
    return decorateShow({
      ...r,
      missing_episodes: missingByShow.get(r.id) || 0,
      progress: r.owned_episodes ? Math.round((r.watched_episodes / r.owned_episodes) * 100) : 0,
    });
  });

  if (search) {
    const q = search.toLowerCase();
    out = out.filter((s) => s.title.toLowerCase().includes(q));
  }
  if (status) out = out.filter((s) => s.user_status === status);

  if (sort === 'recent') out.sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
  else if (sort === 'size') out.sort((a, b) => b.size_bytes - a.size_bytes);
  else if (sort === 'missing') out.sort((a, b) => b.missing_episodes - a.missing_episodes);
  else if (sort === 'progress') out.sort((a, b) => b.progress - a.progress);

  return out;
}

export function getShow(showId) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
  if (!show) return null;

  const seasons = db.prepare(
    'SELECT * FROM seasons WHERE show_id = ? ORDER BY season_number'
  ).all(showId);

  const episodes = db.prepare(`
    SELECT e.*,
      COALESCE(es.watched, 0) AS watched,
      es.watched_at, es.rating AS user_rating, es.note,
      es.progress_seconds, es.duration_seconds,
      (SELECT COUNT(*) FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0) AS file_count,
      (SELECT COALESCE(json_extract(f.media_info, '$.quality'), f.quality) FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0 ORDER BY f.size_bytes DESC LIMIT 1) AS quality,
      (SELECT f.media_info FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0 ORDER BY f.size_bytes DESC LIMIT 1) AS media_info,
      (SELECT f.path FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0 ORDER BY f.size_bytes DESC LIMIT 1) AS file_path,
      (SELECT f.id FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0 ORDER BY f.size_bytes DESC LIMIT 1) AS file_id,
      (SELECT COALESCE(SUM(f.size_bytes),0) FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0) AS size_bytes
    FROM episodes e
    LEFT JOIN episode_state es ON es.episode_id = e.id
    WHERE e.show_id = ?
    ORDER BY e.season_number, e.episode_number
  `).all(showId);

  const now = today();

  // Missing flags and counts come from missingReport(), the single definition
  // shared with the Missing page, Library badges and Stats.
  const report = missingReport().find((m) => m.show_id === showId);
  const missingKeys = new Set();
  const missingBySeason = new Map();
  for (const s of report?.seasons || []) {
    missingBySeason.set(s.season_number, s.episodes.length);
    for (const e of s.episodes) missingKeys.add(`${s.season_number}:${e.episode_number}`);
  }

  // Subtitle files next to each episode, one directory read per season folder.
  const subs = subtitleIndex(episodes.map((e) => e.file_path));

  const decorated = episodes.map(({ media_info: mediaJson, ...e }) => ({
    ...e,
    subtitles: (subs.get(e.file_path) || []).map((x) => x.lang || x.format),
    ...mediaSummary(mediaJson),
    owned: e.file_count > 0,
    // TMDB rows with no date are announced but unscheduled; rows the scanner
    // made from a file have no date but obviously exist.
    aired: e.air_date ? e.air_date <= now : !e.tmdb_id,
    upcoming: Boolean(e.air_date && e.air_date > now),
    missing: missingKeys.has(`${e.season_number}:${e.episode_number}`),
  }));

  // Seasons present in files but absent from the TMDB season list still show up.
  const bySeason = new Map();
  for (const e of decorated) {
    if (!bySeason.has(e.season_number)) bySeason.set(e.season_number, []);
    bySeason.get(e.season_number).push(e);
  }

  const seasonBlocks = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, eps]) => {
      const meta = seasons.find((s) => s.season_number === number) || {};
      const owned = eps.filter((e) => e.owned).length;
      const aired = eps.filter((e) => e.aired).length;
      return {
        season_number: number,
        name: meta.name || (number === 0 ? 'Specials' : `Season ${number}`),
        poster_path: meta.poster_path || null,
        air_date: meta.air_date || null,
        episode_count: meta.episode_count ?? eps.length,
        owned_count: owned,
        aired_count: aired,
        missing_count: missingBySeason.get(number) || 0,
        watched_count: eps.filter((e) => e.watched).length,
        episodes: eps,
      };
    });

  const extras = db.prepare(`
    SELECT id, filename, path, size_bytes, quality FROM files
    WHERE show_id = ? AND episode_id IS NULL AND is_missing = 0
    ORDER BY filename
  `).all(showId);

  const ownedTotal = decorated.filter((e) => e.owned).length;
  const airedTotal = decorated.filter((e) => e.aired).length;
  const watchedTotal = decorated.filter((e) => e.watched).length;

  return {
    ...decorateShow(show),
    seasons: seasonBlocks,
    extras,
    stats: {
      owned: ownedTotal,
      aired: airedTotal,
      total: decorated.length,
      watched: watchedTotal,
      missing: report?.count || 0,
      progress: ownedTotal ? Math.round((watchedTotal / ownedTotal) * 100) : 0,
      size_bytes: db.prepare(
        'SELECT COALESCE(SUM(size_bytes),0) c FROM files WHERE show_id = ? AND is_missing = 0'
      ).get(showId).c,
    },
  };
}

// ---------------------------------------------------------------- movies

export function listMovies({ search = '', status = null, sort = 'title' } = {}) {
  const rows = db.prepare(`
    SELECT m.*, c.name AS collection_name,
      COALESCE(ms.watched, 0) AS watched, ms.watched_at, ms.rating AS watch_rating,
      (SELECT COUNT(*) FROM files f WHERE f.movie_id = m.id AND f.is_missing = 0) AS file_count,
      (SELECT COALESCE(SUM(f.size_bytes),0) FROM files f WHERE f.movie_id = m.id AND f.is_missing = 0) AS size_bytes,
      (SELECT COALESCE(json_extract(f.media_info, '$.quality'), f.quality) FROM files f WHERE f.movie_id = m.id AND f.is_missing = 0 ORDER BY f.size_bytes DESC LIMIT 1) AS quality,
      (SELECT f.path FROM files f WHERE f.movie_id = m.id AND f.is_missing = 0 LIMIT 1) AS file_path
    FROM movies m
    LEFT JOIN collections c ON c.id = m.collection_id
    LEFT JOIN movie_state ms ON ms.movie_id = m.id
    ORDER BY m.sort_title
  `).all();

  let out = rows.map(decorateMovie);
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((m) => m.title.toLowerCase().includes(q));
  }
  if (status) out = out.filter((m) => m.user_status === status);

  if (sort === 'recent') out.sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
  else if (sort === 'size') out.sort((a, b) => b.size_bytes - a.size_bytes);
  else if (sort === 'year') out.sort((a, b) => (b.year || 0) - (a.year || 0));
  return out;
}

export function getMovie(movieId) {
  const m = db.prepare(`
    SELECT m.*, c.name AS collection_name,
      COALESCE(ms.watched,0) AS watched, ms.watched_at, ms.rating AS watch_rating, ms.note,
      ms.progress_seconds, ms.duration_seconds
    FROM movies m
    LEFT JOIN collections c ON c.id = m.collection_id
    LEFT JOIN movie_state ms ON ms.movie_id = m.id
    WHERE m.id = ?
  `).get(movieId);
  if (!m) return null;

  const files = db.prepare(
    'SELECT id, filename, path, size_bytes, quality, codec, source, media_info FROM files WHERE movie_id = ? AND is_missing = 0 ORDER BY size_bytes DESC'
  ).all(movieId);
  const subs = subtitleIndex(files.map((f) => f.path));
  for (const f of files) {
    f.subtitles = subs.get(f.path) || [];
    f.media = f.media_info ? JSON.parse(f.media_info) : null;
    delete f.media_info;
    if (f.media?.quality) f.quality = f.media.quality;
  }

  const siblings = m.collection_id
    ? db.prepare(
        'SELECT id, title, tmdb_title, year, poster_path, custom_poster FROM movies WHERE collection_id = ? AND id != ? ORDER BY year'
      ).all(m.collection_id, movieId)
    : [];

  return { ...decorateMovie(m), files, collection_siblings: siblings };
}

// ---------------------------------------------------------------- discovery

/** Next unwatched owned episode for every show that has one in progress. */
export function continueWatching(limit = 24) {
  const rows = db.prepare(`
    SELECT s.id AS show_id, s.title, s.poster_path, s.backdrop_path, s.custom_poster, s.icon_emoji, s.accent_color,
           e.id AS episode_id, e.season_number, e.episode_number, e.title AS episode_title,
           e.runtime, e.still_path,
           (SELECT COUNT(*) FROM episode_state es2
             WHERE es2.show_id = s.id AND es2.watched = 1) AS watched_count,
           (SELECT COUNT(DISTINCT f2.episode_id) FROM files f2
             WHERE f2.show_id = s.id AND f2.episode_id IS NOT NULL AND f2.is_missing = 0) AS owned_count,
           (SELECT MAX(es3.watched_at) FROM episode_state es3
             WHERE es3.show_id = s.id AND es3.watched = 1) AS last_watched_at
    FROM shows s
    JOIN episodes e ON e.show_id = s.id
    JOIN files f ON f.episode_id = e.id AND f.is_missing = 0
    LEFT JOIN episode_state es ON es.episode_id = e.id
    WHERE COALESCE(es.watched, 0) = 0
      -- Dropped or finished: you have said you are not watching this.
      AND COALESCE(s.user_status, '') NOT IN ('dropped', 'completed')
      AND e.id = (
        SELECT e2.id FROM episodes e2
        JOIN files f2 ON f2.episode_id = e2.id AND f2.is_missing = 0
        LEFT JOIN episode_state es2 ON es2.episode_id = e2.id
        WHERE e2.show_id = s.id AND COALESCE(es2.watched, 0) = 0
        -- Season 0 is specials: never the thing to watch next.
        ORDER BY (e2.season_number = 0), e2.season_number, e2.episode_number LIMIT 1
      )
    GROUP BY s.id
    ORDER BY (last_watched_at IS NULL), last_watched_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map((r) => ({
    ...r,
    poster: r.custom_poster || (r.poster_path ? `tmdb:${r.poster_path}` : null),
    started: r.watched_count > 0,
    progress: r.owned_count ? Math.round((r.watched_count / r.owned_count) * 100) : 0,
  }));
}

/** Upcoming episodes with air dates in the future -> countdown timers. */
export function upcoming(days = 90) {
  const rows = db.prepare(`
    SELECT e.id AS episode_id, e.season_number, e.episode_number, e.title AS episode_title,
           e.air_date, e.runtime, e.still_path,
           s.id AS show_id, s.title AS show_title, s.poster_path, s.custom_poster,
           s.icon_emoji, s.accent_color, s.network
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    WHERE e.air_date IS NOT NULL
      AND e.air_date > date('now')
      AND e.air_date <= date('now', '+' || ? || ' days')
      -- What is coming for a series you dropped is not news you asked for.
      AND COALESCE(s.user_status, '') != 'dropped'
    ORDER BY e.air_date, s.sort_title
  `).all(days);

  const now = Date.now();
  return rows.map((r) => {
    const airMs = new Date(r.air_date + 'T00:00:00Z').getTime();
    return {
      ...r,
      poster: r.custom_poster || (r.poster_path ? `tmdb:${r.poster_path}` : null),
      days_until: Math.max(0, Math.ceil((airMs - now) / 86400000)),
    };
  });
}

/**
 * Everything aired that is not on disk, grouped by show.
 *
 * Two sources, because the episode table only lists what TMDB told us about:
 *  - matched shows: any aired episode with no file (authoritative)
 *  - unmatched shows: holes in the episode numbering (heuristic, so the
 *    feature still works before an API key is ever entered)
 */
export function missingReport() {
  const rows = db.prepare(`
    SELECT s.id AS show_id, s.title, s.poster_path, s.custom_poster, s.tmdb_status,
           e.season_number, e.episode_number, e.title AS episode_title, e.air_date
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    -- TMDB rows with no date are announced but unscheduled, so they don't
    -- count; rows the scanner created from a file have no date but do exist.
    WHERE (e.air_date <= date('now') OR (e.air_date IS NULL AND e.tmdb_id IS NULL))
      -- Specials (season 0) only count once the library holds at least one.
      AND (e.season_number > 0 OR EXISTS (
        SELECT 1 FROM files f0
        JOIN episodes e0 ON e0.id = f0.episode_id
        WHERE e0.show_id = e.show_id AND e0.season_number = 0 AND f0.is_missing = 0
      ))
      AND NOT EXISTS (
        SELECT 1 FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0
      )
      -- Nothing is missing from a series you dropped.
      AND COALESCE(s.user_status, '') != 'dropped'
      -- A title you only follow, or one whose files you deleted, is not a gap
      -- in the library: you are not missing what you never kept.
      AND EXISTS (
        SELECT 1 FROM files f1 WHERE f1.show_id = s.id AND f1.is_missing = 0
      )
    ORDER BY s.sort_title, e.season_number, e.episode_number
  `).all();

  // Numbering gaps for shows TMDB has not matched.
  const owned = db.prepare(`
    SELECT s.id AS show_id, s.title, s.poster_path, s.custom_poster, s.tmdb_status,
           e.season_number, e.episode_number
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    WHERE s.tmdb_id IS NULL
      AND EXISTS (SELECT 1 FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0)
    ORDER BY s.sort_title, e.season_number, e.episode_number
  `).all();

  const seen = new Map();
  for (const r of owned) {
    const key = `${r.show_id}|${r.season_number}`;
    if (!seen.has(key)) seen.set(key, { meta: r, nums: [] });
    seen.get(key).nums.push(r.episode_number);
  }
  for (const { meta, nums } of seen.values()) {
    const have = new Set(nums);
    const top = Math.max(...nums);
    for (let i = 1; i <= top; i++) {
      if (have.has(i)) continue;
      rows.push({
        show_id: meta.show_id,
        title: meta.title,
        poster_path: meta.poster_path,
        custom_poster: meta.custom_poster,
        tmdb_status: meta.tmdb_status,
        season_number: meta.season_number,
        episode_number: i,
        episode_title: null,
        air_date: null,
      });
    }
  }

  const byShow = new Map();
  for (const r of rows) {
    if (!byShow.has(r.show_id)) {
      byShow.set(r.show_id, {
        show_id: r.show_id,
        title: r.title,
        poster: r.custom_poster || (r.poster_path ? `tmdb:${r.poster_path}` : null),
        tmdb_status: r.tmdb_status,
        seasons: new Map(),
        count: 0,
      });
    }
    const show = byShow.get(r.show_id);
    if (!show.seasons.has(r.season_number)) show.seasons.set(r.season_number, []);
    show.seasons.get(r.season_number).push({
      episode_number: r.episode_number,
      title: r.episode_title,
      air_date: r.air_date,
    });
    show.count++;
  }

  // Per-season totals, so the UI can tell a gap inside a season you have from a
  // whole season you never downloaded (most of Family Guy's 440 are the latter).
  const seasonStats = new Map();
  for (const r of db.prepare(`
    SELECT e.show_id, e.season_number,
           COUNT(DISTINCT e.id) AS total,
           COUNT(DISTINCT CASE WHEN f.id IS NOT NULL THEN e.id END) AS owned
    FROM episodes e
    LEFT JOIN files f ON f.episode_id = e.id AND f.is_missing = 0
    GROUP BY e.show_id, e.season_number
  `).all()) {
    seasonStats.set(`${r.show_id}|${r.season_number}`, r);
  }

  return [...byShow.values()]
    .map((s) => {
      const seasons = [...s.seasons.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season_number, episodes]) => {
          const st = seasonStats.get(`${s.show_id}|${season_number}`) || {};
          const owned = st.owned || 0;
          return {
            season_number,
            episodes,
            owned,
            total: st.total ?? episodes.length,
            whole: owned === 0,
          };
        });
      return {
        ...s,
        seasons,
        gap_count: seasons.filter((x) => !x.whole).reduce((n, x) => n + x.episodes.length, 0),
        whole_seasons: seasons.filter((x) => x.whole).length,
      };
    })
    // Gaps inside seasons you already have come first: those are the likely downloads.
    .sort((a, b) => b.gap_count - a.gap_count || b.count - a.count);
}


// TMDB names television genres differently from film ones, so a library ends
// up with "Action" films on one shelf and "Action & Adventure" series on
// another. Browsing wants one shelf, so the combined television names are
// mapped onto the film names they cover.
const GENRE_ALIASES = {
  'Action & Adventure': ['Action', 'Adventure'],
  'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War'],
};

const genreNames = (raw) => {
  const out = new Set();
  for (const name of parseJson(raw, [])) {
    for (const mapped of GENRE_ALIASES[name] || [name]) out.add(mapped);
  }
  return out;
};

/**
 * The library grouped by genre, for browsing by mood rather than by name.
 * A title with three genres appears under all three: that is what genres are.
 * Genres come from TMDB, so without a key there is nothing to group by.
 */
export function byGenre() {
  const shows = db.prepare(`
    SELECT s.id, s.title, s.year, s.genres, s.poster_path, s.custom_poster, s.icon_emoji,
           (SELECT COUNT(DISTINCT f.episode_id) FROM files f
             WHERE f.show_id = s.id AND f.episode_id IS NOT NULL AND f.is_missing = 0) AS owned_episodes,
           (SELECT COUNT(*) FROM episode_state es WHERE es.show_id = s.id AND es.watched = 1) AS watched_episodes
    FROM shows s
  `).all();

  const movies = db.prepare(`
    SELECT m.id, COALESCE(m.tmdb_title, m.title) AS title, m.year, m.genres,
           m.poster_path, m.custom_poster, m.icon_emoji,
           COALESCE(ms.watched, 0) AS watched
    FROM movies m
    LEFT JOIN movie_state ms ON ms.movie_id = m.id
  `).all();

  const groups = new Map();
  const add = (name, item) => {
    if (!groups.has(name)) groups.set(name, { name, shows: 0, movies: 0, items: [] });
    const g = groups.get(name);
    g[item.kind === 'show' ? 'shows' : 'movies']++;
    g.items.push(item);
  };

  for (const row of shows) {
    const item = {
      id: row.id, kind: 'show', title: row.title, year: row.year,
      poster: row.custom_poster || (row.poster_path ? `tmdb:${row.poster_path}` : null),
      icon_emoji: row.icon_emoji,
      watched: row.owned_episodes > 0 && row.watched_episodes >= row.owned_episodes,
    };
    for (const name of genreNames(row.genres)) add(name, item);
  }
  for (const row of movies) {
    const item = {
      id: row.id, kind: 'movie', title: row.title, year: row.year,
      poster: row.custom_poster || (row.poster_path ? `tmdb:${row.poster_path}` : null),
      icon_emoji: row.icon_emoji,
      watched: Boolean(row.watched),
    };
    for (const name of genreNames(row.genres)) add(name, item);
  }

  const ungrouped =
    shows.filter((s) => !parseJson(s.genres, []).length).length +
    movies.filter((m) => !parseJson(m.genres, []).length).length;

  return {
    // Biggest shelves first; a genre with two things is less useful to browse.
    genres: [...groups.values()]
      .map((g) => ({ ...g, count: g.items.length, items: g.items.sort((a, b) => a.title.localeCompare(b.title)) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    without_genres: ungrouped,
  };
}
