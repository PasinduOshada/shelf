import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Poster, ProgressBar, EmptyState, SectionTitle, Spinner } from '../components/Bits';
import { titleHue, primaryBtn, ghostBtn } from '../components/DetailHero';
import { playTarget } from '../components/MediaActions';

function CountdownCard({ item }) {
  const days = item.days_until;
  const soon = days <= 7;
  return (
    <Link
      to={`/show/${item.show_id}`}
      className="group flex w-[252px] shrink-0 gap-3 rounded-card border border-edge bg-surface p-2.5 transition hover:border-accent/45"
    >
      <div className="w-[62px] shrink-0">
        <Poster poster={item.poster} title={item.show_title} emoji={item.icon_emoji} size="w185" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate text-[12.5px] font-medium text-ink group-hover:text-accent">
          {item.show_title}
        </div>
        <div className="mono mt-0.5 truncate text-[10.5px] text-ink-dim">
          S{item.season_number}E{item.episode_number}
          {item.episode_title ? ` · ${item.episode_title}` : ''}
        </div>
        <div className="mt-auto flex items-baseline gap-1.5">
          <span
            className={`display text-[30px] leading-none tnum ${soon ? 'text-accent' : 'text-ink'}`}
          >
            {days === 0 ? 'Today' : days}
          </span>
          {days > 0 && (
            <span className="mono text-[10px] uppercase tracking-wider text-ink-dim">
              {days === 1 ? 'day' : 'days'}
            </span>
          )}
        </div>
        <div className="mono text-[10px] text-ink-dim">{item.air_date}</div>
      </div>
    </Link>
  );
}

function NewEpisodes({ airing }) {
  const list = [...(airing.today || []), ...(airing.recent || [])].filter((e) => !e.watched);
  if (!list.length) return null;
  const today = new Set((airing.today || []).map((e) => e.id));
  return (
    <section>
      <SectionTitle>New this week</SectionTitle>
      <div className="overflow-hidden rounded-card border border-edge">
        {list.slice(0, 20).map((e) => {
          const code = `S${String(e.season_number).padStart(2, '0')}E${String(e.episode_number).padStart(2, '0')}`;
          return (
            <div key={e.id} className="flex items-center gap-3 border-b border-edge/60 px-3 py-2 last:border-b-0">
              <Link to={`/show/${e.show_id}`} className="w-9 shrink-0">
                <Poster
                  poster={e.custom_poster || (e.poster_path ? `tmdb:${e.poster_path}` : null)}
                  title={e.show_title}
                  emoji={e.icon_emoji}
                  size="w92"
                />
              </Link>
              <div className="min-w-0 flex-1">
                <Link to={`/show/${e.show_id}`} className="truncate text-[13px] text-ink hover:text-accent">
                  {e.show_title} <span className="mono text-ink-dim">{code}</span>
                </Link>
                <div className="mono truncate text-[10.5px] text-ink-dim">
                  {today.has(e.id) ? <span className="text-accent">Aired today</span> : e.air_date}
                  {e.episode_title ? ` · ${e.episode_title}` : ''}
                </div>
              </div>
              {e.owned ? (
                <button
                  onClick={() => playTarget({ episodeId: e.id }, `${e.show_title} ${code}`)}
                  className="display rounded bg-accent px-3 py-1 text-[10.5px] uppercase tracking-wide text-accent-ink transition hover:opacity-90"
                >
                  ▶ Play
                </button>
              ) : (
                <span className="text-[11px] text-ink-dim">Not downloaded yet</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ContinueCard({ item, onWatched, busy }) {
  const h = titleHue(item.title);
  return (
    <div className="group relative overflow-hidden rounded-card border border-edge transition hover:border-accent/45">
      <div
        className="absolute inset-0"
        // A translucent tint rather than a dark hue, so text stays readable on
        // both the dark themes and Daylight.
        style={{ background: `linear-gradient(110deg, hsl(${h} 50% 50% / 0.2), rgb(var(--surface)) 64%)` }}
      />
      <div className="relative flex gap-4 p-3">
        <Link to={`/show/${item.show_id}`} className="w-[74px] shrink-0">
          <Poster poster={item.poster} title={item.title} emoji={item.icon_emoji} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mono text-[9.5px] uppercase tracking-[0.2em] text-accent">Next up</div>
          <Link
            to={`/show/${item.show_id}`}
            className="display mt-1 truncate text-[17px] uppercase leading-tight text-ink transition-colors hover:text-accent"
          >
            {item.title}
          </Link>
          <div className="mono mt-1 truncate text-[11px] text-ink-dim">
            S{item.season_number}E{item.episode_number}
            {item.episode_title ? ` · ${item.episode_title}` : ''}
          </div>
          <div className="mt-auto pt-3">
            <ProgressBar value={item.progress} />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="mono text-[10.5px] text-ink-dim">
                {item.watched_count}/{item.owned_count} watched
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={() => playTarget({ episodeId: item.episode_id }, `${item.title} S${item.season_number}E${item.episode_number}`)}
                  className="display rounded bg-accent px-3 py-1 text-[10.5px] uppercase tracking-wide text-accent-ink transition hover:opacity-90"
                >
                  ▶ Play
                </button>
                <button
                  onClick={() => onWatched(item)}
                  disabled={busy}
                  className="rounded border border-edge px-2.5 py-1 text-[10.5px] text-ink transition hover:border-accent/50 disabled:opacity-40"
                >
                  Watched
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PickPanel({ pick, onReroll, onDismiss }) {
  if (pick === false) {
    return (
      <div className="mb-5 rounded-card border border-edge px-4 py-3 text-[13px] text-ink-dim">
        Nothing unwatched left to pick from.
      </div>
    );
  }
  const h = titleHue(pick.title);
  return (
    <div className="relative mb-6 overflow-hidden rounded-card border border-accent/35">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(70% 140% at 0% 0%, hsl(${h} 55% 50% / 0.22), transparent 70%), rgb(var(--surface))`,
        }}
      />
      <div className="relative flex gap-5 p-4">
        <div className="w-[92px] shrink-0">
          <Poster poster={pick.poster} title={pick.title} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">
            Tonight’s pick · {pick.kind === 'movie' ? 'film' : 'series'}
          </div>
          <div className="display mt-1.5 text-[26px] uppercase leading-none text-ink">{pick.title}</div>
          {pick.year && <div className="mono mt-1.5 text-[11px] text-ink-dim">{pick.year}</div>}
          {pick.overview && (
            <p className="mt-2 line-clamp-2 max-w-[62ch] text-[13px] text-ink-dim">{pick.overview}</p>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
            <Link to={`/${pick.kind === 'movie' ? 'movie' : 'show'}/${pick.id}`} className={primaryBtn}>
              Open
            </Link>
            <button onClick={onReroll} className={ghostBtn}>
              Reroll
            </button>
            <button onClick={onDismiss} className="ml-1 text-[11px] text-ink-dim hover:text-ink">
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function UpNextPage() {
  const [queue, setQueue] = useState(null);
  const [soon, setSoon] = useState(null);
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [airing, setAiring] = useState(null);

  async function load() {
    const [q, u, a] = await Promise.all([api.continueWatching(40), api.upcoming(120), api.airing().catch(() => null)]);
    setQueue(q);
    setSoon(u);
    setAiring(a);
  }

  useEffect(() => {
    load();
    const onRefresh = () => load();
    window.addEventListener('shelf:refresh', onRefresh);
    return () => window.removeEventListener('shelf:refresh', onRefresh);
  }, []);

  async function markWatched(item) {
    setBusy(true);
    try {
      await api.watchEpisode(item.episode_id, true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function surprise() {
    const result = await api.surprise({ unwatched: 'true' });
    setPick(result || false);
  }

  if (!queue) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Loading
      </div>
    );
  }

  const inProgress = queue.filter((q) => q.started);
  const fresh = queue.filter((q) => !q.started);

  return (
    <div className="space-y-11">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Tonight</div>
          <h1 className="display mt-2 text-[42px] uppercase leading-none text-ink">Up next</h1>
          <p className="mono mt-2.5 text-[11px] text-ink-dim">
            {inProgress.length} in progress · {soon?.length || 0} airing in the next 120 days
          </p>
        </div>
        <button onClick={surprise} className={ghostBtn}>
          Surprise me
        </button>
      </header>

      {pick !== null && (
        <PickPanel pick={pick} onReroll={surprise} onDismiss={() => setPick(null)} />
      )}

      {airing && <NewEpisodes airing={airing} />}

      {soon?.length > 0 && (
        <section>
          <SectionTitle>Airing soon</SectionTitle>
          <div className="no-scrollbar bleed flex gap-3 overflow-x-auto gutter-x pb-1">
            {soon.slice(0, 24).map((s) => (
              <CountdownCard key={s.episode_id} item={s} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>Continue watching</SectionTitle>
        {!inProgress.length ? (
          <EmptyState
            icon="▶"
            title="Nothing in progress"
            hint="Mark an episode watched and the next one lands here automatically."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {inProgress.map((item) => (
              <ContinueCard key={item.episode_id} item={item} onWatched={markWatched} busy={busy} />
            ))}
          </div>
        )}
      </section>

      {fresh.length > 0 && (
        <section>
          <SectionTitle>
            Not started
            <span className="mono ml-2 text-[10px] normal-case tracking-normal">{fresh.length}</span>
          </SectionTitle>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-x-4 gap-y-5">
            {fresh.slice(0, 30).map((item) => (
              <Link key={item.show_id} to={`/show/${item.show_id}`} className="group block rise">
                <Poster poster={item.poster} title={item.title} emoji={item.icon_emoji} />
                <div className="mt-2 truncate text-[12px] font-medium text-ink group-hover:text-accent">
                  {item.title}
                </div>
                <div className="mono truncate text-[10px] text-ink-dim">{item.owned_count} eps</div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
