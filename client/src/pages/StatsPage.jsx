import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatBytes, episodeLabel, plural } from '../api';
import { Badge, Spinner, EmptyState } from '../components/Bits';
import { FigureStrip, primaryBtn } from '../components/DetailHero';

function Delta({ now, before }) {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!Number.isFinite(pct) || pct === 0) return null;
  return (
    <Badge tone={pct > 0 ? 'good' : 'default'}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}% vs previous
    </Badge>
  );
}

function Panel({ title, aside, children, className = '' }) {
  return (
    <div className={`rounded-card border border-edge bg-surface/50 p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="display text-[12px] uppercase tracking-[0.14em] text-ink-dim">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** 90-day activity, drawn to one scale with its peak and dates labelled. */
function ActivityChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.minutes));
  const mid = data[Math.floor(data.length / 2)]?.day;
  return (
    <div>
      <div className="mono mb-2 flex justify-between text-[10px] text-ink-dim">
        <span>minutes watched per day</span>
        <span>peak {(max / 60).toFixed(1)}h</span>
      </div>
      <div className="relative h-32">
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-edge" />
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-edge/50" />
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-edge">
          {data.map((d) => (
            <div
              key={d.day}
              title={`${d.day} · ${Math.round(d.minutes)} min`}
              className="flex-1 rounded-t-[1px] bg-accent/80 transition-colors hover:bg-accent"
              style={{ height: d.minutes ? `${Math.max(3, (d.minutes / max) * 100)}%` : 0 }}
            />
          ))}
        </div>
      </div>
      <div className="mono mt-1.5 flex justify-between text-[10px] text-ink-dim">
        <span>{data[0]?.day}</span>
        <span>{mid}</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function BarList({ items, valueKey = 'count', labelKey = 'name', format = (v) => v }) {
  const max = Math.max(1, ...items.map((i) => i[valueKey]));
  return (
    <div className="grid gap-2">
      {items.map((item, i) => (
        <div
          key={`${item[labelKey]}-${i}`}
          className="grid grid-cols-[minmax(0,9.5rem)_1fr_4.75rem] items-center gap-3"
        >
          <span className="truncate text-[12px] text-ink-dim">{item[labelKey]}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${(item[valueKey] / max) * 100}%` }}
            />
          </div>
          <span className="mono text-right text-[11px] text-ink-dim">{format(item[valueKey])}</span>
        </div>
      ))}
    </div>
  );
}

function Summary({ title, now, before }) {
  return (
    <Panel title={title} aside={<Delta now={now.minutes} before={before.minutes} />}>
      <div className="flex items-baseline gap-2">
        <span className="display text-[44px] leading-none tnum text-ink">{now.hours}</span>
        <span className="display text-[15px] uppercase text-ink-dim">hours</span>
      </div>
      <div className="mono mt-2 text-[11px] text-ink-dim">
        {plural(now.episodes, 'episode')} · {plural(now.movies, 'film')} · {plural(now.shows, 'show')}
      </div>
      {now.top?.length > 0 && (
        <div className="mt-5">
          <BarList
            items={now.top}
            valueKey="minutes"
            labelKey="title"
            format={(m) => `${(m / 60).toFixed(1)}h`}
          />
        </div>
      )}
    </Panel>
  );
}

/** Hours per week or per month, so a habit shows up as a shape. */
function Trend({ data, unit }) {
  const max = Math.max(1, ...data.map((p) => p.minutes));
  const fmt = (start) => {
    const d = new Date(start + 'T12:00:00');
    return unit === 'month'
      ? d.toLocaleDateString(undefined, { month: 'short' })
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height: 132 }}>
        {data.map((p) => (
          <div key={p.start} className="flex min-w-0 flex-1 flex-col justify-end" title={`${p.hours}h · ${plural(p.episodes, 'episode')} · ${plural(p.movies, 'film')}`}>
            <div
              className={`rounded-t ${p.minutes ? 'bg-accent/70' : 'bg-edge'}`}
              style={{ height: `${p.minutes ? Math.max(4, (p.minutes / max) * 118) : 2}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mono mt-2 flex justify-between text-[10px] text-ink-dim">
        <span>{fmt(data[0]?.start || '')}</span>
        <span className="text-ink">peak {(max / 60).toFixed(1)}h</span>
        <span>{fmt(data[data.length - 1]?.start || '')}</span>
      </div>
    </div>
  );
}

// Times arrive in UTC with no zone on them. An episode watched at one in the
// morning belongs to that night, not to the day before.
function localDay(value) {
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** What you watched and when, newest first, grouped by day. */
function Timeline({ rows }) {
  if (!rows.length) return <p className="text-[13px] text-ink-dim">Nothing watched yet.</p>;
  const days = [];
  for (const r of rows) {
    const day = localDay(r.watched_at);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
    days[days.length - 1].items.push(r);
  }
  const label = (d) => {
    const date = new Date(d + 'T12:00:00');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (d === today) return 'Today';
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const title = (r) =>
    r.kind === 'movie'
      ? r.movie_title || 'Film'
      : `${r.show_title || 'Show'} · ${episodeLabel(r.season_number, r.episode_number)}${r.episode_title ? ` — ${r.episode_title}` : ''}`;

  return (
    <div className="grid gap-4">
      {days.map((d) => (
        <div key={d.day} className="grid gap-1.5">
          <div className="mono text-[10px] uppercase tracking-wider text-ink-dim">{label(d.day)}</div>
          {d.items.map((r) => (
            <div key={r.id} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-ink">{title(r)}</span>
              <span className="mono shrink-0 text-[10.5px] text-ink-dim">
                {r.minutes ? `${r.minutes}m` : ''}
                {r.is_rewatch ? ' · rewatch' : ''}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function StatsPage() {
  const [data, setData] = useState(null);
  const [unit, setUnit] = useState('week');
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    Promise.all([
      api.overview(),
      api.activity(90),
      api.summaries(),
      api.streaks(),
      api.composition(),
      api.history(60),
    ]).then(([overview, activity, summaries, streaks, composition, history]) =>
      setData({ overview, activity, summaries, streaks, composition, history })
    );
  }, []);

  useEffect(() => {
    api.periods(unit, unit === 'month' ? 12 : 12).then(setTrend);
  }, [unit]);

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Counting
      </div>
    );
  }

  const { overview, activity, summaries, streaks, composition, history } = data;
  const noWatchData = overview.watched.minutes === 0;

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Your viewing</div>
          <div className="mt-3 flex items-end gap-4">
            <span className="display text-[clamp(72px,9vw,116px)] leading-[0.8] tnum text-accent">
              {overview.watched.hours}
              <span className="text-[0.38em] text-ink-dim">h</span>
            </span>
            <div className="pb-1.5">
              <div className="display text-[15px] uppercase tracking-wide text-ink">watched</div>
              <div className="mono mt-0.5 text-[11px] text-ink-dim">
                {overview.watched.days} days of your life
              </div>
            </div>
          </div>
        </div>
        <div className="mono text-right text-[11px] leading-relaxed text-ink-dim">
          {plural(overview.watched.episodes, 'episode')} · {plural(overview.watched.movies, 'film')}
          <br />
          {overview.missing_gaps ?? overview.missing_episodes} missing from seasons you’ve started
        </div>
      </header>

      <FigureStrip
        items={[
          { label: 'Library', value: formatBytes(overview.totals.size_bytes) },
          { label: 'Titles', value: overview.totals.shows + overview.totals.movies },
          { label: 'Current streak', value: `${streaks.current}d`, tone: streaks.current ? 'accent' : null },
          { label: 'Longest streak', value: `${streaks.longest}d` },
        ]}
      />

      {noWatchData ? (
        <EmptyState
          icon="◔"
          title="No watch history yet"
          hint="Mark a few episodes watched and this page fills with charts, streaks and recaps."
          action={
            <Link to="/up-next" className={primaryBtn}>
              Go to Up Next
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4">
          <Panel title="Last 90 days">
            <ActivityChart data={activity} />
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Summary title="This week" now={summaries.week} before={summaries.prev_week} />
            <Summary title="This month" now={summaries.month} before={summaries.prev_month} />
          </div>
          <Panel
            title={unit === 'month' ? 'Hours by month' : 'Hours by week'}
            aside={
              <div className="flex items-center gap-1">
                {['week', 'month'].map((u) => (
                  <button
                    key={u}
                    onClick={() => setUnit(u)}
                    aria-pressed={unit === u}
                    className={`rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                      unit === u ? 'bg-accent/12 text-accent' : 'text-ink-dim hover:bg-surface hover:text-ink'
                    }`}
                  >
                    {u === 'week' ? 'Weekly' : 'Monthly'}
                  </button>
                ))}
              </div>
            }
          >
            {trend ? <Trend data={trend} unit={unit} /> : <Spinner />}
          </Panel>
          <Panel title="Recently watched">
            <Timeline rows={history} />
          </Panel>
        </div>
      )}

      <h2 className="display mb-4 mt-11 text-sm uppercase tracking-[0.14em] text-ink-dim">
        What’s on the shelf
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {composition.genres.length > 0 ? (
          <Panel title="Genres">
            <BarList items={composition.genres.slice(0, 8)} />
          </Panel>
        ) : (
          <Panel title="Genres">
            <p className="text-[12.5px] text-ink-dim">
              Genres arrive with TMDB metadata. Add a key in Settings to fill this in.
            </p>
          </Panel>
        )}
        <Panel title="Quality mix">
          <BarList items={composition.quality} />
        </Panel>
        <Panel title="Biggest shows">
          <BarList items={composition.biggestShows} valueKey="bytes" labelKey="title" format={formatBytes} />
        </Panel>
        <Panel title="Biggest films">
          <BarList items={composition.biggestMovies} valueKey="bytes" labelKey="title" format={formatBytes} />
        </Panel>
      </div>
    </div>
  );
}
