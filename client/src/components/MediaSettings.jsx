import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, SectionTitle, Spinner } from './Bits';
import { primaryBtn, ghostBtn } from './DetailHero';

const input =
  'mono min-w-0 flex-1 rounded border border-edge bg-bg px-3 py-2 text-[12px] outline-none transition focus:border-accent/50';

/** Which program opens videos. */
export function PlayerSettings() {
  const [player, setPlayer] = useState(null);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.player().then(setPlayer).catch((err) => setError(err.message));
  }, []);

  async function choose(path) {
    setError(null);
    try {
      setPlayer(await api.setPlayer(path));
      setCustom('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function browse() {
    if (window.shelf?.pickPlayer) {
      const path = await window.shelf.pickPlayer();
      if (path) choose(path);
    }
  }

  const options = player
    ? [
        { path: null, name: 'System default', hint: 'Whatever Windows opens videos with' },
        ...player.detected.map((p) => ({ ...p, hint: p.path })),
        ...(player.path && !player.detected.some((p) => p.path === player.path)
          ? [{ path: player.path, name: player.name, hint: player.path }]
          : []),
      ]
    : [];

  return (
    <section>
      <SectionTitle>Playback</SectionTitle>
      <div className="rounded-card border border-edge bg-surface/50 p-5">
        <p className="max-w-[68ch] text-[13px] leading-relaxed text-ink-dim">
          The Play buttons open the file in this program. Shelf found the players below on this
          computer.
        </p>
        {!player ? (
          <Spinner className="mt-4" />
        ) : (
          <div role="radiogroup" aria-label="Video player" className="mt-4 grid gap-1.5 sm:grid-cols-2">
            {options.map((o) => {
              const on = (player.path || null) === o.path;
              return (
                <button
                  key={o.path || 'default'}
                  role="radio"
                  aria-checked={on}
                  onClick={() => choose(o.path)}
                  className={`flex items-center gap-3 rounded border px-3 py-2.5 text-left transition ${
                    on ? 'border-accent/60 bg-accent/10' : 'border-edge hover:border-accent/40'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${on ? 'border-accent' : 'border-edge'}`}
                  >
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] text-ink">{o.name}</span>
                    <span className="mono block truncate text-[10.5px] text-ink-dim">{o.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {player && (
          <div className="mt-5 border-t border-edge/70 pt-4">
            <label className="flex items-center gap-2.5 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={player.auto_watch}
                onChange={async (e) => setPlayer({ ...player, ...(await api.setPlaybackSettings({ autoWatch: e.target.checked })) })}
                className="h-3.5 w-3.5 accent-accent"
              />
              Mark as watched after
              <select
                value={player.watched_at}
                onChange={async (e) => setPlayer({ ...player, ...(await api.setPlaybackSettings({ watchedAt: Number(e.target.value) })) })}
                aria-label="Mark watched after this much of the file"
                className="rounded border border-edge bg-bg px-2 py-1 text-[12.5px] text-ink outline-none"
              >
                {[80, 85, 90, 95].map((v) => <option key={v} value={v}>{v}%</option>)}
              </select>
              has played
            </label>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">
              {player.trackable
                ? 'Shelf follows playback in this player: it remembers where you stopped, resumes from there, and marks episodes watched.'
                : 'Shelf can follow playback in VLC, mpv and MPC-HC (with its web interface on). With other players, mark episodes watched yourself.'}
            </p>
          </div>
        )}

        {player && !player.available && (
          <p className="mt-3 text-[12.5px] text-warn">
            The chosen player is no longer installed; videos open with the system default.
          </p>
        )}

        <div className="mt-4 flex gap-2.5">
          {window.shelf?.pickPlayer ? (
            <button onClick={browse} className={ghostBtn}>
              Choose another program…
            </button>
          ) : (
            <>
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Full path to another player, e.g. C:\Program Files\mpv\mpv.exe"
                aria-label="Path to a video player"
                spellCheck="false"
                className={input}
              />
              <button onClick={() => choose(custom.trim())} disabled={!custom.trim()} className={ghostBtn}>
                Use this player
              </button>
            </>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
      </div>
    </section>
  );
}

/** OpenSubtitles key, sign-in and preferred languages. */
export function SubtitleSettings() {
  const [s, setS] = useState(null);
  const [auto, setAuto] = useState(null);
  const [key, setKey] = useState('');
  const [languages, setLanguages] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);

  const apply = (next) => {
    setS(next);
    setLanguages(next.languages);
  };

  useEffect(() => {
    api.subtitleSettings().then(apply).catch((err) => setError(err.message));
    api.autoSubtitles().then(setAuto).catch(() => {});
  }, []);

  async function run(name, fn, done) {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const next = await fn();
      apply(next);
      if (done) setNote(typeof done === 'function' ? done(next) : done);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (!s) {
    return (
      <section>
        <SectionTitle>Subtitles</SectionTitle>
        <Spinner />
      </section>
    );
  }

  return (
    <section>
      <SectionTitle>Subtitles</SectionTitle>
      <div className="rounded-card border border-edge bg-surface/50 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="display text-[14px] uppercase tracking-wide text-ink">OpenSubtitles</span>
          {s.configured ? <Badge tone="good">connected</Badge> : <Badge tone="warn">not connected</Badge>}
          {s.signed_in && <Badge>signed in as {s.username}</Badge>}
        </div>
        <p className="mt-3 max-w-[68ch] text-[13px] leading-relaxed text-ink-dim">
          Subtitle files next to your videos are always detected. To search and download new ones,
          create a free account on{' '}
          <a
            href="https://www.opensubtitles.com/en/consumers"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline-offset-2 hover:underline"
          >
            opensubtitles.com
          </a>
          , add an API consumer, and paste its key here. Without signing in you get 5 downloads a
          day; signing in raises that. Downloads are saved next to the video.
        </p>

        <div className="mt-4 flex gap-2.5">
          <input
            type="password"
            autoComplete="off"
            spellCheck="false"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={s.configured ? 'Replace the saved API key' : 'Paste your OpenSubtitles API key'}
            aria-label="OpenSubtitles API key"
            className={input}
          />
          <button
            onClick={() => run('key', () => api.setSubtitleKey(key.trim()), 'Key saved.').then(() => setKey(''))}
            disabled={!key.trim() || busy === 'key'}
            className={primaryBtn}
          >
            {busy === 'key' ? 'Checking' : 'Save key'}
          </button>
        </div>

        {s.configured && (
          <div className="mt-5 grid gap-5 border-t border-edge/70 pt-5 lg:grid-cols-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run('langs', () => api.updateSubtitleSettings({ languages }), 'Languages saved.');
              }}
            >
              <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Languages</div>
              <div className="flex gap-2.5">
                <input
                  value={languages}
                  onChange={(e) => setLanguages(e.target.value)}
                  aria-label="Subtitle languages"
                  placeholder="en, si, ta"
                  className={input}
                />
                <button type="submit" disabled={busy === 'langs'} className={ghostBtn}>
                  Save
                </button>
              </div>
              <p className="mt-1.5 text-[11.5px] text-ink-dim">Two-letter codes: en English, si Sinhala, ta Tamil, hi Hindi, ko Korean.</p>
              {auto && (
                <label className="mt-3 flex items-start gap-2.5 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={auto.enabled}
                    onChange={async (e) => setAuto(await api.setAutoSubtitles(e.target.checked))}
                    className="mt-[3px] h-3.5 w-3.5 accent-accent"
                  />
                  <span>
                    Get subtitles automatically for newly organized files
                    <span className="block text-[11.5px] text-ink-dim">
                      Only confident matches, only languages the file doesn’t already have, at most 10 per run.
                      {auto.last ? ` Last run: ${auto.last.downloaded} downloaded.` : ''}
                    </span>
                  </span>
                </label>
              )}
              <label className="mt-3 flex items-center gap-2.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={s.hide_machine}
                  onChange={(e) => run('machine', () => api.updateSubtitleSettings({ hideMachine: e.target.checked }))}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Hide machine-translated subtitles
              </label>
            </form>

            <div>
              <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-dim">Account (optional)</div>
              {s.signed_in ? (
                <button onClick={() => run('logout', () => api.subtitleLogout(), 'Signed out.')} className={ghostBtn}>
                  Sign out {s.username}
                </button>
              ) : (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(
                      'login',
                      () => api.subtitleLogin(user.trim(), pass),
                      (r) => `Signed in${r.allowed_downloads ? `: ${r.allowed_downloads} downloads a day` : ''}.`
                    ).then(() => setPass(''));
                  }}
                >
                  <div className="flex gap-2">
                    <input
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                      autoComplete="username"
                      placeholder="Username"
                      aria-label="OpenSubtitles username"
                      className={input}
                    />
                    <input
                      type="password"
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                      autoComplete="current-password"
                      placeholder="Password"
                      aria-label="OpenSubtitles password"
                      className={input}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="submit" disabled={!user.trim() || !pass || busy === 'login'} className={ghostBtn}>
                      {busy === 'login' ? 'Signing in' : 'Sign in'}
                    </button>
                    <span className="text-[11.5px] text-ink-dim">Your password is not stored, only the sign-in session.</span>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

        {(note || error) && (
          <p role={error ? 'alert' : 'status'} className={`mt-4 text-[12.5px] ${error ? 'text-danger' : 'text-good'}`}>
            {error || note}
          </p>
        )}
      </div>
    </section>
  );
}
