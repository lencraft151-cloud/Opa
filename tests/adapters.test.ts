import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { HueAdapter } from '../src/adapters/hue/adapter.ts';
import { HueClient } from '../src/adapters/hue/client.ts';
import { ShellyAdapter } from '../src/adapters/shelly/adapter.ts';
import { LinkButtonRequiredError } from '../src/adapters/types.ts';
import type { IntegrationContext } from '../src/adapters/types.ts';
import type { Integration, ShellyIntegrationConfig } from '../src/core/types.ts';
import { setLogLevel } from '../src/core/logger.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// Simuliertes Shelly-Gerät (Gen2, passwortgeschützt)
// ---------------------------------------------------------------------------

const REALM = 'shellyplus1-mock';
const NONCE = '12345678';
const PASSWORD = 'geheim';

/** Unabhängige Nachrechnung der Digest-Antwort (RFC 7616, SHA-256, qop=auth). */
function expectedDigestResponse(params: Record<string, string>, method: string): string {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const ha1 = sha(`admin:${REALM}:${PASSWORD}`);
  const ha2 = sha(`${method}:${params['uri']}`);
  return sha(
    `${ha1}:${NONCE}:${params['nc']}:${params['cnonce']}:${params['qop']}:${ha2}`,
  );
}

function parseAuthHeader(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const regex = /(\w+)="?([^",]+)"?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(header)) !== null) {
    params[match[1] as string] = match[2] as string;
  }
  return params;
}

interface MockShellyState {
  switchOn: boolean;
  temperature: number;
  authenticatedCalls: number;
}

function createMockShelly(state: MockShellyState): http.Server {
  return http.createServer((req, res) => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/shelly') {
      json(200, {
        name: 'Mock Shelly',
        id: 'shellyplus1-mock',
        mac: 'A8032ABCDEF0',
        model: 'SNSW-001X16EU',
        gen: 2,
        fw_id: '20240101-000000',
        ver: '1.2.0',
        app: 'Plus1',
        auth_en: true,
      });
      return;
    }

    // Alles unter /rpc verlangt Digest-Authentifizierung.
    const authorization = req.headers.authorization;
    if (!authorization) {
      json(401, { error: 'unauthorized' }, {
        'www-authenticate': `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", algorithm=SHA-256`,
      });
      return;
    }

    const params = parseAuthHeader(authorization);
    if (params['response'] !== expectedDigestResponse(params, req.method ?? 'GET')) {
      json(401, { error: 'bad digest' });
      return;
    }
    state.authenticatedCalls++;

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}') as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };

      switch (rpc.method) {
        case 'Shelly.GetStatus':
          json(200, {
            id: rpc.id,
            result: {
              'switch:0': {
                id: 0,
                output: state.switchOn,
                apower: state.switchOn ? 42.5 : 0,
                aenergy: { total: 987.6 },
              },
              'temperature:0': { id: 0, tC: state.temperature },
              sys: { mac: 'A8032ABCDEF0' },
            },
          });
          return;
        case 'Shelly.GetConfig':
          json(200, {
            id: rpc.id,
            result: {
              sys: { device: { name: 'Mock Shelly' } },
              'switch:0': { id: 0, name: 'Kaffeemaschine' },
            },
          });
          return;
        case 'Switch.Set':
          state.switchOn = Boolean(rpc.params?.['on']);
          json(200, { id: rpc.id, result: { was_on: !state.switchOn } });
          return;
        default:
          json(200, { id: rpc.id, error: { code: -32601, message: 'Unbekannte Methode' } });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Simulierte Hue Bridge (V1-Pairing über HTTP)
// ---------------------------------------------------------------------------

function createMockHue(state: { linkButtonPressed: boolean }): http.Server {
  return http.createServer((req, res) => {
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/api/config') {
      json({
        name: 'Mock Bridge',
        bridgeid: '001788FFFE123456',
        modelid: 'BSB002',
        apiversion: '1.65.0',
        swversion: '1965111030',
        mac: '00:17:88:12:34:56',
      });
      return;
    }

    if (req.url === '/api' && req.method === 'POST') {
      if (!state.linkButtonPressed) {
        json([{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
        return;
      }
      json([{ success: { username: 'mock-application-key', clientkey: 'MOCKCLIENTKEY' } }]);
      return;
    }

    res.writeHead(404).end();
  });
}

// ---------------------------------------------------------------------------

let shellyServer: http.Server;
let hueServer: http.Server;
let shellyHost = '';
let hueHost = '';
const shellyState: MockShellyState = { switchOn: false, temperature: 21.5, authenticatedCalls: 0 };
const hueState = { linkButtonPressed: false };

before(async () => {
  shellyServer = createMockShelly(shellyState);
  hueServer = createMockHue(hueState);
  await Promise.all([
    new Promise<void>((resolve) => shellyServer.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => hueServer.listen(0, '127.0.0.1', resolve)),
  ]);
  shellyHost = `127.0.0.1:${(shellyServer.address() as AddressInfo).port}`;
  hueHost = `127.0.0.1:${(hueServer.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => shellyServer.close(() => resolve())),
    new Promise<void>((resolve) => hueServer.close(() => resolve())),
  ]);
});

describe('Shelly-Adapter gegen ein simuliertes Gerät', () => {
  const adapter = new ShellyAdapter();
  let ctx: IntegrationContext;

  it('verweigert die Einbindung ohne Passwort', async () => {
    await assert.rejects(
      () => adapter.link({ host: shellyHost }),
      /passwortgeschützt|Passwort/,
    );
  });

  it('bindet das Gerät mit Passwort ein', async () => {
    const result = await adapter.link({ host: shellyHost, password: PASSWORD });
    assert.equal(result.externalId, 'shellyplus1-mock');
    const config = result.config as ShellyIntegrationConfig;
    assert.equal(config.generation, 2);
    assert.equal(config.authRequired, true);
    assert.equal(config.username, 'admin');
    assert.deepEqual(result.secrets, { password: PASSWORD });

    ctx = {
      integration: { id: 'int_test', name: 'Mock Shelly' } as Integration,
      config: result.config,
      secrets: result.secrets ?? null,
    };
  });

  it('meldet Kanäle und Sensoren als eigene Geräte', async () => {
    const devices = await adapter.listDevices(ctx);
    const byId = new Map(devices.map((device) => [device.externalId, device]));

    assert.equal(byId.size, 2);
    assert.equal(byId.get('switch:0')?.name, 'Kaffeemaschine', 'Kanalname aus der Konfiguration');
    assert.deepEqual(byId.get('switch:0')?.capabilities, [
      'switch',
      'sensor.power',
      'sensor.energy',
    ]);
    assert.equal(byId.get('temperature:0')?.state.temperatureC, 21.5);
    assert.equal(byId.get('switch:0')?.state.on, false);
  });

  it('schaltet den Kanal und liest den neuen Zustand zurück', async () => {
    const state = await adapter.execute(ctx, 'switch:0', { type: 'setPower', on: true });
    assert.equal(state.on, true);
    assert.equal(shellyState.switchOn, true);

    const states = await adapter.readStates(ctx);
    assert.equal(states.get('switch:0')?.on, true);
    assert.equal(states.get('switch:0')?.powerW, 42.5);
  });

  it('lehnt Kommandos ab, die der Kanal nicht kann', async () => {
    await assert.rejects(
      () => adapter.execute(ctx, 'switch:0', { type: 'setBrightness', brightness: 50 }),
      /nicht dimmbar/,
    );
    await assert.rejects(
      () => adapter.execute(ctx, 'temperature:0', { type: 'setPower', on: true }),
      /lässt sich nicht schalten/,
    );
  });

  it('hat alle RPC-Aufrufe erfolgreich authentifiziert', () => {
    assert.ok(shellyState.authenticatedCalls > 3, 'Digest-Auth muss durchgehend greifen');
  });

  it('meldet ein falsches Passwort verständlich', async () => {
    const wrong: IntegrationContext = { ...ctx, secrets: { password: 'falsch' } };
    await assert.rejects(() => adapter.test(wrong), /Passwort/);
  });
});

describe('Hue-Adapter gegen eine simulierte Bridge', () => {
  const adapter = new HueAdapter();

  it('erkennt die Bridge anhand der öffentlichen Konfiguration', async () => {
    const config = await HueClient.fetchBridgeConfig(hueHost);
    assert.equal(config.bridgeid, '001788FFFE123456');
    assert.equal(config.modelid, 'BSB002');
  });

  it('verlangt den Druck auf den Link-Button', async () => {
    await assert.rejects(
      () => adapter.link({ host: hueHost }),
      (err: Error) => {
        assert.ok(err instanceof LinkButtonRequiredError);
        assert.match(err.message, /Knopf/);
        return true;
      },
    );
  });

  it('holt nach dem Knopfdruck den Application Key', async () => {
    hueState.linkButtonPressed = true;
    const result = await adapter.link({ host: hueHost, name: 'Wohnungs-Bridge' });

    assert.equal(result.name, 'Wohnungs-Bridge');
    assert.equal(result.externalId, '001788FFFE123456');
    assert.deepEqual(result.secrets, {
      applicationKey: 'mock-application-key',
      clientKey: 'MOCKCLIENTKEY',
    });
    assert.equal((result.config as { bridgeId: string }).bridgeId, '001788FFFE123456');
  });

  it('meldet fehlende Zugangsdaten, statt still zu scheitern', async () => {
    await assert.rejects(
      () =>
        adapter.test({
          integration: { id: 'int_x', name: 'Bridge' } as Integration,
          config: { host: hueHost, bridgeId: 'x' },
          secrets: null,
        }),
      /Application Key/,
    );
  });

  it('erkennt Nicht-Hue-Geräte', async () => {
    await assert.rejects(() => HueClient.fetchBridgeConfig(shellyHost, 2000));
  });
});
