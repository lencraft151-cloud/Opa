/**
 * Angefangene Eingaben, die ein Neuladen überstehen.
 *
 * Zwei Dinge werden hier geprüft, und das zweite wiegt schwerer als das
 * erste: dass ein halb ausgefülltes Formular nach dem Neuladen wieder dasteht
 * – und dass Kennwörter dabei *nicht* dabei sind. Ein vergessener Raumname
 * kostet zehn Sekunden; ein Kennwort, das im Browser liegen bleibt, ist ein
 * Fehler anderer Art.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** Der Speicher, den der Browser sonst mitbringt. */
class FakeStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  get raw(): string {
    return JSON.stringify([...this.data.entries()]);
  }
}

const storage = new FakeStorage();
(globalThis as unknown as { sessionStorage: FakeStorage }).sessionStorage = storage;

/**
 * Eine Feld-Attrappe.
 *
 * Nur so viel DOM, wie der Entwurfsspeicher anfasst: Name, Typ, Wert und die
 * Frage, in welchem Kasten das Feld steckt.
 */
interface FakeField {
  tagName: string;
  type: string;
  name: string;
  id?: string;
  value: string;
  checked?: boolean;
  autocomplete?: string;
  dataset: Record<string, string>;
  closest(selector: string): { id: string } | null;
}

function field(options: Partial<FakeField> & { name: string }): FakeField {
  const scope = { id: (options as { scopeId?: string }).scopeId ?? 'form-test' };
  return {
    tagName: 'INPUT',
    type: 'text',
    value: '',
    dataset: {},
    ...options,
    closest: (selector: string) =>
      selector.includes('device-card') ? null : scope,
  } as FakeField;
}

function root(fields: FakeField[]) {
  return {
    querySelectorAll: (_selector: string) => ({
      forEach: (callback: (item: FakeField) => void) => fields.forEach(callback),
    }),
  };
}

const { fieldKey, rememberField, restoreDrafts, clearDrafts, forgetDrafts } = await import(
  '../public/js/drafts.js'
);

describe('Entwurfsspeicher', () => {
  beforeEach(() => forgetDrafts());

  it('merkt sich eine getippte Eingabe und setzt sie wieder ein', () => {
    const typed = field({ name: 'raumname', value: 'Wintergarten' });
    rememberField(typed);

    const fresh = field({ name: 'raumname' });
    assert.equal(restoreDrafts(root([fresh])), 1);
    assert.equal(fresh.value, 'Wintergarten');
  });

  it('speichert kein Kennwort – auch nicht kurz', () => {
    for (const secret of [
      field({ name: 'kennwort', type: 'password', value: 'geheim123' }),
      field({ name: 'app-passwort', value: 'abcd-efgh-ijkl' }),
      field({ name: 'token', value: 'BQD_xyz' }),
      field({ name: 'client-id', value: '0123456789abcdef' }),
      field({ name: 'egal', autocomplete: 'current-password', value: 'geheim' }),
    ]) {
      rememberField(secret);
    }

    assert.equal(storage.raw.includes('geheim'), false);
    assert.equal(storage.raw.includes('abcd-efgh-ijkl'), false);
    assert.equal(storage.raw.includes('BQD_xyz'), false);
    assert.equal(storage.raw.includes('0123456789abcdef'), false);
  });

  it('überschreibt nicht, was schon auf dem Bildschirm steht', () => {
    rememberField(field({ name: 'raumname', value: 'Wintergarten' }));

    const busy = field({ name: 'raumname', value: 'Küche' });
    assert.equal(restoreDrafts(root([busy])), 0);
    assert.equal(busy.value, 'Küche');
  });

  it('vergisst ein wieder geleertes Feld', () => {
    const typed = field({ name: 'raumname', value: 'Wintergarten' });
    rememberField(typed);
    typed.value = '';
    rememberField(typed);

    const fresh = field({ name: 'raumname' });
    assert.equal(restoreDrafts(root([fresh])), 0);
    assert.equal(fresh.value, '');
  });

  it('hält gleichnamige Felder aus verschiedenen Formularen auseinander', () => {
    const a = { ...field({ name: 'name', value: 'Wohnzimmer' }), closest: () => ({ id: 'form-raum' }) };
    const b = { ...field({ name: 'name', value: 'Abends' }), closest: () => ({ id: 'form-szene' }) };

    assert.notEqual(fieldKey(a as unknown as FakeField), fieldKey(b as unknown as FakeField));
  });

  it('merkt sich Schalter und Auswahllisten', () => {
    rememberField(field({ name: 'aktiv', type: 'checkbox', value: 'ja', checked: true }));
    rememberField({ ...field({ name: 'raum', value: 'kueche' }), tagName: 'SELECT' } as FakeField);

    const box = field({ name: 'aktiv', type: 'checkbox', value: 'ja', checked: false });
    const list = { ...field({ name: 'raum' }), tagName: 'SELECT' } as FakeField;
    assert.equal(restoreDrafts(root([box, list])), 2);
    assert.equal(box.checked, true);
    assert.equal(list.value, 'kueche');
  });

  it('fasst Gerätekarten nicht an', () => {
    const slider = {
      ...field({ name: 'helligkeit', value: '80' }),
      closest: (selector: string) => (selector.includes('device-card') ? { id: 'karte' } : null),
    } as FakeField;

    rememberField(slider);
    assert.equal(storage.raw.includes('helligkeit'), false);
  });

  it('vergisst ein Formular, sobald es abgeschickt ist', () => {
    const typed = field({ name: 'raumname', value: 'Wintergarten' });
    rememberField(typed);
    clearDrafts(root([typed]));

    const fresh = field({ name: 'raumname' });
    assert.equal(restoreDrafts(root([fresh])), 0);
  });

  it('vergibt ohne Namen keine Kennung', () => {
    assert.equal(fieldKey(field({ name: '' })), null);
    assert.equal(fieldKey(null), null);
  });
});
