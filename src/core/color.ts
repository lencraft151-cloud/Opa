/**
 * Farbraum-Umrechnungen.
 *
 * Der Hub arbeitet intern mit HSV (Farbton 0..360, Sättigung 0..100), weil das
 * für UI und Automationen am handlichsten ist. Hue erwartet CIE-xy, Shelly RGBW
 * erwartet RGB – die Umrechnung passiert hier an einer Stelle.
 */

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

export interface Xy {
  x: number;
  y: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function hsvToRgb(hue: number, saturation: number, value = 100): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 100) / 100;
  const v = clamp(value, 0, 100) / 100;

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  };
}

export function rgbToHsv(rgb: Rgb): { hue: number; saturation: number; value: number } {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  const saturation = max === 0 ? 0 : delta / max;
  return { hue: round(hue, 1), saturation: round(saturation * 100, 1), value: round(max * 100, 1) };
}

/**
 * RGB → CIE 1931 xy im Wide-Gamut-RGB-D65-Raum, wie von Philips für Hue
 * dokumentiert (inkl. Gamma-Korrektur).
 */
export function rgbToXy(rgb: Rgb): Xy {
  const gamma = (channel: number): number => {
    const c = clamp(channel, 0, 255) / 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };

  const r = gamma(rgb.r);
  const g = gamma(rgb.g);
  const b = gamma(rgb.b);

  const X = r * 0.649926 + g * 0.103455 + b * 0.197109;
  const Y = r * 0.234327 + g * 0.743075 + b * 0.022598;
  const Z = r * 0.0 + g * 0.053077 + b * 1.035763;

  const sum = X + Y + Z;
  if (sum === 0) return { x: 0.3127, y: 0.329 }; // D65-Weißpunkt
  return { x: round(X / sum, 4), y: round(Y / sum, 4) };
}

/** CIE xy (+ Helligkeit) → RGB. */
export function xyToRgb(xy: Xy, brightness = 1): Rgb {
  const y = xy.y === 0 ? 0.0001 : xy.y;
  const Y = clamp(brightness, 0, 1);
  const X = (Y / y) * xy.x;
  const Z = (Y / y) * (1 - xy.x - y);

  let r = X * 1.4628067 - Y * 0.1840623 - Z * 0.2743606;
  let g = -X * 0.5217933 + Y * 1.4472381 + Z * 0.0677227;
  let b = X * 0.0349342 - Y * 0.0968930 + Z * 1.2884099;

  const compand = (channel: number): number => {
    const c = Math.max(0, channel);
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(clamp(v, 0, 1) * 255);
  };

  // Übersteuerung auf den größten Kanal normieren, sonst kippt der Farbton.
  const max = Math.max(r, g, b);
  if (max > 1) {
    r /= max;
    g /= max;
    b /= max;
  }

  return { r: compand(r), g: compand(g), b: compand(b) };
}

export function hsvToXy(hue: number, saturation: number): Xy {
  return rgbToXy(hsvToRgb(hue, saturation, 100));
}

export function xyToHsv(xy: Xy): { hue: number; saturation: number } {
  const { hue, saturation } = rgbToHsv(xyToRgb(xy, 1));
  return { hue, saturation };
}

/** Mired (Hue "mirek") ↔ Kelvin. */
export function miredToKelvin(mired: number): number {
  if (mired <= 0) return 6500;
  return Math.round(1_000_000 / mired);
}

export function kelvinToMired(kelvin: number): number {
  if (kelvin <= 0) return 366;
  return Math.round(1_000_000 / kelvin);
}

/** Hue-Bridges akzeptieren typischerweise 153..500 mirek (6535 K .. 2000 K). */
export function clampMirek(mirek: number, min = 153, max = 500): number {
  return Math.round(clamp(mirek, min, max));
}
