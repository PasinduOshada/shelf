// Library tools against a throwaway database: reviews and progress, TV Time
// import (zip + CSV), backup round trip, duplicates and the trash guard,
// Trakt mapping, media info, playback and subtitle choices, airing alerts.
// No network, no real files outside a temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

let work;
let db;
let m = {};
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-extras-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  ({ db } = await import('../src/db.js'));
  m.watch = await import('../src/watch.js');
  m.tvtime = await import('../src/importers/tvtime.js');
  m.zip = await import('../src/importers/zip.js');
  m.backup = await import('../src/backup.js');
  m.dupes = await import('../src/duplicates.js');
  m.trash = await import('../src/trash.js');
  m.trakt = await import('../src/importers/trakt.js');
  m.media = await import('../src/mediainfo.js');
  m.playback = await import('../src/playback.js');
  m.subs = await import('../src/autoSubtitles.js');
  m.airing = await import('../src/airing.js');
  seed();
});
after(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function seed() {
  const lib = join(work, 'lib');
  mkdirSync(lib, { recursive: true });
  db.prepare("INSERT INTO libraries (id, path, kind) VALUES ('L1', ?, 'tv')").run(lib);
  db.prepare(`INSERT INTO shows (id, library_id, folder_path, folder_name, title, tmdb_id, episode_runtime)
    VALUES ('S1', 'L1', ?, 'Severance', 'Severance', 95396, 50)`).run(join(lib, 'Severance'));
  db.prepare(`INSERT INTO shows (id, library_id, folder_path, folder_name, title, tmdb_id, episode_group_id)
    VALUES ('S2', 'L1', ?, 'Money Heist', 'Money Heist', 71446, 'grp')`).run(join(lib, 'Money Heist'));
  for (const [id, s, e, air] of [['E1', 1, 1, '2022-02-18'], ['E2', 1, 2, '2022-02-18'], ['E3', 2, 1, iso(today)]]) {
    db.prepare('INSERT INTO episodes (id, show_id, season_number, episode_number, air_date, title) VALUES (?,?,?,?,?,?)')
      .run(id, 'S1', s, e, air, `Ep ${e}`);
  }
  db.prepare("INSERT INTO episodes (id, show_id, season_number, episode_number) VALUES ('MH1', 'S2', 1, 1)").run();
  db.prepare("INSERT INTO movies (id, title, year, tmdb_id, runtime) VALUES ('M1', 'Heat', 1995, 949, 170)").run();

  const f = (id, path, extra) => {
    writeFileSync(path, 'x'.repeat(extra.size || 10));
    db.prepare(`INSERT INTO files (id, path, filename, size_bytes, show_id, episode_id, movie_id, quality, media_info)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, path, id, extra.size || 10, extra.show || null, extra.ep || null,
      extra.movie || null, extra.quality || null, extra.media ? JSON.stringify(extra.media) : null);
  };
  f('F1', join(lib, 'sev-1-720.mkv'), { show: 'S1', ep: 'E1', quality: '720p', size: 100 });
  f('F2', join(lib, 'sev-1-1080.mkv'), { show: 'S1', ep: 'E1', size: 50, media: { quality: '1080p', hdr: 'HDR10', audio: [{ lang: 'en' }], subtitles: [] } });
  f('F3', join(lib, 'sev-3.mkv'), { show: 'S1', ep: 'E3' });
  f('F4', join(lib, 'heat.mkv'), { movie: 'M1' });
}

test('reviews, notes and resume positions', () => {
  assert.deepEqual({ ...m.watch.setEpisodeReview('E1', { rating: 9, note: '  great  ' }) }, { rating: 9, note: 'great' });
  assert.deepEqual({ ...m.watch.setEpisodeReview('E1', { note: '' }) }, { rating: 9, note: null });
  assert.throws(() => m.watch.setEpisodeReview('E1', { rating: 11 }), /1 to 10/);
  assert.equal(m.watch.setMovieReview('nope', { rating: 5 }), null);

  m.watch.saveProgress({ episodeId: 'E2', position: 600, duration: 3000 });
  assert.equal(m.watch.getProgress({ episodeId: 'E2' }).progress_seconds, 600);
  // Marking watched clears the resume point.
  m.watch.setEpisodeWatched('E2', true);
  assert.equal(m.watch.getProgress({ episodeId: 'E2' }).progress_seconds, null);
  m.watch.setEpisodeWatched('E2', false);
});

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('TV Time export: zip, CSV quirks, matching, and a harmless second import', () => {
  const tracking = [
    'uuid,type,series_name,movie_name,season_number,episode_number,created_at',
    '1,watch,Severance,,1,1,2024-03-01 20:00:00',
    '2,watch,"Severance",,1,2,2024-03-02 20:00:00',
    '3,follow,Severance,,,,2024-01-01 00:00:00',
    '4,watch,Unknown Show,,1,1,2024-03-03 00:00:00',
    '5,watch,,Heat,,,2024-04-01 21:00:00',
    '6,watch,"Show, With Comma",,1,1,2024-04-02 00:00:00',
    '7,watch,Severance,,5,9,2024-04-02 00:00:00',
  ].join('\r\n');
  const seen = 'tv_show_name,episode_season_number,episode_number,created_at\nSeverance,1,1,2024-03-01 20:00:00\n';
  const upload = zip([['export/tracking-prod-records-v2.csv', tracking], ['export/seen_episode_latest.csv', seen], ['export/user.csv', 'a,b\n1,2']]);

  assert.equal(m.zip.readZip(upload).length, 3);
  const preview = m.tvtime.previewImport([{ buffer: upload, originalname: 'tvtime.zip' }]);
  assert.deepEqual(preview.found, { episodes: 6, movies: 1 });
  assert.deepEqual(preview.matched, { episodes: 2, movies: 1 });
  assert.equal(preview.not_in_shelf, 1);
  assert.deepEqual(preview.unmatched_shows.map((s) => s.title).sort(), ['Show, With Comma', 'Unknown Show']);

  const applied = m.tvtime.applyImport(preview.import_id);
  assert.deepEqual(applied.marked, { episodes: 2, movies: 1 });
  const at = db.prepare("SELECT watched_at FROM watch_history WHERE episode_id = 'E1'").get().watched_at;
  assert.equal(at, '2024-03-01 20:00:00');

  const again = m.tvtime.previewImport([{ buffer: upload }]);
  assert.deepEqual(m.tvtime.applyImport(again.import_id).marked, { episodes: 0, movies: 0 });
  assert.throws(() => m.tvtime.applyImport(again.import_id), /expired/);
});

test('backup round trip restores onto a fresh library, without secrets', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tmdb.apiKey', 'secret'), ('player.watchedAt', '85')").run();
  db.prepare("UPDATE shows SET is_favorite = 1, notes = 'rewatch' WHERE id = 'S1'").run();
  const backup = m.backup.exportBackup();
  const text = JSON.stringify(backup);
  assert.ok(!text.includes('secret'));
  assert.ok(backup.history.length >= 3);

  // Wipe the user's state, keep the library, then restore.
  db.exec("DELETE FROM watch_history; DELETE FROM episode_state; DELETE FROM movie_state; UPDATE shows SET is_favorite = 0, notes = NULL");
  db.prepare("DELETE FROM settings WHERE key = 'player.watchedAt'").run();
  const r = m.backup.importBackup(JSON.parse(text));
  assert.ok(r.history >= 3);
  const s = db.prepare("SELECT is_favorite, notes FROM shows WHERE id = 'S1'").get();
  assert.deepEqual({ ...s }, { is_favorite: 1, notes: 'rewatch' });
  assert.equal(db.prepare("SELECT watched FROM episode_state WHERE episode_id = 'E1'").get().watched, 1);
  assert.equal(db.prepare("SELECT rating FROM episode_state WHERE episode_id = 'E1'").get().rating, 9);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'player.watchedAt'").get().value, '85');

  // Importing the same backup again adds nothing.
  assert.equal(m.backup.importBackup(JSON.parse(text)).history, 0);
  assert.throws(() => m.backup.importBackup({ hello: 1 }), /not a Shelf backup/);
});

test('duplicates: best copy suggested, only-copy guard, trash handler', async () => {
  const groups = m.dupes.duplicateGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep, 'F2'); // 1080p HDR beats a bigger 720p file
  assert.equal(groups[0].reclaim_bytes, 100);

  const trashed = [];
  m.trash.setTrashHandler(async (p) => trashed.push(p));
  await m.dupes.trashDuplicate('F1');
  assert.equal(trashed.length, 1);
  await assert.rejects(m.dupes.trashDuplicate('F2'), /only copy/);
  await assert.rejects(m.dupes.trashDuplicate('F4'), /only copy/);
  assert.equal(m.dupes.duplicateGroups().length, 0);

  // Same "episode", different lengths: misnumbered episodes, never trashed.
  const lib = join(work, 'lib');
  for (const [id, mins] of [['G1', 27], ['G2', 29]]) {
    writeFileSync(join(lib, `${id}.mkv`), 'x');
    db.prepare(`INSERT INTO files (id, path, filename, size_bytes, show_id, episode_id, media_info)
      VALUES (?, ?, ?, 1, 'S1', 'E2', ?)`).run(id, join(lib, `${id}.mkv`), id, JSON.stringify({ duration: mins * 60 }));
  }
  const odd = m.dupes.duplicateGroups().find((g) => g.key === 'E2');
  assert.equal(odd.different_lengths, true);
  assert.equal(odd.keep, null);
  await assert.rejects(m.dupes.trashDuplicate('G1'), /different lengths/);
});

test('Trakt: pull maps by TMDB id and skips custom orderings; push shapes history', () => {
  const pull = m.trakt.mapPull(
    [
      { show: { title: 'Severance', ids: { tmdb: 95396 } }, seasons: [{ number: 2, episodes: [{ number: 1, last_watched_at: '2025-01-17T10:00:00.000Z' }, { number: 9 }] }] },
      { show: { title: 'Money Heist', ids: { tmdb: 71446 } }, seasons: [{ number: 1, episodes: [{ number: 1 }] }] },
      { show: { title: 'Not here', ids: { tmdb: 1 } }, seasons: [] },
    ],
    [{ movie: { ids: { tmdb: 949 } }, last_watched_at: '2025-01-01T00:00:00.000Z' }]
  );
  assert.deepEqual(pull.episodes.map((e) => e.episodeId), ['E3']);
  assert.deepEqual(pull.movies.map((x) => x.movieId), ['M1']);
  assert.deepEqual(pull.skippedOrdering, ['Money Heist']);

  const push = m.trakt.mapPush('2000-01-01');
  assert.ok(push.movies.some((x) => x.ids.tmdb === 949));
  const sev = push.shows.find((x) => x.ids.tmdb === 95396);
  assert.ok(sev.seasons[0].episodes.some((e) => e.number === 1 && e.watched_at === '2024-03-01T20:00:00.000Z'));
  assert.ok(!push.shows.some((x) => x.ids.tmdb === 71446));

  assert.throws(() => m.trakt.setTraktApp({ clientId: 'short', clientSecret: 'x' }), /64 characters/);
});

test('media info: resolution labels and stream summary', () => {
  assert.equal(m.media.qualityFor(1920, 800), '1080p');
  assert.equal(m.media.qualityFor(3840, 1600), '2160p');
  assert.equal(m.media.qualityFor(1280, 536), '720p');
  assert.equal(m.media.qualityFor(720, 576), '576p');
  assert.equal(m.media.qualityFor(720, 480), '480p');
  const s = m.media.summarize({
    format: { duration: '3434.5', tags: { title: 'ARCHIE' } },
    streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, color_transfer: 'smpte2084', pix_fmt: 'yuv420p10le' },
      { codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'hin' } },
      { codec_type: 'subtitle', tags: { language: 'eng', title: 'English (SDH)' }, disposition: {} },
    ],
  });
  assert.deepEqual(
    [s.duration, s.quality, s.video_codec, s.hdr, s.bit_depth, s.audio[0].lang, s.subtitles[0].lang, s.subtitles[0].hi, s.title],
    [3435, '2160p', 'HEVC', 'HDR10', 10, 'hi', 'en', true, 'ARCHIE']
  );
});

test('playback: players that can be followed, and how they are started', async () => {
  assert.equal(m.playback.playerKind('C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'), 'vlc');
  assert.equal(m.playback.playerKind('C:\\mpv\\mpv.exe'), 'mpv');
  assert.equal(m.playback.playerKind('C:\\MPC-HC\\mpc-hc64.exe'), 'mpc');
  assert.equal(m.playback.playerKind('C:\\Windows Media Player\\wmplayer.exe'), null);
  const vlc = await m.playback.launchArgs('vlc', 'C:\\a b.mkv', 125.7);
  assert.equal(vlc.args[0], 'C:\\a b.mkv');
  assert.ok(vlc.args.includes('--start-time=125'));
  assert.ok(vlc.args.includes('--http-host=127.0.0.1'));
  assert.match(vlc.channel.password, /^[a-f0-9]{24}$/);
  const mpv = await m.playback.launchArgs('mpv', 'x.mkv', 0);
  assert.ok(!mpv.args.some((a) => a.startsWith('--start')));
});

test('automatic subtitles only take confident picks', () => {
  const r = (o) => ({ machine: false, hash_match: false, trusted: false, downloads: 0, ...o });
  assert.equal(m.subs.pickSubtitle([r({ file_id: 1, downloads: 50 })]), null);
  assert.equal(m.subs.pickSubtitle([r({ file_id: 1, downloads: 50 }), r({ file_id: 2, hash_match: true })]).file_id, 2);
  assert.equal(m.subs.pickSubtitle([r({ file_id: 3, hash_match: true, machine: true })]), null);
  assert.equal(m.subs.pickSubtitle([r({ file_id: 4, trusted: true, downloads: 150 })]).file_id, 4);
});

test('new-episode alerts fire once per episode', () => {
  let heard = [];
  m.airing.airingEvents.on('aired', (list) => (heard = list));
  const first = m.airing.checkAiring();
  assert.deepEqual(first.map((e) => e.id), ['E3']);
  assert.equal(heard.length, 1);
  assert.deepEqual(m.airing.checkAiring(), []);
  assert.ok(existsSync(join(work, 'lib')));
});
