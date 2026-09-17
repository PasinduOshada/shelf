import { useEffect, useState } from 'react';
import { SectionTitle, Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

const KOFI = 'https://ko-fi.com/picklerobot';

function Licences({ onClose }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/licenses')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Notices are missing from this build'))))
      .then(setText)
      .catch((err) => setError(err.message));
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="licences-title"
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-card border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge px-6 py-4">
          <h3 id="licences-title" className="display text-[18px] uppercase text-ink">Third-party licences</h3>
          <button onClick={onClose} className={`${ghostBtn} ml-auto`} autoFocus>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          {error ? (
            <p className="text-[13px] text-danger">{error}</p>
          ) : !text ? (
            <Spinner />
          ) : (
            <pre className="mono whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-ink-dim">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** What Shelf is, who made it, and everything it stands on. */
export default function About() {
  const [showLicences, setShowLicences] = useState(false);

  return (
    <section>
      <SectionTitle>About</SectionTitle>
      <div className="rounded-card border border-edge bg-surface/50 p-5">
        <p className="max-w-[68ch] text-[13px] leading-relaxed text-ink-dim">
          Shelf indexes your media read-only. Files only change when you confirm it: Organize moves
          and renames, the duplicate cleaner sends a copy to the Recycle Bin, and subtitles you
          download are saved next to their video. Watch history, posters and themes live in a local
          database beside the app, never inside your library folders.
        </p>

        <div className="mt-5 border-t border-edge/70 pt-4">
          <p className="max-w-[68ch] text-[13px] leading-relaxed text-ink">
            Shelf is free and open source (MIT). If it saves you an evening of renaming files,
            a coffee is a lovely way to say so.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <a href={KOFI} target="_blank" rel="noreferrer" className={primaryBtn}>
              Buy me a coffee
            </a>
            <button onClick={() => setShowLicences(true)} className={ghostBtn}>
              Third-party licences
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-1.5 border-t border-edge/70 pt-4 text-[11.5px] leading-relaxed text-ink-dim">
          <p>
            This product uses the TMDB API but is not endorsed or certified by TMDB. Subtitles come
            from OpenSubtitles.com, and syncing uses your own Trakt account.
          </p>
          <p>
            File details are read with ffprobe from the FFmpeg project (GPL-3.0), run as a separate
            program. Archivo and IBM Plex are licensed under the SIL Open Font License.
          </p>
        </div>
      </div>

      {showLicences && <Licences onClose={() => setShowLicences(false)} />}
    </section>
  );
}
