// Real stream details read from the video file with ffprobe: resolution, HDR,
// codecs, audio and subtitle languages, duration, and the embedded title tag.
//
// ffprobe ships with the Windows build (@ffprobe-installer/win32-x64). Other
// systems use SHELF_FFPROBE or an ffprobe on PATH; without one, Shelf simply
// keeps the details it guessed from file names.
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { db } from './db.js';

const require = createRequire(import.meta.url);

let cachedPath;

export function ffprobePath() {
  if (cachedPath !== undefined) return cachedPath;
  const candidates = [];
  if (process.env.SHELF_FFPROBE) candidates.push(process.env.SHELF_FFPROBE);
  if (process.platform === 'win32' && process.arch === 'x64') {
    try {
      const pkg = require.resolve('@ffprobe-installer/win32-x64/package.json');
      // Inside a packaged app the binary lives in app.asar.unpacked.
      candidates.push(pkg.replace(/package\.json$/, 'ffprobe.exe').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`));
    } catch {
      // Not installed.
    }
  }
  cachedPath = candidates.find((p) => existsSync(p)) || null;
  if (!cachedPath) {
    const r = spawnSync('ffprobe', ['-version'], { windowsHide: true });
    if (r.status === 0) cachedPath = 'ffprobe';
  }
  return cachedPath;
}

export function probeAvailable() {
  return Boolean(ffprobePath());
}

function run(path) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout)))
    );
  });
}

const LANG = {
  eng: 'en', hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', sin: 'si', kor: 'ko',
  jpn: 'ja', chi: 'zh', zho: 'zh', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', rus: 'ru', ara: 'ar', tur: 'tr', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', nob: 'no',
  dan: 'da', fin: 'fi', pol: 'pl', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', heb: 'he',
  gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk', hrv: 'hr', fil: 'tl',
};
const lang2 = (code) => {
  const c = String(code || '').toLowerCase();
  if (!c || c === 'und') return null;
  return LANG[c] || (c.length === 2 ? c : c);
};

export function qualityFor(width, height) {
  if (!width || !height) return null;
  // Width matters for letterboxed films (1920x800 is still 1080p).
  if (width >= 3200 || height >= 1800) return '2160p';
  if (width >= 1700 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  if (height >= 560 || width >= 1000) return '576p';
  if (height >= 400) return '480p';
  return `${height}p`;
}

const CODEC = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2' };

/** The parts of ffprobe's output worth keeping. */
export function summarize(raw) {
  const streams = raw?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const transfer = String(video?.color_transfer || '');
  const hasDv = (video?.side_data_list || []).some((d) => /dovi|dolby vision/i.test(d.side_data_type || ''));
  const duration = Number(raw?.format?.duration) || Number(video?.duration) || null;
  return {
    duration: duration ? Math.round(duration) : null,
    width: video?.width || null,
    height: video?.height || null,
    quality: qualityFor(video?.width, video?.height),
    video_codec: video ? CODEC[video.codec_name] || video.codec_name?.toUpperCase() : null,
    hdr: hasDv ? 'Dolby Vision' : transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : null,
    bit_depth: Number(video?.bits_per_raw_sample) || (/10/.test(video?.pix_fmt || '') ? 10 : 8),
    bitrate: Number(raw?.format?.bit_rate) || null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        lang: lang2(s.tags?.language),
        codec: (s.codec_name || '').toUpperCase(),
        channels: s.channels || null,
        title: s.tags?.title || null,
      })),
    subtitles: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        lang: lang2(s.tags?.language),
        title: s.tags?.title || null,
        forced: Boolean(s.disposition?.forced) || /forced/i.test(s.tags?.title || ''),
        hi: Boolean(s.disposition?.hearing_impaired) || /\b(sdh|cc)\b/i.test(s.tags?.title || ''),
      })),
    title: raw?.format?.tags?.title || raw?.format?.tags?.TITLE || null,
  };
}

export async function probeFile(path) {
  if (!probeAvailable()) return null;
  return summarize(await run(path));
}

// ---------------------------------------------------------------- library job

let job = { running: false, done: 0, total: 0 };

export function probeStatus() {
  const counts = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN probed_at IS NOT NULL THEN 1 ELSE 0 END) probed
    FROM files WHERE is_missing = 0 AND ext IN ('.mkv','.mp4','.avi','.m4v','.mov','.wmv','.ts')
  `).get();
  return { ...job, available: probeAvailable(), files: counts.total, probed: counts.probed || 0 };
}

const saveInfo = db.prepare('UPDATE files SET media_info = ?, probed_at = ? WHERE id = ?');

/**
 * Probe every indexed file that has not been probed since it last changed.
 * Two at a time, so a big library does not swamp the disk.
 */
export function startProbe({ all = false } = {}) {
  if (job.running || !probeAvailable()) return probeStatus();
  const rows = db.prepare(`
    SELECT id, path, mtime, probed_at FROM files
    WHERE is_missing = 0 AND ext IN ('.mkv','.mp4','.avi','.m4v','.mov','.wmv','.ts')
    ${all ? '' : 'AND (probed_at IS NULL OR probed_at < mtime)'}
  `).all();
  job = { running: true, done: 0, total: rows.length, failed: 0, started_at: new Date().toISOString() };

  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        if (!existsSync(row.path)) continue;
        const info = await probeFile(row.path);
        saveInfo.run(JSON.stringify(info), statSync(row.path).mtime.toISOString(), row.id);
      } catch {
        job.failed++;
        // Remember the attempt so a broken file is not retried every scan.
        saveInfo.run(null, new Date().toISOString(), row.id);
      } finally {
        job.done++;
      }
    }
  };
  Promise.all([worker(), worker()]).finally(() => {
    job = { ...job, running: false, finished_at: new Date().toISOString() };
  });
  return probeStatus();
}

let probeTimer = null;

/** Read new files' details a little after start, then every half hour. */
export function scheduleProbe() {
  if (probeTimer) return;
  const first = setTimeout(() => startProbe(), 2 * 60_000);
  first.unref?.();
  probeTimer = setInterval(() => startProbe(), 30 * 60_000);
  probeTimer.unref?.();
}

/** Parsed media_info for a files row, or null. */
export function infoOf(row) {
  if (!row?.media_info) return null;
  try {
    return JSON.parse(row.media_info);
  } catch {
    return null;
  }
}
