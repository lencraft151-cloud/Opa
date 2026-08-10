/**
 * Wo die Daten liegen – und warum das die Bedingung dafür ist, den Hub
 * aktualisieren zu können, ohne ihn neu einzurichten.
 *
 * Geprüft wird genau das, was sonst erst nach dem nächsten Update auffällt:
 * dass eine ausdrückliche Angabe gewinnt, dass ein alter Bestand mitkommt,
 * dass der Schlüssel bleibt, wo die Daten sind – und dass ein misslungener
 * Umzug den Hub nicht am Starten hindert.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultDataDir, loadOrCreateSecretKey, resolveDataDir } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';

setLogLevel('silent');

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'smarthome-datadir-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Führt etwas mit gesetzten Umgebungsvariablen aus und räumt danach auf. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Vorgabeort der Daten', () => {
  it('liegt außerhalb der Arbeitskopie', () => {
    const place = withEnv({ XDG_DATA_HOME: undefined }, () => defaultDataDir());
    // Der ganze Zweck: Was hier liegt, wird beim Aktualisieren nicht
    // ausgetauscht.
    assert.ok(!place.startsWith(process.cwd()), `${place} liegt im Projektordner`);
    assert.match(place, /smarthome-hub$/);
  });

  it('folgt XDG_DATA_HOME, wenn gesetzt', function (t) {
    if (process.platform !== 'linux') return t.skip('nur unter Linux');
    const place = withEnv({ XDG_DATA_HOME: '/eigener/ort' }, () => defaultDataDir());
    assert.equal(place, path.join('/eigener/ort', 'smarthome-hub'));
  });
});

describe('Datenordner bestimmen', () => {
  it('nimmt DATA_DIR, wenn es gesetzt ist', () => {
    const wanted = path.join(dir, 'eigener-ort');
    const result = withEnv({ DATA_DIR: wanted }, () => resolveDataDir(dir));
    assert.equal(result.dir, wanted);
    assert.equal(result.movedFrom, null);
  });

  it('lässt einen selbst gewählten Ort in Ruhe, auch wenn daneben ein alter liegt', () => {
    // Wer den Ort bestimmt hat (Docker-Volume, eigene Platte), soll nicht
    // umgezogen werden – auch nicht gut gemeint.
    const cwd = path.join(dir, 'projekt-mit-alt');
    mkdirSync(path.join(cwd, 'data'), { recursive: true });
    writeFileSync(path.join(cwd, 'data', 'smarthome.json'), '{"version":1}');

    const wanted = path.join(dir, 'volume');
    const result = withEnv({ DATA_DIR: wanted }, () => resolveDataDir(cwd));

    assert.equal(result.dir, wanted);
    assert.ok(existsSync(path.join(cwd, 'data', 'smarthome.json')), 'der alte Ordner bleibt');
  });

  it('holt einen alten Bestand aus dem Projektordner nach', () => {
    const cwd = path.join(dir, 'projekt-umzug');
    const ziel = path.join(dir, 'ziel-umzug');
    mkdirSync(path.join(cwd, 'data', 'telemetry'), { recursive: true });
    writeFileSync(path.join(cwd, 'data', 'smarthome.json'), '{"version":1,"households":[]}');
    writeFileSync(path.join(cwd, 'data', 'telemetry', 'messwerte.jsonl'), '{"t":"x"}\n');

    const result = withEnv({ DATA_DIR: undefined, XDG_DATA_HOME: ziel }, () =>
      resolveDataDir(cwd),
    );

    const erwartet = path.join(ziel, 'smarthome-hub');
    assert.equal(result.dir, erwartet);
    assert.equal(result.movedFrom, path.join(cwd, 'data'));
    assert.match(result.note ?? '', /umgezogen/);

    // Alles ist mitgekommen – Datenbank *und* Messwerte.
    assert.ok(existsSync(path.join(erwartet, 'smarthome.json')));
    assert.ok(existsSync(path.join(erwartet, 'telemetry', 'messwerte.jsonl')));
    assert.equal(existsSync(path.join(cwd, 'data')), false, 'im Projektordner bleibt nichts');
  });

  it('rührt den alten Ordner nicht an, wenn am neuen Ort schon Daten liegen', () => {
    // Sonst überschriebe ein vergessener Rest im Projektordner den echten
    // Bestand – der Fehler wäre nicht rückgängig zu machen.
    const cwd = path.join(dir, 'projekt-beide');
    const ziel = path.join(dir, 'ziel-beide');
    mkdirSync(path.join(cwd, 'data'), { recursive: true });
    writeFileSync(path.join(cwd, 'data', 'smarthome.json'), '{"alt":true}');
    mkdirSync(path.join(ziel, 'smarthome-hub'), { recursive: true });
    writeFileSync(path.join(ziel, 'smarthome-hub', 'smarthome.json'), '{"neu":true}');

    const result = withEnv({ DATA_DIR: undefined, XDG_DATA_HOME: ziel }, () =>
      resolveDataDir(cwd),
    );

    assert.equal(result.movedFrom, null);
    assert.equal(
      readFileSync(path.join(ziel, 'smarthome-hub', 'smarthome.json'), 'utf8'),
      '{"neu":true}',
    );
    assert.ok(existsSync(path.join(cwd, 'data', 'smarthome.json')));
  });

  it('nimmt einen leeren Projektordner nicht für einen Bestand', () => {
    const cwd = path.join(dir, 'projekt-leer');
    const ziel = path.join(dir, 'ziel-leer');
    mkdirSync(path.join(cwd, 'data'), { recursive: true });

    const result = withEnv({ DATA_DIR: undefined, XDG_DATA_HOME: ziel }, () =>
      resolveDataDir(cwd),
    );
    assert.equal(result.dir, path.join(ziel, 'smarthome-hub'));
    assert.equal(result.movedFrom, null);
  });

  it('läuft weiter, wenn der Umzug scheitert', () => {
    // Ein Hub, der wegen eines misslungenen Umzugs gar nicht startet, wäre
    // die schlechtere Antwort. Er sagt es und arbeitet am alten Ort weiter.
    const cwd = path.join(dir, 'projekt-gesperrt');
    mkdirSync(path.join(cwd, 'data'), { recursive: true });
    writeFileSync(path.join(cwd, 'data', 'smarthome.json'), '{"version":1}');

    /*
     * Der Weg wird durch eine *Datei* versperrt, nicht durch Dateirechte:
     * Rechte umgeht der Systemverwalter, und dann prüfte der Test nichts.
     * Ein Ordner unterhalb einer Datei ist dagegen für jeden unmöglich.
     */
    const versperrt = path.join(dir, 'keine-datei-sondern-ordner');
    writeFileSync(versperrt, 'ich bin eine Datei');

    const result = withEnv(
      { DATA_DIR: undefined, XDG_DATA_HOME: path.join(versperrt, 'darunter') },
      () => resolveDataDir(cwd),
    );

    assert.equal(result.dir, path.join(cwd, 'data'), 'der alte Ort bleibt in Betrieb');
    assert.match(result.note ?? '', /nicht.*umziehen|verschieben/i);
    assert.ok(existsSync(path.join(cwd, 'data', 'smarthome.json')), 'die Daten sind noch da');
  });
});

describe('Verschlüsselungsschlüssel', () => {
  it('legt beim ersten Start einen an – im Datenordner', () => {
    const ort = path.join(dir, 'schluessel-neu');
    const result = withEnv({ SECRET_KEY: undefined }, () => loadOrCreateSecretKey(ort));

    assert.equal(result.source, 'created');
    assert.match(result.key, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(path.join(ort, 'secret.key')));
  });

  it('nimmt beim nächsten Start denselben wieder', () => {
    // Der eigentliche Punkt: Ein neuer Schlüssel würde alle gespeicherten
    // Zugangsdaten unlesbar machen – die Bridges müssten neu gekoppelt werden.
    const ort = path.join(dir, 'schluessel-wieder');
    const erst = withEnv({ SECRET_KEY: undefined }, () => loadOrCreateSecretKey(ort));
    const zweit = withEnv({ SECRET_KEY: undefined }, () => loadOrCreateSecretKey(ort));

    assert.equal(zweit.key, erst.key);
    assert.equal(zweit.source, 'file');
  });

  it('speichert ihn nur für den Besitzer lesbar', function (t) {
    if (process.platform === 'win32') return t.skip('Dateirechte nur unter POSIX');
    const ort = path.join(dir, 'schluessel-rechte');
    withEnv({ SECRET_KEY: undefined }, () => loadOrCreateSecretKey(ort));
    const mode = statSync(path.join(ort, 'secret.key')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('lässt der Umgebung den Vorrang', () => {
    const ort = path.join(dir, 'schluessel-umgebung');
    const result = withEnv({ SECRET_KEY: 'von-aussen' }, () => loadOrCreateSecretKey(ort));
    assert.equal(result.key, 'von-aussen');
    assert.equal(result.source, 'env');
  });

  it('rettet einen Schlüssel aus der Umgebung in den Datenordner', () => {
    // Damit er auch dann noch da ist, wenn die `.env` beim nächsten
    // Herunterladen fehlt.
    const ort = path.join(dir, 'schluessel-retten');
    withEnv({ SECRET_KEY: 'aus-der-env' }, () => loadOrCreateSecretKey(ort));
    assert.equal(readFileSync(path.join(ort, 'secret.key'), 'utf8'), 'aus-der-env');

    const spaeter = withEnv({ SECRET_KEY: undefined }, () => loadOrCreateSecretKey(ort));
    assert.equal(spaeter.key, 'aus-der-env');
    assert.equal(spaeter.source, 'file');
  });
});
