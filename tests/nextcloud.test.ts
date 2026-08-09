/**
 * Nextcloud: Adressen, OCS-Antworten, neue Benachrichtigungen und der
 * vollständige Weg vom Server bis zum Ereignis, aus dem die Oberfläche ein
 * Popup baut.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { events } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Household } from '../src/core/types.ts';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE } from '../src/core/types.ts';
import {
  clampInterval,
  describeNotification,
  freshNotifications,
  NextcloudService,
  normalizeBaseUrl,
  parseOcs,
  toNotifications,
} from '../src/services/nextcloudService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// Adressen
// ---------------------------------------------------------------------------

describe('Nextcloud-Adresse', () => {
  it('ergänzt das fehlende https', () => {
    assert.equal(normalizeBaseUrl('cloud.example.de'), 'https://cloud.example.de');
  });

  it('wirft den abschließenden Schrägstrich weg', () => {
    assert.equal(normalizeBaseUrl('https://cloud.example.de/'), 'https://cloud.example.de');
  });

  it('behält ein Unterverzeichnis', () => {
    assert.equal(
      normalizeBaseUrl('https://example.de/nextcloud/'),
      'https://example.de/nextcloud',
    );
  });

  it('schneidet eine mitkopierte App-Adresse ab', () => {
    assert.equal(
      normalizeBaseUrl('https://cloud.example.de/index.php/apps/files?dir=/Fotos'),
      'https://cloud.example.de',
    );
    assert.equal(
      normalizeBaseUrl('https://example.de/nextcloud/apps/dashboard'),
      'https://example.de/nextcloud',
    );
  });

  it('behält einen abweichenden Port und http', () => {
    assert.equal(normalizeBaseUrl('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
  });

  it('meldet eine leere Eingabe verständlich', () => {
    assert.throws(() => normalizeBaseUrl('   '), /fehlt die Adresse/);
  });
});

// ---------------------------------------------------------------------------
// OCS
// ---------------------------------------------------------------------------

describe('OCS-Antworten', () => {
  it('packt die Nutzdaten aus', () => {
    const body = JSON.stringify({
      ocs: { meta: { status: 'ok', statuscode: 200 }, data: { id: 'anna' } },
    });
    assert.deepEqual(parseOcs<{ id: string }>(body, 'cloud.example.de'), { id: 'anna' });
  });

  it('macht aus einem OCS-Fehlercode eine lesbare Meldung', () => {
    const body = JSON.stringify({
      ocs: { meta: { status: 'failure', statuscode: 998, message: 'App not enabled' } },
    });
    assert.throws(() => parseOcs(body, 'cloud.example.de'), /App not enabled/);
  });

  it('erkennt eine Seite, die keine Nextcloud ist', () => {
    assert.throws(
      () => parseOcs('<html>Anmeldung</html>', 'router.fritz.box'),
      /keine JSON-Antwort/,
    );
    assert.throws(() => parseOcs('{"hallo":1}', 'router.fritz.box'), /nicht wie eine Nextcloud/);
  });
});

// ---------------------------------------------------------------------------
// Benachrichtigungen
// ---------------------------------------------------------------------------

const raw = (id: number, extra: Record<string, unknown> = {}) => ({
  notification_id: id,
  app: 'spreed',
  subject: `Nachricht ${id}`,
  message: 'Hallo!',
  datetime: '2026-08-09T10:00:00+00:00',
  ...extra,
});

describe('Benachrichtigungen lesen', () => {
  it('nimmt die neueste zuerst', () => {
    const list = toNotifications([raw(3), raw(9), raw(5)]);
    assert.deepEqual(
      list.map((entry) => entry.id),
      [9, 5, 3],
    );
  });

  it('überspringt Einträge ohne Kennung', () => {
    const list = toNotifications([{ app: 'files' }, raw(2)]);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, 2);
  });

  it('macht aus einem relativen Verweis eine vollständige Adresse', () => {
    const list = toNotifications([raw(1, { link: '/call/abc123' })], 'https://cloud.example.de');
    assert.equal(list[0]?.link, 'https://cloud.example.de/call/abc123');
  });

  it('lässt einen Verweis fallen, der kein http(s) ist', () => {
    const list = toNotifications(
      [raw(1, { link: 'javascript:alert(1)' })],
      'https://cloud.example.de',
    );
    assert.equal(list[0]?.link, null);
  });

  it('kommt mit einer leeren Liste zurecht', () => {
    assert.deepEqual(toNotifications([]), []);
    assert.deepEqual(toNotifications(null), []);
  });
});

describe('Was ist neu', () => {
  it('meldet nur, was über dem gemerkten Stand liegt – aufsteigend', () => {
    const list = toNotifications([raw(12), raw(11), raw(10)]);
    const { fresh, nextId } = freshNotifications(list, 10);
    assert.deepEqual(
      fresh.map((entry) => entry.id),
      [11, 12],
    );
    assert.equal(nextId, 12);
  });

  it('meldet nichts, wenn sich nichts geändert hat', () => {
    const list = toNotifications([raw(12)]);
    assert.deepEqual(freshNotifications(list, 12), { fresh: [], nextId: 12 });
  });

  it('behält den Stand, wenn gar nichts offen ist', () => {
    assert.deepEqual(freshNotifications([], 42), { fresh: [], nextId: 42 });
  });

  it('spuckt nach einem Zurücksetzen der Nextcloud keine alten Meldungen aus', () => {
    // Alle Kennungen unter dem gemerkten Stand: Die Zählung fing neu an.
    const list = toNotifications([raw(2), raw(1)]);
    assert.deepEqual(freshNotifications(list, 500), { fresh: [], nextId: 2 });
  });
});

describe('Wie eine Meldung heißt', () => {
  it('übersetzt bekannte Apps', () => {
    assert.equal(
      describeNotification({
        id: 1,
        app: 'spreed',
        subject: 'Anna hat geschrieben',
        message: '',
        link: null,
        datetime: '',
      }),
      'Talk: Anna hat geschrieben',
    );
  });

  it('nimmt bei unbekannten Apps deren Namen', () => {
    assert.equal(
      describeNotification({
        id: 1,
        app: 'cospend',
        subject: 'Neue Ausgabe',
        message: '',
        link: null,
        datetime: '',
      }),
      'cospend: Neue Ausgabe',
    );
  });

  it('bleibt auch ohne Betreff verständlich', () => {
    assert.equal(
      describeNotification({ id: 1, app: 'files', subject: '', message: '', link: null, datetime: '' }),
      'Dateien: Neue Benachrichtigung',
    );
  });
});

describe('Abruftakt', () => {
  it('bleibt in vernünftigen Grenzen', () => {
    assert.equal(clampInterval(30), 30);
    assert.equal(clampInterval(1), 10);
    assert.equal(clampInterval(99_999), 3600);
    assert.equal(clampInterval(Number.NaN), 30);
  });
});

// ---------------------------------------------------------------------------
// Der ganze Weg – gegen eine nachgebaute Nextcloud
// ---------------------------------------------------------------------------

const USER = 'anna';
const APP_PASSWORD = 'aaaaa-bbbbb-ccccc-ddddd-eeeee';

interface FakeCloud {
  server: http.Server;
  url: string;
  /** Was die Instanz gerade als offen meldet. */
  notifications: Array<Record<string, unknown>>;
  /** Wie oft die Liste abgefragt wurde. */
  calls: number;
  /** Gelöschte Kennungen, in der Reihenfolge des Eintreffens. */
  deleted: Array<number | 'alle'>;
}

function ocs(res: http.ServerResponse, data: unknown, statuscode = 200): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ocs: { meta: { status: 'ok', statuscode }, data } }));
}

async function startFakeCloud(): Promise<FakeCloud> {
  const state: FakeCloud = {
    server: null as unknown as http.Server,
    url: '',
    notifications: [],
    calls: 0,
    deleted: [],
  };

  state.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(`${USER}:${APP_PASSWORD}`).toString('base64')}`;

    // Eine Nextcloud verlangt diesen Header – ohne ihn antwortet sie mit einer
    // HTML-Seite statt mit JSON.
    assert.equal(req.headers['ocs-apirequest'], 'true');

    if (auth !== expected) {
      res.writeHead(401).end('unauthorized');
      return;
    }

    if (url.pathname === '/ocs/v2.php/cloud/user') {
      ocs(res, { id: USER, 'display-name': 'Anna Beispiel' });
      return;
    }
    if (url.pathname === '/ocs/v2.php/cloud/capabilities') {
      ocs(res, { version: { string: '29.0.4' } });
      return;
    }
    if (url.pathname === '/ocs/v2.php/apps/notifications/api/v2/notifications') {
      if (req.method === 'DELETE') {
        state.deleted.push('alle');
        state.notifications = [];
        ocs(res, {});
        return;
      }
      state.calls += 1;
      ocs(res, state.notifications);
      return;
    }
    const single = url.pathname.match(/^\/ocs\/v2\.php\/apps\/notifications\/api\/v2\/notifications\/(\d+)$/);
    if (single && req.method === 'DELETE') {
      const id = Number(single[1]);
      state.deleted.push(id);
      state.notifications = state.notifications.filter(
        (entry) => entry['notification_id'] !== id,
      );
      ocs(res, {});
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const { port } = state.server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  return state;
}

/** Sammelt die Benachrichtigungs-Ereignisse, aus denen die Oberfläche Popups macht. */
function collectNotifications(): { popups: Array<Record<string, unknown>>; stop: () => void } {
  const popups: Array<Record<string, unknown>> = [];
  const off = events.on('notification', (payload) => {
    popups.push(payload as unknown as Record<string, unknown>);
  });
  return { popups, stop: off };
}

const household = (id: string): Household => ({
  id,
  name: 'Testhaushalt',
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  setupStep: 'done',
  setupCompletedAt: nowIso(),
  pollIntervalSeconds: 15,
  fritzboxUrl: '',
  pricePerKwh: 0.35,
  currency: 'EUR',
  basePricePerMonth: 0,
  autoUpdate: false,
  autoUpdateFrom: '03:00',
  autoUpdateTo: '05:00',
  appearance: { ...DEFAULT_APPEARANCE },
  presence: { ...DEFAULT_PRESENCE },
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

describe('Nextcloud verbinden und abholen', () => {
  let dir: string;
  let cloud: FakeCloud;
  let service: NextcloudService;
  let db: Database;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-nextcloud-'));
    cloud = await startFakeCloud();

    db = new Database(path.join(dir, 'db.json'));
    await db.load();
    await db.update((data) => {
      data.households.push(household('hh_1'));
    });
    service = new NextcloudService(createRepositories(db), 'testschluessel');
  });

  after(async () => {
    service.stop();
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('prüft die Zugangsdaten beim Verbinden und merkt sich den Anzeigenamen', async () => {
    cloud.notifications = [raw(7, { link: '/call/abc' })];
    const { popups, stop } = collectNotifications();

    const account = await service.connect('hh_1', {
      baseUrl: cloud.url,
      username: USER,
      appPassword: APP_PASSWORD,
    });
    stop();

    assert.equal(account.displayName, 'Anna Beispiel');
    assert.equal(account.serverVersion, '29.0.4');
    assert.equal(account.hasSecrets, true);
    assert.equal(account.lastError, null);
    // Der erste Abruf meldet nichts: Sonst poppen beim Verbinden alle alten
    // Benachrichtigungen auf einmal auf.
    assert.deepEqual(popups, []);
    assert.equal(account.lastNotificationId, 7);
  });

  it('speichert das App-Passwort nur verschlüsselt', () => {
    const stored = db.read().nextcloud[0];
    assert.ok(stored?.secretsEnc);
    assert.ok(!JSON.stringify(stored).includes(APP_PASSWORD));
    // Über die API geht das Feld gar nicht erst hinaus.
    const status = service.status('hh_1');
    assert.equal('secretsEnc' in (status.account as object), false);
    assert.equal(status.account?.hasSecrets, true);
  });

  it('meldet eine neue Benachrichtigung als Ereignis mit Verweis', async () => {
    cloud.notifications = [raw(8, { link: '/call/xyz', subject: 'Anna hat geschrieben' }), raw(7)];
    const { popups, stop } = collectNotifications();

    await service.refresh('hh_1');
    stop();

    assert.equal(popups.length, 1);
    assert.equal(popups[0]?.['message'], 'Talk: Anna hat geschrieben');
    assert.equal(popups[0]?.['link'], `${cloud.url}/call/xyz`);
    assert.equal(popups[0]?.['source'], 'nextcloud');
    assert.equal(popups[0]?.['householdId'], 'hh_1');
  });

  it('meldet dieselbe Benachrichtigung kein zweites Mal', async () => {
    const { popups, stop } = collectNotifications();
    await service.refresh('hh_1');
    stop();
    assert.deepEqual(popups, []);
  });

  it('gibt die offene Liste an die Oberfläche weiter', () => {
    const status = service.status('hh_1');
    assert.deepEqual(
      status.notifications.map((entry) => entry.id),
      [8, 7],
    );
  });

  it('markiert eine einzelne Benachrichtigung als gelesen', async () => {
    await service.dismiss('hh_1', 8);
    assert.deepEqual(cloud.deleted, [8]);
    assert.deepEqual(
      service.status('hh_1').notifications.map((entry) => entry.id),
      [7],
    );
  });

  it('markiert alle als gelesen', async () => {
    await service.dismissAll('hh_1');
    assert.equal(cloud.deleted.at(-1), 'alle');
    assert.deepEqual(service.status('hh_1').notifications, []);
  });

  it('erklärt ein falsches App-Passwort, ohne die Hub-Sitzung zu beenden', async () => {
    await assert.rejects(
      () =>
        service.connect('hh_1', {
          baseUrl: cloud.url,
          username: USER,
          appPassword: 'falsch',
        }),
      (err: Error & { status?: number; hint?: string }) => {
        assert.match(err.message, /Anmeldung abgelehnt/);
        assert.match(err.hint ?? '', /App-Passwort/);
        // 401 wäre falsch: Die Oberfläche wirft den Nutzer bei 401 zur
        // Anmeldemaske – abgelehnt hat aber die Nextcloud, nicht der Hub.
        assert.equal(err.status, 400);
        return true;
      },
    );
  });

  it('vermerkt einen fehlgeschlagenen Abruf am Konto', async () => {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
    await assert.rejects(() => service.refresh('hh_1'));
    assert.match(service.status('hh_1').account?.lastError ?? '', /.+/);
  });

  it('trennt die Verbindung samt Zugangsdaten', async () => {
    await service.disconnect('hh_1');
    assert.deepEqual(db.read().nextcloud, []);
    assert.equal(service.status('hh_1').account, null);
  });

  it('erklärt einen Abruf ohne verbundene Nextcloud', async () => {
    await assert.rejects(() => service.refresh('hh_1'), /keine Nextcloud verbunden/i);
  });
});
