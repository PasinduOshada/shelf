// Playback tracking for files Shelf opens itself.
//
// VLC is started with its local web interface on a random port and password,
// mpv with a private IPC pipe, and MPC-HC/BE is read through its web
// interface when the user has turned that on. Every few seconds Shelf asks
// how far along playback is: that becomes the resume point, and once most of
// the file has played the episode or film is marked watched.
// The system default player cannot be asked, so nothing is tracked there.
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { getSetting } from './db.js';
import { saveProgress, setEpisodeWatched, setMovieWatched } from './watch.js';

export const playbackEvents = new EventEmitter();

const POLL_MS = 5000;
const sessions = new Map();

export function watchedThreshold() {
  const v = Number(getSetting('player.watchedAt', '90'));
  return Number.isFinite(v) && v >= 50 && v <= 100 ? v / 100 : 0.9;
}

export function autoWatchEnabled() {
  return getSetting('player.autoWatch', '1') === '1';
}

export function playerKind(path) {
  const name = basename(String(path || '')).toLowerCase();
  if (/^vlc(\.exe)?$/.test(name) || /vlc\.app/i.test(path || '')) return 'vlc';
  if (/^mpv(\.exe|\.com)?$/.test(name) || /mpv\.app/i.test(path || '')) return 'mpv';
  if (/^mpc-(hc|be)(64)?\.exe$/.test(name)) return 'mpc';
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Arguments that start playback at `start` seconds and open a status channel. */
export async function launchArgs(kind, file, start) {
  const s = Math.max(0, Math.floor(start || 0));
  if (kind === 'vlc') {
    const port = await freePort();
    const password = randomBytes(12).toString('hex');
    return {
      args: [
        file, '--extraintf=http', '--http-host=127.0.0.1', `--http-port=${port}`,
        `--http-password=${password}`, ...(s ? [`--start-time=${s}`] : []),
      ],
      channel: { kind, port, password },
    };
  }
  if (kind === 'mpv') {
    const pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\shelf-mpv-${randomBytes(6).toString('hex')}`
      : `/tmp/shelf-mpv-${randomBytes(6).toString('hex')}.sock`;
    return { args: [file, `--input-ipc-server=${pipe}`, ...(s ? [`--start=${s}`] : [])], channel: { kind, pipe } };
  }
  if (kind === 'mpc') {
    return { args: [file, ...(s ? ['/start', String(s * 1000)] : [])], channel: { kind, port: 13579 } };
  }
  return { args: [file], channel: null };
}

// ---------------------------------------------------------------- reading status

async function vlcStatus({ port, password }) {
  const res = await fetch(`http://127.0.0.1:${port}/requests/status.json`, {
    headers: { Authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`VLC ${res.status}`);
  const s = await res.json();
  return { position: Number(s.time) || 0, duration: Number(s.length) || 0, state: s.state };
}

function mpvRequest(pipe, property) {
  return new Promise((resolve, reject) => {
    const sock = connect(pipe);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('mpv timeout'));
    }, 3000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('connect', () => sock.write(`${JSON.stringify({ command: ['get_property', property] })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"error"'));
      if (!line) return;
      clearTimeout(timer);
      sock.end();
      const msg = JSON.parse(line);
      resolve(msg.error === 'success' ? msg.data : null);
    });
  });
}

async function mpvStatus({ pipe }) {
  const [position, duration] = [await mpvRequest(pipe, 'time-pos'), await mpvRequest(pipe, 'duration')];
  return { position: Number(position) || 0, duration: Number(duration) || 0, state: 'playing' };
}

async function mpcStatus({ port }) {
  const res = await fetch(`http://127.0.0.1:${port}/variables.html`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`MPC ${res.status}`);
  const html = await res.text();
  const num = (id) => Number(html.match(new RegExp(`id="${id}">(\\d+)<`))?.[1]) || 0;
  return { position: num('position') / 1000, duration: num('duration') / 1000, state: 'playing' };
}

const READERS = { vlc: vlcStatus, mpv: mpvStatus, mpc: mpcStatus };

// ---------------------------------------------------------------- sessions

/**
 * Start `player` on `file` and follow it. `target` says what the file is
 * ({ episodeId } or { movieId }) so progress lands on the right row.
 */
export async function startTracked({ player, file, target, start = 0, label = '' }) {
  const kind = playerKind(player);
  const { args, channel } = await launchArgs(kind, file, start);
  const child = spawn(player, args, { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  if (!channel || (!target.episodeId && !target.movieId)) return { tracked: false };

  const id = randomBytes(6).toString('hex');
  const session = {
    id, kind, label, target, channel, started_at: Date.now(), position: start, duration: 0,
    marked: false, misses: 0, seen: false,
  };
  sessions.set(id, session);
  child.once('exit', () => finish(session));
  session.timer = setInterval(() => poll(session), POLL_MS);
  session.timer.unref?.();
  return { tracked: true, session: id };
}

async function poll(session) {
  let status;
  try {
    status = await READERS[session.kind](session.channel);
    session.misses = 0;
    session.seen = true;
  } catch {
    // Starting players take a moment; after that, silence means it closed.
    session.misses++;
    const grace = session.seen ? 3 : 12;
    if (session.misses >= grace) finish(session);
    return;
  }
  if (!status.duration) return;
  session.position = status.position;
  session.duration = status.duration;
  saveProgress({ ...session.target, position: status.position, duration: status.duration });

  if (!session.marked && autoWatchEnabled() && status.position / status.duration >= watchedThreshold()) {
    session.marked = true;
    const r = session.target.episodeId
      ? setEpisodeWatched(session.target.episodeId, true)
      : setMovieWatched(session.target.movieId, true);
    if (r) playbackEvents.emit('watched', { ...session.target, label: session.label });
  }
}

function finish(session) {
  if (!sessions.has(session.id)) return;
  clearInterval(session.timer);
  sessions.delete(session.id);
  playbackEvents.emit('ended', { ...session.target, label: session.label, marked: session.marked });
}

export function activeSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id, kind: s.kind, label: s.label, ...s.target,
    position: Math.round(s.position || 0), duration: Math.round(s.duration || 0), marked: s.marked,
  }));
}
