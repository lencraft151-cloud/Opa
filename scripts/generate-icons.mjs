/**
 * Erzeugt die PNG-Icons der Web-App aus derselben Geometrie wie icon.svg.
 *
 * Warum selbst rastern statt eine Bibliothek zu nehmen: Das Projekt kommt
 * ohne native Abhängigkeiten aus, und ein Icon-Generator ist der falsche
 * Anlass, diese Regel zu brechen. Gezeichnet wird mit Abstandsfunktionen und
 * 3×3-Überabtastung, kodiert mit dem eingebauten zlib.
 *
 * Aufruf:  node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../public', import.meta.url));
const CANVAS = 512; // Bezugsgröße der Geometrie

// --------------------------------------------------------------------------
// Geometrie (identisch zu icon.svg)
// --------------------------------------------------------------------------

const ROOF = [
  [112, 244],
  [256, 128],
  [400, 244],
];
const WALLS = [
  [152, 232],
  [152, 384],
  [360, 384],
  [360, 232],
];
const STROKE = 30;
const BULB = { x: 256, y: 312, r: 34 };

const COLOR_TOP = [63, 127, 232];
const COLOR_BOTTOM = [31, 75, 176];
const WHITE = [255, 255, 255];
const YELLOW = [255, 215, 106];

// --------------------------------------------------------------------------
// Zeichnen
// --------------------------------------------------------------------------

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPolyline(px, py, points) {
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    min = Math.min(min, distanceToSegment(px, py, points[i - 1], points[i]));
  }
  return min;
}

/** Abstand zum Rand eines abgerundeten Rechtecks (negativ = innen). */
function roundedRectDistance(px, py, size, radius) {
  const halfSize = size / 2;
  const qx = Math.abs(px - halfSize) - (halfSize - radius);
  const qy = Math.abs(py - halfSize) - (halfSize - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Farbe eines einzelnen Abtastpunkts in Bezugskoordinaten (0..512).
 * @returns {[number, number, number, number]} RGBA
 */
function sample(x, y, { scale, maskable }) {
  // Für maskable-Icons wird die Zeichnung verkleinert, damit sie im
  // "safe zone"-Kreis bleibt, den Android beliebig beschneiden darf.
  const cx = CANVAS / 2;
  const gx = cx + (x - cx) / scale;
  const gy = cx + (y - cx) / scale;

  const radius = maskable ? CANVAS : 112;
  const edge = roundedRectDistance(x, y, CANVAS, radius);
  if (edge > 0.5) return [0, 0, 0, 0];

  const alpha = edge < -0.5 ? 255 : Math.round((0.5 - edge) * 255);
  let color = mix(COLOR_TOP, COLOR_BOTTOM, (x + y) / (2 * CANVAS));

  if (Math.hypot(gx - BULB.x, gy - BULB.y) <= BULB.r) {
    color = YELLOW;
  } else if (
    distanceToPolyline(gx, gy, ROOF) <= STROKE / 2 ||
    distanceToPolyline(gx, gy, WALLS) <= STROKE / 2
  ) {
    color = WHITE;
  }

  return [color[0], color[1], color[2], alpha];
}

function render(size, options) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = CANVAS / size;
  const samples = 3;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) * step;
          const y = (py + (sy + 0.5) / samples) * step;
          const [sr, sg, sb, sa] = sample(x, y, options);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const count = samples * samples;
      const offset = (py * size + px) * 4;
      // Farben sind mit Alpha gewichtet – zurückrechnen, sonst werden die
      // Ränder dunkel.
      pixels[offset] = a > 0 ? Math.round(r / a) : 0;
      pixels[offset + 1] = a > 0 ? Math.round(g / a) : 0;
      pixels[offset + 2] = a > 0 ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a / count);
    }
  }
  return pixels;
}

// --------------------------------------------------------------------------
// PNG-Kodierung
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // Bittiefe
  header[9] = 6; // Farbtyp RGBA
  header[10] = 0; // Deflate
  header[11] = 0; // Standardfilter
  header[12] = 0; // kein Interlacing

  // Jede Bildzeile bekommt ein führendes Filterbyte (0 = keiner).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------------

const targets = [
  { file: 'icon-192.png', size: 192, scale: 1, maskable: false },
  { file: 'icon-512.png', size: 512, scale: 1, maskable: false },
  { file: 'icon-180.png', size: 180, scale: 1, maskable: false },
  // Android beschneidet maskable-Icons – die Zeichnung muss kleiner sein.
  { file: 'icon-maskable.png', size: 512, scale: 0.68, maskable: true },
];

for (const target of targets) {
  const pixels = render(target.size, { scale: target.scale, maskable: target.maskable });
  const png = encodePng(pixels, target.size);
  writeFileSync(path.join(OUT_DIR, target.file), png);
  process.stdout.write(`${target.file}: ${target.size}×${target.size}, ${png.length} Bytes\n`);
}
