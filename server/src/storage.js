// What Shelf costs you in disk, and how to give most of it back.
//
// Shelf should be a rounding error next to the library it describes: the index
// of a thousand files is a few megabytes, and the artwork is cached at the size
// it is displayed and no larger. This module measures that, and tidies up the
// three things that grow quietly: artwork nothing refers to any more, the
// database's write-ahead log, and pages freed by deleted rows.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
 * Give back what can be given back. Artwork for titles that are still in the
 * library is kept: it is what makes the app work offline, and fetching it again
 * would cost more than it saves.
 */
export function tidyStorage() {
  const before = storageReport();
  const pruned = pruneImageCache();
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
