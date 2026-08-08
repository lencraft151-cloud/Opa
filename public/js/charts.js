/** Diagramme als reines SVG – klein, scharf und ohne Bibliothek. */

import { esc, fmt } from './format.js';

/**
 * Liniendiagramm mit Min/Max-Band. Die Linie zeichnet sich beim Erscheinen
 * einmal durch (`stroke-dasharray`-Animation in styles.css).
 */
export function lineChart(series, metric) {
  if (!series || series.length < 2) {
    return `<div class="empty"><span class="emoji">📈</span>
      Für diesen Zeitraum liegen noch zu wenige Messwerte vor.<br />
      <span class="small">Der Hub schreibt bei jeder relevanten Änderung mit – nach einer Weile wird die Kurve dichter.</span>
    </div>`;
  }

  const width = 900;
  const height = 260;
  const pad = { top: 16, right: 16, bottom: 30, left: 54 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const values = series.flatMap((point) => [point.min, point.max]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lower = min - span * 0.12;
  const upper = max + span * 0.12;

  const x = (index) => pad.left + (index / (series.length - 1)) * innerW;
  const y = (value) => pad.top + innerH - ((value - lower) / (upper - lower)) * innerH;

  const line = series.map((p, i) => `${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const band = [
    ...series.map((p, i) => `${x(i).toFixed(1)},${y(p.max).toFixed(1)}`),
    ...series
      .map((p, i) => ({ p, i }))
      .reverse()
      .map(({ p, i }) => `${x(i).toFixed(1)},${y(p.min).toFixed(1)}`),
  ].join(' ');

  const ticks = 4;
  const grid = Array.from({ length: ticks + 1 }, (_, index) => {
    const value = lower + ((upper - lower) * index) / ticks;
    const yPos = y(value);
    return `<line class="axis" x1="${pad.left}" y1="${yPos.toFixed(1)}" x2="${width - pad.right}" y2="${yPos.toFixed(1)}" />
            <text class="label" x="${pad.left - 8}" y="${(yPos + 4).toFixed(1)}" text-anchor="end">${esc(
              fmt.metric(value, metric),
            )}</text>`;
  }).join('');

  const labelCount = Math.min(6, series.length);
  const timeLabels = Array.from({ length: labelCount }, (_, index) => {
    const seriesIndex = Math.round((index / (labelCount - 1)) * (series.length - 1));
    const date = new Date(series[seriesIndex].t);
    const text = date.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const anchor = index === 0 ? 'start' : index === labelCount - 1 ? 'end' : 'middle';
    return `<text class="label" x="${x(seriesIndex).toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${esc(text)}</text>`;
  }).join('');

  // Länge grob abschätzen, damit die Zeichenanimation gleichmäßig läuft.
  const approxLength = Math.round(innerW * 1.4);

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
               aria-label="Verlauf">
    ${grid}
    <polygon class="band" points="${band}" />
    <polyline class="line" points="${line}" style="--len:${approxLength}" />
    ${timeLabels}
  </svg>`;
}

/** Kleine Verlaufskurve für Gerätekarten. */
export function sparkline(values) {
  if (!values || values.length < 2) return '';
  const width = 200;
  const height = 34;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - 3 - ((value - min) / span) * (height - 6);
    return [x, y];
  });

  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${path} L${width} ${height} L0 ${height} Z`;

  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="fill" d="${area}" />
    <path d="${path}" />
  </svg>`;
}

/**
 * Rundanzeige, z. B. für die Durchschnittstemperatur.
 * `value` liegt zwischen `min` und `max`; darüber/darunter wird gekappt.
 */
export function gauge({ value, min = 0, max = 40, label, unit = '°C' }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  // Dreiviertelkreis, unten offen.
  const arc = circumference * 0.75;
  const ratio =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(1, Math.max(0, (value - min) / (max - min)))
      : 0;
  const offset = arc * (1 - ratio);

  const display =
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1).replace('.', ',') : '–';

  return `<svg class="gauge" viewBox="0 0 128 128" role="img" aria-label="${esc(label ?? '')}">
    <g transform="rotate(135 64 64)">
      <circle class="track" cx="64" cy="64" r="${radius}"
              stroke-dasharray="${arc.toFixed(1)} ${circumference.toFixed(1)}" />
      <circle class="value-arc" cx="64" cy="64" r="${radius}"
              stroke-dasharray="${arc.toFixed(1)} ${circumference.toFixed(1)}"
              stroke-dashoffset="${offset.toFixed(1)}" />
    </g>
    <text class="big" x="64" y="66">${esc(display)}${esc(unit)}</text>
    <text class="sub" x="64" y="86">${esc(label ?? '')}</text>
  </svg>`;
}

/** Waagerechte Balkenliste, z. B. Top-Verbraucher. */
export function barList(entries, { formatValue = (v) => String(v), emptyText = 'Keine Daten' } = {}) {
  if (!entries || entries.length === 0) {
    return `<div class="empty"><span class="emoji">🔌</span>${esc(emptyText)}</div>`;
  }
  const max = Math.max(...entries.map((entry) => entry.value), 0.0001);

  return `<div class="bars">${entries
    .map((entry) => {
      const percent = Math.max(2, (entry.value / max) * 100);
      return `<div class="bar-row">
        <div class="bar-label">${esc(entry.label)}${
          entry.sub ? ` <span class="muted small">${esc(entry.sub)}</span>` : ''
        }</div>
        <div class="bar-value">${esc(formatValue(entry.value))}</div>
        <div class="bar-track"><div class="bar-fill" style="--w:${percent.toFixed(1)}%"></div></div>
      </div>`;
    })
    .join('')}</div>`;
}
