// Titles you follow that are not on this computer.
//
// A tracked title is an ordinary show or film row with no library and no
// folder: metadata and watch history, no files. That is the whole difference.
// Everything else — episodes, ratings, notes, statistics — works the same,
// which is also why deleting a download never costs you the record: the files
// go, the row and its history stay.
import { randomUUID } from 'node:crypto';
import { db, sortTitle } from './db.js';
import { enrichShow, enrichMovie, hasApiKey } from './tmdb.js';
import * as q from './queries.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const read = (kind, id) => (kind === 'show' ? q.getShow(id) : q.getMovie(id));

/** The same title already in the library, matched the way a scan would. */
function findExisting(kind, tmdbId, title, year) {
  const table = kind === 'show' ? 'shows' : 'movies';
  if (tmdbId) {
    const hit = db.prepare(`SELECT id FROM ${table} WHERE tmdb_id = ?`).get(tmdbId);
    if (hit) return hit;
  }
  if (!title) return null;
  return db
    .prepare(`SELECT id FROM ${table} WHERE sort_title = ? AND IFNULL(year, -1) = IFNULL(?, -1)`)
    .get(sortTitle(title), year ?? null);
}

/**
 * Start following a title. With a TMDB id it arrives with its artwork and,
 * for a series, its episode list, so episodes can be ticked off straight away.
 * Without one it is just a name and a year, which is enough to record that you
 * watched it.
 */
export async function addTracked({ kind, tmdbId = null, title = '', year = null }) {
  if (kind !== 'show' && kind !== 'movie') throw fail("kind must be 'show' or 'movie'");
  const id = tmdbId ? Number(tmdbId) : null;
  const name = String(title || '').trim();
  const when = year ? Number(year) : null;
  if (!id && !name) throw fail('Give a title to follow, or pick one from the search');
  if (id && !hasApiKey()) throw fail('Add a TMDB API key in Settings first.');

  const existing = findExisting(kind, id, name, when);
  if (existing) return { ...read(kind, existing.id), already_had_it: true };

  const rowId = randomUUID();
  const label = name || 'Untitled';
  if (kind === 'show') {
    db.prepare(
      `INSERT INTO shows (id, title, sort_title, year, tmdb_status)
       VALUES (?, ?, ?, ?, 'unmatched')`
    ).run(rowId, label, sortTitle(label), when);
  } else {
    db.prepare(
      `INSERT INTO movies (id, title, sort_title, year, tmdb_status)
       VALUES (?, ?, ?, ?, 'unmatched')`
    ).run(rowId, label, sortTitle(label), when);
  }

  if (id) {
    let result;
    try {
      result = kind === 'show' ? await enrichShow(rowId, id) : await enrichMovie(rowId, id);
    } catch (err) {
      removeRow(kind, rowId);
      throw fail(`TMDB could not be reached: ${err.message || err}`, 502);
    }
    if (!result?.ok) {
      removeRow(kind, rowId);
      throw fail('TMDB does not have that title any more', 404);
    }
  }
  return read(kind, rowId);
}

function removeRow(kind, id) {
  db.prepare(`DELETE FROM ${kind === 'show' ? 'shows' : 'movies'} WHERE id = ?`).run(id);
}

/**
 * Stop following a title, and forget what you watched of it. Refused once
 * files exist: that one belongs to the library, and removing it is a job for
 * the folder it lives in.
 */
export function removeTracked(kind, id) {
  if (kind !== 'show' && kind !== 'movie') throw fail("kind must be 'show' or 'movie'");
  const table = kind === 'show' ? 'shows' : 'movies';
  const column = kind === 'show' ? 'show_id' : 'movie_id';
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw fail('Not found', 404);

  // Only files that are actually there count. Someone who deleted the videos
  // and rescanned is left with rows pointing at nothing, and refusing to let
  // go of the title because of those would be refusing for no reason.
  const present = db
    .prepare(`SELECT COUNT(*) c FROM files WHERE ${column} = ? AND is_missing = 0`)
    .get(id).c;
  if (present) {
    throw fail('This one has files in your library, so it stays. Remove the files instead.', 409);
  }
  db.prepare(`DELETE FROM files WHERE ${column} = ?`).run(id);
  removeRow(kind, id);
  return { ok: true };
}
