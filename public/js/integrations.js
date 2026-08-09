/**
 * Integrationen finden und verbinden.
 *
 * Wird an zwei Stellen gebraucht: im Einrichtungsassistenten und später in
 * den Einstellungen, wenn eine Bridge dazukommt. Beide Stellen sollen sich
 * gleich verhalten – deshalb steht die Logik hier und nicht zweimal.
 */

import { api, guard, toast } from './api.js';
import { emptyState } from './components.js';
import { esc, plural, VENDOR_LABEL } from './format.js';

/** Was welcher Hersteller zum Verbinden braucht. */
export const INTEGRATION_HINTS = {
  hue: {
    label: 'Philips Hue Bridge',
    password: 'Passwort (bei Hue nicht nötig)',
    hint: 'Die Hue Bridge braucht kein Passwort – dort genügt der runde Knopf auf dem Gerät. Auch alte, runde Bridges der ersten Generation werden unterstützt.',
    needsUsername: false,
  },
  shelly: {
    label: 'Shelly',
    password: 'Passwort (nur geschützte Shellys)',
    hint: 'Ein Shelly ist nur dann passwortgeschützt, wenn du das in seiner App eingerichtet hast. Alte Gen1-Geräte und neue Gen2/Gen3-Geräte funktionieren beide.',
    needsUsername: false,
  },
  homematic: {
    label: 'Homematic CCU / RaspberryMatic',
    password: 'Passwort',
    hint: 'Benutzername und Passwort sind dieselben wie in der CCU-Weboberfläche. Der Benutzer braucht Administratorrechte; ohne Eintrag versucht der Hub „Admin“.',
    needsUsername: true,
  },
  fritzbox: {
    label: 'FRITZ!Box (experimentell)',
    password: 'Passwort',
    hint: 'Nimm einen Benutzer aus der Box unter „System → FRITZ!Box-Benutzer" mit der Berechtigung „Smart-Home-Geräte steuern". Als Adresse funktioniert meist fritz.box. Diese Integration ist neu und weniger erprobt als die anderen.',
    needsUsername: true,
    experimental: true,
  },
};

/** Ein Fundstück aus der Netzwerksuche. */
export function discoveryItem(entry) {
  const notes = [
    esc(entry.host),
    esc(entry.model || 'Modell unbekannt'),
    `gefunden per ${esc(entry.source)}`,
  ];
  if (entry.requiresLinkButton) notes.push('<strong>Knopf auf der Bridge drücken</strong>');
  if (entry.authRequired) notes.push('Anmeldung nötig');

  return `<div class="item">
    <div>
      <div class="title">${esc(entry.name)}
        <span class="badge">${esc(VENDOR_LABEL[entry.type] ?? entry.type)}</span>
      </div>
      <div class="sub">${notes.join(' · ')}</div>
    </div>
    ${
      entry.alreadyLinked
        ? '<span class="badge ok">bereits verbunden</span>'
        : `<button class="primary" data-connect="${esc(entry.host)}" data-type="${esc(entry.type)}"
             data-auth="${entry.authRequired ? '1' : ''}">Verbinden</button>`
    }
  </div>`;
}

/**
 * Sucht im Netz und zeigt jeden Treffer sofort.
 *
 * Die Wartezeit selbst lässt sich nur begrenzt verkürzen: Eine mDNS-Suche
 * muss die volle Zeit lauschen, wenn auf einen Diensttyp niemand antwortet.
 * Was sich ändern lässt, ist der Eindruck – und der war der eigentliche
 * Fehler. Ein Kasten, in dem fünf Sekunden lang „Suche läuft…" steht und
 * sonst nichts, sieht aus wie ein Hänger. Jetzt erscheint das erste Gerät
 * nach Bruchteilen einer Sekunde, und darunter steht, auf wen noch gewartet
 * wird.
 *
 * @param {HTMLElement} target
 * @param {boolean} scan Auch das Netz abklopfen (findet stumme Geräte).
 * @param {() => Promise<void>} onConnected
 */
export function runDiscovery(target, scan, onConnected) {
  const found = new Map();
  const started = Date.now();
  let stream;

  const seconds = () => `${Math.round((Date.now() - started) / 100) / 10} s`;

  const render = (status) => {
    const list = [...found.values()].map(discoveryItem).join('');
    target.innerHTML = `${list}${status}`;
    target.querySelectorAll('[data-connect]').forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = 'yes';
      button.addEventListener('click', () => void connectFound(button, onConnected));
    });
  };

  /*
   * Die Uhr läuft weiter, auch wenn gerade nichts passiert.
   *
   * Zwischen zwei Meldungen liegen mehrere Sekunden – eine stehende Anzeige
   * sieht darin genauso aus wie ein Hänger. Eine Zahl, die sich bewegt, ist
   * der Unterschied zwischen „es arbeitet" und „es ist abgestürzt".
   */
  const ticker = setInterval(() => {
    const clock = target.querySelector('[data-elapsed]');
    if (clock) clock.textContent = seconds();
  }, 200);

  const searching = (message) =>
    `<div class="item searching">
       <div>
         <div class="title"><span class="spinner" aria-hidden="true"></span>
           Suche läuft… <span data-elapsed>${esc(seconds())}</span></div>
         <div class="sub">${esc(message)}</div>
       </div>
       <button class="small" data-stop-discovery>Abbrechen</button>
     </div>`;

  render(
    searching(
      scan
        ? 'Der Hub klopft zuerst ab, welche Adressen im Netz belegt sind.'
        : 'Der Hub horcht ins Netz.',
    ),
  );

  const stop = () => {
    clearInterval(ticker);
    stream?.close();
    render('');
  };

  const wireStop = () => {
    target.querySelector('[data-stop-discovery]')?.addEventListener('click', stop);
  };
  wireStop();

  stream = new EventSource(`/api/integrations/discover/stream?scan=${scan ? 'true' : 'false'}`);

  stream.addEventListener('found', (event) => {
    const { entry } = JSON.parse(event.data);
    found.set(`${entry.type}:${entry.host}`, entry);
    render(searching(`${plural(found.size, 'Gerät gefunden', 'Geräte gefunden')} – es läuft weiter.`));
    wireStop();
  });

  stream.addEventListener('progress', (event) => {
    const { pending, message } = JSON.parse(event.data);
    if (pending.length === 0) return;
    render(
      searching(
        `${message} · es fehlen noch: ${pending
          .map((type) => VENDOR_LABEL[type] ?? type)
          .join(', ')}`,
      ),
    );
    wireStop();
  });

  stream.addEventListener('done', () => {
    clearInterval(ticker);
    stream.close();
    if (found.size > 0) {
      render(
        `<p class="muted small">${plural(
          found.size,
          'Gerät gefunden',
          'Geräte gefunden',
        )} in ${seconds()}.</p>`,
      );
      return;
    }
    target.innerHTML = emptyState(
      '🔍',
      'Nichts gefunden.',
      scan
        ? 'Auch das Abklopfen des Netzes war leer. Läuft der Hub im selben Netz wie deine Geräte? In Docker braucht er "--network host".'
        : 'Versuche es mit „Gründlich suchen“ – oder trage die IP-Adresse unten manuell ein.',
    );
  });

  stream.onerror = () => {
    clearInterval(ticker);
    stream.close();
    // Kein `done` mehr zu erwarten – zeigen, was da ist, statt hängen zu bleiben.
    render(
      found.size > 0
        ? `<p class="muted small">Verbindung zur Suche abgebrochen – ${plural(
            found.size,
            'Gerät',
            'Geräte',
          )} bis dahin gefunden.</p>`
        : '<p class="muted small">Die Suche wurde unterbrochen. Versuche es noch einmal.</p>',
    );
  };
}

/** Verbindet ein gefundenes Gerät und fragt dabei nach Anmeldedaten. */
export async function connectFound(button, onConnected) {
  const body = { type: button.dataset.type, host: button.dataset.connect, importRooms: true };

  if (button.dataset.auth) {
    // Zentralen kennen Benutzerkonten, ein Shelly nur ein Passwort.
    if (INTEGRATION_HINTS[body.type]?.needsUsername) {
      const isFritz = body.type === 'fritzbox';
      const username = prompt(
        isFritz
          ? `Benutzername der FRITZ!Box ${body.host} (aus „System → FRITZ!Box-Benutzer"):`
          : `Benutzername der Zentrale ${body.host} (wie in der CCU-Weboberfläche):`,
        isFritz ? '' : 'Admin',
      );
      if (username === null) return;
      body.username = username.trim() || (isFritz ? '' : 'Admin');
    }
    const password = prompt(
      body.username
        ? `Passwort für ${body.username} auf ${body.host}:`
        : `Passwort für ${body.host}:`,
    );
    if (password === null) return;
    body.password = password;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Verbinde…';

  const result = await connect(body);

  button.disabled = false;
  button.textContent = label;
  if (result) await onConnected?.();
}

/** Legt eine Integration an und meldet den Erfolg verständlich. */
export async function connect(body) {
  const result = await guard(() => api('/integrations', { method: 'POST', body }));
  if (!result) return null;
  toast(`${result.integration.name} verbunden.`, {
    kind: 'success',
    hint: `${plural(result.devices.length, 'Gerät', 'Geräte')} übernommen.`,
  });
  return result;
}

/**
 * Bogen für die Eingabe von Hand.
 * @param {string} id Kennung des Formulars – die Seite kann mehrere haben.
 */
export function manualForm(id) {
  const types = Object.entries(INTEGRATION_HINTS)
    .map(([type, info]) => `<option value="${esc(type)}">${esc(info.label)}</option>`)
    .join('');

  return `<form class="form" id="${esc(id)}">
    <div class="field-row">
      <label>Typ <select name="type">${types}</select></label>
      <label>IP-Adresse
        <input name="host" required placeholder="192.168.1.42" inputmode="decimal" />
      </label>
    </div>
    <div class="field-row">
      <label>Anzeigename (optional)
        <input name="name" maxlength="120" placeholder="z. B. Shelly Bad" />
      </label>
      <label data-for-username hidden>Benutzername
        <input name="username" maxlength="64" placeholder="Admin" autocomplete="username" />
      </label>
      <label><span data-password-label>Passwort</span>
        <input name="password" type="password" autocomplete="off" />
      </label>
    </div>
    <p class="field-help" data-type-hint></p>
    <button type="submit" class="primary">Verbinden</button>
  </form>`;
}

/**
 * Verdrahtet einen Bogen aus `manualForm`.
 * @param {HTMLFormElement} form
 * @param {() => Promise<void>} onConnected
 */
export function bindManualForm(form, onConnected) {
  const select = form.querySelector('[name="type"]');

  const sync = () => {
    const info = INTEGRATION_HINTS[select.value] ?? INTEGRATION_HINTS.shelly;
    const label = form.querySelector('[data-password-label]');
    const hint = form.querySelector('[data-type-hint]');
    if (label) label.textContent = info.password;
    if (hint) hint.textContent = info.hint;
    // Nur Zentralen mit Benutzerkonten fragen nach einem Namen.
    form.querySelectorAll('[data-for-username]').forEach((element) => {
      element.hidden = !info.needsUsername;
    });
  };

  select.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = {
      type: data.get('type'),
      host: String(data.get('host')).trim(),
      importRooms: true,
    };
    const name = String(data.get('name') || '').trim();
    const password = String(data.get('password') || '');
    const username = String(data.get('username') || '').trim();
    if (name) body.name = name;
    if (password) body.password = password;
    if (INTEGRATION_HINTS[body.type]?.needsUsername) body.username = username;

    const result = await connect(body);
    if (!result) return;
    form.reset();
    sync();
    await onConnected?.();
  });
}
