import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { enumerateHosts, isIPv4, isPrivateIPv4, reachableHosts } from '../src/util/net.js';

/**
 * Der zweite Durchgang ist die Antwort auf ein Ärgernis, das sich schlecht
 * beschreiben lässt: „Manchmal muss ich fünfmal suchen, bis alles da ist."
 *
 * Dahinter steckt kein Zufall, sondern eine Frist. Ein Gerät im WLAN, das
 * gerade aufwacht, antwortet nicht in 400 ms – beim nächsten Versuch schon.
 * Ein echtes Netz lässt sich dafür nicht herstellen, deshalb wird hier der
 * Abklopfer selbst eingesetzt: Er weiß, wie lange jedes Gerät braucht.
 */
function slowHosts(latency: Record<string, number>, log: string[][]) {
  return async (host: string, _ports: number[], timeoutMs: number): Promise<boolean> => {
    log.push([host, String(timeoutMs)]);
    const needs = latency[host];
    return needs !== undefined && needs <= timeoutMs;
  };
}

describe('Erreichbare Adressen', () => {
  test('findet im zweiten Durchgang, wer beim ersten zu langsam war', async () => {
    const log: string[][] = [];
    const found = await reachableHosts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], {
      timeoutMs: 400,
      retryTimeoutMs: 1200,
      probe: slowHosts({ '10.0.0.1': 50, '10.0.0.2': 900 }, log),
    });

    // Die träge .2 fehlte bei 400 ms und ist trotzdem in der Liste.
    assert.deepEqual(found, ['10.0.0.1', '10.0.0.2']);
  });

  test('klopft nur die Schweiger ein zweites Mal ab', async () => {
    const log: string[][] = [];
    await reachableHosts(['10.0.0.1', '10.0.0.2', '10.0.0.3'], {
      timeoutMs: 400,
      retryTimeoutMs: 1200,
      probe: slowHosts({ '10.0.0.1': 50, '10.0.0.2': 900 }, log),
    });

    const second = log.filter(([, budget]) => budget === '1200').map(([host]) => host);
    // .1 hat sofort geantwortet und wird nicht noch einmal behelligt.
    assert.deepEqual(second.sort(), ['10.0.0.2', '10.0.0.3']);
    assert.equal(log.length, 5);
  });

  test('spart sich den zweiten Durchgang, wenn alle geantwortet haben', async () => {
    const log: string[][] = [];
    const found = await reachableHosts(['10.0.0.1', '10.0.0.2'], {
      timeoutMs: 400,
      retryTimeoutMs: 1200,
      probe: slowHosts({ '10.0.0.1': 10, '10.0.0.2': 20 }, log),
    });

    assert.deepEqual(found, ['10.0.0.1', '10.0.0.2']);
    assert.equal(log.length, 2);
  });

  test('lässt den zweiten Durchgang aus, wenn er nichts Neues brächte', async () => {
    const log: string[][] = [];
    await reachableHosts(['10.0.0.1'], {
      timeoutMs: 800,
      retryTimeoutMs: 800,
      probe: slowHosts({}, log),
    });

    // Gleiche Frist heißt gleiches Ergebnis – das wäre nur verlorene Zeit.
    assert.equal(log.length, 1);
  });

  test('gibt die Treffer sortiert und ohne Dubletten zurück', async () => {
    const log: string[][] = [];
    const found = await reachableHosts(['10.0.0.9', '10.0.0.2', '10.0.0.9'], {
      timeoutMs: 400,
      probe: slowHosts({ '10.0.0.9': 10, '10.0.0.2': 10 }, log),
    });

    assert.deepEqual(found, ['10.0.0.2', '10.0.0.9']);
  });
});

describe('Adressrechnerei', () => {
  test('zählt ein /24 ohne Netz-, Broadcast- und eigene Adresse auf', () => {
    const hosts = enumerateHosts({
      interfaceName: 'eth0',
      address: '192.168.178.42',
      netmask: '255.255.255.0',
      cidr: 24,
      hostCount: 254,
    });

    assert.equal(hosts.length, 253);
    assert.ok(!hosts.includes('192.168.178.42'));
    assert.ok(!hosts.includes('192.168.178.0'));
    assert.ok(!hosts.includes('192.168.178.255'));
    assert.equal(hosts[0], '192.168.178.1');
  });

  test('begrenzt ein zu großes Netz auf das eigene /24', () => {
    const hosts = enumerateHosts({
      interfaceName: 'eth0',
      address: '10.1.2.3',
      netmask: '255.255.0.0',
      cidr: 16,
      hostCount: 65534,
    });

    assert.equal(hosts.length, 253);
    assert.ok(hosts.every((host) => host.startsWith('10.1.2.')));
  });

  test('erkennt private Adressen', () => {
    assert.ok(isPrivateIPv4('192.168.178.1'));
    assert.ok(isPrivateIPv4('10.0.0.1'));
    assert.ok(isPrivateIPv4('172.16.0.1'));
    assert.ok(!isPrivateIPv4('8.8.8.8'));
    assert.ok(!isPrivateIPv4('kein.host'));
  });

  test('unterscheidet Adresse und Name', () => {
    assert.ok(isIPv4('192.168.1.1'));
    assert.ok(!isIPv4('fritz.box'));
    assert.ok(!isIPv4('192.168.1.256'));
  });
});
