import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AppError,
  badRequest,
  describeNetworkError,
  errorSummary,
  notFound,
  unauthorized,
} from '../src/core/errors.ts';

describe('Fehlerobjekte', () => {
  it('nimmt einen Handlungshinweis auf und gibt ihn aus', () => {
    const error = badRequest('Der Strompreis darf nicht negativ sein.', { field: 'pricePerKwh' }, 'Trage z. B. 0.35 ein.');
    assert.equal(error.status, 400);
    assert.deepEqual(error.toJSON(), {
      code: 'bad_request',
      message: 'Der Strompreis darf nicht negativ sein.',
      hint: 'Trage z. B. 0.35 ein.',
      details: { field: 'pricePerKwh' },
    });
  });

  it('lässt leere Felder in der Ausgabe weg', () => {
    const error = new AppError(500, 'internal_error', 'Kaputt');
    assert.deepEqual(error.toJSON(), { code: 'internal_error', message: 'Kaputt' });
  });

  it('gibt Anmeldefehlern einen brauchbaren Standardhinweis', () => {
    assert.match(unauthorized().hint ?? '', /Authorization: Bearer/);
  });

  it('fasst Meldung und Hinweis für Logs zusammen', () => {
    assert.equal(
      errorSummary(notFound('Raum room_1', 'Prüfe die ID.')),
      'Raum room_1 wurde nicht gefunden – Prüfe die ID.',
    );
    assert.equal(errorSummary(new Error('schlicht')), 'schlicht');
    assert.equal(errorSummary('Text'), 'Text');
  });
});

describe('Netzwerkfehler in Klartext übersetzen', () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ['ECONNREFUSED', /nimmt keine Verbindung an/, /Neustart|AP-Modus/],
    ['EHOSTUNREACH', /nicht erreichbar/, /network host/],
    ['ENOTFOUND', /nicht auflösen/, /feste IP-Adresse/],
    ['ETIMEDOUT', /antwortet nicht/, /Batteriesensoren|Taste/],
    ['ECONNRESET', /Verbindung abgebrochen/, /nächsten Durchlauf/],
  ];

  for (const [code, messagePattern, hintPattern] of cases) {
    it(`erklärt ${code} verständlich`, () => {
      const error = describeNetworkError(code, '192.168.1.42');
      assert.match(error.message, messagePattern);
      assert.match(error.hint ?? '', hintPattern);
      assert.ok(error.message.includes('192.168.1.42'), 'die Adresse steht in der Meldung');
      assert.ok(!error.message.includes(code), 'der rohe Fehlercode taucht nicht in der Meldung auf');
    });
  }

  it('setzt für Zeitüberschreitungen den passenden Status', () => {
    assert.equal(describeNetworkError('ETIMEDOUT', 'host').status, 504);
    assert.equal(describeNetworkError('ECONNREFUSED', 'host').status, 502);
  });

  it('bleibt auch bei unbekannten Codes verständlich', () => {
    const error = describeNetworkError('EWEIRD', 'shelly.local');
    assert.match(error.message, /Verbindung zu shelly.local ist fehlgeschlagen/);
    assert.equal(error.code, 'upstream_error');
  });

  it('kommt ohne Code zurecht', () => {
    assert.ok(describeNetworkError(undefined, 'host') instanceof AppError);
  });
});
