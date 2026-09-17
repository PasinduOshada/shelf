// Regression tests for TMDB title matching, using the real misspelled folder
// names from this library and TMDB-shaped search results (with decoys).
// Pure functions only: no network, and a throwaway database.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let m;
before(async () => {
  // tmdb.js imports db.js, which opens a database; keep it away from the real one.
  process.env.SHELF_DATA_DIR = mkdtempSync(join(tmpdir(), 'shelf-match-'));
  process.env.SHELF_DB_PATH = join(process.env.SHELF_DATA_DIR, 'test.db');
  m = await import('../src/tmdb.js');
});

const tv = (name, first_air_date, popularity = 10) => ({ name, original_name: name, first_air_date, popularity });
const film = (title, release_date, popularity = 10) => ({ title, original_title: title, release_date, popularity });

function picks(results, locals, year, kind, expected) {
  const best = m.pickBest(results, locals, year, kind);
  const name = best.result.name || best.result.title;
  assert.equal(name, expected, `${locals[0]} picked "${name}" (score ${best.score.toFixed(2)})`);
  assert.ok(best.score >= m.MATCH_THRESHOLD, `${locals[0]} scored only ${best.score.toFixed(2)}`);
}

test('misspelled and trimmed folder names still match the right series', () => {
  picks(
    [tv('The Raincoat Killer: Chasing a Predator in Korea', '2021-05-07'), tv('Killer Instinct', '2005-09-23')],
    ['Tha Raincoat Killer'], null, 'tv',
    'The Raincoat Killer: Chasing a Predator in Korea'
  );
  picks(
    [tv('Fight Night: The Million Dollar Heist', '2024-09-18'), tv('Friday Night Lights', '2006-10-03', 60)],
    ['FIght Night The Million Doller heist'], null, 'tv',
    'Fight Night: The Million Dollar Heist'
  );
  picks(
    [tv('Indian Predator: The Butcher of Delhi', '2022-07-20'), tv('Predator', '2010-01-01', 40)],
    ['Butcher of Delhi'], null, 'tv',
    'Indian Predator: The Butcher of Delhi'
  );
  picks(
    [tv('Oggy and the Cockroaches', '1998-09-06', 30), tv('Oggy Oggy', '2021-08-23', 5)],
    ['Oggy & The Crokroachers', 'Oggy and the Cockroaches Bitter Chocolate'], null, 'tv',
    'Oggy and the Cockroaches'
  );
});

test('the episode-filename title beats a vaguer folder name', () => {
  picks(
    [tv('House of the Dragon', '2022-08-21', 90), tv('Dragons: Race to the Edge', '2015-06-26', 20)],
    ['House of the Dragon', 'House Of The Dragons'], 2022, 'tv',
    'House of the Dragon'
  );
  picks(
    [tv('Your Friendly Neighborhood Spider-Man', '2025-01-29'), tv('Spider-Man', '1994-11-19', 50)],
    ['Your Friendly Neighborhood Spider-Man', 'Your Friendly Neighbourhood Spiderman'], null, 'tv',
    'Your Friendly Neighborhood Spider-Man'
  );
});

test('year breaks ties between remakes', () => {
  picks(
    [film('How to Train Your Dragon', '2010-03-18', 80), film('How to Train Your Dragon', '2025-06-06', 70)],
    ['How to Trian Your Dragon'], 2025, 'movie',
    'How to Train Your Dragon'
  );
  const best = m.pickBest(
    [film('How to Train Your Dragon', '2010-03-18', 80), film('How to Train Your Dragon', '2025-06-06', 70)],
    ['How to Trian Your Dragon'], 2025, 'movie'
  );
  assert.equal(best.result.release_date, '2025-06-06');
});

test('a short generic title does not swallow an unrelated long one', () => {
  // "Missing" is contained in the local name but is a different film.
  assert.ok(m.similarity('wijesingheᴺˢ Missing You', 'Missing') < m.MATCH_THRESHOLD);
  assert.ok(m.similarity('wijesingheᴺˢ Missing You', 'Missing You') >= m.MATCH_THRESHOLD);
  // Screen-recording junk never matches anything.
  assert.ok(m.similarity('DOC-20251014-WA0001', 'Doc') < m.MATCH_THRESHOLD);
});

test('fallback queries recover from typos and junk prefixes', () => {
  const q = m.candidateQueries(['How to Trian Your Dragon']);
  assert.ok(q.includes('your dragon'), `no tail query in ${JSON.stringify(q)}`);

  const oggy = m.candidateQueries(['Oggy and the Cockroaches Bitter Chocolate', 'Oggy & The Crokroachers']);
  assert.ok(oggy.includes('oggy'), `no single-word fallback in ${JSON.stringify(oggy)}`);

  const uploader = m.candidateQueries(['wijesingheᴺˢ Missing You']);
  assert.ok(uploader.includes('missing you'), `no drop-first-word query in ${JSON.stringify(uploader)}`);

  assert.ok(q.length <= 7);
});

test('censored titles and number words compare equal (found on the real library)', () => {
  picks(
    [tv('The End of the F***ing World', '2017-10-24'), tv('Carol & the End of the World', '2023-12-15')],
    ['The End of the Fucking World', 'End of The Fucking world'], null, 'tv',
    'The End of the F***ing World'
  );

  // TMDB spells the film with a digit, and a same-named premiere special
  // (video: true) exists. The special won before number words were handled.
  const premiere = "Marvel Studios' The Fantastic Four: First Steps - World Premiere";
  picks(
    [
      { title: 'The Fantastic 4: First Steps', original_title: 'The Fantastic 4: First Steps', release_date: '2025-07-23', popularity: 36, video: false },
      { title: premiere, original_title: premiere, release_date: '2025-07-14', popularity: 2, video: true },
    ],
    ['The Fantastic Four First Steps'], 2025, 'movie',
    'The Fantastic 4: First Steps'
  );

  // TMDB writes "Shōgun"; without folding the accent, "GoShogun" (1981) won.
  picks(
    [tv('GoShogun', '1981-07-03', 3), tv('Shōgun', '2024-02-27', 80)],
    ['Shogun'], 2024, 'tv',
    'Shōgun'
  );
});

test('episode ordering follows the files on disk (Money Heist, real layouts)', () => {
  // Files: Netflix parts 2-5.
  const owned = [];
  for (const [season, n] of [[2, 9], [3, 8], [4, 8], [5, 10]]) {
    for (let e = 1; e <= n; e++) owned.push({ season, episode: e });
  }
  const layout = (counts) => new Map(counts.map((n, i) => [i + 1, n]));

  const tmdbDefault = layout([15, 16, 10]); // broadcast seasons
  const candidates = [
    { id: 'original', name: 'Original Parts', counts: layout([9, 6, 8, 8, 10]) },
    { id: 'edited', name: 'Parts (edited version)', counts: layout([13, 9, 8, 8, 10]) },
    { id: 'italian', name: 'Italian Parts', counts: layout([13, 9, 8, 8, 10]) },
    { id: 'seasons', name: 'Seasons (edited version)', counts: layout([16, 16, 16]) },
  ];

  assert.equal(m.orderingFit(tmdbDefault, owned), 17);
  const best = m.pickOrdering(tmdbDefault, candidates, owned);
  assert.equal(best.id, 'edited');
  assert.equal(best.fit, 35);

  // A show whose files already fit TMDB's seasons never switches.
  const severance = [...Array(9)].map((_, i) => ({ season: 1, episode: i + 1 }));
  assert.equal(m.pickOrdering(layout([9, 10]), [{ id: 'x', counts: layout([20]) }], severance).id, null);
});
