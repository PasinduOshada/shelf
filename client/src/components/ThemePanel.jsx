import { useEffect, useRef, useState } from 'react';
import {
  PRESETS,
  PRESET_IDS,
  TOKENS,
  applyTheme,
  contrastRatio,
  exportTheme,
  hexToTriplet,
  importTheme,
  loadTheme,
  saveTheme,
  themeFromPreset,
  tripletToHex,
} from '../themes';
import { Badge, SectionTitle } from './Bits';

function PresetSwatch({ id, preset, active, onPick }) {
  const t = preset.tokens;
  return (
    <button
      onClick={() => onPick(id)}
      className={`group overflow-hidden rounded border text-left transition ${
        active ? 'border-accent' : 'border-edge hover:border-accent/40'
      }`}
    >
      {/* A miniature of the theme rather than a row of dots. */}
      <div className="flex h-14" style={{ background: `rgb(${t.bg})` }}>
        <div className="m-2 flex flex-1 flex-col justify-between rounded-sm p-1.5" style={{ background: `rgb(${t.surface})` }}>
          <div className="h-1 w-8 rounded-full" style={{ background: `rgb(${t.text})`, opacity: 0.85 }} />
          <div className="flex items-center gap-1">
            <div className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${t.accent})` }} />
            <div className="h-1 w-6 rounded-full" style={{ background: `rgb(${t.dim})` }} />
          </div>
        </div>
      </div>
      <div className="border-t border-edge px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-medium text-ink">{preset.name}</span>
          {active && <span className="text-[10px] text-accent">●</span>}
        </div>
        <div className="truncate text-[10px] text-ink-dim">{preset.note}</div>
      </div>
    </button>
  );
}

export default function ThemePanel() {
  const [theme, setTheme] = useState(() => loadTheme());
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(null);
  const fileRef = useRef(null);

  // Push any change straight to the document so the edit is the preview.
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
    window.dispatchEvent(new CustomEvent('shelf:theme', { detail: theme }));
  }, [theme]);

  function pickPreset(id) {
    setTheme(themeFromPreset(id));
    setMessage(null);
  }

  function setToken(key, hex) {
    const triplet = hexToTriplet(hex);
    if (!triplet) return;
    setTheme((prev) => ({
      ...prev,
      name: prev.presetId ? `${prev.name} (edited)` : prev.name,
      presetId: null,
      tokens: { ...prev.tokens, [key]: triplet },
    }));
  }

  function copyExport() {
    navigator.clipboard.writeText(exportTheme(theme));
    setMessage('Theme JSON copied to clipboard.');
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setTheme(importTheme(await file.text()));
      setMessage('Theme imported.');
    } catch (err) {
      setMessage(err.message);
    }
    e.target.value = '';
  }

  // Contrast checks that matter for readability, surfaced rather than hidden.
  const checks = [
    { label: 'Text on background', ratio: contrastRatio(theme.tokens.text, theme.tokens.bg), min: 4.5 },
    { label: 'Muted on surface', ratio: contrastRatio(theme.tokens.dim, theme.tokens.surface), min: 3 },
    { label: 'Accent on background', ratio: contrastRatio(theme.tokens.accent, theme.tokens.bg), min: 3 },
    { label: 'Ink on accent', ratio: contrastRatio(theme.tokens.accentInk, theme.tokens.accent), min: 4.5 },
  ];
  const failing = checks.filter((c) => c.ratio < c.min);

  return (
    <section>
      <SectionTitle
        action={
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-edge px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim transition hover:border-accent/40 hover:text-ink"
          >
            {open ? 'Close editor' : 'Customise'}
          </button>
        }
      >
        Theme
      </SectionTitle>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {PRESET_IDS.map((id) => (
          <PresetSwatch
            key={id}
            id={id}
            preset={PRESETS[id]}
            active={theme.presetId === id}
            onPick={pickPreset}
          />
        ))}
      </div>

      {!theme.presetId && (
        <div className="mt-2.5 flex items-center gap-2 text-[11px] text-ink-dim">
          <Badge tone="accent">custom</Badge>
          <span>{theme.name}</span>
        </div>
      )}

      {open && (
        <div className="mt-4 rounded border border-edge bg-surface p-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                Colours
              </h4>
              <div className="grid gap-2">
                {TOKENS.map(({ key, label, hint }) => (
                  <label key={key} className="flex items-center gap-3">
                    <input
                      type="color"
                      value={tripletToHex(theme.tokens[key])}
                      onChange={(e) => setToken(key, e.target.value)}
                      aria-label={label}
                      className="h-7 w-9 cursor-pointer rounded border border-edge bg-transparent p-0.5"
                    />
                    <span className="flex-1 text-[12.5px] text-ink">{label}</span>
                    <span className="mono text-[10px] text-ink-dim">{hint}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div>
                <h4 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                  Shape
                </h4>
                <label className="flex items-center gap-3">
                  <span className="w-16 text-[12.5px] text-ink">Radius</span>
                  <input
                    type="range"
                    min="0"
                    max="18"
                    value={theme.radius ?? 6}
                    onChange={(e) =>
                      setTheme((p) => ({ ...p, radius: Number(e.target.value), presetId: null }))
                    }
                    className="flex-1 accent-current"
                    style={{ accentColor: `rgb(${theme.tokens.accent})` }}
                  />
                  <span className="mono w-9 text-right text-[11px] text-ink-dim">
                    {theme.radius ?? 6}px
                  </span>
                </label>
                <label className="mt-2 flex items-center gap-3">
                  <span className="w-16 text-[12.5px] text-ink">Base</span>
                  <button
                    onClick={() => setTheme((p) => ({ ...p, dark: !(p.dark !== false) }))}
                    className="rounded border border-edge px-3 py-1 text-[11px] text-ink-dim transition hover:border-accent/40 hover:text-ink"
                  >
                    {theme.dark !== false ? 'Dark' : 'Light'}
                  </button>
                  <span className="text-[10px] text-ink-dim">
                    sets colour-scheme for native controls
                  </span>
                </label>
              </div>

              <div>
                <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim">
                  Contrast
                </h4>
                <div className="grid gap-1">
                  {checks.map((c) => (
                    <div key={c.label} className="flex items-center gap-2 text-[11.5px]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          c.ratio >= c.min ? 'bg-good' : 'bg-warn'
                        }`}
                      />
                      <span className="flex-1 text-ink-dim">{c.label}</span>
                      <span className="mono text-ink-dim">{c.ratio.toFixed(1)}:1</span>
                    </div>
                  ))}
                </div>
                {failing.length > 0 && (
                  <p className="mt-2 text-[11px] text-warn">
                    {failing.length} pair{failing.length === 1 ? '' : 's'} below the readable
                    threshold — usable, but text will be hard to read.
                  </p>
                )}
              </div>

              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  onClick={copyExport}
                  className="rounded border border-edge px-3 py-1.5 text-[11px] text-ink-dim transition hover:border-accent/40 hover:text-ink"
                >
                  Copy theme JSON
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="rounded border border-edge px-3 py-1.5 text-[11px] text-ink-dim transition hover:border-accent/40 hover:text-ink"
                >
                  Import…
                </button>
                <button
                  onClick={() => pickPreset('projection')}
                  className="rounded px-3 py-1.5 text-[11px] text-ink-dim transition hover:text-ink"
                >
                  Reset
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={onImportFile}
                />
              </div>
            </div>
          </div>

          {message && <div className="mt-3 text-[11.5px] text-accent">{message}</div>}
        </div>
      )}
    </section>
  );
}
