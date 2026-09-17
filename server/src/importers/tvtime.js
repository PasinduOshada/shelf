// Import watch history from a TV Time data export (TV Time closed on
// 15 July 2026; its GDPR export is a zip of CSV files).
//
// Watches live in tracking-prod-records(-v2).csv (series_name / movie_name,
// type, season_number, episode_number, created_at) and in the
// seen_episode*.csv files (tv_show_name, episode_season_number,
// episode_number). Titles are matched to the library; episodes already
// watched in Shelf are left alone, so importing twice is harmless.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { isZip, readZip } from './zip.js';
import { setEpisodeWatched, setMovieWatched } from '../watch.js';

/** RFC 4180 CSV to an array of objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const num = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** Watch records from the export's files ([{ name, text }]). */
export function extractWatches(files) {
  const episodes = [];
  const movies = [];
  for (const { name, text } of files) {
    const base = name.split('/').pop().toLowerCase();
    if (!base.endsWith('.csv')) continue;
    const isTracking = base.startsWith('tracking-prod-records');
    const isSeen = /^(show_)?seen_episode/.test(base);
    if (!isTracking && !isSeen) continue;

    for (const r of parseCsv(text)) {
      const type = (r.type || '').toLowerCase();
      if (type && !['watch', 'rewatch'].includes(type)) continue;
      const at = r.created_at || r.watch_date || r.updated_at || null;
      if (isTracking && r.movie_name) {
        movies.push({ title: r.movie_name, at });
        continue;
      }
      const show = r.series_name || r.tv_show_name;
      const season = num(r.season_number ?? r.s_no ?? r.episode_season_number);
      const episode = num(r.episode_number ?? r.ep_no);
      if (show && season !== null && episode !== null) episodes.push({ show, season, episode, at });
    }
  }
  return { episodes, movies };
}

const key = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9]/g, '');

function libraryIndex() {
  const shows = new Map();
  for (const s of db.prepare('SELECT id, title, folder_name FROM shows').all()) {
    for (const t of [s.title, s.folder_name]) if (t && !shows.has(key(t))) shows.set(key(t), s.id);
  }
  const movies = new Map();
  for (const m of db.prepare('SELECT id, title, tmdb_title FROM movies').all()) {
    for (const t of [m.tmdb_title, m.title]) if (t && !movies.has(key(t))) movies.set(key(t), m.id);
  }
  return { shows, movies };
}

const episodeRow = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?');

/** Match records to the library without changing anything. */
export function planImport(watches) {
  const idx = libraryIndex();
  const plan = { episodes: [], movies: [], unmatchedShows: new Map(), unmatchedMovies: new Set(), notInShelf: 0 };
  const seen = new Set();

  for (const w of watches.episodes) {
    const showId = idx.shows.get(key(w.show));
    if (!showId) {
      plan.unmatchedShows.set(w.show, (plan.unmatchedShows.get(w.show) || 0) + 1);
      continue;
    }
    const ep = episodeRow.get(showId, w.season, w.episode);
    if (!ep) {
      plan.notInShelf++;
      continue;
    }
    // One watch per episode: the first record wins.
    if (seen.has(ep.id)) continue;
    seen.add(ep.id);
    plan.episodes.push({ episodeId: ep.id, at: w.at });
  }
  for (const w of watches.movies) {
    const movieId = idx.movies.get(key(w.title));
    if (!movieId) {
      plan.unmatchedMovies.add(w.title);
      continue;
    }
    if (seen.has(movieId)) continue;
    seen.add(movieId);
    plan.movies.push({ movieId, at: w.at });
  }
  return plan;
}

// ---------------------------------------------------------------- upload flow

const pending = new Map();

export function readExport(uploads) {
  const files = [];
  for (const u of uploads) {
    if (isZip(u.buffer)) {
      for (const e of readZip(u.buffer)) files.push({ name: e.name, text: e.data.toString('utf8') });
    } else {
      files.push({ name: u.originalname || 'upload.csv', text: u.buffer.toString('utf8') });
    }
  }
  return files;
}

export function previewImport(uploads) {
  const watches = extractWatches(readExport(uploads));
  if (!watches.episodes.length && !watches.movies.length) {
    throw Object.assign(
      new Error('No watch history found. Choose the TV Time export zip, or its tracking-prod-records CSV files.'),
      { status: 400 }
    );
  }
  const plan = planImport(watches);
  const id = randomUUID();
  pending.clear();
  pending.set(id, { plan, at: Date.now() });
  return {
    import_id: id,
    found: { episodes: watches.episodes.length, movies: watches.movies.length },
    matched: { episodes: plan.episodes.length, movies: plan.movies.length },
    not_in_shelf: plan.notInShelf,
    unmatched_shows: [...plan.unmatchedShows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([title, count]) => ({ title, count })),
    unmatched_movies: [...plan.unmatchedMovies].slice(0, 50),
  };
}

export function applyImport(id) {
  const entry = pending.get(id);
  if (!entry) throw Object.assign(new Error('That import has expired. Choose the file again.'), { status: 410 });
  pending.delete(id);
  let episodes = 0;
  let movies = 0;
  for (const e of entry.plan.episodes) {
    if (setEpisodeWatched(e.episodeId, true, { at: e.at, ifUnwatched: true })?.changed) episodes++;
  }
  for (const m of entry.plan.movies) {
    if (setMovieWatched(m.movieId, true, { at: m.at, ifUnwatched: true })?.changed) movies++;
  }
  return { marked: { episodes, movies }, already: entry.plan.episodes.length - episodes + entry.plan.movies.length - movies };
}
