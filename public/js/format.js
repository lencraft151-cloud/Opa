/** Anzeigeformate. Alles an einer Stelle, damit Einheiten überall gleich aussehen. */

const NBSP = ' ';

function nf(digits) {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

export const fmt = {
  temperature: (value) => (isNum(value) ? `${nf(1).format(value)}${NBSP}°C` : '–'),

  percent: (value, digits = 0) => (isNum(value) ? `${nf(digits).format(value)}${NBSP}%` : '–'),

  power: (value) => {
    if (!isNum(value)) return '–';
    if (Math.abs(value) >= 1000) return `${nf(2).format(value / 1000)}${NBSP}kW`;
    return `${nf(value >= 100 ? 0 : 1).format(value)}${NBSP}W`;
  },

  energy: (kwh) => {
    if (!isNum(kwh)) return '–';
    if (kwh > 0 && kwh < 0.1) return `${nf(0).format(kwh * 1000)}${NBSP}Wh`;
    return `${nf(kwh >= 100 ? 1 : 2).format(kwh)}${NBSP}kWh`;
  },

  money: (value, currency = 'EUR') => {
    if (!isNum(value)) return '–';
    try {
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
    } catch {
      return `${nf(2).format(value)}${NBSP}${currency}`;
    }
  },

  lux: (value) => (isNum(value) ? `${nf(0).format(value)}${NBSP}lx` : '–'),

  time: (iso) =>
    !iso
      ? '–'
      : new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),

  clock: (iso) =>
    !iso ? '–' : new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),

  /** „vor 3 Minuten“ – verständlicher als ein Zeitstempel. */
  relative: (iso) => {
    if (!iso) return 'nie';
    const deltaSeconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (deltaSeconds < 45) return 'gerade eben';
    const units = [
      ['minute', 60],
      ['hour', 3600],
      ['day', 86400],
      ['month', 2592000],
      ['year', 31536000],
    ];
    let chosen = ['minute', 60];
    for (const unit of units) if (deltaSeconds >= unit[1]) chosen = unit;
    const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });
    return rtf.format(-Math.round(deltaSeconds / chosen[1]), chosen[0]);
  },

  metric(value, metric) {
    switch (metric) {
      case 'temperatureC':
        return this.temperature(value);
      case 'humidity':
      case 'batteryPercent':
      case 'brightness':
        return this.percent(value);
      case 'powerW':
        return this.power(value);
      case 'energyWh':
        return this.energy(isNum(value) ? value / 1000 : value);
      case 'illuminanceLux':
        return this.lux(value);
      default:
        return isNum(value) ? nf(1).format(value) : '–';
    }
  },
};

export const METRIC_LABEL = {
  temperatureC: 'Temperatur',
  humidity: 'Luftfeuchte',
  illuminanceLux: 'Umgebungshelligkeit',
  powerW: 'Stromverbrauch gerade',
  energyWh: 'Verbrauchte Energie',
  batteryPercent: 'Batteriestand',
  brightness: 'Lampenhelligkeit',
  targetTemperatureC: 'Solltemperatur',
  valvePosition: 'Ventilstellung',
};

/**
 * Fähigkeiten in Alltagssprache. Die technischen Bezeichner (`sensor.motion`)
 * gehören in die API, nicht auf den Bildschirm.
 */
export const CAPABILITY_LABEL = {
  switch: 'schaltbar',
  dimmer: 'dimmbar',
  color: 'Farben',
  color_temperature: 'Weißtöne',
  cover: 'Rollladen',
  'cover.tilt': 'Lamellen',
  thermostat: 'Heizung',
  'sensor.temperature': 'misst Temperatur',
  'sensor.humidity': 'misst Luftfeuchte',
  'sensor.motion': 'erkennt Bewegung',
  'sensor.illuminance': 'misst Helligkeit',
  'sensor.power': 'misst Strom',
  'sensor.energy': 'zählt Verbrauch',
  'sensor.battery': 'zeigt Batteriestand',
  button: 'Taster',
};

export const VENDOR_LABEL = {
  hue: 'Philips Hue',
  shelly: 'Shelly',
  homematic: 'Homematic',
  fritzbox: 'FRITZ!Box',
};

export const COVER_STATE_LABEL = {
  open: 'offen',
  closed: 'geschlossen',
  opening: 'fährt auf',
  closing: 'fährt zu',
  stopped: 'angehalten',
};

/** „1 Automation“ statt „1 Automationen“. */
export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Maskiert Text für die Einbettung in HTML-Vorlagen. */
export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
