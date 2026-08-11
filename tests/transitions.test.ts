/**
 * Übergänge: dass eine Farbe wandert statt zu springen.
 *
 * Jeder Hersteller kann das, jeder auf seine Weise und in seiner Einheit –
 * Hue in Millisekunden, die alte Hue-API in Zehntelsekunden, Shelly in
 * Sekunden, AVM wieder in Zehntelsekunden. Genau dort passieren die Fehler,
 * die niemand bemerkt: Aus 450 ms werden 45 Sekunden, und die Lampe scheint
 * zu hängen.
 *
 * Deshalb prüft diese Datei jede Umrechnung einzeln – und beim Shelly gegen
 * ein simuliertes Gerät, das mitschreibt, was tatsächlich ankommt.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildLightUpdate, buildV1LightUpdate } from '../src/adapters/hue/adapter.ts';
import { avmDuration } from '../src/adapters/fritzbox/adapter.ts';
import { ShellyAdapter } from '../src/adapters/shelly/adapter.ts';
import type { IntegrationContext } from '../src/adapters/types.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { commandsFor, EFFECTS } from '../src/services/effectService.ts';
import type { LightEffect } from '../src/core/types.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// Hue
// ---------------------------------------------------------------------------

describe('Hue blendet selbst hinüber', () => {
  it('gibt die Übergangszeit in Millisekunden weiter', () => {
    const { update } = buildLightUpdate({ type: 'setColor', hue: 120, saturation: 80 }, {}, 3000);
    assert.deepEqual(update.dynamics, { duration: 3000 });
  });

  it('lässt ohne Angabe alles beim Sprung', () => {
    const { update } = buildLightUpdate({ type: 'setColor', hue: 120, saturation: 80 }, {});
    assert.equal(update.dynamics, undefined, 'ein Regler soll sofort folgen');
  });

  it('blendet die Helligkeit, aber nicht das Ausschalten', () => {
    const hell = buildLightUpdate({ type: 'setBrightness', brightness: 80 }, {}, 2000);
    assert.deepEqual(hell.update.dynamics, { duration: 2000 });

    /*
     * Eine Lampe, die über zwei Sekunden „aus" geht, ist für den Hub schon
     * aus, während sie noch leuchtet – der nächste Abgleich meldete dann
     * einen Zustand, den niemand sieht.
     */
    const aus = buildLightUpdate({ type: 'setBrightness', brightness: 0 }, {}, 2000);
    assert.equal(aus.update.dynamics, undefined);
    const schalter = buildLightUpdate({ type: 'setPower', on: false }, {}, 2000);
    assert.equal(schalter.update.dynamics, undefined);
  });

  it('deckelt bei einer Minute', () => {
    const { update } = buildLightUpdate({ type: 'setBrightness', brightness: 50 }, {}, 999_999);
    assert.deepEqual(update.dynamics, { duration: 60_000 });
  });

  it('rechnet für die alte Bridge in Zehntelsekunden', () => {
    // Ohne Umrechnung würde aus 450 ms hier `transitiontime: 450`,
    // also dreiviertel Minute – die Lampe schiene zu hängen.
    const { body } = buildV1LightUpdate({ type: 'setColor', hue: 200, saturation: 60 }, 3000);
    assert.equal(body['transitiontime'], 30);

    const kurz = buildV1LightUpdate({ type: 'setBrightness', brightness: 40 }, 450);
    assert.equal(kurz.body['transitiontime'], 5, '450 ms sind gerundet fünf Zehntel');

    const ohne = buildV1LightUpdate({ type: 'setBrightness', brightness: 40 });
    assert.equal(ohne.body['transitiontime'], undefined);

    const aus = buildV1LightUpdate({ type: 'setPower', on: false }, 3000);
    assert.equal(aus.body['transitiontime'], undefined);
  });
});

// ---------------------------------------------------------------------------
// Shelly, gegen ein simuliertes Gerät
// ---------------------------------------------------------------------------

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

function createMockShellyLight(calls: RpcCall[]): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/shelly') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ name: 'Mock', mac: 'AABBCCDDEEFF', gen: 2, ver: '1.4.0', auth_en: false }),
        );
        return;
      }
      if (req.url === '/rpc') {
        const payload = JSON.parse(body) as RpcCall & { id: number };
        calls.push({ method: payload.method, params: payload.params ?? {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: payload.id, result: {} }));
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
}

describe('Shelly rechnet Übergänge in Sekunden', () => {
  const adapter = new ShellyAdapter();
  const calls: RpcCall[] = [];
  let server: http.Server;
  let ctx: IntegrationContext;

  before(async () => {
    server = createMockShellyLight(calls);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    ctx = {
      integration: { id: 'int_1', name: 'Mock' },
      config: { host, generation: 2, authRequired: false },
      secrets: {},
    } as unknown as IntegrationContext;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('schickt transition_duration in Sekunden mit', async () => {
    calls.length = 0;
    await adapter.execute(ctx, 'rgbw:0', { type: 'setColor', hue: 40, saturation: 90 }, {
      transitionMs: 3000,
    });
    assert.equal(calls[0]?.params['transition_duration'], 3, 'Shelly zählt in Sekunden');
  });

  it('deckelt bei fünf Sekunden – mehr lehnt die Firmware ab', async () => {
    calls.length = 0;
    await adapter.execute(ctx, 'rgbw:0', { type: 'setBrightness', brightness: 70 }, {
      transitionMs: 30_000,
    });
    assert.equal(calls[0]?.params['transition_duration'], 5);
  });

  it('lässt ohne Angabe sofort schalten', async () => {
    calls.length = 0;
    await adapter.execute(ctx, 'rgbw:0', { type: 'setBrightness', brightness: 70 });
    assert.equal(calls[0]?.params['transition_duration'], undefined);
  });

  it('blendet das Ausschalten nicht', async () => {
    calls.length = 0;
    await adapter.execute(ctx, 'rgbw:0', { type: 'setPower', on: false }, { transitionMs: 3000 });
    assert.equal(calls[0]?.params['transition_duration'], undefined);
  });
});

describe('Die FRITZ!Box rechnet in Zehntelsekunden', () => {
  it('rechnet um und deckelt bei einer Sekunde', () => {
    // Mehr als 10 nimmt die Box nicht an – und kürzt nicht, sondern weist die
    // ganze Anfrage ab.
    assert.equal(avmDuration(3000), '10');
    assert.equal(avmDuration(500), '5');
    assert.equal(avmDuration(450), '5');
  });

  it('macht aus einem sehr kurzen Übergang keine Null', () => {
    // Sonst wäre „ein bisschen blenden" dasselbe wie „gar nicht blenden".
    assert.equal(avmDuration(40), '1');
  });

  it('bleibt ohne Angabe beim Sprung', () => {
    assert.equal(avmDuration(), '0');
    assert.equal(avmDuration(0), '0');
    assert.equal(avmDuration(Number.NaN), '0');
  });
});

// ---------------------------------------------------------------------------
// Was die Effekte daraus machen
// ---------------------------------------------------------------------------

describe('Jeder Effekt blendet so, wie er soll', () => {
  it('lässt Disco, Gruseln und Gewitter springen', () => {
    for (const id of ['disco', 'gruselig', 'gewitter'] as LightEffect[]) {
      assert.equal(EFFECTS[id].fade, 0, `${id} darf nicht weich sein`);
    }
  });

  it('blendet Farbverlauf, Wecklicht und Einschlaflicht durch', () => {
    for (const id of ['farbwechsel', 'sonnenaufgang', 'einschlafen'] as LightEffect[]) {
      assert.equal(EFFECTS[id].fade, 1, `${id} soll fließen`);
    }
  });

  it('hält jede Blende zwischen 0 und 1', () => {
    for (const definition of Object.values(EFFECTS)) {
      assert.ok(definition.fade >= 0 && definition.fade <= 1, definition.id);
    }
  });
});

describe('Farbverlauf verteilt sich über die Lampen', () => {
  const hueOf = (index: number, count: number, step = 0): number => {
    const command = commandsFor('farbwechsel', step, index, { progress: 0, count }).find(
      (entry) => entry.type === 'setColor',
    );
    assert.ok(command && command.type === 'setColor');
    return command.hue;
  };

  it('teilt den Farbkreis gleichmäßig auf', () => {
    // Drei Lampen: 0°, 120°, 240° – zusammen ein Regenbogen, nicht drei Zufälle.
    assert.deepEqual([0, 1, 2].map((index) => hueOf(index, 3)), [0, 120, 240]);
    assert.deepEqual([0, 1].map((index) => hueOf(index, 2)), [0, 180]);
  });

  it('wandert gemeinsam weiter, ohne den Abstand zu verlieren', () => {
    const vorher = [0, 1, 2].map((index) => hueOf(index, 3, 0));
    const nachher = [0, 1, 2].map((index) => hueOf(index, 3, 5));
    for (const [i, wert] of nachher.entries()) {
      assert.equal((wert - (vorher[i] as number) + 360) % 360, 60, 'alle um denselben Betrag');
    }
  });

  it('kommt mit einer einzigen Lampe zurecht', () => {
    assert.equal(hueOf(0, 1), 0);
  });
});

// ---------------------------------------------------------------------------
// Die beiden Verläufe über die Zeit
// ---------------------------------------------------------------------------

describe('Sonnenaufgang', () => {
  const brightnessAt = (progress: number): number => {
    const command = commandsFor('sonnenaufgang', 0, 0, { progress, count: 1 }).find(
      (entry) => entry.type === 'setBrightness',
    );
    assert.ok(command && command.type === 'setBrightness');
    return command.brightness;
  };

  it('fängt fast dunkel an und endet ganz hell', () => {
    assert.equal(brightnessAt(0), 1);
    assert.equal(brightnessAt(1), 100);
  });

  it('wird immer heller, nie dunkler', () => {
    let letzte = 0;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const wert = brightnessAt(Math.min(1, p));
      assert.ok(wert >= letzte, `bei ${p.toFixed(2)}: ${wert} nach ${letzte}`);
      letzte = wert;
    }
  });

  it('legt zum Schluss stärker zu als am Anfang', () => {
    // Das Auge nimmt Helligkeit nicht linear wahr: Gleichmäßig hochgedreht
    // wäre es gefühlt nach einer Minute hell und danach passierte nichts mehr.
    const frueh = brightnessAt(0.3) - brightnessAt(0.2);
    const spaet = brightnessAt(0.9) - brightnessAt(0.8);
    assert.ok(spaet > frueh * 2, `früh ${frueh}, spät ${spaet}`);
  });

  it('geht von Rot über Orange in warmweißes Licht über', () => {
    const start = commandsFor('sonnenaufgang', 0, 0, { progress: 0, count: 1 });
    const farbe = start.find((entry) => entry.type === 'setColor');
    assert.ok(farbe && farbe.type === 'setColor');
    assert.ok(farbe.hue <= 10, `tiefrot erwartet, war ${farbe.hue}`);

    const ende = commandsFor('sonnenaufgang', 0, 0, { progress: 1, count: 1 });
    const weiss = ende.find((entry) => entry.type === 'setColorTemperature');
    assert.ok(weiss && weiss.type === 'setColorTemperature');
    assert.equal(weiss.kelvin, 4000);
  });

  it('schaltet die Lampe zuerst ein', () => {
    assert.deepEqual(commandsFor('sonnenaufgang', 0, 0, { progress: 0.5, count: 1 })[0], {
      type: 'setPower',
      on: true,
    });
  });
});

describe('Einschlaflicht', () => {
  const brightnessAt = (progress: number): number | null => {
    const command = commandsFor('einschlafen', 0, 0, { progress, count: 1 }).find(
      (entry) => entry.type === 'setBrightness',
    );
    return command && command.type === 'setBrightness' ? command.brightness : null;
  };

  it('wird immer dunkler', () => {
    let letzte = 999;
    for (let p = 0; p < 1; p += 0.05) {
      const wert = brightnessAt(p);
      assert.ok(wert !== null);
      assert.ok(wert <= letzte, `bei ${p.toFixed(2)}: ${wert} nach ${letzte}`);
      letzte = wert;
    }
  });

  it('schaltet am Ende wirklich aus', () => {
    // Eine Lampe, die auf einem Prozent stehen bleibt, ist nachts hell genug
    // zum Ärgern.
    assert.deepEqual(commandsFor('einschlafen', 0, 0, { progress: 1, count: 1 }), [
      { type: 'setPower', on: false },
    ]);
  });

  it('wird dabei immer wärmer', () => {
    const kelvinAt = (progress: number): number => {
      const command = commandsFor('einschlafen', 0, 0, { progress, count: 1 }).find(
        (entry) => entry.type === 'setColorTemperature',
      );
      assert.ok(command && command.type === 'setColorTemperature');
      return command.kelvin;
    };
    assert.equal(kelvinAt(0), 2700);
    assert.ok(kelvinAt(0.99) < 1900, 'zum Schluss ohne Blauanteil');
  });
});
