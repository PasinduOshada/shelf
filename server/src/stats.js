import { db } from './db.js';
import { missingReport } from './queries.js';

function parseJson(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

/** Headline numbers for the dashboard. */
export function overview() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const totals = {
    shows: one('SELECT COUNT(*) c FROM shows').c,
    movies: one('SELECT COUNT(*) c FROM movies').c,
    episodes: one('SELECT COUNT(*) c FROM episodes').c,
    files: one('SELECT COUNT(*) c FROM files WHERE is_missing = 0').c,
    size_bytes: one('SELECT COALESCE(SUM(size_bytes),0) c FROM files WHERE is_missing = 0').c,
  };

  const watched = {
    episodes: one('SELECT COUNT(*) c FROM episode_state WHERE watched = 1').c,
    movies: one('SELECT COUNT(*) c FROM movie_state WHERE watched = 1').c,
    minutes: one('SELECT COALESCE(SUM(minutes),0) c FROM watch_history').c,
  };

  // Same source as the Missing page, including the numbering-gap estimates
  // for shows TMDB has not matched -- otherwise the two pages disagree.
  const report = missingReport();
  const missing = report.reduce((n, s) => n + s.count, 0);
  // Gaps inside seasons already started -- the actionable part. The full count
  // is dominated by seasons never downloaded.
  const missingGaps = report.reduce((n, s) => n + (s.gap_count || 0), 0);

  return {
    totals,
    watched: {
      ...watched,
      hours: Math.round(watched.minutes / 60),
      days: +(watched.minutes / 1440).toFixed(1),
    },
    missing_episodes: missing,
    missing_gaps: missingGaps,
    unmatched: {
      shows: one("SELECT COUNT(*) c FROM shows WHERE tmdb_id IS NULL").c,
      movies: one("SELECT COUNT(*) c FROM movies WHERE tmdb_id IS NULL").c,
    },
  };
}

/** Per-day watch minutes over a window, for the activity chart. */
export function activity(days = 90) {
  const rows = db.prepare(`
    SELECT date(watched_at) AS day,
           COUNT(*) AS items,
           COALESCE(SUM(minutes),0) AS minutes
    FROM watch_history
    WHERE watched_at >= datetime('now', '-' || ? || ' days')
    GROUP BY day ORDER BY day
  `).all(days);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const hit = byDay.get(d);
    out.push({ day: d, items: hit?.items ?? 0, minutes: hit?.minutes ?? 0 });
  }
  return out;
}

/** Rolling summaries: this week, this month, and the ones before them. */
export function summaries() {
  const window = (fromSql, toSql) => {
    const r = db.prepare(`
      SELECT COUNT(*) items,
             COALESCE(SUM(minutes),0) minutes,
             COUNT(DISTINCT show_id) shows,
             SUM(CASE WHEN kind='movie' THEN 1 ELSE 0 END) movies,
             SUM(CASE WHEN kind='episode' THEN 1 ELSE 0 END) episodes
      FROM watch_history
      WHERE watched_at >= ${fromSql} ${toSql ? `AND watched_at < ${toSql}` : ''}
    `).get();
    return { ...r, hours: +(r.minutes / 60).toFixed(1) };
  };

  const topIn = (fromSql) => db.prepare(`
    SELECT s.title, COUNT(*) n, COALESCE(SUM(h.minutes),0) minutes
    FROM watch_history h JOIN shows s ON s.id = h.show_id
    WHERE h.watched_at >= ${fromSql}
    GROUP BY s.id ORDER BY minutes DESC LIMIT 5
  `).all();

  return {
    week: { ...window("datetime('now','-7 days')"), top: topIn("datetime('now','-7 days')") },
    prev_week: window("datetime('now','-14 days')", "datetime('now','-7 days')"),
    month: { ...window("datetime('now','-30 days')"), top: topIn("datetime('now','-30 days')") },
    prev_month: window("datetime('now','-60 days')", "datetime('now','-30 days')"),
    year: { ...window("datetime('now','-365 days')"), top: topIn("datetime('now','-365 days')") },
  };
}

/** Longest and current consecutive-day watching streak. */
export function streaks() {
  const days = db.prepare(
    'SELECT DISTINCT date(watched_at) d FROM watch_history ORDER BY d'
  ).all().map((r) => r.d);

  if (!days.length) return { current: 0, longest: 0, last_watched: null };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + 'T00:00:00Z').getTime();
    const cur = new Date(days[i] + 'T00:00:00Z').getTime();
    if (cur - prev === 86400000) run++;
    else run = 1;
    if (run > longest) longest = run;
  }

  // Current streak counts back from today or yesterday.
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const last = days[days.length - 1];
  let current = 0;
  if (last === todayStr || last === yesterdayStr) {
    current = 1;
    for (let i = days.length - 1; i > 0; i--) {
      const prev = new Date(days[i - 1] + 'T00:00:00Z').getTime();
      const cur = new Date(days[i] + 'T00:00:00Z').getTime();
      if (cur - prev === 86400000) current++;
      else break;
    }
  }
  return { current, longest, last_watched: last };
}

/** Library composition: genres, quality, decades, biggest items. */
export function composition() {
  const genreCount = new Map();
  const addGenres = (json, weight = 1) => {
    for (const g of parseJson(json, [])) {
      genreCount.set(g, (genreCount.get(g) || 0) + weight);
    }
  };
  for (const r of db.prepare('SELECT genres FROM shows WHERE genres IS NOT NULL').all()) addGenres(r.genres);
  for (const r of db.prepare('SELECT genres FROM movies WHERE genres IS NOT NULL').all()) addGenres(r.genres);

  const genres = [...genreCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const quality = db.prepare(`
    SELECT COALESCE(json_extract(media_info, '$.quality'), quality, 'unknown') name, COUNT(*) count,
           COALESCE(SUM(size_bytes),0) bytes
    FROM files WHERE is_missing = 0
    GROUP BY 1 ORDER BY count DESC
  `).all();

  const codecs = db.prepare(`
    SELECT COALESCE(codec,'unknown') name, COUNT(*) count
    FROM files WHERE is_missing = 0
    GROUP BY COALESCE(codec,'unknown') ORDER BY count DESC
  `).all();

  const biggestShows = db.prepare(`
    SELECT s.id, s.title, COUNT(f.id) files, COALESCE(SUM(f.size_bytes),0) bytes
    FROM shows s JOIN files f ON f.show_id = s.id AND f.is_missing = 0
    GROUP BY s.id ORDER BY bytes DESC LIMIT 10
  `).all();

  const biggestMovies = db.prepare(`
    SELECT m.id, COALESCE(m.tmdb_title, m.title) AS title, m.year, COALESCE(SUM(f.size_bytes),0) bytes
    FROM movies m JOIN files f ON f.movie_id = m.id AND f.is_missing = 0
    GROUP BY m.id ORDER BY bytes DESC LIMIT 10
  `).all();

  const decades = db.prepare(`
    SELECT (year/10)*10 AS decade, COUNT(*) count FROM movies
    WHERE year IS NOT NULL GROUP BY decade ORDER BY decade
  `).all();

  return { genres, quality, codecs, biggestShows, biggestMovies, decades };
}

/** Year-in-review. */
export function wrapped(year = new Date().getFullYear()) {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const p = [from, to];

  const totals = db.prepare(`
    SELECT COUNT(*) items, COALESCE(SUM(minutes),0) minutes,
           COUNT(DISTINCT show_id) shows,
           SUM(CASE WHEN kind='movie' THEN 1 ELSE 0 END) movies,
           SUM(CASE WHEN kind='episode' THEN 1 ELSE 0 END) episodes,
           COUNT(DISTINCT date(watched_at)) active_days
    FROM watch_history WHERE watched_at >= ? AND watched_at < ?
  `).get(...p);

  const topShows = db.prepare(`
    SELECT s.id, s.title, s.poster_path, s.custom_poster,
           COUNT(*) episodes, COALESCE(SUM(h.minutes),0) minutes
    FROM watch_history h JOIN shows s ON s.id = h.show_id
    WHERE h.watched_at >= ? AND h.watched_at < ?
    GROUP BY s.id ORDER BY minutes DESC LIMIT 10
  `).all(...p);

  const byMonth = db.prepare(`
    SELECT strftime('%m', watched_at) month, COUNT(*) items,
           COALESCE(SUM(minutes),0) minutes
    FROM watch_history WHERE watched_at >= ? AND watched_at < ?
    GROUP BY month ORDER BY month
  `).all(...p);

  const busiestDay = db.prepare(`
    SELECT date(watched_at) day, COUNT(*) items, COALESCE(SUM(minutes),0) minutes
    FROM watch_history WHERE watched_at >= ? AND watched_at < ?
    GROUP BY day ORDER BY minutes DESC LIMIT 1
  `).get(...p);

  const genreCount = new Map();
  const rows = db.prepare(`
    SELECT DISTINCT s.genres FROM watch_history h JOIN shows s ON s.id = h.show_id
    WHERE h.watched_at >= ? AND h.watched_at < ? AND s.genres IS NOT NULL
  `).all(...p);
  for (const r of rows) {
    for (const g of parseJson(r.genres, [])) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const key = String(i + 1).padStart(2, '0');
    const hit = byMonth.find((m) => m.month === key);
    return { month: i + 1, items: hit?.items ?? 0, minutes: hit?.minutes ?? 0 };
  });

  return {
    year,
    totals: {
      ...totals,
      hours: Math.round(totals.minutes / 60),
      days: +(totals.minutes / 1440).toFixed(1),
    },
    topShows: topShows.map((s) => ({
      ...s,
      poster: s.custom_poster || (s.poster_path ? `tmdb:${s.poster_path}` : null),
    })),
    months,
    busiestDay,
    topGenres: [...genreCount.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 6),
  };
}
