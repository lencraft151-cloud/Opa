import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest } from '../core/errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Passwörter.
 *
 * Gespeichert wird nie das Passwort, sondern eine scrypt-Ableitung samt der
 * Parameter, mit denen sie entstanden ist:
 *
 *     scrypt$16384$8$1$<salz>$<ableitung>
 *
 * Die Parameter mitzuschreiben klingt umständlich, ist aber der Grund, warum
 * sie später erhöht werden können, ohne dass alte Passwörter ungültig werden.
 *
 * scrypt läuft absichtlich asynchron: Die Ableitung dauert bewusst rund
 * 100 ms, und in dieser Zeit soll der Hub weiter Geräte bedienen können.
 */

/** Kosten wie in der Node-Dokumentation empfohlen. */
const PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Prüft ein Passwort gegen eine gespeicherte Ableitung.
 *
 * Der Vergleich ist zeitunabhängig – sonst verriete die Antwortdauer, wie
 * viele Zeichen bereits stimmen.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: PARAMS.maxmem,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Die zwanzig Passwörter, die in jeder Leak-Sammlung ganz oben stehen. Eine
 * vollständige Liste gehört nicht in einen Haushalts-Hub – aber diese hier
 * abzuweisen kostet nichts und verhindert die schlimmsten Fälle.
 */
const TOO_COMMON = new Set([
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'passwort',
  'qwertz123',
  'qwerty123',
  'iloveyou',
  'admin123',
  'letmein1',
  'welcome1',
  'sonnenschein',
  'schatz123',
  'hallo123',
  'test1234',
  'geheim123',
  'smarthome',
  'zuhause123',
  'abcd1234',
]);

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Prüft ein neues Passwort und erklärt bei einem Nein, was zu tun ist.
 *
 * Bewusst keine Zeichenklassen-Pflicht („mindestens ein Sonderzeichen“): Sie
 * führt zu `Passwort1!` und macht Passwörter nicht besser. Länge zählt.
 */
export function assertUsablePassword(password: string, username = ''): void {
  const value = password.normalize('NFKC');

  if (value.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(
      `Das Passwort ist zu kurz – mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`,
      undefined,
      'Drei zufällige Wörter hintereinander sind leicht zu merken und trotzdem sicher.',
    );
  }
  if (value.length > 200) {
    throw badRequest('Das Passwort ist unpraktisch lang – höchstens 200 Zeichen.');
  }
  if (TOO_COMMON.has(value.toLowerCase())) {
    throw badRequest(
      'Dieses Passwort steht auf jeder Liste, die Angreifer zuerst durchprobieren.',
      undefined,
      'Nimm etwas, das nicht in einem Wörterbuch steht – zum Beispiel drei zufällige Wörter.',
    );
  }
  if (username && value.toLowerCase().includes(username.trim().toLowerCase()) && username.length >= 3) {
    throw badRequest(
      'Das Passwort darf nicht den Anmeldenamen enthalten.',
      undefined,
      'Der Name ist bekannt – ein Passwort, das ihn enthält, ist damit halb geraten.',
    );
  }
}
