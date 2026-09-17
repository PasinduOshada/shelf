// Filename -> structured media info.
// Tuned against a real-world library of scene/P2P release names.

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts']);
const SUB_EXT = new Set(['.srt', '.sub', '.ass', '.ssa', '.vtt']);

// Tokens that mark the end of a title and the start of release metadata.
// Kept deliberately conservative: anything that also occurs in real titles
// (part, cut, max, season, ts, hd) is NOT listed here.
const NOISE = [
  '2160p', '1080p', '720p', '576p', '480p', '360p', '4k', 'uhd',
  'webrip', 'webdl', 'bluray', 'bdrip', 'brrip', 'hdrip', 'hdtv',
  'dvdrip', 'remux', 'ds4k',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx',
  '10bit', '8bit', 'hdr', 'hdr10',
  'aac', 'aac2', 'ac3', 'eac3', 'dts', 'ddp5', 'ddp', 'dd5', 'truehd', 'atmos',
  'flac', 'opus', '2ch', '6ch', '8ch',
  'dualaudio', 'multi', 'subbed', 'dubbed', 'esub',
  'korean', 'hindi', 'tamil', 'telugu', 'malayalam', 'chinese', 'japanese',
  'spanish', 'norwegian', 'kor',
  'nf', 'amzn', 'atvp', 'dsnp', 'hmax', 'hulu', 'pcok', 'linetv', 'friday',
  'internal', 'proper', 'repack', 'unrated', 'uncensored', 'remastered',
  'imax', 'docu', 'roadshow',
];

// Release groups / trackers, usually trailing.
const GROUPS = [
  'psa', 'pahe', 'megusta', 'galaxytv', 'galaxyrg', 'galaxyrg265',
  'yts', 'yify', 'sparks', 'tipex', 'eztvx', 'eztv',
  'syncup', 'kyogo', 'minx', 'scope', 'rmteam', 'mkvcage', 'ganool', 'hevcbay',
  'ion10', 'ntb', 'flux', 'cakes', 'mpm', 'ezi', 'tif', 'kane',
  'seriesland4u', 'tvseriesland', 'seriesbayx', 't4tsa', 'telegram', 'themoviesbos',
  'yifan', 'dra', 'rickychannel', 'silence', 'edith',
];

const NOISE_SET = new Set(NOISE);
const GROUP_SET = new Set(GROUPS);

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i).toLowerCase() } : { base: name, ext: '' };
}

// Remove leading [GROUP] / (GROUP) / @handle decorations.
function stripLeadingTags(s) {
  let out = s;
  let prev;
  do {
    prev = out;
    out = out
      .replace(/^\s*[\[({][^\])}]*[\])}]\s*/, '')
      .replace(/^\s*@\S+\s*/, '')
      .replace(/^[\s._-]+/, '');
  } while (out !== prev && out.length);
  return out || s;
}

// Trailing junk: [tag], (1), @handle
function stripTrailingTags(s) {
  let out = s;
  let prev;
  do {
    prev = out;
    out = out
      .replace(/\s*[\[({][^\])}]*[\])}]\s*$/, '')
      .replace(/\s*@\S+\s*$/, '')
      .replace(/[\s._-]+$/, '');
  } while (out !== prev && out.length);
  return out;
}

function normalizeSeparators(s) {
  return s.replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function bareToken(tok) {
  return tok.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isNoiseToken(bare) {
  if (NOISE_SET.has(bare)) return true;
  if (GROUP_SET.has(bare)) return true;
  if (/^\d+(ch|bit|p)$/.test(bare)) return true;
  if (/^(web|dd)$/.test(bare)) return true;
  return false;
}

// Cut a title string at the first release-metadata token.
function cleanTitle(raw) {
  if (!raw) return '';
  let s = normalizeSeparators(stripTrailingTags(stripLeadingTags(raw)));

  const parts = s.split(' ');
  const kept = [];
  for (const p of parts) {
    const bare = bareToken(p);
    // Lone separators ("-") carry no meaning but must not terminate the title:
    // "Mission.Impossible.-.The.Final.Reckoning" is one title.
    if (!bare) continue;
    if (isNoiseToken(bare)) break;
    // A year token ends the title -- bare form so "(2023)" counts too.
    if (/^(19|20)\d{2}$/.test(bare) && kept.length) break;
    kept.push(p);
  }

  let title = (kept.length ? kept : parts).join(' ');
  title = title
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return title;
}

function extractYear(s, { first = false } = {}) {
  const paren = s.match(/[\[(]((?:19|20)\d{2})/);
  if (paren) return Number(paren[1]);
  const m = [...s.matchAll(/(?:^|[\s._([-])((?:19|20)\d{2})(?=$|[\s._)\]-])/g)];
  if (!m.length) return null;
  return Number(first ? m[0][1] : m[m.length - 1][1]);
}

function extractQuality(s) {
  // Lookarounds, not \b: "_" is a word character, so \b720p\b misses "_720p_".
  const m = s.match(/(?<![a-z0-9])(2160p|1080p|720p|576p|480p)(?![a-z0-9])/i);
  if (m) return m[1].toLowerCase();
  if (/(?<![a-z0-9])(4k|uhd)(?![a-z0-9])/i.test(s)) return '2160p';
  return null;
}

function extractCodec(s) {
  if (/(x265|h\.?265|hevc)/i.test(s)) return 'x265';
  if (/(x264|h\.?264|avc)/i.test(s)) return 'x264';
  if (/xvid/i.test(s)) return 'xvid';
  return null;
}

function extractSource(s) {
  if (/web[\s._-]?dl/i.test(s)) return 'WEB-DL';
  if (/webrip/i.test(s)) return 'WEBRip';
  if (/blu[\s._-]?ray|bdrip|brrip/i.test(s)) return 'BluRay';
  if (/hdrip/i.test(s)) return 'HDRip';
  if (/hdtv/i.test(s)) return 'HDTV';
  if (/dvdrip/i.test(s)) return 'DVDRip';
  if (/remux/i.test(s)) return 'REMUX';
  return null;
}

// Ordered season/episode matchers, most specific first.
// Lookarounds (not \b) because "_" is a word char: "_S01E01_" must still match.
const EP_PATTERNS = [
  // S01E01 / S01.E01 / S01_E01 / S01 E01 / s01e01
  { re: /(?<![A-Za-z0-9])S(\d{1,2})[\s._-]*E(\d{1,3})(?!\d)/i, s: 1, e: 2 },
  // (s01e01)
  { re: /\(\s*s(\d{1,2})\s*e(\d{1,3})\s*\)/i, s: 1, e: 2 },
  // 1x01
  { re: /(?<![A-Za-z0-9])(\d{1,2})x(\d{1,3})(?!\d)/i, s: 1, e: 2 },
  // Season 1 Episode 2
  { re: /Season[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})(?!\d)/i, s: 1, e: 2 },
  // Bare E01 (season unknown -> defaultSeason)
  { re: /(?<![A-Za-z0-9])E(\d{1,3})(?!\d)/i, s: null, e: 1 },
  // Leading "02 - Title"
  { re: /^(\d{1,2})\s*[-–]\s+/, s: null, e: 1 },
];

/**
 * Parse a media filename.
 * @param {string} filename
 * @param {{folderTitle?: string, defaultSeason?: number}} [opts]
 */
export function parseFilename(filename, opts = {}) {
  const { base, ext } = stripExt(filename);
  const isVideo = VIDEO_EXT.has(ext);
  const isSubtitle = SUB_EXT.has(ext);

  const result = {
    filename,
    ext,
    kind: isSubtitle ? 'subtitle' : isVideo ? 'video' : 'other',
    title: null,
    year: extractYear(base),
    season: null,
    episode: null,
    episodeTitle: null,
    quality: extractQuality(base),
    codec: extractCodec(base),
    source: extractSource(base),
    isEpisode: false,
  };

  if (result.kind === 'other') return result;

  const cleaned = stripLeadingTags(base);

  for (const pat of EP_PATTERNS) {
    const m = cleaned.match(pat.re);
    if (!m) continue;

    const season = pat.s === null ? (opts.defaultSeason ?? 1) : Number(m[pat.s]);
    const episode = Number(m[pat.e]);
    if (!Number.isFinite(episode)) continue;

    const before = cleaned.slice(0, m.index);
    const after = cleaned.slice(m.index + m[0].length);

    let title = cleanTitle(before);
    // "[TIF]_S02_E01_Fargo_720p" puts the title AFTER the marker.
    if (title.length < 2) title = cleanTitle(after);

    const epTitle = cleanTitle(after);
    if (title && epTitle && epTitle !== title) result.episodeTitle = epTitle;

    result.season = season;
    result.episode = episode;
    result.isEpisode = true;
    result.title = title || cleanTitle(opts.folderTitle || '') || null;
    return result;
  }

  // No episode marker -> treat as a movie.
  result.title = cleanTitle(cleaned) || cleanTitle(opts.folderTitle || '') || null;
  return result;
}

/**
 * Clean a folder name into a series/collection title.
 * "House Of The Dragons(2022)" -> "House Of The Dragons"
 * "Reacher Season 3" -> "Reacher"
 * "Vikings(2013-2020)" -> "Vikings" (2013)
 */
export function parseFolderName(folderName) {
  const year = extractYear(folderName, { first: true });

  let s = folderName
    .replace(/\((?:19|20)\d{2}\s*[-–]?\s*(?:(?:19|20)\d{2})?\)/g, ' ')
    .replace(/\[(?:19|20)\d{2}\]/g, ' ')
    .replace(/\bSeasons?\s*\d+(?:\s*[-–]\s*\d+)?\b/gi, ' ')
    .replace(/(?<![A-Za-z0-9])S\d{1,2}(?![A-Za-z0-9])/gi, ' ')
    .replace(/\bcomplete\b/gi, ' ');

  s = normalizeSeparators(stripTrailingTags(stripLeadingTags(s)));
  return { title: s.trim(), year };
}

export function isVideoFile(filename) {
  return VIDEO_EXT.has(stripExt(filename).ext);
}

export function isSubtitleFile(filename) {
  return SUB_EXT.has(stripExt(filename).ext);
}
