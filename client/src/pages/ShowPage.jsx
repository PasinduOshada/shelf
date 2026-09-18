import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, formatBytes, countdown, formatClock, episodeLabel, plural } from '../api';
import { Badge, Spinner, StatusPicker } from '../components/Bits';
import DetailHero, { FigureStrip, ghostBtn, quietBtn } from '../components/DetailHero';
import { PlayButton, RowActions, SubtitleDialog, toast, playTarget } from '../components/MediaActions';
import EpisodePanel, { Renumber } from '../components/EpisodePanel';
import MatchDialog from '../components/MatchDialog';
import RenameDialog from '../components/RenameDialog';
import OrderingDialog from '../components/OrderingDialog';

const EMOJI = ['🔥', '👑', '🗡️', '🚀', '🧟', '🕵️', '💀', '🌊', '🐉', '🎭', '🧪', '❤️', '🍿', '🌌'];

// Diagonal hatching marks an episode that aired but is not on disk.
const MISSING_HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg, transparent 0 7px, rgb(var(--edge) / 0.45) 7px 8px)',
};

const epCode = (e) => episodeLabel(e.season_number, e.episode_number);

function EpisodeRow({ episode, onToggle, busy, onSubtitles, expanded, onExpand, onChanged }) {
  // The server decides what counts as missing (specials and unscheduled
  // episodes are excluded), so the row trusts that flag.
  const missing = episode.missing;

  let sub = null;
  if (episode.upcoming) sub = <span className="text-accent">airs {countdown(episode.air_date)}</span>;
  else if (missing) sub = <span className="text-warn/90">aired · not on disk</span>;
  else if (episode.air_date) sub = <span>{episode.air_date}</span>;

  const resumable = !episode.watched && episode.progress_seconds > 60 && episode.duration_seconds;
  const subtitleLangs = [...new Set([...(episode.subtitles || []), ...(episode.embedded_subtitles || [])])];

  return (
    <>
    <div
      className={`grid grid-cols-[22px_34px_minmax(0,1fr)_auto_auto_68px] items-center gap-3 border-b border-edge/60 px-4 py-2.5 last:border-b-0 ${
        missing ? '' : 'transition-colors hover:bg-surface'
      }`}
      style={missing ? MISSING_HATCH : undefined}
    >
      <button
        onClick={() => onToggle(episode)}
        disabled={!episode.owned || busy}
        aria-label={episode.watched ? 'Mark unwatched' : 'Mark watched'}
        title={episode.owned ? 'Toggle watched' : 'Not on disk'}
        className={`grid h-[18px] w-[18px] place-items-center rounded-[4px] border text-[10px] font-bold transition ${
          episode.watched
            ? 'border-accent bg-accent text-accent-ink'
            : 'border-edge text-transparent hover:border-accent/70'
        } ${!episode.owned ? 'cursor-not-allowed opacity-35' : ''}`}
      >
        ✓
      </button>

      <span className="mono text-right text-[12px] text-ink-dim">
        {String(episode.episode_number).padStart(2, '0')}
      </span>

      <button
        onClick={onExpand}
        aria-expanded={expanded}
        className="min-w-0 text-left"
        title="Rating, notes and file details"
      >
        <div className={`flex items-center gap-2 truncate text-[13.5px] ${episode.owned ? 'text-ink' : 'text-ink-dim'}`}>
          <span className="truncate">{episode.title || `Episode ${episode.episode_number}`}</span>
          {episode.user_rating ? <span className="shrink-0 text-[11px] text-accent">★ {episode.user_rating / 2}</span> : null}
          {episode.note ? <span className="shrink-0 text-[11px] text-ink-dim" title={episode.note}>✎</span> : null}
        </div>
        {(sub || resumable) && (
          <div className="mono mt-0.5 flex items-center gap-2 text-[10.5px] text-ink-dim">
            {sub}
            {resumable && (
              <span className="flex items-center gap-1.5 text-accent">
                <span className="relative h-[3px] w-14 overflow-hidden rounded-full bg-ink/15">
                  <span
                    className="absolute inset-y-0 left-0 bg-accent"
                    style={{ width: `${Math.min(100, (episode.progress_seconds / episode.duration_seconds) * 100)}%` }}
                  />
                </span>
                resume {formatClock(episode.progress_seconds)}
              </span>
            )}
          </div>
        )}
      </button>

      <div className="flex items-center gap-1.5">
        {episode.hdr && <Badge tone="good">{episode.hdr}</Badge>}
        {episode.quality && <Badge>{episode.quality}</Badge>}
        {episode.file_count > 1 && <Badge tone="danger">{episode.file_count} copies</Badge>}
      </div>

      <div className="w-[118px]">
        {episode.owned && (
          <RowActions
            target={{ fileId: episode.file_id }}
            label={epCode(episode)}
            subtitles={subtitleLangs}
            onSubtitles={() => onSubtitles(episode)}
          />
        )}
      </div>

      <span className="mono text-right text-[11px] text-ink-dim" title={episode.size_bytes ? formatBytes(episode.size_bytes) : undefined}>
        {episode.duration ? formatClock(episode.duration) : episode.size_bytes > 0 ? formatBytes(episode.size_bytes) : '—'}
      </span>
    </div>
    {expanded && <EpisodePanel episode={episode} onChanged={onChanged} />}
    </>
  );
}

export default function ShowPage() {
  const { id } = useParams();
  const [show, setShow] = useState(null);
  const [openSeason, setOpenSeason] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dialog, setDialog] = useState(null); // 'match' | 'rename' | 'order' | null
  const [subsFor, setSubsFor] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [fixingExtra, setFixingExtra] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  async function load() {
    try {
      const data = await api.show(id);
      setShow(data);
      setOpenSeason((current) =>
        current != null && data.seasons.some((s) => s.season_number === current)
          ? current
          : data.seasons.find((s) => s.season_number > 0)?.season_number ??
            data.seasons[0]?.season_number ??
            null
      );
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setShow(null);
    setOpenSeason(null);
    setDialog(null);
    setExpanded(null);
    load();
    // Playback tracking and other windows change watch state: stay current.
    const onRefresh = () => load();
    window.addEventListener('shelf:refresh', onRefresh);
    return () => window.removeEventListener('shelf:refresh', onRefresh);
  }, [id]);

  async function fetchSeasonSubtitles(seasonNumber) {
    try {
      toast('Looking for subtitles…');
      const r = await api.fetchSubtitles({ showId: id, season: seasonNumber });
      toast(
        r?.stopped
          ? `Downloaded ${r.downloaded}. ${r.stopped}.`
          : `Downloaded ${r?.downloaded ?? 0} subtitle${r?.downloaded === 1 ? '' : 's'}${r?.skipped ? `; ${r.skipped} already had one` : ''}.`
      );
      load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const nextUp = useMemo(() => {
    if (!show) return null;
    // Specials come last: they are watched around a series, not before it.
    const seasons = [...show.seasons].sort(
      (a, b) => (a.season_number === 0) - (b.season_number === 0) || a.season_number - b.season_number
    );
    for (const season of seasons) {
      const ep = season.episodes.find((e) => e.owned && !e.watched);
      if (ep) return ep;
    }
    return null;
  }, [show]);

  // Keyboard: p plays the next episode, w marks it watched.
  useEffect(() => {
    const onKey = (e) => {
      if (!nextUp) return;
      if (e.detail === 'p') playTarget({ fileId: nextUp.file_id }, `${show.title} ${epCode(nextUp)}`);
      if (e.detail === 'w') toggleEpisode(nextUp);
    };
    window.addEventListener('shelf:shortcut', onKey);
    return () => window.removeEventListener('shelf:shortcut', onKey);
  }, [nextUp, show]);

  async function run(fn) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const toggleEpisode = (ep) => run(() => api.watchEpisode(ep.id, !ep.watched));
  const markSeason = (season, watched) => run(() => api.watchShow(id, { season, watched }));
  const patch = (body) => run(() => api.updateShow(id, body));

  async function uploadPoster(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await run(() => api.uploadPoster('shows', id, file));
  }

  async function closeAndRefresh() {
    setDialog(null);
    await load();
    window.dispatchEvent(new CustomEvent('shelf:refresh'));
  }

  if (error && !show) {
    return <div className="text-sm text-danger">{error}</div>;
  }

  if (!show) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Loading
      </div>
    );
  }

  const season = show.seasons.find((s) => s.season_number === openSeason);
  const eyebrow = [show.network, show.status].filter(Boolean).join(' · ') || 'Series';

  return (
    <div>
      <DetailHero
        backdropPath={show.backdrop_path}
        poster={show.poster}
        title={show.title}
        emoji={show.icon_emoji}
        eyebrow={eyebrow}
        genres={show.genres}
        overview={show.overview}
        meta={
          <>
            {show.year && <span className="text-ink">{show.year}</span>}
            <span>{show.seasons.length} {show.seasons.length === 1 ? 'season' : 'seasons'}</span>
            <span>·</span>
            <span>{plural(show.stats.total, 'episode')}</span>
            {show.vote_average > 0 && (
              <>
                <span>·</span>
                <span className="text-accent">★ {show.vote_average.toFixed(1)}</span>
              </>
            )}
          </>
        }
        titleAddon={
          <div className="relative mt-1 flex items-center gap-1.5">
            <StatusPicker
              value={show.user_status}
              onChange={(user_status) => patch({ user_status })}
            />
            <button
              onClick={() => patch({ is_favorite: show.is_favorite ? 0 : 1 })}
              aria-label={show.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
              className={`grid h-8 w-8 place-items-center rounded border text-base transition ${
                show.is_favorite
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-edge bg-surface/70 text-ink-dim hover:text-accent'
              }`}
            >
              ★
            </button>
            <button
              onClick={() => setPicker((v) => !v)}
              aria-label="Set folder icon"
              className="grid h-8 w-8 place-items-center rounded border border-edge bg-surface/70 text-base transition hover:border-accent/50"
            >
              {show.icon_emoji || <span className="text-[11px] text-ink-dim">+</span>}
            </button>
            {picker && (
              <div className="absolute left-0 top-10 z-40 grid w-60 grid-cols-7 gap-1 rounded border border-edge bg-surface p-2 shadow-2xl">
                {EMOJI.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      patch({ icon_emoji: e });
                      setPicker(false);
                    }}
                    className="grid h-7 place-items-center rounded hover:bg-surface-2"
                  >
                    {e}
                  </button>
                ))}
                <button
                  onClick={() => {
                    patch({ icon_emoji: null });
                    setPicker(false);
                  }}
                  className="col-span-7 mt-1 rounded py-1 text-[11px] text-ink-dim hover:bg-surface-2"
                >
                  Clear icon
                </button>
              </div>
            )}
          </div>
        }
        actions={
          <>
            {nextUp ? (
              <>
                <PlayButton target={{ fileId: nextUp.file_id }} label={`${show.title} ${epCode(nextUp)}`}>
                  Play {epCode(nextUp)}
                </PlayButton>
                <button className={ghostBtn} disabled={busy} onClick={() => toggleEpisode(nextUp)}>
                  Mark watched
                </button>
              </>
            ) : show.stats.owned > 0 ? (
              <span className="display rounded border border-accent/40 px-4 py-2 text-[12.5px] uppercase tracking-wide text-accent">
                All caught up
              </span>
            ) : null}
            {show.next_air_date && (
              <span className="mono inline-flex items-center gap-2 rounded border border-edge bg-surface/70 px-3 py-2 text-[11px] text-ink/85 backdrop-blur-sm">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {episodeLabel(show.next_season, show.next_episode)} {countdown(show.next_air_date)}
              </span>
            )}
          </>
        }
        posterSlot={
          <>
            <button onClick={() => setDialog('match')} className={quietBtn}>
              {show.tmdb_id ? 'Fix match' : 'Find on TMDB'}
            </button>
            <button onClick={() => setDialog('rename')} className={quietBtn}>
              Rename
            </button>
            <button onClick={() => fileRef.current?.click()} className={quietBtn}>
              Upload poster
            </button>
            {show.custom_poster && (
              <button onClick={() => run(() => api.clearShowPoster(id))} className={quietBtn}>
                Remove uploaded poster
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={uploadPoster} />
          </>
        }
      />

      <FigureStrip
        items={[
          { label: 'On disk', value: show.stats.owned },
          { label: 'Watched', value: show.stats.watched },
          { label: 'Missing', value: show.stats.missing, tone: show.stats.missing ? 'warn' : null },
          { label: 'Progress', value: `${show.stats.progress}%`, tone: 'accent' },
          { label: 'Size', value: formatBytes(show.stats.size_bytes) },
        ]}
      />

      {error && <div className="mb-4 text-[12px] text-danger">{error}</div>}

      {show.seasons.length > 0 && (
        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-edge">
            <div className="no-scrollbar -mb-px flex gap-6 overflow-x-auto">
              {show.seasons.map((s) => {
                const on = openSeason === s.season_number;
                return (
                  <button
                    key={s.season_number}
                    onClick={() => setOpenSeason(s.season_number)}
                    className={`display relative shrink-0 border-b-2 pb-2.5 text-[13px] uppercase tracking-[0.08em] transition-colors ${
                      on ? 'border-accent text-ink' : 'border-transparent text-ink-dim hover:text-ink'
                    }`}
                  >
                    {s.name}
                    {s.missing_count > 0 && (
                      <span className="mono ml-1.5 text-[10px] tracking-normal text-warn">
                        −{s.missing_count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-4 pb-2.5">
              {show.tmdb_id && (
                <button
                  onClick={() => setDialog('order')}
                  className="mono text-[10.5px] text-ink-dim transition hover:text-ink"
                  title="Choose how episodes are grouped into seasons"
                >
                  Order: {show.episode_group_name || 'TMDB seasons'} ▾
                </button>
              )}
              {season && (
                <>
                  <span className="mono text-[11px] text-ink-dim">
                    {season.owned_count}/{season.episode_count} on disk · {season.watched_count} watched
                  </span>
                  <button
                    onClick={() => markSeason(season.season_number, true)}
                    disabled={busy}
                    className="text-[11px] text-accent transition hover:underline disabled:opacity-40"
                  >
                    Mark season watched
                  </button>
                  <button
                    onClick={() => markSeason(season.season_number, false)}
                    disabled={busy}
                    className="text-[11px] text-ink-dim transition hover:text-ink disabled:opacity-40"
                  >
                    Clear
                  </button>
                  {season.owned_count > 0 && (
                    <button
                      onClick={() => fetchSeasonSubtitles(season.season_number)}
                      className="text-[11px] text-ink-dim transition hover:text-ink"
                      title="Download missing subtitles in your languages (Settings → Subtitles)"
                    >
                      Get subtitles
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {season && (
            <div className="overflow-hidden rounded-card border border-edge bg-surface/40">
              {season.episodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  onToggle={toggleEpisode}
                  busy={busy}
                  onSubtitles={setSubsFor}
                  expanded={expanded === ep.id}
                  onExpand={() => setExpanded((cur) => (cur === ep.id ? null : ep.id))}
                  onChanged={load}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {show.extras?.length > 0 && (
        <section className="mt-10">
          <h3 className="display mb-3 text-sm uppercase tracking-[0.14em] text-ink-dim">
            Extras &amp; unmatched files
            <span className="mono ml-2 text-[10px] tracking-normal">{show.extras.length}</span>
          </h3>
          <div className="overflow-hidden rounded-card border border-edge">
            {show.extras.map((f) => (
              <div key={f.id} className="border-b border-edge/60 px-4 py-2 last:border-b-0">
              <div className="flex items-center gap-4">
                <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-ink-dim">
                  {f.filename}
                </span>
                {f.quality && <Badge>{f.quality}</Badge>}
                <span className="mono text-[11px] text-ink-dim">{formatBytes(f.size_bytes)}</span>
                <RowActions
                  target={{ fileId: f.id }}
                  label={f.filename}
                  onSubtitles={() => setSubsFor({ file_id: f.id, extra: f.filename })}
                />
                <button onClick={() => setFixingExtra(fixingExtra === f.id ? null : f.id)} className="text-[11px] text-ink-dim hover:text-ink">
                  Set episode
                </button>
              </div>
              {fixingExtra === f.id && (
                <Renumber file={f} onSaved={() => { setFixingExtra(null); load(); }} />
              )}
              </div>
            ))}
          </div>
        </section>
      )}

      {dialog === 'match' && (
        <MatchDialog
          kind="show"
          id={id}
          initialQuery={show.title}
          onClose={() => setDialog(null)}
          onMatched={closeAndRefresh}
        />
      )}

      {dialog === 'rename' && (
        <RenameDialog
          label="series"
          initial={show.title}
          onSave={async (title) => {
            await api.updateShow(id, { title });
            await closeAndRefresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {subsFor && (
        <SubtitleDialog
          target={{ fileId: subsFor.file_id }}
          title={subsFor.extra || `${show.title} · ${epCode(subsFor)}${subsFor.title ? ` · ${subsFor.title}` : ''}`}
          onClose={() => setSubsFor(null)}
          onSaved={load}
        />
      )}

      {dialog === 'order' && (
        <OrderingDialog showId={id} onClose={() => setDialog(null)} onChanged={closeAndRefresh} />
      )}
    </div>
  );
}
