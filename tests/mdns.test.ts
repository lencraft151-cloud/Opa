import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { describe, it } from 'node:test';
import { browse, buildQuery, MDNS_SERVICES, parseResponse } from '../src/util/mdns.ts';
import { setLogLevel } from '../src/core/logger.ts';

setLogLevel('silent');

const QU_BIT = 0x8000;
const CLASS_IN = 1;

/** Liest die QCLASS des ersten Fragedatensatzes aus einer Anfrage. */
function questionClass(query: Buffer): number {
  let offset = 12;
  while (offset < query.length && query[offset] !== 0) {
    offset += (query[offset] as number) + 1;
  }
  return query.readUInt16BE(offset + 3);
}

describe('mDNS-Anfrage', () => {
  it('fragt genau einen PTR-Datensatz ab', () => {
    const query = buildQuery('_shelly._tcp.local', false);
    assert.equal(query.readUInt16BE(4), 1, 'ein Fragedatensatz');
    assert.equal(query.readUInt16BE(2), 0, 'Standard-Query ohne Flags');
    assert.ok(query.includes(Buffer.from('_shelly', 'ascii')));
  });

  it('setzt das Unicast-Bit nur, wenn es angefordert wird', () => {
    // Auf Port 5353 empfangen wir Multicast-Antworten – dann darf das Bit
    // nicht gesetzt sein, sonst antworten manche Geräte gar nicht.
    assert.equal(questionClass(buildQuery('_hue._tcp.local', false)), CLASS_IN);
    assert.equal(questionClass(buildQuery('_hue._tcp.local', true)), CLASS_IN | QU_BIT);
  });
});

// ---------------------------------------------------------------------------
// Antwort-Parser
// ---------------------------------------------------------------------------

/** Baut einen DNS-Namen als Labelfolge. */
function name(value: string): Buffer {
  const parts = value.split('.').filter(Boolean);
  return Buffer.concat([
    ...parts.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part, 'ascii')])),
    Buffer.from([0]),
  ]);
}

function record(rname: string, type: number, rdata: Buffer): Buffer {
  const head = Buffer.concat([name(rname), Buffer.alloc(10)]);
  head.writeUInt16BE(type, head.length - 10);
  head.writeUInt16BE(CLASS_IN, head.length - 8);
  head.writeUInt32BE(120, head.length - 6);
  head.writeUInt16BE(rdata.length, head.length - 2);
  return Buffer.concat([head, rdata]);
}

function response(records: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // Antwort, autoritativ
  header.writeUInt16BE(records.length, 6); // ANCOUNT
  return Buffer.concat([header, ...records]);
}

function txt(entries: string[]): Buffer {
  return Buffer.concat(
    entries.map((entry) => Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry, 'ascii')])),
  );
}

function srv(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0); // Priorität
  head.writeUInt16BE(0, 2); // Gewicht
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, name(target)]);
}

describe('mDNS-Antworten auswerten', () => {
  const service = '_shelly._tcp.local';
  const instance = 'shellyplus1-a8032ab._shelly._tcp.local';

  it('setzt PTR, SRV, TXT und A zu einem Dienst zusammen', () => {
    const message = response([
      record(service, 12, name(instance)),
      record(instance, 33, srv(80, 'shellyplus1-a8032ab.local')),
      record(instance, 16, txt(['gen=2', 'app=Plus1'])),
      record('shellyplus1-a8032ab.local', 1, Buffer.from([192, 168, 1, 50])),
    ]);

    const [found] = parseResponse(message, service, '192.168.1.50');
    assert.ok(found);
    assert.equal(found?.name, instance);
    assert.equal(found?.port, 80);
    assert.equal(found?.host, 'shellyplus1-a8032ab.local');
    assert.deepEqual(found?.txt, { gen: '2', app: 'Plus1' });
    assert.deepEqual(found?.addresses, ['192.168.1.50']);
  });

  it('ignoriert Dienste anderer Typen', () => {
    const message = response([
      record('_printer._tcp.local', 12, name('drucker._printer._tcp.local')),
    ]);
    assert.deepEqual(parseResponse(message, service), []);
  });

  it('kommt mit einem Paket ohne Adressdatensatz zurecht', () => {
    // Manche Geräte schicken den A-Record in einem eigenen Paket nach.
    const message = response([record(service, 12, name(instance))]);
    const [found] = parseResponse(message, service, '192.168.1.77');
    assert.equal(found?.name, instance);
    assert.deepEqual(found?.addresses, ['192.168.1.77'], 'Absenderadresse als Rückfallebene');
  });

  it('wirft bei kaputten Paketen nicht', () => {
    assert.deepEqual(parseResponse(Buffer.alloc(0), service), []);
    assert.deepEqual(parseResponse(Buffer.from([1, 2, 3]), service), []);
    assert.deepEqual(parseResponse(response([record(service, 12, Buffer.alloc(2))]), service), []);
  });
});

// ---------------------------------------------------------------------------
// Zusammenspiel mit einem echten Responder
// ---------------------------------------------------------------------------

describe('Suche im Netzwerk', () => {
  it('findet ein Gerät, das ausschließlich per Multicast antwortet', async (t) => {
    const service = '_shelly._tcp.local';
    const instance = 'mock-shelly._shelly._tcp.local';

    // Responder auf dem Standardport – wie ein echtes Gerät.
    const responder = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const ready = await new Promise<boolean>((resolve) => {
      responder.once('error', () => resolve(false));
      responder.bind(5353, () => {
        try {
          responder.addMembership('224.0.0.251');
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });

    if (!ready) {
      responder.close();
      t.skip('Multicast ist in dieser Umgebung nicht verfügbar');
      return;
    }

    const answer = response([
      record(service, 12, name(instance)),
      record(instance, 33, srv(80, 'mock-shelly.local')),
      record('mock-shelly.local', 1, Buffer.from([127, 0, 0, 1])),
    ]);

    responder.on('message', (msg) => {
      // Nur auf unsere Anfrage reagieren, nicht auf fremden Verkehr.
      if (!msg.includes(Buffer.from('_shelly', 'ascii'))) return;
      if (msg.readUInt16BE(6) !== 0) return; // Antworten überspringen
      // Ausschließlich per Multicast antworten – genau der Fall, den die
      // frühere Unicast-Variante nicht mitbekommen hat.
      responder.send(answer, 0, answer.length, 5353, '224.0.0.251');
    });

    try {
      const found = await browse(service, { timeoutMs: 2500, queryCount: 2 });
      const match = found.find((entry) => entry.name === instance);
      assert.ok(match, `Dienst nicht gefunden, erhalten: ${JSON.stringify(found)}`);
      assert.equal(match?.host, 'mock-shelly.local');
    } finally {
      responder.close();
    }
  });
});
