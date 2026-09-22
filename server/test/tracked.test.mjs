// Following a title that is not on this computer, the way TV Time does:
// adding it, recording what you watched, then downloading it and deleting it
// again without losing the record.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let tracked;
let scanner;
let watch;
let q;
let db;
let work;
let tv;

function episodeFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  const when = new Date(Date.now() - 3600_000);
  utimesSync(path, when, when);
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-tracked-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  tv = join(work, 'TV');
  mkdirSync(tv);

  db = await import('../src/db.js');
  q = await import('../src/queries.js');
  watch = await import('../src/watch.js');
  scanner = await import('../src/scanner/scan.js');
  tracked = await import('../src/tracked.js');
  scanner.addLibrary({ path: tv, kind: 'tv' });
});
after(() => {
  db.db.close();
  rmSync(work, { recursive: true, force: true });
});

// No TMDB key in the tests, so titles are followed by name and year.
test('a film you watched elsewhere can be added and marked watched', async () => {
  const film = await tracked.addTracked({ kind: 'movie', title: 'Whiplash', year: 2014 });
  assert.equal(film.title, 'Whiplash');
  assert.equal(film.files.length, 0, 'a tracked film should have no files');

  watch.setMovieWatched(film.id, true);
  assert.equal(q.getMovie(film.id).watched, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM watch_history').get().c, 1);
});

test('adding the same title twice follows the one already there', async () => {
  const again = await tracked.addTracked({ kind: 'movie', title: 'Whiplash', year: 2014 });
  assert.equal(again.already_had_it, true);
  assert.equal(db.db.prepare("SELECT COUNT(*) c FROM movies WHERE sort_title = 'whiplash'").get().c, 1);
});

test('a series is followed with its own row and nothing on disk', async () => {
  const show = await tracked.addTracked({ kind: 'show', title: 'Chernobyl', year: 2019 });
  assert.equal(show.title, 'Chernobyl');
  assert.equal(show.stats.owned, 0);
  const row = db.db.prepare('SELECT library_id, folder_path FROM shows WHERE id = ?').get(show.id);
  assert.equal(row.library_id, null, 'a tracked show belongs to no library');
  assert.equal(row.folder_path, null, 'a tracked show has no folder');
});

test('downloading it later claims the row instead of starting a second one', () => {
  const before = db.db.prepare("SELECT id FROM shows WHERE sort_title = 'chernobyl'").all();
  assert.equal(before.length, 1);

  episodeFile(join(tv, 'Chernobyl', 'Season 01', 'Chernobyl.S01E01.1080p.mkv'));
  scanner.scanLibraries();

  const after = db.db.prepare("SELECT id, folder_path FROM shows WHERE sort_title = 'chernobyl'").all();
  assert.equal(after.length, 1, 'a duplicate row appeared');
  assert.equal(after[0].id, before[0].id, 'the followed row was abandoned');
  assert.ok(after[0].folder_path, 'the row never got its folder');
});

test('deleting the files keeps the title and its history', () => {
  const show = db.db.prepare("SELECT id FROM shows WHERE sort_title = 'chernobyl'").get();
  const episode = db.db.prepare('SELECT id FROM episodes WHERE show_id = ? ORDER BY episode_number').get(show.id);
  watch.setEpisodeWatched(episode.id, true);
  assert.equal(q.getShow(show.id).stats.watched, 1);

  rmSync(join(tv, 'Chernobyl'), { recursive: true, force: true });
  scanner.scanLibraries();

  const still = q.getShow(show.id);
  assert.ok(still, 'the show disappeared with its files');
  assert.equal(still.stats.owned, 0, 'files are gone');
  assert.equal(still.stats.watched, 1, 'the watch record went with them');
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM watch_history WHERE show_id = ?').get(show.id).c,
    1,
    'history was lost'
  );
});

test('a title with nothing on disk is not reported as missing', () => {
  assert.equal(q.missingReport().length, 0);
});

test('a followed title can be dropped again, but not one with files', async () => {
  const film = await tracked.addTracked({ kind: 'movie', title: 'Tenet', year: 2020 });
  assert.deepEqual(tracked.removeTracked('movie', film.id), { ok: true });
  assert.equal(q.getMovie(film.id), null);

  episodeFile(join(tv, 'The Bear', 'The.Bear.S01E01.1080p.mkv'));
  scanner.scanLibraries();
  const owned = db.db.prepare("SELECT id FROM shows WHERE sort_title = 'bear'").get();
  assert.throws(() => tracked.removeTracked('show', owned.id), /files in your library/);
});

test('a title needs at least a name', async () => {
  await assert.rejects(() => tracked.addTracked({ kind: 'movie' }), /Give a title/);
  await assert.rejects(() => tracked.addTracked({ kind: 'book', title: 'x' }), /kind must be/);
});

test('a whole series can be marked watched with nothing on disk', async () => {
  // The reason for the feature: a series you watched years ago, long before
  // Shelf, and never had the files for.
  const show = await tracked.addTracked({ kind: 'show', title: 'Twin Peaks', year: 1990 });
  const seasons = [1, 2];
  for (const season of seasons) {
    for (let n = 1; n <= 3; n++) {
      db.db.prepare(
        `INSERT INTO episodes (id, show_id, season_number, episode_number, title, air_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`tp-${season}-${n}`, show.id, season, n, `Episode ${n}`, '1990-04-08');
    }
  }
  // One that has not aired yet, which must not be touched.
  db.db.prepare(
    `INSERT INTO episodes (id, show_id, season_number, episode_number, title, air_date)
     VALUES ('tp-future', ?, 3, 1, 'Not yet', date('now', '+30 days'))`
  ).run(show.id);

  watch.setShowWatched(show.id, { watched: true });

  const watched = db.db.prepare('SELECT episode_id FROM episode_state WHERE show_id = ? AND watched = 1').all(show.id);
  assert.equal(watched.length, 6, 'every aired episode should be marked');
  assert.ok(!watched.some((r) => r.episode_id === 'tp-future'), 'an unaired episode was marked watched');
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM watch_history WHERE show_id = ?').get(show.id).c,
    6,
    'history should record all six'
  );

  watch.setShowWatched(show.id, { watched: false });
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM episode_state WHERE show_id = ? AND watched = 1').get(show.id).c,
    0,
    'clearing should leave nothing watched'
  );
});

test('a title whose files you deleted can still be let go', async () => {
  // The button appeared but the action refused, because rows pointing at files
  // that are no longer there still counted as "files in your library".
  episodeFile(join(tv, 'Gone Show', 'Gone.Show.S01E01.1080p.mkv'));
  scanner.scanLibraries();
  const show = db.db.prepare("SELECT id FROM shows WHERE sort_title LIKE 'gone%'").get();
  assert.ok(show, 'the show should have been scanned');

  rmSync(join(tv, 'Gone Show'), { recursive: true, force: true });
  scanner.scanLibraries();

  const full = q.getShow(show.id);
  assert.equal(full.stats.owned, 0, 'nothing should be on disk any more');
  assert.deepEqual(tracked.removeTracked('show', show.id), { ok: true });
  assert.equal(q.getShow(show.id), null, 'the title should be gone');
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM files WHERE show_id = ?').get(show.id).c,
    0,
    'its stale file rows should go too'
  );
});

test('catching up marks everything to that point and nothing after', async () => {
  const show = await tracked.addTracked({ kind: 'show', title: 'The Wire', year: 2002 });
  for (const [season, count] of [[1, 3], [2, 3]]) {
    for (let n = 1; n <= count; n++) {
      db.db.prepare(
        `INSERT INTO episodes (id, show_id, season_number, episode_number, title, air_date)
         VALUES (?, ?, ?, ?, ?, '2002-06-02')`
      ).run(`wire-${season}-${n}`, show.id, season, n, `Episode ${n}`);
    }
  }
  // A special, which sits outside the run and should not be swept up.
  db.db.prepare(
    `INSERT INTO episodes (id, show_id, season_number, episode_number, title, air_date)
     VALUES ('wire-special', ?, 0, 1, 'Behind the scenes', '2002-06-02')`
  ).run(show.id);

  watch.setShowWatched(show.id, { watched: true, upTo: { season: 2, episode: 2 } });

  const watched = db.db
    .prepare('SELECT episode_id FROM episode_state WHERE show_id = ? AND watched = 1')
    .all(show.id)
    .map((r) => r.episode_id)
    .sort();
  assert.deepEqual(watched, ['wire-1-1', 'wire-1-2', 'wire-1-3', 'wire-2-1', 'wire-2-2']);
});

test('a series you dropped stops asking to be watched', async () => {
  episodeFile(join(tv, 'Dropped Show', 'Dropped.Show.S01E01.1080p.mkv'));
  scanner.scanLibraries();
  const show = db.db.prepare("SELECT id FROM shows WHERE sort_title LIKE 'dropped%'").get();

  assert.ok(q.continueWatching(50).some((r) => r.show_id === show.id), 'it should be queued at first');

  db.db.prepare("UPDATE shows SET user_status = 'dropped' WHERE id = ?").run(show.id);
  assert.ok(!q.continueWatching(50).some((r) => r.show_id === show.id), 'a dropped series is still queued');
  assert.ok(!q.missingReport().some((r) => r.show_id === show.id), 'a dropped series still reports gaps');

  db.db.prepare("UPDATE shows SET user_status = 'completed' WHERE id = ?").run(show.id);
  assert.ok(!q.continueWatching(50).some((r) => r.show_id === show.id), 'a finished series is still queued');
});
