// Two-way watch sync with Trakt.
//
// The user registers a free Trakt API app (trakt.tv/oauth/applications, with
// the redirect URI urn:ietf:wg:oauth:2.0:oob) and pastes its Client ID and
// Secret. Sign-in uses Trakt's device flow: Shelf shows a short code, the
// user enters it on trakt.tv, and only tokens are stored. Titles are matched
// by TMDB id, so only matched shows and films take part. Shows that use a
// custom episode ordering are skipped: their numbers differ from Trakt's.
import { db, getSetting, setSetting } from '../db.js';
import { getSecret, setSecret } from '../secrets.js';
import { setEpisodeWatched, setMovieWatched } from '../watch.js';

const API = 'https://api.trakt.tv';
const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

const cfg = () => ({
  clientId: getSetting('trakt.clientId') || '',
  clientSecret: getSecret('trakt.clientSecret') || '',
  token: getSecret('trakt.accessToken') || '',
  refresh: getSecret('trakt.refreshToken') || '',
  expiresAt: Number(getSetting('trakt.expiresAt') || 0),
});

class TraktError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function traktStatus() {
  const c = cfg();
  return {
    configured: Boolean(c.clientId && c.clientSecret),
    connected: Boolean(c.token),
    username: getSetting('trakt.username') || null,
    last_sync: getSetting('trakt.lastSync') || null,
    last_result: JSON.parse(getSetting('trakt.lastResult', 'null') || 'null'),
    device: device ? { user_code: device.user_code, verification_url: device.verification_url, expires_at: device.expires_at } : null,
  };
}

export function setTraktApp({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(id) || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new TraktError('Paste the Client ID and Client Secret from your Trakt API app (64 characters each)');
  }
  setSetting('trakt.clientId', id);
  setSecret('trakt.clientSecret', secret);
  return traktStatus();
}

export function disconnectTrakt() {
  for (const k of ['trakt.accessToken', 'trakt.refreshToken']) setSecret(k, '');
  for (const k of ['trakt.expiresAt', 'trakt.username']) setSetting(k, '');
  device = null;
  return traktStatus();
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const c = cfg();
  if (!c.clientId) throw new TraktError('Add your Trakt API app first');
  if (auth) await ensureFresh();
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': c.clientId,
    'User-Agent': 'Shelf/0.1.0',
  };
  if (auth) headers.Authorization = `Bearer ${getSecret('trakt.accessToken')}`;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TraktError(`Could not reach Trakt (${err.cause?.code || err.name})`, 502);
  }
  if (res.status === 401 && auth) {
    disconnectTrakt();
    throw new TraktError('Trakt signed Shelf out. Connect again.', 401);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

async function ensureFresh() {
  const c = cfg();
  if (!c.token) throw new TraktError('Connect your Trakt account first', 401);
  if (!c.expiresAt || Date.now() < c.expiresAt - 24 * 3600_000) return;
  const res = await fetch(`${API}/oauth/token`, {
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: c.refresh, client_id: c.clientId, client_secret: c.clientSecret,
      redirect_uri: REDIRECT, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    disconnectTrakt();
    throw new TraktError('Your Trakt sign-in expired. Connect again.', 401);
  }
  saveTokens(await res.json());
}

function saveTokens(t) {
  setSecret('trakt.accessToken', t.access_token);
  setSecret('trakt.refreshToken', t.refresh_token);
  setSetting('trakt.expiresAt', String((t.created_at * 1000 || Date.now()) + t.expires_in * 1000));
}

// ---------------------------------------------------------------- device sign-in

let device = null;

export async function startDeviceLogin() {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) throw new TraktError('Add your Trakt API app first');
  const { status, data } = await call('/oauth/device/code', { method: 'POST', body: { client_id: c.clientId }, auth: false });
  if (status !== 200) throw new TraktError(`Trakt refused the sign-in request (${status}). Check the Client ID.`);
  device = { ...data, expires_at: Date.now() + data.expires_in * 1000 };
  pollDevice();
  return traktStatus();
}

function pollDevice() {
  const d = device;
  if (!d) return;
  setTimeout(async () => {
    if (device !== d) return;
    if (Date.now() > d.expires_at) {
      device = null;
      return;
    }
    const c = cfg();
    try {
      const { status, data } = await call('/oauth/device/token', {
        method: 'POST', auth: false,
        body: { code: d.device_code, client_id: c.clientId, client_secret: c.clientSecret },
      });
      if (status === 200) {
        saveTokens(data);
        device = null;
        const me = await call('/users/settings').catch(() => null);
        if (me?.data?.user?.username) setSetting('trakt.username', me.data.user.username);
        return;
      }
      if ([404, 409, 410, 418].includes(status)) {
        device = null;
        return;
      }
      if (status === 429) d.interval += 1;
    } catch {
      // Network hiccup: keep polling until the code expires.
    }
    pollDevice();
  }, (d.interval || 5) * 1000);
}

// ---------------------------------------------------------------- sync

/** Pull Trakt's watched items into Shelf. Pure mapping, exported for tests. */
export function mapPull(watchedShows, watchedMovies) {
  const showsByTmdb = new Map(
    db.prepare('SELECT id, tmdb_id, episode_group_id FROM shows WHERE tmdb_id IS NOT NULL').all().map((s) => [s.tmdb_id, s])
  );
  const moviesByTmdb = new Map(
    db.prepare('SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL').all().map((m) => [m.tmdb_id, m.id])
  );
  const ep = db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?');
  const out = { episodes: [], movies: [], skippedOrdering: [] };

  for (const w of watchedShows || []) {
    const show = showsByTmdb.get(w.show?.ids?.tmdb);
    if (!show) continue;
    if (show.episode_group_id) {
      out.skippedOrdering.push(w.show.title);
      continue;
    }
    for (const season of w.seasons || []) {
      for (const e of season.episodes || []) {
        const row = ep.get(show.id, season.number, e.number);
        if (row) out.episodes.push({ episodeId: row.id, at: e.last_watched_at || w.last_watched_at });
      }
    }
  }
  for (const w of watchedMovies || []) {
    const id = moviesByTmdb.get(w.movie?.ids?.tmdb);
    if (id) out.movies.push({ movieId: id, at: w.last_watched_at });
  }
  return out;
}

/** Local watches since the last push, in Trakt's /sync/history shape. */
export function mapPush(since) {
  const rows = db.prepare(`
    SELECT h.kind, h.watched_at, e.season_number, e.episode_number,
           s.tmdb_id AS show_tmdb, s.episode_group_id, m.tmdb_id AS movie_tmdb
    FROM watch_history h
    LEFT JOIN episodes e ON e.id = h.episode_id
    LEFT JOIN shows s ON s.id = h.show_id
    LEFT JOIN movies m ON m.id = h.movie_id
    WHERE h.watched_at > ?
    ORDER BY h.watched_at
  `).all(since || '1970-01-01');

  const movies = [];
  const shows = new Map();
  for (const r of rows) {
    const at = `${r.watched_at.replace(' ', 'T')}.000Z`;
    if (r.kind === 'movie' && r.movie_tmdb) {
      movies.push({ ids: { tmdb: r.movie_tmdb }, watched_at: at });
    } else if (r.kind === 'episode' && r.show_tmdb && !r.episode_group_id) {
      if (!shows.has(r.show_tmdb)) shows.set(r.show_tmdb, { ids: { tmdb: r.show_tmdb }, seasons: new Map() });
      const seasons = shows.get(r.show_tmdb).seasons;
      if (!seasons.has(r.season_number)) seasons.set(r.season_number, []);
      seasons.get(r.season_number).push({ number: r.episode_number, watched_at: at });
    }
  }
  return {
    movies,
    shows: [...shows.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, episodes]) => ({ number, episodes })),
    })),
    count: rows.length,
    last: rows.length ? rows[rows.length - 1].watched_at : since,
  };
}

let syncing = false;
let syncTimer = null;

/** Sync every six hours while connected. */
export function scheduleTraktSync() {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (getSecret('trakt.accessToken') && getSetting('trakt.autoSync', '1') === '1') syncTrakt().catch(() => {});
  }, 6 * 60 * 60_000);
  syncTimer.unref?.();
}

export async function syncTrakt() {
  if (syncing) throw new TraktError('A sync is already running', 409);
  syncing = true;
  try {
    const [shows, movies] = await Promise.all([call('/sync/watched/shows'), call('/sync/watched/movies')]);
    if (shows.status !== 200 || movies.status !== 200) throw new TraktError(`Trakt returned ${shows.status}/${movies.status}`, 502);

    // Push first, so what was watched here is on Trakt before we read back.
    const push = mapPush(getSetting('trakt.lastPush'));
    let pushed = { movies: 0, episodes: 0 };
    if (push.movies.length || push.shows.length) {
      const r = await call('/sync/history', { method: 'POST', body: { movies: push.movies, shows: push.shows } });
      if (r.status !== 201) throw new TraktError(`Trakt did not accept the history (${r.status})`, 502);
      pushed = r.data?.added || pushed;
    }
    if (push.last) setSetting('trakt.lastPush', push.last);

    const pull = mapPull(shows.data, movies.data);
    let pulled = 0;
    for (const e of pull.episodes) if (setEpisodeWatched(e.episodeId, true, { at: e.at, ifUnwatched: true })?.changed) pulled++;
    for (const m of pull.movies) if (setMovieWatched(m.movieId, true, { at: m.at, ifUnwatched: true })?.changed) pulled++;
    // Our own pulls are now in watch_history; don't send them back next time.
    setSetting('trakt.lastPush', new Date().toISOString().replace('T', ' ').slice(0, 19));

    const result = {
      at: new Date().toISOString(),
      pulled,
      pushed: (pushed.movies || 0) + (pushed.episodes || 0),
      skipped_orderings: [...new Set(pull.skippedOrdering)],
    };
    setSetting('trakt.lastSync', result.at);
    setSetting('trakt.lastResult', JSON.stringify(result));
    return result;
  } finally {
    syncing = false;
  }
}
