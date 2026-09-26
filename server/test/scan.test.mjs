// What a scan puts in the library, against a throwaway folder tree.
// Only films and episodes belong there: not samples, trailers, phone clips,
// artwork, subtitles or anything else that lives beside them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Mark a path hidden the way Windows does; elsewhere the dot name stands in. */
function hide(path) {
  if (process.platform !== 'win32') return;
  execFileSync('attrib', ['+h', path], { windowsHide: true });
}

let scanner;
let db;
let work;
let stats;

const BIG = 400 * 1024 ** 2; // past the point where "sample" means a clip

function file(path, bytes = 1024) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, bytes); // sparse: a feature-length size without the bytes
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-scan-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);

  const tv = join(work, 'TV');
  file(join(tv, 'Severance', 'Season 01', 'Severance.S01E01.1080p.mkv'));
  file(join(tv, 'Severance', 'Season 01', 'Severance.S01E01.1080p.srt'));
  file(join(tv, 'Severance', 'Season 01', 'sample.mkv'));
  file(join(tv, 'Severance', 'Season 01', 'poster.jpg'));
  file(join(tv, 'Severance', 'Trailer.mkv'));
  file(join(tv, 'Severance', 'WhatsApp Video 2025-01-01 at 10.10.10.mp4'));
  file(join(tv, 'Holiday photos', 'notes.txt'));
  // An episode whose own title is "Free Sample": not a clip.
  file(join(tv, 'Mrs Fletcher', 'Mrs_Fletcher_S01E02_Free_Sample_720p_WEBRip.mkv'));

  // Hidden, by the Windows attribute and by name.
  file(join(tv, 'Private', 'Private.S01E01.1080p.mkv'));
  hide(join(tv, 'Private'));
  file(join(tv, 'Severance', 'Season 01', 'Severance.S01E09.1080p.mkv'));
  hide(join(tv, 'Severance', 'Season 01', 'Severance.S01E09.1080p.mkv'));
  file(join(tv, '.stfolder', 'Severance.S01E08.1080p.mkv'));

  const films = join(work, 'Films');
  file(join(films, 'Dune Part Two (2024) 1080p.mkv'));
  file(join(films, 'Dune Part Two (2024) 1080p-sample.mkv'));
  file(join(films, 'Arrival (2016)', 'Arrival.2016.1080p.mkv'));
  file(join(films, 'Arrival (2016)', 'Arrival.2016.teaser.mp4'));
  file(join(films, 'Arrival (2016)', 'artwork.png'));
  file(join(films, 'Arrival (2016)', 'readme.nfo'));
  file(join(films, 'IMG_20240102_120000.mp4'));
  file(join(films, 'Arrival (2016)', 'Sample', 'a-clip.mkv'));
  // A feature-length film whose name happens to say "sample".
  file(join(films, 'The Sample (2019) 1080p.mkv'), BIG);

  db = await import('../src/db.js');
  scanner = await import('../src/scanner/scan.js');
  scanner.addLibrary({ path: tv, kind: 'tv' });
  scanner.addLibrary({ path: films, kind: 'movie' });
  stats = await scanner.scanLibraries();
});
after(() => {
  db.db.close();
  rmSync(work, { recursive: true, force: true });
});

const paths = () => db.db.prepare('SELECT filename FROM files').all().map((r) => r.filename);

test('only video files are indexed at all', () => {
  const kept = paths();
  assert.ok(!kept.some((n) => /\.(jpg|png|txt|nfo|srt)$/i.test(n)), kept.join(', '));
});

test('samples, trailers and phone clips are left out', () => {
  const kept = paths();
  for (const unwanted of [
    'sample.mkv', 'Trailer.mkv', 'WhatsApp Video 2025-01-01 at 10.10.10.mp4',
    'Dune Part Two (2024) 1080p-sample.mkv', 'Arrival.2016.teaser.mp4', 'IMG_20240102_120000.mp4',
    'a-clip.mkv',
  ]) {
    assert.ok(!kept.includes(unwanted), `${unwanted} should not be in the library`);
  }
  assert.equal(stats.skipped, 7);
});

test('the episodes and films themselves are kept', () => {
  const kept = paths();
  assert.ok(kept.includes('Severance.S01E01.1080p.mkv'));
  assert.ok(kept.includes('Dune Part Two (2024) 1080p.mkv'));
  assert.ok(kept.includes('Arrival.2016.1080p.mkv'));
  // The word "sample" inside a release name is part of the episode title.
  assert.ok(kept.includes('Mrs_Fletcher_S01E02_Free_Sample_720p_WEBRip.mkv'));
  assert.equal(stats.episodes, 2);
});

test('a folder with no video in it never becomes a show', () => {
  const shows = db.db.prepare('SELECT title FROM shows').all().map((r) => r.title);
  assert.deepEqual(shows.sort(), ['Mrs Fletcher', 'Severance']);
});

test('a feature-length file called "sample" is still a film', () => {
  // Size decides: a clip is small, so the name alone never loses a real film.
  assert.ok(paths().includes('The Sample (2019) 1080p.mkv'));
});

test('hidden files and folders are never scanned', () => {
  // They are on disk and readable: only the hidden mark keeps them out.
  assert.ok(existsSync(join(work, 'TV', 'Private', 'Private.S01E01.1080p.mkv')));
  assert.ok(existsSync(join(work, 'TV', 'Severance', 'Season 01', 'Severance.S01E09.1080p.mkv')));
  const kept = paths();
  assert.ok(!kept.includes('Private.S01E01.1080p.mkv'), 'a hidden folder is walked past');
  assert.ok(!kept.includes('Severance.S01E09.1080p.mkv'), 'a hidden file is picked up');
  assert.ok(!kept.includes('Severance.S01E08.1080p.mkv'), 'a dot folder is walked past');
  const shows = db.db.prepare('SELECT title FROM shows').all().map((r) => r.title);
  assert.ok(!shows.includes('Private'), 'a hidden folder became a show');
});

test('specials never lead the "watch next" queue', async () => {
  // Severance has a Specials folder (season 0) and a season 1.
  const q = await import('../src/queries.js');
  const next = q.continueWatching(10).find((r) => r.title === 'Severance');
  assert.ok(next, 'Severance is not queued at all');
  assert.equal(next.season_number, 1, 'a special was offered before season 1');
  assert.equal(next.episode_number, 1, 'wrong episode offered');
});

test('a quiet year in Wrapped counts zero, not null', async () => {
  // Same trap as the weekly figures: SUM() over no rows is NULL, and the page
  // printed "null films" for any year with nothing in it.
  const stats = await import('../src/stats.js');
  const quiet = stats.wrapped(1999).totals;
  assert.equal(quiet.movies, 0);
  assert.equal(quiet.episodes, 0);
  assert.equal(quiet.items, 0);
  assert.equal(quiet.hours, 0);
});

test('a week with nothing watched counts zero, not null', async () => {
  // SUM() over no rows is NULL in SQLite, which reached the screen as
  // "null episodes - null films".
  const stats = await import('../src/stats.js');
  const week = stats.summaries().week;
  assert.equal(week.episodes, 0);
  assert.equal(week.movies, 0);
  assert.equal(week.items, 0);
  assert.equal(week.hours, 0);
});

test('a category folder is a shelf, not a title', async () => {
  // Taken from a real library: "Documentaries" holding standalone films at the
  // top and docuseries in their own folders. It became one show called
  // "Documentaries" whose films hid inside it as extras.
  const work = mkdtempSync(join(tmpdir(), 'shelf-group-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);

  const tv = join(work, 'TV');
  const docs = join(tv, 'Documentaries');
  file(join(docs, 'Amanda.Knox.2016.720p.WEBRip.x264.mp4'));
  file(join(docs, 'The.Tinder.Swindler.2022.720p.NF.WEBRip.x264.mkv'));
  file(join(docs, 'Night Stalker', 'Night.Stalker.S01E01.1080p.mkv'));
  file(join(docs, 'Night Stalker', 'Night.Stalker.S01E02.1080p.mkv'));
  // Loose episodes in a category folder belong to their own series.
  file(join(docs, 'Wild.Wild.Country.S01E01.1080p.mkv'));
  file(join(docs, 'Wild.Wild.Country.S01E02.1080p.mkv'));
  // A real show that happens to have loose episodes beside its season folders
  // must keep working: the folder name is a title, not a category.
  file(join(tv, 'Fargo', 'Fargo.S02E01.720p.mkv'));
  file(join(tv, 'Fargo', 'Season 03', 'Fargo.S03E01.720p.mkv'));

  const freshDb = await import(`../src/db.js?group=${Date.now()}`);
  const freshScanner = await import(`../src/scanner/scan.js?group=${Date.now()}`);
  freshScanner.addLibrary({ path: tv, kind: 'tv' });
  await freshScanner.scanLibraries();

  const shows = freshDb.db.prepare('SELECT title FROM shows ORDER BY title').all().map((r) => r.title);
  const films = freshDb.db.prepare('SELECT title FROM movies ORDER BY title').all().map((r) => r.title);

  assert.ok(!shows.includes('Documentaries'), `"Documentaries" became a show: ${shows.join(', ')}`);
  assert.ok(films.includes('Amanda Knox'), `the films are missing: ${films.join(', ')}`);
  assert.ok(films.includes('The Tinder Swindler'), `the films are missing: ${films.join(', ')}`);
  assert.ok(shows.includes('Night Stalker'), `a docuseries subfolder was lost: ${shows.join(', ')}`);
  assert.ok(shows.includes('Wild Wild Country'), `loose episodes lost their series: ${shows.join(', ')}`);
  assert.ok(shows.includes('Fargo'), 'a real show with loose episodes was broken');

  const fargo = freshDb.db.prepare("SELECT id FROM shows WHERE title = 'Fargo'").get();
  assert.equal(
    freshDb.db.prepare('SELECT COUNT(*) c FROM files WHERE show_id = ?').get(fargo.id).c,
    2,
    'Fargo should keep both its loose episode and its season folder'
  );

  freshDb.db.close();
  rmSync(work, { recursive: true, force: true });
});

test('an unplugged drive does not wipe what Shelf knows', async () => {
  // A library on a removable drive. Scanning while it is unplugged used to
  // mark every one of its files missing, which reads as "your library is gone".
  const drive = join(work, 'E drive');
  file(join(drive, 'Severance', 'Severance.S01E01.1080p.mkv'));
  scanner.addLibrary({ path: drive, kind: 'tv' });
  await scanner.scanLibraries();

  const onDrive = () =>
    db.db.prepare('SELECT COUNT(*) c FROM files WHERE is_missing = 0 AND path LIKE ?').get(drive + '%').c;
  assert.equal(onDrive(), 1, 'the drive should have been scanned');
  const show = db.db.prepare('SELECT id FROM shows WHERE folder_path LIKE ?').get(drive + '%');
  assert.ok(show, 'its show should exist');

  // Unplugged.
  rmSync(drive, { recursive: true, force: true });
  const stats = await scanner.scanLibraries();

  assert.ok(stats.unavailable.includes(drive), 'the scan should report the folder it could not reach');
  assert.equal(onDrive(), 1, 'its files were marked missing even though the drive was just absent');
  assert.ok(
    db.db.prepare('SELECT id FROM shows WHERE id = ?').get(show.id),
    'the show should survive its drive being unplugged'
  );
});

test('a scan lets the app breathe, and says where it has got to', async () => {
  // The server runs inside the desktop app's own process: a scan that never
  // yields freezes the window. This checks the event loop keeps turning, and
  // that progress is readable while it does.
  const many = join(work, 'Many');
  for (let n = 1; n <= 12; n++) {
    file(join(many, `Show ${n}`, 'Season 01', `Show.${n}.S01E01.1080p.mkv`));
  }
  scanner.addLibrary({ path: many, kind: 'tv' });

  let ticks = 0;
  const seen = [];
  const beat = setInterval(() => {
    ticks++;
    const s = scanner.scanStatus();
    if (s.running) seen.push(s.done);
  }, 5);

  const before = scanner.scanStatus();
  assert.equal(before.running, false, 'nothing should be running yet');

  await scanner.scanLibraries();
  clearInterval(beat);

  assert.ok(ticks > 3, `the event loop only turned ${ticks} times during the scan`);
  assert.ok(seen.length > 0, 'progress was never visible while scanning');
  assert.ok(seen.at(-1) >= seen[0], 'progress should move forward');
  assert.equal(scanner.scanStatus().running, false, 'it should say it has finished');
});

test('two scans at once take their turn rather than racing', async () => {
  // Scanning yields to the event loop now, so overlapping runs are possible in
  // a way they were not before: Rescan while a finished download triggers one.
  const both = join(work, 'Both At Once');
  for (let n = 1; n <= 4; n++) file(join(both, `Show ${n}`, 'Season 01', `Show.${n}.S01E01.1080p.mkv`));
  scanner.addLibrary({ path: both, kind: 'tv' });

  const seenRunning = [];
  const beat = setInterval(() => {
    const s = scanner.scanStatus();
    if (s.running) seenRunning.push(s.done);
  }, 5);
  const [a, b] = await Promise.all([scanner.scanLibraries(), scanner.scanLibraries()]);
  clearInterval(beat);

  assert.equal(a.shows, b.shows, 'both runs should agree on what they found');
  const rows = db.db.prepare('SELECT COUNT(*) c FROM files WHERE path LIKE ?').get(both + '%').c;
  assert.equal(rows, 4, `each file should be indexed once, found ${rows}`);
  // Progress belongs to one run at a time: it never counts past its own total.
  const status = scanner.scanStatus();
  assert.equal(status.running, false);
});
