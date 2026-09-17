// TMDB client.
//
// Every call degrades to null when no API key is configured, so the app stays
// usable on a fresh install. Matching is deliberately forgiving, because real
// folder names are misspelled ("Tha Raincoat Killer"), trimmed ("Butcher of
// Delhi") or noisy ("Oggy & The Crokroachers").
import { randomUUID } from 'node:crypto';
import { db, getSetting, setSetting, transaction, sortTitle } from './db.js';
import { cacheImage } from './images.js';
import { parseFilename, parseFolderName } from './scanner/parse.js';

const BASE = 'https://api.themoviedb.org/3';

export function getApiKey() {
  return process.env.TMDB_API_KEY || getSetting('tmdb.apiKey') || null;
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

class TmdbAuthError extends Error {}

/**
 * TMDB hands out two credentials and people paste either: the short v3 "API
 * Key" (query parameter) or the long v4 "Read Access Token" (a JWT, sent as a
 * Bearer header). Accept both.
 */
function authFor(key) {
  return /^eyJ/.test(key)
    ? { headers: { Authorization: `Bearer ${key}` }, apiKey: null }
    : { headers: {}, apiKey: key };
}

let lastCall = 0;
const MIN_GAP_MS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(path, params = {}, attempt = 0) {
  const key = getApiKey();
  if (!key) return null;

  const gap = Date.now() - lastCall;
  if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
  lastCall = Date.now();

  const auth = authFor(key);
  const url = new URL(BASE + path);
  if (auth.apiKey) url.searchParams.set('api_key', auth.apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...auth.headers } });
  } catch (err) {
    if (attempt < 2) {
      await sleep(800 * (attempt + 1));
      return tmdb(path, params, attempt + 1);
    }
    throw err;
  }

  if (res.status === 401) throw new TmdbAuthError('TMDB rejected the API key');
  if (res.status === 404) return null;
  if (res.status === 429 && attempt < 5) {
    await sleep(Number(res.headers.get('retry-after')) * 1000 || 1500);
    return tmdb(path, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`);
  return res.json();
}

export async function verifyApiKey(key) {
  const auth = authFor(key);
  const url = new URL(BASE + '/configuration');
  if (auth.apiKey) url.searchParams.set('api_key', auth.apiKey);
  // A reset connection says nothing about the key; retry before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...auth.headers } });
      return res.ok;
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(600 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------- matching

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'with', 'for', 'aka']);

// Strip what hurts a title search: AKA aliases, bracket noise, punctuation.
// Censored words are restored first -- TMDB lists "The End of the F***ing
// World", and stripping the asterisks would leave "f ing".
function searchable(title) {
  return String(title || '')
    .replace(/\bf\*+ing/gi, 'fucking')
    .replace(/\bf\*+k/gi, 'fuck')
    .replace(/\bsh\*+t/gi, 'shit')
    .replace(/\bA[\s._]?K[\s._]?A\b.*$/i, '')
    .replace(/[\[(].*?[\])]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const NUMBER_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

// The form titles are compared in. Number words become digits so a filename's
// "Fantastic Four" equals TMDB's "The Fantastic 4". Search queries keep the
// original wording; only comparison is canonicalised.
// Accents are dropped too: TMDB's "Shōgun" must equal a filename's "Shogun".
const canonical = (s) =>
  searchable(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => NUMBER_WORDS[w]);

const norm = (s) => canonical(s).replace(/[^a-z0-9]/g, '');
const words = (s) => canonical(s).split(/\s+/).filter(Boolean);
const significant = (s) => words(s).filter((w) => w.length >= 4 && !STOP.has(w));

/** 0..1 similarity between a local title and a TMDB title. */
function similarity(local, remote) {
  const x = norm(local);
  const y = norm(remote);
  if (!x || !y) return 0;
  if (x === y) return 1;

  // One contains the other ("Foodtopia" in "Sausage Party: Foodtopia"). The
  // length ratio stops a short generic title swallowing a long specific one.
  const shorter = Math.min(x.length, y.length);
  const longer = Math.max(x.length, y.length);
  if (shorter >= 4 && (x.includes(y) || y.includes(x))) {
    const ratio = shorter / longer;
    if (ratio >= 0.4) return 0.6 + 0.3 * ratio;
  }

  // Misspelled or trimmed names: how many of the local title's meaningful
  // words appear in the TMDB title. "FIght Night The Million Doller heist"
  // shares 4 of its 5 with "Fight Night: The Million Dollar Heist".
  const sig = significant(local);
  if (sig.length >= 2) {
    const remoteWords = new Set(words(remote));
    const hit = sig.filter((w) => remoteWords.has(w)).length;
    // One shared word is not evidence: "wijesingheᴺˢ Missing You" shares only
    // "missing" with the unrelated film "Missing".
    if (hit < 2) return 0;
    return 0.3 + 0.55 * (hit / sig.length);
  }
  return 0;
}

const MATCH_THRESHOLD = 0.55;

function pickBest(results, locals, year, kind) {
  const nameKey = kind === 'tv' ? 'name' : 'title';
  const dateKey = kind === 'tv' ? 'first_air_date' : 'release_date';
  let best = null;
  for (const r of results) {
    let s = 0;
    for (const t of locals) {
      s = Math.max(s, similarity(t, r[nameKey]), similarity(t, r[`original_${nameKey}`]));
    }
    if (year && r[dateKey]?.startsWith(String(year))) s += 0.15;
    // TMDB flags premieres, featurettes and trailers as `video`; never prefer them.
    if (r.video === true) s -= 0.3;
    s += Math.min(r.popularity || 0, 100) / 2000; // tie-break toward the well-known one
    if (!best || s > best.score) best = { score: s, result: r };
  }
  return best;
}

/** Search strings to try, most specific first, then increasingly forgiving. */
function candidateQueries(primary) {
  const out = [];
  const add = (q) => {
    const s = searchable(q);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  for (const t of primary) add(t);
  const first = primary[0] || '';
  const rest = words(first).slice(1);
  if (rest.length >= 2) add(rest.join(' ')); // drops a leading junk word or uploader tag
  const sig = significant(first);
  if (sig.length >= 2) add(sig.slice(0, 3).join(' '));
  // A typo in an early word ("How to Trian Your Dragon") survives in the tail.
  if (sig.length >= 3) add(sig.slice(-2).join(' '));
  if (sig[0]) add(sig[0]);
  return out.slice(0, 7);
}

async function findMatch(kind, primary, scoreAgainst, years) {
  const endpoint = kind === 'tv' ? '/search/tv' : '/search/movie';
  const yearParam = kind === 'tv' ? 'first_air_date_year' : 'year';
  const year = years.find(Boolean) || null;

  for (const query of candidateQueries(primary)) {
    for (const y of year ? [year, null] : [null]) {
      const data = await tmdb(endpoint, { query, [yearParam]: y, include_adult: 'false' });
      if (!data?.results?.length) continue;
      const best = pickBest(data.results, scoreAgainst, year, kind);
      if (best && best.score >= MATCH_THRESHOLD) return best.result;
    }
  }
  return null;
}

/** Every title hint a show has: episode filenames, its folder, its display title. */
function showHints(show) {
  const counts = new Map();
  const years = [show.year];
  const files = db.prepare(
    'SELECT filename FROM files WHERE show_id = ? AND episode_id IS NOT NULL AND is_missing = 0 LIMIT 8'
  ).all(show.id);
  for (const f of files) {
    const p = parseFilename(f.filename);
    if (p.title) counts.set(p.title, (counts.get(p.title) || 0) + 1);
    if (p.year) years.push(p.year);
  }
  const fileTitles = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const folderTitle = show.folder_name ? parseFolderName(show.folder_name).title : null;

  const primary = [...new Set([fileTitles[0], folderTitle, show.title].filter(Boolean))];
  const scoreAgainst = [...new Set([...primary, ...fileTitles])];
  return { primary, scoreAgainst, years };
}

// Pure matching helpers, exported for the regression tests.
export { similarity, candidateQueries, pickBest, MATCH_THRESHOLD };

/**
 * Official title + year for a parsed title, or null. Used by the organiser to
 * name folders; the same forgiving matcher the library uses.
 */
export async function lookupTitle(kind, title, year, alternatives = []) {
  const names = [title, ...alternatives];
  const hit = await findMatch(kind, names, names, [year]);
  if (!hit) return null;
  const date = kind === 'tv' ? hit.first_air_date : hit.release_date;
  const hitYear = date ? Number(date.slice(0, 4)) : null;
  // A film's year is part of its identity: "Dune (2021)" is not "Dune (1984)".
  if (kind === 'movie' && year && hitYear && Math.abs(hitYear - year) > 1) return null;
  return { tmdb_id: hit.id, title: kind === 'tv' ? hit.name : hit.title, year: hitYear };
}

/** Map of episode number -> name for one TMDB season (empty when unknown). */
export async function seasonEpisodeNames(tmdbId, season) {
  const data = await tmdb(`/tv/${tmdbId}/season/${season}`);
  return new Map((data?.episodes || []).map((e) => [e.episode_number, e.name]));
}

export const searchShowRaw = (q) => tmdb('/search/tv', { query: searchable(q) });
export const searchMovieRaw = (q) => tmdb('/search/movie', { query: searchable(q) });

// ---------------------------------------------------------------- enrichment

async function cachePoster(path) {
  try {
    await cacheImage('w342', path);
  } catch {
    /* artwork is best-effort; it is fetched again lazily on first view */
  }
}

// ---------------------------------------------------------------- episode ordering
//
// TMDB's default seasons don't always match how files are numbered. Money
// Heist on disk uses Netflix's five "parts" (13/9/8/8/10 episodes); TMDB's
// default is three broadcast seasons (15/16/10). TMDB publishes alternative
// orderings as "episode groups", and the one that explains the most files wins.

// Group types that describe a season layout. 2 (absolute numbering) and
// 5 (story arcs) don't correspond to SxxEyy file names.
const ORDERING_TYPES = new Set([1, 3, 4, 6, 7]);

/** How many owned (season, episode) pairs exist in an ordering's layout. */
export function orderingFit(counts, owned) {
  let fit = 0;
  for (const { season, episode } of owned) {
    if ((counts.get(season) || 0) >= episode) fit++;
  }
  return fit;
}

/** Episodes an ordering adds beyond the owned ones, in seasons the user has. */
function orderingSlack(counts, owned) {
  const bySeason = new Map();
  for (const { season } of owned) bySeason.set(season, (bySeason.get(season) || 0) + 1);
  let slack = 0;
  for (const [season, n] of bySeason) slack += Math.max(0, (counts.get(season) || 0) - n);
  return slack;
}

/**
 * Pick the ordering that explains the most files. TMDB's default wins unless an
 * alternative fits strictly more; among equals, the tighter layout wins.
 */
export function pickOrdering(defaultCounts, candidates, owned) {
  const defaultFit = orderingFit(defaultCounts, owned);
  let best = null;
  for (const c of candidates) {
    const fit = orderingFit(c.counts, owned);
    if (fit <= defaultFit) continue;
    const score = fit * 1000 - orderingSlack(c.counts, owned);
    if (!best || score > best.score) best = { id: c.id, name: c.name, fit, score };
  }
  return best || { id: null, name: null, fit: defaultFit };
}

function ownedPairs(showId) {
  return db.prepare(`
    SELECT DISTINCT parsed_season AS season, parsed_episode AS episode FROM files
    WHERE show_id = ? AND episode_id IS NOT NULL AND is_missing = 0
      AND parsed_season IS NOT NULL AND parsed_episode IS NOT NULL
  `).all(showId);
}

const layoutOf = (seasons) =>
  new Map(seasons.map((s) => [s.season_number, s.episodes?.length ?? s.episode_count ?? 0]));

async function fetchGroup(groupId) {
  const g = await tmdb(`/tv/episode_group/${groupId}`);
  if (!g?.groups?.length) return null;
  const seasons = [...g.groups]
    .sort((a, b) => a.order - b.order)
    .map((grp) => {
      const episodes = [...(grp.episodes || [])]
        .sort((a, b) => a.order - b.order)
        .map((e) => ({ ...e, episode_number: e.order + 1 }));
      return {
        season_number: grp.order,
        name: grp.name || `Season ${grp.order}`,
        overview: null,
        poster_path: null,
        air_date: episodes.find((e) => e.air_date)?.air_date ?? null,
        episodes,
      };
    });
  return { id: g.id, name: g.name, type: g.type, seasons };
}

async function candidateGroups(tmdbId) {
  const list = await tmdb(`/tv/${tmdbId}/episode_groups`);
  const out = [];
  for (const g of (list?.results || []).filter((r) => ORDERING_TYPES.has(r.type) && r.episode_count > 0).slice(0, 8)) {
    const full = await fetchGroup(g.id);
    if (full) out.push({ ...full, counts: layoutOf(full.seasons) });
  }
  return out;
}

/** Every ordering TMDB offers for a show, scored against the files on disk. */
export async function listOrderings(showId) {
  const show = db.prepare('SELECT tmdb_id, episode_group_id FROM shows WHERE id = ?').get(showId);
  if (!show?.tmdb_id) return null;
  const details = await tmdb(`/tv/${show.tmdb_id}`);
  if (!details) return null;

  const owned = ownedPairs(showId);
  const defaultCounts = layoutOf(details.seasons || []);
  const groups = await candidateGroups(show.tmdb_id);
  const describe = (counts) => ({
    seasons: counts.size,
    episodes: [...counts.values()].reduce((a, b) => a + b, 0),
    fit: orderingFit(counts, owned),
  });

  return {
    current: show.episode_group_id && show.episode_group_id !== 'default' ? show.episode_group_id : null,
    owned: owned.length,
    orderings: [
      { id: null, name: 'TMDB seasons', ...describe(defaultCounts) },
      ...groups.map((g) => ({ id: g.id, name: g.name, ...describe(g.counts) })),
    ],
  };
}

// ---------------------------------------------------------------- enrichment

/**
 * Write TMDB show details + the full episode list into the local tables.
 *
 * `groupId`: undefined = keep the show's current ordering (or pick one
 * automatically), 'default' = force TMDB's seasons, any other value = that
 * episode group.
 */
export async function enrichShow(showId, tmdbId, { groupId } = {}) {
  const details = await tmdb(`/tv/${tmdbId}`);
  if (!details) return { ok: false, reason: 'not-found' };

  const current = db.prepare('SELECT tmdb_id, episode_group_id FROM shows WHERE id = ?').get(showId);
  let choice = groupId;
  if (choice === undefined && current?.tmdb_id === tmdbId && current.episode_group_id) {
    choice = current.episode_group_id;
  }

  const defaultCounts = layoutOf(details.seasons || []);
  let group = null;
  if (choice && choice !== 'default') {
    group = await fetchGroup(choice);
  } else if (choice === undefined) {
    const owned = ownedPairs(showId);
    // Only look at alternatives when TMDB's seasons leave files unexplained.
    if (owned.length && orderingFit(defaultCounts, owned) < owned.length) {
      const candidates = await candidateGroups(tmdbId);
      const best = pickOrdering(defaultCounts, candidates, owned);
      group = candidates.find((c) => c.id === best.id) || null;
    }
  }

  let seasons;
  if (group) {
    seasons = group.seasons;
  } else {
    seasons = [];
    for (const s of details.seasons || []) {
      if (s.season_number == null) continue;
      const season = await tmdb(`/tv/${tmdbId}/season/${s.season_number}`);
      if (!season) continue;
      seasons.push({
        season_number: s.season_number,
        name: s.name ?? null,
        overview: s.overview ?? null,
        poster_path: s.poster_path ?? null,
        air_date: s.air_date ?? null,
        episodes: season.episodes || [],
      });
    }
  }

  // The next episode is reported in TMDB's default numbering; translate it.
  let next = details.next_episode_to_air;
  if (next && group) {
    const hit = group.seasons
      .flatMap((s) => s.episodes.map((e) => ({ s: s.season_number, e })))
      .find((x) => x.e.id === next.id);
    next = hit ? { ...next, season_number: hit.s, episode_number: hit.e.episode_number } : next;
  }

  const genres = JSON.stringify((details.genres || []).map((g) => g.name));
  const runtime = details.episode_run_time?.[0] ?? null;
  const name = details.name || null;
  const storedChoice = group ? group.id : choice === 'default' ? 'default' : null;

  transaction(() => {
    // Shows are keyed by folder path, so adopting TMDB's canonical name is safe.
    db.prepare(
      `UPDATE shows SET tmdb_id=?, tmdb_status='matched', overview=?, poster_path=?,
        backdrop_path=?, genres=?, network=?, status=?, first_air_date=?, last_air_date=?,
        vote_average=?, episode_runtime=?, next_air_date=?, next_season=?, next_episode=?,
        next_title=?, title=COALESCE(?, title), sort_title=COALESCE(?, sort_title),
        year=COALESCE(year, CAST(SUBSTR(?, 1, 4) AS INTEGER)),
        episode_group_id=?, episode_group_name=?,
        tmdb_refreshed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(
      tmdbId, details.overview ?? null, details.poster_path ?? null,
      details.backdrop_path ?? null, genres,
      details.networks?.[0]?.name ?? null, details.status ?? null,
      details.first_air_date ?? null, details.last_air_date ?? null,
      details.vote_average ?? null, runtime,
      next?.air_date ?? null, next?.season_number ?? null,
      next?.episode_number ?? null, next?.name ?? null,
      name, name ? sortTitle(name) : null, details.first_air_date ?? null,
      storedChoice, group ? group.name : null, showId
    );

    // Episodes the chosen ordering doesn't contain: TMDB-only rows are removed
    // (otherwise switching ordering leaves stale "missing" episodes), while rows
    // tied to a file or watch history stay but lose metadata that no longer fits.
    const wanted = new Set();
    for (const s of seasons) for (const e of s.episodes) wanted.add(`${s.season_number}:${e.episode_number}`);
    for (const row of db.prepare('SELECT id, season_number, episode_number FROM episodes WHERE show_id = ?').all(showId)) {
      if (wanted.has(`${row.season_number}:${row.episode_number}`)) continue;
      const used = db.prepare(`
        SELECT 1 FROM files WHERE episode_id = ?1
        UNION ALL SELECT 1 FROM episode_state WHERE episode_id = ?1
        UNION ALL SELECT 1 FROM watch_history WHERE episode_id = ?1
        LIMIT 1
      `).get(row.id);
      if (used) {
        db.prepare('UPDATE episodes SET tmdb_id=NULL, title=NULL, overview=NULL, air_date=NULL, runtime=NULL, still_path=NULL, vote_average=NULL WHERE id=?').run(row.id);
      } else {
        db.prepare('DELETE FROM episodes WHERE id = ?').run(row.id);
      }
    }

    for (const s of seasons) {
      const count = s.episodes.length;
      const existing = db
        .prepare('SELECT id FROM seasons WHERE show_id=? AND season_number=?')
        .get(showId, s.season_number);
      if (existing) {
        db.prepare('UPDATE seasons SET name=?, overview=?, poster_path=?, air_date=?, episode_count=? WHERE id=?')
          .run(s.name ?? null, s.overview ?? null, s.poster_path ?? null, s.air_date ?? null, count, existing.id);
      } else {
        db.prepare(
          `INSERT INTO seasons (id, show_id, season_number, name, overview, poster_path, air_date, episode_count)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(randomUUID(), showId, s.season_number, s.name ?? null, s.overview ?? null,
              s.poster_path ?? null, s.air_date ?? null, count);
      }

      for (const ep of s.episodes) {
        const found = db
          .prepare('SELECT id FROM episodes WHERE show_id=? AND season_number=? AND episode_number=?')
          .get(showId, s.season_number, ep.episode_number);
        if (found) {
          db.prepare('UPDATE episodes SET tmdb_id=?, title=?, overview=?, air_date=?, runtime=?, still_path=?, vote_average=? WHERE id=?')
            .run(ep.id, ep.name ?? null, ep.overview ?? null, ep.air_date ?? null,
                 ep.runtime ?? null, ep.still_path ?? null, ep.vote_average ?? null, found.id);
        } else {
          db.prepare(
            `INSERT INTO episodes (id, show_id, season_number, episode_number, tmdb_id, title, overview, air_date, runtime, still_path, vote_average)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).run(randomUUID(), showId, s.season_number, ep.episode_number, ep.id,
                ep.name ?? null, ep.overview ?? null, ep.air_date ?? null,
                ep.runtime ?? null, ep.still_path ?? null, ep.vote_average ?? null);
        }
      }
    }

    // Seasons left with no episodes belonged to the previous ordering.
    db.prepare(`
      DELETE FROM seasons WHERE show_id = ?1
        AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = ?1 AND e.season_number = seasons.season_number)
    `).run(showId);
  });

  await cachePoster(details.poster_path);
  return { ok: true, title: name, ordering: group ? group.name : null };
}

export async function enrichMovie(movieId, tmdbId) {
  const d = await tmdb(`/movie/${tmdbId}`);
  if (!d) return { ok: false, reason: 'not-found' };

  transaction(() => {
    // Movies are re-found on every scan by their parsed title, so the canonical
    // TMDB title lives in its own column instead of overwriting `title`.
    db.prepare(
      `UPDATE movies SET tmdb_id=?, tmdb_status='matched', tmdb_title=?, overview=?, poster_path=?,
        backdrop_path=?, genres=?, runtime=?, release_date=?, vote_average=?, tagline=?,
        tmdb_refreshed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
    ).run(
      tmdbId, d.title ?? null, d.overview ?? null, d.poster_path ?? null, d.backdrop_path ?? null,
      JSON.stringify((d.genres || []).map((g) => g.name)),
      d.runtime ?? null, d.release_date ?? null, d.vote_average ?? null,
      d.tagline ?? null, movieId
    );
  });

  await cachePoster(d.poster_path);
  return { ok: true, title: d.title };
}

/**
 * Background metadata work.
 *  - default: match + enrich everything still unmatched
 *  - refresh: re-pull already-matched titles whose data goes stale: shows still
 *    airing (new episodes, air dates, countdowns) and recent films (ratings,
 *    artwork). Ended shows and older films rarely change on TMDB.
 */
export async function enrichAll({ onProgress = null, refresh = false } = {}) {
  if (!hasApiKey()) return { skipped: true, reason: 'no-api-key' };

  // Shows with no episodes are grouping folders ("Documentaries"), not series.
  const shows = refresh
    ? db.prepare(`
        SELECT * FROM shows
        WHERE tmdb_id IS NOT NULL
          AND (status IS NULL OR status NOT IN ('Ended', 'Canceled'))
          AND (tmdb_refreshed_at IS NULL OR tmdb_refreshed_at < datetime('now', '-20 hours'))
        ORDER BY sort_title
      `).all()
    : db.prepare(`
        SELECT s.* FROM shows s
        WHERE s.tmdb_id IS NULL AND s.tmdb_status != 'failed'
          AND EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = s.id)
        ORDER BY s.sort_title
      `).all();
  const movies = refresh
    ? db.prepare(`
        SELECT * FROM movies
        WHERE tmdb_id IS NOT NULL
          AND (release_date IS NULL OR release_date >= date('now', '-180 days'))
          AND (tmdb_refreshed_at IS NULL OR tmdb_refreshed_at < datetime('now', '-7 days'))
        ORDER BY sort_title
      `).all()
    : db.prepare(
        "SELECT * FROM movies WHERE tmdb_id IS NULL AND tmdb_status != 'failed' ORDER BY sort_title"
      ).all();

  const state = {
    mode: refresh ? 'refresh' : 'match',
    total: shows.length + movies.length, done: 0, shows: 0, movies: 0, failed: 0, failures: [],
  };
  const report = (current) => onProgress?.({ ...state, failures: [...state.failures], current });

  async function attempt(kind, table, row, find, enrich) {
    report(row.tmdb_title || row.title);
    try {
      const hit = await find(row);
      if (hit) {
        await enrich(row.id, hit.id);
        state[kind]++;
      } else if (!refresh) {
        db.prepare(`UPDATE ${table} SET tmdb_status='failed' WHERE id=?`).run(row.id);
        state.failed++;
        if (state.failures.length < 200) state.failures.push(row.title);
      }
    } catch (err) {
      if (err instanceof TmdbAuthError) throw err;
      // A refresh that fails keeps the existing match; only new matches are marked failed.
      if (!refresh) db.prepare(`UPDATE ${table} SET tmdb_status='failed' WHERE id=?`).run(row.id);
      state.failed++;
      if (state.failures.length < 200) state.failures.push(row.tmdb_title || row.title);
    }
    state.done++;
  }

  for (const show of shows) {
    await attempt('shows', 'shows', show, (row) => {
      if (refresh) return { id: row.tmdb_id };
      const { primary, scoreAgainst, years } = showHints(row);
      return findMatch('tv', primary, scoreAgainst, years);
    }, (id, tmdbId) => enrichShow(id, tmdbId));
  }
  for (const movie of movies) {
    await attempt('movies', 'movies', movie,
      (row) => (refresh ? { id: row.tmdb_id } : findMatch('movie', [row.title], [row.title], [row.year])),
      enrichMovie);
  }

  report(null);
  setSetting(refresh ? 'tmdb.lastRefresh' : 'tmdb.lastEnrich', new Date().toISOString());
  return { ...state };
}

// ---------------------------------------------------------------- background job

// Enriching ~180 titles takes a few minutes, far longer than a request should
// hang, so it runs in the background and the UI polls for progress.
let job = { running: false };

export function enrichStatus() {
  return { ...job, configured: hasApiKey() };
}

export function startEnrich({ retryFailed = false, refresh = false } = {}) {
  if (!hasApiKey()) return { running: false, error: 'Add a TMDB API key first.', configured: false };
  if (job.running) return enrichStatus();

  if (retryFailed && !refresh) {
    db.exec("UPDATE shows SET tmdb_status='unmatched' WHERE tmdb_status='failed'");
    db.exec("UPDATE movies SET tmdb_status='unmatched' WHERE tmdb_status='failed'");
  }

  job = {
    running: true, mode: refresh ? 'refresh' : 'match',
    done: 0, total: 0, shows: 0, movies: 0, failed: 0, failures: [],
    current: null, error: null, startedAt: new Date().toISOString(), finishedAt: null,
  };

  enrichAll({ refresh, onProgress: (p) => Object.assign(job, p) })
    .then((result) => Object.assign(job, result, {
      running: false, current: null, finishedAt: new Date().toISOString(),
    }))
    .catch((err) => Object.assign(job, {
      running: false, current: null, error: String(err?.message || err), finishedAt: new Date().toISOString(),
    }));

  return enrichStatus();
}

let refreshTimer = null;

/**
 * Keep airing shows current without anyone pressing a button: a minute after
 * start, then every six hours. Each run only touches titles older than the
 * refresh windows above, so most runs finish almost immediately.
 */
export function scheduleMetadataRefresh({ initialDelayMs = 60_000, intervalMs = 6 * 3_600_000 } = {}) {
  if (refreshTimer) return;
  const tick = () => {
    if (hasApiKey() && !job.running) startEnrich({ refresh: true });
  };
  setTimeout(tick, initialDelayMs).unref?.();
  refreshTimer = setInterval(tick, intervalMs);
  refreshTimer.unref?.();
}
