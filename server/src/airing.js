// New-episode alerts. Once an hour Shelf looks for episodes of shows in the
// library that aired today (or yesterday, if Shelf was closed) and announces
// each one once. The desktop app turns the event into a notification; the web
// build shows the same list on Up Next.
import { EventEmitter } from 'node:events';
import { db, getSetting, setSetting } from './db.js';

export const airingEvents = new EventEmitter();

const localDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export function airingEnabled() {
  return getSetting('notify.airing', '1') === '1';
}

/** Episodes of library shows that aired between `from` and `to` (inclusive, local dates). */
export function airedBetween(from, to) {
  return db.prepare(`
    SELECT e.id, e.season_number, e.episode_number, e.title AS episode_title, e.air_date,
           s.id AS show_id, s.title AS show_title, s.poster_path, s.custom_poster, s.icon_emoji,
           EXISTS (SELECT 1 FROM files f WHERE f.episode_id = e.id AND f.is_missing = 0) AS owned,
           COALESCE((SELECT es.watched FROM episode_state es WHERE es.episode_id = e.id), 0) AS watched
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
    WHERE e.air_date BETWEEN ? AND ?
      AND e.season_number > 0
      AND EXISTS (SELECT 1 FROM files f WHERE f.show_id = s.id AND f.is_missing = 0)
    ORDER BY e.air_date DESC, s.title, e.season_number, e.episode_number
  `).all(from, to);
}

export function airingToday() {
  const today = localDate(Date.now());
  return airedBetween(today, today);
}

export function checkAiring(now = Date.now()) {
  if (!airingEnabled()) return [];
  const today = localDate(now);
  const yesterday = localDate(now - 86_400_000);
  const seen = new Set(JSON.parse(getSetting('airing.notified', '[]') || '[]'));
  const fresh = airedBetween(yesterday, today).filter((e) => !seen.has(e.id));
  if (!fresh.length) return [];
  for (const e of fresh) seen.add(e.id);
  setSetting('airing.notified', JSON.stringify([...seen].slice(-500)));
  airingEvents.emit('aired', fresh);
  return fresh;
}

let timer = null;

export function scheduleAiringAlerts() {
  if (timer) return;
  const first = setTimeout(() => checkAiring(), 90_000);
  first.unref?.();
  timer = setInterval(() => checkAiring(), 60 * 60_000);
  timer.unref?.();
}
