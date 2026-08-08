/**
 * Lichtvorschau.
 *
 * Beim Verstellen einer Lampe zeigt ihre Karte, wie das Licht aussehen wird:
 * ein farbiger Schein hinter der Karte, dessen Farbe der eingestellten Farbe
 * folgt und dessen Stärke der Helligkeit.
 *
 * Der Grund ist nicht Verzierung, sondern Zeit: Kommandos gehen erst beim
 * Loslassen an das Gerät. Zwischen „Regler bewegen" und „Lampe reagiert"
 * lägen sonst ein bis zwei Sekunden, in denen man nur eine Zahl sieht. Die
 * Vorschau schließt genau diese Lücke.
 *
 * Abschaltbar in den Einstellungen – auf einem alten Tablet kostet ein
 * weichgezeichneter Schein spürbar Rechenzeit.
 */

let enabled = true;

/** Wird aus den Darstellungseinstellungen gesetzt. */
export function setLivePreview(value) {
  enabled = value !== false;
  document.documentElement.dataset.preview = enabled ? 'on' : 'off';
}

export function isLivePreviewOn() {
  return enabled;
}

/**
 * Farbe eines Lichts als CSS-Wert.
 *
 * @param {object} state Gerätezustand
 * @returns {string|null} `null`, wenn das Gerät kein Licht ist
 */
export function lightColor(state = {}) {
  if (typeof state.hue === 'number' && typeof state.saturation === 'number') {
    // Etwas heller als die reine Farbe – ein Schein ist kein Anstrich.
    return `hsl(${state.hue} ${Math.max(35, state.saturation)}% 60%)`;
  }
  if (typeof state.colorTemperatureK === 'number') return kelvinToCss(state.colorTemperatureK);
  return null;
}

/**
 * Näherung für Weißtöne.
 *
 * Die exakte Umrechnung von Farbtemperatur in Bildschirmfarben ist eine
 * Tabelle; für einen Lichtschein genügt eine Kurve, die bei 2000 K bernstein
 * und bei 6500 K bläulich-weiß liegt.
 */
export function kelvinToCss(kelvin) {
  const value = Math.min(6500, Math.max(1800, Number(kelvin) || 2700));
  // 1800 K → 25°, 6500 K → 210° wäre zu bunt; stattdessen bleibt der Farbton
  // im warmen Bereich und die Sättigung nimmt zum Kalten hin ab.
  const warmth = (value - 1800) / (6500 - 1800); // 0 = warm, 1 = kalt
  const hue = warmth < 0.55 ? 32 + warmth * 20 : 210 - (1 - warmth) * 60;
  const saturation = Math.round(70 - Math.abs(warmth - 0.1) * 55);
  const lightness = 55 + warmth * 12;
  return `hsl(${Math.round(hue)} ${Math.max(8, saturation)}% ${Math.round(lightness)}%)`;
}

/**
 * Setzt Farbe und Stärke des Scheins auf einer Karte.
 *
 * @param {HTMLElement} card
 * @param {{ color?: string|null, strength?: number }} light
 */
export function applyLight(card, light) {
  if (!card) return;
  const color = light.color ?? null;
  const strength = Math.max(0, Math.min(1, light.strength ?? 0));

  if (!enabled || !color || strength <= 0) {
    card.style.removeProperty('--light-color');
    card.style.setProperty('--light-strength', '0');
    return;
  }
  card.style.setProperty('--light-color', color);
  card.style.setProperty('--light-strength', String(strength));
}

/**
 * Der Schein, der zum tatsächlichen Zustand eines Geräts gehört.
 * Aus ist aus – eine ausgeschaltete Lampe leuchtet nicht.
 */
export function lightFromDevice(device) {
  const state = device?.state ?? {};
  if (state.on !== true) return { color: null, strength: 0 };

  const color = lightColor(state);
  if (!color) return { color: null, strength: 0 };

  const brightness = typeof state.brightness === 'number' ? state.brightness : 100;
  // Auch eine schwach gedimmte Lampe soll sichtbar sein, deshalb nicht linear.
  return { color, strength: 0.25 + (brightness / 100) * 0.75 };
}

/** Inline-Stil für die erste Darstellung – vermeidet ein Nachflackern. */
export function lightStyle(device) {
  const light = lightFromDevice(device);
  if (!light.color) return '';
  return `--light-color:${light.color};--light-strength:${light.strength.toFixed(2)}`;
}

/**
 * Vorschau während einer Bedienung.
 *
 * @param {HTMLElement} card
 * @param {object} device Aktueller Zustand als Ausgangspunkt
 * @param {{ brightness?: number, hue?: number, saturation?: number, kelvin?: number, on?: boolean }} change
 */
export function previewChange(card, device, change) {
  if (!enabled) return;
  const state = { ...(device?.state ?? {}) };

  if (change.brightness !== undefined) {
    state.brightness = change.brightness;
    state.on = change.brightness > 0;
  }
  if (change.hue !== undefined) {
    state.hue = change.hue;
    delete state.colorTemperatureK;
    state.on = true;
  }
  if (change.saturation !== undefined) state.saturation = change.saturation;
  if (change.kelvin !== undefined) {
    state.colorTemperatureK = change.kelvin;
    delete state.hue;
    state.on = true;
  }
  if (change.on !== undefined) state.on = change.on;

  applyLight(card, lightFromDevice({ state }));
  card.classList.toggle('previewing', true);
}

/** Beendet die Vorschau und kehrt zum echten Zustand zurück. */
export function endPreview(card, device) {
  if (!card) return;
  card.classList.remove('previewing');
  applyLight(card, lightFromDevice(device));
}
