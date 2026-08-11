import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ShellyAdapter } from '../src/adapters/shelly/adapter.ts';
import {
  normalizeCoverState,
  parseGen1Status,
  parseGen2Status,
} from '../src/adapters/shelly/mapping.ts';
import type { IntegrationContext } from '../src/adapters/types.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Integration, ShellyIntegrationConfig } from '../src/core/types.ts';

setLogLevel('silent');

const naming = { deviceName: 'Shelly', channelNames: new Map<string, string>() };

describe('Farbkanäle', () => {
  it('meldet die Fähigkeit "color" für RGB-Kanäle', () => {
    const components = parseGen2Status(
      { 'rgb:0': { id: 0, output: true, brightness: 70, rgb: [255, 140, 40] } },
      naming,
    );
    assert.deepEqual(components[0]?.capabilities, ['switch', 'dimmer', 'color']);
    assert.equal(Math.round(components[0]?.state.hue ?? 0), 28);
  });

  it('meldet sie nicht für einfache Lichtkanäle', () => {
    const components = parseGen2Status(
      { 'light:0': { id: 0, output: true, brightness: 40 } },
      naming,
    );
    assert.deepEqual(components[0]?.capabilities, ['switch', 'dimmer']);
  });
});

describe('Fahrzustand eines Rollladens', () => {
  it('unterscheidet die Bedeutung von "open" je Generation', () => {
    // Gen2: Endzustand. Gen1: Fahrt nach oben. Derselbe String, zwei Bedeutungen.
    assert.equal(normalizeCoverState('open', 100, 2), 'open');
    assert.equal(normalizeCoverState('open', 40, 1), 'opening');
    assert.equal(normalizeCoverState('close', 40, 1), 'closing');
  });

  it('übernimmt die Gen2-Fahrzustände direkt', () => {
    assert.equal(normalizeCoverState('opening', 40, 2), 'opening');
    assert.equal(normalizeCoverState('closing', 40, 2), 'closing');
    assert.equal(normalizeCoverState('closed', 0, 2), 'closed');
  });

  it('leitet den Zustand aus der Position ab, wenn das Gerät stillsteht', () => {
    assert.equal(normalizeCoverState('stop', 0, 1), 'closed');
    assert.equal(normalizeCoverState('stop', 100, 1), 'open');
    assert.equal(normalizeCoverState('stop', 55, 1), 'stopped');
    assert.equal(normalizeCoverState('stopped', 55, 2), 'stopped');
  });

  it('kommt ohne Angaben zurecht', () => {
    assert.equal(normalizeCoverState(undefined, undefined, 2), 'stopped');
    assert.equal(normalizeCoverState('calibrating', undefined, 2), 'stopped');
  });
});

describe('Rollläden im Gerätestatus', () => {
  it('liest Position, Fahrzustand und Lamellen aus Gen2', () => {
    const [cover] = parseGen2Status(
      {
        'cover:0': {
          id: 0,
          state: 'opening',
          current_pos: 65,
          slat_pos: 30,
          apower: 3.4,
        },
      },
      naming,
    );
    assert.equal(cover?.state.position, 65);
    assert.equal(cover?.state.coverState, 'opening');
    assert.equal(cover?.state.tilt, 30);
    assert.deepEqual(cover?.capabilities, ['cover', 'cover.tilt', 'sensor.power']);
  });

  it('meldet Rollläden ohne Lamellen auch ohne die Tilt-Fähigkeit', () => {
    const [cover] = parseGen2Status(
      { 'cover:0': { id: 0, state: 'stopped', current_pos: 20 } },
      naming,
    );
    assert.deepEqual(cover?.capabilities, ['cover']);
    assert.equal(cover?.state.tilt, undefined);
  });

  it('liest Gen1-Rollläden inklusive Leistung', () => {
    const [cover] = parseGen1Status(
      { rollers: [{ state: 'close', current_pos: 42, power: 55.5 }] },
      naming,
    );
    assert.equal(cover?.externalId, 'cover:0');
    assert.equal(cover?.state.position, 42);
    assert.equal(cover?.state.coverState, 'closing');
    assert.equal(cover?.state.powerW, 55.5);
    assert.ok(cover?.capabilities.includes('sensor.power'));
  });
});

// ---------------------------------------------------------------------------
// Adapter gegen ein simuliertes Rollladen-Gerät
// ---------------------------------------------------------------------------

interface CoverState {
  position: number;
  slat: number;
  state: string;
  calls: string[];
}

const coverState: CoverState = { position: 50, slat: 0, state: 'stopped', calls: [] };
let server: http.Server;
let host = '';

function createServer(): http.Server {
  return http.createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/shelly') {
      json({
        id: 'shellyplus2pm-cover',
        model: 'SNSW-102P16EU',
        mac: 'B0A73212',
        gen: 2,
        ver: '1.0.3',
        app: 'Plus2PM',
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
      coverState.calls.push(rpc.method);

      switch (rpc.method) {
        case 'Shelly.GetStatus':
          json({
            id: rpc.id,
            result: {
              'cover:0': {
                id: 0,
                state: coverState.state,
                current_pos: coverState.position,
                slat_pos: coverState.slat,
                apower: coverState.state === 'stopped' ? 0 : 48.2,
              },
            },
          });
          return;
        case 'Shelly.GetConfig':
          json({
            id: rpc.id,
            result: { sys: { device: { name: 'Wohnzimmer' } }, 'cover:0': { id: 0, name: 'Terrasse' } },
          });
          return;
        case 'Cover.Open':
          coverState.state = 'opening';
          json({ id: rpc.id, result: null });
          return;
        case 'Cover.Close':
          coverState.state = 'closing';
          json({ id: rpc.id, result: null });
          return;
        case 'Cover.Stop':
          coverState.state = 'stopped';
          json({ id: rpc.id, result: null });
          return;
        case 'Cover.GoToPosition':
          if (typeof rpc.params?.['pos'] === 'number') {
            coverState.position = rpc.params['pos'] as number;
          }
          if (typeof rpc.params?.['slat_pos'] === 'number') {
            coverState.slat = rpc.params['slat_pos'] as number;
          }
          json({ id: rpc.id, result: null });
          return;
        case 'Shelly.CheckForUpdate':
          json({ id: rpc.id, result: { stable: { version: '1.1.0' } } });
          return;
        case 'Shelly.GetDeviceInfo':
          json({ id: rpc.id, result: { ver: '1.0.3' } });
          return;
        case 'Shelly.Update':
          json({ id: rpc.id, result: null });
          return;
        default:
          json({ id: rpc.id, error: { code: -32601, message: 'Unbekannte Methode' } });
      }
    });
  });
}

before(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Rollladen-Kommandos über den Shelly-Adapter', () => {
  const adapter = new ShellyAdapter();
  let ctx: IntegrationContext;

  it('bindet den Rollladenaktor ein', async () => {
    const result = await adapter.link({ host });
    ctx = {
      integration: { id: 'int_cover', name: 'Wohnzimmer' } as Integration,
      config: result.config,
      secrets: null,
    };
    assert.equal((result.config as ShellyIntegrationConfig).generation, 2);

    const devices = await adapter.listDevices(ctx);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.name, 'Terrasse');
    assert.ok(devices[0]?.capabilities.includes('cover'));
    assert.ok(devices[0]?.capabilities.includes('cover.tilt'));
  });

  it('fährt auf, zu und hält an', async () => {
    const opened = await adapter.execute(ctx, 'cover:0', { type: 'openCover' });
    assert.equal(opened.coverState, 'opening');
    assert.ok(coverState.calls.includes('Cover.Open'));

    const closed = await adapter.execute(ctx, 'cover:0', { type: 'closeCover' });
    assert.equal(closed.coverState, 'closing');

    const stopped = await adapter.execute(ctx, 'cover:0', { type: 'stopCover' });
    assert.equal(stopped.coverState, 'stopped');
    assert.ok(coverState.calls.includes('Cover.Stop'));
  });

  it('fährt eine Position an', async () => {
    const result = await adapter.execute(ctx, 'cover:0', { type: 'setPosition', position: 80 });
    assert.equal(result.position, 80);
    assert.equal(coverState.position, 80);

    const states = await adapter.readStates(ctx);
    assert.equal(states.get('cover:0')?.position, 80);
  });

  it('verstellt die Lamellen', async () => {
    const result = await adapter.execute(ctx, 'cover:0', { type: 'setTilt', tilt: 35 });
    assert.equal(result.tilt, 35);
    assert.equal(coverState.slat, 35);
  });

  it('begrenzt Werte außerhalb von 0..100', async () => {
    await adapter.execute(ctx, 'cover:0', { type: 'setPosition', position: 250 });
    assert.equal(coverState.position, 100);
    await adapter.execute(ctx, 'cover:0', { type: 'setTilt', tilt: -20 });
    assert.equal(coverState.slat, 0);
  });

  it('lehnt Schaltbefehle mit einem passenden Hinweis ab', async () => {
    await assert.rejects(
      () => adapter.execute(ctx, 'cover:0', { type: 'setPower', on: true }),
      (err: Error & { hint?: string }) => {
        assert.match(err.message, /lässt sich nicht schalten/);
        assert.match(err.hint ?? '', /Auf\/Zu\/Stop/);
        return true;
      },
    );
  });

  it('erkennt eine neue Firmware', async () => {
    const info = await adapter.checkForUpdate(ctx);
    assert.equal(info.currentVersion, '1.0.3');
    assert.equal(info.availableVersion, '1.1.0');
    assert.equal(info.updateAvailable, true);
    assert.equal(info.installable, true);

    await adapter.installUpdate(ctx);
    assert.ok(coverState.calls.includes('Shelly.Update'));
  });
});
