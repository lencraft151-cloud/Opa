/**
 * Darstellung anwenden: Schriftgröße, Akzentfarben, Hell/Dunkel, Bewegung.
 *
 * Die Werte gehören zum Haushalt und nicht zum Browser – wer die Schrift
 * größer stellt, will das auf dem Küchentablet genauso wie auf dem Handy.
 * Damit die Oberfläche beim Start nicht kurz in der Voreinstellung
 * aufblitzt, wird die zuletzt gültige Fassung zusätzlich lokal gemerkt und
 * sofort angewendet.
 */

import { setLivePreview } from './lightpreview.js';

const STORAGE_KEY = 'smarthome.appearance';

export const DEFAULT_APPEARANCE = {
  fontScale: 1,
  accentColor: null,
  accentColorAlt: null,
  theme: 'auto',
  reduceMotion: false,
  livePreview: true,
};

/** Auswahlmöglichkeiten für die Einstellungen – Beschriftung inklusive. */
export const FONT_SCALES = [
  { value: 0.9, label: 'Klein' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Groß' },
  { value: 1.3, label: 'Größer' },
  { value: 1.5, label: 'Sehr groß' },
];

export const THEMES = [
  { value: 'auto', label: 'Wie das System' },
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
];

/** Vorschläge, damit niemand mit einem Farbwähler allein gelassen wird. */
export const ACCENT_PRESETS = [
  { label: 'Mitgeliefert', color: null, alt: null },
  { label: 'Waldgrün', color: '#1f8a4c', alt: '#7cc242' },
  { label: 'Sonnenorange', color: '#d1610d', alt: '#e8b33a' },
  { label: 'Beere', color: '#a63478', alt: '#e0609b' },
  { label: 'Tiefsee', color: '#1c6ea4', alt: '#31b7c4' },
  { label: 'Graphit', color: '#4b5563', alt: '#94a3b8' },
];

export function readStoredAppearance() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) } : { ...DEFAULT_APPEARANCE };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/**
 * Setzt die Darstellung auf dem Dokument.
 * @param {object} appearance
 */
export function applyAppearance(appearance) {
  const settings = { ...DEFAULT_APPEARANCE, ...(appearance ?? {}) };
  const root = document.documentElement;
  active = settings;
  watchSystemTheme();

  root.style.setProperty('--font-scale', String(clamp(settings.fontScale, 0.85, 1.6)));

  if (settings.theme === 'dark' || settings.theme === 'light') {
    root.dataset.theme = settings.theme;
  } else {
    delete root.dataset.theme;
  }

  if (settings.reduceMotion) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;

  // Lichtvorschau: Die Gerätekarten zeigen beim Verstellen, wie es aussehen
  // wird. Auf schwachen Geräten kostet der weichgezeichnete Schein Zeit.
  setLivePreview(settings.livePreview !== false);

  /*
   * Eine eigene Farbe wird direkt am Dokument gesetzt und schlägt damit die
   * mitgelieferte aus dem Stylesheet – auch die für den dunklen Modus. Ohne
   * eigene Farbe wird nichts gesetzt, damit hell und dunkel weiter ihre
   * jeweils passende Abstimmung behalten.
   */
  if (settings.accentColor) {
    root.style.setProperty('--accent', settings.accentColor);
    root.style.setProperty('--accent-text', readableTextOn(settings.accentColor));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-text');
  }

  if (settings.accentColorAlt) root.style.setProperty('--accent-2', settings.accentColorAlt);
  else root.style.removeProperty('--accent-2');

  // Die Adressleiste auf dem Handy soll mitgehen.
  syncThemeColor();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Privater Modus – dann eben beim nächsten Start kurz die Voreinstellung */
  }
  return settings;
}

/** Wendet die zuletzt bekannte Darstellung an, bevor der Hub antwortet. */
export function applyStoredAppearance() {
  return applyAppearance(readStoredAppearance());
}

/**
 * Schwarz oder Weiß – je nachdem, was auf der Akzentfarbe lesbar ist.
 * Formel nach WCAG (relative Leuchtdichte).
 */
export function readableTextOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  // Kontrast gegen Weiß bzw. Schwarz vergleichen und den besseren nehmen.
  const againstWhite = 1.05 / (luminance + 0.05);
  const againstBlack = (luminance + 0.05) / 0.05;
  return againstBlack >= againstWhite ? '#0b1017' : '#ffffff';
}

export function hexToRgb(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function clamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 1;
}

/** Zuletzt angewendete Darstellung – für die Systemumschaltung unten. */
let active = { ...DEFAULT_APPEARANCE };
let watching = false;

/**
 * Bei „Wie das System“ wechselt der Hintergrund, ohne dass jemand etwas
 * einstellt. Dann muss auch die Farbe der Systemleiste nachziehen.
 */
function watchSystemTheme() {
  if (watching || typeof matchMedia !== 'function') return;
  watching = true;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (active.theme === 'auto') syncThemeColor();
  });
}

/** Färbt die Systemleiste passend zum tatsächlich sichtbaren Hintergrund. */
function syncThemeColor() {
  const target = document.body ?? document.documentElement;
  const background = getComputedStyle(target).backgroundColor;
  if (!background || background === 'rgba(0, 0, 0, 0)') return;

  // Die beiden Einträge aus dem HTML-Kopf gelten je nach Systemeinstellung.
  // Ab hier bestimmt die App die Farbe, also bleibt genau einer übrig.
  const tags = [...document.querySelectorAll('meta[name="theme-color"]')];
  tags.slice(1).forEach((tag) => tag.remove());
  const tag = tags[0];
  if (!tag) return;
  tag.removeAttribute('media');
  tag.setAttribute('content', background);
}
