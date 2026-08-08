/** Einstiegspunkt: Navigation, Live-Updates, Service Worker. */

import { api, auth, showError, toast } from './api.js';
import { applyAppearance, applyStoredAppearance } from './appearance.js';
import { loadDashboardData, renderCurrent, renderPanel, store } from './dashboard.js';
import { icons } from './icons.js';
import { startSelfUpdate } from './selfupdate.js';
import { initSetup } from './setup.js';

const $ = (selector) => document.querySelector(selector);

const TABS = [
  { id: 'overview', label: 'Übersicht', icon: icons.home, primary: true },
  { id: 'rooms', label: 'Räume', icon: icons.rooms, primary: true },
  { id: 'devices', label: 'Geräte', icon: icons.devices, primary: true },
  { id: 'energy', label: 'Energie', icon: icons.energy, primary: true },
  { id: 'history', label: 'Verlauf', icon: icons.chart },
  { id: 'automations', label: 'Automationen', icon: icons.automation },
  { id: 'settings', label: 'Einstellungen', icon: icons.settings },
];

let activeTab = 'overview';
let info = null;

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

  const setupState = await api('/setup/state');
  if (!setupState.hasHousehold || !setupState.completed) {
    $('#view-setup').classList.remove('hidden');
    $('#view-app').classList.add('hidden');
    initSetup(setupState, startDashboard);
    return;
  }
  await startDashboard();
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
    showError(err);
    // Ein abgelaufenes Token ist der häufigste Grund – zurück zur Einrichtung
    // hilft hier nicht, aber die Meldung erklärt, was zu tun ist.
    if (err?.status === 401) auth.token = '';
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

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (interacting) {
      scheduleRender(); // später erneut versuchen
      return;
    }
    renderCurrent();
  }, 350);
}

/**
 * Verbindet den Ereignisstrom. `EventSource` versucht zwar selbst erneut zu
 * verbinden, meldet dem Nutzer aber nichts – deshalb ein eigener Aufbau mit
 * Backoff und sichtbarem Zustand.
 */
function connectEventStream() {
  source?.close();
  source = new EventSource(`/api/events?access_token=${encodeURIComponent(auth.token)}`);

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
    const { message, level } = JSON.parse(event.data);
    toast(message, { kind: level === 'error' ? 'error' : 'info', timeout: 8000 });
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
      if (activeTab === 'overview') renderCurrent();
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
