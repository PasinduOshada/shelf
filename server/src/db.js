import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, ensureDirs } from './paths.js';

const here = dirname(fileURLToPath(import.meta.url));

ensureDirs();

export const db = new DatabaseSync(DB_PATH);

db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// Additive migrations for databases created before a column existed.
// CREATE TABLE IF NOT EXISTS above is a no-op on an existing table.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('file_operations', 'batch_id', 'TEXT');
addColumnIfMissing('movies', 'tmdb_title', 'TEXT');
// Which TMDB episode ordering a show follows (null = TMDB's default seasons).
addColumnIfMissing('shows', 'episode_group_id', 'TEXT');
addColumnIfMissing('shows', 'episode_group_name', 'TEXT');
// When metadata was last pulled, so airing shows can be refreshed.
addColumnIfMissing('shows', 'tmdb_refreshed_at', 'TEXT');
addColumnIfMissing('movies', 'tmdb_refreshed_at', 'TEXT');
// Planned / watching / paused / dropped, the same set shows use.
addColumnIfMissing('movies', 'user_status', 'TEXT');
// Where playback stopped (resume) and how long the file is.
for (const table of ['episode_state', 'movie_state']) {
  addColumnIfMissing(table, 'progress_seconds', 'INTEGER');
  addColumnIfMissing(table, 'duration_seconds', 'INTEGER');
  addColumnIfMissing(table, 'progress_at', 'TEXT');
}
// A person's correction of what a file is, which scans must respect.
addColumnIfMissing('files', 'manual_season', 'INTEGER');
addColumnIfMissing('files', 'manual_episode', 'INTEGER');
// Real stream details read from the file (JSON), and when.
addColumnIfMissing('files', 'media_info', 'TEXT');
addColumnIfMissing('files', 'probed_at', 'TEXT');

db.exec('CREATE INDEX IF NOT EXISTS idx_fileops_batch ON file_operations(batch_id)');

// node:sqlite has no .transaction() helper (that is better-sqlite3).
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? null : String(value));
}

// Title used for alphabetical sorting: drop a leading article, lowercase.
export function sortTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .trim();
}
