/** Wiederverwendbare Bausteine der Oberfläche. */

import { sparkline } from './charts.js';
import { bindColorControls, colorWheel, hsvToCss } from './colorwheel.js';
import { CAPABILITY_LABEL, COVER_STATE_LABEL, esc, fmt, VENDOR_LABEL } from './format.js';
import { iconForDevice, icons } from './icons.js';

const has = (device, capability) => device.capabilities.includes(capability);

/** Zusammenfassende Kachel. */
export function tile({ value, label, trend, accent = false }) {
  return `<div class="tile ${accent ? 'accent' : ''}">
    <div class="value">${esc(value)}</div>
    <div class="label">${esc(label)}</div>
    ${trend ? `<div class="trend">${esc(trend)}</div>` : ''}
  </div>`;
}

export function emptyState(emoji, title, hint = '') {
  return `<div class="empty">
    <span class="emoji">${esc(emoji)}</span>
    <div>${esc(title)}</div>
    ${hint ? `<div class="small">${esc(hint)}</div>` : ''}
  </div>`;
}

export function skeletonGrid(count = 4) {
  return `<div class="grid">${'<div class="skeleton"></div>'.repeat(count)}</div>`;
}

// ---------------------------------------------------------------------------
// Gerätekarte
// ---------------------------------------------------------------------------

/**
 * @param {object} device
 * @param {{ showMeta?: boolean, roomName?: string|null, history?: number[] }} options
 */
export function deviceCard(device, options = {}) {
  if (has(device, 'cover')) return coverCard(device, options);

  const state = device.state ?? {};
  const readings = [];

  const push = (icon, value) => readings.push(`<span class="reading">${icon} <strong>${value}</strong></span>`);
  if (has(device, 'sensor.temperature')) push('🌡️', esc(fmt.temperature(state.temperatureC)));
  if (has(device, 'sensor.humidity')) push('💧', esc(fmt.percent(state.humidity)));
  if (has(device, 'sensor.power')) push('⚡', esc(fmt.power(state.powerW)));
  if (has(device, 'sensor.energy')) push('Σ', esc(fmt.energy((state.energyWh ?? 0) / 1000)));
  if (has(device, 'sensor.illuminance')) push('☀️', esc(fmt.lux(state.illuminanceLux)));
  if (has(device, 'sensor.motion')) push('🚶', state.motion ? 'Bewegung' : 'ruhig');
  if (has(device, 'sensor.battery')) push('🔋', esc(fmt.percent(state.batteryPercent)));

  const controls = [];
  if (has(device, 'dimmer')) {
    controls.push(
      slider({
        label: 'Helligkeit',
        value: Math.round(state.brightness ?? 0),
        display: fmt.percent(state.brightness ?? 0),
        attribute: 'brightness',
        deviceId: device.id,
      }),
    );
  }
  if (has(device, 'color_temperature')) {
    controls.push(
      slider({
        label: 'Weißton',
        value: Math.round(state.colorTemperatureK ?? 2700),
        display: describeKelvin(state.colorTemperatureK ?? 2700),
        attribute: 'kelvin',
        deviceId: device.id,
        min: 2000,
        max: 6500,
        step: 100,
      }),
    );
  }
  if (has(device, 'color')) {
    controls.push(`<details class="color-details" data-section="color:${esc(device.id)}">
      <summary>Farbe wählen</summary>
      ${colorWheel(device)}
    </details>`);
  }

  // Ein Farbpunkt im Kopf zeigt die aktuelle Farbe, ohne dass man das Rad
  // aufklappen muss.
  const colorHint =
    has(device, 'color') && typeof state.hue === 'number'
      ? `<span class="color-dot" title="Aktuelle Farbe"
               style="background:${hsvToCss(state.hue, state.saturation ?? 100)}"></span>`
      : '';

  return `<article class="device-card ${state.on ? 'on' : ''} ${device.reachable ? '' : 'offline'}"
                   data-device="${esc(device.id)}">
    <header>
      <div>
        <div class="name">${esc(device.name)}</div>
        ${options.showMeta ? metaLine(device, options.roomName) : ''}
      </div>
      <div class="row tight" style="flex-wrap:nowrap">
        ${colorHint}
        ${
          has(device, 'switch')
            ? `<label class="switch" title="Ein- und ausschalten">
                 <input type="checkbox" data-power="${esc(device.id)}" ${state.on ? 'checked' : ''}
                        ${device.reachable ? '' : 'disabled'} />
                 <span></span>
               </label>`
            : `<span class="badge">${device.reachable ? 'misst nur' : 'offline'}</span>`
        }
      </div>
    </header>
    ${readings.length ? `<div class="readings">${readings.join('')}</div>` : ''}
    ${options.history?.length ? sparkline(options.history) : ''}
    ${controls.join('')}
    ${device.reachable ? '' : offlineHint(device)}
  </article>`;
}

function metaLine(device, roomName) {
  const parts = [VENDOR_LABEL[device.vendor] ?? device.vendor];
  if (roomName) parts.push(roomName);
  // Statt der Fähigkeitscodes steht hier in Alltagssprache, was das Gerät kann.
  const abilities = device.capabilities
    .map((capability) => CAPABILITY_LABEL[capability])
    .filter(Boolean);
  if (abilities.length > 0) parts.push(abilities.join(', '));
  return `<div class="meta">${esc(parts.join(' · '))}</div>`;
}

function offlineHint(device) {
  return `<div class="meta">Antwortet gerade nicht – zuletzt erreicht
    ${esc(fmt.relative(device.lastSeenAt))}. Sensoren mit Batterie melden sich
    nur, wenn sie aufwachen; das ist normal.</div>`;
}

/** „2700 K“ sagt den wenigsten etwas – „warmweiß“ schon. */
export function describeKelvin(kelvin) {
  if (kelvin <= 2300) return `Kerzenlicht (${kelvin} K)`;
  if (kelvin <= 3200) return `warmweiß (${kelvin} K)`;
  if (kelvin <= 4500) return `neutralweiß (${kelvin} K)`;
  if (kelvin <= 5500) return `kaltweiß (${kelvin} K)`;
  return `Tageslicht (${kelvin} K)`;
}

function slider({ label, value, display, attribute, deviceId, min = 0, max = 100, step = 1 }) {
  return `<label class="slider-field">
    <span class="slider-head"><span>${esc(label)}</span><b data-readout="${esc(attribute)}">${esc(display)}</b></span>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
           data-${esc(attribute)}="${esc(deviceId)}" />
  </label>`;
}

// ---------------------------------------------------------------------------
// Rollladen
// ---------------------------------------------------------------------------

/**
 * Rollladenkarte mit animierter Darstellung.
 *
 * Die Position ist wie im Rest des Systems definiert: 100 = ganz offen,
 * 0 = ganz zu. Der gezeichnete Behang ist entsprechend `100 - position` hoch.
 */
export function coverCard(device, options = {}) {
  const state = device.state ?? {};
  const position = typeof state.position === 'number' ? Math.round(state.position) : null;
  const closedPercent = position === null ? 50 : 100 - position;
  const coverState = state.coverState ?? 'stopped';
  const moving = coverState === 'opening' || coverState === 'closing';

  const tiltControl = has(device, 'cover.tilt')
    ? slider({
        label: 'Lamellen',
        value: Math.round(state.tilt ?? 0),
        display: fmt.percent(state.tilt ?? 0),
        attribute: 'tilt',
        deviceId: device.id,
      })
    : '';

  return `<article class="device-card cover-card ${device.reachable ? '' : 'offline'}"
                   data-device="${esc(device.id)}">
    <header>
      <div>
        <div class="name">${esc(device.name)}</div>
        ${options.showMeta ? metaLine(device, options.roomName) : ''}
      </div>
      <span class="badge ${moving ? 'accent' : ''}">${esc(COVER_STATE_LABEL[coverState] ?? coverState)}</span>
    </header>

    <div class="cover-body">
      <div class="blind ${moving ? 'moving' : ''}" aria-hidden="true">
        <span class="sun"></span>
        <div class="slats" style="--closed:${closedPercent}%"></div>
      </div>

      <div class="cover-buttons">
        <button class="icon ${coverState === 'opening' ? 'active' : ''}"
                data-cover-open="${esc(device.id)}" title="Auffahren" aria-label="Auffahren">${icons.up}</button>
        <button class="icon" data-cover-stop="${esc(device.id)}" title="Anhalten" aria-label="Anhalten">${icons.stop}</button>
        <button class="icon ${coverState === 'closing' ? 'active' : ''}"
                data-cover-close="${esc(device.id)}" title="Zufahren" aria-label="Zufahren">${icons.down}</button>
      </div>

      <div class="cover-info">
        ${slider({
          label: 'Position (offen)',
          value: position ?? 0,
          display: position === null ? '–' : fmt.percent(position),
          attribute: 'position',
          deviceId: device.id,
        })}
        ${tiltControl}
        ${
          has(device, 'sensor.power')
            ? `<div class="readings"><span class="reading">⚡ <strong>${esc(fmt.power(state.powerW))}</strong></span></div>`
            : ''
        }
      </div>
    </div>
    ${device.reachable ? '' : offlineHint(device)}
  </article>`;
}

// ---------------------------------------------------------------------------
// Verdrahtung
// ---------------------------------------------------------------------------

const RANGE_COMMANDS = {
  brightness: (value) => ({ type: 'setBrightness', brightness: value }),
  kelvin: (value) => ({ type: 'setColorTemperature', kelvin: value }),
  position: (value) => ({ type: 'setPosition', position: value }),
  tilt: (value) => ({ type: 'setTilt', tilt: value }),
};

const READOUT = {
  brightness: (value) => fmt.percent(value),
  kelvin: (value) => describeKelvin(value),
  position: (value) => fmt.percent(value),
  tilt: (value) => fmt.percent(value),
};

/**
 * Verbindet alle Bedienelemente eines gerenderten Bereichs mit `onCommand`.
 * @param {ParentNode} root
 * @param {(deviceId: string, command: object) => Promise<unknown>} onCommand
 */
export function bindDeviceControls(root, onCommand) {
  root.querySelectorAll('[data-power]').forEach((input) => {
    input.addEventListener('change', () => {
      void onCommand(input.dataset.power, { type: 'setPower', on: input.checked });
    });
  });

  for (const [attribute, build] of Object.entries(RANGE_COMMANDS)) {
    root.querySelectorAll(`[data-${attribute}]`).forEach((input) => {
      const readout = input.closest('.slider-field')?.querySelector('[data-readout]');
      // Beschriftung folgt dem Finger, gesendet wird erst beim Loslassen.
      input.addEventListener('input', () => {
        if (readout) readout.textContent = READOUT[attribute](Number(input.value));
      });
      input.addEventListener('change', () => {
        void onCommand(input.dataset[attribute], build(Number(input.value)));
      });
    });
  }

  const coverButtons = [
    ['coverOpen', 'openCover'],
    ['coverClose', 'closeCover'],
    ['coverStop', 'stopCover'],
  ];
  for (const [dataset, type] of coverButtons) {
    root.querySelectorAll(`[data-${dataset.replace(/([A-Z])/g, '-$1').toLowerCase()}]`).forEach((button) => {
      button.addEventListener('click', () => {
        void onCommand(button.dataset[dataset], { type });
      });
    });
  }

  bindColorControls(root, onCommand);
}

/** Icon eines Geräts – auch außerhalb der Karte nutzbar. */
export { iconForDevice };
