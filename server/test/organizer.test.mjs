// Organiser tests: identification and naming are pure; the plan/apply/undo
// round trip runs against throwaway folders and a throwaway database, never a
// real library. No network (TMDB is off: there is no key in the test DB).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

let o;
let work;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-organize-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  o = await import('../src/organizer.js');
});
after(async () => {
  // Windows will not delete the folder while the database file is open.
  (await import('../src/db.js')).db.close();
  rmSync(work, { recursive: true, force: true });
});

function touch(path, content = 'x') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('identifies episodes and films from names and folders', () => {
  const ep = o.identify('the.last.of.us.s01e03.long.long.time.1080p.web.h264.mkv');
  assert.equal(ep.kind, 'tv');
  assert.equal(ep.title, 'The Last of Us');
  assert.deepEqual([ep.season, ep.episode, ep.quality], [1, 3, '1080p']);

  // No title in the file: the show folder names it, the season folder numbers it.
  const bare = o.identify('Episode 5.mp4', ['Season 2', 'Slow Horses (2022)']);
  assert.deepEqual([bare.kind, bare.title, bare.season, bare.episode, bare.year], ['tv', 'Slow Horses', 2, 5, 2022]);

  const marker = o.identify('S01E02.mkv', ['Severance']);
  assert.deepEqual([marker.kind, marker.title], ['tv', 'Severance']);

  const film = o.identify('Dune.Part.Two.2024.2160p.UHD.BluRay.x265.mkv');
  assert.deepEqual([film.kind, film.title, film.year, film.quality], ['movie', 'Dune Part Two', 2024, '2160p']);

  // A badly named file inside a well named film folder takes the folder's name.
  const foldered = o.identify('movie.mkv', ['Past Lives (2023)']);
  assert.deepEqual([foldered.kind, foldered.title, foldered.year], ['movie', 'Past Lives', 2023]);

  assert.equal(o.identify('DOC-20251014-WA0003.mp4').kind, 'unknown');
  const oggy = o.identify('[MPM] Oggy and the Cockroaches - Bitter Chocolate (s01e01).mp4', ['Season 1', 'Oggy & The Crokroachers']);
  assert.deepEqual(
    [oggy.title, oggy.episodeTitle, oggy.folderTitle, oggy.inSeasonFolder],
    ['Oggy and the Cockroaches', 'Bitter Chocolate', 'Oggy & The Crokroachers', true]
  );
  const fg = o.identify('Family Guy - S01E01 - Death Has a Shadow.mkv');
  assert.deepEqual([fg.title, fg.episodeTitle], ['Family Guy', 'Death Has a Shadow']);

  // Split films keep their part number; titles that already carry it do not repeat it.
  const p1 = o.identify('The.Girl.with.the.Dragon.Tattoo.Part.1.2009.Extended.720.mkv');
  assert.equal(p1.part, 1);
  const named = { title: 'The Girl with the Dragon Tattoo', year: 2009, part: 1 };
  assert.equal(o.movieFileBase(named, { year: true, quality: true }), 'The Girl with the Dragon Tattoo (2009) - Part 1');
  const hallows = { title: 'Harry Potter and the Deathly Hallows: Part 1', year: 2010, part: 1, quality: '1080p' };
  assert.equal(o.movieFileBase(hallows, { year: true, quality: true }), 'Harry Potter and the Deathly Hallows - Part 1 (2010) - 1080p');
  assert.equal(o.identify('The.Godfather.Part.II.1974.mkv').part, null);

  // A grouping folder is not a title (this once produced "The Movies (1925)").
  assert.equal(o.identify('DOC-20251014-WA0001.mp4', ['Movies']).kind, 'unknown');
  const doc = o.identify('Amanda.Knox.2016.720p.mp4', ['Documentaries', 'TV Series']);
  assert.deepEqual([doc.kind, doc.title, doc.folderTitle], ['movie', 'Amanda Knox', null]);
  assert.equal(o.identify('VID_20240101_120000.mp4').kind, 'unknown');
  assert.equal(o.identify('WhatsApp Video 2025-01-01 at 10.00.00.mp4').kind, 'unknown');
  assert.equal(o.identify('20250101_101010.mp4').kind, 'unknown');
  // A real title that starts with a junk-looking word still counts.
  assert.equal(o.identify('Video.Nasty.2023.1080p.mkv').kind, 'movie');
});

test('builds names from the chosen parts only', () => {
  const ep = { title: 'Severance', season: 1, episode: 2, episodeTitle: 'Half Loop', quality: '1080p' };
  assert.equal(
    o.episodeFileBase(ep, { episodeTitle: true, quality: true }),
    'Severance - S01E02 - Half Loop - 1080p'
  );
  assert.equal(o.episodeFileBase(ep, { episodeTitle: false, quality: false }), 'Severance - S01E02');

  const film = { title: 'Alien: Romulus', year: 2024, quality: '2160p' };
  assert.equal(o.movieFileBase(film, { year: true, quality: true }), 'Alien - Romulus (2024) - 2160p');
  assert.equal(o.movieFileBase(film, { year: false, quality: false }), 'Alien - Romulus');
  assert.equal(o.safeName("Don't F**k with Cats: Hunting an Internet Killer"), "Don't Fuck with Cats - Hunting an Internet Killer");
  assert.equal(o.safeName('What If...?'), 'What If');
  // TMDB placeholder names are left out.
  assert.equal(
    o.episodeFileBase({ ...ep, episodeTitle: 'Episode 1' }, { episodeTitle: true, quality: false }),
    'Severance - S01E02'
  );

  assert.equal(o.seasonFolderName(3, true), 'Season 03');
  assert.equal(o.seasonFolderName(3, false), 'Season 3');
  assert.equal(o.seasonFolderName(0), 'Specials');
  assert.equal(o.showFolderName({ title: 'Severance', year: 2022 }, { showYear: true }), 'Severance (2022)');
  assert.equal(o.smartCase('the lord of the rings'), 'The Lord of the Rings');
  assert.equal(o.smartCase('WALL-E'), 'Wall-e'); // all caps is normalised too
  assert.equal(o.smartCase('iCarly'), 'iCarly');
});

test('ignores unknown option keys and wrong types', () => {
  const opts = o.normalizeOptions({ mode: 'delete', rename: 'yes', tv: { quality: false, evil: true } });
  assert.equal(opts.mode, 'move');
  assert.equal(opts.rename, true);
  assert.equal(opts.tv.quality, false);
  assert.equal('evil' in opts.tv, false);
});

test('plans, moves with subtitles, reports conflicts, and undoes', async () => {
  const src = join(work, 'downloads');
  const dest = join(work, 'media');
  touch(join(src, 'Severance.S01E01.1080p.WEB.mkv'), 'ep1');
  touch(join(src, 'Severance.S01E01.1080p.WEB.en.srt'), 'sub1');
  touch(join(src, 'severance.s01e02.720p.mkv'), 'ep2');
  touch(join(src, 'Dune.Part.Two.2024.2160p.mkv'), 'dune');
  touch(join(src, 'sample', 'Dune.Part.Two.2024.sample.mkv'), 's');
  touch(join(src, 'DOC-20251014-WA0003.mp4'), 'phone');
  touch(join(src, 'notes.txt'), 'not a video');
  // Already in the destination, under an older spelling: must be reused.
  touch(join(dest, 'TV Series', 'severance', 'Season 1', 'keep.txt'), 'k');
  // Something already sits where a film would go: a conflict, never overwritten.
  touch(join(dest, 'Movies', 'Dune Part Two (2024)', 'Dune Part Two (2024) - 2160p.mkv'), 'existing');

  const plan = await o.planImport({
    source: src,
    tvRoot: join(dest, 'TV Series'),
    movieRoot: join(dest, 'Movies'),
    settleMs: 0,
    options: { useTmdb: false },
  });

  assert.equal(plan.summary.scanned, 4);
  assert.equal(plan.summary.episodes, 2);
  assert.equal(plan.summary.movies, 1);
  assert.equal(plan.summary.ready, 2);
  assert.equal(plan.unidentified.length, 1);
  assert.equal(plan.ignored.length, 1);

  const ep1 = plan.items.find((i) => i.episode === 1);
  assert.equal(ep1.to, join(dest, 'TV Series', 'severance', 'Season 1', 'Severance - S01E01 - 1080p.mkv'));
  assert.equal(ep1.sidecars[0].to, join(dirname(ep1.to), 'Severance - S01E01 - 1080p.en.srt'));
  const dune = plan.items.find((i) => i.kind === 'movie');
  assert.equal(dune.status, 'conflict');

  // Nothing has moved yet.
  assert.ok(existsSync(join(src, 'Severance.S01E01.1080p.WEB.mkv')));

  // A conflicting id is ignored even when asked for.
  const result = await o.applyPlan(plan, plan.items.map((i) => i.id));
  assert.equal(result.done, 2);
  assert.equal(result.sidecars, 1);
  assert.equal(readFileSync(ep1.to, 'utf8'), 'ep1');
  assert.equal(readFileSync(join(dest, 'Movies', 'Dune Part Two (2024)', 'Dune Part Two (2024) - 2160p.mkv'), 'utf8'), 'existing');
  assert.ok(existsSync(join(src, 'Dune.Part.Two.2024.2160p.mkv')));
  assert.ok(!existsSync(join(src, 'Severance.S01E01.1080p.WEB.mkv')));

  const undone = await o.undoBatch(result.batch_id);
  assert.equal(undone.reverted, 3);
  assert.equal(readFileSync(join(src, 'Severance.S01E01.1080p.WEB.mkv'), 'utf8'), 'ep1');
  assert.ok(existsSync(join(src, 'Severance.S01E01.1080p.WEB.en.srt')));
  // The reused season folder still holds the user's file, so it stays.
  assert.deepEqual(readdirSync(join(dest, 'TV Series', 'severance', 'Season 1')), ['keep.txt']);
});

test('copy mode leaves the originals, and undo removes only the copies', async () => {
  const src = join(work, 'copy-src');
  const dest = join(work, 'copy-dest');
  touch(join(src, 'Slow Horses', 'Season 1', 'Episode 1.mkv'), 'a');
  touch(join(src, 'Slow Horses', 'Season 1', 'Episode 2.mkv'), 'b');
  mkdirSync(dest);

  const plan = await o.planImport({
    source: src, tvRoot: dest, movieRoot: dest, settleMs: 0,
    options: { mode: 'copy', useTmdb: false, tv: { showYear: false, seasonPad: false } },
  });
  const result = await o.applyPlan(plan, plan.items.map((i) => i.id));
  assert.equal(result.done, 2);
  const season = join(dest, 'Slow Horses', 'Season 1');
  assert.deepEqual(readdirSync(season).sort(), ['Slow Horses - S01E01.mkv', 'Slow Horses - S01E02.mkv']);
  assert.ok(existsSync(join(src, 'Slow Horses', 'Season 1', 'Episode 1.mkv')));

  const undone = await o.undoBatch(result.batch_id);
  assert.equal(undone.reverted, 2);
  assert.ok(!existsSync(join(dest, 'Slow Horses')), 'empty folders the batch created are removed');
  assert.ok(existsSync(join(src, 'Slow Horses', 'Season 1', 'Episode 2.mkv')));
});

test('two files wanting the same name: the larger is kept ready', async () => {
  const src = join(work, 'dupes');
  touch(join(src, 'Fargo.S02E01.720p.mkv'), 'small');
  touch(join(src, 'a', 'Fargo.S02E01.1080p.mkv'), 'much larger file');
  const plan = await o.planImport({
    source: src, tvRoot: join(work, 'dupes-out'), movieRoot: join(work, 'dupes-out'),
    settleMs: 0,
    options: { useTmdb: false, tv: { quality: false } },
  });
  const [ready, dup] = ['ok', 'duplicate'].map((s) => plan.items.find((i) => i.status === s));
  assert.equal(basename(ready.from), 'Fargo.S02E01.1080p.mkv');
  assert.match(dup.note, /include quality/);
});

test('never plans files that are still downloading; takes several sources', async () => {
  const a = join(work, 'dl-a');
  const b = join(work, 'dl-b');
  touch(join(a, 'Fallout.S02E01.1080p.mkv'), 'done');
  touch(join(a, 'Fallout.S02E02.1080p.mkv'), 'half');
  touch(join(a, 'Fallout.S02E02.1080p.mkv.aria2'), 'marker');
  touch(join(b, 'Heat.1995.1080p.mkv'), 'fresh');
  const out = join(work, 'dl-out');

  const fresh = await o.planImport({
    sources: [a, b, a], tvRoot: out, movieRoot: out, options: { useTmdb: false },
  });
  assert.deepEqual(fresh.sources, [a, b]);
  const state = Object.fromEntries(fresh.items.map((i) => [basename(i.from), [i.status, i.note]]));
  assert.deepEqual(state['Fallout.S02E02.1080p.mkv'], ['busy', 'Still downloading']);
  // Written a moment ago: could still be growing.
  assert.equal(state['Heat.1995.1080p.mkv'][0], 'busy');

  const settled = await o.planImport({
    sources: [a, b], tvRoot: out, movieRoot: out, settleMs: 0, options: { useTmdb: false },
  });
  const ready = settled.items.filter((i) => i.status === 'ok').map((i) => basename(i.from)).sort();
  assert.deepEqual(ready, ['Fallout.S02E01.1080p.mkv', 'Heat.1995.1080p.mkv']);
});

test('rejects relative and missing paths', async () => {
  await assert.rejects(o.planImport({ source: 'downloads', tvRoot: work, movieRoot: work }), /full folder path/);
  await assert.rejects(o.planImport({ source: join(work, 'nope'), tvRoot: work, movieRoot: work }), /does not exist/);
  await assert.rejects(
    o.planImport({ source: work, tvRoot: join(work, 'no', 'such', 'parent'), movieRoot: work }),
    /does not exist/
  );
});

test('rename only: files keep their folders and just get proper names', async () => {
  // For a library that is already where you want it: fix the names, move
  // nothing. There is no destination at all in this mode.
  const mine = join(work, 'Already Sorted');
  touch(join(mine, 'Severance', 'severance.s01e01.1080p.web-dl.x265-grp.mkv'), 'a');
  touch(join(mine, 'Severance', 'severance.s01e02.1080p.web-dl.x265-grp.mkv'), 'b');
  touch(join(mine, 'my films', 'dune.part.two.2024.2160p.bluray.x265.mkv'), 'c');

  const plan = await o.planImport({
    source: mine,
    settleMs: 0,
    options: { mode: 'rename', useTmdb: false, include: { tv: true, movies: true } },
  });

  assert.equal(plan.summary.scanned, 3);
  assert.equal(plan.items.length, 3, 'every file should be planned');
  for (const item of plan.items) {
    assert.equal(dirname(item.to), dirname(item.from), `${basename(item.from)} was moved out of its folder`);
  }

  const result = await o.applyPlan(plan, plan.items.map((i) => i.id));
  assert.equal(result.done, 3);
  assert.equal(result.failed, 0);

  assert.deepEqual(readdirSync(join(mine, 'Severance')).sort(), [
    'Severance - S01E01 - 1080p.mkv',
    'Severance - S01E02 - 1080p.mkv',
  ]);
  assert.deepEqual(readdirSync(join(mine, 'my films')), ['Dune Part Two (2024) - 2160p.mkv']);

  // And it can be taken back like any other batch.
  const undone = await o.undoBatch(result.batch_id);
  assert.equal(undone.reverted, 3);
  assert.ok(readdirSync(join(mine, 'Severance')).includes('severance.s01e01.1080p.web-dl.x265-grp.mkv'));
});

test('rename only needs no destination folders at all', async () => {
  const mine = join(work, 'No Destination');
  touch(join(mine, 'The.Bear.S01E01.1080p.mkv'), 'd');
  // startPlan validates destinations up front; in this mode there are none.
  const job = o.startPlan({ source: mine, options: { mode: 'rename', useTmdb: false } });
  assert.ok(job, 'a preview should start without tvRoot or movieRoot');
});
