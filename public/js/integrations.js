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
  sonos: {
    label: 'Sonos-Lautsprecher',
    password: 'Passwort (bei Sonos nicht nötig)',
    hint: 'Sonos braucht kein Konto und kein Passwort – der Lautsprecher steht im eigenen Netz. Gefunden wird er normalerweise von allein; die Adresse steht in der Sonos-App unter Einstellungen → System → Produkte → Netzwerk.',
    needsUsername: false,
  },
  fritzbox: {
    label: 'FRITZ!Box',
    password: 'Passwort der Box',
    hint: 'Das Kennwort der Box-Oberfläche genügt: Den Benutzernamen holt sich der Hub bei der Box selbst – auch Boxen mit „Anmeldung nur mit Kennwort" haben intern einen (er heißt dann etwa fritz3000). Nur wenn dort mehrere Konten angelegt sind, muss der Name eingetragen werden, und das gewählte Konto braucht die Berechtigung „Smart-Home-Geräte und Automatisierung steuern". Als Adresse funktioniert meist fritz.box.',
    // Optional, nicht Pflicht: Viele Boxen sind auf „Anmeldung nur mit
    // Passwort" eingestellt, und dann gibt es gar keinen Namen einzutragen.
    needsUsername: false,
    optionalUsername: true,
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
/**
 * Was frühere Suchläufe schon gefunden haben.
 *
 * Der Grund für diesen Speicher ist eine Klage, die genau ins Schwarze traf:
 * „Ich muss fünfmal gründlich suchen, bis alles da ist." Eine Suchanfrage ist
 * ein einzelnes UDP-Paket; geht es verloren, schweigt das Gerät – und beim
 * nächsten Lauf fehlt dafür ein anderes. Jeder Lauf für sich ist unvollständig,
 * aber zusammen ergeben sie ein vollständiges Bild.
 *
 * Also wirft die Oberfläche nichts mehr weg: Ein neuer Lauf ergänzt, was schon
 * da war, statt die Liste zu leeren. Wer die Adresse eines Geräts einmal
 * gesehen hat, sieht sie auch beim nächsten Mal.
 */
const seenBefore = new Map();

export function forgetDiscovered() {
  seenBefore.clear();
}

export function runDiscovery(target, scan, onConnected) {
  const found = new Map(seenBefore);
  const started = Date.now();
  let stream;

  const seconds = () => `${Math.round((Date.now() - started) / 100) / 10} s`;

  const render = (status) => {
    const list = [...found.values()].map(discoveryItem).join('');
    target.innerHTML = `${list}${connectAllBar()}${status}`;
    target.querySelectorAll('[data-connect]').forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = 'yes';
      button.addEventListener('click', () => void connectFound(button, onConnected));
    });
    target.querySelector('[data-connect-all]')?.addEventListener('click', (event) => {
      void connectAll(event.currentTarget, [...found.values()], onConnected);
    });
  };

  /**
   * „Mit allem verbinden" – aber nur dort, wo das ohne Rückfrage geht.
   *
   * Alles, was ein Passwort braucht, bleibt außen vor: Ein Sammelknopf, der
   * fünfmal hintereinander nach Kennwörtern fragt, ist kein Sammelknopf. Die
   * Hue Bridge ist dabei, denn dort ist der „Schlüssel" der Knopf am Gerät.
   */
  const connectAllBar = () => {
    const open = [...found.values()].filter(
      (entry) => !entry.alreadyLinked && !entry.authRequired,
    );
    if (open.length < 2) return '';
    return `<div class="row tight" style="margin:.6rem 0">
      <button class="primary" data-connect-all>Mit allen ${open.length} verbinden</button>
      <span class="muted small">Ohne Rückfrage – geschützte Geräte bleiben einzeln.</span>
    </div>`;
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
    const key = `${entry.type}:${entry.host}`;
    found.set(key, entry);
    // Auch für den nächsten Lauf merken – siehe `seenBefore`.
    seenBefore.set(key, entry);
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
      const fresh = [...found.values()].filter((entry) => entry.source !== 'zuvor').length;
      render(
        `<p class="muted small">${plural(
          found.size,
          'Gerät gefunden',
          'Geräte gefunden',
        )} in ${seconds()}.${
          found.size > fresh
            ? ' Darunter Geräte aus einem früheren Suchlauf – die Liste wächst mit jedem Durchgang, statt neu anzufangen.'
            : ''
        }</p>`,
      );
      return;
    }
    if (found.size > 0) return;
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

  /*
   * Ein Sonos-Lautsprecher ist keine Integration: Er hat keine Zugangsdaten
   * und keine Geräteliste im Sinne des Hubs. Übernommen wird er deshalb über
   * seinen eigenen Weg – gefunden wird er aber gemeinsam mit allen anderen,
   * denn dort sucht man ihn.
   */
  if (body.type === 'sonos') {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Verbinde…';
    const result = await guard(
      () => api('/sonos/discover', { method: 'POST', body: { host: body.host } }),
      { success: 'Lautsprecher übernommen.', successHint: 'Zu finden unter „Dienste".' },
    );
    button.disabled = false;
    button.textContent = label;
    if (result) await onConnected?.();
    return;
  }

  if (button.dataset.auth) {
    // Zentralen kennen Benutzerkonten, ein Shelly nur ein Passwort.
    if (INTEGRATION_HINTS[body.type]?.needsUsername) {
      const username = prompt(
        `Benutzername der Zentrale ${body.host} (wie in der CCU-Weboberfläche):`,
        'Admin',
      );
      if (username === null) return;
      body.username = username.trim() || 'Admin';
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
    /*
     * Das Feld erscheint, wenn ein Name gebraucht *oder* möglich ist – bei
     * der FRITZ!Box nur als Möglichkeit. Viele Boxen sind auf „Anmeldung nur
     * mit Passwort" eingestellt; dort gibt es gar keinen Namen einzutragen,
     * und ein Pflichtfeld wäre schlicht nicht auszufüllen.
     */
    form.querySelectorAll('[data-for-username]').forEach((element) => {
      element.hidden = !info.needsUsername && !info.optionalUsername;
      const field = element.querySelector('input');
      if (field) {
        field.placeholder = info.optionalUsername ? 'nur bei mehreren Konten' : 'Admin';
      }
      const caption = element.childNodes[0];
      if (caption && caption.nodeType === Node.TEXT_NODE) {
        caption.textContent = info.optionalUsername ? 'Benutzername (optional) ' : 'Benutzername ';
      }
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


/**
 * Verbindet alles auf einmal, was ohne Zugangsdaten auskommt.
 *
 * Der Bericht am Ende nennt beides – was ging und was nicht –, denn bei einer
 * Hue Bridge hängt der Erfolg daran, ob jemand rechtzeitig den Knopf gedrückt
 * hat. Ein stilles „fertig" wäre dort schlicht gelogen.
 */
export async function connectAll(button, entries, onConnected) {
  const open = entries.filter((entry) => !entry.alreadyLinked && !entry.authRequired);
  if (open.length === 0) return;

  const label = button.textContent;
  button.disabled = true;

  const ok = [];
  const failed = [];

  for (const [index, entry] of open.entries()) {
    button.textContent = `Verbinde ${index + 1}/${open.length}…`;
    try {
      if (entry.type === 'sonos') {
        await api('/sonos/discover', { method: 'POST', body: { host: entry.host } });
      } else {
        await api('/integrations', {
          method: 'POST',
          body: { type: entry.type, host: entry.host, importRooms: true },
        });
      }
      ok.push(entry.name);
    } catch (err) {
      failed.push(`${entry.name}: ${err?.message ?? 'unbekannter Fehler'}`);
    }
  }

  button.disabled = false;
  button.textContent = label;

  if (ok.length > 0) {
    toast(`${plural(ok.length, 'Gerät verbunden', 'Geräte verbunden')}.`, {
      kind: 'success',
      hint: ok.join(', '),
      timeout: 6000,
    });
  }
  if (failed.length > 0) {
    toast(`${plural(failed.length, 'Gerät ließ', 'Geräte ließen')} sich nicht verbinden.`, {
      kind: 'warn',
      hint: failed.join(' · '),
      timeout: 12000,
    });
  }

  await onConnected?.();
}
