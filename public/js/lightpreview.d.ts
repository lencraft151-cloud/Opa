/**
 * Typen für die Lichtvorschau.
 *
 * Die Oberfläche ist bewusst reines JavaScript ohne Build-Schritt – der
 * Browser lädt genau die Dateien, die im Verzeichnis liegen. Die Tests prüfen
 * die Rechenteile aber mit, und dafür braucht TypeScript diese Beschreibung.
 * Sie wird nirgends ausgeliefert und nirgends übersetzt.
 */

export interface Light {
  /** CSS-Farbe des Scheins, `null` bei allem, was kein Licht ist. */
  color: string | null;
  /** 0 = kein Schein, 1 = volle Stärke. */
  strength: number;
}

export interface LightState {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
  colorTemperatureK?: number;
  [key: string]: unknown;
}

export function setLivePreview(value: boolean): void;
export function isLivePreviewOn(): boolean;
export function lightColor(state?: LightState): string | null;
export function kelvinToCss(kelvin: number): string;
export function applyLight(card: Element | null, light: Partial<Light>): void;
export function lightFromDevice(device?: { state?: LightState }): Light;
export function lightStyle(device?: { state?: LightState }): string;
export function previewChange(
  card: Element,
  device: { state?: LightState } | undefined,
  change: {
    brightness?: number;
    hue?: number;
    saturation?: number;
    kelvin?: number;
    on?: boolean;
  },
): void;
export function endPreview(card: Element | null, device?: { state?: LightState }): void;
