// settings.js — User preferences, reader display settings, persistence
import { getSetting, setSetting, getAllSettings } from './db.js';

export const DEFAULTS = {
  // Reader display
  readerTheme:    'dark',
  fontFamily:     'Literata, Georgia, serif',
  fontSize:       18,
  lineHeight:     1.6,
  margin:         8,
  flow:           'paginated',
  justify:        true,
  hyphenate:      false,
  spread:         'none',

  // App
  appTheme:       'dark',       // 'dark' | 'light' | 'system'
  librarySort:    'addedAt',
  libraryView:    'grid',       // 'grid' | 'list'

  // TTS
  ttsRate:        1.0,
  ttsVoice:       '',

  // Misc
  keepScreenOn:   false,
  autoFullscreen: false,
  showReadingTimer: true,
  onboarded:      false,
};

export const READING_THEMES = [
  { id: 'dark',   label: 'Dark',   bg: '#0E0E16', fg: '#E8E6F0', accent: '#6C5CE7' },
  { id: 'light',  label: 'Light',  bg: '#FAFAF8', fg: '#1A1A2E', accent: '#5A4FCF' },
  { id: 'sepia',  label: 'Sepia',  bg: '#F4EDD8', fg: '#3D2B1F', accent: '#8B6914' },
  { id: 'amoled', label: 'Amoled', bg: '#000000', fg: '#FFFFFF', accent: '#7C6AF4' },
  { id: 'forest', label: 'Forest', bg: '#1A2A1A', fg: '#E8F5E9', accent: '#4CAF50' },
  { id: 'ocean',  label: 'Ocean',  bg: '#0A1628', fg: '#E3F0FF', accent: '#4FC3F7' },
];

export const FONT_OPTIONS = [
  { id: 'Literata, Georgia, serif',        label: 'Literata',  style: 'font-family: Literata, Georgia, serif' },
  { id: 'Georgia, serif',                  label: 'Georgia',   style: 'font-family: Georgia, serif' },
  { id: '"Times New Roman", Times, serif', label: 'Times',     style: 'font-family: "Times New Roman", Times, serif' },
  { id: 'Palatino, "Palatino Linotype", serif', label: 'Palatino', style: 'font-family: Palatino, "Palatino Linotype", serif' },
  { id: 'Inter, system-ui, sans-serif',    label: 'Inter',     style: 'font-family: Inter, system-ui, sans-serif' },
  { id: '"Open Sans", sans-serif',         label: 'Open Sans', style: 'font-family: "Open Sans", sans-serif' },
  { id: 'Verdana, Geneva, sans-serif',     label: 'Verdana',   style: 'font-family: Verdana, Geneva, sans-serif' },
  { id: '"Courier New", Courier, monospace', label: 'Mono',    style: 'font-family: "Courier New", Courier, monospace' },
];

class SettingsStore {
  constructor() {
    this._cache = { ...DEFAULTS };
    this._ready = false;
    this._listeners = new Map();
  }

  async init() {
    const stored = await getAllSettings();
    this._cache = { ...DEFAULTS, ...stored };
    this._ready = true;
    return this._cache;
  }

  get(key) {
    return this._cache[key] ?? DEFAULTS[key];
  }

  async set(key, value) {
    this._cache[key] = value;
    await setSetting(key, value);
    this._emit(key, value);
  }

  async setMany(updates) {
    for (const [k, v] of Object.entries(updates)) {
      this._cache[k] = v;
      await setSetting(k, v);
    }
    for (const [k, v] of Object.entries(updates)) this._emit(k, v);
  }

  getAll() { return { ...this._cache }; }

  on(key, fn) {
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(fn);
    return () => this.off(key, fn);
  }

  off(key, fn) {
    const list = this._listeners.get(key) ?? [];
    this._listeners.set(key, list.filter((f) => f !== fn));
  }

  _emit(key, value) {
    (this._listeners.get(key) ?? []).forEach((fn) => fn(value));
    (this._listeners.get('*') ?? []).forEach((fn) => fn(key, value));
  }
}

export const settings = new SettingsStore();

// ─── CSS Builders ─────────────────────────────────────────────────────────────
export function buildReaderCSS(s) {
  const theme = READING_THEMES.find((t) => t.id === s.readerTheme) ?? READING_THEMES[0];
  return `
    html, body {
      background: ${theme.bg} !important;
      color: ${theme.fg} !important;
    }
    body {
      font-family: ${s.fontFamily};
      font-size: ${s.fontSize}px !important;
      line-height: ${s.lineHeight} !important;
      text-align: ${s.justify ? 'justify' : 'left'};
      hyphens: ${s.hyphenate ? 'auto' : 'manual'};
      padding: 0 ${s.margin}% !important;
      -webkit-font-smoothing: antialiased;
    }
    a { color: ${theme.accent}; }
    img, svg { max-width: 100%; height: auto; }
    pre, code { font-size: 0.9em; overflow-x: auto; }
    h1,h2,h3,h4 { color: ${theme.fg}; line-height: 1.2; }
    p { margin: 0 0 0.8em; }
    blockquote {
      border-left: 3px solid ${theme.accent};
      padding-left: 1em;
      opacity: .8;
    }
    /* Folio highlight colours */
    .folio-highlight[data-color="yellow"] { background: rgba(255,224,102,.45) !important; }
    .folio-highlight[data-color="green"]  { background: rgba(111,207,151,.45) !important; }
    .folio-highlight[data-color="blue"]   { background: rgba(86,204,242,.45) !important; }
    .folio-highlight[data-color="pink"]   { background: rgba(242,153,74,.45) !important; }
    .folio-highlight[data-color="purple"] { background: rgba(187,107,217,.45) !important; }
    /* TTS word highlight */
    .tts-word { background: ${theme.accent}55; border-radius: 3px; }
  `;
}

export function buildThemeVars(themeName) {
  const theme = READING_THEMES.find((t) => t.id === themeName) ?? READING_THEMES[0];
  return { bg: theme.bg, fg: theme.fg, accent: theme.accent };
}

// ─── App Theme Application ────────────────────────────────────────────────────
export function applyAppTheme(theme) {
  const effective = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.setAttribute('data-theme', effective);
}
