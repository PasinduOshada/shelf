-- Shelf: local-first media library + watch tracker.
-- Read-only index of files on disk; all user state lives alongside, never in the files.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('tv', 'movie')),
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_scan   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- shows

CREATE TABLE IF NOT EXISTS shows (
  id              TEXT PRIMARY KEY,
  library_id      TEXT REFERENCES libraries(id) ON DELETE SET NULL,
  folder_path     TEXT UNIQUE,
  folder_name     TEXT,

  title           TEXT NOT NULL,
  sort_title      TEXT,
  year            INTEGER,

  tmdb_id         INTEGER,
  tmdb_status     TEXT,              -- unmatched | matched | manual | failed
  overview        TEXT,
  poster_path     TEXT,              -- TMDB relative path
  backdrop_path   TEXT,
  genres          TEXT,              -- JSON array
  network         TEXT,
  status          TEXT,              -- Returning Series | Ended | Canceled
  first_air_date  TEXT,
  last_air_date   TEXT,
  vote_average    REAL,
  episode_runtime INTEGER,           -- minutes, typical

  -- next unaired episode, cached from TMDB for countdowns
  next_air_date   TEXT,
  next_season     INTEGER,
  next_episode    INTEGER,
  next_title      TEXT,

  -- user customisation
  custom_poster   TEXT,              -- /uploads/<file>
  icon_emoji      TEXT,
  accent_color    TEXT,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  user_status     TEXT,              -- watching | completed | paused | dropped | planned
  user_rating     INTEGER,
  notes           TEXT,
  tags            TEXT,              -- JSON array

  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shows_tmdb ON shows(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_shows_title ON shows(sort_title);

CREATE TABLE IF NOT EXISTS seasons (
  id             TEXT PRIMARY KEY,
  show_id        TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season_number  INTEGER NOT NULL,
  name           TEXT,
  overview       TEXT,
  poster_path    TEXT,
  air_date       TEXT,
  episode_count  INTEGER,            -- authoritative count from TMDB
  UNIQUE (show_id, season_number)
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  show_id         TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season_number   INTEGER NOT NULL,
  episode_number  INTEGER NOT NULL,
  tmdb_id         INTEGER,
  title           TEXT,
  overview        TEXT,
  air_date        TEXT,
  runtime         INTEGER,
  still_path      TEXT,
  vote_average    REAL,
  UNIQUE (show_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, season_number, episode_number);
CREATE INDEX IF NOT EXISTS idx_episodes_air ON episodes(air_date);

-- ---------------------------------------------------------------- movies

CREATE TABLE IF NOT EXISTS collections (
  id           TEXT PRIMARY KEY,
  tmdb_id      INTEGER,
  name         TEXT NOT NULL,
  poster_path  TEXT,
  custom_poster TEXT,
  icon_emoji   TEXT
);

CREATE TABLE IF NOT EXISTS movies (
  id             TEXT PRIMARY KEY,
  library_id     TEXT REFERENCES libraries(id) ON DELETE SET NULL,
  collection_id  TEXT REFERENCES collections(id) ON DELETE SET NULL,

  title          TEXT NOT NULL,
  sort_title     TEXT,
  year           INTEGER,

  tmdb_id        INTEGER,
  tmdb_status    TEXT,
  overview       TEXT,
  poster_path    TEXT,
  backdrop_path  TEXT,
  genres         TEXT,
  runtime        INTEGER,
  release_date   TEXT,
  vote_average   REAL,
  tagline        TEXT,

  custom_poster  TEXT,
  icon_emoji     TEXT,
  accent_color   TEXT,
  is_favorite    INTEGER NOT NULL DEFAULT 0,
  user_rating    INTEGER,
  notes          TEXT,
  tags           TEXT,

  added_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movies_tmdb ON movies(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(sort_title);

-- ---------------------------------------------------------------- files

CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  parent_dir    TEXT,
  ext           TEXT,
  size_bytes    INTEGER,
  mtime         TEXT,

  show_id       TEXT REFERENCES shows(id) ON DELETE CASCADE,
  episode_id    TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  movie_id      TEXT REFERENCES movies(id) ON DELETE CASCADE,

  -- parsed-from-filename, kept even when no episode row matched yet
  parsed_season  INTEGER,
  parsed_episode INTEGER,
  quality        TEXT,
  codec          TEXT,
  source         TEXT,

  is_missing    INTEGER NOT NULL DEFAULT 0,   -- row kept, file gone from disk
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_show ON files(show_id);
CREATE INDEX IF NOT EXISTS idx_files_episode ON files(episode_id);
CREATE INDEX IF NOT EXISTS idx_files_movie ON files(movie_id);

-- ---------------------------------------------------------------- watch state

CREATE TABLE IF NOT EXISTS episode_state (
  episode_id   TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  show_id      TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  watched      INTEGER NOT NULL DEFAULT 0,
  watched_at   TEXT,
  play_count   INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_epstate_show ON episode_state(show_id, watched);

CREATE TABLE IF NOT EXISTS movie_state (
  movie_id    TEXT PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
  watched     INTEGER NOT NULL DEFAULT 0,
  watched_at  TEXT,
  play_count  INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER,
  note        TEXT
);

-- Append-only log powering stats, streaks, weekly/monthly recaps and Wrapped.
CREATE TABLE IF NOT EXISTS watch_history (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('episode', 'movie')),
  episode_id   TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  movie_id     TEXT REFERENCES movies(id) ON DELETE CASCADE,
  show_id      TEXT REFERENCES shows(id) ON DELETE CASCADE,
  watched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  minutes      INTEGER NOT NULL DEFAULT 0,
  is_rewatch   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_history_at ON watch_history(watched_at);
CREATE INDEX IF NOT EXISTS idx_history_show ON watch_history(show_id);

-- ---------------------------------------------------------------- misc

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Every file operation the user performs through the app, for undo + audit.
CREATE TABLE IF NOT EXISTS file_operations (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT,                   -- groups one "Apply" run so it can be undone together
  op          TEXT NOT NULL,          -- move | rename
  from_path   TEXT NOT NULL,
  to_path     TEXT NOT NULL,
  status      TEXT NOT NULL,          -- pending | done | undone | failed
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- idx_fileops_batch is created in db.js, after the batch_id migration runs.
