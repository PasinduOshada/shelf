import { tmdbImg } from '../api';
import { Poster } from './Bits';

/** Same hash the poster fallback uses, so a title's hero and poster share a hue. */
export function titleHue(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

/**
 * Full-bleed header for show and movie pages.
 *
 * With TMDB artwork it is a backdrop under two scrims. Without it, the band is
 * washed in the title's own hue, so an unmatched library still gets a distinct,
 * lit-from-the-projector opening rather than a flat slab.
 *
 * Everything laid over the band uses theme tokens (surface, edge, ink), never
 * fixed white/black, because the scrims fade to the page ground -- which is
 * paper-coloured in the light theme.
 */
export default function DetailHero({
  backdropPath,
  poster,
  title,
  emoji,
  eyebrow,
  meta,
  genres = [],
  overview,
  tagline,
  actions,
  posterSlot,
  titleAddon,
}) {
  // w780 behind a blur and a gradient looks the same as w1280 and costs a
  // third of the disk.
  const backdrop = tmdbImg(backdropPath, 'w780');
  const h = titleHue(title);

  return (
    <section className="relative bleed -mt-8 mb-8 overflow-hidden">
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-top opacity-60"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(80% 130% at 12% 0%, hsl(${h} 46% 26% / 0.95), transparent 62%),
              linear-gradient(115deg, hsl(${(h + 30) % 360} 32% 13%), rgb(var(--bg)) 72%)`,
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/75 to-bg/10" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/85 via-bg/30 to-transparent" />

      <div className="relative flex flex-wrap items-end gap-8 gutter-x pb-9 pt-24">
        <div className="w-[176px] shrink-0">
          <Poster
            poster={poster}
            title={title}
            emoji={emoji}
            // w342 is what enrichment pre-caches, so it shows instantly; at 176px
            // wide it is still 2x resolution.
            size="w342"
            className="shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)] ring-1 ring-white/10"
          />
          {posterSlot && <div className="mt-2.5 flex flex-col gap-1">{posterSlot}</div>}
        </div>

        <div className="min-w-0 max-w-3xl flex-1 pb-1">
          {eyebrow && (
            <div className="mono mb-2.5 text-[10px] uppercase tracking-[0.22em] text-accent">
              {eyebrow}
            </div>
          )}
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="display text-[clamp(30px,4.2vw,56px)] uppercase leading-[0.92] text-ink">
              {title}
            </h1>
            {titleAddon}
          </div>

          {meta && (
            <div className="mono mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
              {meta}
            </div>
          )}

          {genres.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {genres.map((g) => (
                <span
                  key={g}
                  className="rounded-full border border-edge bg-surface/60 px-2.5 py-0.5 text-[11px] text-ink/85"
                >
                  {g}
                </span>
              ))}
            </div>
          )}

          {tagline && <p className="mt-4 text-[14px] italic text-ink/80">“{tagline}”</p>}

          {overview && (
            <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-ink-dim">{overview}</p>
          )}

          {actions && <div className="mt-5 flex flex-wrap items-center gap-2.5">{actions}</div>}
        </div>
      </div>
    </section>
  );
}

/** Label/figure strip under a hero. Hairline-divided figures, not a row of cards. */
export function FigureStrip({ items }) {
  return (
    <dl
      className="figure-strip mb-9 grid grid-cols-2 border-y border-edge"
      style={{ '--figures': `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(({ label, value, tone }, i) => (
        <div
          key={label}
          className={`min-w-0 border-edge px-4 py-3.5 sm:px-5 ${i % 2 ? 'border-l' : ''} ${i > 1 ? 'border-t sm:border-t-0' : ''} ${i > 0 ? 'sm:border-l' : ''}`}
        >
          <dt className="mono text-[10px] uppercase tracking-[0.16em] text-ink-dim">{label}</dt>
          <dd
            className={`display mt-1 truncate text-2xl tnum ${
              tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-ink'
            }`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const primaryBtn =
  'display rounded bg-accent px-5 py-2 text-[12.5px] uppercase tracking-wide text-accent-ink transition hover:opacity-90 disabled:opacity-40';

export const ghostBtn =
  'rounded border border-edge bg-surface/70 px-4 py-2 text-[12.5px] text-ink backdrop-blur-sm transition hover:border-accent/50 disabled:opacity-40';

/** Square icon button (favourite, folder icon) that sits beside a hero title. */
export const iconBtn =
  'grid h-8 w-8 place-items-center rounded border border-edge bg-surface/70 text-base backdrop-blur-sm transition hover:border-accent/50';

export const quietBtn = 'text-left text-[11px] text-ink-dim transition hover:text-ink';
