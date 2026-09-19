// Shelf should cost a rounding error next to the library it describes, and
// should be able to give back what it no longer needs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let storage;
let images;
let db;
let work;
let cache;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-storage-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);

  db = await import('../src/db.js');
  images = await import('../src/images.js');
  storage = await import('../src/storage.js');

  // One film that is still here, with its poster, and artwork left behind by a
  // title that has since gone.
  db.db.prepare(
    "INSERT INTO movies (id, title, sort_title, poster_path) VALUES ('m1', 'Arrival', 'arrival', '/keep.jpg')"
  ).run();

  cache = images.IMAGE_CACHE_DIR;
  mkdirSync(join(cache, 'w342'), { recursive: true });
  writeFileSync(join(cache, 'w342', 'keep.jpg'), Buffer.alloc(40 * 1024));
  writeFileSync(join(cache, 'w342', 'orphan.jpg'), Buffer.alloc(60 * 1024));
  writeFileSync(join(cache, 'w342', 'also-orphan.jpg'), Buffer.alloc(20 * 1024));
});
after(() => {
  db.db.close();
  rmSync(work, { recursive: true, force: true });
});

test('the report counts the index, the artwork and the uploads', () => {
  const report = storage.storageReport();
  assert.equal(report.image_files, 3);
  assert.ok(report.images >= 120 * 1024, `artwork measured as ${report.images}`);
  assert.ok(report.database > 0, 'the database measured as nothing');
  assert.equal(report.total, report.database + report.images + report.uploads);
});

test('tidying drops artwork nothing refers to, and keeps the rest', () => {
  const result = storage.tidyStorage();

  assert.equal(result.removed_images, 2, 'the orphans should go');
  assert.ok(existsSync(join(cache, 'w342', 'keep.jpg')), 'a poster in use was deleted');
  assert.ok(!existsSync(join(cache, 'w342', 'orphan.jpg')));
  assert.ok(result.freed >= 80 * 1024, `only gave back ${result.freed} bytes`);
  assert.equal(storage.storageReport().image_files, 1);
});

test('the film itself is untouched by tidying', () => {
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM movies').get().c, 1);
});
