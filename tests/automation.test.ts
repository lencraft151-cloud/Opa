import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compare,
  isWithinTimeRange,
  localTime,
  localWeekday,
} from '../src/services/automationService.ts';
import { changedKeys, supports } from '../src/services/deviceService.ts';
import type { Device } from '../src/core/types.ts';

describe('Vergleichsoperatoren', () => {
  it('wertet alle Operatoren korrekt aus', () => {
    assert.equal(compare(18, '<', 19), true);
    assert.equal(compare(19, '<', 19), false);
    assert.equal(compare(19, '<=', 19), true);
    assert.equal(compare(20, '>', 19), true);
    assert.equal(compare(19, '>=', 19), true);
    assert.equal(compare(19, '==', 19), true);
    assert.equal(compare(19, '!=', 20), true);
  });
});

describe('Zeitfenster in der Zeitzone des Haushalts', () => {
  // 2026-08-07 12:30 UTC = 14:30 in Berlin (Sommerzeit)
  const date = new Date('2026-08-07T12:30:00Z');

  it('rechnet in die Zeitzone des Haushalts um', () => {
    assert.equal(localTime(date, 'Europe/Berlin'), '14:30');
    assert.equal(localTime(date, 'UTC'), '12:30');
  });

  it('erkennt einfache Zeitfenster', () => {
    assert.equal(isWithinTimeRange(date, 'Europe/Berlin', '06:00', '22:00'), true);
    assert.equal(isWithinTimeRange(date, 'Europe/Berlin', '15:00', '22:00'), false);
  });

  it('behandelt Fenster über Mitternacht', () => {
    assert.equal(isWithinTimeRange(date, 'Europe/Berlin', '22:00', '06:00'), false);
    const night = new Date('2026-08-07T23:30:00Z'); // 01:30 in Berlin
    assert.equal(isWithinTimeRange(night, 'Europe/Berlin', '22:00', '06:00'), true);
  });

  it('liefert den Wochentag als 0 = Sonntag', () => {
    assert.equal(localWeekday(new Date('2026-08-07T12:00:00Z'), 'Europe/Berlin'), 5); // Freitag
    assert.equal(localWeekday(new Date('2026-08-09T12:00:00Z'), 'Europe/Berlin'), 0); // Sonntag
  });

  it('berücksichtigt den Zeitzonenwechsel beim Wochentag', () => {
    // 23:30 UTC am Freitag ist in Berlin bereits Samstag.
    assert.equal(localWeekday(new Date('2026-08-07T23:30:00Z'), 'Europe/Berlin'), 6);
    assert.equal(localWeekday(new Date('2026-08-07T23:30:00Z'), 'UTC'), 5);
  });
});

describe('Fähigkeiten und Kommandos', () => {
  const device = (capabilities: Device['capabilities']): Device =>
    ({
      id: 'dev_1',
      capabilities,
      state: {},
    }) as Device;

  it('erlaubt nur passende Kommandos', () => {
    assert.equal(supports(device(['switch']), { type: 'setPower', on: true }), true);
    assert.equal(supports(device(['switch']), { type: 'setBrightness', brightness: 50 }), false);
    assert.equal(supports(device(['switch', 'dimmer']), { type: 'setBrightness', brightness: 50 }), true);
    assert.equal(supports(device(['cover']), { type: 'setPosition', position: 30 }), true);
  });

  it('lässt Identify für jedes Gerät zu', () => {
    assert.equal(supports(device([]), { type: 'identify' }), true);
  });
});

describe('Erkennung von Zustandsänderungen', () => {
  it('meldet nur tatsächlich geänderte Felder', () => {
    assert.deepEqual(changedKeys({ on: true, brightness: 50 }, { on: true, brightness: 50 }), []);
    assert.deepEqual(changedKeys({ on: true, brightness: 50 }, { brightness: 70 }), ['brightness']);
    assert.deepEqual(changedKeys({}, { on: false }), ['on']);
  });

  it('ignoriert den Zeitstempel', () => {
    assert.deepEqual(
      changedKeys({ on: true, updatedAt: 'a' }, { on: true, updatedAt: 'b' }),
      [],
    );
  });
});
