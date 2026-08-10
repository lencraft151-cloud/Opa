/** Einstiegspunkt: Navigation, Live-Updates, Service Worker. */

import { api, setUnauthorizedHandler, showError, toast } from './api.js';
import { applyAppearance, applyStoredAppearance } from './appearance.js';
import {
  loadDashboardData,
  refreshNextcloudCard,
  renderCurrent,
  renderPanel,
  store,
} from './dashboard.js';
import { icons } from './icons.js';
import { hideLogin, showLogin } from './login.js';
import { startSelfUpdate } from './selfupdate.js';
import { initSetup } from './setup.js';

const $ = (selector) => document.querySelector(selector);

const TABS = [
  { id: 'overview', label: 'Übersicht', icon: icons.home, primary: true },
  { id: 'rooms', label: 'Räume', icon: icons.rooms, primary: true },
  { id: 'devices', label: 'Geräte', icon: icons.devices, primary: true },
  { id: 'scenes', label: 'Szenen', icon: icons.scene, primary: true },
  /*
   * Energie und Verlauf standen getrennt – dabei beantworten sie dieselbe
   * Frage aus zwei Richtungen: „Was war?" Wer den Stromverbrauch ansieht,
   * will meist auch die Temperaturkurve daneben. Ein Reiter weniger, und
   * beides auf einem Bildschirm.
   */
  { id: 'insights', label: 'Auswertung', icon: icons.energy },
  /*
   * Sonos, Spotify und Nextcloud sind keine Geräte – es gibt nichts zu
   * schalten und nichts zu messen. Sie in die Geräteliste zu stellen würde
   * beide Begriffe verwischen, also haben sie einen eigenen Reiter.
   */
  { id: 'services', label: 'Dienste', icon: icons.music },
  { id: 'automations', label: 'Automationen', icon: icons.automation },
  { id: 'settings', label: 'Einstellungen', icon: icons.settings },
  { id: 'wiki', label: 'Wiki', icon: icons.book },
];

let activeTab = 'overview';
let info = null;
/** Verhindert, dass mehrere abgelaufene Anfragen die Maske mehrfach öffnen. */
let signedOut = false;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function boot() {
  // Zuerst die zuletzt bekannte Darstellung – sonst blitzt beim Start kurz
  // die Voreinstellung auf, bevor der Hub geantwortet hat.
  applyStoredAppearance();

  try {
    info = await api('/system/info');
  } catch (err) {
    showError(err);
    setConnection('down', 'Hub nicht erreichbar');
    setTimeout(boot, 5000);
    return;
  }

  store.systemInfo = info;

  // Ab hier bemerkt die Seite selbst, wenn der Hub eine neue Fassung hat.
  startSelfUpdate(info.build);

  // Eine abgelaufene Anmeldung führt von überall zurück zur Anmeldemaske.
  setUnauthorizedHandler(() => {
    if (signedOut) return;
    signedOut = true;
    source?.close();
    showLogin(onSignedIn, { reason: 'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.' });
  });

  const setupState = await api('/setup/state');

  /*
   * Ohne Haushalt gibt es niemanden, der sich anmelden könnte – der Assistent
   * legt Haushalt und ersten Zugang in einem Schritt an. Das ist der einzige
   * Fall, in dem die Oberfläche ohne Anmeldung etwas anzeigt.
   */
  if (!setupState.hasHousehold) {
    showSetup(setupState);
    return;
  }

  // Ab hier gibt es einen Haushalt – bleibt die Frage, wer davorsitzt.
  const me = await api('/auth/me', { silent401: true }).catch(() => null);

  if (me?.userCount === 0 && (me?.viaToken || me?.authDisabled)) {
    // Hub aus einer früheren Fassung: Haushalt ja, Konto nein.
    showFirstAccountSetup();
    return;
  }
  if (!me?.user && !me?.authDisabled) {
    /*
     * Früher startete hier der Assistent, sobald die Einrichtung unfertig war
     * – ohne zu fragen, ob überhaupt jemand angemeldet ist. Seine erste
     * Anfrage lief dann in einen 401, und der Fehlerpfad schaltete auf die
     * Anmeldemaske um: ein Aufblitzen des Assistenten, ein roter Eintrag in
     * der Konsole und drei einander widersprechende Meldungen übereinander.
     */
    showLogin(onSignedIn, {
      reason: setupState.completed
        ? undefined
        : 'Die Einrichtung ist noch nicht abgeschlossen. Melde dich an, um sie fortzusetzen.',
    });
    return;
  }

  // Angemeldet, aber der Assistent ist noch nicht durch.
  if (!setupState.completed) {
    showSetup(setupState);
    return;
  }

  await startDashboard();
}

function showSetup(setupState) {
  hideLogin();
  $('#view-setup').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  initSetup(setupState, onSignedIn);
}

/**
 * Nach erfolgreicher Anmeldung.
 *
 * Wohin es geht, entscheidet der Stand der Einrichtung – nicht die Annahme,
 * dass sie fertig ist. Wer den Assistenten abgebrochen hat, landete sonst in
 * einem Dashboard ohne Geräte und ohne Weg zurück.
 */
async function onSignedIn() {
  signedOut = false;
  hideLogin();

  const setupState = await api('/setup/state').catch(() => null);
  if (setupState && !setupState.completed) {
    showSetup(setupState);
    return;
  }
  await startDashboard();
}

/**
 * Nachrüstung für bestehende Hubs: Es gibt einen Haushalt, aber noch kein
 * Konto. Wer mit dem alten Zugriffstoken hereinkommt, legt hier eines an.
 */
function showFirstAccountSetup() {
  hideLogin();
  $('#view-setup').classList.add('hidden');
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  $('#login-subtitle').textContent =
    'Dieser Hub kannte bisher nur ein Zugriffstoken. Lege jetzt deinen Zugang an.';

  const form = $('#form-login');
  form.querySelector('[name="password"]').setAttribute('autocomplete', 'new-password');
  form.querySelector('button[type="submit"]').textContent = 'Zugang anlegen';

  form.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = new FormData(form);
      const created = await guardFirstAccount({
        username: String(data.get('username')).trim(),
        password: String(data.get('password')),
      });
      if (!created) return;
      toast(`Zugang für „${created.username}" angelegt.`, {
        kind: 'success',
        hint: 'Ab jetzt meldest du dich damit an – auf jedem Gerät.',
      });
      await onSignedIn();
    },
    { capture: true },
  );
}

async function guardFirstAccount(input) {
  try {
    const { createFirstAccount } = await import('./login.js');
    return await createFirstAccount(input);
  } catch (err) {
    showError(err);
    return null;
  }
}

async function startDashboard() {
  $('#view-setup').classList.add('hidden');
  $('#view-app').classList.remove('hidden');

  buildNavigation();
  try {
    await loadDashboardData();
    // Die Darstellung gehört zum Haushalt und gilt damit auf jedem Gerät.
    applyAppearance(store.household?.appearance);
  } catch (err) {
    // Bei 401 zeigt der Handler oben bereits die Anmeldemaske.
    if (err?.status !== 401) showError(err);
    return;
  }
  renderPanel(activeTab);
  connectEventStream();
  startPeriodicRefresh();
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function buildNavigation() {
  $('#tabs-desktop').innerHTML = TABS.map(
    (tab) =>
      `<button class="tab ${tab.id === activeTab ? 'active' : ''}" data-tab="${tab.id}">${tab.label}</button>`,
  ).join('');

  const mobile = TABS.filter((tab) => tab.primary);
  $('#tabs-mobile').innerHTML =
    mobile
      .map(
        (tab) =>
          `<button data-tab="${tab.id}" class="${tab.id === activeTab ? 'active' : ''}">
             ${tab.icon}<span>${tab.label}</span>
           </button>`,
      )
      .join('') +
    `<button data-sheet="1" class="${mobile.some((tab) => tab.id === activeTab) ? '' : 'active'}">
       ${icons.more}<span>Mehr</span>
     </button>`;

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  });
  $('#tabs-mobile').querySelector('[data-sheet]').addEventListener('click', openSheet);
}

function selectTab(id) {
  activeTab = id;
  buildNavigation();
  closeSheet();
  renderPanel(id);
  // Ganz nach oben scrollen statt `scrollIntoView` – sonst rutscht der erste
  // Abschnitt unter die klebende Kopfzeile.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSheet() {
  const sheet = $('#sheet');
  sheet.innerHTML = TABS.filter((tab) => !tab.primary)
    .map(
      (tab) =>
        `<button class="icon" data-sheet-tab="${tab.id}">${tab.icon}<span>${tab.label}</span></button>`,
    )
    .join('');
  sheet.querySelectorAll('[data-sheet-tab]').forEach((button) => {
    button.addEventListener('click', () => selectTab(button.dataset.sheetTab));
  });
  $('#sheet-backdrop').classList.remove('hidden');
}

function closeSheet() {
  $('#sheet-backdrop').classList.add('hidden');
}

$('#sheet-backdrop').addEventListener('click', (event) => {
  if (event.target.id === 'sheet-backdrop') closeSheet();
});

// ---------------------------------------------------------------------------
// Live-Updates
// ---------------------------------------------------------------------------

let source = null;
let reconnectDelay = 1000;
let renderTimer = null;

function setConnection(kind, text) {
  const dot = $('#live-dot');
  const label = $('#live-text');
  if (!dot || !label) return;
  dot.className = `dot ${kind}`;
  label.textContent = text;
}

/**
 * Während der Nutzer etwas bedient, wird nicht neu gezeichnet – sonst
 * springt der Regler unter dem Finger weg, wenn ein Messwert eintrifft.
 */
let interacting = false;
for (const [event, value] of [
  ['pointerdown', true],
  ['pointerup', false],
  ['pointercancel', false],
]) {
  document.addEventListener(event, (e) => {
    if (value && !e.target.closest?.('.color-wheel, input[type="range"]')) return;
    interacting = value;
  });
}

/**
 * Neuzeichnen nach einem Geräteereignis.
 *
 * `reason: 'devices'` sagt der Dashboard-Schicht, dass nur ein Messwert
 * hereinkam. Ansichten ohne Gerätebezug – Automationen, Einstellungen –
 * bleiben dann stehen, statt einem halb ausgefüllten Formular in die Quere
 * zu kommen.
 */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (interacting) {
      scheduleRender(); // später erneut versuchen
      return;
    }
    renderCurrent({ reason: 'devices' });
  }, 350);
}

/**
 * Verbindet den Ereignisstrom. `EventSource` versucht zwar selbst erneut zu
 * verbinden, meldet dem Nutzer aber nichts – deshalb ein eigener Aufbau mit
 * Backoff und sichtbarem Zustand.
 */
function connectEventStream() {
  source?.close();
  // Die Anmeldung reist als Cookie mit – `EventSource` kann keine Header
  // setzen, und ein Token in der Adresszeile stünde in jedem Server-Log.
  source = new EventSource('/api/events');

  source.addEventListener('ready', () => {
    reconnectDelay = 1000;
    setConnection('live', 'live');
  });

  const applyDevice = (event) => {
    const { device } = JSON.parse(event.data);
    const index = store.devices.findIndex((item) => item.id === device.id);
    if (index >= 0) store.devices[index] = device;
    else store.devices.push(device);
    scheduleRender();
  };

  source.addEventListener('device.updated', applyDevice);
  source.addEventListener('device.added', applyDevice);
  source.addEventListener('device.removed', (event) => {
    const { deviceId } = JSON.parse(event.data);
    store.devices = store.devices.filter((device) => device.id !== deviceId);
    scheduleRender();
  });
  source.addEventListener('integration.updated', () => {
    void api('/integrations')
      .then((list) => {
        store.integrations = list;
        scheduleRender();
      })
      .catch(() => undefined);
  });
  source.addEventListener('automation.triggered', (event) => {
    const { ruleName } = JSON.parse(event.data);
    toast(`Automation ausgelöst: ${ruleName}`, { kind: 'success', timeout: 4000 });
  });
  source.addEventListener('notification', (event) => {
    const { message, level, hint, link, source: origin } = JSON.parse(event.data);
    toast(message, {
      kind: level === 'error' ? 'error' : 'info',
      hint: hint ?? '',
      link: link ?? '',
      // Eine Nachricht aus der Nextcloud will gelesen werden – dafür sind
      // sechs Sekunden zu knapp, wenn man gerade nicht davorsteht.
      timeout: origin === 'nextcloud' ? 15_000 : 8000,
    });
    if (origin === 'nextcloud') refreshNextcloudCard();
  });

  source.onerror = () => {
    source?.close();
    setConnection('down', `getrennt – neuer Versuch in ${Math.round(reconnectDelay / 1000)} s`);
    setTimeout(connectEventStream, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  };
}

/**
 * Kennzahlen kommen nicht über den Ereignisstrom (sie werden serverseitig
 * berechnet), deshalb ein ruhiger Takt im Hintergrund.
 */
function startPeriodicRefresh() {
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const [summary, climate] = await Promise.all([
        api('/household/summary'),
        api('/telemetry/climate'),
      ]);
      store.summary = summary;
      store.climate = climate;
      if (activeTab === 'overview') renderCurrent({ reason: 'devices' });
    } catch {
      /* beim nächsten Durchlauf erneut */
    }
  }, 30_000);

  // Nach dem Zurückholen aus dem Hintergrund sofort auffrischen – auf dem
  // Handy war die Seite oft minutenlang eingefroren.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (source?.readyState === EventSource.CLOSED) connectEventStream();
    void loadDashboardData().then(renderCurrent).catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Service Worker (Offline-Hülle, Installation als App)
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* ohne Service Worker funktioniert alles außer Offline-Start */
    });
  });
}

void boot();
