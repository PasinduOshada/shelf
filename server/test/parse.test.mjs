// Regression tests for the filename parser, drawn from real release names.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, parseFolderName } from '../src/scanner/parse.js';

function check(filename, expected) {
  const parsed = parseFilename(filename);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(parsed[key], value, `${filename} -> ${key}`);
  }
}

test('episodes: scene, P2P and hand-named layouts', () => {
  check('[MPM-EZI]The.End.of.the.Fucking.World.S01E01.720p.10bit.x265.mkv', {
    title: 'The End of the Fucking World', season: 1, episode: 1, quality: '720p', codec: 'x265',
  });
  check('Fargo.S01E01.720p.BluRay.x264-GalaxyTV.mkv', {
    title: 'Fargo', season: 1, episode: 1, source: 'BluRay', codec: 'x264',
  });
  check('Hijack 2023 S02E05 720p 10bit WEBRip 2CH x265 HEVC-PSA.mkv', {
    title: 'Hijack', season: 2, episode: 5,
  });
  check('Vikings.S06E03.720p.HDTV.x265.[@SeriesLand4U] (1).mkv', {
    title: 'Vikings', season: 6, episode: 3,
  });
});

test('episodes: title after the marker', () => {
  check('[TIF]_S02_E01_Fargo_720p_10bit.mkv', { title: 'Fargo', season: 2, episode: 1 });
});

test('underscore-separated names (\\b does not fire next to "_")', () => {
  check('A_Shop_for_Killers_A_K_A_Sarinjaui_Syopingmol_S01E01_KOREAN_720p.mkv', {
    isEpisode: true, season: 1, episode: 1, quality: '720p',
  });
  check('Avatar_Fire_and_Ash_2025_iNTERNAL_720p_10bit_WEBRip_2CH_x265_HEV.mkv', {
    isEpisode: false, title: 'Avatar Fire and Ash', year: 2025, quality: '720p', source: 'WEBRip',
  });
});

test('unusual episode markers', () => {
  check('[MPM] Oggy and the Cockroaches - Bitter Chocolate (s01e01).mp4', { season: 1, episode: 1 });
  check('[MPM-EZI] The Bondsman E01 [720p].mkv', {
    title: 'The Bondsman', season: 1, episode: 1, quality: '720p',
  });
});

test('movies keep words that look like release noise', () => {
  check('The.Godfather.Part.II.1974.REMASTERED.720p.10bit.BluRay.mkv', {
    isEpisode: false, title: 'The Godfather Part II', year: 1974,
  });
  check('Mission.Impossible.-.The.Final.Reckoning.2025.720p.AMZN.WEB-.mkv', {
    title: 'Mission Impossible The Final Reckoning', year: 2025,
  });
  check('Cold Case (2021) Malayalam 720p HDRIp.mkv', { title: 'Cold Case', year: 2021 });
});

test('folder names', () => {
  assert.deepEqual(parseFolderName('Vikings(2013-2020)'), { title: 'Vikings', year: 2013 });
  assert.equal(parseFolderName('Reacher Season 3').title, 'Reacher');
  assert.equal(parseFolderName('Monarch S2').title, 'Monarch');
});

test('initialisms keep their capitals', async () => {
  // From real libraries: lower casing "M*A*S*H" and capitalising the first
  // letter gives "M*a*s*h", and "S.W.A.T" becomes "S W a T" once the dots are
  // spaces, because "a" is a small word.
  const { smartCase } = await import('../src/organizer.js');

  assert.equal(smartCase('m*a*s*h'), 'M*A*S*H');
  assert.equal(smartCase('M*A*S*H'), 'M*A*S*H');
  assert.equal(smartCase('s w a t'), 'S W A T');
  assert.equal(smartCase('u.n.c.l.e'), 'U.N.C.L.E');
  assert.equal(smartCase('the man from u.n.c.l.e'), 'The Man From U.N.C.L.E');

  // Ordinary titles are left as they were.
  assert.equal(smartCase('the last of us'), 'The Last of Us');
  assert.equal(smartCase('THE BEAR'), 'The Bear');
  assert.equal(smartCase('a knight of the seven kingdoms'), 'A Knight of the Seven Kingdoms');
  assert.equal(smartCase('Dune: Part Two'), 'Dune: Part Two');
});
