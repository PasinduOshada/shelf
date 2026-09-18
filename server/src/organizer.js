// File organiser.
//
// Shelf indexes read-only. This module is the ONE place that writes to the
// user's disk, and only when they apply a plan they have previewed.
//
// The user picks any source folder (a download folder, a whole drive) and a
// destination. Files are identified from their names alone -- no AI, no
// network -- and, when a TMDB key is set, official titles and episode names
// are looked up. The result is a tidy tree:
//
//   <dest>/TV Series/Show Name (2022)/Season 01/Show Name - S01E02 - Title - 1080p.mkv
//   <dest>/Movies/Film Name (2024)/Film Name (2024) - 2160p.mkv
//
// Rules it never breaks:
//   - never overwrites a file (conflicts are shown and skipped)
//   - a "move" deletes the source only after a verified copy (cross-drive)
//   - every operation is logged before it happens, so a batch can be undone
import { readdirSync, existsSync, statSync, constants as fsConstants } from 'node:fs';
import { rename, copyFile, stat, unlink, mkdir, readdir, rmdir } from 'node:fs/promises';
import { join, dirname, basename, extname, isAbsolute, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, transaction, getSetting } from './db.js';
import { DATA_DIR } from './paths.js';
import {
  parseFilename, parseFolderName, isVideoFile, isSubtitleFile,
  isJunkName, isClipFile, SKIP_DIR, SAMPLE_DIR,
} from './scanner/parse.js';
import { hasApiKey, lookupTitle, seasonEpisodeNames } from './tmdb.js';
import { probeAvailable, probeFile } from './mediainfo.js';

// ---------------------------------------------------------------- naming

const SEASON_DIR = /^(?:season|series|s)[\s._-]*(\d{1,3})$/i;
const SPECIALS_DIR = /^(?:specials?|extras?)$/i;

export const DEFAULT_OPTIONS = {
  include: { tv: true, movies: true },
  mode: 'move', // 'move' | 'copy'
  rename: true,
  useTmdb: true,
  tv: { showYear: true, seasonPad: true, episodeTitle: true, quality: true },
  movie: { folder: true, year: true, quality: true },
};

/** Merge user options over the defaults, keeping only known keys and types. */
export function normalizeOptions(input = {}) {
  const o = structuredClone(DEFAULT_OPTIONS);
  const pick = (target, source) => {
    for (const k of Object.keys(target)) {
      if (source?.[k] === undefined) continue;
      if (typeof target[k] === 'object') pick(target[k], source[k]);
      else if (typeof target[k] === typeof source[k]) target[k] = source[k];
    }
  };
  pick(o, input);
  if (o.mode !== 'copy') o.mode = 'move';
  return o;
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);

/** "the last of us" -> "The Last of Us". Leaves mixed-case titles alone. */
export function smartCase(title) {
  const s = String(title || '').trim();
  if (!s || (s !== s.toLowerCase() && s !== s.toUpperCase())) return s;
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Make a title safe as a file or folder name on every system. "Title: Part"
 * becomes "Title - Part", censored words ("F**k") are spelled out, and the
 * characters Windows forbids are dropped, as are trailing dots and spaces.
 */
export function safeName(name) {
  return String(name)
    .replace(/\bf\*+k/gi, (m) => `${m[0]}uck`)
    .replace(/\bf\*+ing/gi, (m) => `${m[0]}ucking`)
    .replace(/\bsh\*+t/gi, (m) => `${m[0]}hit`)
    .replace(/\s*:\s+/g, ' - ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(?: - )+/g, ' - ')
    .replace(/[. ]+$/, '')
    .trim();
}

// TMDB's stand-in names add nothing to a file name.
const PLACEHOLDER_EPISODE = /^(?:episode|ep\.?|chapter|part)\s*(?:\d+|[ivxlc]+)$/i;

const pad2 = (n) => String(n).padStart(2, '0');

export function seasonFolderName(season, pad = true) {
  if (season === 0) return 'Specials';
  return `Season ${pad ? pad2(season) : season}`;
}

export function episodeFileBase({ title, season, episode, episodeTitle, quality }, tv) {
  const parts = [title, `S${pad2(season)}E${pad2(episode)}`];
  if (tv.episodeTitle && episodeTitle && !PLACEHOLDER_EPISODE.test(episodeTitle.trim())) parts.push(episodeTitle);
  if (tv.quality && quality) parts.push(quality);
  return safeName(parts.join(' - '));
}

export function movieBase({ title, year }, movie) {
  return safeName(movie.year && year ? `${title} (${year})` : title);
}

export function movieFileBase(item, movie) {
  const parts = [movieBase(item, movie)];
  // Keep "Part 1" unless the official title already says it ("Deathly Hallows Part 1").
  if (item.part && !key(item.title).includes(`part${item.part}`)) parts.push(`Part ${item.part}`);
  if (movie.quality && item.quality) parts.push(item.quality);
  return safeName(parts.join(' - '));
}

export function showFolderName({ title, year }, tv) {
  return safeName(tv.showYear && year ? `${title} (${year})` : title);
}

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function dirsIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Existing folder for a title inside `root`, whatever its spelling
 * ("House Of The Dragons(2022)", "house.of.the.dragons"), else null.
 */
function existingTitleDir(root, title) {
  const want = key(title);
  for (const name of dirsIn(root)) {
    if (key(parseFolderName(name).title) === want) return join(root, name);
  }
  return null;
}

/** Existing folder for a season ("Season 01", "S2", "Specials"), else a new one. */
function seasonDir(showDir, season, pad) {
  for (const name of dirsIn(showDir)) {
    if (season === 0 && SPECIALS_DIR.test(name)) return join(showDir, name);
    const m = name.match(SEASON_DIR);
    if (m && Number(m[1]) === season) return join(showDir, name);
  }
  return join(showDir, seasonFolderName(season, pad));
}

// ---------------------------------------------------------------- identification

const JUNK = { test: isJunkName };
const EPISODE_WORD = /(?:^|[\s._-])(?:episode|ep)[\s._-]*(\d{1,3})(?!\d)/i;
const LEADING_NUMBER = /^(\d{1,3})(?=[\s._-]|$)/;
// Release tags the parser can hand back as an "episode title" ("1080p WEB").
const RELEASE_WORD = /(?<![a-z0-9])(?:\d{3,4}p|4k|web(?:rip|-?dl)?|hdtv|bluray|brrip|x26[45]|h26[45]|hevc|aac|ddp?\d?|amzn|nf|repack|proper)(?![a-z0-9])/i;

/**
 * Work out what one video is from its name and the folders around it.
 * `ancestors` are folder names from the file's parent upward, stopping below
 * the source root (the root's own name says nothing about the file).
 */
export function identify(filename, ancestors = []) {
  const isSeason = (a) => SEASON_DIR.test(a) || SPECIALS_DIR.test(a);
  const seasonFolder = isSeason(ancestors[0] || '') ? ancestors[0] : null;
  const folderSeason = !seasonFolder
    ? null
    : SPECIALS_DIR.test(seasonFolder) ? 0 : Number(seasonFolder.match(SEASON_DIR)[1]);
  // The nearest folder that could be a title. Grouping folders ("Movies",
  // "Documentaries") never name anything.
  const showFolder = ancestors.find((a) => !isSeason(a)) || null;
  const usable = showFolder && !isGenericFolder(showFolder) ? showFolder : null;
  return identifyIn(filename, seasonFolder, folderSeason, usable);
}

const GENERIC_FOLDERS = new Set([
  'movies', 'movie', 'films', 'film', 'tv', 'tvseries', 'tvshows', 'series', 'shows', 'videos', 'video',
  'downloads', 'download', 'completed', 'complete', 'media', 'entertainment', 'library', 'plex', 'jellyfin',
  'documentaries', 'documentary', 'docs', 'anime', 'cartoons', 'kids', 'newfolder', 'misc', 'other', 'others',
  'torrents', 'telegram', 'whatsapp', 'whatsappvideo', 'desktop', 'temp', 'tmp', 'unsorted', 'toorganize',
  'english', 'hindi', 'tamil', 'korean', 'malayalam', 'telugu', 'sinhala', 'subs', 'subtitles', 'extras', 'featurettes',
]);

function isGenericFolder(name) {
  return GENERIC_FOLDERS.has(name.toLowerCase().replace(/[^a-z]/g, ''));
}

function identifyIn(filename, seasonFolder, folderSeason, showFolder) {
  const folder = showFolder ? folderInfo(showFolder) : null;
  const context = { folderTitle: folder?.title || null, inSeasonFolder: Boolean(seasonFolder && showFolder) };
  const result = identifyName(filename, folder, folderSeason);
  return result.kind === 'unknown' ? result : { ...result, ...context };
}

/** "Severance.S01.1080p-GROUP" -> { title: "Severance" }, "Vikings(2013-2020)" -> 2013. */
function folderInfo(name) {
  const f = parseFolderName(name);
  const cleaned = parseFilename(`${f.title}.mkv`).title || f.title;
  // Only take the cleaned form when it actually removed release tags; it also
  // drops "&", which "Oggy & The Cockroaches" needs.
  return { title: stripAlias(key(cleaned) === key(f.title) ? f.title : cleaned), year: f.year };
}

/** "A Shop for Killers A K A Sarinjaui Syopingmol" -> "A Shop for Killers". */
function stripAlias(title) {
  return title ? title.replace(/\s+a\s?k\s?a\s+.*$/i, '').trim() : title;
}

function identifyName(filename, folder, folderSeason) {
  const p = parseFilename(filename, {
    folderTitle: folder?.title,
    defaultSeason: folderSeason ?? undefined,
  });
  const base = basename(filename, extname(filename));

  // "Episode 5.mkv" or "05.mkv" inside a season folder: an episode of that show.
  if (!p.isEpisode && folderSeason !== null && folder?.title) {
    const m = base.match(EPISODE_WORD) || base.match(LEADING_NUMBER);
    if (m) {
      return {
        kind: 'tv', title: smartCase(folder.title), year: folder.year, season: folderSeason,
        episode: Number(m[1]), episodeTitle: null, quality: p.quality, confidence: 'medium',
        hint: 'folder',
      };
    }
  }

  if (p.isEpisode) {
    let title = stripAlias(p.title);
    let hint = 'filename';
    // A marker-first name ("S01E02.mkv") has no title of its own.
    if (!title || key(title).length < 2 || JUNK.test(title)) {
      title = folder?.title || null;
      hint = 'folder';
    }
    if (!title) return { kind: 'unknown', reason: 'Episode number found, but no show name' };
    let episodeTitle = p.episodeTitle && !RELEASE_WORD.test(p.episodeTitle) && /[\p{L}\p{N}]{2,}/u.test(p.episodeTitle)
      ? p.episodeTitle
      : null;
    // "Oggy and the Cockroaches - Bitter Chocolate (s01e01)": the episode
    // name comes before the marker, after the show's name.
    const split = !episodeTitle && hint === 'filename' && base.match(SHOW_DASH_EPISODE);
    if (split) {
      const show = parseFilename(`${split[1]}.mkv`).title;
      if (show && key(show).length >= 2) {
        title = stripAlias(show);
        episodeTitle = split[2].trim();
      }
    }
    return {
      kind: 'tv', title: smartCase(title), year: p.year || folder?.year || null,
      season: p.season, episode: p.episode,
      episodeTitle: episodeTitle ? smartCase(episodeTitle) : null,
      quality: p.quality, confidence: hint === 'filename' ? 'high' : 'medium', hint,
    };
  }

  let title = stripAlias(p.title);
  let year = p.year;
  let hint = 'filename';
  if (!title || JUNK.test(base) || JUNK.test(title) || /^\d+$/.test(key(title))) title = null;
  // A film folder ("Dune Part Two (2024)") is often better named than its file.
  if (folder?.title && !JUNK.test(folder.title) && (!title || (!year && folder.year))) {
    title = folder.title;
    year = year || folder.year;
    hint = 'folder';
  }
  if (!title || key(title).length < 2) {
    return { kind: 'unknown', reason: 'No recognisable title in the name' };
  }
  const part = base.match(PART_RE);
  return {
    kind: 'movie', title: smartCase(title), year: year || null, quality: p.quality,
    part: part ? Number(part[2]) : null,
    confidence: year ? 'high' : 'medium', hint,
  };
}

// "[TAG] Show Name - Episode Name (s01e01)": show, then episode, then marker.
const SHOW_DASH_EPISODE = /^(?:\s*\[[^\]]*\])*\s*(.+?)\s+-\s+(.+?)\s*[[(]?\s*s\d{1,2}\s*e\d{1,3}\s*[\])]?\s*$/i;

// "Film.Part.1", "Film.CD2", "Film Disc 1": one film split over files.
const PART_RE = /(?:^|[\s._-])(part|pt|cd|disc|disk)[\s._-]*(\d{1,2})(?![\d])/i;

// ---------------------------------------------------------------- walking

const MAX_FILES = 25000;
const MAX_DEPTH = 12;

function statOf(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// Download clients leave a marker next to a file they are still writing.
const PARTIAL_SUFFIXES = ['.part', '.partial', '.!qb', '.!ut', '.!bt', '.aria2', '.crdownload', '.download', '.tmp'];

function stillDownloading(name, siblings) {
  const lower = new Set(siblings.map((n) => n.toLowerCase()));
  const base = name.toLowerCase();
  return PARTIAL_SUFFIXES.some((sfx) => lower.has(base + sfx));
}

/** Every video under the roots, with the folder names between each and its root. */
function walk(roots, excludes) {
  const out = { videos: [], ignored: [], truncated: false };
  const dataDir = resolve(DATA_DIR).toLowerCase();

  const visit = (dir, ancestors, depth) => {
    if (depth > MAX_DEPTH || out.truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const name of files) {
      if (!isVideoFile(name)) continue;
      const path = join(dir, name);
      const st = statOf(path);
      const size = st?.size ?? null;
      if (isClipFile(name, size) || SAMPLE_DIR.test(basename(dir))) {
        out.ignored.push({ from: path, size_bytes: size, reason: 'Sample or trailer' });
        continue;
      }
      out.videos.push({
        path, dir, name, root, size_bytes: size, mtime: st?.mtimeMs ?? 0, ancestors, siblings: files,
        downloading: stillDownloading(name, files),
      });
      if (out.videos.length >= MAX_FILES) {
        out.truncated = true;
        return;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIR.test(e.name) || excludes.has(e.name.toLowerCase())) continue;
      const child = join(dir, e.name);
      if (child.toLowerCase() === dataDir) continue;
      visit(child, [e.name, ...ancestors], depth + 1);
    }
  };

  let root;
  for (root of roots) visit(root, [], 0);
  return out;
}

/** Subtitles named after a video ("Film.srt", "Film.en.srt") travel with it. */
function sidecarsFor(video) {
  const base = basename(video.name, extname(video.name));
  const lower = base.toLowerCase();
  return video.siblings
    .filter((n) => isSubtitleFile(n) && n.toLowerCase().startsWith(lower))
    .map((n) => ({ name: n, suffix: n.slice(base.length) }))
    .filter((s) => /^(?:\.[\w-]{1,12})*\.\w+$/.test(s.suffix));
}

// ---------------------------------------------------------------- planning

const norm = (p) => resolve(p).toLowerCase();

function checkDir(path, label) {
  if (!path || typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`${label} must be a full folder path`);
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!st.isDirectory()) throw new Error(`${label} is not a folder: ${path}`);
}

// Watched folders are re-previewed every few minutes; the same titles need not
// be looked up again each time.
const lookupCache = new Map();
const LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;

const libraryFile = db.prepare(`
  SELECT f.path, f.quality, f.episode_id, f.movie_id,
         e.season_number, e.episode_number, e.title AS episode_title,
         s.id AS show_id, s.title AS show_title, s.year AS show_year, s.first_air_date, s.tmdb_id AS show_tmdb,
         m.title AS movie_title, m.tmdb_title, m.year AS movie_year, m.release_date, m.tmdb_id AS movie_tmdb
  FROM files f
  LEFT JOIN episodes e ON e.id = f.episode_id
  LEFT JOIN shows s ON s.id = e.show_id
  LEFT JOIN movies m ON m.id = f.movie_id
  WHERE f.path = ? AND f.is_missing = 0
`);

const yearOf = (date, fallback) => (date ? Number(String(date).slice(0, 4)) : fallback) || null;

/**
 * The library's identity for an indexed file, when it is trustworthy: matched
 * on TMDB, renamed by hand, or given an episode number by hand. Otherwise null,
 * and the file name decides.
 */
export function libraryIdentity(path) {
  const r = libraryFile.get(path);
  if (!r) return null;
  if (r.episode_id && r.show_id && r.show_tmdb) {
    return {
      kind: 'tv', title: r.show_title, year: yearOf(r.first_air_date, r.show_year),
      season: r.season_number, episode: r.episode_number, episodeTitle: r.episode_title || null,
      quality: r.quality, confidence: 'high', hint: 'library', show_id: r.show_id, tmdb_id: r.show_tmdb,
    };
  }
  if (r.movie_id && (r.movie_tmdb || r.tmdb_title)) {
    return {
      kind: 'movie', title: r.tmdb_title || r.movie_title, year: yearOf(r.release_date, r.movie_year),
      quality: r.quality, part: Number(basename(path).match(PART_RE)?.[2]) || null,
      confidence: r.movie_tmdb ? 'high' : 'medium', hint: 'library',
      tmdb_id: r.movie_tmdb || null,
    };
  }
  return null;
}

/** `source` and/or `sources`, validated, resolved and de-duplicated. */
export function sourceList(source, sources) {
  const list = [...(Array.isArray(sources) ? sources : []), ...(source ? [source] : [])];
  if (!list.length) throw new Error('Choose a folder to organize');
  const out = [];
  for (const p of list) {
    checkDir(p, 'Source');
    const r = resolve(p);
    if (!out.some((o) => norm(o) === norm(r))) out.push(r);
  }
  return out;
}

/** A destination may not exist yet, but its parent must. */
function checkDestination(path) {
  if (!path || typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('Destination must be a full folder path');
  }
  if (existsSync(path)) checkDir(path, 'Destination');
  else checkDir(dirname(path), 'Destination');
  return resolve(path);
}

/** True when `child` is strictly inside `parent` (blocks ../ escapes). */
function isInside(child, parent) {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The folder a video "lives" in: its parent, or the show folder above a season folder. */
function homeDir(dir, source) {
  const d = SEASON_DIR.test(basename(dir)) || SPECIALS_DIR.test(basename(dir)) ? dirname(dir) : dir;
  return isInside(d, resolve(source)) ? d : null;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'with', 'for', 'at']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w));

/** Folder and file names that plainly mean the same show ("Alexander" / "Alexander The Making of a God"). */
function related(a, b) {
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return false;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  const wb = new Set(words(b));
  return words(a).some((w) => w.length > 2 && wb.has(w));
}

/**
 * A show group's name. Consistent filenames that agree with the folder give
 * the fuller, usually better-spelled title ("House of the Dragon" over the
 * folder's "House Of The Dragons"); otherwise the folder's name is used.
 */
function groupTitle(g) {
  const best = mostCommon(g.titles);
  if (!g.folderTitle) return best;
  const share = g.titles.filter((t) => t === best).length / g.titles.length;
  return share >= 0.5 && related(g.folderTitle, best) ? best : g.folderTitle;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v != null && v !== '') counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/**
 * Build a plan. Touches nothing on disk (and makes TMDB lookups only when
 * enabled and a key is set).
 */
export async function planImport({
  source, sources, tvRoot, movieRoot, options = {}, onProgress = () => {}, settleMs = 2 * 60 * 1000,
}) {
  const opts = normalizeOptions(options);
  const roots_ = sourceList(source, sources);
  if (!opts.include.tv && !opts.include.movies) throw new Error('Choose TV series, films, or both');
  const roots = {
    tv: opts.include.tv ? checkDestination(tvRoot) : null,
    movie: opts.include.movies ? checkDestination(movieRoot) : null,
  };

  onProgress({ phase: 'Reading folders', done: 0, total: 0 });
  const excludes = new Set(
    JSON.parse(getSetting('scan.excludes', '[]')).map((s) => String(s).toLowerCase())
  );
  const found = walk(roots_, excludes);

  const unidentified = [];
  const shows = new Map();
  const movies = [];
  const embeddedGuesses = [];
  const probing = probeAvailable();
  const embeddedTitle = async (v) => {
    if (!probing) return null;
    onProgress({ phase: 'Reading titles inside files', done: 0, total: 0, current: v.name });
    try {
      const info = await probeFile(v.path);
      const t = info?.title?.replace(/^[\w.-]+\.(?:com|org|net|in|to)\s*\|\s*/i, '').trim();
      return t && t.length > 1 ? t : null;
    } catch {
      return null;
    }
  };

  for (const v of found.videos) {
    // What the library already knows beats the file name: a TMDB match, a
    // title fixed by hand, or an episode number corrected by hand.
    const known = libraryIdentity(v.path);
    let id = known || identify(v.name, v.ancestors);
    if (id.kind === 'unknown') {
      // Phone and messenger copies often keep the release name inside the file.
      const embedded = await embeddedTitle(v);
      const guess = embedded ? identify(`${embedded}${extname(v.name)}`, v.ancestors) : null;
      if (guess && guess.kind !== 'unknown') {
        id = { ...guess, hint: 'embedded', embedded_title: embedded, confidence: 'medium' };
        embeddedGuesses.push({ v, id });
        continue;
      }
      unidentified.push({
        from: v.path, size_bytes: v.size_bytes, reason: id.reason,
        embedded_title: embedded || null,
      });
      continue;
    }
    const item = {
      ...id, id: norm(v.path), from: v.path, size_bytes: v.size_bytes,
      ext: extname(v.name).toLowerCase(), video: v, home: homeDir(v.dir, v.root),
      mtime: v.mtime, downloading: v.downloading,
    };
    if (id.kind === 'tv') {
      if (!roots.tv) continue;
      // A file inside a show's folder belongs to that folder: always when there
      // is a season folder in between, otherwise when the names agree.
      const trustFolder = item.home && (known || (id.folderTitle &&
        (id.inSeasonFolder || related(id.folderTitle, id.title))));
      const k = known ? `show:${known.show_id}` : trustFolder ? `dir:${norm(item.home)}` : `title:${key(id.title)}`;
      if (!shows.has(k)) {
        shows.set(k, {
          titles: [], years: [], items: [],
          home: trustFolder ? item.home : null,
          folderTitle: trustFolder && !known ? smartCase(id.folderTitle) : null,
          known: known ? { tmdb_id: known.tmdb_id } : null,
        });
      }
      const g = shows.get(k);
      g.titles.push(id.title);
      g.years.push(id.year);
      g.items.push(item);
    } else if (roots.movie) {
      movies.push(item);
    }
  }

  // Several files carrying the same bare title ("ARCHIE") with no episode
  // numbers are most likely episodes of one series: say so instead of
  // guessing a film name for each.
  const sharedTitles = new Map();
  for (const g of embeddedGuesses) {
    const k = key(g.id.embedded_title);
    sharedTitles.set(k, (sharedTitles.get(k) || 0) + 1);
  }
  for (const { v, id } of embeddedGuesses) {
    const count = sharedTitles.get(key(id.embedded_title));
    if (id.kind === 'movie' && !id.year && count > 1) {
      unidentified.push({
        from: v.path, size_bytes: v.size_bytes, embedded_title: id.embedded_title,
        reason: `${count} files are titled "${id.embedded_title}" inside, with no episode numbers; probably one series`,
      });
      continue;
    }
    const item = {
      ...id, id: norm(v.path), from: v.path, size_bytes: v.size_bytes,
      ext: extname(v.name).toLowerCase(), video: v, home: null,
      mtime: v.mtime, downloading: v.downloading,
    };
    if (id.kind === 'tv' && roots.tv) {
      const k = `title:${key(id.title)}`;
      if (!shows.has(k)) shows.set(k, { titles: [], years: [], items: [], home: null, folderTitle: null, known: null });
      const grp = shows.get(k);
      grp.titles.push(id.title);
      grp.years.push(id.year);
      grp.items.push(item);
    } else if (id.kind === 'movie' && roots.movie) {
      movies.push(item);
    }
  }

  // ---- official names (optional) ----
  const tmdbOn = opts.useTmdb && hasApiKey();
  const movieKeys = new Set(movies.filter((m) => m.hint !== 'library').map((m) => `${key(m.title)}|${m.year || ''}`));
  const lookups = tmdbOn ? [...shows.values()].filter((g) => !g.known).length + movieKeys.size : 0;
  let looked = 0;
  const lookupErrors = [];
  const lookup = async (kind, title, year, alternatives = []) => {
    onProgress({ phase: 'Looking up official titles', done: looked, total: lookups, current: title });
    const cacheKey = JSON.stringify([kind, title, year, alternatives]);
    const cached = lookupCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.hit;
    try {
      const hit = await lookupTitle(kind, title, year, alternatives);
      lookupCache.set(cacheKey, { hit, at: Date.now() });
      return hit;
    } catch (err) {
      lookupErrors.push(String(err?.message || err));
      return null;
    } finally {
      looked++;
    }
  };

  for (const g of shows.values()) {
    g.title = groupTitle(g);
    g.year = mostCommon(g.years);
    g.source = 'filename';
    if (g.known) {
      // Already identified in the library; episode names come from there too.
      Object.assign(g, { tmdb_id: g.known.tmdb_id, source: g.known.tmdb_id ? 'library' : 'filename' });
      continue;
    }
    if (!tmdbOn) continue;
    // A misspelled folder ("Oggy & The Crokroachers") may still be found by
    // the spelling in the file names, and the other way round.
    const alternatives = [mostCommon(g.titles), g.folderTitle].filter((t) => t && t !== g.title);
    const hit = await lookup('tv', g.title, g.year, alternatives);
    if (!hit) continue;
    Object.assign(g, { title: hit.title, year: hit.year || g.year, tmdb_id: hit.tmdb_id, source: 'tmdb' });
    if (opts.rename && opts.tv.episodeTitle) {
      g.names = new Map();
      for (const s of new Set(g.items.map((i) => i.season))) {
        g.names.set(s, await seasonEpisodeNames(hit.tmdb_id, s).catch(() => new Map()));
      }
    }
  }

  const movieHits = new Map();
  for (const m of movies) {
    if (m.hint === 'library') {
      m.source = m.tmdb_id ? 'library' : 'filename';
      continue;
    }
    m.source = 'filename';
    if (!tmdbOn) continue;
    const k = `${key(m.title)}|${m.year || ''}`;
    if (!movieHits.has(k)) movieHits.set(k, await lookup('movie', m.title, m.year));
    const hit = movieHits.get(k);
    if (hit) {
      Object.assign(m, {
        title: hit.title, year: hit.year || m.year, tmdb_id: hit.tmdb_id, source: 'tmdb',
      });
    }
  }

  // ---- targets ----
  onProgress({ phase: 'Building the preview', done: 0, total: 0, current: null });
  const items = [];

  const place = (item, dir, newBase) => {
    const { video } = item;
    delete item.video;
    const keepBase = basename(video.name, extname(video.name));
    const base = opts.rename ? newBase : keepBase;
    item.to = join(dir, base + (opts.rename ? item.ext : extname(video.name)));
    item.sidecars = sidecarsFor(video).map((s) => ({
      from: join(video.dir, s.name),
      to: join(dir, base + (opts.rename ? s.suffix.toLowerCase() : s.suffix)),
    }));
    items.push(item);
  };

  for (const g of shows.values()) {
    // Show folders already in the destination are kept exactly as they are.
    const showDir = (g.home && isInside(g.home, roots.tv) && g.home) ||
      existingTitleDir(roots.tv, g.title) ||
      join(roots.tv, showFolderName(g, opts.tv));
    for (const it of g.items) {
      Object.assign(it, { title: g.title, year: g.year, tmdb_id: g.tmdb_id || null, source: g.source });
      const official = g.names?.get(it.season)?.get(it.episode);
      if (official) it.episodeTitle = official;
      place(it, seasonDir(showDir, it.season, opts.tv.seasonPad), episodeFileBase(it, opts.tv));
    }
  }

  for (const m of movies) {
    // A film already in a folder inside the destination (its own, or a
    // collection like "Avatar") stays there.
    const kept = m.home && isInside(m.home, roots.movie) ? m.home : null;
    const dir = kept || (opts.movie.folder
      ? existingTitleDir(roots.movie, m.title) || join(roots.movie, movieBase(m, opts.movie))
      : roots.movie);
    place(m, dir, movieFileBase(m, opts.movie));
  }

  // ---- status: ready, duplicate or conflict ----
  const claimed = new Map();
  let alreadyTidy = 0;
  const planned = [];
  // Largest first, so when two copies collide the better one is kept ready.
  for (const it of items.sort((a, b) => (b.size_bytes || 0) - (a.size_bytes || 0))) {
    if (it.to === it.from) {
      alreadyTidy++;
      continue;
    }
    const t = norm(it.to);
    // Windows names are case-insensitive: a case-only rename is not a conflict.
    const caseOnly = t === norm(it.from);
    if (it.downloading || Date.now() - it.mtime < settleMs) {
      // Moving a file a download client is still writing would corrupt it.
      it.status = 'busy';
      it.note = it.downloading ? 'Still downloading' : 'Changed moments ago; may still be downloading';
    } else if (claimed.has(t)) {
      it.status = 'duplicate';
      it.note = `Same new name as ${basename(claimed.get(t))}` +
        ((it.kind === 'tv' ? opts.tv.quality : opts.movie.quality) ? '' : ' (include quality to keep both)');
    } else if (existsSync(it.to) && !caseOnly) {
      it.status = 'conflict';
      it.note = 'A file with this name is already there';
    } else {
      it.status = 'ok';
      claimed.set(t, it.from);
    }
    it.creates_folder = !existsSync(dirname(it.to));
    planned.push(it);
  }

  planned.sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.title.localeCompare(b.title) ||
    (a.season ?? 0) - (b.season ?? 0) ||
    (a.episode ?? 0) - (b.episode ?? 0)
  );

  const ready = planned.filter((i) => i.status === 'ok');
  const tv = planned.filter((i) => i.kind === 'tv');
  return {
    source: roots_[0],
    sources: roots_,
    tvRoot: roots.tv,
    movieRoot: roots.movie,
    options: opts,
    items: planned,
    unidentified,
    ignored: found.ignored,
    summary: {
      scanned: found.videos.length,
      truncated: found.truncated,
      episodes: tv.length,
      shows: new Set(tv.map((i) => key(i.title))).size,
      movies: planned.length - tv.length,
      ready: ready.length,
      ready_bytes: ready.reduce((s, i) => s + (i.size_bytes || 0), 0),
      blocked: planned.length - ready.length,
      already_tidy: alreadyTidy,
      unidentified: unidentified.length,
      tmdb: tmdbOn,
      tmdb_errors: lookupErrors.length,
    },
  };
}

// ---------------------------------------------------------------- applying

async function copyVerified(from, to) {
  await copyFile(from, to, fsConstants.COPYFILE_EXCL);
  const [a, b] = await Promise.all([stat(from), stat(to)]);
  if (a.size !== b.size) {
    await unlink(to).catch(() => {});
    throw new Error('Copy was incomplete');
  }
}

/** Move one file; across drives that is copy, verify, then delete the original. */
async function moveFile(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  await copyVerified(from, to);
  try {
    await unlink(from);
  } catch (err) {
    // The copy is complete and verified; only the original could not be removed.
    throw Object.assign(new Error(`Copied, but the original could not be removed: ${err.message}`), { copied: true });
  }
}

const logOp = db.prepare(
  `INSERT INTO file_operations (id, batch_id, op, from_path, to_path, status) VALUES (?,?,?,?,?,'pending')`
);
const finishOp = db.prepare('UPDATE file_operations SET status = ?, op = ?, error = ? WHERE id = ?');
const repointFile = db.prepare('UPDATE files SET path = ?, parent_dir = ?, filename = ? WHERE path = ?');

async function transfer(batchId, mode, from, to) {
  if (!existsSync(from)) return { status: 'skipped', error: 'Source no longer exists' };
  if (existsSync(to) && norm(to) !== norm(from)) return { status: 'skipped', error: 'Target already exists' };

  await mkdir(dirname(to), { recursive: true });
  const opId = randomUUID();
  // Intent is logged BEFORE touching disk, so an interrupted run leaves a trail.
  logOp.run(opId, batchId, mode, from, to);
  try {
    if (mode === 'copy') {
      await copyVerified(from, to);
      finishOp.run('done', 'copy', null, opId);
    } else {
      await moveFile(from, to);
      transaction(() => {
        finishOp.run('done', 'move', null, opId);
        repointFile.run(to, dirname(to), basename(to), from);
      });
    }
    return { status: 'done' };
  } catch (err) {
    const message = String(err?.message || err);
    if (err.copied) {
      // Both files exist: record a copy, so undo removes only ours.
      finishOp.run('done', 'copy', message, opId);
      return { status: 'done', warning: message };
    }
    finishOp.run('failed', mode, message, opId);
    return { status: 'failed', error: message };
  }
}

/** Source folders that no longer hold any video. Reported, never removed. */
async function emptiedFolders(dirs, sources) {
  const roots = new Set(sources.map(norm));
  const out = [];
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (roots.has(norm(dir))) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      if (!entries.some((e) => e.isDirectory() || isVideoFile(e.name))) {
        out.push({ path: dir, leftover_files: entries.length });
      }
    } catch {
      // Already gone.
    }
  }
  return out;
}

export async function applyPlan(plan, ids, { onProgress = () => {} } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one file');
  const wanted = new Set(ids);
  const chosen = plan.items.filter((i) => wanted.has(i.id) && i.status === 'ok');
  const { mode } = plan.options;
  const batchId = randomUUID();
  const totalBytes = chosen.reduce((s, i) => s + (i.size_bytes || 0), 0);
  let bytes = 0;

  const result = { batch_id: batchId, mode, done: 0, skipped: 0, failed: 0, sidecars: 0, warnings: [], errors: [], moved_paths: [] };
  const touched = new Set();

  for (const [n, item] of chosen.entries()) {
    onProgress({
      phase: mode === 'copy' ? 'Copying' : 'Moving', done: n, total: chosen.length,
      bytes, total_bytes: totalBytes, current: basename(item.to),
    });
    const r = await transfer(batchId, mode, item.from, item.to);
    bytes += item.size_bytes || 0;
    if (r.status !== 'done') {
      result[r.status]++;
      result.errors.push({ file: item.from, message: r.error });
      continue;
    }
    result.done++;
    result.moved_paths.push(item.to);
    touched.add(dirname(item.from));
    if (r.warning) result.warnings.push({ file: item.from, message: r.warning });
    for (const s of item.sidecars || []) {
      if ((await transfer(batchId, mode, s.from, s.to)).status === 'done') result.sidecars++;
    }
  }

  onProgress({ phase: 'Finishing', done: chosen.length, total: chosen.length, bytes, total_bytes: totalBytes, current: null });
  result.empty_folders = mode === 'move' ? await emptiedFolders(touched, plan.sources || [plan.source]) : [];
  return result;
}

/**
 * After an undo, remove the season and show folders the batch created if they
 * are now completely empty. A folder with anything in it is never touched.
 */
async function removeIfEmpty(dir) {
  for (let d = dir, i = 0; i < 2; i++, d = dirname(d)) {
    try {
      if ((await readdir(d)).length) return;
      await rmdir(d);
    } catch {
      return;
    }
  }
}

/** Reverse a batch, newest operation first. */
export async function undoBatch(batchId) {
  const ops = db.prepare(
    "SELECT * FROM file_operations WHERE batch_id = ? AND status = 'done' ORDER BY created_at DESC, rowid DESC"
  ).all(batchId);
  const result = { reverted: 0, skipped: 0, failed: 0 };

  for (const op of ops) {
    try {
      if (op.op === 'copy') {
        // Remove only our copy, and only while the original is still intact.
        const [a, b] = await Promise.all([stat(op.from_path), stat(op.to_path)]);
        if (a.size !== b.size) {
          result.skipped++;
          continue;
        }
        await unlink(op.to_path);
      } else {
        if (!existsSync(op.to_path) || (existsSync(op.from_path) && norm(op.from_path) !== norm(op.to_path))) {
          result.skipped++;
          continue;
        }
        await mkdir(dirname(op.from_path), { recursive: true });
        await moveFile(op.to_path, op.from_path);
        repointFile.run(op.from_path, dirname(op.from_path), basename(op.from_path), op.to_path);
      }
      db.prepare("UPDATE file_operations SET status = 'undone' WHERE id = ?").run(op.id);
      result.reverted++;
      await removeIfEmpty(dirname(op.to_path));
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** Recent batches, for the history list and undo buttons. */
export function organizeHistory(limit = 20) {
  return db.prepare(`
    SELECT batch_id,
           COUNT(*) AS operations,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'undone' THEN 1 ELSE 0 END) AS undone,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN op = 'copy' THEN 1 ELSE 0 END) AS copies,
           MIN(created_at) AS created_at,
           MIN(to_path) AS sample_to
    FROM file_operations
    WHERE batch_id IS NOT NULL
    GROUP BY batch_id
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// ---------------------------------------------------------------- jobs

// Planning with TMDB and copying across drives both take far longer than a
// request should hang, so they run in the background and the UI polls.
let job = { running: false };
let lastPlan = null;
const PLAN_TTL_MS = 60 * 60 * 1000;

export function organizeJob() {
  return { ...job, plan_id: lastPlan?.id ?? null };
}

export function currentPlan() {
  return lastPlan;
}

export function runJob(type, work) {
  if (job.running) throw new Error(`Busy: a ${job.type} is still running`);
  job = { type, running: true, phase: 'Starting', done: 0, total: 0, started_at: new Date().toISOString() };
  const onProgress = (p) => Object.assign(job, p);
  work(onProgress)
    .then((result) => {
      job = { ...job, running: false, phase: 'Done', result, finished_at: new Date().toISOString() };
    })
    .catch((err) => {
      job = { ...job, running: false, phase: 'Failed', error: String(err?.message || err) };
    });
  return organizeJob();
}

export function organizeBusy() {
  return job.running;
}

export function startPlan({ source, sources, tvRoot, movieRoot, options }) {
  // Validate up front so bad paths fail the request, not the job.
  sourceList(source, sources);
  const opts = normalizeOptions(options);
  if (opts.include.tv) checkDestination(tvRoot);
  if (opts.include.movies) checkDestination(movieRoot);
  lastPlan = null;
  return runJob('preview', async (onProgress) => {
    const plan = await planImport({ source, sources, tvRoot, movieRoot, options: opts, onProgress });
    lastPlan = { id: randomUUID(), created_at: Date.now(), ...plan };
    return { plan_id: lastPlan.id, summary: plan.summary };
  });
}

export function startApply({ planId, ids, afterApply = async () => {} }) {
  if (!lastPlan || lastPlan.id !== planId) throw new Error('That preview is out of date. Preview again.');
  if (Date.now() - lastPlan.created_at > PLAN_TTL_MS) throw new Error('That preview is over an hour old. Preview again.');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Choose at least one file');
  const plan = lastPlan;
  return runJob('organize', async (onProgress) => {
    const result = await applyPlan(plan, ids, { onProgress });
    // Files have moved: the preview no longer describes the disk.
    lastPlan = null;
    await afterApply(plan, result);
    return result;
  });
}

export function startUndo(batchId, afterUndo = async () => {}) {
  return runJob('undo', async (onProgress) => {
    onProgress({ phase: 'Undoing' });
    const result = await undoBatch(batchId);
    lastPlan = null;
    await afterUndo();
    return result;
  });
}
