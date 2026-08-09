/**
 * Die Fassung des Hubs.
 *
 * Steht hier und nicht in `package.json`, weil der Build sie sonst erst zur
 * Laufzeit von der Platte lesen müsste – und weil `dist/` neben `package.json`
 * liegt, nicht darin. Beide Stellen zeigen dieselbe Zahl; `CHANGELOG.md` sagt,
 * was sich dahinter verbirgt.
 */
export const VERSION = '1.3.2';
