// With no connection, Shelf still has to work. TMDB brings artwork and episode
// names; everything else - scanning, organizing, tracking, statistics - is
// local, and must not hang, throw, or lose anything when the network is gone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let db;
let scanner;
let queries;
let watch;
let stats;
let organizer;
let tracked;
let tmdb;
let work;
let tv;
let downloads;

/** Every outbound request fails the way it does with the cable pulled. */
const offline = () => {
  const err = new Error('getaddrinfo ENOTFOUND api.themoviedb.org');
  err.cause = { code: 'ENOTFOUND' };
  return Promise.reject(err);
};

function video(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  const when = new Date(Date.now() - 7200_000);
  utimesSync(path, when, when);
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-offline-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  tv = join(work, 'TV');
  downloads = join(work, 'Downloads');
  mkdirSync(tv);

  video(join(tv, 'Severance', 'Season 01', 'Severance.S01E01.1080p.WEB-DL.mkv'));
  video(join(tv, 'Severance', 'Season 01', 'Severance.S01E02.1080p.WEB-DL.mkv'));
  video(join(downloads, 'The.Bear.S01E01.1080p.WEBRip.mkv'));
  video(join(downloads, 'Arrival.2016.1080p.BluRay.x264.mkv'));

  db = await import('../src/db.js');
  scanner = await import('../src/scanner/scan.js');
  queries = await import('../src/queries.js');
  watch = await import('../src/watch.js');
  stats = await import('../src/stats.js');
  organizer = await import('../src/organizer.js');
  tracked = await import('../src/tracked.js');
  tmdb = await import('../src/tmdb.js');

  scanner.addLibrary({ path: tv, kind: 'tv' });
  // A key is configured, so the code will try to reach TMDB and fail, which is
  // the case that matters: being offline is not the same as having no key.
  db.setSetting('tmdb.apiKey', 'offline-test-key');
  globalThis.fetch = offline;
});
after(() => {
  db.db.close();
  rmSync(work, { recursive: true, force: true });
});

test('scanning a library needs nothing from the network', () => {
  const result = scanner.scanLibraries();
  assert.equal(result.shows, 1);
  assert.equal(result.episodes, 2);
  assert.equal(queries.listShows().length, 1);
});

test('watching, rating and history all work offline', () => {
  const show = queries.listShows()[0];
  const episode = queries.getShow(show.id).seasons[0].episodes[0];
  watch.setEpisodeWatched(episode.id, true);

  assert.equal(queries.getShow(show.id).stats.watched, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM watch_history').get().c, 1);
  assert.ok(stats.overview().watched.minutes > 0);
  assert.equal(stats.periods('week', 4).length, 4);
  assert.equal(queries.continueWatching(5).length, 1);
});

test('the organizer plans and moves files offline', async () => {
  const plan = await organizer.planImport({
    source: downloads,
    tvRoot: tv,
    movieRoot: join(work, 'Films'),
    // Asking for TMDB titles while offline: it must fall back, not fail.
    options: { useTmdb: true, rename: true },
  });
  assert.equal(plan.summary.scanned, 2, 'both downloads should be seen');
  assert.ok(plan.items.length >= 2, 'nothing was planned');
  assert.equal(plan.summary.tmdb_errors > 0 || plan.summary.tmdb === false, true);

  const ready = plan.items.filter((i) => i.status === 'ok');
  assert.ok(ready.length >= 1, 'nothing was ready to move');
  const result = await organizer.applyPlan(plan, ready.map((i) => i.id));
  assert.ok(result.done >= 1, 'no file moved');
  assert.equal(result.failed, 0);
  for (const item of ready) assert.ok(existsSync(item.to), `${item.to} is not there`);

  const undone = await organizer.undoBatch(result.batch_id);
  assert.equal(undone.reverted, result.done);
});

test('a title can be followed offline, by name', async () => {
  const film = await tracked.addTracked({ kind: 'movie', title: 'Whiplash', year: 2014 });
  assert.equal(film.title, 'Whiplash');
  watch.setMovieWatched(film.id, true);
  assert.equal(queries.getMovie(film.id).watched, 1);
});

test('a TMDB failure is reported, and leaves the library alone', async () => {
  const before = queries.listShows()[0];
  const match = await tmdb.enrichShow(before.id, 12345).catch((err) => err);
  assert.ok(match instanceof Error || match?.ok === false, 'it should report, not succeed');

  const after = queries.listShows()[0];
  assert.notEqual(after.tmdb_status, 'matched', 'a failed lookup must not claim a match');
  assert.equal(queries.listShows().length, 1, 'the library changed because of a network error');
  assert.equal(after.title, before.title);
});

test('the backup can still be written and read offline', async () => {
  const backup = await import('../src/backup.js');
  const data = backup.exportBackup();
  assert.ok(data.shows.length >= 1, 'backup has no shows');
  assert.ok(data.history.length >= 1, 'backup has no history');
});

test('an outage does not write the library off as unmatchable', async () => {
  // Running the matcher with no connection used to mark every title
  // "failed", and failed titles are skipped next time - so one dropped
  // connection quietly stopped the library from ever matching.
  const job = await new Promise((resolve) => {
    let last = null;
    tmdb.enrichAll({ onProgress: (p) => { last = p; } }).then(() => resolve(last));
  });

  assert.ok(job.offline > 0, 'the run should say it could not reach TMDB');
  assert.equal(job.failed, 0, 'nothing should be written off as not found');
  const statuses = db.db.prepare('SELECT tmdb_status FROM shows').all().map((r) => r.tmdb_status);
  assert.ok(!statuses.includes('failed'), `a title was marked failed: ${statuses.join(', ')}`);
});
