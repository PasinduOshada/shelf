// Watched-folder organising, against throwaway folders and a throwaway DB.
// No network: there is no TMDB key, so "sure" means an unambiguous name.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let auto;
let work;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-auto-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  auto = await import('../src/autoOrganize.js');
});
after(async () => {
  (await import('../src/db.js')).db.close();
  rmSync(work, { recursive: true, force: true });
});

// Files "finished downloading" an hour ago.
function old(path, content = 'x') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const t = new Date(Date.now() - 3600_000);
  utimesSync(path, t, t);
}

test('only confident items move without asking', () => {
  assert.equal(auto.isConfident({ status: 'ok', source: 'tmdb', confidence: 'high' }, true), true);
  // TMDB found *something* for a yearless home video: still not sure.
  assert.equal(auto.isConfident({ status: 'ok', source: 'tmdb', confidence: 'medium' }, true), false);
  assert.equal(auto.isConfident({ status: 'ok', source: 'filename', confidence: 'high' }, true), false);
  assert.equal(auto.isConfident({ status: 'ok', source: 'filename', confidence: 'high' }, false), true);
  assert.equal(auto.isConfident({ status: 'ok', source: 'filename', confidence: 'medium' }, false), false);
  assert.equal(auto.isConfident({ status: 'busy', source: 'tmdb' }, true), false);
});

test('settings are validated before they are saved', () => {
  const dl = join(work, 'Downloads');
  mkdirSync(dl, { recursive: true });
  assert.throws(() => auto.setAutoConfig({ enabled: true, folders: [] }), /at least one folder/);
  assert.throws(() => auto.setAutoConfig({ folders: [join(work, 'missing')] }), /does not exist/);
  // Watching a folder that contains the destination would loop forever.
  assert.throws(
    () => auto.setAutoConfig({ enabled: true, folders: [dl], tvRoot: join(dl, 'TV'), movieRoot: join(work, 'Movies') }),
    /picked up again/
  );
  assert.throws(() => auto.setAutoConfig({ intervalMinutes: 2 }), /Unsupported interval/);
  assert.equal(auto.autoConfig().enabled, false);
});

test('a pass moves finished, recognisable downloads and leaves the rest', async () => {
  const dl = join(work, 'Downloads');
  const media = join(work, 'Media');
  mkdirSync(media, { recursive: true });
  old(join(dl, 'Severance.S02E03.1080p.WEB.mkv'), 'ep');
  old(join(dl, 'Heat.1995.1080p.BluRay.mkv'), 'film');
  old(join(dl, 'Some Home Video.mp4'), 'no year, so not sure'); // medium confidence: waits
  old(join(dl, 'VID_20250101_101010.mp4'), 'phone'); // not recognised: waits
  old(join(dl, 'Fallout.S02E01.mkv'), 'partial');
  old(join(dl, 'Fallout.S02E01.mkv.part'), ''); // still downloading: untouched

  auto.setAutoConfig({
    enabled: true,
    folders: [dl],
    tvRoot: join(media, 'TV Series'),
    movieRoot: join(media, 'Movies'),
    options: { useTmdb: false },
    settleMinutes: 1,
  });

  const entry = await auto.runAutoOrganize({ manual: true });
  assert.equal(entry.moved, 2);
  assert.equal(entry.downloading, 1);
  assert.equal(entry.waiting, 2);
  assert.ok(existsSync(join(media, 'TV Series', 'Severance', 'Season 02', 'Severance - S02E03 - 1080p.mkv')));
  assert.ok(existsSync(join(media, 'Movies', 'Heat (1995)', 'Heat (1995) - 1080p.mkv')));
  assert.ok(existsSync(join(dl, 'Some Home Video.mp4')));
  assert.ok(existsSync(join(dl, 'Fallout.S02E01.mkv')));

  const status = auto.autoStatus();
  assert.equal(status.pending.count, 2);
  assert.equal(status.log[0].batch_id, entry.batch_id);

  // Review mode reports but moves nothing.
  old(join(dl, 'Heat.1995.2160p.mkv'), '4k');
  auto.setAutoConfig({ mode: 'review' });
  const review = await auto.runAutoOrganize({ manual: true });
  assert.equal(review.moved, 0);
  assert.equal(review.waiting, 3);
  assert.ok(existsSync(join(dl, 'Heat.1995.2160p.mkv')));

  auto.setAutoConfig({ enabled: false });
});

test('a watched folder that is not there is waited for, not reported as broken', async () => {
  // An external drive that is unplugged used to throw on every pass: a log
  // entry and a desktop notification every few minutes until it came back.
  const watching = join(work, 'watch-unplugged');
  const dest = join(work, 'dest-unplugged');
  mkdirSync(watching, { recursive: true });
  mkdirSync(join(dest, 'TV'), { recursive: true });
  mkdirSync(join(dest, 'Films'), { recursive: true });

  auto.setAutoConfig({
    enabled: true,
    folders: [watching],
    tvRoot: join(dest, 'TV'),
    movieRoot: join(dest, 'Films'),
    options: { useTmdb: false },
    settleMinutes: 1,
  });

  // The drive goes away.
  rmSync(watching, { recursive: true, force: true });

  const before = auto.autoStatus().log.length;
  const entry = await auto.runAutoOrganize({ manual: true });

  assert.ok(entry, 'a manual run should report something');
  assert.equal(entry.error, undefined, `it should not be an error: ${entry.error}`);
  assert.equal(entry.skipped, true, 'it should say it skipped the pass');
  assert.ok(entry.unreachable.includes(watching), 'it should name the folder it could not reach');
  assert.equal(entry.moved, 0);
  assert.equal(auto.autoStatus().log.length, before, 'nothing should be written to the log');

  // Leave nothing watching a folder that is gone, or the timer outlives the run.
  auto.setAutoConfig({ enabled: false, folders: [] });
});
