import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, transaction, sortTitle, getSetting } from '../db.js';
import { hiddenFilter, nothingHidden } from '../hidden.js';
import {
  parseFilename, parseFolderName, isVideoFile, isSubtitleFile,
  isJunkName, isClipFile, SKIP_DIR, SAMPLE_DIR,
} from './parse.js';

// Folders that name a category rather than a title. "Documentaries" is a
// shelf, not a programme: what stands in it stands on its own.
const GROUPING_DIR =
  /^(?:documentar(?:y|ies)|movies?|films?|shows?|tv(?:[\s._-]?(?:series|shows?))?|series|anime|cartoons?|kids|collections?|misc(?:ellaneous)?|various|other|stuff|new folder|videos?|media)$/i;

const SEASON_DIR = /^(?:season|series|s)[\s._-]*(\d{1,3})$/i;
const SPECIALS_DIR = /^(?:specials?|extras?)$/i;

const isSeasonDir = (name) => SEASON_DIR.test(name) || SPECIALS_DIR.test(name);

// Set for the library being scanned; hidden entries are never walked into.
let isHidden = nothingHidden;

// The server lives in the desktop app's own process, so a scan that never
// gives the event loop a turn freezes the whole window: no clicks, no tray, no
// answer to anything. Work is committed in batches with a breath between them.
let progress = { running: false, phase: null, done: 0, total: 0, current: null };

export function scanStatus() {
  return { ...progress };
}

const breathe = () => new Promise((resolve) => setImmediate(resolve));

function normalize(p) {
  return String(p).replace(/[\\/]+/g, '/').toLowerCase();
}

function loadExcludes() {
  try {
    const raw = getSetting('scan.excludes', '[]');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(normalize).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isExcluded(path, excludes) {
  if (!excludes.length) return false;
  const p = normalize(path);
  return excludes.some((ex) => p === ex || p.startsWith(ex + '/') || p.includes('/' + ex + '/') || p.endsWith('/' + ex));
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (isHidden(full, e.name)) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIR.test(e.name)) walkFiles(full, out);
    } else out.push(full);
  }
  return out;
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIR.test(e.name))
      .filter((e) => !isHidden(join(dir, e.name), e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !isHidden(join(dir, e.name), e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A folder is a show root when it holds Season dirs or loose episode files.
 * Grouping folders (e.g. "Documentaries" holding several docuseries) are
 * recursed into, so each nested series becomes its own show rather than all
 * of them collapsing into one with colliding episode numbers.
 */
function collectShowRoots(dir, excludes, out = { roots: [], groups: [] }, depth = 0) {
  if (isExcluded(dir, excludes)) return out;

  const subdirs = listDirs(dir);
  const hasSeasonDirs = subdirs.some(isSeasonDir);
  const hasDirectVideos = listFiles(dir).some(isVideoFile);

  if (GROUPING_DIR.test(basename(dir))) {
    // Never a title of its own. Anything loose in it is dealt with one file at
    // a time; the folders inside it are found by the recursion below.
    if (hasDirectVideos) out.groups.push(dir);
  } else if (hasSeasonDirs || hasDirectVideos) {
    out.roots.push(dir);
  }

  if (depth < 2) {
    for (const d of subdirs) {
      if (isSeasonDir(d)) continue;
      collectShowRoots(join(dir, d), excludes, out, depth + 1);
    }
  }
  return out;
}

/**
 * A video that is not the film or episode itself: release samples, trailers,
 * and phone or camera exports that happen to sit in a media folder.
 */
function isNotLibraryMedia(filePath, filename) {
  if (isJunkName(filename.replace(/\.[^.]+$/, ''))) return true;
  if (SAMPLE_DIR.test(basename(dirname(filePath)))) return true;
  const { size } = fileStat(filePath);
  return isClipFile(filename, size);
}

function seasonFromPath(filePath, showRoot) {
  const rel = relative(showRoot, dirname(filePath));
  if (!rel || rel === '.') return null;
  for (const part of rel.split(sep)) {
    const m = part.match(SEASON_DIR);
    if (m) return Number(m[1]);
    if (SPECIALS_DIR.test(part)) return 0;
  }
  return null;
}

function fileStat(p) {
  try {
    const s = statSync(p);
    return { size: s.size, mtime: new Date(s.mtimeMs).toISOString() };
  } catch {
    return { size: null, mtime: null };
  }
}

// ---------------------------------------------------------------- upserts

function upsertShow({ libraryId, folderPath, folderName }) {
  const { title, year } = parseFolderName(folderName);
  const existing =
    db.prepare('SELECT * FROM shows WHERE folder_path = ?').get(folderPath) ||
    // A title you were only following, now downloaded: claim that row rather
    // than starting a second one beside it.
    db.prepare(
      `SELECT * FROM shows
       WHERE folder_path IS NULL AND library_id IS NULL AND sort_title = ?
         -- A year only rules the match out when both sides state one.
         AND (year IS NULL OR ?2 IS NULL OR year = ?2)`
    ).get(sortTitle(title || folderName), year ?? null);
  if (existing) {
    if (!existing.folder_path) {
      db.prepare('UPDATE shows SET folder_path = ?, folder_name = ? WHERE id = ?')
        .run(folderPath, folderName, existing.id);
      existing.folder_path = folderPath;
      existing.folder_name = folderName;
    }
    // Heal a detached row: libraries.id is ON DELETE SET NULL, so removing and
    // re-adding a library orphans its shows until the next scan.
    if (existing.library_id !== libraryId) {
      db.prepare('UPDATE shows SET library_id = ? WHERE id = ?').run(libraryId, existing.id);
      existing.library_id = libraryId;
    }
    return existing;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO shows (id, library_id, folder_path, folder_name, title, sort_title, year, tmdb_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unmatched')`
  ).run(id, libraryId, folderPath, folderName, title || folderName, sortTitle(title || folderName), year);
  return db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
}

function ensureEpisode(showId, season, episode) {
  const found = db
    .prepare('SELECT id FROM episodes WHERE show_id = ? AND season_number = ? AND episode_number = ?')
    .get(showId, season, episode);
  if (found) return found.id;
  const id = randomUUID();
  db.prepare('INSERT INTO episodes (id, show_id, season_number, episode_number) VALUES (?, ?, ?, ?)')
    .run(id, showId, season, episode);
  return id;
}

function ensureSeason(showId, season) {
  const found = db.prepare('SELECT id FROM seasons WHERE show_id = ? AND season_number = ?').get(showId, season);
  if (found) return found.id;
  const id = randomUUID();
  db.prepare('INSERT INTO seasons (id, show_id, season_number) VALUES (?, ?, ?)').run(id, showId, season);
  return id;
}

function upsertMovie({ libraryId, collectionId, title, year }) {
  const existing = db
    .prepare('SELECT * FROM movies WHERE sort_title = ? AND IFNULL(year, -1) = IFNULL(?, -1)')
    .get(sortTitle(title), year ?? null);
  if (existing) {
    if (existing.library_id !== libraryId) {
      db.prepare('UPDATE movies SET library_id = ? WHERE id = ?').run(libraryId, existing.id);
      existing.library_id = libraryId;
    }
    return existing;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO movies (id, library_id, collection_id, title, sort_title, year, tmdb_status)
     VALUES (?, ?, ?, ?, ?, ?, 'unmatched')`
  ).run(id, libraryId, collectionId ?? null, title, sortTitle(title), year ?? null);
  return db.prepare('SELECT * FROM movies WHERE id = ?').get(id);
}

function upsertCollection(name) {
  const existing = db.prepare('SELECT * FROM collections WHERE name = ?').get(name);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run(id, name);
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}

function recordFile(row) {
  const { size, mtime } = fileStat(row.path);
  const existing = db.prepare('SELECT id FROM files WHERE path = ?').get(row.path);

  if (existing) {
    db.prepare(
      `UPDATE files SET filename=?, parent_dir=?, ext=?, size_bytes=?, mtime=?,
        show_id=?, episode_id=?, movie_id=?, parsed_season=?, parsed_episode=?,
        quality=?, codec=?, source=?, is_missing=0, scanned_at=datetime('now')
       WHERE id=?`
    ).run(
      row.filename, row.parentDir, row.ext, size, mtime,
      row.showId ?? null, row.episodeId ?? null, row.movieId ?? null,
      row.season ?? null, row.episode ?? null,
      row.quality ?? null, row.codec ?? null, row.source ?? null, existing.id
    );
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO files (id, path, filename, parent_dir, ext, size_bytes, mtime,
       show_id, episode_id, movie_id, parsed_season, parsed_episode, quality, codec, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, row.path, row.filename, row.parentDir, row.ext, size, mtime,
    row.showId ?? null, row.episodeId ?? null, row.movieId ?? null,
    row.season ?? null, row.episode ?? null,
    row.quality ?? null, row.codec ?? null, row.source ?? null
  );
  return id;
}

// ---------------------------------------------------------------- scanning

const manualEpisode = db.prepare('SELECT manual_season, manual_episode FROM files WHERE path = ?');

/**
 * Videos standing loose in a category folder. Each is its own title: a single
 * documentary is a film, and loose episodes belong to whatever series their
 * own names give, not to the folder they happen to share.
 */
function scanGroupFolder(library, dir, stats, excludes) {
  const series = new Map();

  for (const filename of listFiles(dir).sort()) {
    if (!isVideoFile(filename)) {
      if (isSubtitleFile(filename)) stats.subtitles++;
      continue;
    }
    const path = join(dir, filename);
    if (isExcluded(path, excludes)) continue;
    if (isNotLibraryMedia(path, filename)) {
      stats.skipped++;
      continue;
    }

    const parsed = parseFilename(filename);
    if (parsed.isEpisode && parsed.season != null && parsed.title) {
      const key = sortTitle(parsed.title);
      if (!series.has(key)) series.set(key, { title: parsed.title, files: [] });
      series.get(key).files.push({ path, filename, parsed });
      continue;
    }
    if (!parsed.title) continue;

    const movie = upsertMovie({
      libraryId: library.id, collectionId: null, title: parsed.title, year: parsed.year,
    });
    recordFile({
      path, filename, parentDir: dir, ext: parsed.ext, movieId: movie.id,
      quality: parsed.quality, codec: parsed.codec, source: parsed.source,
    });
    stats.movies++;
    stats.files++;
  }

  for (const group of series.values()) {
    // No folder of its own to be known by, so the first of its files serves as
    // the show's identity. It is stable as long as that file is there.
    const show = upsertShow({
      libraryId: library.id,
      folderPath: group.files[0].path,
      folderName: group.title,
    });
    stats.shows++;
    for (const { path, filename, parsed } of group.files) {
      ensureSeason(show.id, parsed.season);
      const episodeId = ensureEpisode(show.id, parsed.season, parsed.episode);
      recordFile({
        path, filename, parentDir: dir, ext: parsed.ext, showId: show.id, episodeId,
        season: parsed.season, episode: parsed.episode,
        quality: parsed.quality, codec: parsed.codec, source: parsed.source,
      });
      stats.episodes++;
      stats.files++;
    }
  }
}

async function scanTvLibrary(library, stats, excludes) {
  const found = { roots: [], groups: [] };
  for (const folderName of listDirs(library.path)) {
    collectShowRoots(join(library.path, folderName), excludes, found);
  }
  const roots = found.roots;
  // Deepest first, so a file is claimed by the most specific show root.
  roots.sort((a, b) => b.length - a.length);

  progress.total += roots.length + found.groups.length;

  for (const showRoot of roots) {
    progress.current = basename(showRoot);
    progress.done++;
    await breathe();
    // Which files this root actually owns, decided before anything is created:
    // a folder whose only videos are clips or phone exports is not a show.
    const owned = [];
    for (const filePath of walkFiles(showRoot)) {
      const filename = basename(filePath);
      if (!isVideoFile(filename)) {
        if (isSubtitleFile(filename)) stats.subtitles++;
        continue;
      }
      if (isExcluded(filePath, excludes)) continue;
      if (isNotLibraryMedia(filePath, filename)) {
        stats.skipped++;
        continue;
      }
      // Skip files owned by a nested (deeper) show root.
      const owner = roots.find((r) => filePath.startsWith(r + sep));
      if (owner && owner !== showRoot) continue;
      owned.push(filePath);
    }
    if (!owned.length) continue;

    transaction(() => {
    const show = upsertShow({
      libraryId: library.id,
      folderPath: showRoot,
      folderName: basename(showRoot),
    });
    stats.shows++;

    for (const filePath of owned) {
      const filename = basename(filePath);

      const dirSeason = seasonFromPath(filePath, showRoot);
      const parsed = parseFilename(filename, {
        folderTitle: basename(showRoot),
        defaultSeason: dirSeason ?? 1,
      });
      // A person's correction ("this is S01E03") beats whatever the name says.
      const manual = manualEpisode.get(filePath);
      if (manual?.manual_episode != null) {
        parsed.isEpisode = true;
        parsed.season = manual.manual_season ?? 1;
        parsed.episode = manual.manual_episode;
      }
      const season = parsed.season ?? dirSeason;

      const common = {
        path: filePath,
        filename,
        parentDir: dirname(filePath),
        ext: parsed.ext,
        showId: show.id,
        quality: parsed.quality,
        codec: parsed.codec,
        source: parsed.source,
      };

      if (parsed.isEpisode && season != null) {
        ensureSeason(show.id, season);
        const episodeId = ensureEpisode(show.id, season, parsed.episode);
        recordFile({ ...common, episodeId, season, episode: parsed.episode });
        stats.episodes++;
      } else {
        recordFile({ ...common, season: null, episode: null });
        stats.extras++;
      }
      stats.files++;
    }
    });
  }

  // After the shows, so anything a real series claimed is already spoken for.
  for (const dir of found.groups) {
    progress.current = basename(dir);
    progress.done++;
    await breathe();
    transaction(() => scanGroupFolder(library, dir, stats, excludes));
  }
}

const FILM_BATCH = 120;

async function scanMovieLibrary(library, stats, excludes) {
  const loose = listFiles(library.path).filter(isVideoFile);
  const folders = listDirs(library.path);
  progress.total += Math.ceil(loose.length / FILM_BATCH) + folders.length;

  for (let at = 0; at < loose.length; at += FILM_BATCH) {
    progress.current = library.label || basename(library.path);
    progress.done++;
    await breathe();
    transaction(() => {
      for (const filename of loose.slice(at, at + FILM_BATCH)) {
        const filePath = join(library.path, filename);
        if (isExcluded(filePath, excludes)) continue;
        if (isNotLibraryMedia(filePath, filename)) {
          stats.skipped++;
          continue;
        }

        const parsed = parseFilename(filename);
        if (!parsed.title) continue;

        const movie = upsertMovie({
          libraryId: library.id, collectionId: null,
          title: parsed.title, year: parsed.year,
        });
        recordFile({
          path: filePath, filename, parentDir: library.path, ext: parsed.ext,
          movieId: movie.id, quality: parsed.quality, codec: parsed.codec, source: parsed.source,
        });
        stats.movies++;
        stats.files++;
      }
    });
  }

  for (const folderName of folders) {
    progress.current = folderName;
    progress.done++;
    await breathe();
    const dirPath = join(library.path, folderName);
    if (isExcluded(dirPath, excludes)) continue;

    const videoFiles = walkFiles(dirPath)
      .filter((f) => isVideoFile(basename(f)))
      .filter((f) => !isExcluded(f, excludes))
      .filter((f) => {
        if (!isNotLibraryMedia(f, basename(f))) return true;
        stats.skipped++;
        return false;
      });
    if (!videoFiles.length) continue;

    transaction(() => {
    const collection = videoFiles.length > 1 ? upsertCollection(folderName) : null;

    for (const filePath of videoFiles) {
      const filename = basename(filePath);
      const parsed = parseFilename(filename, { folderTitle: folderName });
      if (!parsed.title) continue;

      const movie = upsertMovie({
        libraryId: library.id, collectionId: collection?.id ?? null,
        title: parsed.title, year: parsed.year,
      });
      recordFile({
        path: filePath, filename, parentDir: dirname(filePath), ext: parsed.ext,
        movieId: movie.id, quality: parsed.quality, codec: parsed.codec, source: parsed.source,
      });
      stats.movies++;
      stats.files++;
    }
    });
  }
}

// Scans yield now, so two can overlap: the sidebar's Rescan while a finished
// download triggers one, say. They do not corrupt anything - every write is an
// upsert - but they repeat each other's work and share one progress count, so
// they take their turn instead.
let queue = Promise.resolve();

export function scanLibraries(options = {}) {
  const run = queue.then(() => scanOnce(options), () => scanOnce(options));
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function scanOnce({ libraryId = null } = {}) {
  const libs = libraryId
    ? db.prepare('SELECT * FROM libraries WHERE id = ?').all(libraryId)
    : db.prepare('SELECT * FROM libraries WHERE enabled = 1').all();

  const excludes = loadExcludes();
  const stats = {
    libraries: 0, shows: 0, episodes: 0, movies: 0,
    files: 0, extras: 0, subtitles: 0, skipped: 0, missing: 0, unavailable: [], durationMs: 0,
  };
  const started = Date.now();
  progress = { running: true, phase: 'Reading folders', done: 0, total: 0, current: null };

  for (const library of libs) {
    if (!existsSync(library.path)) {
      // An external drive that is not plugged in, or a folder that moved. Its
      // files are not gone, they are just out of reach, so nothing under it is
      // touched below.
      stats.unavailable.push(library.path);
      continue;
    }
    stats.libraries++;
    isHidden = hiddenFilter([library.path]);
    if (library.kind === 'tv') await scanTvLibrary(library, stats, excludes);
    else await scanMovieLibrary(library, stats, excludes);
    db.prepare("UPDATE libraries SET last_scan = datetime('now') WHERE id = ?").run(library.id);
  }

  const outOfReach = stats.unavailable.map((p) => normalize(p));
  const unreachable = (path) => {
    const p = normalize(path);
    return outOfReach.some((root) => p === root || p.startsWith(root + '/'));
  };

  progress.phase = 'Checking what is still there';
  const known = db.prepare('SELECT id, path FROM files WHERE is_missing = 0').all();
  const CHECK_BATCH = 400;
  for (let at = 0; at < known.length; at += CHECK_BATCH) {
    await breathe();
    transaction(() => {
      for (const row of known.slice(at, at + CHECK_BATCH)) {
        // Marking a whole library missing because its drive is unplugged would
        // throw away everything Shelf knows about it, for no reason.
        if (unreachable(row.path)) continue;
        if (!existsSync(row.path)) {
          db.prepare('UPDATE files SET is_missing = 1 WHERE id = ?').run(row.id);
          stats.missing++;
        }
      }
    });
  }

  isHidden = nothingHidden;
  pruneEmptyShows();
  // Fold the write-ahead log back in. A scan writes a lot at once, and the log
  // otherwise stays as large as the busiest scan for the rest of the session.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Something else is reading; it will fold in later.
  }
  stats.durationMs = Date.now() - started;
  progress = { running: false, phase: null, done: 0, total: 0, current: null };
  return stats;
}

/**
 * Remove shows left holding nothing: a folder that stopped being a title (a
 * category folder, say) or one whose files all went elsewhere. Only debris
 * goes - anything you followed, watched, rated or wrote a note on stays, as
 * does any title you added yourself.
 */
function pruneEmptyShows() {
  const dead = db.prepare(`
    SELECT s.id, s.title FROM shows s
    WHERE s.library_id IS NOT NULL
      AND s.is_favorite = 0
      AND s.user_status IS NULL AND s.user_rating IS NULL
      AND (s.notes IS NULL OR s.notes = '')
      AND NOT EXISTS (SELECT 1 FROM files f WHERE f.show_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM watch_history h WHERE h.show_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM episode_state e WHERE e.show_id = s.id AND (e.watched = 1 OR e.rating IS NOT NULL))
  `).all();

  if (!dead.length) return;
  transaction(() => {
    for (const show of dead) db.prepare('DELETE FROM shows WHERE id = ?').run(show.id);
  });
  return dead.length;
}

export function addLibrary({ path, kind, label = null }) {
  const existing = db.prepare('SELECT * FROM libraries WHERE path = ?').get(path);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare('INSERT INTO libraries (id, path, kind, label) VALUES (?, ?, ?, ?)').run(id, path, kind, label);
  return db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
}
