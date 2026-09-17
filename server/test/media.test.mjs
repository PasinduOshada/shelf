// Subtitle helpers and the local-only request guard. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let subs;
let app;
let work;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-media-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  subs = await import('../src/subtitles.js');
  app = await import('../src/app.js');
});
after(async () => {
  (await import('../src/db.js')).db.close();
  rmSync(work, { recursive: true, force: true });
});

test('OpenSubtitles hash: size plus first and last 64 KB as little-endian words', async () => {
  const zeros = join(work, 'zeros.bin');
  writeFileSync(zeros, Buffer.alloc(131072));
  assert.equal(await subs.movieHash(zeros), '0000000000020000');

  // Every word 1 in both chunks: 8192 + 8192 words, plus the size.
  const ones = Buffer.alloc(65536);
  for (let i = 0; i < ones.length; i += 8) ones.writeBigUInt64LE(1n, i);
  const file = join(work, 'ones.bin');
  writeFileSync(file, ones);
  assert.equal(await subs.movieHash(file), (65536n + 16384n).toString(16).padStart(16, '0'));

  const tiny = join(work, 'tiny.bin');
  writeFileSync(tiny, 'short');
  assert.equal(await subs.movieHash(tiny), null);
});

test('finds subtitles named after a video, with their language', () => {
  const names = [
    'Film (2024).mkv', 'Film (2024).srt', 'Film (2024).en.srt', 'Film (2024).si.forced.ass',
    'Film (2024) extras.srt', 'Other.en.srt', 'Film (2024).nfo',
  ];
  const found = subs.localSubtitles('C:/x/Film (2024).mkv', names);
  assert.deepEqual(found.map((s) => [s.name, s.lang, s.format]), [
    ['Film (2024).srt', null, 'srt'],
    ['Film (2024).en.srt', 'en', 'srt'],
    ['Film (2024).si.forced.ass', 'si', 'ass'],
    ['Film (2024) extras.srt', null, 'srt'],
  ]);
});

test('language preferences are validated', () => {
  assert.equal(subs.setSubtitlePrefs({ languages: 'EN, si,ta, en' }).languages, 'en,si,ta');
  assert.throws(() => subs.setSubtitlePrefs({ languages: 'english' }), /language codes/);
});

function guard(headers) {
  let status = 200;
  let passed = false;
  const res = { status: (s) => ({ json: () => { status = s; } }) };
  app.localOnly({ headers }, res, () => { passed = true; });
  return passed ? 'pass' : status;
}

test('the API answers only this computer', () => {
  assert.equal(guard({ host: 'localhost:5180' }), 'pass');
  assert.equal(guard({ host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' }), 'pass');
  assert.equal(guard({ host: '[::1]:4100' }), 'pass');
  // DNS rebinding: an attacker's name pointed at 127.0.0.1.
  assert.equal(guard({ host: 'evil.example:4100' }), 403);
  // A web page posting to the local API.
  assert.equal(guard({ host: 'localhost:4100', origin: 'https://evil.example' }), 403);
  assert.equal(guard({}), 403);
});
