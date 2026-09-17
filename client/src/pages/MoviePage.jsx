import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, formatBytes, formatRuntime, formatClock } from '../api';
import { Poster, Badge, Spinner, RatingStars } from '../components/Bits';
import { MediaFacts } from '../components/EpisodePanel';
import DetailHero, { FigureStrip, primaryBtn, ghostBtn, quietBtn } from '../components/DetailHero';
import MatchDialog from '../components/MatchDialog';
import RenameDialog from '../components/RenameDialog';
import { PlayButton, RowActions, SubtitleDialog, toast, playTarget } from '../components/MediaActions';

export default function MoviePage() {
  const { id } = useParams();
  const [movie, setMovie] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null); // 'match' | 'rename' | null
  const [subsFor, setSubsFor] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  async function load() {
    try {
      setMovie(await api.movie(id));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    setMovie(null);
    setDialog(null);
    load();
    const onRefresh = () => load();
    window.addEventListener('shelf:refresh', onRefresh);
    return () => window.removeEventListener('shelf:refresh', onRefresh);
  }, [id]);

  useEffect(() => {
    setNote(movie?.note || '');
  }, [movie?.id, movie?.note]);

  useEffect(() => {
    const onKey = (e) => {
      if (!movie?.files.length) return;
      if (e.detail === 'p') playTarget({ movieId: id }, movie.title);
      if (e.detail === 'w') run(() => api.watchMovie(id, !movie.watched));
    };
    window.addEventListener('shelf:shortcut', onKey);
    return () => window.removeEventListener('shelf:shortcut', onKey);
  }, [movie, id]);

  async function review(body) {
    try {
      await api.reviewMovie(id, body);
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

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

  async function closeAndRefresh() {
    setDialog(null);
    await load();
    window.dispatchEvent(new CustomEvent('shelf:refresh'));
  }

  if (error && !movie) return <div className="text-sm text-danger">{error}</div>;

  if (!movie) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Loading
      </div>
    );
  }

  const totalBytes = movie.files.reduce((n, f) => n + (f.size_bytes || 0), 0);
  const quality = movie.files.find((f) => f.quality)?.quality;

  return (
    <div>
      <DetailHero
        backdropPath={movie.backdrop_path}
        poster={movie.poster}
        title={movie.title}
        emoji={movie.icon_emoji}
        eyebrow={movie.collection_name ? `Collection · ${movie.collection_name}` : 'Film'}
        genres={movie.genres}
        tagline={movie.tagline}
        overview={movie.overview}
        meta={
          <>
            {movie.year && <span className="text-ink">{movie.year}</span>}
            {movie.runtime && (
              <>
                <span>·</span>
                <span>{formatRuntime(movie.runtime)}</span>
              </>
            )}
            {movie.vote_average > 0 && (
              <>
                <span>·</span>
                <span className="text-accent">★ {movie.vote_average.toFixed(1)}</span>
              </>
            )}
          </>
        }
        titleAddon={
          <button
            onClick={() => run(() => api.updateMovie(id, { is_favorite: movie.is_favorite ? 0 : 1 }))}
            aria-label={movie.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
            className={`mt-1 grid h-8 w-8 place-items-center rounded border text-base transition ${
              movie.is_favorite
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-edge bg-surface/70 text-ink-dim hover:text-accent'
            }`}
          >
            ★
          </button>
        }
        actions={
          <>
          {movie.files.length > 0 && (
            <PlayButton target={{ movieId: id }} label={movie.title}>
              {!movie.watched && movie.progress_seconds > 60 ? `Resume ${formatClock(movie.progress_seconds)}` : 'Play'}
            </PlayButton>
          )}
          {movie.watched ? (
            <>
              <span className="display rounded border border-accent/40 bg-accent/10 px-4 py-2 text-[12.5px] uppercase tracking-wide text-accent">
                ✓ Watched{movie.watched_at ? ` · ${String(movie.watched_at).slice(0, 10)}` : ''}
              </span>
              <button
                className={ghostBtn}
                disabled={busy}
                onClick={() => run(() => api.watchMovie(id, false))}
              >
                Mark unwatched
              </button>
            </>
          ) : (
            <button
              className={movie.files.length ? ghostBtn : primaryBtn}
              disabled={busy || !movie.files.length}
              onClick={() => run(() => api.watchMovie(id, true))}
            >
              Mark watched
            </button>
          )}
          </>
        }
        posterSlot={
          <>
            <button onClick={() => setDialog('match')} className={quietBtn}>
              {movie.tmdb_id ? 'Fix match' : 'Find on TMDB'}
            </button>
            <button onClick={() => setDialog('rename')} className={quietBtn}>
              Rename
            </button>
            <button onClick={() => fileRef.current?.click()} className={quietBtn}>
              Upload poster
            </button>
            {movie.custom_poster && (
              <button onClick={() => run(() => api.clearMoviePoster(id))} className={quietBtn}>
                Remove uploaded poster
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) run(() => api.uploadPoster('movies', id, f));
              }}
            />
          </>
        }
      />

      <FigureStrip
        items={[
          { label: 'Runtime', value: formatRuntime(movie.runtime) || '—' },
          { label: 'Quality', value: quality || '—', tone: quality ? 'accent' : null },
          { label: 'Files', value: movie.files.length },
          { label: 'Size', value: formatBytes(totalBytes) },
        ]}
      />

      {error && <div className="mb-4 text-[12px] text-danger">{error}</div>}

      <section className="mb-10 grid gap-3 rounded-card border border-edge bg-surface/40 p-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:gap-8">
        <div>
          <h3 className="display mb-2 text-sm uppercase tracking-[0.14em] text-ink-dim">Your rating</h3>
          <RatingStars value={movie.watch_rating} onChange={(rating) => review({ rating })} size="text-[24px]" />
        </div>
        <div className="min-w-0">
          <h3 className="display mb-2 text-sm uppercase tracking-[0.14em] text-ink-dim">Notes</h3>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (movie.note || '') && review({ note })}
            placeholder="What you thought, who recommended it…"
            aria-label="Film notes"
            rows={2}
            maxLength={4000}
            className="w-full resize-y rounded border border-edge bg-bg px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-dim/50 focus:border-accent/50"
          />
        </div>
      </section>

      {movie.files.length > 0 && (
        <section>
          <h3 className="display mb-3 text-sm uppercase tracking-[0.14em] text-ink-dim">On disk</h3>
          <div className="overflow-hidden rounded-card border border-edge">
            {movie.files.map((f) => (
              <div
                key={f.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto_72px] items-center gap-4 border-b border-edge/60 px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="mono truncate text-[11.5px] text-ink">{f.filename}</div>
                  <div className="mono mt-0.5 truncate text-[10px] text-ink-dim">{f.path}</div>
                  <MediaFacts media={f.media} />
                </div>
                <div className="flex gap-1.5">
                  {f.source && <Badge>{f.source}</Badge>}
                  {!f.media && f.codec && <Badge>{f.codec}</Badge>}
                  {!f.media && f.quality && <Badge tone="accent">{f.quality}</Badge>}
                </div>
                <RowActions
                  target={{ fileId: f.id }}
                  label={f.filename}
                  subtitles={f.subtitles.map((x) => x.lang || x.format)}
                  onSubtitles={() => setSubsFor(f)}
                />
                <span className="mono text-right text-[11px] text-ink-dim">
                  {formatBytes(f.size_bytes)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {movie.collection_siblings?.length > 0 && (
        <section className="mt-10">
          <h3 className="display mb-4 text-sm uppercase tracking-[0.14em] text-ink-dim">
            More in {movie.collection_name}
          </h3>
          <div className="flex flex-wrap gap-4">
            {movie.collection_siblings.map((s) => (
              <Link key={s.id} to={`/movie/${s.id}`} className="group w-[120px]">
                <Poster
                  poster={s.custom_poster || (s.poster_path ? `tmdb:${s.poster_path}` : null)}
                  title={s.tmdb_title || s.title}
                />
                <div className="mt-2 truncate text-[12px] font-medium text-ink group-hover:text-accent">
                  {s.tmdb_title || s.title}
                </div>
                <div className="mono text-[10px] text-ink-dim">{s.year || '—'}</div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {subsFor && (
        <SubtitleDialog
          target={{ fileId: subsFor.id }}
          title={`${movie.title}${movie.year ? ` (${movie.year})` : ''}`}
          onClose={() => setSubsFor(null)}
          onSaved={load}
        />
      )}

      {dialog === 'match' && (
        <MatchDialog
          kind="movie"
          id={id}
          initialQuery={movie.title}
          onClose={() => setDialog(null)}
          onMatched={closeAndRefresh}
        />
      )}

      {dialog === 'rename' && (
        <RenameDialog
          label="film"
          initial={movie.title}
          onSave={async (title) => {
            await api.updateMovie(id, { title });
            await closeAndRefresh();
          }}
          onReset={
            movie.file_title && movie.file_title !== movie.title
              ? async () => {
                  await api.updateMovie(id, { title: null });
                  await closeAndRefresh();
                }
              : null
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
