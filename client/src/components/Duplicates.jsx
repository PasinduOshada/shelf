import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatBytes } from '../api';
import { Badge, EmptyState } from './Bits';
import { ghostBtn, primaryBtn } from './DetailHero';
import { MediaFacts } from './EpisodePanel';
import { revealTarget, toast } from './MediaActions';

/**
 * Several files for one episode or film. The best copy (resolution, HDR,
 * languages) is suggested; the others can go to the Recycle Bin, one at a
 * time, after a confirmation. The last copy can never be removed here.
 */
export default function Duplicates({ groups, onChanged }) {
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  async function remove(file) {
    setBusy(true);
    try {
      await api.trashFile(file.id);
      toast(`Moved ${file.filename} to the Recycle Bin`);
      setConfirm(null);
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (!groups?.length) {
    return <EmptyState icon="✓" title="No duplicates" hint="Every episode and film has exactly one file." />;
  }

  return (
    <>
      <div className="overflow-hidden rounded-card border border-edge">
        {groups.map((g) => (
          <div key={g.key} className="border-b border-edge/60 px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to={g.show_id ? `/show/${g.show_id}` : `/movie/${g.movie_id}`}
                className="display text-[14px] uppercase tracking-wide text-ink hover:text-accent"
              >
                {g.title}
              </Link>
              {g.subtitle && <span className="text-[12px] text-ink-dim">{g.subtitle}</span>}
              {g.different_lengths ? (
                <Badge tone="warn">{g.files.length} files, different lengths</Badge>
              ) : (
                <Badge tone="danger">{g.files.length} copies</Badge>
              )}
              {!g.different_lengths && (
                <span className="mono ml-auto text-[11px] text-ink-dim">frees {formatBytes(g.reclaim_bytes)}</span>
              )}
            </div>
            {g.different_lengths && (
              <p className="mt-1.5 text-[12px] text-ink-dim">
                These run for different lengths, so they are probably different episodes with a wrong number
                in the name. Open the show, expand the episode and use “Wrong episode?” on each file.
              </p>
            )}
            <ul className="mt-2 grid gap-2">
              {g.files.map((f) => {
                const keep = f.id === g.keep;
                return (
                  <li key={f.id} className={`flex flex-wrap items-start gap-3 rounded border px-3 py-2 ${keep ? 'border-good/40 bg-good/5' : 'border-edge/70'}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {keep && <Badge tone="good">best copy</Badge>}
                        <span className="mono truncate text-[11px] text-ink" title={f.path}>{f.filename}</span>
                      </div>
                      <div className="mono mt-0.5 truncate text-[10.5px] text-ink-dim">{formatBytes(f.size_bytes)} · {f.path}</div>
                      <MediaFacts media={{ quality: f.quality, hdr: f.hdr, video_codec: f.codec, duration: f.duration, audio: f.audio.map((lang) => ({ lang })), subtitles: f.subtitles.map((lang) => ({ lang })) }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => revealTarget({ fileId: f.id })} className="text-[11px] text-ink-dim hover:text-ink">
                        Show in folder
                      </button>
                      {!g.different_lengths && (
                        <button
                          onClick={() => setConfirm(f)}
                          className="text-[11px] text-ink-dim transition hover:text-danger"
                        >
                          Move to Recycle Bin
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-ink-dim">
        Removed copies go to the Recycle Bin, so they can be restored. The last copy of anything is always kept.
      </p>

      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={() => setConfirm(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="trash-title"
            className="w-full max-w-md rounded-card border border-edge bg-surface p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mono text-[10px] uppercase tracking-[0.22em] text-accent">Confirm</div>
            <h3 id="trash-title" className="display mt-2 text-[22px] uppercase leading-tight text-ink">
              Move this copy to the Recycle Bin?
            </h3>
            <p className="mono mt-3 break-all text-[11.5px] text-ink">{confirm.path}</p>
            <p className="mt-2 text-[13px] text-ink-dim">
              {formatBytes(confirm.size_bytes)}. You can restore it from the Recycle Bin.
            </p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button onClick={() => setConfirm(null)} className={ghostBtn} autoFocus>
                Cancel
              </button>
              <button onClick={() => remove(confirm)} disabled={busy} className={primaryBtn}>
                {busy ? 'Moving' : 'Move to Recycle Bin'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
