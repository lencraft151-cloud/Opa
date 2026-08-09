/**
 * Passwörter, Sperre gegen Durchprobieren und Sitzungen.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogLevel } from '../src/core/logger.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories, type Repositories } from '../src/storage/repositories.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { describeDevice, normalizeUsername, UserService } from '../src/services/userService.ts';
import {
  assertUsablePassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../src/util/password.ts';

setLogLevel('silent');

describe('Passwörter ableiten und prüfen', () => {
  it('speichert nie das Passwort selbst', async () => {
    const hash = await hashPassword('drei zufaellige woerter');
    assert.ok(!hash.includes('drei'), 'im Hash darf das Passwort nicht auftauchen');
    assert.match(hash, /^scrypt\$16384\$8\$1\$/, 'Parameter stehen mit im Hash');
  });

  it('erkennt das richtige Passwort und nur das', async () => {
    const hash = await hashPassword('drei zufaellige woerter');
    assert.equal(await verifyPassword('drei zufaellige woerter', hash), true);
    assert.equal(await verifyPassword('drei zufaellige woerter ', hash), false);
    assert.equal(await verifyPassword('Drei zufaellige woerter', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('erzeugt für dasselbe Passwort zwei verschiedene Hashes', async () => {
    // Unterschiedliches Salz – sonst verriete die Datenbank, wer dasselbe
    // Passwort benutzt.
    const a = await hashPassword('drei zufaellige woerter');
    const b = await hashPassword('drei zufaellige woerter');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('drei zufaellige woerter', b), true);
  });

  it('behandelt zusammengesetzte Umlaute wie einzelne Zeichen', async () => {
    // „ü" als ein Zeichen und als u+Trema sehen gleich aus; auf der Tastatur
    // hängt es vom System ab, was ankommt.
    const composed = 'grüne wiese heute';
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed, 'die beiden Zeichenketten sind verschieden');
    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, hash), true);
  });

  it('erkennt einen manipulierten Hash', async () => {
    const hash = await hashPassword('drei zufaellige woerter');
    assert.equal(await verifyPassword('drei zufaellige woerter', `${hash}x`), false);
    assert.equal(await verifyPassword('drei zufaellige woerter', 'unsinn'), false);
    assert.equal(await verifyPassword('drei zufaellige woerter', ''), false);
  });
});

describe('Was als Passwort durchgeht', () => {
  it('verlangt eine Mindestlänge und sagt sie', () => {
    assert.throws(
      () => assertUsablePassword('kurz'),
      (err: Error & { hint?: string }) => {
        assert.match(err.message, new RegExp(String(MIN_PASSWORD_LENGTH)));
        assert.match(err.hint ?? '', /drei zufällige Wörter/i);
        return true;
      },
    );
  });

  it('weist die üblichen Verdächtigen ab', () => {
    assert.throws(() => assertUsablePassword('123456789'), /zu kurz|Liste/);
    assert.throws(() => assertUsablePassword('zuhause123'), /Liste/);
    assert.throws(() => assertUsablePassword('SmartHome'.toLowerCase() + ''), /zu kurz|Liste/);
  });

  it('lässt ein Passwort nicht zu, das im Kern der Anmeldename ist', () => {
    const nah = /Anmeldenamen/;
    assert.throws(() => assertUsablePassword('anna hat ein passwort', 'anna'), nah, 'am Anfang');
    assert.throws(() => assertUsablePassword('mein passwort anna', 'anna'), nah, 'am Ende');
    assert.throws(() => assertUsablePassword('was anna will hier', 'anna'), nah, 'mittendrin, ab vier Zeichen');
  });

  it('lehnt einen kurzen Namen nicht ab, nur weil er zufällig im Wort steckt', () => {
    /*
     * „ben" steckt in „Winterabend" – dem Angreifer sagt das nichts, dem
     * Bewohner aber schon: Er sucht ratlos nach einem Passwort, das
     * angenommen wird. Genau das ist beim Einrichten passiert.
     */
    assert.doesNotThrow(() => assertUsablePassword('Winterabend-77', 'ben'));
    assert.doesNotThrow(() => assertUsablePassword('Regenschauer im Mai', 'sam'));
    // Als Baustein bleibt der Name verboten, egal wie kurz er ist.
    assert.throws(() => assertUsablePassword('ben-und-noch-mehr', 'ben'), /Anmeldenamen/);
    assert.throws(() => assertUsablePassword('geheimnisvoll-ben', 'ben'), /Anmeldenamen/);
  });

  it('nimmt eine lange Wortfolge an', () => {
    assert.doesNotThrow(() => assertUsablePassword('birne wolke teppich', 'anna'));
  });
});

describe('Anmeldenamen', () => {
  it('schreibt sie klein und einheitlich', () => {
    assert.equal(normalizeUsername('  Anna  '), 'anna');
    assert.equal(normalizeUsername('Ben.Meier'), 'ben.meier');
  });

  it('lehnt ab, was beim Anmelden zu Tippfehlern führt', () => {
    assert.throws(() => normalizeUsername('an'), /mindestens drei/);
    assert.throws(() => normalizeUsername('anna müller'), /erlaubt/);
    assert.throws(() => normalizeUsername('a'.repeat(40)), /zu lang/);
  });
});

describe('Geräte in der Sitzungsliste benennen', () => {
  it('macht aus einem User-Agent etwas Lesbares', () => {
    assert.equal(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
      'Safari auf iPhone/iPad',
    );
    assert.equal(
      describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
      'Chrome auf Windows',
    );
    assert.equal(describeDevice('irgendwas'), 'Browser auf unbekanntes Gerät');
  });
});

// ---------------------------------------------------------------------------
// Anmeldung gegen den Dienst
// ---------------------------------------------------------------------------

describe('Anmelden, sperren, abmelden', () => {
  let dir: string;
  let repos: Repositories;
  let users: UserService;
  let householdId = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-auth-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    repos = createRepositories(db);
    const households = new HouseholdService(repos);
    users = new UserService(repos);

    const household = await households.create({ name: 'Anmeldung' });
    householdId = household.id;
    await users.create(householdId, { username: 'anna', password: 'birne wolke teppich' });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('macht den ersten Benutzer zum Administrator', () => {
    const [first] = users.list(householdId);
    assert.equal(first?.role, 'admin');
    assert.equal(first?.displayName, 'Anna', 'ohne Angabe wird der Name großgeschrieben');
  });

  it('gibt bei falschen Angaben nicht preis, welcher Teil falsch war', async () => {
    const messages: string[] = [];
    for (const [username, password] of [
      ['anna', 'falsches passwort'],
      ['gibtesnicht', 'birne wolke teppich'],
    ]) {
      await users
        .login(householdId, username as string, password as string)
        .catch((err: Error) => messages.push(err.message));
    }
    assert.equal(messages.length, 2);
    assert.equal(messages[0], messages[1]);
  });

  it('sperrt das Konto nach fünf Fehlversuchen', async () => {
    // Der vorige Test hat schon einen Fehlversuch hinterlassen – hier zählt
    // ab null, sonst hinge das Ergebnis an der Reihenfolge der Tests.
    const [user] = repos.users.listByHousehold(householdId);
    assert.ok(user);
    await repos.users.patch(user.id, { failedAttempts: 0, lockedUntil: null });

    const messages: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await users
        .login(householdId, 'anna', 'wieder falsch')
        .catch((err: Error) => messages.push(err.message));
    }
    assert.equal(messages.length, 5, 'alle fünf Versuche scheitern');
    assert.ok(
      messages.every((message) => /Name oder Passwort/.test(message)),
      'bis zur Sperre bleibt die Meldung dieselbe',
    );

    // Danach nützt selbst das richtige Passwort nichts mehr.
    await assert.rejects(() => users.login(householdId, 'anna', 'birne wolke teppich'), /gesperrt/);
  });

  it('lässt nach Ablauf der Sperre wieder herein', async () => {
    // Die Sperre steht als Zeitpunkt in der Datenbank – hier vorgespult.
    const [user] = repos.users.listByHousehold(householdId);
    assert.ok(user);
    await repos.users.patch(user.id, { lockedUntil: new Date(Date.now() - 1000).toISOString() });

    const result = await users.login(householdId, 'anna', 'birne wolke teppich');
    assert.equal(result.user.username, 'anna');
    assert.ok(result.token.startsWith('ss_'), 'Sitzungen tragen ein eigenes Präfix');
  });

  it('prüft eine Sitzung und erkennt eine abgelaufene', async () => {
    const { token, session } = await users.login(householdId, 'anna', 'birne wolke teppich');
    assert.ok(await users.verifySession(token));

    await repos.sessions.patch(session.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await users.verifySession(token), null);
    assert.equal(repos.sessions.find(session.id), undefined, 'abgelaufen wird aufgeräumt');
  });

  it('meldet beim Passwortwechsel alle anderen Geräte ab', async () => {
    const handy = await users.login(householdId, 'anna', 'birne wolke teppich');
    const tablet = await users.login(householdId, 'anna', 'birne wolke teppich');

    await users.changePassword(
      handy.user.id,
      'birne wolke teppich',
      'ganz andere drei woerter',
      handy.session.id,
    );

    assert.ok(await users.verifySession(handy.token), 'das eigene Gerät bleibt angemeldet');
    assert.equal(await users.verifySession(tablet.token), null, 'die anderen nicht');
  });

  it('lässt das Passwort nur mit dem bisherigen ändern', async () => {
    const [user] = repos.users.listByHousehold(householdId);
    assert.ok(user);
    await assert.rejects(
      () => users.changePassword(user.id, 'stimmt nicht', 'noch drei andere woerter'),
      /bisherige Passwort/,
    );
  });

  it('lässt den letzten Administrator weder löschen noch herabstufen', async () => {
    const [admin] = repos.users.listByHousehold(householdId);
    assert.ok(admin);
    await assert.rejects(
      () => users.update(admin.id, { role: 'member' }),
      /letzte Administrator/,
    );
  });

  it('räumt abgelaufene Sitzungen auf', async () => {
    const { session } = await users.login(householdId, 'anna', 'ganz andere drei woerter');
    await repos.sessions.patch(session.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const removed = await users.pruneExpired();
    assert.ok(removed >= 1);
  });
});
