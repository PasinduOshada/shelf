// What Shelf costs you in disk, and how to give most of it back.
//
// Shelf should be a rounding error next to the library it describes: the index
// of a thousand files is a few megabytes, and the artwork is cached at the size
// it is displayed and no larger. This module measures that, and tidies up the
// three things that grow quietly: artwork nothing refers to any more, the
// database's write-ahead log, and pages freed by deleted rows.
import { readdirSync, statSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { db } from './db.js';
import { DATA_DIR, DB_PATH, UPLOADS_DIR } from './paths.js';
import { IMAGE_CACHE_DIR, cacheSize, pruneImageCache } from './images.js';

function sizeOf(path) {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return stat.size;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

export function storageReport() {
  const images = cacheSize();
  const database = sizeOf(DB_PATH) + sizeOf(DB_PATH + '-wal') + sizeOf(DB_PATH + '-shm');
  const uploads = sizeOf(UPLOADS_DIR);
  return {
    data_dir: DATA_DIR,
    database,
    images: images.bytes,
    image_files: images.files,
    uploads,
    total: database + images.bytes + uploads,
  };
}

/**
 * Delete one uploaded poster, given the URL stored on the row. Called when a
 * poster is replaced or cleared, so the old picture goes at the same moment
 * the thing pointing at it does.
 */
export function dropUpload(url) {
  if (!url || !String(url).startsWith('/uploads/')) return;
  try {
    rmSync(join(UPLOADS_DIR, basename(String(url))));
  } catch {
    // Already gone, or never written.
  }
}

/** Uploaded posters no row points at any more: replaced, or cleared. */
function pruneUploads() {
  const wanted = new Set();
  for (const sql of ['SELECT custom_poster p FROM shows', 'SELECT custom_poster p FROM movies']) {
    for (const row of db.prepare(sql).all()) if (row.p) wanted.add(basename(String(row.p)));
  }

  let removed = 0;
  let names;
  try {
    names = readdirSync(UPLOADS_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (wanted.has(name)) continue;
    const file = join(UPLOADS_DIR, name);
    try {
      // An upload still being attached to its row is not yet referenced.
      if (Date.now() - statSync(file).mtimeMs < 5 * 60_000) continue;
      rmSync(file);
      removed++;
    } catch {
      // Already gone.
    }
  }
  return removed;
}

/**
 * Give back what can be given back. Artwork for titles that are still in the
 * library is kept: it is what makes the app work offline, and fetching it again
 * would cost more than it saves.
 */
export function tidyStorage() {
  const before = storageReport();
  const pruned = pruneImageCache();
  pruned.removed += pruneUploads();
  // Fold the write-ahead log back into the database, then release the pages
  // that deleted rows left behind.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } catch {
    // A checkpoint can be refused while something else is reading; the space
    // is only deferred, never lost.
  }
  const after = storageReport();
  return {
    removed_images: pruned.removed,
    freed: Math.max(0, before.total - after.total),
    ...after,
  };
}
