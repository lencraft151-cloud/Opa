import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { createContainer, type Container } from '../src/container.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { createApp } from '../src/server/app.ts';

setLogLevel('silent');

let dir: string;
let container: Container;
let server: Server;
let baseUrl: string;
/** Sitzungs-Cookie der angemeldeten Testperson. */
let cookie = '';
/** Zugriffstoken für den Programm-Zugang. */
let token = '';

function testConfig(dataDir: string): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    databaseFile: path.join(dataDir, 'db.json'),
    telemetryDir: path.join(dataDir, 'telemetry'),
    secretKey: 'test-secret-key',
    authDisabled: false,
    pollIntervalSeconds: 3600,
    telemetryRetentionDays: 7,
    telemetryMinIntervalSeconds: 0,
    allowCloudDiscovery: false,
    discoveryTimeoutMs: 500,
    hubUpdateCheckUrl: null,
    hubRepoUrl: null,
    hubBranch: 'main',
    logLevel: 'silent',
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  withAuth = true,
): Promise<{ status: number; data: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (withAuth && cookie) headers['cookie'] = cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Der Hub schickt die Sitzung als Cookie – wie ein Browser merken wir sie uns.
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const value = setCookie.split(';')[0] as string;
    if (value.endsWith('=')) cookie = '';
    else cookie = value;
  }

  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

/** Aufruf mit Zugriffstoken statt Sitzung – der Weg für Programme. */
async function callWithToken(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'smarthome-api-'));
  container = await createContainer(testConfig(dir));
  const app = createApp(container);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await container.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('Einrichtung über die API', () => {
  it('meldet einen leeren Hub', async () => {
    const { status, data } = await call('GET', '/api/setup/state');
    assert.equal(status, 200);
    assert.equal(data.hasHousehold, false);
    assert.equal(data.currentStep, 'household');
    assert.equal(data.steps.length, 5);
  });

  it('erlaubt den Systemstatus ohne Token', async () => {
    const { status, data } = await call('GET', '/api/system/info', undefined, false);
    assert.equal(status, 200);
    assert.deepEqual(
      data.adapters.map((adapter: { type: string }) => adapter.type).sort(),
      ['fritzbox', 'homematic', 'hue', 'shelly'],
    );
  });

  it('nennt eine Kennung der ausgelieferten Oberfläche', async () => {
    // Daran erkennt die Weboberfläche, dass sie sich neu laden sollte.
    const first = await call('GET', '/api/system/info', undefined, false);
    assert.match(first.data.build, /^[0-9a-f]{12}$/);
    const second = await call('GET', '/api/system/info', undefined, false);
    assert.equal(second.data.build, first.data.build, 'gleicher Stand, gleiche Kennung');
  });

  it('legt Haushalt und erstes Benutzerkonto an', async () => {
    const { status, data, headers } = await call('POST', '/api/setup/household', {
      name: 'Testhaushalt',
      timezone: 'Europe/Berlin',
      pricePerKwh: 0.42,
      username: 'Anna',
      password: 'drei zufaellige woerter',
      displayName: 'Anna',
    });
    assert.equal(status, 201);
    assert.equal(data.household.name, 'Testhaushalt');
    assert.equal(data.state.currentStep, 'integrations');
    assert.equal(data.household.pricePerKwh, 0.42, 'der eingegebene Strompreis wird übernommen');

    // Der erste Mensch am Hub ist immer Administrator.
    assert.equal(data.user.username, 'anna', 'Anmeldenamen werden klein geschrieben');
    assert.equal(data.user.role, 'admin');
    assert.equal(data.accessToken, undefined, 'kein Token mehr im Bogen');

    // Und er ist direkt angemeldet – als HttpOnly-Cookie.
    const setCookie = headers.get('set-cookie') ?? '';
    assert.match(setCookie, /sh_session=ss_/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });

  it('weist ein zu kurzes Passwort ab, bevor der Haushalt entsteht', async () => {
    // Der Haushalt existiert schon – hier geht es um die Prüfung an sich.
    const { status, data } = await call('POST', '/api/auth/users', {
      username: 'kurz',
      password: 'abc',
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(data), /mindestens 10 Zeichen|zu kurz/i);
  });

  it('setzt sinnvolle Voreinstellungen', async () => {
    const { data } = await call('GET', '/api/household');
    assert.equal(data.currency, 'EUR');
    assert.equal(data.autoUpdate, false);
    assert.equal(data.autoUpdateFrom, '03:00');
  });

  it('lehnt einen zweiten Haushalt ab', async () => {
    const { status, data } = await call('POST', '/api/setup/household', {
      name: 'Zweiter',
      username: 'zweiter',
      password: 'drei zufaellige woerter',
    });
    assert.equal(status, 409);
    assert.equal(data.error.code, 'conflict');
  });

  it('verlangt ab jetzt eine Anmeldung', async () => {
    const { status, data } = await call('GET', '/api/household', undefined, false);
    assert.equal(status, 401);
    assert.equal(data.error.code, 'unauthorized');
  });

  it('lässt die angemeldete Sitzung durch', async () => {
    const { status, data } = await call('GET', '/api/household');
    assert.equal(status, 200);
    assert.equal(data.name, 'Testhaushalt');
  });

  it('weist ein gefälschtes Token ab', async () => {
    const response = await fetch(`${baseUrl}/api/household`, {
      headers: { authorization: 'Bearer sh_faelschung' },
    });
    assert.equal(response.status, 401);
  });

  it('hält Health, Systeminfo und Setup-Status auch danach offen', async () => {
    // Diese drei Endpunkte muss die Oberfläche vor dem Login abfragen können.
    for (const path of ['/api/health', '/api/system/info', '/api/setup/state']) {
      const { status } = await call('GET', path, undefined, false);
      assert.equal(status, 200, `${path} muss ohne Token erreichbar sein`);
    }
  });

  it('erlaubt den Ereignisstrom mit dem Sitzungs-Cookie', async () => {
    // `EventSource` kann keine Header setzen – das Cookie reist von selbst mit.
    const response = await fetch(`${baseUrl}/api/household`, { headers: { cookie } });
    assert.equal(response.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

describe('Anmeldung mit Name und Passwort', () => {
  it('sagt, wer angemeldet ist', async () => {
    const { data } = await call('GET', '/api/auth/me');
    assert.equal(data.user.username, 'anna');
    assert.equal(data.user.role, 'admin');
    assert.equal(data.userCount, 1);
  });

  it('nennt weder Name noch Passwort als den falschen Teil', async () => {
    // Sonst ließe sich mit der Anmeldemaske herausfinden, welche Konten es gibt.
    const wrongUser = await call('POST', '/api/auth/login', {
      username: 'gibtesnicht',
      password: 'irgendwas1234',
    });
    const wrongPassword = await call('POST', '/api/auth/login', {
      username: 'anna',
      password: 'falsches passwort',
    });
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongUser.data.error.message, wrongPassword.data.error.message);
  });

  it('meldet mit richtigen Angaben an und setzt ein Cookie', async () => {
    const { status, data, headers } = await call('POST', '/api/auth/login', {
      username: 'anna',
      password: 'drei zufaellige woerter',
    });
    assert.equal(status, 200);
    assert.equal(data.user.username, 'anna');
    assert.match(headers.get('set-cookie') ?? '', /sh_session=ss_/);
  });

  it('legt eine zweite Person an und trennt die Rollen', async () => {
    const created = await call('POST', '/api/auth/users', {
      username: 'ben',
      password: 'noch drei woerter',
      displayName: 'Ben',
      role: 'member',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.role, 'member');

    const list = await call('GET', '/api/auth/users');
    assert.deepEqual(
      list.data.map((user: { username: string }) => user.username).sort(),
      ['anna', 'ben'],
    );
  });

  it('lehnt denselben Anmeldenamen ein zweites Mal ab', async () => {
    const { status, data } = await call('POST', '/api/auth/users', {
      username: 'BEN',
      password: 'wieder drei woerter',
    });
    assert.equal(status, 409);
    assert.match(data.error.message, /gibt es schon/);
  });

  it('prüft den Anmeldenamen auf brauchbare Zeichen', async () => {
    const { status, data } = await call('POST', '/api/auth/users', {
      username: 'anna müller',
      password: 'drei ganz andere woerter',
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(data), /Buchstaben|erlaubt/);
  });

  it('führt Sitzungen und beendet sie einzeln', async () => {
    const sessions = await call('GET', '/api/auth/sessions');
    assert.ok(sessions.data.length >= 1);
    assert.equal(
      sessions.data.filter((session: { current: boolean }) => session.current).length,
      1,
      'genau eine Sitzung ist die eigene',
    );
  });

  it('lässt das eigene Passwort nur mit dem bisherigen ändern', async () => {
    const wrong = await call('POST', '/api/auth/password', {
      currentPassword: 'stimmt nicht',
      newPassword: 'ein ganz neues passwort',
    });
    assert.equal(wrong.status, 401);

    const right = await call('POST', '/api/auth/password', {
      currentPassword: 'drei zufaellige woerter',
      newPassword: 'ein ganz neues passwort',
    });
    assert.equal(right.status, 200);

    // Zurück zum bekannten Passwort, damit die folgenden Tests weiterlaufen.
    await call('POST', '/api/auth/password', {
      currentPassword: 'ein ganz neues passwort',
      newPassword: 'drei zufaellige woerter',
    });
  });

  it('lässt den letzten Administrator nicht entfernen', async () => {
    const users = await call('GET', '/api/auth/users');
    const ben = users.data.find((user: { username: string }) => user.username === 'ben');
    await call('PATCH', `/api/auth/users/${ben.id}`, { role: 'member' });

    const me = await call('GET', '/api/auth/me');
    const removeSelf = await call('DELETE', `/api/auth/users/${me.data.user.id}`);
    assert.equal(removeSelf.status, 409);
    assert.match(removeSelf.data.error.message, /eigene Konto/);
  });
});

describe('Räume', () => {
  let roomId = '';

  it('legt einen Raum an', async () => {
    const { status, data } = await call('POST', '/api/rooms', { name: 'Wohnzimmer' });
    assert.equal(status, 201);
    assert.equal(data.name, 'Wohnzimmer');
    roomId = data.id;
  });

  it('verhindert doppelte Raumnamen', async () => {
    const { status } = await call('POST', '/api/rooms', { name: 'wohnzimmer' });
    assert.equal(status, 409);
  });

  it('liefert Räume inklusive Klimawerten', async () => {
    const { status, data } = await call('GET', '/api/rooms');
    assert.equal(status, 200);
    assert.equal(data.length, 1);
    assert.equal(data[0].deviceCount, 0);
    assert.equal(data[0].climate.temperatureC, null);
  });

  it('ändert einen Raum', async () => {
    const { status, data } = await call('PATCH', `/api/rooms/${roomId}`, {
      name: 'Wohnzimmer',
      targetTemperatureC: 21.5,
    });
    assert.equal(status, 200);
    assert.equal(data.targetTemperatureC, 21.5);
  });

  it('meldet unbekannte Räume mit 404', async () => {
    const { status, data } = await call('GET', '/api/rooms/room_gibtesnicht');
    assert.equal(status, 404);
    assert.equal(data.error.code, 'not_found');
  });

  it('prüft die Eingaben', async () => {
    const { status, data } = await call('POST', '/api/rooms', { name: '' });
    assert.equal(status, 400);
    assert.equal(data.error.code, 'bad_request');
    assert.ok(Array.isArray(data.error.details));
  });
});

describe('Geräte und Abschluss', () => {
  it('liefert eine leere Geräteliste', async () => {
    const { status, data } = await call('GET', '/api/devices');
    assert.equal(status, 200);
    assert.deepEqual(data, []);
  });

  it('liefert eine Zusammenfassung für das Dashboard', async () => {
    const { status, data } = await call('GET', '/api/household/summary');
    assert.equal(status, 200);
    assert.equal(data.total, 0);
    assert.equal(data.rooms, 1);
    assert.equal(data.averageTemperatureC, null);
  });

  it('verweigert den Abschluss ohne verbundene Integration', async () => {
    const { status, data } = await call('POST', '/api/setup/complete');
    assert.equal(status, 400);
    assert.match(data.error.message, /mindestens eine/i);
  });

  it('lehnt Kommandos an unbekannte Geräte ab', async () => {
    const { status } = await call('POST', '/api/devices/dev_unbekannt/command', {
      type: 'setPower',
      on: true,
    });
    assert.equal(status, 404);
  });

  it('lehnt unbekannte Kommandotypen ab', async () => {
    const { status } = await call('POST', '/api/devices/dev_x/command', { type: 'explodieren' });
    assert.equal(status, 400);
  });
});

describe('Automationen', () => {
  it('lehnt Regeln mit unbekannten Geräten ab', async () => {
    const { status, data } = await call('POST', '/api/automations', {
      name: 'Kaputt',
      trigger: {
        type: 'sensor',
        deviceId: 'dev_gibtesnicht',
        metric: 'temperatureC',
        operator: '<',
        value: 19,
      },
      actions: [
        { type: 'notify', message: 'zu kalt' },
      ],
    });
    assert.equal(status, 400);
    assert.match(data.error.message, /gehört nicht zu diesem Haushalt/);
  });

  it('legt eine Regel mit Zeitplan an und führt sie testweise aus', async () => {
    const created = await call('POST', '/api/automations', {
      name: 'Abendmeldung',
      trigger: { type: 'schedule', at: '20:00', days: [1, 2, 3, 4, 5] },
      actions: [{ type: 'notify', message: 'Guten Abend' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.enabled, true);

    const run = await call('POST', `/api/automations/${created.data.id}/run`);
    assert.equal(run.status, 200);
    assert.equal(run.data.executed, 1);

    const removed = await call('DELETE', `/api/automations/${created.data.id}`);
    assert.equal(removed.status, 204);
  });

  it('prüft das Uhrzeitformat', async () => {
    const { status } = await call('POST', '/api/automations', {
      name: 'Falsche Zeit',
      trigger: { type: 'schedule', at: '25:99', days: [] },
      actions: [{ type: 'notify', message: 'x' }],
    });
    assert.equal(status, 400);
  });

  it('legt eine wiederkehrende Regel mit Zeitfenster an', async () => {
    const created = await call('POST', '/api/automations', {
      name: 'Stündlich lüften erinnern',
      trigger: {
        type: 'interval',
        everyMinutes: 120,
        from: '08:00',
        to: '20:00',
        days: [1, 2, 3, 4, 5],
      },
      actions: [{ type: 'notify', message: 'Fenster auf' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.trigger.everyMinutes, 120);
    assert.equal(created.data.trigger.from, '08:00');

    await call('DELETE', `/api/automations/${created.data.id}`);
  });

  it('lehnt einen zu kurzen Takt ab', async () => {
    // Unter fünf Minuten wäre nur Last ohne Nutzen.
    const { status } = await call('POST', '/api/automations', {
      name: 'Zu hektisch',
      trigger: { type: 'interval', everyMinutes: 1 },
      actions: [{ type: 'notify', message: 'x' }],
    });
    assert.equal(status, 400);
  });
});

describe('Darstellung', () => {
  it('liefert Voreinstellungen, solange nichts gewählt wurde', async () => {
    const { data } = await call('GET', '/api/household');
    assert.deepEqual(data.appearance, {
      fontScale: 1,
      accentColor: null,
      accentColorAlt: null,
      theme: 'auto',
      reduceMotion: false,
      // Die Lichtvorschau ist vorgabemäßig an – sie schließt die Lücke
      // zwischen „Regler bewegen" und „Lampe reagiert".
      livePreview: true,
    });
  });

  it('speichert Schriftgröße und Akzentfarbe', async () => {
    const { status, data } = await call('PATCH', '/api/household', {
      appearance: { fontScale: 1.3, accentColor: '#1F8A4C' },
    });
    assert.equal(status, 200);
    assert.equal(data.appearance.fontScale, 1.3);
    assert.equal(data.appearance.accentColor, '#1f8a4c', 'Farben werden vereinheitlicht');
  });

  it('lässt bereits gesetzte Werte stehen, wenn nur eines geändert wird', async () => {
    const { data } = await call('PATCH', '/api/household', { appearance: { theme: 'dark' } });
    assert.equal(data.appearance.theme, 'dark');
    assert.equal(data.appearance.fontScale, 1.3, 'die Schriftgröße bleibt erhalten');
    assert.equal(data.appearance.accentColor, '#1f8a4c');
  });

  it('nimmt „keine eigene Farbe" als bewusste Wahl an', async () => {
    const { data } = await call('PATCH', '/api/household', {
      appearance: { accentColor: null },
    });
    assert.equal(data.appearance.accentColor, null);
  });

  it('weist unmögliche Werte mit einer verständlichen Meldung ab', async () => {
    const tooBig = await call('PATCH', '/api/household', { appearance: { fontScale: 4 } });
    assert.equal(tooBig.status, 400);

    const noColor = await call('PATCH', '/api/household', {
      appearance: { accentColor: 'knallrot' },
    });
    assert.equal(noColor.status, 400);
    assert.match(JSON.stringify(noColor.data), /rrggbb/);

    const unknown = await call('PATCH', '/api/household', { appearance: { glitzer: true } });
    assert.equal(unknown.status, 400);
  });

  it('setzt die Darstellung wieder zurück', async () => {
    const { data } = await call('PATCH', '/api/household', {
      appearance: {
        fontScale: 1,
        accentColor: null,
        accentColorAlt: null,
        theme: 'auto',
        reduceMotion: false,
        livePreview: true,
      },
    });
    assert.equal(data.appearance.fontScale, 1);
    assert.equal(data.appearance.theme, 'auto');
  });
});

describe('Zugriffstoken für Programme', () => {
  it('legt beim Einrichten von selbst keines mehr an', async () => {
    // Menschen melden sich an – ein Token braucht nur, wer ein Skript schreibt.
    const list = await call('GET', '/api/household/tokens');
    assert.deepEqual(list.data, []);
  });

  it('erstellt eines und gibt es genau einmal aus', async () => {
    const created = await call('POST', '/api/household/tokens', { name: 'Backup-Skript' });
    assert.equal(created.status, 201);
    assert.ok(created.data.accessToken.startsWith('sh_'));
    token = created.data.accessToken;

    const list = await call('GET', '/api/household/tokens');
    assert.equal(list.data.length, 1);
    assert.ok(
      list.data.every((entry: Record<string, unknown>) => !('tokenHash' in entry)),
      'der Hash bleibt im Hub',
    );
  });

  it('lässt ein Programm damit lesen und schalten', async () => {
    const { status, data } = await callWithToken('GET', '/api/devices');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('reicht aber nicht für die Benutzerverwaltung', async () => {
    // Ein Token gehört einem Programm, nicht einer Person – es hat keine Rolle.
    const { status, data } = await callWithToken('POST', '/api/auth/users', {
      username: 'skript',
      password: 'drei zufaellige woerter',
    });
    assert.equal(status, 401);
    assert.match(JSON.stringify(data), /Person|Anmeldung/);
  });

  it('lässt sich widerrufen – auch das letzte', async () => {
    // Früher war das gesperrt, weil man sich sonst aussperrte. Seit es eine
    // Anmeldung gibt, kann das nicht mehr passieren.
    const list = await call('GET', '/api/household/tokens');
    const { status } = await call('DELETE', `/api/household/tokens/${list.data[0].id}`);
    assert.equal(status, 204);

    const after = await call('GET', '/api/household/tokens');
    assert.deepEqual(after.data, []);
  });

  it('weist ein widerrufenes Token ab', async () => {
    const { status } = await callWithToken('GET', '/api/devices');
    assert.equal(status, 401);
  });
});

describe('Stromverbrauch', () => {
  it('liefert eine Auswertung auch ohne Messwerte', async () => {
    const { status, data } = await call('GET', '/api/energy/summary?period=today');
    assert.equal(status, 200);
    assert.equal(data.totalKwh, 0);
    assert.equal(data.currency, 'EUR');
    assert.equal(data.period.label, 'Heute');
    assert.deepEqual(data.devices, []);
    assert.equal(data.projection, null, 'ohne Messwerte wird nichts hochgerechnet');
    assert.equal(data.coverage, 0);
  });

  it('kennt alle Zeiträume', async () => {
    for (const period of ['today', 'yesterday', 'week', 'month', 'year']) {
      const { status, data } = await call('GET', `/api/energy/summary?period=${period}`);
      assert.equal(status, 200, period);
      assert.equal(data.period.key, period);
    }
  });

  it('weist unbekannte Zeiträume ab', async () => {
    const { status, data } = await call('GET', '/api/energy/summary?period=jahrhundert');
    assert.equal(status, 400);
    assert.ok(data.error.hint, 'auch Parameterfehler bekommen einen Hinweis');
  });

  it('übernimmt einen geänderten Strompreis in die Kostenrechnung', async () => {
    const patched = await call('PATCH', '/api/household', { pricePerKwh: 0.5, currency: 'CHF' });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.pricePerKwh, 0.5);

    const { data } = await call('GET', '/api/energy/summary?period=today');
    assert.equal(data.pricePerKwh, 0.5);
    assert.equal(data.currency, 'CHF');

    await call('PATCH', '/api/household', { pricePerKwh: 0.35, currency: 'EUR' });
  });

  it('lehnt negative Strompreise mit einem Hinweis ab', async () => {
    const { status, data } = await call('PATCH', '/api/household', { pricePerKwh: -1 });
    assert.equal(status, 400);
    assert.ok(data.error.message.length > 0);
  });
});

describe('Firmware-Updates', () => {
  it('liefert eine Übersicht mit den Auto-Update-Einstellungen', async () => {
    const { status, data } = await call('GET', '/api/updates');
    assert.equal(status, 200);
    assert.equal(data.updatesAvailable, 0);
    assert.equal(data.autoUpdate.enabled, false);
    assert.equal(data.autoUpdate.from, '03:00');
    assert.deepEqual(data.integrations, []);
  });

  it('schaltet die automatische Installation ein', async () => {
    const { status, data } = await call('PATCH', '/api/household', {
      autoUpdate: true,
      autoUpdateFrom: '02:30',
      autoUpdateTo: '04:30',
    });
    assert.equal(status, 200);
    assert.equal(data.autoUpdate, true);

    const overview = await call('GET', '/api/updates');
    assert.equal(overview.data.autoUpdate.enabled, true);
    assert.equal(overview.data.autoUpdate.from, '02:30');
  });

  it('lehnt ein leeres Zeitfenster ab', async () => {
    const { status, data } = await call('PATCH', '/api/household', {
      autoUpdateFrom: '03:00',
      autoUpdateTo: '03:00',
    });
    assert.equal(status, 400);
    assert.match(data.error.hint ?? '', /unterscheiden/);
  });

  it('prüft das Uhrzeitformat', async () => {
    const { status } = await call('PATCH', '/api/household', { autoUpdateFrom: '25:99' });
    assert.equal(status, 400);
  });

  it('meldet unbekannte Integrationen mit 404', async () => {
    const { status } = await call('POST', '/api/updates/int_gibtesnicht/check');
    assert.equal(status, 404);
  });
});

describe('Rollladen-Kommandos', () => {
  it('akzeptiert die neuen Kommandotypen im Schema', async () => {
    // Ohne Gerät scheitert es an der ID, nicht an der Validierung.
    for (const command of [
      { type: 'openCover' },
      { type: 'closeCover' },
      { type: 'stopCover' },
      { type: 'setTilt', tilt: 40 },
      { type: 'setPosition', position: 80 },
    ]) {
      const { status } = await call('POST', '/api/devices/dev_unbekannt/command', command);
      assert.equal(status, 404, `${command.type} muss die Validierung passieren`);
    }
  });

  it('weist ungültige Werte ab', async () => {
    const tooHigh = await call('POST', '/api/devices/dev_x/command', { type: 'setTilt', tilt: 300 });
    assert.equal(tooHigh.status, 400);
    const missing = await call('POST', '/api/devices/dev_x/command', { type: 'setPosition' });
    assert.equal(missing.status, 400);
  });
});

describe('Fehlerbehandlung', () => {
  it('meldet unbekannte API-Routen mit 404', async () => {
    const { status, data } = await call('GET', '/api/gibtesnicht');
    assert.equal(status, 404);
    assert.equal(data.error.code, 'not_found');
  });

  it('meldet kaputtes JSON verständlich', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{kein json',
    });
    assert.equal(response.status, 400);
    const data = (await response.json()) as { error: { message: string; hint?: string } };
    assert.match(data.error.message, /JSON/);
    assert.ok(data.error.hint, 'auch der JSON-Fehler bekommt einen Hinweis');
  });
});
