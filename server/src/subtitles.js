// Subtitles: what is already next to a video, and search/download from
// OpenSubtitles.com with the user's own free API key.
//
// Downloads are saved next to the video as "<video name>.<lang>.srt", which
// every common player picks up automatically. An existing file is never
// overwritten.
import { open, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { getSecret, setSecret } from './secrets.js';
import { isSubtitleFile } from './scanner/parse.js';
import { findFile } from './player.js';

const API = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Shelf v0.1.0';

// ---------------------------------------------------------------- local files

/** Subtitle files named after a video: "Film.srt", "Film.en.srt", "Film.en.forced.srt". */
export function localSubtitles(videoPath, names = null) {
  const base = basename(videoPath, extname(videoPath));
  const lower = base.toLowerCase();
  let entries = names;
  if (!entries) {
    try {
      entries = readdirSync(dirname(videoPath));
    } catch {
      return [];
    }
  }
  return entries
    .filter((n) => isSubtitleFile(n) && n.toLowerCase().startsWith(lower))
    .map((n) => {
      const tags = n.slice(base.length, -extname(n).length).split('.').filter(Boolean);
      const lang = tags.find((t) => /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(t)) || null;
      return { name: n, lang: lang ? lang.toLowerCase() : null, format: extname(n).slice(1).toLowerCase() };
    })
    .filter((s) => s.name.length > base.length);
}

/** Subtitle counts for many videos, reading each folder once. */
export function subtitleIndex(paths) {
  const byDir = new Map();
  const out = new Map();
  for (const p of paths) {
    if (!p) continue;
    const dir = dirname(p);
    if (!byDir.has(dir)) {
      try {
        byDir.set(dir, readdirSync(dir).filter(isSubtitleFile));
      } catch {
        byDir.set(dir, []);
      }
    }
    const subs = byDir.get(dir);
    out.set(p, subs.length ? localSubtitles(p, subs) : []);
  }
  return out;
}

// ---------------------------------------------------------------- settings

export function subtitleSettings() {
  return {
    configured: Boolean(getSecret('opensubtitles.apiKey')),
    signed_in: Boolean(getSecret('opensubtitles.token')),
    username: getSetting('opensubtitles.username') || null,
    languages: getSetting('subtitles.languages') || 'en',
    hide_machine: getSetting('subtitles.hideMachine', '1') === '1',
  };
}

export function setSubtitlePrefs({ languages, hideMachine }) {
  if (languages !== undefined) {
    const list = String(languages).toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!list.length || !list.every((l) => /^[a-z]{2}(?:-[a-z]{2})?$/.test(l))) {
      throw new Error('Use language codes separated by commas, like "en, si, ta"');
    }
    setSetting('subtitles.languages', [...new Set(list)].join(','));
  }
  if (hideMachine !== undefined) setSetting('subtitles.hideMachine', hideMachine ? '1' : '0');
  return subtitleSettings();
}

class SubtitleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function os(path, { method = 'GET', params = {}, body, key = getSecret('opensubtitles.apiKey'), auth = true } = {}) {
  if (!key) throw new SubtitleError('Add an OpenSubtitles API key in Settings first.', 400);
  const url = new URL(API + path);
  // OpenSubtitles asks for sorted, lowercase parameters (it redirects otherwise).
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v != null && v !== '') url.searchParams.set(k, String(v).toLowerCase());
  }
  const headers = { 'Api-Key': key, 'User-Agent': USER_AGENT, Accept: 'application/json' };
  const token = auth ? getSecret('opensubtitles.token') : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
      });
      break;
    } catch (err) {
      // A dropped connection says nothing about the request; try again. Not
      // for downloads, where a retry could spend a second daily download.
      if (attempt < 2 && path !== '/download') {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw new SubtitleError(`Could not reach OpenSubtitles (${err.cause?.code || err.name || err.message})`, 502);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    // Expired sign-in: forget it so the next call can still work anonymously.
    setSecret('opensubtitles.token', '');
    throw new SubtitleError('Your OpenSubtitles sign-in expired. Sign in again in Settings.', 401);
  }
  if (path === '/login' && (res.status === 400 || res.status === 401)) {
    throw new SubtitleError('OpenSubtitles did not accept that username and password', 401);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SubtitleError(
      `OpenSubtitles did not accept the API key${data.message ? ` (${data.message})` : ''}`,
      401
    );
  }
  if (res.status === 406 || res.status === 429) {
    throw new SubtitleError(data.message || 'Download limit reached for today', 429);
  }
  if (!res.ok) throw new SubtitleError(data.message || data.errors?.join(', ') || `OpenSubtitles error ${res.status}`, 502);
  return data;
}

export async function setApiKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) {
    setSecret('opensubtitles.apiKey', '');
    setSecret('opensubtitles.token', '');
    return subtitleSettings();
  }
  // A cheap call that, unlike /infos/*, actually checks the key.
  await os('/discover/popular', { key: trimmed, auth: false, params: { languages: 'en', type: 'movie' } });
  setSecret('opensubtitles.apiKey', trimmed);
  return subtitleSettings();
}

/**
 * Signing in raises the daily download limit (5 anonymous, 20+ with a free
 * account). Only the session token is stored, never the password.
 */
export async function signIn(username, password) {
  if (!username || !password) throw new SubtitleError('Enter your OpenSubtitles username and password');
  setSecret('opensubtitles.token', '');
  const data = await os('/login', { method: 'POST', body: { username, password }, auth: false });
  setSecret('opensubtitles.token', data.token);
  setSetting('opensubtitles.username', data.user?.username || username);
  return { ...subtitleSettings(), allowed_downloads: data.user?.allowed_downloads ?? null };
}

export function signOut() {
  setSecret('opensubtitles.token', '');
  setSetting('opensubtitles.username', '');
  return subtitleSettings();
}

// ---------------------------------------------------------------- search

/**
 * OpenSubtitles' file hash: size plus the 64-bit little-endian sums of the
 * first and last 64 KB. It identifies the exact release, so a hash match is
 * almost always perfectly in sync.
 */
export async function movieHash(path) {
  const CHUNK = 65536;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size < CHUNK) return null;
    let hash = BigInt(size);
    for (const position of [0, size - CHUNK]) {
      const buf = Buffer.alloc(CHUNK);
      await fh.read(buf, 0, CHUNK, position);
      for (let i = 0; i < CHUNK; i += 8) hash += buf.readBigUInt64LE(i);
    }
    return (hash & 0xffffffffffffffffn).toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

function describe(file) {
  const row = db.prepare(`
    SELECT f.id, f.path, f.episode_id, f.movie_id,
           e.season_number, e.episode_number, e.title AS episode_title,
           s.title AS show_title, s.tmdb_id AS show_tmdb_id, s.episode_group_id,
           m.title AS movie_title, m.tmdb_title, m.year AS movie_year, m.tmdb_id AS movie_tmdb_id
    FROM files f
    LEFT JOIN episodes e ON e.id = f.episode_id
    LEFT JOIN shows s ON s.id = e.show_id
    LEFT JOIN movies m ON m.id = f.movie_id
    WHERE f.id = ?
  `).get(file.id);
  return row;
}

function shape(item, hashMatched) {
  const a = item.attributes || {};
  const f = a.files?.[0];
  if (!f) return null;
  return {
    file_id: f.file_id,
    file_name: f.file_name,
    language: a.language,
    release: a.release || f.file_name,
    downloads: a.download_count ?? 0,
    rating: a.ratings ?? null,
    hearing_impaired: Boolean(a.hearing_impaired),
    machine: Boolean(a.machine_translated || a.ai_translated),
    fps: a.fps || null,
    uploaded: a.upload_date || null,
    uploader: a.uploader?.name || null,
    trusted: Boolean(a.from_trusted),
    hash_match: Boolean(hashMatched || a.moviehash_match),
  };
}

export async function searchSubtitles(target, { languages } = {}) {
  const file = findFile(target);
  const info = describe(file);
  const prefs = subtitleSettings();
  const langs = (languages || prefs.languages).toLowerCase();

  const hash = await movieHash(file.path).catch(() => null);
  const byHash = hash ? os('/subtitles', { params: { moviehash: hash, languages: langs } }) : null;

  let meta;
  if (info.episode_id) {
    // A custom episode ordering (Money Heist "Parts") has different numbers
    // from OpenSubtitles', so search by name there instead of TMDB id.
    const params = info.show_tmdb_id && !info.episode_group_id
      ? { parent_tmdb_id: info.show_tmdb_id }
      : { query: info.show_title };
    meta = os('/subtitles', {
      params: { ...params, season_number: info.season_number, episode_number: info.episode_number, languages: langs, type: 'episode' },
    });
  } else {
    const params = info.movie_tmdb_id
      ? { tmdb_id: info.movie_tmdb_id }
      : { query: info.tmdb_title || info.movie_title, year: info.movie_year };
    meta = os('/subtitles', { params: { ...params, languages: langs, type: 'movie' } });
  }

  const [hashRes, metaRes] = await Promise.allSettled([byHash, meta]);
  if (metaRes.status === 'rejected' && (!byHash || hashRes.status === 'rejected')) throw metaRes.reason;

  const seen = new Set();
  const results = [];
  const add = (items, hashMatched) => {
    for (const item of items || []) {
      const s = shape(item, hashMatched);
      if (!s || seen.has(s.file_id)) continue;
      seen.add(s.file_id);
      results.push(s);
    }
  };
  if (hashRes.status === 'fulfilled' && hashRes.value) add(hashRes.value.data, true);
  if (metaRes.status === 'fulfilled') add(metaRes.value.data, false);

  const visible = prefs.hide_machine ? results.filter((r) => !r.machine) : results;
  visible.sort((a, b) =>
    Number(b.hash_match) - Number(a.hash_match) ||
    Number(b.trusted) - Number(a.trusted) ||
    b.downloads - a.downloads
  );

  return {
    file_id: file.id,
    video: basename(file.path),
    languages: langs,
    hash_checked: Boolean(hash),
    hidden_machine: results.length - visible.length,
    existing: localSubtitles(file.path),
    results: visible.slice(0, 60),
  };
}

function freeName(dir, base, ext) {
  let name = `${base}${ext}`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}.${i}${ext}`;
  return name;
}

export async function downloadSubtitle(target, { subtitleFileId, language }) {
  const file = findFile(target);
  const id = Number(subtitleFileId);
  if (!Number.isInteger(id) || id <= 0) throw new SubtitleError('Unknown subtitle');

  const data = await os('/download', { method: 'POST', body: { file_id: id } });
  if (!data.link) throw new SubtitleError(data.message || 'OpenSubtitles did not return a download link', 502);

  // The link is a short-lived file URL on OpenSubtitles' own CDN.
  const link = new URL(data.link);
  if (link.protocol !== 'https:' || !/(^|\.)opensubtitles\.(com|org)$/i.test(link.hostname)) {
    throw new SubtitleError('Unexpected download location', 502);
  }
  const res = await fetch(link, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new SubtitleError(`Download failed (${res.status})`, 502);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new SubtitleError('The subtitle file looks wrong', 502);

  const ext = /^\.(srt|ass|ssa|vtt|sub)$/i.test(extname(data.file_name || '')) ? extname(data.file_name).toLowerCase() : '.srt';
  const lang = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(language || '') ? `.${language.toLowerCase()}` : '';
  const dir = dirname(file.path);
  const name = freeName(dir, basename(file.path, extname(file.path)) + lang, ext);
  await writeFile(join(dir, name), bytes, { flag: 'wx' });

  return {
    saved: name,
    remaining: data.remaining ?? null,
    reset_time: data.reset_time || null,
    existing: localSubtitles(file.path, await readdir(dir)),
  };
}
