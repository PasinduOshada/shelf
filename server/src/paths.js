// Writable paths, env-overridable so an Electron wrapper can redirect them
// to userData without touching the rest of the server.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');

export const DATA_DIR = process.env.SHELF_DATA_DIR
  ? resolve(process.env.SHELF_DATA_DIR)
  : join(serverRoot, 'data');

export const DB_PATH = process.env.SHELF_DB_PATH
  ? resolve(process.env.SHELF_DB_PATH)
  : join(DATA_DIR, 'shelf.db');

export const UPLOADS_DIR = process.env.SHELF_UPLOADS_DIR
  ? resolve(process.env.SHELF_UPLOADS_DIR)
  : join(DATA_DIR, 'uploads');

export const CLIENT_DIST = process.env.SHELF_CLIENT_DIST
  ? resolve(process.env.SHELF_CLIENT_DIST)
  : join(serverRoot, '..', 'client', 'dist');

export function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(UPLOADS_DIR, { recursive: true });
}
