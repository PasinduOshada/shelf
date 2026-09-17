import { useEffect, useState } from 'react';
import { api, formatBytes, formatClock } from '../api';
import { Badge, RatingStars, Spinner } from './Bits';

const langList = (list) => [...new Set((list || []).map((x) => x.lang).filter(Boolean))].map((l) => l.toUpperCase());

/** One file's real details, read from the file itself. */
export function MediaFacts({ media, compact = false }) {
  if (!media) return null;
  const audio = langList(media.audio);
  const subs = langList(media.subtitles);
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${compact ? '' : 'mt-1'}`}>
      {media.quality && <Badge tone="accent">{media.quality}{media.width ? ` · ${media.width}×${media.height}` : ''}</Badge>}
      {media.hdr && <Badge tone="good">{media.hdr}</Badge>}
      {media.video_codec && <Badge>{media.video_codec}{media.bit_depth === 10 ? ' 10-bit' : ''}</Badge>}
      {media.duration && <Badge>{formatClock(media.duration)}</Badge>}
      {audio.length > 0 && <Badge title="Audio languages">🔊 {audio.join(' ')}</Badge>}
      {subs.length > 0 && <Badge title="Subtitles inside the file">CC {subs.slice(0, 6).join(' ')}{subs.length > 6 ? ` +${subs.length - 6}` : ''}</Badge>}
    </div>
  );
}

/** Correct which episode a file is. */
export function Renumber({ file, onSaved }) {
  const [season, setSeason] = useState(file.manual_season ?? '');
  const [episode, setEpisode] = useState(file.manual_episode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(clear = false) {
    setBusy(true);
    setError(null);
    try {
      await api.setFileEpisode(file.id, clear ? null : Number(season), clear ? null : Number(episode));
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const field = 'mono w-14 rounded border border-edge bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent/50';
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-dim"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span>This file is</span>
      <label className="flex items-center gap-1">
        S <input className={field} inputMode="numeric" value={season} onChange={(e) => setSeason(e.target.value)} aria-label="Season number" />
      </label>
      <label className="flex items-center gap-1">
        E <input className={field} inputMode="numeric" value={episode} onChange={(e) => setEpisode(e.target.value)} aria-label="Episode number" />
      </label>
      <button type="submit" disabled={busy || season === '' || episode === ''} className="text-accent hover:underline disabled:opacity-40">
        Save
      </button>
      {file.manual_episode != null && (
        <button type="button" onClick={() => save(true)} disabled={busy} className="hover:text-ink">
          Use the file name again
        </button>
      )}
      {error && <span className="text-danger">{error}</span>}
    </form>
  );
}

/** Rating, note, and the files behind an episode. */
export default function EpisodePanel({ episode, onChanged }) {
  const [files, setFiles] = useState(null);
  const [note, setNote] = useState(episode.note || '');
  const [saved, setSaved] = useState(null);
  const [fixing, setFixing] = useState(null);

  const loadFiles = () =>
    episode.owned ? api.episodeFiles(episode.id).then(setFiles).catch(() => setFiles([])) : setFiles([]);

  useEffect(() => {
    loadFiles();
  }, [episode.id, episode.owned]);

  async function review(body) {
    await api.reviewEpisode(episode.id, body);
    setSaved('Saved');
    setTimeout(() => setSaved(null), 1500);
    onChanged();
  }

  return (
    <div className="grid gap-4 border-b border-edge/60 bg-surface/60 px-4 py-4 pl-[72px] last:border-b-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {episode.overview && <p className="mb-3 text-[13px] leading-relaxed text-ink-dim">{episode.overview}</p>}
        <div className="flex items-center gap-3">
          <RatingStars value={episode.user_rating} onChange={(rating) => review({ rating })} />
          {saved && <span className="text-[11px] text-good">{saved}</span>}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (episode.note || '') && review({ note })}
          placeholder="Notes: a favourite moment, who you watched it with…"
          aria-label="Episode notes"
          rows={2}
          maxLength={4000}
          className="mt-2 w-full resize-y rounded border border-edge bg-bg px-3 py-2 text-[12.5px] text-ink outline-none transition placeholder:text-ink-dim/50 focus:border-accent/50"
        />
      </div>

      <div className="min-w-0">
        {!episode.owned ? (
          <p className="text-[12px] text-ink-dim">Not on disk.</p>
        ) : !files ? (
          <Spinner />
        ) : (
          <ul className="grid gap-2">
            {files.map((f) => (
              <li key={f.id} className="min-w-0">
                <div className="mono truncate text-[11px] text-ink" title={f.path}>{f.filename}</div>
                <div className="mono text-[10.5px] text-ink-dim">
                  {formatBytes(f.size_bytes)}
                  {f.manual_episode != null && ' · numbered by you'}
                </div>
                <MediaFacts media={f.media} />
                {fixing === f.id ? (
                  <Renumber file={f} onSaved={() => { setFixing(null); loadFiles(); onChanged(); }} />
                ) : (
                  <button onClick={() => setFixing(f.id)} className="mt-1 text-[11px] text-ink-dim hover:text-ink">
                    Wrong episode?
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
