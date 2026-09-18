// API keys and sign-in tokens, kept out of plain sight.
//
// The desktop app hands Shelf a vault backed by the operating system (Windows
// DPAPI through Electron's safeStorage), tied to the signed-in user account.
// Values are then stored encrypted, so someone reading the database file, a
// backup of it, or a synced copy of the folder does not get the keys.
//
// Without a vault (running the server on its own, or an OS with no keyring)
// values stay readable, exactly as before: the alternative would be hiding a
// decryption key next to the data, which protects nobody.
import { getSetting, setSetting } from './db.js';

const PREFIX = 'enc.v1:';

/** Settings that hold a credential. */
export const SECRET_KEYS = [
  'tmdb.apiKey',
  'opensubtitles.apiKey',
  'opensubtitles.token',
  'trakt.clientSecret',
  'trakt.accessToken',
  'trakt.refreshToken',
];

let vault = null;

/** `{ encrypt(text) -> string, decrypt(string) -> text }`, or null to turn it off. */
export function setSecretVault(next) {
  vault = next;
  if (vault) migrate();
}

export function secretsEncrypted() {
  return Boolean(vault);
}

export function getSecret(key, fallback = null) {
  const raw = getSetting(key);
  if (!raw) return fallback;
  if (!raw.startsWith(PREFIX)) return raw;
  if (!vault) return fallback;
  try {
    return vault.decrypt(raw.slice(PREFIX.length));
  } catch {
    // Written by another user account or machine: treat as not set, so the
    // person is simply asked for the key again.
    return fallback;
  }
}

export function setSecret(key, value) {
  const text = value == null ? '' : String(value);
  if (!text) {
    setSetting(key, '');
    return;
  }
  setSetting(key, vault ? PREFIX + vault.encrypt(text) : text);
}

// A known value, encrypted, to find out whether the vault can still open what
// it wrote last time. Electron only saves its encryption key on a clean exit,
// so a first run that ends in a crash leaves ciphertext nothing can read.
const CANARY = 'secrets.canary';
const CANARY_VALUE = 'shelf';

/** Move keys saved in the clear into the vault, once it has proved itself. */
function migrate() {
  if (getSecret(CANARY) !== CANARY_VALUE) {
    // Either the first run with a vault, or a vault that changed underneath
    // us. Leave readable keys readable and try again next time.
    setSecret(CANARY, CANARY_VALUE);
    return;
  }
  for (const key of SECRET_KEYS) {
    const raw = getSetting(key);
    if (raw && !raw.startsWith(PREFIX)) setSecret(key, raw);
  }
}
