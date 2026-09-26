import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, formatBytes, tmdbImg, posterUrl, episodeLabel, plural } from '../api';
import AddTitleDialog from '../components/AddTitleDialog';
import { Poster, Badge, ProgressBar, EmptyState } from '../components/Bits';
import { titleHue, primaryBtn, ghostBtn } from '../components/DetailHero';
import { PlayButton } from '../components/MediaActions';

// What you have decided about a title, not what the files say.
export const STATUSES = [
  { id: 'watching', label: 'Watching' },
  { id: 'planned', label: 'Planned' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Done' },
  { id: 'dropped', label: 'Dropped' },
];

const SORTS = [
  { id: 'title', label: 'A–Z' },
  { id: 'recent', label: 'Recent' },
  { id: 'missing', label: 'Missing' },
  { id: 'size', label: 'Largest' },
];

/* ---- hero ---------------------------------------------------------- */

function Hero({ item, onWatched, busy }) {
  const backdrop = tmdbImg(item.backdrop_path, 'w780');
  const art = posterUrl(item.poster, 'w780');
  const h = titleHue(item.title);

  return (
    <section className="relative bleed -mt-8 mb-10 overflow-hidden">
      {backdrop || art ? (
        <img
          src={backdrop || art}
          alt=""
          className="absolute inset-0 h-full w-full scale-105 object-cover object-top opacity-55 blur-[1px]"
        />
      ) : (
        // No artwork yet: light the band in the title's own hue, like a
        // projector spilling colour, so the opening is never a black slab.
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(70% 150% at 80% 0%, hsl(${h} 52% 30% / 0.95), transparent 62%),
              radial-gradient(55% 120% at 0% 100%, rgb(var(--accent) / 0.16), transparent 60%),
              linear-gradient(120deg, hsl(${(h + 28) % 360} 30% 12%), rgb(var(--bg)) 82%)`,
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/55 to-bg/5" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/90 via-bg/40 to-transparent" />

      <div className="relative grid items-end gap-10 gutter-x pb-9 pt-20 lg:grid-cols-[minmax(0,1fr)_196px]">
        <div className="min-w-0">
          <div className="mono mb-2.5 text-[10px] uppercase tracking-[0.22em] text-accent">
            Continue watching
          </div>
          <h1 className="display max-w-2xl text-[clamp(34px,5vw,64px)] uppercase leading-[0.9] text-ink">
            {item.title}
          </h1>
          <div className="mono mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
            <span className="text-ink">
              {episodeLabel(item.season_number, item.episode_number)}
            </span>
            {item.episode_title && <span className="max-w-sm truncate">{item.episode_title}</span>}
            <span>·</span>
            <span>
              {item.watched_count}/{item.owned_count} watched
            </span>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <PlayButton
              target={{ episodeId: item.episode_id }}
              label={`${item.title} ${episodeLabel(item.season_number, item.episode_number)}`}
            >
              Play {episodeLabel(item.season_number, item.episode_number)}
            </PlayButton>
            <button onClick={onWatched} disabled={busy} className={ghostBtn}>
              Mark watched
            </button>
            <Link to={`/show/${item.show_id}`} className={ghostBtn}>
              Open show
            </Link>
          </div>
          <div className="mt-6 max-w-sm">
            <ProgressBar value={item.progress} />
          </div>
        </div>

        <Link
          to={`/show/${item.show_id}`}
          className="group hidden justify-self-end lg:block lg:w-[196px]"
          aria-label={`Open ${item.title}`}
        >
          <Poster
            poster={item.poster}
            title={item.title}
            emoji={item.icon_emoji}
            size="w342"
            className="rotate-[1.5deg] shadow-[0_30px_70px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/10 transition-transform duration-500 group-hover:rotate-0"
          />
        </Link>
      </div>
    </section>
  );
}

/* ---- cards --------------------------------------------------------- */

function ShowCard({ show }) {
  return (
    <Link to={`/show/${show.id}`} className="group block rise cv-auto">
      <Poster poster={show.poster} title={show.title} emoji={show.icon_emoji}>
        <div className="absolute inset-0 z-[3] bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        {show.missing_episodes > 0 && (
          <div className="absolute right-1.5 top-1.5 z-[3]">
            <Badge tone="glass" title={`${show.missing_episodes} episodes missing`}>
              −{show.missing_episodes}
            </Badge>
          </div>
        )}
        {show.is_favorite ? (
          <div className="absolute left-1.5 top-1.5 z-[3] text-[13px] text-accent drop-shadow">★</div>
        ) : null}
        {show.owned_episodes > 0 && show.progress > 0 && (
          <div className="absolute inset-x-2 bottom-2 z-[3]">
            <ProgressBar value={show.progress} onArt />
          </div>
        )}
      </Poster>
      <div className="mt-2 truncate text-[12.5px] font-medium text-ink transition-colors group-hover:text-accent">
        {show.title}
      </div>
      <div className="mono truncate text-[10px] text-ink-dim" title={show.search_hit?.title || ''}>
        {show.search_hit
          ? `${episodeLabel(show.search_hit.season, show.search_hit.episode)} · ${show.search_hit.title}`
          : show.owned_episodes > 0
            ? `${plural(show.owned_episodes, 'ep')} · ${formatBytes(show.size_bytes)}`
            : 'Tracking'}
      </div>
    </Link>
  );
}

function MovieCard({ movie }) {
  return (
    <Link to={`/movie/${movie.id}`} className="group block rise cv-auto">
      <Poster poster={movie.poster} title={movie.title} emoji={movie.icon_emoji}>
        <div className="absolute inset-0 z-[3] bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        {movie.watched ? (
          <div className="absolute right-1.5 top-1.5 z-[3] grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] text-accent-ink">
            ✓
          </div>
        ) : null}
        {movie.quality ? (
          // Top-left: the bottom edge is where a generated poster prints its title.
          <div className="absolute left-1.5 top-1.5 z-[3]">
            <Badge tone="glass">{movie.quality}</Badge>
          </div>
        ) : null}
      </Poster>
      <div className="mt-2 truncate text-[12.5px] font-medium text-ink transition-colors group-hover:text-accent">
        {movie.title}
      </div>
      <div className="mono truncate text-[10px] text-ink-dim">
        {movie.year || '—'}
        {movie.collection_name ? ` · ${movie.collection_name}` : ''}
        {movie.file_count === 0 ? ' · Tracking' : ''}
      </div>
    </Link>
  );
}

/* ---- list view ------------------------------------------------------ */

const ROW = 'grid items-center gap-4 border-b border-edge/50 px-3 py-2 last:border-b-0 transition-colors';
// A phone has room for the name and one figure; hiding a cell is not enough,
// its column has to go with it.
const COLS =
  'grid-cols-[minmax(0,1fr)_5rem] sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_5.5rem_6.5rem]';
const MIDDLE = 'hidden sm:block';

function ListHeader({ columns }) {
  return (
    <div className={`${ROW} ${COLS} mono border-edge text-[10px] uppercase tracking-wider text-ink-dim`}>
      {columns.map((c, i) => (
        <span
          key={c}
          className={`${i === 1 || i === 2 ? MIDDLE : ''} ${i > 1 ? 'text-right' : ''}`}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function ShowRow({ show }) {
  return (
    <Link to={`/show/${show.id}`} className={`${ROW} ${COLS} hover:bg-surface`}>
      <span className="flex min-w-0 items-center gap-2">
        {show.is_favorite ? <span className="shrink-0 text-[11px] text-accent">★</span> : null}
        <span className="truncate text-[13px] text-ink">{show.title}</span>
        {show.year ? <span className="mono shrink-0 text-[10.5px] text-ink-dim">{show.year}</span> : null}
      </span>
      <span className="mono hidden truncate text-[11px] text-ink-dim sm:block" title={show.folder_path || ''}>
        {show.folder_name || 'Tracking'}
      </span>
      <span className={`mono text-right text-[11px] text-ink-dim ${MIDDLE}`}>
        {show.owned_episodes ? `${show.watched_episodes}/${show.owned_episodes}` : '—'}
      </span>
      <span className="mono text-right text-[11px] text-ink-dim">
        {show.owned_episodes ? formatBytes(show.size_bytes) : 'tracking'}
      </span>
    </Link>
  );
}

function MovieRow({ movie }) {
  const file = movie.file_path ? movie.file_path.split(/[\\/]/).pop() : '';
  return (
    <Link to={`/movie/${movie.id}`} className={`${ROW} ${COLS} hover:bg-surface`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`shrink-0 text-[11px] ${movie.watched ? 'text-accent' : 'text-transparent'}`}>✓</span>
        {movie.is_favorite ? <span className="shrink-0 text-[11px] text-accent">★</span> : null}
        <span className="truncate text-[13px] text-ink">{movie.title}</span>
        {movie.year ? <span className="mono shrink-0 text-[10.5px] text-ink-dim">{movie.year}</span> : null}
      </span>
      <span className="mono hidden truncate text-[11px] text-ink-dim sm:block" title={movie.file_path || ''}>
        {file || 'Tracking'}
      </span>
      <span className={`mono text-right text-[11px] text-ink-dim ${MIDDLE}`}>{movie.quality || '—'}</span>
      <span className="mono text-right text-[11px] text-ink-dim">
        {movie.file_count ? formatBytes(movie.size_bytes) : 'tracking'}
      </span>
    </Link>
  );
}

/** The next episode, on one line, for people who did not come for posters. */
function ContinueLine({ item, onWatched, busy }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-edge bg-surface/50 px-4 py-2.5">
      <span className="mono text-[10px] uppercase tracking-wider text-accent">Continue</span>
      <Link to={`/show/${item.show_id}`} className="min-w-0 truncate text-[13px] text-ink hover:text-accent">
        {item.title}
      </Link>
      <span className="mono text-[11px] text-ink-dim">
        {episodeLabel(item.season_number, item.episode_number)}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <PlayButton
          target={{ episodeId: item.episode_id }}
          label={`${item.title} ${episodeLabel(item.season_number, item.episode_number)}`}
          className="!px-3 !py-1 !text-[10px]"
        >
          Play
        </PlayButton>
        <button
          onClick={onWatched}
          disabled={busy}
          className="rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim transition hover:border-accent/50 hover:text-ink disabled:opacity-50"
        >
          Watched
        </button>
      </div>
    </div>
  );
}

/* ---- genres --------------------------------------------------------- */

// One row of a shelf, so sixteen genres stay browsable instead of becoming a
// mile of posters. The rest is one click away.
const SHELF_PREVIEW = 14;

function GenreShelf({ genre }) {
  const [all, setAll] = useState(false);
  const shown = all ? genre.items : genre.items.slice(0, SHELF_PREVIEW);
  const hidden = genre.items.length - shown.length;

  return (
    <section className="cv-auto">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="display text-[15px] uppercase tracking-[0.12em] text-ink">{genre.name}</h2>
        <span className="mono text-[10px] uppercase tracking-wider text-ink-dim">
          {genre.shows > 0 && plural(genre.shows, 'show')}
          {genre.shows > 0 && genre.movies > 0 && ' · '}
          {genre.movies > 0 && plural(genre.movies, 'film')}
        </span>
        {(hidden > 0 || all) && (
          <button
            onClick={() => setAll((v) => !v)}
            className="mono ml-auto text-[10px] uppercase tracking-wider text-accent transition hover:underline"
          >
            {all ? 'Show less' : `Show all ${genre.items.length}`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-3.5 gap-y-5">
        {shown.map((item) => (
          <Link
            key={`${item.kind}-${item.id}`}
            to={`/${item.kind === 'show' ? 'show' : 'movie'}/${item.id}`}
            className="group block rise"
          >
            <Poster poster={item.poster} title={item.title} emoji={item.icon_emoji}>
              {item.watched && (
                <div className="absolute right-1.5 top-1.5 z-[3] grid h-5 w-5 place-items-center rounded-full bg-accent text-[10px] text-accent-ink">
                  ✓
                </div>
              )}
            </Poster>
            <div className="mt-1.5 truncate text-[12px] font-medium text-ink transition-colors group-hover:text-accent">
              {item.title}
            </div>
            <div className="mono truncate text-[10px] text-ink-dim">
              {item.kind === 'show' ? 'series' : item.year || 'film'}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Genres({ tmdbReady }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.genres().then(setData).catch(() => setData({ genres: [], without_genres: 0 }));
  }, []);

  if (!data) {
    return (
      <div className="grid gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <div className="skeleton h-4 w-40 rounded" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3.5">
              {Array.from({ length: 6 }).map((_, j) => (
                <div key={j} className="skeleton aspect-[2/3] rounded-card" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!data.genres.length) {
    return (
      <EmptyState
        icon="🎭"
        title="No genres yet"
        hint={
          tmdbReady
            ? 'Genres arrive with the rest of the metadata. Fetch posters and metadata in Settings, then come back.'
            : 'Genres come from TMDB. Add a free key in Settings and they appear here.'
        }
        action={
          <Link to="/settings" className={primaryBtn}>
            Open Settings
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid gap-10">
      {data.genres.map((genre) => (
        <GenreShelf key={genre.name} genre={genre} />
      ))}
      {data.without_genres > 0 && (
        <p className="text-[12.5px] text-ink-dim">
          {plural(data.without_genres, 'title')} with no genre yet — they need a TMDB match.
        </p>
      )}
    </div>
  );
}

/* ---- page ---------------------------------------------------------- */

export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = params.get('tab') || 'shows';
  const search = params.get('search') || '';
  const sort = params.get('sort') || 'title';
  const status = params.get('status') || '';

  const [shows, setShows] = useState(null);
  const [movies, setMovies] = useState(null);
  const [hero, setHero] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tmdbReady, setTmdbReady] = useState(false);
  // '' until someone picks: with no artwork to show, a plain list reads better
  // than a grid of empty boxes.
  const [chosenView, setChosenView] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const [s, m, queue] = await Promise.all([
        api.shows({ search, sort, status: status || undefined }),
        api.movies({ search, sort, status: status || undefined }),
        api.continueWatching(1),
      ]);
      setShows(s);
      setMovies(m);
      setHero(queue?.[0] || null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setTmdbReady(Boolean(s.tmdbConfigured));
        setChosenView(s.view || '');
      })
      .catch(() => setChosenView(''));
  }, []);

  const view = chosenView || (tmdbReady ? 'grid' : 'list');

  function pickView(next) {
    setChosenView(next);
    api.updateSettings({ view: next }).catch(() => {});
  }

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener('shelf:refresh', onRefresh);
    return () => window.removeEventListener('shelf:refresh', onRefresh);
  }, [search, sort, status]);

  async function markHeroWatched() {
    if (!hero) return;
    setBusy(true);
    try {
      await api.watchEpisode(hero.episode_id, true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function setParam(key, value) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }

  const browsing = tab === 'genres';
  const items = tab === 'shows' ? shows : movies;
  const totalBytes = (items || []).reduce((sum, x) => sum + (x.size_bytes || 0), 0);

  return (
    <div>
      {adding && (
        <AddTitleDialog
          tmdbReady={tmdbReady}
          onClose={() => setAdding(false)}
          onAdded={(added) => {
            setAdding(false);
            navigate(added.seasons ? `/show/${added.id}` : `/movie/${added.id}`);
          }}
        />
      )}
      {hero && !search && (
        view === 'list' ? (
          <ContinueLine item={hero} onWatched={markHeroWatched} busy={busy} />
        ) : (
          <Hero item={hero} onWatched={markHeroWatched} busy={busy} />
        )
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-5">
        <div className="flex items-center gap-6" role="tablist" aria-label="Library">
          {['shows', 'movies', 'genres'].map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setParam('tab', id === 'shows' ? null : id)}
              className={`display relative border-b-2 pb-1.5 text-sm uppercase tracking-[0.12em] transition-colors ${
                tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-dim hover:text-ink'
              }`}
            >
              {id}
              <span className="mono ml-2 text-[10px] tracking-normal opacity-60">
                {id === 'genres' ? '' : id === 'shows' ? shows?.length ?? '' : movies?.length ?? ''}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim transition hover:border-accent/50 hover:text-ink"
        >
          + Add watched
        </button>
        </div>

        <div className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 ${browsing ? 'hidden' : ''}`}>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
            {STATUSES.map((f) => (
              <button
                key={f.id}
                onClick={() => setParam('status', status === f.id ? null : f.id)}
                aria-pressed={status === f.id}
                className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                  status === f.id
                    ? 'bg-accent/12 text-accent'
                    : 'text-ink-dim hover:bg-surface hover:text-ink'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="mono text-[11px] text-ink-dim">{formatBytes(totalBytes)}</span>
          <div className="flex items-center gap-1" role="group" aria-label="How to show the library">
            {[
              { id: 'grid', label: 'Grid' },
              { id: 'list', label: 'List' },
            ].map((v) => (
              <button
                key={v.id}
                onClick={() => pickView(v.id)}
                aria-pressed={view === v.id}
                className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                  view === v.id ? 'bg-accent/12 text-accent' : 'text-ink-dim hover:bg-surface hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => setParam('sort', s.id === 'title' ? null : s.id)}
                className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                  sort === s.id
                    ? 'bg-accent/12 text-accent'
                    : 'text-ink-dim hover:bg-surface hover:text-ink'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {search && (
        <div className="mb-5 flex items-center gap-2 text-[13px] text-ink-dim">
          Results for <span className="font-medium text-ink">“{search}”</span>
          <button onClick={() => setParam('search', null)} className="text-accent hover:underline">
            clear
          </button>
        </div>
      )}

      {browsing ? (
        <Genres tmdbReady={tmdbReady} />
      ) : loading && !items ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="skeleton aspect-[2/3] rounded-card" />
              <div className="skeleton h-3 w-3/4 rounded" />
            </div>
          ))}
        </div>
      ) : !items?.length ? (
        <EmptyState
          icon={tab === 'shows' ? '📺' : '🎞'}
          title={
            search ? 'Nothing matched'
            : status ? `Nothing marked ${STATUSES.find((f) => f.id === status)?.label.toLowerCase()}`
            : `No ${tab} indexed`
          }
          hint={
            search ? 'Try a different title.'
            : status ? 'Set the status from a show or film page.'
            : 'Add a library folder in Settings, then run a scan.'
          }
          action={
            search || status ? (
              <button
                onClick={() => {
                  setParam('search', null);
                  setParam('status', null);
                }}
                className={primaryBtn}
              >
                Clear filters
              </button>
            ) : (
              <Link to="/settings" className={primaryBtn}>
                Open Settings
              </Link>
            )
          }
        />
      ) : view === 'list' ? (
        <div className="rounded-card border border-edge bg-surface/40">
          <ListHeader
            columns={
              tab === 'shows'
                ? ['Show', 'Folder', 'Watched', 'Size']
                : ['Film', 'File', 'Quality', 'Size']
            }
          />
          {tab === 'shows'
            ? shows.map((s) => <ShowRow key={s.id} show={s} />)
            : movies.map((m) => <MovieRow key={m.id} movie={m} />)}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6">
          {tab === 'shows'
            ? shows.map((s) => <ShowCard key={s.id} show={s} />)
            : movies.map((m) => <MovieCard key={m.id} movie={m} />)}
        </div>
      )}
    </div>
  );
}
