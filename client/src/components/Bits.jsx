import { useEffect, useState } from 'react';
import { posterUrl } from '../api';

/**
 * `onArt` is for bars laid over poster artwork, which is always dark whatever
 * the theme; everywhere else the track follows the theme's text colour so it
 * stays visible on a light ground.
 */
export function ProgressBar({ value, className = '', onArt = false }) {
  return (
    <div
      className={`h-[3px] w-full overflow-hidden rounded-full ${
        onArt ? 'bg-white/25' : 'bg-ink/15'
      } ${className}`}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Badge({ children, tone = 'default', className = '', title }) {
  const tones = {
    default: 'bg-surface-2 text-ink-dim',
    accent: 'bg-accent/15 text-accent',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    good: 'bg-good/15 text-good',
    // Over poster artwork, which stays dark in every theme.
    glass: 'bg-black/65 text-white/90 backdrop-blur-sm',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ className = '' }) {
  return (
    <div
      className={`h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-accent ${className}`}
    />
  );
}

export function EmptyState({ icon = '🎞', title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-edge px-6 py-16 text-center">
      <div className="text-3xl opacity-50">{icon}</div>
      <div className="display text-lg text-ink">{title}</div>
      {hint && <p className="max-w-sm text-sm text-ink-dim">{hint}</p>}
      {action}
    </div>
  );
}

export function SectionTitle({ children, action, className = '' }) {
  return (
    <div className={`mb-3 flex items-end justify-between gap-4 ${className}`}>
      <h2 className="display text-sm uppercase tracking-[0.14em] text-ink-dim">{children}</h2>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------
   Poster

   Real artwork when TMDB has matched the title. Otherwise a generated
   placeholder that is meant to look deliberate: a deterministic hue
   from the title, a ghosted monogram, grain and a vignette (the last
   two live in index.css as .poster-fallback).
   ------------------------------------------------------------------ */
function hueFor(seed = '') {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * Initial of the title's last meaningful word ("American Nightmare" -> N).
 * First letters repeat through an alphabetical grid -- a wall of identical
 * "A"s -- while last words vary far more. Sequel numbers, roman numerals and
 * filler words are skipped, so "The Godfather Part II" still gives G.
 */
function monogram(title = '') {
  const words = String(title)
    .split(/\s+/)
    .filter((w) => /[a-z]/i.test(w) && !/^(the|a|an|of|and|part|[ivx]+|\d+)$/i.test(w));
  const pick = words[words.length - 1] || String(title).trim();
  const ch = pick.match(/[a-z0-9]/i);
  return ch ? ch[0].toUpperCase() : '?';
}

export function Poster({
  poster,
  title,
  emoji,
  size = 'w342',
  className = '',
  rounded = 'rounded-card',
  children,
}) {
  const source = posterUrl(poster, size);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  // Offline with an uncached poster, or a dead link: use the generated art.
  const url = failed ? null : source;
  const h = hueFor(title);

  return (
    <div
      className={`relative aspect-[2/3] w-full overflow-hidden bg-surface-2 ${rounded} ${
        url ? '' : 'poster-fallback'
      } ${className}`}
      style={
        url
          ? undefined
          : {
              background: `linear-gradient(157deg, hsl(${h} 40% 27%), hsl(${(h + 34) % 360} 36% 10%))`,
            }
      }
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-[600ms] ease-out group-hover:scale-[1.05]"
        />
      ) : (
        <>
          <span aria-hidden="true" className="poster-monogram">
            {monogram(title)}
          </span>
          <div className="poster-title absolute inset-0 z-[2] flex flex-col justify-end p-2.5">
            {emoji && <span className="mb-1 text-lg leading-none">{emoji}</span>}
            <span className="display line-clamp-3 text-[13px] leading-tight text-white/90">
              {title}
            </span>
          </div>
        </>
      )}
      {children}
    </div>
  );
}

/** Backdrop band used at the top of detail pages. */
export function Backdrop({ src, children, height = 'h-[300px]' }) {
  return (
    <div className={`relative bleed -mt-8 ${height} overflow-hidden`}>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full bg-surface-2" />
      )}
      {/* Two scrims: one to the page ground, one from the left so text reads. */}
      <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/25" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg/85 via-transparent to-transparent" />
      {children}
    </div>
  );
}

/**
 * Five stars for a 1–10 rating (each star is two points). Clicking the
 * current rating again clears it.
 */
export function RatingStars({ value, onChange, size = 'text-[18px]', label = 'Your rating' }) {
  const stars = Math.round((value || 0) / 2);
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={stars === n}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          onClick={() => onChange(stars === n ? null : n * 2)}
          className={`${size} leading-none transition ${n <= stars ? 'text-accent' : 'text-ink-dim/40 hover:text-accent/70'}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
