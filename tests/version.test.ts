/**
 * Die Fassung steht an drei Stellen – und muss überall dieselbe sein.
 *
 * `src/version.ts` ist die, die der Hub ausliefert; `package.json` die, mit
 * der er installiert wird; `CHANGELOG.md` die, die erklärt, was drin ist.
 * Driften sie auseinander, ist der Schaden nicht bloß kosmetisch: Die
 * Aktualisierungsprüfung vergleicht die ausgelieferte Fassung mit den
 * Überschriften im Änderungsprotokoll. Hinkt `version.ts` hinterher, hält der
 * Hub seinen eigenen Stand für ein verfügbares Update und bietet an, sich
 * selbst zu installieren.
 *
 * Genau das ist einmal passiert. Deshalb dieser Test.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
  return pkg.version;
}

function changelogVersions(): string[] {
  const text = readFileSync(`${root}CHANGELOG.md`, 'utf8');
  return [...text.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((match) => match[1] as string);
}

describe('Fassung des Hubs', () => {
  it('stimmt mit package.json überein', () => {
    assert.equal(
      VERSION,
      packageVersion(),
      'src/version.ts und package.json nennen verschiedene Fassungen',
    );
  });

  it('hat einen Abschnitt im Änderungsprotokoll', () => {
    const versions = changelogVersions();
    assert.ok(
      versions.includes(VERSION),
      `CHANGELOG.md hat keinen Abschnitt „## ${VERSION}"`,
    );
  });

  it('steht im Änderungsprotokoll ganz oben', () => {
    // Der Hub zeigt beim Aktualisieren den Abschnitt der neuesten Fassung.
    assert.equal(changelogVersions()[0], VERSION);
  });

  it('nennt jede Fassung nur einmal', () => {
    const versions = changelogVersions();
    assert.equal(new Set(versions).size, versions.length);
  });

  it('zählt im Änderungsprotokoll abwärts', () => {
    const versions = changelogVersions().map((v) => v.split('.').map(Number));
    for (let i = 1; i < versions.length; i++) {
      const newer = versions[i - 1] as number[];
      const older = versions[i] as number[];
      const compare =
        (newer[0] as number) - (older[0] as number) ||
        (newer[1] as number) - (older[1] as number) ||
        (newer[2] as number) - (older[2] as number);
      assert.ok(compare > 0, `Fassung ${older.join('.')} steht über ${newer.join('.')}`);
    }
  });
});
