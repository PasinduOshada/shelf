import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, transaction, sortTitle, getSetting } from '../db.js';
import { hiddenFilter, nothingHidden } from '../hidden.js';
import {
  parseFilename, parseFolderName, isVideoFile, isSubtitleFile,
  isJunkName, isClipFile, SKIP_DIR, SAMPLE_DIR,
} from './parse.js';

const SEASON_DIR = /^(?:season|series|s)[\s._-]*(\d{1,3})$/i;
const SPECIALS_DIR = /^(?:specials?|extras?)$/i;

const isSeasonDir = (name) => SEASON_DIR.test(name) || SPECIALS_DIR.test(name);

// Set for the library being scanned; hidden entries are never walked into.
let isHidden = nothingHidden;

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
function collectShowRoots(dir, excludes, depth = 0) {
  if (isExcluded(dir, excludes)) return [];

  const roots = [];
  const subdirs = listDirs(dir);
  const hasSeasonDirs = subdirs.some(isSeasonDir);
  const hasDirectVideos = listFiles(dir).some(isVideoFile);

  if (hasSeasonDirs || hasDirectVideos) roots.push(dir);

  if (depth < 2) {
    for (const d of subdirs) {
      if (isSeasonDir(d)) continue;
      roots.push(...collectShowRoots(join(dir, d), excludes, depth + 1));
    }
  }
  return roots;
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
  const existing = db.prepare('SELECT * FROM shows WHERE folder_path = ?').get(folderPath);
  if (existing) {
    // Heal a detached row: libraries.id is ON DELETE SET NULL, so removing and
    // re-adding a library orphans its shows until the next scan.
    if (existing.library_id !== libraryId) {
      db.prepare('UPDATE shows SET library_id = ? WHERE id = ?').run(libraryId, existing.id);
      existing.library_id = libraryId;
    }
    return existing;
  }

  const { title, year } = parseFolderName(folderName);
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

function scanTvLibrary(library, stats, excludes) {
  const roots = [];
  for (const folderName of listDirs(library.path)) {
    roots.push(...collectShowRoots(join(library.path, folderName), excludes));
  }
  // Deepest first, so a file is claimed by the most specific show root.
  roots.sort((a, b) => b.length - a.length);

  for (const showRoot of roots) {
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
  }
}

function scanMovieLibrary(library, stats, excludes) {
  for (const filename of listFiles(library.path)) {
    if (!isVideoFile(filename)) continue;
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

  for (const folderName of listDirs(library.path)) {
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
  }
}

export function scanLibraries({ libraryId = null } = {}) {
  const libs = libraryId
    ? db.prepare('SELECT * FROM libraries WHERE id = ?').all(libraryId)
    : db.prepare('SELECT * FROM libraries WHERE enabled = 1').all();

  const excludes = loadExcludes();
  const stats = {
    libraries: 0, shows: 0, episodes: 0, movies: 0,
    files: 0, extras: 0, subtitles: 0, skipped: 0, missing: 0, durationMs: 0,
  };
  const started = Date.now();

  for (const library of libs) {
    if (!existsSync(library.path)) continue;
    stats.libraries++;
    isHidden = hiddenFilter([library.path]);
    transaction(() => {
      if (library.kind === 'tv') scanTvLibrary(library, stats, excludes);
      else scanMovieLibrary(library, stats, excludes);
      db.prepare("UPDATE libraries SET last_scan = datetime('now') WHERE id = ?").run(library.id);
    });
  }

  transaction(() => {
    for (const row of db.prepare('SELECT id, path FROM files WHERE is_missing = 0').all()) {
      if (!existsSync(row.path)) {
        db.prepare('UPDATE files SET is_missing = 1 WHERE id = ?').run(row.id);
        stats.missing++;
      }
    }
  });

  isHidden = nothingHidden;
  stats.durationMs = Date.now() - started;
  return stats;
}

export function addLibrary({ path, kind, label = null }) {
  const existing = db.prepare('SELECT * FROM libraries WHERE path = ?').get(path);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare('INSERT INTO libraries (id, path, kind, label) VALUES (?, ?, ?, ?)').run(id, path, kind, label);
  return db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
}
