/**
 * Farbrad für Lampen.
 *
 * Der Winkel bestimmt den Farbton, der Abstand zur Mitte die Sättigung –
 * außen kräftig, in der Mitte weiß. Gezeichnet wird das Rad mit zwei
 * CSS-Verläufen (conic für den Farbton, radial für die Sättigung); das ist
 * schärfer als ein gerastertes Bild und kommt ohne Canvas aus.
 */

import { esc } from './format.js';
import { previewChange } from './lightpreview.js';

/** Voreingestellte Stimmungen – schneller als jedes Rad. */
export const COLOR_PRESETS = [
  { label: 'Kerzenlicht', kelvin: 2000 },
  { label: 'Warmweiß', kelvin: 2700 },
  { label: 'Neutralweiß', kelvin: 4000 },
  { label: 'Tageslicht', kelvin: 6000 },
  { label: 'Rot', hue: 0, saturation: 100 },
  { label: 'Orange', hue: 30, saturation: 100 },
  { label: 'Gelb', hue: 55, saturation: 95 },
  { label: 'Grün', hue: 120, saturation: 85 },
  { label: 'Türkis', hue: 175, saturation: 90 },
  { label: 'Blau', hue: 225, saturation: 95 },
  { label: 'Violett', hue: 280, saturation: 90 },
  { label: 'Pink', hue: 320, saturation: 85 },
];

/** Farbtemperatur grob als Bildschirmfarbe, für die Vorschau der Weißtöne. */
export function kelvinToCss(kelvin) {
  const t = Math.min(1, Math.max(0, (kelvin - 2000) / 4500));
  const r = 255;
  const g = Math.round(150 + 85 * t);
  const b = Math.round(70 + 175 * t);
  return `rgb(${r} ${g} ${b})`;
}

export function hsvToCss(hue, saturation) {
  return `hsl(${hue} ${saturation}% 55%)`;
}

/**
 * Baut das Farbrad. Der Griff sitzt auf der aktuellen Farbe.
 * @param {object} device Gerät mit der Fähigkeit "color"
 */
export function colorWheel(device) {
  const state = device.state ?? {};
  const hue = typeof state.hue === 'number' ? state.hue : 40;
  const saturation = typeof state.saturation === 'number' ? state.saturation : 70;
  const supportsWhite = device.capabilities.includes('color_temperature');

  const presets = COLOR_PRESETS.filter((preset) => supportsWhite || preset.hue !== undefined)
    .map((preset) => {
      const color = preset.kelvin ? kelvinToCss(preset.kelvin) : hsvToCss(preset.hue, preset.saturation);
      const data = preset.kelvin
        ? `data-preset-kelvin="${preset.kelvin}"`
        : `data-preset-hue="${preset.hue}" data-preset-saturation="${preset.saturation}"`;
      return `<button class="swatch" ${data} data-device="${esc(device.id)}"
                title="${esc(preset.label)}" aria-label="${esc(preset.label)}"
                style="--swatch:${color}"></button>`;
    })
    .join('');

  return `<div class="color-picker">
    <div class="color-wheel" data-wheel="${esc(device.id)}" role="slider"
         tabindex="0" aria-label="Farbe wählen"
         aria-valuetext="Farbton ${Math.round(hue)} Grad, Sättigung ${Math.round(saturation)} Prozent">
      <span class="wheel-handle" style="--angle:${hue}deg; --radius:${saturation}"></span>
    </div>
    <div class="color-side">
      <div class="color-current">
        <span class="color-dot" style="background:${hsvToCss(hue, saturation)}"></span>
        <span class="muted small" data-color-label="${esc(device.id)}">
          Farbton ${Math.round(hue)}°, Sättigung ${Math.round(saturation)} %
        </span>
      </div>
      <div class="swatches">${presets}</div>
    </div>
  </div>`;
}

/**
 * Verbindet Rad und Farbfelder mit `onCommand`.
 *
 * Während des Ziehens wird nur die Anzeige nachgeführt; gesendet wird beim
 * Loslassen. Sonst würde jede Fingerbewegung ein Kommando an die Bridge
 * schicken und die Lampe käme mit dem Nachziehen nicht hinterher.
 */
export function bindColorControls(root, onCommand, lookupDevice = () => undefined) {
  root.querySelectorAll('[data-wheel]').forEach((wheel) => {
    const deviceId = wheel.dataset.wheel;
    const handle = wheel.querySelector('.wheel-handle');
    const label = root.querySelector(`[data-color-label="${CSS.escape(deviceId)}"]`);
    const dot = label?.previousElementSibling;
    const card = wheel.closest('.device-card');
    let pending = null;

    const positionFrom = (event) => {
      const rect = wheel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = event.clientX - cx;
      const dy = event.clientY - cy;

      // Bildschirmkoordinaten: y zeigt nach unten, deshalb das Vorzeichen.
      let hue = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (hue < 0) hue += 360;

      const radius = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2));
      return { hue: Math.round(hue), saturation: Math.round(radius * 100) };
    };

    const preview = ({ hue, saturation }) => {
      handle.style.setProperty('--angle', `${hue}deg`);
      handle.style.setProperty('--radius', String(saturation));
      if (dot) dot.style.background = hsvToCss(hue, saturation);
      // Die ganze Karte zeigt mit, wie das Licht aussehen wird.
      if (card) previewChange(card, lookupDevice(deviceId), { hue, saturation });
      if (label) label.textContent = `Farbton ${hue}°, Sättigung ${saturation} %`;
      wheel.setAttribute(
        'aria-valuetext',
        `Farbton ${hue} Grad, Sättigung ${saturation} Prozent`,
      );
    };

    wheel.addEventListener('pointerdown', (event) => {
      wheel.setPointerCapture(event.pointerId);
      pending = positionFrom(event);
      preview(pending);
      event.preventDefault();
    });

    wheel.addEventListener('pointermove', (event) => {
      if (!wheel.hasPointerCapture?.(event.pointerId)) return;
      pending = positionFrom(event);
      preview(pending);
    });

    const release = (event) => {
      if (!pending) return;
      wheel.releasePointerCapture?.(event.pointerId);
      const { hue, saturation } = pending;
      pending = null;
      // Die Vorschau endet hier – ab jetzt zeigt die Karte den echten Zustand.
      card?.classList.remove('previewing');
      void onCommand(deviceId, { type: 'setColor', hue, saturation });
    };
    wheel.addEventListener('pointerup', release);
    wheel.addEventListener('pointercancel', release);

    // Bedienung per Tastatur: Pfeile drehen den Farbton, hoch/runter die Sättigung.
    wheel.addEventListener('keydown', (event) => {
      const current = {
        hue: parseFloat(handle.style.getPropertyValue('--angle')) || 0,
        saturation: parseFloat(handle.style.getPropertyValue('--radius')) || 0,
      };
      const step = event.shiftKey ? 15 : 5;
      let changed = true;
      switch (event.key) {
        case 'ArrowLeft':
          current.hue = (current.hue - step + 360) % 360;
          break;
        case 'ArrowRight':
          current.hue = (current.hue + step) % 360;
          break;
        case 'ArrowUp':
          current.saturation = Math.min(100, current.saturation + step);
          break;
        case 'ArrowDown':
          current.saturation = Math.max(0, current.saturation - step);
          break;
        default:
          changed = false;
      }
      if (!changed) return;
      event.preventDefault();
      preview(current);
      void onCommand(deviceId, {
        type: 'setColor',
        hue: Math.round(current.hue),
        saturation: Math.round(current.saturation),
      });
    });
  });

  root.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      const deviceId = swatch.dataset.device;
      if (swatch.dataset.presetKelvin) {
        void onCommand(deviceId, {
          type: 'setColorTemperature',
          kelvin: Number(swatch.dataset.presetKelvin),
        });
        return;
      }
      void onCommand(deviceId, {
        type: 'setColor',
        hue: Number(swatch.dataset.presetHue),
        saturation: Number(swatch.dataset.presetSaturation),
      });
    });
  });
}
