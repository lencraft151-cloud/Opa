/**
 * Oberfläche des Smart-Home-Hubs – bewusst ohne Framework, damit die App ohne
 * Build-Schritt aus `public/` ausgeliefert werden kann.
 */

const TOKEN_KEY = 'smarthome.token';

const store = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  info: null,
  setup: null,
  household: null,
  summary: null,
  rooms: [],
  devices: [],
  integrations: [],
  automations: [],
  climate: null,
  discovery: [],
  activeTab: 'overview',
};

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function toast(message, kind = 'info', timeout = 5000) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), timeout);
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (store.token) headers['authorization'] = `Bearer ${store.token}`;

  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.code = data?.error?.code;
    error.status = response.status;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

/** Führt eine Aktion aus und zeigt Fehler als Toast statt sie zu verschlucken. */
async function guard(fn, { success } = {}) {
  try {
    const result = await fn();
    if (success) toast(success, 'success');
    return result;
  } catch (err) {
    toast(err.message, err.code === 'link_button_required' ? 'warn' : 'error', 8000);
    return null;
  }
}

const fmt = {
  temperature: (value) => (value === null || value === undefined ? '–' : `${value.toFixed(1)} °C`),
  percent: (value) => (value === null || value === undefined ? '–' : `${Math.round(value)} %`),
  power: (value) =>
    value === null || value === undefined
      ? '–'
      : value >= 1000
        ? `${(value / 1000).toFixed(2)} kW`
        : `${value.toFixed(1)} W`,
  energy: (value) =>
    value === null || value === undefined ? '–' : `${(value / 1000).toFixed(2)} kWh`,
  lux: (value) => (value === null || value === undefined ? '–' : `${Math.round(value)} lx`),
  time: (iso) =>
    !iso ? '–' : new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),
};

const VENDOR_LABEL = { hue: 'Philips Hue', shelly: 'Shelly' };

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function boot() {
  try {
    store.info = await api('/system/info');
  } catch (err) {
    toast(`Hub nicht erreichbar: ${err.message}`, 'error');
    return;
  }

  store.setup = await api('/setup/state');

  if (!store.setup.hasHousehold || !store.setup.completed) {
    showSetup();
  } else {
    await showDashboard();
  }
}

function showSetup() {
  $('#view-setup').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  renderWizard();
}

async function showDashboard() {
  $('#view-setup').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  await loadDashboardData();
  renderActiveTab();
  connectEventStream();
}

// ---------------------------------------------------------------------------
// Einrichtungsassistent
// ---------------------------------------------------------------------------

function renderWizard() {
  const state = store.setup;

  $('#wizard-steps').innerHTML = state.steps
    .map(
      (step, index) => `
      <li class="${step.current ? 'current' : ''} ${step.done ? 'done' : ''}">
        ${index + 1}. ${esc(step.title)}
      </li>`,
    )
    .join('');

  for (const id of ['household', 'integrations', 'rooms', 'assign', 'done']) {
    $(`#step-${id}`).classList.toggle('hidden', state.currentStep !== id);
  }

  if (state.currentStep === 'household') fillTimezones();
  if (state.currentStep === 'integrations') void renderSetupIntegrations();
  if (state.currentStep === 'rooms') void renderSetupRooms();
  if (state.currentStep === 'assign') void renderAssign();
  if (state.currentStep === 'done') renderSetupWarnings();
}

function fillTimezones() {
  const select = $('#timezone-select');
  if (select.options.length > 0) return;
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  select.innerHTML = zones
    .map((zone) => `<option value="${esc(zone)}" ${zone === current ? 'selected' : ''}>${esc(zone)}</option>`)
    .join('');
}

$('#form-household').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const result = await guard(() =>
    api('/setup/household', {
      method: 'POST',
      body: { name: form.get('name'), timezone: form.get('timezone') },
    }),
  );
  if (!result) return;

  store.token = result.accessToken;
  localStorage.setItem(TOKEN_KEY, store.token);
  $('#token-value').textContent = result.accessToken;
  $('#token-box').classList.remove('hidden');
  store.setup = result.state;

  toast('Haushalt angelegt. Weiter geht es mit den Geräten.', 'success');
  setTimeout(() => renderWizard(), 1500);
});

// --- Schritt 2: Integrationen ----------------------------------------------

async function runDiscovery(scan, targetId) {
  const target = $(targetId);
  target.innerHTML = `<div class="item"><span class="sub">Suche läuft${
    scan ? ' (Subnetz-Scan, das kann eine Minute dauern)' : ''
  }…</span></div>`;

  const result = await guard(() => api(`/integrations/discover?scan=${scan ? 'true' : 'false'}`));
  if (!result) {
    target.innerHTML = '';
    return;
  }

  store.discovery = result.found;
  if (result.found.length === 0) {
    target.innerHTML = `<div class="item"><span class="sub">
      Nichts gefunden. Prüfe, ob der Hub im selben Netzwerk läuft – oder trage die IP-Adresse manuell ein.
    </span></div>`;
    return;
  }

  target.innerHTML = result.found
    .map(
      (entry) => `
      <div class="item">
        <div>
          <div class="title">${esc(entry.name)} <span class="badge">${esc(VENDOR_LABEL[entry.type] || entry.type)}</span></div>
          <div class="sub">
            ${esc(entry.host)} · ${esc(entry.model || 'unbekanntes Modell')} · gefunden per ${esc(entry.source)}
            ${entry.requiresLinkButton ? ' · <strong>Knopf auf der Bridge drücken</strong>' : ''}
            ${entry.authRequired ? ' · passwortgeschützt' : ''}
          </div>
        </div>
        ${
          entry.alreadyLinked
            ? '<span class="badge ok">bereits verbunden</span>'
            : `<button class="primary" data-connect="${esc(entry.host)}" data-type="${esc(entry.type)}"
                 data-auth="${entry.authRequired ? '1' : ''}">Verbinden</button>`
        }
      </div>`,
    )
    .join('');

  $$('[data-connect]', target).forEach((button) => {
    button.addEventListener('click', () => connectIntegration(button));
  });
}

async function connectIntegration(button) {
  const host = button.dataset.connect;
  const type = button.dataset.type;
  const body = { type, host, importRooms: true };

  if (button.dataset.auth) {
    const password = prompt(`Passwort für das Shelly-Gerät ${host}:`);
    if (password === null) return;
    body.password = password;
  }

  button.disabled = true;
  button.textContent = 'Verbinde…';

  const result = await guard(() => api('/integrations', { method: 'POST', body }));

  button.disabled = false;
  button.textContent = 'Verbinden';

  if (!result) return;
  toast(`${result.integration.name}: ${result.devices.length} Gerät(e) übernommen.`, 'success');
  await refreshSetupState();
}

$('#btn-discover').addEventListener('click', () => runDiscovery(false, '#discovery-results'));
$('#btn-discover-scan').addEventListener('click', () => runDiscovery(true, '#discovery-results'));

$('#form-manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = {
    type: form.get('type'),
    host: String(form.get('host')).trim(),
    importRooms: true,
  };
  const name = String(form.get('name') || '').trim();
  const password = String(form.get('password') || '');
  if (name) body.name = name;
  if (password) body.password = password;

  const result = await guard(() => api('/integrations', { method: 'POST', body }));
  if (!result) return;
  toast(`${result.integration.name}: ${result.devices.length} Gerät(e) übernommen.`, 'success');
  event.target.reset();
  await refreshSetupState();
});

async function renderSetupIntegrations() {
  const integrations = await guard(() => api('/integrations'));
  if (!integrations) return;
  store.integrations = integrations;
  $('#setup-integrations').innerHTML = integrations.length
    ? integrations.map(integrationItem).join('')
    : '<div class="item"><span class="sub">Noch nichts verbunden.</span></div>';
  $('#btn-to-rooms').disabled = integrations.length === 0;
}

function integrationItem(integration) {
  const badge =
    integration.status === 'linked'
      ? '<span class="badge ok">verbunden</span>'
      : integration.status === 'error'
        ? `<span class="badge error">Fehler</span>`
        : `<span class="badge warn">${esc(integration.status)}</span>`;
  return `
    <div class="item">
      <div>
        <div class="title">${esc(integration.name)} ${badge}</div>
        <div class="sub">
          ${esc(VENDOR_LABEL[integration.type] || integration.type)} · ${esc(integration.config.host)} ·
          ${integration.deviceCount ?? 0} Gerät(e)
          ${integration.lastError ? ` · <span class="badge error">${esc(integration.lastError)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

$('#btn-to-rooms').addEventListener('click', async () => {
  store.setup = await api('/setup/step', { method: 'POST', body: { step: 'rooms' } });
  renderWizard();
});

// --- Schritt 3: Räume -------------------------------------------------------

async function renderSetupRooms() {
  const [suggestions, rooms] = await Promise.all([
    api('/setup/suggested-rooms'),
    api('/rooms'),
  ]);
  store.rooms = rooms;

  const existing = new Set(rooms.map((room) => room.name.toLowerCase()));
  $('#room-suggestions').innerHTML = suggestions.rooms
    .map(
      (name) =>
        `<button class="chip ${existing.has(name.toLowerCase()) ? 'active' : ''}"
           data-room="${esc(name)}" ${existing.has(name.toLowerCase()) ? 'disabled' : ''}>${esc(name)}</button>`,
    )
    .join('');

  $$('[data-room]', $('#room-suggestions')).forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api('/setup/rooms', { method: 'POST', body: { names: [button.dataset.room] } }));
      await renderSetupRooms();
    });
  });

  $('#setup-rooms').innerHTML = rooms.length
    ? rooms
        .map(
          (room) => `
        <div class="item">
          <div class="title">${esc(room.name)}</div>
          <button class="danger small" data-delete-room="${esc(room.id)}">Entfernen</button>
        </div>`,
        )
        .join('')
    : '<div class="item"><span class="sub">Noch keine Räume angelegt.</span></div>';

  $$('[data-delete-room]', $('#setup-rooms')).forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api(`/rooms/${button.dataset.deleteRoom}`, { method: 'DELETE' }));
      await renderSetupRooms();
    });
  });

  $('#btn-to-assign').disabled = rooms.length === 0;
}

$('#form-room').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  await guard(() => api('/setup/rooms', { method: 'POST', body: { names: [name] } }));
  event.target.reset();
  await renderSetupRooms();
});

$('#btn-to-assign').addEventListener('click', async () => {
  store.setup = await api('/setup/step', { method: 'POST', body: { step: 'assign' } });
  renderWizard();
});

// --- Schritt 4: Zuordnung ---------------------------------------------------

async function renderAssign() {
  const [devices, rooms] = await Promise.all([api('/devices?includeHidden=true'), api('/rooms')]);
  store.devices = devices;
  store.rooms = rooms;

  $('#assign-list').innerHTML = devices.length
    ? devices
        .map(
          (device) => `
        <div class="item">
          <div>
            <div class="title">${esc(device.name)}</div>
            <div class="sub">${esc(VENDOR_LABEL[device.vendor] || device.vendor)} · ${esc(
              device.capabilities.join(', ') || 'keine Fähigkeiten',
            )}</div>
          </div>
          <select data-assign="${esc(device.id)}">
            <option value="">– kein Raum –</option>
            ${rooms
              .map(
                (room) =>
                  `<option value="${esc(room.id)}" ${room.id === device.roomId ? 'selected' : ''}>${esc(room.name)}</option>`,
              )
              .join('')}
          </select>
        </div>`,
        )
        .join('')
    : '<div class="item"><span class="sub">Keine Geräte gefunden.</span></div>';
}

$('#btn-save-assign').addEventListener('click', async () => {
  const assignments = $$('[data-assign]').map((select) => ({
    deviceId: select.dataset.assign,
    roomId: select.value || null,
  }));
  if (assignments.length === 0) {
    store.setup = await api('/setup/step', { method: 'POST', body: { step: 'done' } });
    renderWizard();
    return;
  }
  const state = await guard(() => api('/setup/assign', { method: 'POST', body: { assignments } }), {
    success: 'Zuordnung gespeichert.',
  });
  if (!state) return;
  store.setup = await api('/setup/step', { method: 'POST', body: { step: 'done' } });
  renderWizard();
});

// --- Schritt 5: Abschluss ---------------------------------------------------

function renderSetupWarnings() {
  const warnings = store.setup.warnings || [];
  const counts = store.setup.counts;
  $('#setup-warnings').innerHTML =
    `<div class="item"><div class="sub">
       ${counts.integrations} Integration(en) · ${counts.devices} Gerät(e) ·
       ${counts.rooms} Raum/Räume · ${counts.temperatureSensors} Temperatursensor(en)
     </div></div>` +
    warnings
      .map((warning) => `<div class="item"><span class="badge warn">Hinweis</span> ${esc(warning)}</div>`)
      .join('');
}

$('#btn-complete').addEventListener('click', async () => {
  const state = await guard(() => api('/setup/complete', { method: 'POST' }), {
    success: 'Einrichtung abgeschlossen.',
  });
  if (!state) return;
  store.setup = state;
  await showDashboard();
});

async function refreshSetupState() {
  store.setup = await api('/setup/state');
  renderWizard();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function loadDashboardData() {
  const [summary, rooms, devices, integrations, automations, climate] = await Promise.all([
    api('/household/summary'),
    api('/rooms'),
    api('/devices'),
    api('/integrations'),
    api('/automations'),
    api('/telemetry/climate'),
  ]);
  store.summary = summary;
  store.household = summary.household;
  store.rooms = rooms;
  store.devices = devices;
  store.integrations = integrations;
  store.automations = automations;
  store.climate = climate;
  $('#household-name').textContent = summary.household.name;
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((other) => other.classList.toggle('active', other === tab));
    store.activeTab = tab.dataset.tab;
    $$('.tab-panel').forEach((panel) =>
      panel.classList.toggle('hidden', panel.id !== `tab-${store.activeTab}`),
    );
    renderActiveTab();
  });
});

function renderActiveTab() {
  switch (store.activeTab) {
    case 'overview':
      renderOverview();
      break;
    case 'rooms':
      renderRooms();
      break;
    case 'devices':
      renderDevices();
      break;
    case 'history':
      void renderHistory();
      break;
    case 'automations':
      renderAutomations();
      break;
    case 'settings':
      void renderSettings();
      break;
    default:
      break;
  }
}

function renderOverview() {
  const summary = store.summary;
  $('#summary-tiles').innerHTML = [
    tile(fmt.temperature(summary.averageTemperatureC), 'Ø Temperatur'),
    tile(`${summary.lightsOn}`, 'Geräte eingeschaltet'),
    tile(fmt.power(summary.totalPowerW), 'Aktuelle Leistung'),
    tile(`${summary.reachable}/${summary.total}`, 'Geräte erreichbar'),
    tile(`${summary.integrations.linked}`, 'Integrationen aktiv'),
  ].join('');

  const rooms = store.climate?.rooms ?? [];
  $('#climate-grid').innerHTML = rooms.length
    ? rooms
        .map(
          (room) => `
        <div class="device-card">
          <header>
            <div class="name">${esc(room.roomName)}</div>
            ${
              room.targetTemperatureC !== null
                ? `<span class="badge">Soll ${room.targetTemperatureC} °C</span>`
                : ''
            }
          </header>
          <div class="readings">
            <span class="reading"><strong>${fmt.temperature(room.temperatureC)}</strong></span>
            <span class="reading">Luftfeuchte <strong>${fmt.percent(room.humidity)}</strong></span>
          </div>
          <div class="sub muted small">
            ${
              room.sensors.length
                ? room.sensors
                    .map(
                      (sensor) =>
                        `${esc(sensor.name)}: ${fmt.temperature(sensor.temperatureC)}${
                          sensor.batteryPercent !== null ? ` · 🔋 ${sensor.batteryPercent}%` : ''
                        }`,
                    )
                    .join('<br />')
                : 'Kein Sensor in diesem Raum'
            }
          </div>
        </div>`,
        )
        .join('')
    : '<p class="muted">Noch keine Räume mit Sensoren.</p>';
}

function tile(value, label) {
  return `<div class="tile"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`;
}

function renderRooms() {
  const grid = $('#rooms-grid');
  const rooms = store.rooms;
  const unassigned = store.devices.filter((device) => device.roomId === null);

  const sections = rooms.map((room) => {
    const devices = store.devices.filter((device) => device.roomId === room.id);
    return `
      <div class="device-card">
        <header>
          <div class="name">${esc(room.name)}</div>
          <div>
            <button class="small" data-room-all="${esc(room.id)}" data-on="1">Alles an</button>
            <button class="small" data-room-all="${esc(room.id)}" data-on="">Alles aus</button>
          </div>
        </header>
        <div class="readings">
          <span class="reading"><strong>${fmt.temperature(room.climate?.temperatureC ?? null)}</strong></span>
          <span class="reading">💧 <strong>${fmt.percent(room.climate?.humidity ?? null)}</strong></span>
          <span class="reading">⚡ <strong>${fmt.power(room.climate?.powerW ?? 0)}</strong></span>
        </div>
        <div class="list">${devices.map(deviceCard).join('') || '<span class="muted small">Keine Geräte</span>'}</div>
      </div>`;
  });

  if (unassigned.length > 0) {
    sections.push(`
      <div class="device-card">
        <header><div class="name">Ohne Raum</div></header>
        <div class="list">${unassigned.map(deviceCard).join('')}</div>
      </div>`);
  }

  grid.innerHTML = sections.join('') || '<p class="muted">Noch keine Räume angelegt.</p>';
  bindDeviceControls(grid);

  $$('[data-room-all]', grid).forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() =>
        api(`/rooms/${button.dataset.roomAll}/command`, {
          method: 'POST',
          body: { type: 'setPower', on: Boolean(button.dataset.on) },
        }),
      );
      await refreshDevices();
    });
  });
}

function renderDevices() {
  const search = $('#device-search').value.trim().toLowerCase();
  const capability = $('#device-filter').value;

  const devices = store.devices.filter((device) => {
    if (capability && !device.capabilities.includes(capability)) return false;
    if (search && !device.name.toLowerCase().includes(search)) return false;
    return true;
  });

  const list = $('#devices-list');
  list.innerHTML = devices.length
    ? devices.map((device) => deviceCard(device, true)).join('')
    : '<p class="muted">Keine passenden Geräte.</p>';
  bindDeviceControls(list);
}

$('#device-search').addEventListener('input', renderDevices);
$('#device-filter').addEventListener('change', renderDevices);

/** Karte eines einzelnen Geräts inklusive Bedienelementen. */
function deviceCard(device, withMeta = false) {
  const state = device.state || {};
  const has = (capability) => device.capabilities.includes(capability);
  const readings = [];

  if (has('sensor.temperature')) {
    readings.push(`<span class="reading">🌡️ <strong>${fmt.temperature(state.temperatureC)}</strong></span>`);
  }
  if (has('sensor.humidity')) {
    readings.push(`<span class="reading">💧 <strong>${fmt.percent(state.humidity)}</strong></span>`);
  }
  if (has('sensor.power')) {
    readings.push(`<span class="reading">⚡ <strong>${fmt.power(state.powerW)}</strong></span>`);
  }
  if (has('sensor.energy')) {
    readings.push(`<span class="reading">Σ <strong>${fmt.energy(state.energyWh)}</strong></span>`);
  }
  if (has('sensor.illuminance')) {
    readings.push(`<span class="reading">☀️ <strong>${fmt.lux(state.illuminanceLux)}</strong></span>`);
  }
  if (has('sensor.motion')) {
    readings.push(`<span class="reading">🚶 <strong>${state.motion ? 'Bewegung' : 'ruhig'}</strong></span>`);
  }
  if (has('sensor.battery')) {
    readings.push(`<span class="reading">🔋 <strong>${fmt.percent(state.batteryPercent)}</strong></span>`);
  }

  const controls = [];
  if (has('switch')) {
    controls.push(`
      <label class="switch" title="Ein/Aus">
        <input type="checkbox" data-power="${esc(device.id)}" ${state.on ? 'checked' : ''} />
        <span></span>
      </label>`);
  }
  if (has('dimmer')) {
    controls.push(`
      <label class="small muted">Helligkeit ${Math.round(state.brightness ?? 0)} %
        <input type="range" min="0" max="100" value="${Math.round(state.brightness ?? 0)}"
               data-brightness="${esc(device.id)}" />
      </label>`);
  }
  if (has('color_temperature')) {
    controls.push(`
      <label class="small muted">Farbtemperatur ${Math.round(state.colorTemperatureK ?? 2700)} K
        <input type="range" min="2000" max="6500" step="100" value="${Math.round(state.colorTemperatureK ?? 2700)}"
               data-kelvin="${esc(device.id)}" />
      </label>`);
  }
  if (has('cover')) {
    controls.push(`
      <label class="small muted">Position ${Math.round(state.position ?? 0)} %
        <input type="range" min="0" max="100" value="${Math.round(state.position ?? 0)}"
               data-position="${esc(device.id)}" />
      </label>`);
  }

  return `
    <div class="device-card ${device.reachable ? '' : 'offline'}">
      <header>
        <div>
          <div class="name">${esc(device.name)}</div>
          ${
            withMeta
              ? `<div class="sub muted small">${esc(VENDOR_LABEL[device.vendor] || device.vendor)}
                 ${device.model ? `· ${esc(device.model)}` : ''}
                 · ${esc(roomName(device.roomId))}</div>`
              : ''
          }
        </div>
        ${device.reachable ? '' : '<span class="badge error">offline</span>'}
      </header>
      ${readings.length ? `<div class="readings">${readings.join('')}</div>` : ''}
      ${controls.join('')}
    </div>`;
}

function roomName(roomId) {
  return store.rooms.find((room) => room.id === roomId)?.name ?? 'ohne Raum';
}

/** Verdrahtet Schalter und Regler einer gerade gerenderten Liste. */
function bindDeviceControls(root) {
  $$('[data-power]', root).forEach((input) => {
    input.addEventListener('change', async () => {
      await sendCommand(input.dataset.power, { type: 'setPower', on: input.checked });
    });
  });

  const ranges = [
    ['brightness', (value) => ({ type: 'setBrightness', brightness: value })],
    ['kelvin', (value) => ({ type: 'setColorTemperature', kelvin: value })],
    ['position', (value) => ({ type: 'setPosition', position: value })],
  ];

  for (const [attribute, build] of ranges) {
    $$(`[data-${attribute}]`, root).forEach((input) => {
      input.addEventListener('change', async () => {
        await sendCommand(input.dataset[attribute], build(Number(input.value)));
      });
    });
  }
}

async function sendCommand(deviceId, command) {
  const device = await guard(() =>
    api(`/devices/${deviceId}/command`, { method: 'POST', body: command }),
  );
  if (!device) return;
  const index = store.devices.findIndex((item) => item.id === deviceId);
  if (index >= 0) store.devices[index] = device;
  scheduleRender();
}

async function refreshDevices() {
  store.devices = await api('/devices');
  scheduleRender();
}

// --- Verlauf ----------------------------------------------------------------

async function renderHistory() {
  const select = $('#history-device');
  const metric = $('#history-metric').value;
  const hours = Number($('#history-range').value);

  const candidates = store.devices.filter((device) =>
    device.capabilities.some((capability) => capability.startsWith('sensor.')),
  );

  if (select.dataset.count !== String(candidates.length)) {
    select.innerHTML = candidates
      .map((device) => `<option value="${esc(device.id)}">${esc(device.name)}</option>`)
      .join('');
    select.dataset.count = String(candidates.length);
  }

  const deviceId = select.value || candidates[0]?.id;
  if (!deviceId) {
    $('#chart').innerHTML = '<p class="muted">Noch keine Sensoren vorhanden.</p>';
    $('#history-stats').innerHTML = '';
    return;
  }

  const [series, aggregate] = await Promise.all([
    api(`/telemetry/series?deviceId=${deviceId}&metric=${metric}&hours=${hours}&bucketMinutes=${bucketFor(hours)}`),
    api(`/telemetry/aggregate?deviceId=${deviceId}&metric=${metric}&hours=${hours}`),
  ]);

  drawChart(series.series, metric);

  const stats = aggregate.aggregates[0];
  $('#history-stats').innerHTML = stats
    ? [
        tile(formatMetric(stats.min, metric), 'Minimum'),
        tile(formatMetric(stats.avg, metric), 'Mittelwert'),
        tile(formatMetric(stats.max, metric), 'Maximum'),
        tile(String(stats.count), 'Messwerte'),
      ].join('')
    : '<p class="muted">Für diesen Zeitraum liegen keine Messwerte vor.</p>';
}

function bucketFor(hours) {
  if (hours <= 6) return 5;
  if (hours <= 24) return 15;
  if (hours <= 168) return 60;
  return 240;
}

function formatMetric(value, metric) {
  if (metric === 'temperatureC') return fmt.temperature(value);
  if (metric === 'humidity' || metric === 'batteryPercent') return fmt.percent(value);
  if (metric === 'powerW') return fmt.power(value);
  if (metric === 'illuminanceLux') return fmt.lux(value);
  return String(value);
}

/** Zeichnet die Messreihe als SVG – Min/Max als Band, Mittelwert als Linie. */
function drawChart(series, metric) {
  const target = $('#chart');
  if (!series || series.length < 2) {
    target.innerHTML = '<p class="muted">Zu wenige Messwerte für ein Diagramm.</p>';
    return;
  }

  const width = 900;
  const height = 260;
  const padding = { top: 16, right: 16, bottom: 28, left: 48 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const values = series.flatMap((point) => [point.min, point.max]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lower = min - span * 0.1;
  const upper = max + span * 0.1;

  const x = (index) => padding.left + (index / (series.length - 1)) * innerWidth;
  const y = (value) => padding.top + innerHeight - ((value - lower) / (upper - lower)) * innerHeight;

  const line = series.map((point, index) => `${x(index).toFixed(1)},${y(point.avg).toFixed(1)}`).join(' ');
  const band = [
    ...series.map((point, index) => `${x(index).toFixed(1)},${y(point.max).toFixed(1)}`),
    ...series.map((point, index) => `${x(series.length - 1 - index).toFixed(1)},${y(series[series.length - 1 - index].min).toFixed(1)}`),
  ].join(' ');

  const ticks = 4;
  const gridLines = Array.from({ length: ticks + 1 }, (_, index) => {
    const value = lower + ((upper - lower) * index) / ticks;
    const yPos = y(value);
    return `<line class="axis" x1="${padding.left}" y1="${yPos}" x2="${width - padding.right}" y2="${yPos}" />
            <text class="label" x="4" y="${yPos + 4}">${value.toFixed(1)}</text>`;
  }).join('');

  const labelCount = Math.min(6, series.length);
  const timeLabels = Array.from({ length: labelCount }, (_, index) => {
    const seriesIndex = Math.round((index / (labelCount - 1)) * (series.length - 1));
    const point = series[seriesIndex];
    const date = new Date(point.t);
    const text = date.toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `<text class="label" x="${x(seriesIndex)}" y="${height - 8}" text-anchor="middle">${esc(text)}</text>`;
  }).join('');

  target.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
         aria-label="Messreihe ${esc(metric)}">
      ${gridLines}
      <polygon class="band" points="${band}" />
      <polyline class="line" points="${line}" />
      ${timeLabels}
    </svg>`;
}

$('#history-device').addEventListener('change', renderHistory);
$('#history-metric').addEventListener('change', renderHistory);
$('#history-range').addEventListener('change', renderHistory);

// --- Automationen -----------------------------------------------------------

function renderAutomations() {
  const sensorDevices = store.devices.filter((device) =>
    device.capabilities.some((capability) => capability.startsWith('sensor.')),
  );
  const switchable = store.devices.filter((device) => device.capabilities.includes('switch'));

  const options = (devices) =>
    devices.map((device) => `<option value="${esc(device.id)}">${esc(device.name)}</option>`).join('');
  $('#trigger-device').innerHTML = options(sensorDevices);
  $('#action-device').innerHTML = options(switchable);

  $('#automations-list').innerHTML = store.automations.length
    ? store.automations
        .map(
          (rule) => `
        <div class="item">
          <div>
            <div class="title">${esc(rule.name)}
              ${rule.enabled ? '<span class="badge ok">aktiv</span>' : '<span class="badge">pausiert</span>'}
            </div>
            <div class="sub">${esc(describeTrigger(rule.trigger))} · zuletzt: ${fmt.time(rule.lastTriggeredAt)}</div>
          </div>
          <div class="row" style="margin:0">
            <button class="small" data-run-rule="${esc(rule.id)}">Testen</button>
            <button class="small" data-toggle-rule="${esc(rule.id)}" data-enabled="${rule.enabled ? '1' : ''}">
              ${rule.enabled ? 'Pausieren' : 'Aktivieren'}
            </button>
            <button class="small danger" data-delete-rule="${esc(rule.id)}">Löschen</button>
          </div>
        </div>`,
        )
        .join('')
    : '<p class="muted">Noch keine Automationen angelegt.</p>';

  $$('[data-run-rule]').forEach((button) =>
    button.addEventListener('click', () =>
      guard(() => api(`/automations/${button.dataset.runRule}/run`, { method: 'POST' }), {
        success: 'Automation ausgeführt.',
      }),
    ),
  );
  $$('[data-toggle-rule]').forEach((button) =>
    button.addEventListener('click', async () => {
      await guard(() =>
        api(`/automations/${button.dataset.toggleRule}`, {
          method: 'PATCH',
          body: { enabled: !button.dataset.enabled },
        }),
      );
      store.automations = await api('/automations');
      renderAutomations();
    }),
  );
  $$('[data-delete-rule]').forEach((button) =>
    button.addEventListener('click', async () => {
      await guard(() => api(`/automations/${button.dataset.deleteRule}`, { method: 'DELETE' }));
      store.automations = await api('/automations');
      renderAutomations();
    }),
  );
}

function describeTrigger(trigger) {
  const deviceName = (id) => store.devices.find((device) => device.id === id)?.name ?? id;
  if (trigger.type === 'sensor') {
    return `Wenn ${deviceName(trigger.deviceId)} ${trigger.metric} ${trigger.operator} ${trigger.value}` +
      (trigger.forSeconds ? ` für ${Math.round(trigger.forSeconds / 60)} min` : '');
  }
  if (trigger.type === 'deviceState') {
    return `Wenn ${deviceName(trigger.deviceId)} ${trigger.property} = ${trigger.equals}`;
  }
  return `Täglich um ${trigger.at}`;
}

$('#form-automation').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const forMinutes = Number(form.get('forMinutes') || 0);

  const body = {
    name: form.get('name'),
    trigger: {
      type: 'sensor',
      deviceId: form.get('triggerDevice'),
      metric: form.get('triggerMetric'),
      operator: form.get('operator'),
      value: Number(form.get('value')),
      forSeconds: forMinutes * 60,
    },
    actions: [
      {
        type: 'command',
        target: { deviceIds: [form.get('actionDevice')] },
        command: { type: 'setPower', on: form.get('actionCommand') === 'on' },
      },
    ],
    cooldownSeconds: Number(form.get('cooldownMinutes') || 0) * 60,
  };

  const rule = await guard(() => api('/automations', { method: 'POST', body }), {
    success: 'Automation gespeichert.',
  });
  if (!rule) return;
  event.target.reset();
  store.automations = await api('/automations');
  renderAutomations();
});

// --- Einstellungen ----------------------------------------------------------

async function renderSettings() {
  store.integrations = await api('/integrations');
  $('#settings-integrations').innerHTML = store.integrations
    .map(
      (integration) => `
      <div class="item">
        <div>
          <div class="title">${esc(integration.name)}
            ${integration.status === 'linked' ? '<span class="badge ok">verbunden</span>' : `<span class="badge error">${esc(integration.status)}</span>`}
          </div>
          <div class="sub">${esc(VENDOR_LABEL[integration.type] || integration.type)} ·
            ${esc(integration.config.host)} · ${integration.deviceCount} Gerät(e)
            ${integration.lastError ? `<br /><span class="badge error">${esc(integration.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="row" style="margin:0">
          <button class="small" data-sync="${esc(integration.id)}">Synchronisieren</button>
          <button class="small" data-test="${esc(integration.id)}">Testen</button>
          <button class="small danger" data-remove-integration="${esc(integration.id)}">Entfernen</button>
        </div>
      </div>`,
    )
    .join('');

  $$('[data-sync]').forEach((button) =>
    button.addEventListener('click', async () => {
      const result = await guard(() => api(`/integrations/${button.dataset.sync}/sync`, { method: 'POST' }));
      if (result) {
        toast(`+${result.added} neu, ${result.updated} aktualisiert, ${result.removed} entfernt`, 'success');
        await refreshDevices();
      }
    }),
  );
  $$('[data-test]').forEach((button) =>
    button.addEventListener('click', async () => {
      const result = await guard(() => api(`/integrations/${button.dataset.test}/test`, { method: 'POST' }));
      if (result) {
        toast(result.status === 'linked' ? 'Verbindung in Ordnung.' : `Fehler: ${result.lastError}`,
          result.status === 'linked' ? 'success' : 'error');
        await renderSettings();
      }
    }),
  );
  $$('[data-remove-integration]').forEach((button) =>
    button.addEventListener('click', async () => {
      if (!confirm('Integration und alle zugehörigen Geräte entfernen?')) return;
      await guard(() => api(`/integrations/${button.dataset.removeIntegration}`, { method: 'DELETE' }));
      await loadDashboardData();
      await renderSettings();
    }),
  );

  store.rooms = await api('/rooms');
  $('#settings-rooms').innerHTML = store.rooms
    .map(
      (room) => `
      <div class="item">
        <div>
          <div class="title">${esc(room.name)}</div>
          <div class="sub">${room.deviceCount} Gerät(e) · ${fmt.temperature(room.climate?.temperatureC ?? null)}</div>
        </div>
        <button class="small danger" data-remove-room="${esc(room.id)}">Entfernen</button>
      </div>`,
    )
    .join('');
  $$('[data-remove-room]').forEach((button) =>
    button.addEventListener('click', async () => {
      await guard(() => api(`/rooms/${button.dataset.removeRoom}`, { method: 'DELETE' }));
      await loadDashboardData();
      await renderSettings();
    }),
  );

  const tokens = await api('/household/tokens');
  $('#tokens-list').innerHTML = tokens
    .map(
      (token) => `
      <div class="item">
        <div>
          <div class="title">${esc(token.name)}</div>
          <div class="sub">erstellt ${fmt.time(token.createdAt)} · zuletzt genutzt ${fmt.time(token.lastUsedAt)}</div>
        </div>
        <button class="small danger" data-revoke="${esc(token.id)}">Widerrufen</button>
      </div>`,
    )
    .join('');
  $$('[data-revoke]').forEach((button) =>
    button.addEventListener('click', async () => {
      await guard(() => api(`/household/tokens/${button.dataset.revoke}`, { method: 'DELETE' }));
      await renderSettings();
    }),
  );

  const info = store.info;
  $('#system-info').innerHTML = `
    <dt>Version</dt><dd>${esc(info.version)}</dd>
    <dt>Node</dt><dd>${esc(info.node)}</dd>
    <dt>Abfrageintervall</dt><dd>${info.settings.pollIntervalSeconds} s</dd>
    <dt>Messwerte-Aufbewahrung</dt><dd>${info.settings.telemetryRetentionDays} Tage</dd>
    <dt>Adapter</dt><dd>${esc(info.adapters.map((a) => a.displayName).join(', '))}</dd>`;
}

$('#btn-settings-discover').addEventListener('click', () => runDiscovery(false, '#settings-discovery'));
$('#btn-sync-all').addEventListener('click', async () => {
  for (const integration of store.integrations) {
    await guard(() => api(`/integrations/${integration.id}/sync`, { method: 'POST' }));
  }
  await loadDashboardData();
  renderActiveTab();
  toast('Alle Integrationen synchronisiert.', 'success');
});

$('#form-settings-room').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  await guard(() => api('/rooms', { method: 'POST', body: { name } }));
  event.target.reset();
  await loadDashboardData();
  await renderSettings();
});

$('#form-token').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get('name');
  const result = await guard(() => api('/household/tokens', { method: 'POST', body: { name } }));
  if (!result) return;
  event.target.reset();
  prompt('Neues Token (wird nur einmal angezeigt):', result.accessToken);
  await renderSettings();
});

// ---------------------------------------------------------------------------
// Live-Updates
// ---------------------------------------------------------------------------

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderActiveTab();
  }, 400);
}

function connectEventStream() {
  const source = new EventSource(`/api/events?access_token=${encodeURIComponent(store.token)}`);

  source.addEventListener('ready', () => {
    $('#live-dot').className = 'dot live';
    $('#live-text').textContent = 'live';
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
  source.addEventListener('automation.triggered', (event) => {
    const { ruleName } = JSON.parse(event.data);
    toast(`Automation ausgelöst: ${ruleName}`, 'success');
  });
  source.addEventListener('notification', (event) => {
    const { message, level } = JSON.parse(event.data);
    toast(message, level === 'error' ? 'error' : 'info');
  });

  source.onerror = () => {
    $('#live-dot').className = 'dot down';
    $('#live-text').textContent = 'getrennt – neuer Versuch…';
  };
}

// Kennzahlen periodisch nachladen (Summary/Klima kommen nicht über SSE).
setInterval(async () => {
  if ($('#view-app').classList.contains('hidden')) return;
  try {
    store.summary = await api('/household/summary');
    store.climate = await api('/telemetry/climate');
    if (store.activeTab === 'overview') renderOverview();
  } catch {
    /* im nächsten Durchlauf erneut versuchen */
  }
}, 30_000);

void boot();
