// Theme system: curated presets + a custom builder.
//
// Every colour is stored as an "R G B" triplet so Tailwind can do
// `rgb(var(--accent) / 0.15)` for translucency without a second token.

export const TOKENS = [
  { key: 'bg', label: 'Background', hint: 'The page ground' },
  { key: 'surface', label: 'Surface', hint: 'Cards and panels' },
  { key: 'surface2', label: 'Inset', hint: 'Wells, track fills' },
  { key: 'edge', label: 'Border', hint: 'Hairlines and dividers' },
  { key: 'text', label: 'Text', hint: 'Primary reading colour' },
  { key: 'dim', label: 'Muted text', hint: 'Secondary detail' },
  { key: 'accent', label: 'Accent', hint: 'Actions and highlights' },
  { key: 'accentInk', label: 'On accent', hint: 'Text sitting on the accent' },
];

/**
 * Presets are named from the subject's own world -- projection, film stock,
 * print -- rather than generic colour names.
 */
export const PRESETS = {
  projection: {
    name: 'Projection',
    note: 'Warm bulb on a dark auditorium',
    dark: true,
    tokens: {
      bg: '8 9 12',
      surface: '18 20 26',
      surface2: '26 30 38',
      edge: '31 36 48',
      text: '242 243 247',
      dim: '140 147 164',
      accent: '232 180 74',
      accentInk: '20 16 10',
    },
    radius: 6,
  },
  nitrate: {
    name: 'Nitrate',
    note: 'Scorched film stock, red shift',
    dark: true,
    tokens: {
      bg: '14 8 8',
      surface: '28 17 16',
      surface2: '38 24 22',
      edge: '54 33 30',
      text: '247 236 231',
      dim: '176 142 133',
      accent: '226 88 59',
      accentInk: '24 8 5',
    },
    radius: 4,
  },
  midnight: {
    name: 'Midnight',
    note: 'Cold steel, late screening',
    dark: true,
    tokens: {
      bg: '9 11 16',
      surface: '18 22 32',
      surface2: '26 32 45',
      edge: '35 43 60',
      text: '233 238 247',
      dim: '134 146 170',
      accent: '91 141 239',
      accentInk: '6 10 20',
    },
    radius: 8,
  },
  kodachrome: {
    name: 'Kodachrome',
    note: 'Teal shadows, orange highlights',
    dark: true,
    tokens: {
      bg: '7 16 18',
      surface: '14 28 31',
      surface2: '20 39 43',
      edge: '28 52 57',
      text: '233 246 245',
      dim: '128 163 163',
      accent: '255 138 76',
      accentInk: '24 11 4',
    },
    radius: 6,
  },
  noir: {
    name: 'Noir',
    note: 'No colour at all, just contrast',
    dark: true,
    tokens: {
      bg: '10 10 10',
      surface: '22 22 22',
      surface2: '31 31 31',
      edge: '46 46 46',
      text: '245 245 245',
      dim: '150 150 150',
      accent: '245 245 245',
      accentInk: '10 10 10',
    },
    radius: 2,
  },
  daylight: {
    name: 'Daylight',
    note: 'Warm paper, ink, brass',
    dark: false,
    tokens: {
      bg: '247 245 240',
      surface: '255 254 251',
      surface2: '238 235 228',
      edge: '222 217 206',
      text: '28 26 23',
      dim: '111 106 96',
      accent: '176 120 26',
      accentInk: '255 253 247',
    },
    radius: 6,
  },
};

export const PRESET_IDS = Object.keys(PRESETS);

const STORAGE_KEY = 'shelf.theme.v2';

export function hexToTriplet(hex) {
  const m = String(hex).replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function tripletToHex(triplet) {
  const [r, g, b] = String(triplet).split(/\s+/).map(Number);
  if ([r, g, b].some((v) => !Number.isFinite(v))) return '#000000';
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Relative luminance, used to keep the builder honest about contrast. */
function luminance(triplet) {
  const [r, g, b] = String(triplet).split(/\s+/).map(Number);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Push a theme onto the document. */
export function applyTheme(theme) {
  const root = document.documentElement;
  const tokens = theme?.tokens || PRESETS.projection.tokens;

  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${camelToKebab(key)}`, value);
  }
  root.style.setProperty('--radius', `${theme?.radius ?? 6}px`);
  // Some browser UI (form controls, scrollbars) keys off this.
  root.style.colorScheme = theme?.dark === false ? 'light' : 'dark';
  root.dataset.theme = theme?.dark === false ? 'light' : 'dark';
}

function camelToKebab(s) {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export function loadTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.tokens) return saved;
      if (saved?.presetId && PRESETS[saved.presetId]) {
        return { ...PRESETS[saved.presetId], presetId: saved.presetId };
      }
    }
  } catch {
    /* corrupt or unavailable storage falls through to the default */
  }
  return { ...PRESETS.projection, presetId: 'projection' };
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* private mode -- the theme still applies for this session */
  }
}

export function themeFromPreset(id) {
  const preset = PRESETS[id] || PRESETS.projection;
  return { ...preset, presetId: id, tokens: { ...preset.tokens } };
}

/** Serialise a theme for sharing; presets round-trip through this too. */
export function exportTheme(theme) {
  return JSON.stringify(
    {
      name: theme.name || 'Custom',
      note: theme.note || '',
      dark: theme.dark !== false,
      radius: theme.radius ?? 6,
      tokens: theme.tokens,
    },
    null,
    2
  );
}

export function importTheme(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || !parsed.tokens) {
    throw new Error('That file has no "tokens" object');
  }
  const tokens = {};
  for (const { key } of TOKENS) {
    const value = parsed.tokens[key];
    if (!value || !/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(String(value))) {
      throw new Error(`Missing or malformed colour: ${key}`);
    }
    tokens[key] = String(value);
  }
  return {
    name: String(parsed.name || 'Imported'),
    note: String(parsed.note || ''),
    dark: parsed.dark !== false,
    radius: Number(parsed.radius) || 6,
    tokens,
    presetId: null,
  };
}
