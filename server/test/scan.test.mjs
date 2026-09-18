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
  stats = scanner.scanLibraries();
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
