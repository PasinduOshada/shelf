// Fetch subtitles on their own for files that just arrived (organised by hand
// or from a watched folder), in the user's preferred languages. A language is
// skipped when the file already has it, next to it or inside it. Only a
// confident pick is downloaded: a file-hash match, or a well-used subtitle
// from a trusted uploader. Downloads count against the OpenSubtitles quota,
// so a run stops at the first quota error and never takes more than a few.
import { db, getSetting, setSetting } from './db.js';
import { subtitleSettings, searchSubtitles, downloadSubtitle, localSubtitles } from './subtitles.js';

const MAX_PER_RUN = 10;
let running = null;
let last = null;

export function autoSubtitlesEnabled() {
  return getSetting('subtitles.auto', '0') === '1' && subtitleSettings().configured;
}

export function setAutoSubtitles(on) {
  setSetting('subtitles.auto', on ? '1' : '0');
}

export function autoSubtitleStatus() {
  return { enabled: getSetting('subtitles.auto', '0') === '1', running: Boolean(running), last };
}

/** The best result to take without asking, or null. */
export function pickSubtitle(results) {
  const usable = results.filter((r) => !r.machine);
  return (
    usable.find((r) => r.hash_match) ||
    usable.find((r) => r.trusted && r.downloads >= 100) ||
    usable.find((r) => r.downloads >= 2000) ||
    null
  );
}

function embeddedLanguages(row) {
  try {
    return new Set((JSON.parse(row.media_info || 'null')?.subtitles || []).map((s) => s.lang).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function run(paths) {
  const langs = subtitleSettings().languages.split(',').filter(Boolean);
  const summary = { at: new Date().toISOString(), checked: 0, downloaded: 0, skipped: 0, stopped: null, saved: [] };
  const byPath = db.prepare('SELECT id, path, media_info FROM files WHERE path = ? AND is_missing = 0');

  for (const path of paths) {
    if (summary.downloaded >= MAX_PER_RUN || summary.stopped) break;
    const row = byPath.get(path);
    if (!row) continue;
    summary.checked++;
    const have = new Set(localSubtitles(row.path).map((s) => s.lang).filter(Boolean));
    const inside = embeddedLanguages(row);

    for (const lang of langs) {
      if (have.has(lang) || inside.has(lang)) {
        summary.skipped++;
        continue;
      }
      try {
        const found = await searchSubtitles({ fileId: row.id }, { languages: lang });
        const pick = pickSubtitle(found.results.filter((r) => r.language === lang));
        if (!pick) continue;
        const saved = await downloadSubtitle({ fileId: row.id }, { subtitleFileId: pick.file_id, language: lang });
        summary.downloaded++;
        summary.saved.push(saved.saved);
        if (saved.remaining === 0) {
          summary.stopped = 'Daily download limit reached';
          break;
        }
      } catch (err) {
        if (err.status === 429 || err.status === 401) {
          summary.stopped = err.message;
          break;
        }
      }
      if (summary.downloaded >= MAX_PER_RUN) break;
    }
  }
  return summary;
}

/** Queue files for a subtitle check. Returns immediately; one run at a time. */
export function fetchSubtitlesFor(paths) {
  if (!autoSubtitlesEnabled() || !paths?.length) return null;
  const next = (running || Promise.resolve())
    .then(() => run(paths))
    .then((s) => {
      last = s;
      return s;
    })
    .catch(() => null)
    .finally(() => {
      if (running === next) running = null;
    });
  running = next;
  return next;
}
