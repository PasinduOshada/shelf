import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatBytes, plural } from '../api';
import { Poster, Badge, EmptyState, SectionTitle, Spinner } from '../components/Bits';
import { FigureStrip, ghostBtn } from '../components/DetailHero';
import Duplicates from '../components/Duplicates';

const pad = (n) => String(n).padStart(2, '0');

/** [3,4,5,9] -> [[3,5],[9,9]] */
function runs(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

const episodeRange = ([a, b]) => (a === b ? `E${pad(a)}` : `E${pad(a)}–E${pad(b)}`);
const seasonRange = ([a, b]) => (a === b ? `S${pad(a)}` : `S${pad(a)}–S${pad(b)}`);

/** Lines for the clipboard: episode ranges for gaps, one line for whole seasons. */
function downloadLines(show) {
  const lines = [];
  for (const se of show.seasons.filter((s) => !s.whole)) {
    const eps = runs(se.episodes.map((e) => e.episode_number)).map(episodeRange).join(', ');
    lines.push(`${show.title} S${pad(se.season_number)}: ${eps}`);
  }
  const whole = show.seasons.filter((s) => s.whole);
  if (whole.length) {
    const span = runs(whole.map((s) => s.season_number)).map(seasonRange).join(', ');
    lines.push(`${show.title} ${span} (whole seasons)`);
  }
  return lines;
}

function MissingRow({ show }) {
  const partial = show.seasons.filter((s) => !s.whole);
  const whole = show.seasons.filter((s) => s.whole);
  const wholeEpisodes = whole.reduce((n, s) => n + s.episodes.length, 0);

  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-4 border-b border-edge/60 px-4 py-3 last:border-b-0 hover:bg-surface/60">
      <Link to={`/show/${show.show_id}`} className="block w-[44px]">
        <Poster poster={show.poster} title={show.title} size="w185" />
      </Link>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/show/${show.show_id}`}
            className="display truncate text-[14px] uppercase tracking-wide text-ink transition-colors hover:text-accent"
          >
            {show.title}
          </Link>
          {show.tmdb_status !== 'matched' && (
            <Badge title="Inferred from gaps in your file numbering, not from TMDB">estimated</Badge>
          )}
        </div>

        {partial.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            {partial.map((se) => (
              <div key={se.season_number} className="flex flex-wrap items-center gap-1">
                <span className="mono mr-0.5 text-[10px] text-ink-dim">S{pad(se.season_number)}</span>
                {runs(se.episodes.map((e) => e.episode_number)).map((r) => (
                  <span
                    key={r[0]}
                    className="mono rounded-[3px] border border-warn/30 bg-warn/10 px-1.5 py-px text-[10.5px] text-warn"
                  >
                    {episodeRange(r)}
                  </span>
                ))}
                <span className="mono ml-0.5 text-[10px] text-ink-dim">
                  {se.owned}/{se.total}
                </span>
              </div>
            ))}
          </div>
        )}

        {whole.length > 0 && (
          <div className="mono mt-2 text-[11px] text-ink-dim">
            Not started: {runs(whole.map((s) => s.season_number)).map(seasonRange).join(', ')}
            <span className="opacity-70"> · {plural(wholeEpisodes, 'episode')}</span>
          </div>
        )}
      </div>

      <div className="text-right">
        <div
          className={`display text-[26px] leading-none tnum ${show.gap_count ? 'text-warn' : 'text-ink-dim'}`}
          title={show.gap_count ? 'Missing from seasons you have' : 'Only whole seasons missing'}
        >
          {show.gap_count || show.count}
        </div>
        {show.gap_count > 0 && show.gap_count !== show.count && (
          <div className="mono mt-1 text-[10px] text-ink-dim">+{show.count - show.gap_count} unstarted</div>
        )}
      </div>
    </div>
  );
}

export default function MissingPage() {
  const [missing, setMissing] = useState(null);
  const [dupes, setDupes] = useState(null);
  const [showUnstarted, setShowUnstarted] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadDupes = () => api.duplicateGroups().then(setDupes).catch(() => setDupes([]));

  useEffect(() => {
    api.missing().then(setMissing);
    loadDupes();
  }, []);

  if (!missing) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-dim">
        <Spinner /> Checking the library
      </div>
    );
  }

  const withGaps = missing.filter((s) => s.gap_count > 0);
  const onlyWhole = missing.filter((s) => s.gap_count === 0);
  const gapTotal = missing.reduce((n, s) => n + s.gap_count, 0);
  const wholeSeasons = missing.reduce((n, s) => n + s.whole_seasons, 0);
  // Everything beyond the best copy of each duplicated episode or film.
  const reclaimable = (dupes || []).reduce((n, d) => n + d.reclaim_bytes, 0);

  function copyList() {
    const shows = showUnstarted ? missing : withGaps;
    navigator.clipboard.writeText(shows.flatMap(downloadLines).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div>
      <header className="mb-7">
        <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Library health</div>
        <h1 className="display mt-2 text-[42px] uppercase leading-none text-ink">Missing</h1>
        <p className="mt-2.5 max-w-[64ch] text-[13px] text-ink-dim">
          Aired episodes that aren’t on disk. Gaps inside seasons you’ve started come first — those
          are the likely downloads. Seasons you never started are summarised separately.
        </p>
      </header>

      <FigureStrip
        items={[
          { label: 'Gaps in your seasons', value: gapTotal, tone: gapTotal ? 'warn' : null },
          { label: 'Shows with gaps', value: withGaps.length },
          { label: 'Seasons not started', value: wholeSeasons },
          { label: 'Reclaimable', value: formatBytes(reclaimable), tone: reclaimable ? 'accent' : null },
        ]}
      />

      <section>
        <SectionTitle
          action={
            missing.length > 0 && (
              <button onClick={copyList} className={ghostBtn}>
                {copied ? 'Copied' : 'Copy download list'}
              </button>
            )
          }
        >
          Gaps in seasons you have
        </SectionTitle>

        {!withGaps.length ? (
          <EmptyState
            icon="✓"
            title="No gaps"
            hint="Every season you’ve started has all of its aired episodes."
          />
        ) : (
          <div className="overflow-hidden rounded-card border border-edge">
            {withGaps.map((show) => (
              <MissingRow key={show.show_id} show={show} />
            ))}
          </div>
        )}
      </section>

      {onlyWhole.length > 0 && (
        <section className="mt-11">
          <SectionTitle
            action={
              <button onClick={() => setShowUnstarted((v) => !v)} className={ghostBtn}>
                {showUnstarted ? 'Hide' : `Show ${onlyWhole.length}`}
              </button>
            }
          >
            Only unstarted seasons missing
          </SectionTitle>
          {showUnstarted ? (
            <div className="overflow-hidden rounded-card border border-edge">
              {onlyWhole.map((show) => (
                <MissingRow key={show.show_id} show={show} />
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-dim">
              {plural(onlyWhole.length, 'show')} where everything you have is complete, but earlier or later
              seasons were never downloaded.
            </p>
          )}
        </section>
      )}

      <section className="mt-11">
        <SectionTitle>Duplicates</SectionTitle>
        <Duplicates groups={dupes} onChanged={loadDupes} />
      </section>
    </div>
  );
}
