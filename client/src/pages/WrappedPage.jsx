import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Poster, EmptyState, Spinner } from '../components/Bits';
import { primaryBtn } from '../components/DetailHero';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The one typographic risk on this page: an outlined year, like a title card.
const OUTLINE = {
  color: 'transparent',
  WebkitTextStroke: '1.5px rgb(var(--text) / 0.9)',
};

function Credits({ items }) {
  return (
    <dl
      className="mb-12 grid border-y border-edge"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(({ label, value, sub }, i) => (
        <div key={label} className={`min-w-0 px-5 py-6 ${i > 0 ? 'border-l border-edge' : ''}`}>
          <dd className="display text-[clamp(40px,5vw,64px)] leading-none tnum text-ink">{value}</dd>
          <dt className="display mt-2 text-[12px] uppercase tracking-[0.16em] text-accent">{label}</dt>
          {sub && <div className="mono mt-1 truncate text-[10.5px] text-ink-dim">{sub}</div>}
        </div>
      ))}
    </dl>
  );
}

function MonthChart({ months }) {
  const max = Math.max(1, ...months.map((m) => m.minutes));
  return (
    <div>
      <div className="mono mb-2 flex justify-between text-[10px] text-ink-dim">
        <span>hours per month</span>
        <span>peak {(max / 60).toFixed(1)}h</span>
      </div>
      <div className="relative h-44">
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-edge" />
        <div className="absolute inset-0 flex items-end gap-2 border-b border-edge">
          {months.map((m) => (
            <div
              key={m.month}
              title={`${MONTHS[m.month - 1]} · ${(m.minutes / 60).toFixed(1)}h`}
              className="flex-1 rounded-t-[2px] bg-gradient-to-t from-accent/45 to-accent"
              style={{ height: m.minutes ? `${Math.max(2, (m.minutes / max) * 100)}%` : 0 }}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        {months.map((m) => (
          <span key={m.month} className="mono flex-1 text-center text-[10px] text-ink-dim">
            {MONTHS[m.month - 1]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function WrappedPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api.wrapped(year).then(setData);
  }, [year]);

  const years = [thisYear - 2, thisYear - 1, thisYear];

  return (
    <div>
      <header className="relative bleed -mt-8 mb-10 overflow-hidden gutter-x pb-10 pt-14">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(60% 120% at 85% 0%, rgb(var(--accent) / 0.2), transparent 65%), linear-gradient(to bottom, rgb(var(--surface2) / 0.6), rgb(var(--bg)))',
          }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="mono text-[10px] uppercase tracking-[0.3em] text-accent">Year in review</div>
            <h1 className="display mt-3">
              <span className="block text-[clamp(88px,14vw,180px)] leading-[0.78] tnum" style={OUTLINE}>
                {year}
              </span>
              <span className="mt-2 block text-[clamp(26px,3.6vw,46px)] uppercase leading-none tracking-[0.2em] text-accent">
                Wrapped
              </span>
            </h1>
          </div>
          <div className="flex gap-5" role="tablist" aria-label="Year">
            {years.map((y) => (
              <button
                key={y}
                role="tab"
                aria-selected={y === year}
                onClick={() => setYear(y)}
                className={`display border-b-2 pb-1.5 text-[15px] tnum transition-colors ${
                  y === year ? 'border-accent text-ink' : 'border-transparent text-ink-dim hover:text-ink'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
      </header>

      {!data ? (
        <div className="flex items-center gap-2 text-sm text-ink-dim">
          <Spinner /> Rolling the credits
        </div>
      ) : data.totals.items === 0 ? (
        <EmptyState
          icon="✦"
          title={`Nothing watched in ${year}`}
          hint="Mark episodes and films watched through the year and this page writes itself."
          action={
            <Link to="/up-next" className={primaryBtn}>
              Go to Up Next
            </Link>
          }
        />
      ) : (
        <>
          <Credits
            items={[
              { label: 'Hours', value: data.totals.hours, sub: `${data.totals.days} days of your life` },
              { label: 'Episodes', value: data.totals.episodes, sub: `across ${data.totals.shows} shows` },
              { label: 'Films', value: data.totals.movies },
              {
                label: 'Active days',
                value: data.totals.active_days,
                sub: `${Math.round((data.totals.active_days / 365) * 100)}% of the year`,
              },
            ]}
          />

          <section className="mb-12">
            <h2 className="display mb-4 text-sm uppercase tracking-[0.14em] text-ink-dim">
              Month by month
            </h2>
            <div className="rounded-card border border-edge bg-surface/50 p-5">
              <MonthChart months={data.months} />
            </div>
          </section>

          {data.topShows.length > 0 && (
            <section className="mb-12">
              <h2 className="display mb-5 text-sm uppercase tracking-[0.14em] text-ink-dim">
                Top billing
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-5 gap-y-7">
                {data.topShows.slice(0, 10).map((s, i) => (
                  <Link key={s.id} to={`/show/${s.id}`} className="group block">
                    <div className="relative">
                      <Poster poster={s.poster} title={s.title} />
                      <span
                        className="display pointer-events-none absolute -bottom-4 -left-2 z-[4] text-[64px] leading-none tnum"
                        style={{ color: 'rgb(var(--accent))', textShadow: '0 4px 18px rgb(0 0 0 / 0.7)' }}
                      >
                        {i + 1}
                      </span>
                    </div>
                    <div className="mt-5 truncate text-[13px] font-medium text-ink group-hover:text-accent">
                      {s.title}
                    </div>
                    <div className="mono text-[10.5px] text-ink-dim">
                      {s.episodes} eps · {(s.minutes / 60).toFixed(1)}h
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-2">
            {data.busiestDay && (
              <div className="rounded-card border border-edge bg-surface/50 p-5">
                <h3 className="display text-[12px] uppercase tracking-[0.14em] text-ink-dim">
                  Biggest binge
                </h3>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="display text-[52px] leading-none tnum text-accent">
                    {(data.busiestDay.minutes / 60).toFixed(1)}
                  </span>
                  <span className="display text-[15px] uppercase text-ink-dim">hours</span>
                </div>
                <div className="mono mt-2 text-[11px] text-ink-dim">
                  {data.busiestDay.day} · {data.busiestDay.items} things in one sitting
                </div>
              </div>
            )}

            <div className="rounded-card border border-edge bg-surface/50 p-5">
              <h3 className="display text-[12px] uppercase tracking-[0.14em] text-ink-dim">
                You leaned into
              </h3>
              {data.topGenres.length ? (
                <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                  {data.topGenres.map((g, i) => (
                    <span
                      key={g.name}
                      className="display uppercase leading-none"
                      style={{
                        fontSize: `${Math.max(14, 30 - i * 3.5)}px`,
                        color: i === 0 ? 'rgb(var(--accent))' : 'rgb(var(--text) / 0.75)',
                      }}
                    >
                      {g.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-[12.5px] text-ink-dim">
                  Genres come from TMDB. Add a key in Settings and they appear here.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
