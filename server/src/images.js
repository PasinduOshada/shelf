// Local cache for TMDB artwork.
//
// Posters are fetched from image.tmdb.org once and kept on disk, so a library
// that has been matched keeps its artwork with no network -- the desktop build
// has to work standalone.
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from './paths.js';
import { db } from './db.js';

export const IMAGE_CACHE_DIR = process.env.SHELF_IMAGE_CACHE_DIR
  ? resolve(process.env.SHELF_IMAGE_CACHE_DIR)
  : join(DATA_DIR, 'cache', 'images');

const SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'w1280', 'original']);

// TMDB file names are opaque ids like "qJeU7KM4nT2C1WpOrwPcSDGFUWE.jpg". Anything
// else is rejected, which also rules out path traversal.
const FILE_RE = /^[A-Za-z0-9_-]{6,80}\.(?:jpe?g|png|webp)$/;

const inflight = new Map();

export function isValidImageRequest(size, file) {
  return SIZES.has(size) && FILE_RE.test(file);
}

/**
 * Ensure a TMDB image is in the local cache; resolves to its absolute path.
 * Concurrent requests for the same image share one download.
 */
export async function cacheImage(size, tmdbPath) {
  if (!tmdbPath) return null;
  const file = String(tmdbPath).replace(/^\/+/, '');
  if (!isValidImageRequest(size, file)) throw new Error('Invalid image path');

  const target = join(IMAGE_CACHE_DIR, size, file);
  if (existsSync(target)) return target;

  const key = `${size}/${file}`;
  if (inflight.has(key)) return inflight.get(key);

  const download = (async () => {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`https://image.tmdb.org/t/p/${size}/${file}`, {
          signal: AbortSignal.timeout(12000),
        });
        break;
      } catch (err) {
        // Stalls and resets happen on some home connections (one hung 10.6 s, and
        // the retry answered in 0.3 s). HTTP errors below are real answers and
        // aren't retried.
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    if (!res.ok) {
      const err = new Error(`TMDB image ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!(res.headers.get('content-type') || '').startsWith('image/')) {
      throw new Error('TMDB returned something that is not an image');
    }

    mkdirSync(join(IMAGE_CACHE_DIR, size), { recursive: true });
    const tmp = `${target}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    try {
      renameSync(tmp, target);
    } catch (err) {
      // Another process won the race; its copy is identical.
      if (existsSync(target)) unlinkSync(tmp);
      else throw err;
    }
    return target;
  })().finally(() => inflight.delete(key));

  inflight.set(key, download);
  return download;
}

/** What the cache currently costs, in files and bytes. */
export function cacheSize() {
  let files = 0;
  let bytes = 0;
  for (const size of SIZES) {
    const dir = join(IMAGE_CACHE_DIR, size);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        bytes += statSync(join(dir, name)).size;
        files++;
      } catch {
        // Gone between listing and asking: nothing to count.
      }
    }
  }
  return { files, bytes };
}

/**
 * Delete artwork nothing refers to any more: posters of titles that were
 * removed, and everything an older match left behind. Keeping them costs disk
 * for pictures no screen will ever ask for again.
 */
export function pruneImageCache() {
  const wanted = new Set();
  const add = (path) => {
    if (path) wanted.add(String(path).replace(/^\//, ''));
  };
  for (const sql of [
    'SELECT poster_path AS p, backdrop_path AS b FROM shows',
    'SELECT poster_path AS p, backdrop_path AS b FROM movies',
    'SELECT poster_path AS p, NULL AS b FROM seasons',
    'SELECT still_path AS p, NULL AS b FROM episodes',
  ]) {
    for (const row of db.prepare(sql).all()) {
      add(row.p);
      add(row.b);
    }
  }

  let removed = 0;
  let bytes = 0;
  for (const size of SIZES) {
    const dir = join(IMAGE_CACHE_DIR, size);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (wanted.has(name)) continue;
      const file = join(dir, name);
      try {
        bytes += statSync(file).size;
        rmSync(file);
        removed++;
      } catch {
        // Already gone.
      }
    }
  }
  return { removed, bytes };
}
