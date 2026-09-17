// Duplicate files: several files for the same episode or film. Shelf suggests
// which copy to keep and can send the others to the Recycle Bin, one file at
// a time and only while another copy of the same title is still on disk.
import { existsSync } from 'node:fs';
import { db } from './db.js';
import { moveToTrash } from './trash.js';

const RANK = { '2160p': 5, '1080p': 4, '720p': 3, '576p': 2, '480p': 1 };

/**
 * Copies of one episode run the same length. Files whose lengths differ by
 * more than a minute are most likely different episodes that were misnamed
 * (three "S01E0" downloads of 27, 28 and 29 minutes), not duplicates.
 */
export function differentLengths(files) {
  const d = files.map((f) => f.duration).filter(Boolean);
  if (d.length < 2) return false;
  return Math.max(...d) - Math.min(...d) > 60;
}

function describeFile(f) {
  let m = null;
  try {
    m = f.media_info ? JSON.parse(f.media_info) : null;
  } catch {
    m = null;
  }
  return {
    id: f.id,
    path: f.path,
    filename: f.filename,
    size_bytes: f.size_bytes,
    quality: m?.quality || f.quality || null,
    codec: m?.video_codec || f.codec || null,
    hdr: m?.hdr || null,
    duration: m?.duration || null,
    audio: [...new Set((m?.audio || []).map((a) => a.lang).filter(Boolean))],
    subtitles: [...new Set((m?.subtitles || []).map((s) => s.lang).filter(Boolean))],
  };
}

/** Higher is better: resolution, then HDR, then more languages, then size. */
export function score(file) {
  return (
    (RANK[file.quality] || 0) * 1000 +
    (file.hdr ? 200 : 0) +
    (file.audio.length + file.subtitles.length) * 10 +
    Math.min((file.size_bytes || 0) / 1e9, 50)
  );
}

export function duplicateGroups() {
  const files = db.prepare(`
    SELECT f.*, e.season_number, e.episode_number, e.title AS episode_title,
           s.id AS show_id, s.title AS show_title,
           m.id AS mid, COALESCE(m.tmdb_title, m.title) AS movie_title, m.year AS movie_year
    FROM files f
    LEFT JOIN episodes e ON e.id = f.episode_id
    LEFT JOIN shows s ON s.id = e.show_id
    LEFT JOIN movies m ON m.id = f.movie_id
    WHERE f.is_missing = 0 AND (f.episode_id IS NOT NULL OR f.movie_id IS NOT NULL)
      AND COALESCE(f.episode_id, f.movie_id) IN (
        SELECT COALESCE(episode_id, movie_id) FROM files
        WHERE is_missing = 0 AND (episode_id IS NOT NULL OR movie_id IS NOT NULL)
        GROUP BY COALESCE(episode_id, movie_id) HAVING COUNT(*) > 1
      )
  `).all();

  const groups = new Map();
  for (const f of files) {
    const key = f.episode_id || f.movie_id;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: f.episode_id ? 'episode' : 'movie',
        title: f.episode_id
          ? `${f.show_title} S${String(f.season_number).padStart(2, '0')}E${String(f.episode_number).padStart(2, '0')}`
          : `${f.movie_title}${f.movie_year ? ` (${f.movie_year})` : ''}`,
        subtitle: f.episode_title || null,
        show_id: f.show_id || null,
        movie_id: f.mid || null,
        files: [],
      });
    }
    groups.get(key).files.push(describeFile(f));
  }

  const out = [];
  for (const g of groups.values()) {
    g.files.sort((a, b) => score(b) - score(a));
    g.different_lengths = differentLengths(g.files);
    // Only real copies get a suggestion; misnumbered episodes need renumbering.
    g.keep = g.different_lengths ? null : g.files[0].id;
    g.reclaim_bytes = g.different_lengths ? 0 : g.files.slice(1).reduce((n, f) => n + (f.size_bytes || 0), 0);
    out.push(g);
  }
  return out.sort((a, b) => b.reclaim_bytes - a.reclaim_bytes);
}

/** Recycle one copy. Refuses unless another copy of the same title remains. */
export async function trashDuplicate(fileId) {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND is_missing = 0').get(fileId);
  if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
  const owner = f.episode_id ? ['episode_id', f.episode_id] : f.movie_id ? ['movie_id', f.movie_id] : null;
  if (!owner) throw Object.assign(new Error('Only copies of a known episode or film can be removed here'), { status: 400 });
  const others = db.prepare(`SELECT path FROM files WHERE ${owner[0]} = ? AND id != ? AND is_missing = 0`).all(owner[1], f.id);
  if (!others.some((o) => existsSync(o.path))) {
    throw Object.assign(new Error('This is the only copy left, so it is kept'), { status: 409 });
  }
  const lengths = db.prepare(`SELECT json_extract(media_info, '$.duration') AS duration FROM files WHERE ${owner[0]} = ? AND is_missing = 0`).all(owner[1]);
  if (differentLengths(lengths)) {
    throw Object.assign(
      new Error('These files have different lengths, so they are probably different episodes. Renumber them instead.'),
      { status: 409 }
    );
  }
  if (!existsSync(f.path)) {
    db.prepare('UPDATE files SET is_missing = 1 WHERE id = ?').run(f.id);
    return { ok: true, already_gone: true };
  }
  await moveToTrash(f.path);
  db.prepare('UPDATE files SET is_missing = 1 WHERE id = ?').run(f.id);
  return { ok: true, path: f.path, size_bytes: f.size_bytes };
}
