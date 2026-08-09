/**
 * Was passiert, wenn etwas schiefgegangen ist.
 *
 * Drei Wege zurück werden hier geprüft:
 *
 * - Ein Gerät wurde nicht erkannt → aus seinen Werten erschließen, was es ist
 *   (`inferKind`), und notfalls von Hand richtigstellen (`effectiveDevice`).
 * - Der Hub ist veraltet → Fassungen vergleichen und das Änderungsprotokoll
 *   lesen (`compareVersions`, `parseChangelog`).
 * - Der Datenstand ist hin → Sicherung zurückspielen (`BackupService`).
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { inferKind } from '../src/adapters/homematic/mapping.ts';
import { setLogLevel } from '../src/core/logger.ts';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_PRESENCE,
  type Device,
  type Household,
  type Integration,
} from '../src/core/types.ts';
import { BackupService, parseBackup } from '../src/services/backupService.ts';
import {
  blockingChanges,
  compareVersions,
  HubUpdateService,
  parseChangelog,
} from '../src/services/hubUpdateService.ts';
import { Database } from '../src/storage/database.ts';
import { effectiveDevice } from '../src/storage/repositories.ts';

setLogLevel('silent');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------

describe('Unbekannte Kanäle aus ihren Werten erkennen', () => {
  it('erkennt einen Rollladen an Niveau und Fahrtrichtung', () => {
    // Genau der Fall, der bisher wortlos verschwand: ein Kanaltyp, den die
    // Namenstabelle nicht kennt, der aber eindeutig ein Antrieb ist.
    assert.equal(
      inferKind({ LEVEL: 0.4, DIRECTION: 0 }, 'HmIP-XYZ', 'IRGENDWAS_UNBEKANNT'),
      'cover',
    );
    assert.equal(inferKind({ LEVEL: 1, ACTIVITY_STATE: 0 }, '', ''), 'cover');
    assert.equal(inferKind({ LEVEL: 0.5, LEVEL_SLATS: 0.2 }, '', ''), 'cover');
  });

  it('erkennt eine Heizung an der Solltemperatur', () => {
    assert.equal(inferKind({ SET_POINT_TEMPERATURE: 21 }, '', ''), 'thermostat');
    assert.equal(inferKind({ SET_TEMPERATURE: 19.5 }, '', ''), 'thermostat');
  });

  it('unterscheidet Rollladen und Dimmer am Modellnamen, wenn nur LEVEL da ist', () => {
    assert.equal(inferKind({ LEVEL: 0.3 }, 'HmIP-BROLL', 'IRGENDWAS'), 'cover');
    assert.equal(inferKind({ LEVEL: 0.3 }, 'HM-LC-Bl1-FM', ''), 'cover');
    assert.equal(inferKind({ LEVEL: 0.3 }, 'HmIP-BDT', 'DIMMER'), 'dimmer');
    // Ohne jeden Anhaltspunkt: lieber Dimmer als falsch geratener Rollladen.
    assert.equal(inferKind({ LEVEL: 0.3 }, '', ''), 'dimmer');
  });

  it('macht aus einem booleschen STATE einen Schalter – außer bei Bewegung', () => {
    assert.equal(inferKind({ STATE: false }, 'HmIP-PS', 'SWITCH'), 'switch');
    assert.equal(inferKind({ STATE: true }, 'HM-Sec-MDIR', 'MOTION_DETECTOR'), 'motion');
    // Ein STATE, der keine Wahrheit ist, sagt nichts über die Gattung.
    assert.equal(inferKind({ STATE: 3 }, '', ''), null);
  });

  it('gibt auf, wenn nichts da ist, woraus sich etwas schließen ließe', () => {
    assert.equal(inferKind({}, 'HmIP-XYZ', 'MAINTENANCE'), null);
    assert.equal(inferKind({ IRGENDWAS: 1 }, '', ''), null);
  });
});

// ---------------------------------------------------------------------------

describe('Richtiggestellte Gerätetypen', () => {
  const base = (): Device => ({
    id: 'dev_1',
    householdId: 'hh_1',
    integrationId: 'int_1',
    roomId: null,
    externalId: 'x1',
    vendor: 'shelly',
    name: 'Rollladen Küche',
    manufacturer: null,
    model: null,
    firmware: null,
    capabilities: ['switch', 'sensor.power'],
    capabilityOverride: null,
    state: { updatedAt: '2026-08-08T10:00:00.000Z' },
    reachable: true,
    hidden: false,
    lastSeenAt: '2026-08-08T10:00:00.000Z',
    createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
  });

  it('lässt das Gerät in Ruhe, solange nichts richtiggestellt wurde', () => {
    const device = base();
    assert.equal(effectiveDevice(device), device, 'kein Umkopieren ohne Anlass');
  });

  it('setzt die Korrektur des Menschen über die Meldung des Geräts', () => {
    const device = { ...base(), capabilityOverride: ['cover', 'sensor.power'] as Device['capabilities'] };
    assert.deepEqual(effectiveDevice(device).capabilities, ['cover', 'sensor.power']);
  });

  it('behält beides: was gemeldet wurde und was der Mensch sagt', () => {
    // Ein Firmware-Update darf neue Fähigkeiten mitbringen, ohne die
    // Richtigstellung zu überschreiben – deshalb bleiben beide Listen stehen.
    const device = { ...base(), capabilityOverride: ['cover'] as Device['capabilities'] };
    const effective = effectiveDevice(device);
    assert.deepEqual(effective.capabilities, ['cover']);
    assert.deepEqual(device.capabilities, ['switch', 'sensor.power']);
  });

  it('nimmt eine leere Liste als „keine Korrektur"', () => {
    const device = { ...base(), capabilityOverride: [] as Device['capabilities'] };
    assert.deepEqual(effectiveDevice(device).capabilities, ['switch', 'sensor.power']);
  });
});

// ---------------------------------------------------------------------------

describe('Fassungen vergleichen', () => {
  it('vergleicht nach Zahlen, nicht nach Zeichen', () => {
    // Als Text wäre "1.10.0" kleiner als "1.9.0" – ein Fehler, der sich erst
    // beim zehnten Nebenversionssprung zeigt und dann schwer zu finden ist.
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
    assert.ok(compareVersions('1.2.9', '1.3.0') < 0);
  });

  it('verträgt ein führendes v und fehlende Stellen', () => {
    assert.equal(compareVersions('v1.3.0', '1.3.0'), 0);
    assert.equal(compareVersions('1.3', '1.3.0'), 0);
    assert.ok(compareVersions('1.3.1', '1.3') > 0);
  });
});

describe('Was einer Aktualisierung im Weg steht', () => {
  it('zählt geänderte verfolgte Dateien', () => {
    const porcelain = [' M src/index.ts', 'M  package.json', 'D  README.md'].join('\n');
    assert.deepEqual(blockingChanges(porcelain), ['src/index.ts', 'package.json', 'README.md']);
  });

  it('lässt Unverfolgtes durch', () => {
    /*
     * Der eigentliche Punkt dieser Funktion. `data/`, `.env` und
     * `node_modules/` sind auf jeder normalen Installation vorhanden und
     * unverfolgt; ein `git pull --ff-only` fasst sie nicht an. Die vorige
     * Fassung wertete jede Zeile als Hindernis und verweigerte damit
     * ausgerechnet dort die Aktualisierung, wo alles in Ordnung war.
     */
    const porcelain = ['?? data/', '?? .env', '?? node_modules/', '!! dist/'].join('\n');
    assert.deepEqual(blockingChanges(porcelain), []);
  });

  it('nimmt bei Umbenennungen den neuen Namen', () => {
    assert.deepEqual(blockingChanges('R  alt.ts -> neu.ts'), ['neu.ts']);
  });

  it('kommt mit leerer Ausgabe zurecht', () => {
    assert.deepEqual(blockingChanges(''), []);
    assert.deepEqual(blockingChanges('\n\n'), []);
  });
});

describe('Arbeitskopie nachholen', () => {
  let dir: string;
  let upstream: string;
  let install: string;

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sh-bootstrap-'));
    upstream = path.join(dir, 'upstream');
    install = path.join(dir, 'install');

    // Ein winziges „Repository" mit zwei Fassungen.
    await mkdir(path.join(upstream, 'src'), { recursive: true });
    await writeFile(path.join(upstream, 'src', 'index.js'), "console.log('alt')\n");
    await writeFile(path.join(upstream, '.gitignore'), 'data/\n.env\n');
    await git(upstream, 'init', '-q', '-b', 'main');
    await git(upstream, 'config', 'user.email', 'test@example.invalid');
    await git(upstream, 'config', 'user.name', 'Test');
    await git(upstream, 'add', '-A');
    await git(upstream, 'commit', '-qm', 'erste Fassung');
    await writeFile(path.join(upstream, 'src', 'index.js'), "console.log('neu')\n");
    await git(upstream, 'add', '-A');
    await git(upstream, 'commit', '-qm', 'zweite Fassung');

    // Eine Installation ohne `.git`: alter Quelltext, daneben die Daten.
    await mkdir(path.join(install, 'src'), { recursive: true });
    await mkdir(path.join(install, 'data'), { recursive: true });
    await writeFile(path.join(install, 'src', 'index.js'), "console.log('alt')\n");
    await writeFile(path.join(install, '.gitignore'), 'data/\n.env\n');
    await writeFile(path.join(install, 'data', 'smarthome.json'), '{"households":[]}\n');
    await writeFile(path.join(install, '.env'), 'SECRET_KEY=geheim\n');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('meldet „bootstrap", wenn keine Arbeitskopie da ist', async () => {
    const service = new HubUpdateService('1.0.0', {
      checkUrl: null,
      root: install,
      repoUrl: upstream,
      branch: 'main',
      dataDir: path.join(install, 'data'),
    });
    const info = await service.info();
    assert.equal(info.mode, 'bootstrap');
    assert.equal(info.canUpdate, true, 'fehlende Arbeitskopie ist kein Hindernis mehr');
    assert.match(String(info.reason), /holt sie sich/);
  });

  it('verweigert ohne hinterlegte Adresse – aber sagt, welche fehlt', async () => {
    const service = new HubUpdateService('1.0.0', {
      checkUrl: null,
      root: install,
      repoUrl: null,
    });
    const info = await service.info();
    assert.equal(info.mode, 'none');
    assert.equal(info.canUpdate, false);
    assert.match(String(info.reason), /HUB_REPO_URL/);
  });

  it('zieht den Quelltext und lässt die Daten liegen', async () => {
    const service = new HubUpdateService('1.0.0', {
      checkUrl: null,
      root: install,
      repoUrl: upstream,
      branch: 'main',
      dataDir: path.join(install, 'data'),
    });

    // `npm install` und `npm run build` gehören nicht in einen Test – geprüft
    // wird der Schritt, der die Daten gefährden könnte.
    await service.fetchSources();

    assert.equal(
      await readFile(path.join(install, 'src', 'index.js'), 'utf8'),
      "console.log('neu')\n",
      'der Quelltext ist die neue Fassung',
    );
    assert.equal(
      await readFile(path.join(install, 'data', 'smarthome.json'), 'utf8'),
      '{"households":[]}\n',
      'die Datenbank ist unangetastet',
    );
    assert.equal(
      await readFile(path.join(install, '.env'), 'utf8'),
      'SECRET_KEY=geheim\n',
      'der Schlüssel ist unangetastet',
    );

    // Und danach ist es eine gewöhnliche Arbeitskopie.
    const after = await service.info();
    assert.equal(after.mode, 'pull');
    assert.equal(after.canUpdate, true);
  });

  it('bricht ab, wenn die Daten unter einem Pfad des Quelltexts liegen', async () => {
    // `DATA_DIR=./src` wäre eine unglückliche, aber mögliche Einstellung –
    // und ein `checkout -f` würde die Datenbank überschreiben.
    const service = new HubUpdateService('1.0.0', {
      checkUrl: null,
      root: install,
      repoUrl: upstream,
      branch: 'main',
      dataDir: path.join(install, 'src'),
    });
    await assert.rejects(() => service.fetchSources(), /überschreiben/);
  });
});

describe('Änderungsprotokoll lesen', () => {
  const text = [
    '# Änderungen',
    '',
    'Vorwort, das keiner Fassung gehört.',
    '',
    '## 1.3.0 – 2026-08-08',
    '',
    '**Neu.** Etwas Nützliches.',
    '',
    '## 1.2.0 – 2026-08-07',
    '',
    'Kleinigkeiten.',
    '',
    '## v1.1.0',
    '',
    'Ohne Datum.',
    '',
  ].join('\n');

  it('zerlegt die Datei in Abschnitte, neueste zuerst', () => {
    const entries = parseChangelog(text);
    assert.deepEqual(
      entries.map((entry) => entry.version),
      ['1.3.0', '1.2.0', '1.1.0'],
    );
    assert.equal(entries[0]?.date, '2026-08-08');
    assert.equal(entries[0]?.body, '**Neu.** Etwas Nützliches.');
  });

  it('lässt das Vorwort weg – es gehört zu keiner Fassung', () => {
    const entries = parseChangelog(text);
    assert.ok(!entries.some((entry) => entry.body.includes('Vorwort')));
  });

  it('kommt ohne Datum aus', () => {
    const entry = parseChangelog(text).find((item) => item.version === '1.1.0');
    assert.equal(entry?.date, null);
    assert.equal(entry?.body, 'Ohne Datum.');
  });

  it('gibt bei einer Datei ohne Überschriften nichts zurück, statt zu raten', () => {
    assert.deepEqual(parseChangelog('Nur Fließtext.\n\nMehr Fließtext.'), []);
  });
});

// ---------------------------------------------------------------------------

describe('Sicherung und Wiederherstellung', () => {
  let dir: string;
  let db: Database;
  let backup: BackupService;

  const household = (id: string): Household => ({
    id,
    name: 'Zuhause',
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    setupStep: 'done',
    setupCompletedAt: '2026-08-08T10:00:00.000Z',
    pricePerKwh: 0.35,
    currency: 'EUR',
    basePricePerMonth: 12,
    autoUpdate: false,
    autoUpdateFrom: '03:00',
    autoUpdateTo: '05:00',
    appearance: { ...DEFAULT_APPEARANCE },
    presence: { ...DEFAULT_PRESENCE },
    createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
  });

  const integration = (id: string, host: string): Integration => ({
    id,
    householdId: 'hh_alt',
    type: 'hue',
    name: `Bridge ${host}`,
    config: { host, bridgeId: 'B1', apiVersion: '2' },
    secretsEnc: 'verschluesselt',
    status: 'linked',
    lastError: null,
    lastSeenAt: '2026-08-08T10:00:00.000Z',
    updateInfo: null,
    createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
  });

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sh-backup-'));
    db = new Database(path.join(dir, 'db.json'));
    await db.load();
    backup = new BackupService(db);

    await db.update((data) => {
      data.households = [household('hh_alt')];
      data.integrations = [integration('int_1', '192.168.1.5')];
      data.rooms = [
        {
          id: 'room_1',
          householdId: 'hh_alt',
          name: 'Küche',
          icon: 'kitchen',
          targetTemperatureC: null,
          sortOrder: 0,
          createdAt: '2026-08-08T10:00:00.000Z',
          updatedAt: '2026-08-08T10:00:00.000Z',
        },
      ];
      data.users = [
        {
          id: 'usr_1',
          householdId: 'hh_alt',
          username: 'anna',
          displayName: 'Anna',
          passwordHash: 'egal',
          role: 'admin',
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: null,
          createdAt: '2026-08-08T10:00:00.000Z',
          updatedAt: '2026-08-08T10:00:00.000Z',
        },
      ];
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('nimmt keine Zugangsdaten mit in die Datei', () => {
    const file = backup.export('hh_alt');
    const serialized = JSON.stringify(file);
    assert.ok(!serialized.includes('verschluesselt'), 'keine Bridge-Zugangsdaten');
    assert.ok(!serialized.includes('passwordHash'), 'keine Passwörter');
    assert.ok(!serialized.includes('anna'), 'keine Benutzerkonten');
    assert.equal(file.rooms.length, 1);
    assert.equal(file.integrations.length, 1);
  });

  it('erkennt eine fremde Datei an ihrer Kennung', () => {
    assert.throws(() => parseBackup({ hallo: 'welt' }), /nicht von diesem Hub/);
    assert.throws(() => parseBackup(null), /keine Sicherungsdatei/);
    assert.throws(
      () => parseBackup({ format: 'smarthome-hub-backup', version: 99, household: {} }),
      /neueren Fassung/,
    );
  });

  it('behält beim Zurückspielen die Zugangsdaten derselben Bridge', async () => {
    const file = backup.export('hh_alt');
    // Zwischendurch wird alles kaputtgemacht – bis auf die Verbindung selbst.
    await db.update((data) => {
      data.rooms = [];
    });

    const result = await backup.restore(file);
    assert.equal(result.rooms, 1);
    assert.deepEqual(result.needRelink, [], 'dieselbe Bridge bleibt verbunden');
    assert.equal(db.read().integrations[0]?.secretsEnc, 'verschluesselt');
    assert.equal(db.read().integrations[0]?.status, 'linked');
  });

  it('meldet ehrlich, welche Verbindung nach dem Umzug neu herzustellen ist', async () => {
    const file = backup.export('hh_alt');
    // Ein anderer Hub: dieselbe Sicherung, aber eine Bridge unter anderer Adresse.
    await db.update((data) => {
      data.integrations = [integration('int_1', '10.0.0.9')];
    });

    const result = await backup.restore(file);
    assert.deepEqual(result.needRelink, ['Bridge 192.168.1.5']);
    assert.equal(db.read().integrations[0]?.secretsEnc, null);
    assert.equal(db.read().integrations[0]?.status, 'pending');
    assert.match(String(db.read().integrations[0]?.lastError), /Erneut verbinden/);
  });

  it('sperrt niemanden aus: Benutzerkonten überleben die Wiederherstellung', async () => {
    const file = backup.export('hh_alt');
    // Der laufende Hub hat einen anderen Haushalt – so sieht es nach einer
    // Neuinstallation aus, an der schon jemand angemeldet ist.
    await db.update((data) => {
      data.households = [household('hh_neu')];
      data.users = data.users.map((user) => ({ ...user, householdId: 'hh_neu' }));
    });

    await backup.restore(file);

    const data = db.read();
    assert.equal(data.users.length, 1, 'Benutzer bleiben unangetastet');
    assert.equal(data.households[0]?.id, 'hh_neu', 'der laufende Haushalt behält seine ID');
    assert.equal(data.users[0]?.householdId, 'hh_neu');
    assert.equal(
      data.rooms[0]?.householdId,
      'hh_neu',
      'die zurückgespielten Räume ziehen mit um',
    );
  });
});
