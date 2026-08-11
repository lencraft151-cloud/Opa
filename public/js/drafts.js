/**
 * Angefangene Eingaben überleben ein Neuladen.
 *
 * Der Anlass ist eine alltägliche Ärgernis-Kette: Man tippt eine Adresse, eine
 * Automation, einen Raumnamen – und in dem Moment lädt die Oberfläche sich
 * neu, weil der Hub sich aktualisiert hat oder neu gestartet ist. Danach ist
 * das Formular leer, und alles muss noch einmal getippt werden.
 *
 * Dagegen hilft nur eines: Was jemand eintippt, wird sofort mitgeschrieben und
 * nach dem Neuladen wieder eingesetzt.
 *
 * Zwei Grenzen sind bewusst gezogen:
 *
 * - **Keine Passwörter.** Kennwörter, App-Passwörter und Token werden nie
 *   gespeichert – auch nicht „nur kurz". Ein Formular, das man einmal neu
 *   ausfüllt, ist besser als ein Kennwort, das im Browser liegen bleibt.
 * - **Keine Gerätezustände.** Ein Helligkeitsregler auf einer Gerätekarte
 *   zeigt, was die Lampe *tut*. Ihn wiederherzustellen hieße, einen alten
 *   Stand über die Wirklichkeit zu legen.
 *
 * Abgelegt wird in `sessionStorage`: Das überlebt genau das, worum es geht –
 * das Neuladen desselben Tabs – und verschwindet, wenn er zugeht.
 */

const PREFIX = 'entwurf:';

/** Felder, deren Inhalt nirgends zwischengespeichert wird. */
function isSecret(field) {
  if (field.type === 'password') return true;
  const name = `${field.name ?? ''} ${field.id ?? ''} ${field.autocomplete ?? ''}`.toLowerCase();
  return /pass|kennwort|secret|token|client-?id|clientid/.test(name);
}

/** Was überhaupt gemerkt wird. */
function isDraftable(field) {
  if (!field || !field.tagName) return false;
  const tag = field.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  if (field.type === 'file' || field.type === 'range' || field.type === 'hidden') return false;
  // Gerätekarten zeigen den Zustand des Geräts, keine Eingabe.
  if (field.closest?.('.device-card, .music-player')) return false;
  return !isSecret(field);
}

/**
 * Wiedererkennungsmerkmal eines Feldes.
 *
 * Bewusst aus Formular und Feldname zusammengesetzt statt aus einer Position:
 * Die Oberfläche zeichnet sich ständig neu, und ein „drittes Eingabefeld"
 * kann danach etwas ganz anderes sein.
 */
export function fieldKey(field) {
  if (!field?.tagName) return null;
  const form = field.closest('form, fieldset, .card, details');
  const scope = form?.id || form?.dataset?.section || form?.className || 'seite';
  const name = field.name || field.id || field.dataset?.field || '';
  if (!name) return null;
  const variant = field.type === 'checkbox' || field.type === 'radio' ? field.value : '';
  return `${scope}::${name}::${variant}`;
}

function read() {
  try {
    return JSON.parse(sessionStorage.getItem(PREFIX) ?? '{}');
  } catch {
    return {};
  }
}

function write(all) {
  try {
    sessionStorage.setItem(PREFIX, JSON.stringify(all));
  } catch {
    /* Voller oder gesperrter Speicher: dann eben ohne Entwürfe. */
  }
}

/** Merkt sich den Inhalt eines Feldes. */
export function rememberField(field) {
  const key = fieldKey(field);
  if (!key || !isDraftable(field)) return;

  const all = read();
  const value = field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value;

  // Leere Felder gar nicht erst merken – sonst überschriebe ein leerer
  // Entwurf beim Wiederherstellen einen sinnvollen Vorgabewert.
  if (value === '' || value === false) delete all[key];
  else all[key] = value;

  write(all);
}

/**
 * Setzt gemerkte Eingaben wieder ein.
 *
 * Nur in Felder, die der Nutzer nicht schon selbst gefüllt hat: Ein Entwurf
 * darf nichts überschreiben, was gerade auf dem Bildschirm steht.
 */
export function restoreDrafts(root = document) {
  const all = read();
  if (Object.keys(all).length === 0) return 0;

  let restored = 0;
  root.querySelectorAll('input, textarea, select').forEach((field) => {
    if (!isDraftable(field)) return;
    const key = fieldKey(field);
    if (key === null || !(key in all)) return;

    if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.checked === all[key]) return;
      field.checked = Boolean(all[key]);
    } else {
      if (field.value) return;
      field.value = String(all[key]);
    }
    restored += 1;
  });
  return restored;
}

/** Vergisst die Entwürfe eines Formulars – nach dem Absenden. */
export function clearDrafts(form) {
  const all = read();
  let changed = false;
  form.querySelectorAll('input, textarea, select').forEach((field) => {
    const key = fieldKey(field);
    if (key !== null && key in all) {
      delete all[key];
      changed = true;
    }
  });
  if (changed) write(all);
}

/** Alles vergessen – etwa nach dem Abmelden. */
export function forgetDrafts() {
  try {
    sessionStorage.removeItem(PREFIX);
  } catch {
    /* egal */
  }
}

/**
 * Hängt sich einmal an das Dokument.
 *
 * Über Delegation, nicht pro Formular: Die Oberfläche baut ihre Formulare
 * ständig neu auf, und ein Zuhörer je Feld wäre bei jedem Neuzeichnen erneut
 * anzubringen – und irgendwann vergessen.
 */
export function startDrafts() {
  document.addEventListener(
    'input',
    (event) => {
      if (event.target instanceof Element) rememberField(event.target);
    },
    true,
  );
  document.addEventListener(
    'change',
    (event) => {
      if (event.target instanceof Element) rememberField(event.target);
    },
    true,
  );
  document.addEventListener(
    'submit',
    (event) => {
      if (event.target instanceof HTMLFormElement) clearDrafts(event.target);
    },
    true,
  );
}
