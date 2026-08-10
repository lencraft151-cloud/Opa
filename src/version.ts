/**
 * Die Fassung des Hubs.
 *
 * Steht hier und nicht in `package.json`, weil der Build sie sonst erst zur
 * Laufzeit von der Platte lesen müsste – und weil `dist/` neben `package.json`
 * liegt, nicht darin. Beide Stellen zeigen dieselbe Zahl; `CHANGELOG.md` sagt,
 * was sich dahinter verbirgt.
 *
 * Dass sie wirklich dieselbe Zahl zeigen, prüft `tests/version.test.ts` –
 * einmal ist genau das hier vergessen worden, und der Hub hielt daraufhin
 * seine eigene Fassung für ein verfügbares Update.
 */
export const VERSION = '1.10.0';
