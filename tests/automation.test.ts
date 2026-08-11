import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compare,
  isIntervalDue,
  isWithinTimeRange,
  localTime,
  localWeekday,
  undoCommand,
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

// ---------------------------------------------------------------------------
// Wiederholungen
// ---------------------------------------------------------------------------

describe('Wiederkehrende Automationen', () => {
  // 2026-08-07 ist ein Freitag; 12:30 UTC = 14:30 in Berlin.
  const now = new Date('2026-08-07T12:30:00Z');
  const berlin = 'Europe/Berlin';
  const friday = localWeekday(now, berlin);
  const minutes = (count: number) => now.getTime() - count * 60_000;

  it('löst aus, sobald der Takt verstrichen ist', () => {
    const trigger = { type: 'interval' as const, everyMinutes: 60 };
    assert.equal(isIntervalDue(trigger, minutes(59), now, berlin, friday), false);
    assert.equal(isIntervalDue(trigger, minutes(60), now, berlin, friday), true);
    assert.equal(isIntervalDue(trigger, minutes(600), now, berlin, friday), true);
  });

  it('läuft nach einem Neustart sofort einmal', () => {
    // Ohne gemerkte letzte Ausführung ist der Abstand unendlich groß.
    const trigger = { type: 'interval' as const, everyMinutes: 120 };
    assert.equal(isIntervalDue(trigger, 0, now, berlin, friday), true);
  });

  it('hält sich an das Zeitfenster', () => {
    const trigger = { type: 'interval' as const, everyMinutes: 30, from: '08:00', to: '12:00' };
    // 14:30 Ortszeit liegt außerhalb – auch wenn der Takt längst um ist.
    assert.equal(isIntervalDue(trigger, minutes(600), now, berlin, friday), false);

    const evening = { ...trigger, from: '14:00', to: '22:00' };
    assert.equal(isIntervalDue(evening, minutes(600), now, berlin, friday), true);
  });

  it('rechnet das Zeitfenster in der Zeitzone des Haushalts', () => {
    const trigger = { type: 'interval' as const, everyMinutes: 30, from: '12:00', to: '13:00' };
    // In UTC wäre es 12:30 und damit im Fenster, in Berlin ist es 14:30.
    assert.equal(isIntervalDue(trigger, minutes(600), now, berlin, friday), false);
    assert.equal(isIntervalDue(trigger, minutes(600), now, 'UTC', localWeekday(now, 'UTC')), true);
  });

  it('beachtet ausgewählte Wochentage', () => {
    const werktags = { type: 'interval' as const, everyMinutes: 30, days: [1, 2, 3, 4, 5] };
    assert.equal(isIntervalDue(werktags, minutes(600), now, berlin, friday), true);

    const wochenende = { type: 'interval' as const, everyMinutes: 30, days: [0, 6] };
    assert.equal(isIntervalDue(wochenende, minutes(600), now, berlin, friday), false);
  });

  it('nimmt eine leere Tagesliste als „jeden Tag"', () => {
    const trigger = { type: 'interval' as const, everyMinutes: 30, days: [] };
    assert.equal(isIntervalDue(trigger, minutes(600), now, berlin, friday), true);
  });

  it('holt nach dem Zeitfenster nichts nach', () => {
    // Während des Fensters läuft die Zeit weiter; danach löst die Regel
    // einmal aus, nicht so oft, wie sie es "verpasst" hat.
    const trigger = { type: 'interval' as const, everyMinutes: 60, from: '14:00', to: '22:00' };
    assert.equal(isIntervalDue(trigger, minutes(480), now, berlin, friday), true);
  });
});

describe('Kommandos, die sich selbst zurücknehmen', () => {
  /*
   * Für „alle 20 Sekunden das Licht für 10 Sekunden an" braucht es das
   * Gegenteil eines Kommandos. Nur dort, wo es eindeutig ist – für eine
   * Helligkeit wäre das Gegenteil der vorherige Wert, und den müsste man
   * raten. Lieber keine Rücknahme als eine falsche.
   */
  it('kehrt Ein/Aus und Auf/Zu um', () => {
    assert.deepEqual(undoCommand({ type: 'setPower', on: true }), { type: 'setPower', on: false });
    assert.deepEqual(undoCommand({ type: 'setPower', on: false }), { type: 'setPower', on: true });
    assert.deepEqual(undoCommand({ type: 'openCover' }), { type: 'closeCover' });
    assert.deepEqual(undoCommand({ type: 'closeCover' }), { type: 'openCover' });
  });

  it('lässt alles andere in Ruhe', () => {
    assert.equal(undoCommand({ type: 'setBrightness', brightness: 40 }), null);
    assert.equal(undoCommand({ type: 'setTargetTemperature', targetTemperatureC: 21 }), null);
    assert.equal(undoCommand({ type: 'setPosition', position: 50 }), null);
  });
});
