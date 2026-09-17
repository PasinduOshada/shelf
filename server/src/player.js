// Open files in a video player.
//
// Only files Shelf has indexed can be opened (looked up by id), and nothing
// goes through a shell: players are started with an argument list, so a file
// named `a & calc.mkv` is just a file name.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, basename, extname, isAbsolute } from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { playerKind, startTracked, autoWatchEnabled, watchedThreshold } from './playback.js';
import { getProgress } from './watch.js';

const PLATFORM = process.platform;

const WINDOWS_PLAYERS = [
  ['VLC', ['VideoLAN\\VLC\\vlc.exe']],
  ['MPC-HC', ['MPC-HC\\mpc-hc64.exe', 'MPC-HC\\mpc-hc.exe', 'K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe']],
  ['MPC-BE', ['MPC-BE x64\\mpc-be64.exe', 'MPC-BE\\mpc-be.exe']],
  ['PotPlayer', ['DAUM\\PotPlayer\\PotPlayerMini64.exe', 'DAUM\\PotPlayer\\PotPlayerMini.exe', 'PotPlayer\\PotPlayerMini64.exe']],
  ['mpv', ['mpv\\mpv.exe']],
  ['KMPlayer', ['KMPlayer\\KMPlayer.exe', 'KMPlayer 64X\\KMPlayer64.exe']],
  ['GOM Player', ['GRETECH\\GomPlayer\\GOM.exe', 'GOM\\GOMPlayer\\GOM.exe']],
  ['Windows Media Player', ['Windows Media Player\\wmplayer.exe']],
];

const MAC_PLAYERS = [
  ['VLC', '/Applications/VLC.app'],
  ['IINA', '/Applications/IINA.app'],
  ['mpv', '/Applications/mpv.app'],
  ['QuickTime Player', '/System/Applications/QuickTime Player.app'],
];

const LINUX_PLAYERS = [['VLC', 'vlc'], ['mpv', 'mpv'], ['Celluloid', 'celluloid'], ['SMPlayer', 'smplayer'], ['Totem', 'totem']];

function which(cmd) {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Players installed in the usual places. */
export function detectPlayers() {
  const found = [];
  if (PLATFORM === 'win32') {
    const roots = [...new Set([
      process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    ].filter(Boolean))];
    for (const [name, rels] of WINDOWS_PLAYERS) {
      const hit = roots.flatMap((r) => rels.map((rel) => join(r, rel))).find((p) => existsSync(p));
      if (hit) found.push({ name, path: hit });
    }
  } else if (PLATFORM === 'darwin') {
    for (const [name, app] of MAC_PLAYERS) if (existsSync(app)) found.push({ name, path: app });
  } else {
    for (const [name, cmd] of LINUX_PLAYERS) {
      const hit = which(cmd);
      if (hit) found.push({ name, path: hit });
    }
  }
  return found;
}

export function playerSettings() {
  const path = getSetting('player.path') || null;
  const detected = detectPlayers();
  return {
    path,
    trackable: Boolean(path && playerKind(path)),
    ...playbackSettings(),
    name: path ? (detected.find((p) => p.path === path)?.name || basename(path, extname(path))) : null,
    available: path ? existsSync(path) : true,
    detected,
    platform: PLATFORM,
  };
}

/** Save the preferred player; null means "the system default". */
export function setPlayer(path) {
  if (path === null || path === '') {
    setSetting('player.path', '');
    return playerSettings();
  }
  if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) {
    throw new Error('Choose a player program that exists on this computer');
  }
  const isApp = PLATFORM === 'darwin' && /\.app\/?$/i.test(path);
  if (!isApp && !statSync(path).isFile()) throw new Error('That is not a program');
  if (PLATFORM === 'win32' && !/\.exe$/i.test(path)) throw new Error('Choose the player’s .exe file');
  setSetting('player.path', path);
  return playerSettings();
}

function launch(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    // A launcher that starts is good enough; players outlive the request.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function openWithDefault(path) {
  if (PLATFORM === 'win32') return launch('explorer.exe', [path]);
  if (PLATFORM === 'darwin') return launch('open', [path]);
  return launch('xdg-open', [path]);
}

/** Resolve an indexed file: by file id, or the best copy of an episode or film. */
export function findFile({ fileId, episodeId, movieId }) {
  const order = 'ORDER BY size_bytes DESC LIMIT 1';
  const cols = 'id, path, episode_id, movie_id';
  let row = null;
  if (fileId) row = db.prepare(`SELECT ${cols} FROM files WHERE id = ? AND is_missing = 0`).get(fileId);
  else if (episodeId) row = db.prepare(`SELECT ${cols} FROM files WHERE episode_id = ? AND is_missing = 0 ${order}`).get(episodeId);
  else if (movieId) row = db.prepare(`SELECT ${cols} FROM files WHERE movie_id = ? AND is_missing = 0 ${order}`).get(movieId);
  if (!row) throw Object.assign(new Error('No file for that title'), { status: 404 });
  if (!existsSync(row.path)) throw Object.assign(new Error('The file is no longer on disk. Rescan to update.'), { status: 410 });
  return row;
}

/** Where to start: the saved position, unless it is at the very start or end. */
function resumeFrom(what) {
  const p = getProgress(what);
  if (!p?.progress_seconds || p.watched) return 0;
  if (p.progress_seconds < 60) return 0;
  if (p.duration_seconds && p.progress_seconds / p.duration_seconds >= watchedThreshold()) return 0;
  // A few seconds back, to pick the scene up again.
  return Math.max(0, p.progress_seconds - 5);
}

function labelFor(file) {
  if (file.episode_id) {
    const r = db.prepare(`
      SELECT s.title, e.season_number, e.episode_number FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?
    `).get(file.episode_id);
    return r ? `${r.title} S${String(r.season_number).padStart(2, '0')}E${String(r.episode_number).padStart(2, '0')}` : '';
  }
  const m = db.prepare('SELECT COALESCE(tmdb_title, title) t FROM movies WHERE id = ?').get(file.movie_id);
  return m?.t || '';
}

export async function playFile(target, { resume = true } = {}) {
  const file = findFile(target);
  const player = getSetting('player.path') || null;
  const what = file.episode_id ? { episodeId: file.episode_id } : file.movie_id ? { movieId: file.movie_id } : {};
  const start = resume && (what.episodeId || what.movieId) ? resumeFrom(what) : 0;

  if (player && existsSync(player)) {
    const name = basename(player, extname(player));
    if (PLATFORM === 'darwin' && /\.app\/?$/i.test(player)) {
      await launch('open', ['-a', player, file.path]);
      return { ok: true, player: name, path: file.path, tracked: false };
    }
    if (playerKind(player)) {
      const r = await startTracked({ player, file: file.path, target: what, start, label: labelFor(file) });
      return { ok: true, player: name, path: file.path, tracked: r.tracked, resumed_at: start || null };
    }
    await launch(player, [file.path]);
    return { ok: true, player: name, path: file.path, tracked: false };
  }
  await openWithDefault(file.path);
  return { ok: true, player: 'default', path: file.path, tracked: false };
}

export function playbackSettings() {
  return { auto_watch: autoWatchEnabled(), watched_at: Math.round(watchedThreshold() * 100) };
}

export function setPlaybackSettings({ autoWatch, watchedAt }) {
  if (autoWatch !== undefined) setSetting('player.autoWatch', autoWatch ? '1' : '0');
  if (watchedAt !== undefined) {
    const v = Number(watchedAt);
    if (!Number.isInteger(v) || v < 50 || v > 100) throw new Error('Choose a percentage between 50 and 100');
    setSetting('player.watchedAt', String(v));
  }
  return playbackSettings();
}

export async function revealFile(target) {
  const file = findFile(target);
  if (PLATFORM === 'win32') {
    // explorer.exe wants `/select,"path"`; Windows paths cannot contain quotes.
    await new Promise((resolve, reject) => {
      const child = spawn('explorer.exe', [`/select,"${file.path}"`], {
        detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } else if (PLATFORM === 'darwin') {
    await launch('open', ['-R', file.path]);
  } else {
    await launch('xdg-open', [join(file.path, '..')]);
  }
  return { ok: true };
}
