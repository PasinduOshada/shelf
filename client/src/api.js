async function req(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

const qs = (params) => {
  const s = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
  ).toString();
  return s ? `?${s}` : '';
};

/**
 * Resolve a poster reference to a usable URL.
 * TMDB artwork goes through the server's /img cache rather than image.tmdb.org,
 * so posters keep working offline once they have been seen.
 */
export function posterUrl(poster, size = 'w342') {
  if (!poster) return null;
  if (poster.startsWith('tmdb:')) return `/img/${size}${poster.slice(5)}`;
  return poster;
}

export function tmdbImg(path, size = 'w342') {
  return path ? `/img/${size}${path}` : null;
}

export const api = {
  health: () => req('/health'),

  libraries: () => req('/libraries'),
  addLibrary: (body) => req('/libraries', { method: 'POST', body }),
  removeLibrary: (id) => req(`/libraries/${id}`, { method: 'DELETE' }),
  scan: (libraryId) => req('/scan', { method: 'POST', body: { libraryId } }),
  browse: (path) => req(`/browse${qs({ path })}`),

  shows: (params) => req(`/shows${qs(params)}`),
  show: (id) => req(`/shows/${id}`),
  updateShow: (id, body) => req(`/shows/${id}`, { method: 'PATCH', body }),
  clearShowPoster: (id) => req(`/shows/${id}/poster`, { method: 'DELETE' }),

  movies: (params) => req(`/movies${qs(params)}`),
  movie: (id) => req(`/movies/${id}`),
  updateMovie: (id, body) => req(`/movies/${id}`, { method: 'PATCH', body }),
  clearMoviePoster: (id) => req(`/movies/${id}/poster`, { method: 'DELETE' }),
  collections: () => req('/collections'),

  uploadPoster: async (kind, id, file) => {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(`/api/${kind}/${id}/poster`, { method: 'POST', body: form });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  continueWatching: (limit) => req(`/continue-watching${qs({ limit })}`),
  upcoming: (days) => req(`/upcoming${qs({ days })}`),
  missing: () => req('/missing'),
  duplicates: () => req('/duplicates'),
  surprise: (params) => req(`/surprise${qs(params)}`),

  watchEpisode: (id, watched) => req(`/episodes/${id}/watch`, { method: 'POST', body: { watched } }),
  watchShow: (id, body) => req(`/shows/${id}/watch`, { method: 'POST', body }),
  watchMovie: (id, watched) => req(`/movies/${id}/watch`, { method: 'POST', body: { watched } }),
  history: (limit) => req(`/history${qs({ limit })}`),

  overview: () => req('/stats/overview'),
  activity: (days) => req(`/stats/activity${qs({ days })}`),
  summaries: () => req('/stats/summaries'),
  streaks: () => req('/stats/streaks'),
  composition: () => req('/stats/composition'),
  wrapped: (year) => req(`/stats/wrapped${qs({ year })}`),

  tmdbStatus: () => req('/tmdb/status'),
  setTmdbKey: (key) => req('/tmdb/key', { method: 'POST', body: { key } }),
  // Starts the background job; poll enrichStatus() for progress.
  // Accepts `true` (retry not-found titles) or { retryFailed, refresh }.
  enrich: (opts = {}) =>
    req('/tmdb/enrich', { method: 'POST', body: typeof opts === 'boolean' ? { retryFailed: opts } : opts }),
  enrichStatus: () => req('/tmdb/enrich'),
  tmdbSearch: (q, kind) => req(`/tmdb/search${qs({ q, kind })}`),
  matchShow: (id, tmdbId) => req(`/shows/${id}/match`, { method: 'POST', body: { tmdbId } }),
  matchMovie: (id, tmdbId) => req(`/movies/${id}/match`, { method: 'POST', body: { tmdbId } }),
  showOrderings: (id) => req(`/shows/${id}/orderings`),
  // groupId: a TMDB episode group id, or null for TMDB's default seasons.
  setShowOrdering: (id, groupId) => req(`/shows/${id}/ordering`, { method: 'POST', body: { groupId } }),

  settings: () => req('/settings'),
  updateSettings: (body) => req('/settings', { method: 'PATCH', body }),

  // The organiser runs previews and moves as background jobs; poll organizeJob().
  organizeDefaults: () => req('/organize/defaults'),
  organizePreview: (body) => req('/organize/preview', { method: 'POST', body }),
  organizeJob: () => req('/organize/job'),
  organizePlan: () => req('/organize/plan'),
  // `confirm` is required server-side so files can never move by accident.
  organizeApply: (planId, ids) => req('/organize/apply', { method: 'POST', body: { planId, ids, confirm: true } }),
  organizeUndo: (batchId) => req('/organize/undo', { method: 'POST', body: { batchId } }),
  organizeHistory: () => req('/organize/history'),
  autoOrganize: () => req('/organize/auto'),
  setAutoOrganize: (body) => req('/organize/auto', { method: 'PUT', body }),
  runAutoOrganize: () => req('/organize/auto/run', { method: 'POST' }),

  episodeFiles: (id) => req(`/episodes/${id}/files`),
  reviewEpisode: (id, body) => req(`/episodes/${id}/review`, { method: 'PATCH', body }),
  reviewMovie: (id, body) => req(`/movies/${id}/review`, { method: 'PATCH', body }),
  setFileEpisode: (fileId, season, episode) =>
    req(`/files/${fileId}/episode`, { method: 'PATCH', body: { season, episode } }),

  duplicateGroups: () => req('/duplicates/groups'),
  // Sends one copy to the Recycle Bin; the server refuses the last copy.
  trashFile: (fileId) => req(`/files/${fileId}/trash`, { method: 'POST', body: { confirm: true } }),

  probeStatus: () => req('/media/probe'),
  startProbe: (all = false) => req('/media/probe', { method: 'POST', body: { all } }),

  airing: () => req('/airing'),
  setAiring: (enabled) => req('/airing', { method: 'PUT', body: { enabled } }),

  autoSubtitles: () => req('/subtitles/auto'),
  setAutoSubtitles: (enabled) => req('/subtitles/auto', { method: 'PUT', body: { enabled } }),
  fetchSubtitles: (body) => req('/subtitles/auto/run', { method: 'POST', body }),

  playback: () => req('/playback'),
  setPlaybackSettings: (body) => req('/playback/settings', { method: 'PUT', body }),

  importTvTime: async (files) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await fetch('/api/import/tvtime', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed');
    return data;
  },
  applyTvTime: (id) => req(`/import/tvtime/${id}/apply`, { method: 'POST' }),

  trakt: () => req('/trakt'),
  setTraktApp: (clientId, clientSecret) => req('/trakt/app', { method: 'PUT', body: { clientId, clientSecret } }),
  traktConnect: () => req('/trakt/connect', { method: 'POST' }),
  traktDisconnect: () => req('/trakt/disconnect', { method: 'POST' }),
  traktSync: () => req('/trakt/sync', { method: 'POST' }),

  importBackup: async (file, { overwrite = false, settings = true } = {}) => {
    const form = new FormData();
    form.append('file', file);
    form.append('overwrite', String(overwrite));
    form.append('settings', String(settings));
    const res = await fetch('/api/backup/import', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Restore failed');
    return data;
  },

  // target: { fileId } | { episodeId } | { movieId }
  player: () => req('/player'),
  setPlayer: (path) => req('/player', { method: 'PUT', body: { path } }),
  play: (target) => req('/play', { method: 'POST', body: target }),
  reveal: (target) => req('/reveal', { method: 'POST', body: target }),

  subtitleSettings: () => req('/subtitles/settings'),
  updateSubtitleSettings: (body) => req('/subtitles/settings', { method: 'PATCH', body }),
  setSubtitleKey: (key) => req('/subtitles/key', { method: 'POST', body: { key } }),
  subtitleLogin: (username, password) => req('/subtitles/login', { method: 'POST', body: { username, password } }),
  subtitleLogout: () => req('/subtitles/logout', { method: 'POST' }),
  searchSubtitles: (target, languages) => req(`/subtitles/search${qs({ ...target, languages })}`),
  downloadSubtitle: (target, subtitleFileId, language) =>
    req('/subtitles/download', { method: 'POST', body: { ...target, subtitleFileId, language } }),
};

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i > 2 ? 1 : 0)} ${units[i]}`;
}

export function formatRuntime(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "in 3d 14h" style countdown from an ISO date. */
export function countdown(airDate) {
  if (!airDate) return null;
  const target = new Date(`${airDate}T00:00:00`).getTime();
  const diff = target - Date.now();
  if (diff <= 0) return 'Aired';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 30) return `in ${Math.round(days / 30)} mo`;
  if (days > 0) return `in ${days}d ${hours}h`;
  return `in ${hours}h`;
}

/** 3725 -> "1:02:05", 754 -> "12:34". */
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
