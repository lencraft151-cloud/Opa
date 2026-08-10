/**
 * „Eine neue Fassung ist da."
 *
 * Zwei Dinge müssen dabei stimmen, und das zweite ist das schwierigere:
 * Der Hub muss es *merken* – und er muss es **einmal** sagen. Eine
 * Benachrichtigung, die täglich dieselbe Fassung anpreist, wird weggeklickt,
 * ohne gelesen zu werden, und dann geht auch die nächste unter.
 *
 * Dazu die Grundregel dieses Hubs: Ohne eingestellte Prüfadresse telefoniert
 * er gar nicht erst nach draußen.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { events } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { VERSION } from '../src/version.ts';
import {
  compareVersions,
  firstSentence,
  HubUpdateService,
} from '../src/services/hubUpdateService.ts';

setLogLevel('silent');

interface Announcement {
  message: string;
  hint?: string;
  source?: string;
}

/** Sammelt die Einblendungen, die der Hub auslösen würde. */
function collect(): { seen: Announcement[]; stop: () => void } {
  const seen: Announcement[] = [];
  const listener = (payload: Announcement): void => {
    if (payload.source === 'hub-update') seen.push(payload);
  };
  // `on` gibt die Abmeldung zurück – ein Zuhörer je Test, sonst summieren
  // sich die Meldungen über die Testdatei hinweg.
  const off = events.on('notification', listener as never);
  return { seen, stop: off };
}

describe('Ankündigung einer neuen Fassung', () => {
  let server: http.Server;
  let url: string;
  let calls = 0;
  let tag = 'v9.9.9';

  before(async () => {
    server = http.createServer((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tag_name: tag }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/release`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sagt Bescheid, wenn draußen etwas Neueres liegt', async () => {
    const watch = collect();
    const service = new HubUpdateService('1.0.0', { checkUrl: url });

    await service.checkAndAnnounce('hh_1');
    watch.stop();

    assert.equal(watch.seen.length, 1);
    assert.match(watch.seen[0]?.message ?? '', /9\.9\.9/);
    // Auch die laufende Fassung gehört hinein – sonst weiß niemand, ob der
    // Sprung groß ist.
    assert.match(watch.seen[0]?.message ?? '', /1\.0\.0/);
  });

  it('sagt es genau einmal, nicht bei jeder Prüfung', async () => {
    const watch = collect();
    const service = new HubUpdateService('1.0.0', { checkUrl: url });

    await service.checkAndAnnounce('hh_1');
    await service.checkAndAnnounce('hh_1');
    await service.checkAndAnnounce('hh_1');
    watch.stop();

    assert.equal(watch.seen.length, 1, 'dieselbe Fassung wird nur einmal angekündigt');
  });

  it('meldet sich wieder, wenn noch etwas Neueres erscheint', async () => {
    const watch = collect();
    const service = new HubUpdateService('1.0.0', { checkUrl: url });

    tag = 'v9.9.9';
    await service.checkAndAnnounce('hh_1');
    tag = 'v10.0.0';
    await service.checkAndAnnounce('hh_1');
    watch.stop();
    tag = 'v9.9.9';

    assert.equal(watch.seen.length, 2);
    assert.match(watch.seen[1]?.message ?? '', /10\.0\.0/);
  });

  it('schweigt, wenn die eigene Fassung die neueste ist', async () => {
    const watch = collect();
    const service = new HubUpdateService('99.0.0', { checkUrl: url });

    await service.checkAndAnnounce('hh_1');
    watch.stop();

    assert.equal(watch.seen.length, 0);
  });

  it('telefoniert ohne Prüfadresse gar nicht erst nach draußen', async () => {
    const before = calls;
    const service = new HubUpdateService('1.0.0', { checkUrl: null });

    service.start('hh_1');
    await service.checkAndAnnounce('hh_1');
    service.stop();

    assert.equal(calls, before, 'keine einzige Anfrage nach außen');
  });

  it('meldet nichts, wenn die laufende Fassung oben im Protokoll steht', async () => {
    /*
     * Ohne Prüfadresse ist das mitgelieferte Änderungsprotokoll die einzige
     * Auskunft – und dort steht die eigene Fassung ganz oben (dafür sorgt
     * `version.test.ts`). Es gibt also nichts anzukündigen. Fiele hier eine
     * Meldung, bekäme jeder Hub ohne Internetzugang beim Start eine
     * Einblendung über eine Fassung, die er selbst schon ist.
     */
    const watch = collect();
    const service = new HubUpdateService(VERSION, { checkUrl: null });

    await service.checkAndAnnounce('hh_1');
    watch.stop();

    assert.equal(watch.seen.length, 0);
  });

  it('macht aus einem Ausfall der Prüfung keine Fehlermeldung', async () => {
    const watch = collect();
    // Adresse, an der nichts lauscht: Das ist Alltag, kein Zwischenfall.
    const service = new HubUpdateService('1.0.0', {
      checkUrl: 'http://127.0.0.1:1/release',
    });

    const result = await service.checkAndAnnounce('hh_1');
    watch.stop();

    assert.equal(result, null);
    assert.equal(watch.seen.length, 0);
  });

  it('hört auf zu prüfen, wenn man es ihm sagt', () => {
    const service = new HubUpdateService('1.0.0', { checkUrl: url });
    service.start('hh_1');
    service.stop();
    // Ohne offene Zeitgeber endet der Prozess; bliebe einer, hinge der Test.
    assert.ok(true);
  });
});

describe('Die Zeile unter der Ankündigung', () => {
  it('nimmt den ersten Satz des Änderungsabschnitts', () => {
    const text = '**Sonos zeigt Playlists.** Bisher ging das nicht. Und noch mehr Text.';
    assert.equal(firstSentence(text), 'Sonos zeigt Playlists.');
  });

  it('lässt Auszeichnung nicht durchrutschen', () => {
    // `**fett**` mitten in einer Einblendung sähe nach einem Fehler aus.
    assert.equal(firstSentence('**Neu:** `code` hier.'), 'Neu: code hier.');
  });

  it('schneidet nicht mitten in einer Abkürzung ab', () => {
    assert.equal(
      firstSentence('Neu ist z. B. die Suche. Danach kommt mehr.'),
      'Neu ist z. B. die Suche.',
    );
  });

  it('kürzt einen sehr langen Satz mit Auslassungszeichen', () => {
    const long = `${'a'.repeat(300)}.`;
    const result = firstSentence(long, 40) ?? '';
    assert.equal(result.length, 40);
    assert.ok(result.endsWith('…'));
  });

  it('gibt nichts zurück, wo nichts steht', () => {
    assert.equal(firstSentence(''), null);
    assert.equal(firstSentence('## Nur eine Überschrift'), null);
  });

  it('überspringt Überschriften und Listenzeichen', () => {
    assert.equal(firstSentence('## 1.2.0\n\n- Erster Punkt. Zweiter.'), 'Erster Punkt.');
  });
});

describe('Versionen vergleichen', () => {
  it('erkennt neuer und älter', () => {
    assert.ok(compareVersions('1.11.0', '1.9.0') > 0);
    assert.ok(compareVersions('1.9.0', '1.11.0') < 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('stört sich nicht an einem führenden v', () => {
    assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  });
});
