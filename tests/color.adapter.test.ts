import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ShellyAdapter } from '../src/adapters/shelly/adapter.ts';
import type { IntegrationContext } from '../src/adapters/types.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Integration } from '../src/core/types.ts';

setLogLevel('silent');

/**
 * Der Hub meldete für RGB-Kanäle die Fähigkeit "color", der Adapter lehnte
 * das passende Kommando aber ab. Dieser Test hält Fähigkeit und Kommando
 * zusammen.
 */

interface MockState {
  on: boolean;
  brightness: number;
  rgb: [number, number, number];
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
}

const state: MockState = { on: false, brightness: 60, rgb: [255, 255, 255], calls: [] };
let server: http.Server;
let host = '';

before(async () => {
  server = http.createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/shelly') {
      json({
        id: 'shellyplusrgbw-test',
        model: 'SNDC-0D4P10WW',
        mac: 'A8032ABC',
        gen: 2,
        ver: '1.0.3',
        app: 'PlusRGBW',
        auth_en: false,
      });
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}') as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      state.calls.push({ method: rpc.method, ...(rpc.params ? { params: rpc.params } : {}) });

      switch (rpc.method) {
        case 'Shelly.GetStatus':
          json({
            id: rpc.id,
            result: {
              'rgb:0': { id: 0, output: state.on, brightness: state.brightness, rgb: state.rgb },
            },
          });
          return;
        case 'Shelly.GetConfig':
          json({ id: rpc.id, result: { sys: { device: { name: 'Lampe' } } } });
          return;
        case 'RGB.Set':
          if (typeof rpc.params?.['on'] === 'boolean') state.on = rpc.params['on'] as boolean;
          if (Array.isArray(rpc.params?.['rgb'])) {
            state.rgb = rpc.params['rgb'] as [number, number, number];
          }
          if (typeof rpc.params?.['brightness'] === 'number') {
            state.brightness = rpc.params['brightness'] as number;
          }
          json({ id: rpc.id, result: null });
          return;
        default:
          json({ id: rpc.id, error: { code: -32601, message: 'Unbekannte Methode' } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Farbsteuerung eines Shelly RGBW', () => {
  const adapter = new ShellyAdapter();
  let ctx: IntegrationContext;

  it('bindet den Farbkanal mit der Fähigkeit "color" ein', async () => {
    const result = await adapter.link({ host });
    ctx = {
      integration: { id: 'int_color', name: 'Lampe' } as Integration,
      config: result.config,
      secrets: null,
    };
    const devices = await adapter.listDevices(ctx);
    assert.equal(devices.length, 1);
    assert.ok(devices[0]?.capabilities.includes('color'), 'Fähigkeit wird gemeldet');
  });

  it('setzt eine Farbe – die gemeldete Fähigkeit ist also auch nutzbar', async () => {
    const result = await adapter.execute(ctx, 'rgb:0', {
      type: 'setColor',
      hue: 120,
      saturation: 100,
    });
    assert.equal(result.hue, 120);
    assert.equal(result.saturation, 100);
    assert.equal(result.on, true, 'Farbe setzen schaltet die Lampe ein');
    assert.deepEqual(state.rgb, [0, 255, 0], 'Grün als RGB an das Gerät');
  });

  it('rechnet den Farbton korrekt in RGB um', async () => {
    await adapter.execute(ctx, 'rgb:0', { type: 'setColor', hue: 0, saturation: 100 });
    assert.deepEqual(state.rgb, [255, 0, 0]);
    await adapter.execute(ctx, 'rgb:0', { type: 'setColor', hue: 240, saturation: 100 });
    assert.deepEqual(state.rgb, [0, 0, 255]);
  });

  it('ergibt bei Sättigung 0 Weiß', async () => {
    await adapter.execute(ctx, 'rgb:0', { type: 'setColor', hue: 200, saturation: 0 });
    assert.deepEqual(state.rgb, [255, 255, 255]);
  });

  it('normalisiert Farbtöne außerhalb von 0..360', async () => {
    await adapter.execute(ctx, 'rgb:0', { type: 'setColor', hue: 480, saturation: 100 });
    assert.deepEqual(state.rgb, [0, 255, 0], '480° entspricht 120°');
  });

  it('liest die Farbe vom Gerät zurück', async () => {
    await adapter.execute(ctx, 'rgb:0', { type: 'setColor', hue: 300, saturation: 100 });
    const states = await adapter.readStates(ctx);
    const colorState = states.get('rgb:0');
    assert.ok(colorState);
    assert.equal(Math.round(colorState?.hue ?? 0), 300);
    assert.equal(Math.round(colorState?.saturation ?? 0), 100);
  });

  it('lehnt Farbbefehle für Kanäle ohne Farbe verständlich ab', async () => {
    await assert.rejects(
      () => adapter.execute(ctx, 'switch:0', { type: 'setColor', hue: 10, saturation: 50 }),
      (err: Error & { hint?: string }) => {
        assert.match(err.message, /keine Farben/);
        assert.match(err.hint ?? '', /RGB/);
        return true;
      },
    );
  });
});
