/**
 * Das Wiki im Hub.
 *
 * Geprüft wird nicht die Darstellung, sondern das, woran ein Wiki scheitert:
 * eine Suche, die nichts findet; ein Artikel, auf den aus der Oberfläche
 * verwiesen wird, den es aber nicht gibt; und Auszeichnung, die sich in HTML
 * verwandeln lässt, statt darin zu landen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const wiki = await import('../public/js/wiki.js');
const { ARTICLES, markup, searchArticles } = wiki as unknown as {
  ARTICLES: Array<{
    id: string;
    title: string;
    icon: string;
    summary: string;
    sections: Array<{ heading: string; body: string[] }>;
  }>;
  markup: (text: string) => string;
  searchArticles: (articles: unknown[], needle: string) => unknown[];
};

describe('Wiki-Artikel', () => {
  it('hat für jeden Bereich des Hubs einen Artikel', () => {
    const ids = ARTICLES.map((article) => article.id);
    for (const expected of [
      'start',
      'geraete',
      'hue',
      'shelly',
      'fritzbox',
      'homematic',
      'dienste',
      'raeume',
      'automationen',
      'auswertung',
      'sicherung',
      'fehler',
    ]) {
      assert.ok(ids.includes(expected), `Artikel „${expected}" fehlt`);
    }
  });

  it('vergibt jede Kennung nur einmal', () => {
    const ids = ARTICLES.map((article) => article.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('gibt jedem Artikel Titel, Kurzfassung und Inhalt', () => {
    for (const article of ARTICLES) {
      assert.ok(article.title.length > 3, `${article.id}: Titel`);
      // Die Kurzfassung ist der Satz für alle, die den Rest nicht lesen.
      assert.ok(article.summary.length > 40, `${article.id}: Kurzfassung zu dünn`);
      assert.ok(article.sections.length > 0, `${article.id}: keine Abschnitte`);
      for (const section of article.sections) {
        assert.ok(section.heading.length > 2, `${article.id}: Überschrift`);
        assert.ok(section.body.length > 0, `${article.id}/${section.heading}: kein Text`);
      }
    }
  });

  it('erklärt die Stolpersteine, die wirklich auftreten', () => {
    const text = JSON.stringify(ARTICLES).toLowerCase();
    // Jeder dieser Punkte hat schon einmal jemanden aufgehalten.
    for (const topic of [
      'benutzername',
      'smart-home-geräte und automatisierung steuern',
      'app-passwort',
      'premium',
      'gruppe',
      'network host',
    ]) {
      assert.ok(text.includes(topic.toLowerCase()), `Das Wiki schweigt zu „${topic}"`);
    }
  });
});

describe('Wiki-Suche', () => {
  it('findet Artikel über Wörter aus dem Fließtext', () => {
    const hits = searchArticles(ARTICLES, 'kennwort') as Array<{ id: string }>;
    assert.ok(hits.some((article) => article.id === 'fritzbox'));
  });

  it('achtet nicht auf Groß- und Kleinschreibung', () => {
    const lower = searchArticles(ARTICLES, 'premium').length;
    const upper = searchArticles(ARTICLES, 'PREMIUM').length;
    assert.equal(lower, upper);
    assert.ok(lower > 0);
  });

  it('gibt ohne Suchbegriff alles zurück', () => {
    assert.equal(searchArticles(ARTICLES, '   ').length, ARTICLES.length);
  });

  it('gibt bei einem unbekannten Wort ehrlich nichts zurück', () => {
    assert.equal(searchArticles(ARTICLES, 'quastenflosser').length, 0);
  });
});

describe('Auszeichnung im Wiki', () => {
  it('macht aus Sternchen fett und aus Rückstrichen Code', () => {
    assert.equal(markup('**wichtig** und `code`'), '<b>wichtig</b> und <code>code</code>');
  });

  it('lässt HTML aus dem Text nicht durch', () => {
    // Der Text ist zwar von uns – aber eine Auszeichnung, die HTML durchreicht,
    // ist eine Einladung, HTML in die Artikel zu schreiben.
    assert.equal(markup('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('lässt gewöhnlichen Text in Ruhe', () => {
    assert.equal(markup('Einfach ein Satz.'), 'Einfach ein Satz.');
  });
});
