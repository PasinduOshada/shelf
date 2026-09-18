// Credential storage: readable without a vault, encrypted with one, and
// unreadable to anyone who cannot open the vault.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let secrets;
let db;
let work;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'shelf-secrets-'));
  process.env.SHELF_DATA_DIR = join(work, 'data');
  process.env.SHELF_DB_PATH = join(work, 'data', 'test.db');
  mkdirSync(process.env.SHELF_DATA_DIR);
  db = await import('../src/db.js');
  secrets = await import('../src/secrets.js');
});
after(() => {
  db.db.close();
  rmSync(work, { recursive: true, force: true });
});

// Stands in for Windows DPAPI: reversible, and only with this "account".
const vault = {
  encrypt: (text) => Buffer.from(`acct:${text}`).toString('base64'),
  decrypt: (data) => {
    const out = Buffer.from(data, 'base64').toString();
    if (!out.startsWith('acct:')) throw new Error('not ours');
    return out.slice(5);
  },
};

test('without a vault, values are stored as they are', () => {
  secrets.setSecret('tmdb.apiKey', 'plain-key');
  assert.equal(db.getSetting('tmdb.apiKey'), 'plain-key');
  assert.equal(secrets.getSecret('tmdb.apiKey'), 'plain-key');
  assert.equal(secrets.secretsEncrypted(), false);
});

test('a brand new vault is trusted only once it has proved it persists', () => {
  secrets.setSecretVault(vault);
  // First run: the vault might lose its key before the next start, so the
  // readable copy stays put.
  assert.equal(db.getSetting('tmdb.apiKey'), 'plain-key');
  assert.equal(secrets.getSecret('tmdb.apiKey'), 'plain-key');
  assert.equal(secrets.secretsEncrypted(), true);
});

test('a vault that survived a restart takes over the saved keys', () => {
  secrets.setSecretVault(vault);
  const stored = db.getSetting('tmdb.apiKey');
  assert.ok(stored.startsWith('enc.v1:'));
  assert.ok(!stored.includes('plain-key'));
  assert.equal(secrets.getSecret('tmdb.apiKey'), 'plain-key');
});

test('new values round trip and never sit in the database as text', () => {
  secrets.setSecret('opensubtitles.token', 'tok-123');
  assert.ok(!db.getSetting('opensubtitles.token').includes('tok-123'));
  assert.equal(secrets.getSecret('opensubtitles.token'), 'tok-123');
});

test('clearing a value empties it outright', () => {
  secrets.setSecret('opensubtitles.token', '');
  assert.equal(db.getSetting('opensubtitles.token'), '');
  assert.equal(secrets.getSecret('opensubtitles.token'), null);
});

test('another account, or none, cannot read it', () => {
  secrets.setSecretVault({ encrypt: vault.encrypt, decrypt: () => { throw new Error('wrong user'); } });
  assert.equal(secrets.getSecret('tmdb.apiKey'), null);
  assert.equal(secrets.getSecret('tmdb.apiKey', 'fallback'), 'fallback');
  secrets.setSecretVault(null);
  assert.equal(secrets.getSecret('tmdb.apiKey'), null);
});

test('missing keys come back as the fallback', () => {
  assert.equal(secrets.getSecret('trakt.accessToken'), null);
  assert.equal(secrets.getSecret('trakt.accessToken', ''), '');
});

test('a vault with a new key never re-encrypts what it cannot read', () => {
  // Keys rotate when the profile loses its own key store.
  const other = {
    encrypt: (text) => Buffer.from(`else:${text}`).toString('base64'),
    decrypt: (data) => {
      const out = Buffer.from(data, 'base64').toString();
      if (!out.startsWith('else:')) throw new Error('not ours');
      return out.slice(5);
    },
  };
  secrets.setSecretVault(null);
  secrets.setSecret('trakt.clientSecret', 'shhh');
  secrets.setSecretVault(other);
  // The old ciphertext is unreadable, but the plain one is left alone rather
  // than being locked away by a vault that has not proved itself.
  assert.equal(secrets.getSecret('tmdb.apiKey'), null);
  assert.equal(db.getSetting('trakt.clientSecret'), 'shhh');
  secrets.setSecretVault(other);
  assert.ok(db.getSetting('trakt.clientSecret').startsWith('enc.v1:'));
  assert.equal(secrets.getSecret('trakt.clientSecret'), 'shhh');
});
