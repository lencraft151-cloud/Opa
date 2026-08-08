/**
 * Selbstaktualisierung der Weboberfläche.
 *
 * Der Hub liefert unter `/api/system/info` eine Kennung (`build`) der
 * ausgelieferten Dateien mit. Ändert sie sich, liegt eine neue Fassung der
 * Oberfläche auf dem Server – der Browser hält aber noch die alte fest, im
 * eigenen Zwischenspeicher und im Service Worker.
 *
 * Diese Datei erkennt das und lädt die Oberfläche neu: still, wenn niemand
 * hinschaut, mit kurzer Vorwarnung, wenn jemand davorsitzt, und gar nicht,
 * solange gerade getippt wird.
 */

import { toast } from './api.js';

/** Wie oft nachgesehen wird, solange die Seite sichtbar ist. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Vorlauf, bevor sichtbar neu geladen wird. */
const COUNTDOWN_SECONDS = 8;
/** Abstand, in dem bei laufender Eingabe erneut angefragt wird. */
const BUSY_RETRY_MS = 5000;

let knownBuild = null;
let reloading = false;
/** Neue Fassung erkannt, aber noch nicht angewendet. */
let pending = false;

/**
 * @param {string} build Kennung beim Laden der Seite.
 */
export function startSelfUpdate(build) {
  knownBuild = build ?? null;

  setInterval(() => {
    if (!document.hidden) void check();
  }, CHECK_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    // Beim Weggehen ist der beste Zeitpunkt: Niemand sieht das Neuladen.
    if (document.hidden) {
      if (pending) void applyUpdate({ silent: true });
      return;
    }
    void check();
  });

  watchServiceWorker();
}

/** Fragt den Hub, ob eine neue Fassung bereitliegt. */
export async function check() {
  if (reloading || pending) return pending;
  try {
    // Bewusst am Zwischenspeicher vorbei – sonst beantwortet der Service
    // Worker die Frage nach der neuen Fassung mit der alten Antwort.
    const response = await fetch('/api/system/info', { cache: 'no-store' });
    if (!response.ok) return false;
    const info = await response.json();
    if (!info?.build) return false;

    if (knownBuild === null) {
      knownBuild = info.build;
      return false;
    }
    if (info.build === knownBuild) return false;

    pending = true;
    announce();
    return true;
  } catch {
    // Kein Netz: dann gibt es auch nichts zu holen.
    return false;
  }
}

/** Kündigt das Neuladen an – oder wartet, bis der Moment passt. */
function announce() {
  if (document.hidden) {
    void applyUpdate({ silent: true });
    return;
  }

  if (isBusy()) {
    // Wer gerade tippt, wird nicht unterbrochen.
    setTimeout(() => {
      if (pending) announce();
    }, BUSY_RETRY_MS);
    return;
  }

  let remaining = COUNTDOWN_SECONDS;
  const describe = () => `Wird in ${remaining} Sekunden geladen – tippen, um sofort zu laden.`;

  const node = toast('Neue Fassung der Oberfläche', {
    kind: 'success',
    hint: describe(),
    timeout: (COUNTDOWN_SECONDS + 2) * 1000,
  });
  const hint = node.querySelector('.toast-hint');

  const countdown = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdown);
      void applyUpdate({ silent: false });
      return;
    }
    if (hint) hint.textContent = describe();
  }, 1000);

  node.addEventListener('click', () => {
    clearInterval(countdown);
    void applyUpdate({ silent: false });
  });
}

/** Verwirft die zwischengespeicherte App-Hülle und lädt neu. */
export async function applyUpdate({ silent } = { silent: false }) {
  if (reloading) return;
  reloading = true;
  pending = false;

  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    await registration?.update?.();
    /*
     * Der Service Worker hält die alten Dateien fest. Ohne Leeren bekäme
     * der Browser nach dem Neuladen wieder genau dieselbe Fassung – die
     * Seite würde sich „aktualisieren“, ohne sich zu ändern.
     */
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    /* Ohne Service Worker genügt das Neuladen. */
  }

  if (!silent) await new Promise((resolve) => setTimeout(resolve, 150));
  location.reload();
}

/**
 * Übernimmt ein Service Worker die Seite, während sie läuft, sind die
 * geladenen Dateien und der neue Worker möglicherweise nicht mehr
 * derselbe Stand. Beim allerersten Start ist das normal – dann gab es
 * vorher keinen Worker und es gibt nichts neu zu laden.
 */
function watchServiceWorker() {
  const container = navigator.serviceWorker;
  if (!container?.addEventListener) return;
  const hadController = Boolean(container.controller);
  container.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
}

/** Tippt gerade jemand? Dann wird ihm nichts unter den Händen weggezogen. */
function isBusy() {
  const element = document.activeElement;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || element.isContentEditable;
}
