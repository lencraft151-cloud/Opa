/** Dashboard: Übersicht, Räume, Geräte, Energie, Verlauf, Automationen, Einstellungen. */

import { api, errorBanner, guard, toast } from './api.js';
import { ACCENT_PRESETS, applyAppearance, FONT_SCALES, THEMES } from './appearance.js';
import { barList, gauge, lineChart } from './charts.js';
import { bindDeviceControls, deviceCard, emptyState, skeletonGrid, tile } from './components.js';
import { esc, fmt, METRIC_LABEL, plural, VENDOR_LABEL } from './format.js';
import { bindManualForm, manualForm, runDiscovery } from './integrations.js';
import { applyUpdate } from './selfupdate.js';

const $ = (selector) => document.querySelector(selector);

/** Gemeinsamer Datenstand aller Ansichten. */
export const store = {
  /** Antwort von `/system/info` – Fassung, Kennung, verfügbare Adapter. */
  systemInfo: null,
  summary: null,
  household: null,
  rooms: [],
  devices: [],
  integrations: [],
  automations: [],
  climate: null,
  updates: null,
  energy: null,
  templates: null,
  energyPeriod: 'today',
  historyDeviceId: '',
  historyMetric: 'temperatureC',
  historyHours: 24,
};

export async function loadDashboardData() {
  const [summary, rooms, devices, integrations, automations, climate, updates, energy] =
    await Promise.all([
      api('/household/summary'),
      api('/rooms'),
      api('/devices'),
      api('/integrations'),
      api('/automations'),
      api('/telemetry/climate'),
      api('/updates'),
      // Die Übersicht zeigt die Tageskosten – ohne dieses Vorabladen stünde
      // dort bis zum ersten Besuch der Energie-Ansicht nur ein Platzhalter.
      api(`/energy/summary?period=${store.energyPeriod}`),
    ]);
  Object.assign(store, {
    summary,
    household: summary.household,
    rooms,
    devices,
    integrations,
    automations,
    climate,
    updates,
    energy,
  });
  $('#household-name').textContent = summary.household.name;
}

const deviceById = (id) => store.devices.find((device) => device.id === id);
const roomName = (roomId) => store.rooms.find((room) => room.id === roomId)?.name ?? 'Ohne Raum';

/**
 * Aufgeklappte Bereiche über das Neuzeichnen hinweg merken.
 *
 * Die Ansichten werden bei jedem Live-Update neu aufgebaut. Ohne diesen
 * Merker klappt der Farbwähler mitten im Aussuchen wieder zu, weil im
 * Hintergrund ein Messwert eingetroffen ist.
 */
const openSections = new Set();

export function restoreOpenSections(root) {
  root.querySelectorAll('details[data-section]').forEach((details) => {
    const key = details.dataset.section;
    if (openSections.has(key)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) openSections.add(key);
      else openSections.delete(key);
    });
  });
}

/** Ein Gerätekommando senden und die Karte sofort aktualisieren. */
export async function sendCommand(deviceId, command) {
  const updated = await guard(() =>
    api(`/devices/${deviceId}/command`, { method: 'POST', body: command }),
  );
  if (!updated) {
    // Fehlgeschlagen: den echten Zustand wiederherstellen, sonst zeigt der
    // Schalter etwas an, das gar nicht passiert ist.
    await reloadDevices();
    return;
  }
  const index = store.devices.findIndex((device) => device.id === deviceId);
  if (index >= 0) store.devices[index] = updated;
  renderCurrent();
}

export async function reloadDevices() {
  store.devices = await api('/devices');
  renderCurrent();
}

// ---------------------------------------------------------------------------
// Ansichtswechsel
// ---------------------------------------------------------------------------

const RENDERERS = {
  overview: renderOverview,
  rooms: renderRooms,
  devices: renderDevices,
  energy: renderEnergy,
  history: renderHistory,
  automations: renderAutomations,
  settings: renderSettings,
};

let current = 'overview';

export function renderPanel(name) {
  current = name;
  for (const key of Object.keys(RENDERERS)) {
    $(`#panel-${key}`).classList.toggle('hidden', key !== name);
  }
  void RENDERERS[name]?.();
}

export function renderCurrent() {
  void RENDERERS[current]?.();
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

function renderOverview() {
  const panel = $('#panel-overview');
  const summary = store.summary;
  if (!summary) {
    panel.innerHTML = skeletonGrid(4);
    return;
  }

  panel.innerHTML = '';

  // Probleme zuerst – sie sind der Grund, warum jemand das Dashboard öffnet.
  for (const problem of summary.integrations.problems ?? []) {
    panel.append(
      errorBanner({
        title: `${problem.name} meldet ein Problem`,
        hint: problem.error ?? 'Unbekannter Fehler',
        actionLabel: 'Erneut versuchen',
        onAction: async () => {
          const result = await guard(() =>
            api(`/integrations/${problem.id}/test`, { method: 'POST' }),
          );
          if (result?.status === 'linked') {
            toast('Verbindung steht wieder.', { kind: 'success' });
            await refreshSummary();
          }
        },
      }),
    );
  }

  if ((store.updates?.updatesAvailable ?? 0) > 0) {
    panel.append(
      errorBanner({
        kind: 'warn',
        title: `${plural(store.updates.updatesAvailable, "Firmware-Update", "Firmware-Updates")} verfügbar`,
        hint: store.updates.autoUpdate.enabled
          ? `Wird automatisch zwischen ${store.updates.autoUpdate.from} und ${store.updates.autoUpdate.to} Uhr installiert.`
          : 'Automatische Installation ist aus – du kannst sie in den Einstellungen aktivieren.',
        actionLabel: 'Zu den Updates',
        onAction: () => renderPanel('settings'),
      }),
    );
  }

  const climateRooms = store.climate?.rooms ?? [];
  const gaugeHtml = gauge({
    value: summary.averageTemperatureC,
    min: 5,
    max: 30,
    label: 'Ø im Haushalt',
  });

  const tiles = document.createElement('div');
  tiles.className = 'tiles';
  tiles.innerHTML = [
    tile({ value: fmt.power(summary.totalPowerW), label: 'Aktuelle Leistung', accent: true }),
    tile({
      value: store.energy ? fmt.money(store.energy.totalCost, store.energy.currency) : '…',
      label: 'Stromkosten heute',
    }),
    tile({ value: String(summary.lightsOn), label: 'Geräte eingeschaltet' }),
    tile({ value: `${summary.reachable}/${summary.total}`, label: 'Geräte erreichbar' }),
  ].join('');

  const warmest = [...climateRooms]
    .filter((room) => typeof room.temperatureC === 'number')
    .sort((a, b) => b.temperatureC - a.temperatureC);

  const hero = document.createElement('div');
  hero.className = 'card hero';
  hero.innerHTML = `
    <div class="hero-main">
      ${gaugeHtml}
      <div>
        <h2>${esc(greeting())}</h2>
        <div class="muted">${esc(
          [
            plural(store.rooms.length, 'Raum', 'Räume'),
            plural(summary.total, 'Gerät', 'Geräte'),
            plural(store.automations.length, 'Automation', 'Automationen'),
          ].join(' · '),
        )}</div>
        ${
          warmest.length >= 2
            ? `<div class="muted small" style="margin-top:.4rem">
                 Wärmster Raum: <b>${esc(warmest[0].roomName)}</b> ${esc(fmt.temperature(warmest[0].temperatureC))} ·
                 kühlster: <b>${esc(warmest[warmest.length - 1].roomName)}</b>
                 ${esc(fmt.temperature(warmest[warmest.length - 1].temperatureC))}
               </div>`
            : ''
        }
      </div>
    </div>
    <dl class="kv hero-facts">
      <dt>Integrationen</dt><dd>${summary.integrations.linked} verbunden${
        summary.integrations.error > 0 ? `, ${summary.integrations.error} gestört` : ''
      }</dd>
      <dt>Rollläden</dt><dd>${describeCovers()}</dd>
      <dt>Firmware</dt><dd>${
        (store.updates?.updatesAvailable ?? 0) > 0
          ? `${plural(store.updates.updatesAvailable, "Update", "Updates")} verfügbar`
          : 'alles aktuell'
      }</dd>
      <dt>Verbrauch heute</dt><dd>${esc(
        store.energy ? fmt.energy(store.energy.totalKwh) : '–',
      )}</dd>
    </dl>`;

  const quick = document.createElement('div');
  quick.className = 'quick-actions';
  quick.innerHTML = `
    <button data-quick="lights-off">Alle Lichter aus</button>
    <button data-quick="covers-open">Rollläden auf</button>
    <button data-quick="covers-close">Rollläden zu</button>
    <button data-quick="refresh">Aktualisieren</button>`;

  panel.append(hero, tiles, quick);

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = '<h2>Klima nach Raum</h2>';
  panel.append(head);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.innerHTML = climateRooms.length
    ? climateRooms.map(climateCard).join('')
    : emptyState(
        '🌡️',
        'Noch keine Messwerte.',
        'Ordne Temperatursensoren einem Raum zu, dann erscheinen sie hier.',
      );
  panel.append(grid);

  wireQuickActions(quick);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Gute Nacht';
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

/** Kurzfassung des Rollladen-Zustands für die Übersicht. */
function describeCovers() {
  const covers = store.devices.filter((device) => device.capabilities.includes('cover'));
  if (covers.length === 0) return 'keine vorhanden';

  const moving = covers.filter((device) =>
    ['opening', 'closing'].includes(device.state.coverState ?? ''),
  ).length;
  if (moving > 0) return `${moving} von ${covers.length} in Bewegung`;

  const open = covers.filter((device) => (device.state.position ?? 0) > 50).length;
  return `${open} von ${covers.length} offen`;
}

function climateCard(room) {
  const sensors = room.sensors ?? [];
  return `<article class="device-card">
    <header>
      <div class="name">${esc(room.roomName)}</div>
      ${
        room.targetTemperatureC !== null
          ? `<span class="badge">Soll ${esc(fmt.temperature(room.targetTemperatureC))}</span>`
          : ''
      }
    </header>
    <div class="readings">
      <span class="reading">🌡️ <strong>${esc(fmt.temperature(room.temperatureC))}</strong></span>
      <span class="reading">💧 <strong>${esc(fmt.percent(room.humidity))}</strong></span>
    </div>
    <div class="meta">${
      sensors.length
        ? sensors
            .map(
              (sensor) =>
                `${esc(sensor.name)}: ${esc(fmt.temperature(sensor.temperatureC))}${
                  sensor.batteryPercent !== null ? ` · 🔋 ${esc(fmt.percent(sensor.batteryPercent))}` : ''
                }${sensor.reachable ? '' : ' · offline'}`,
            )
            .join('<br />')
        : 'Kein Sensor in diesem Raum'
    }</div>
  </article>`;
}

function wireQuickActions(root) {
  root.querySelectorAll('[data-quick]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.quick;
      button.disabled = true;
      try {
        if (action === 'refresh') {
          await loadDashboardData();
          renderCurrent();
          toast('Aktualisiert.', { kind: 'success', timeout: 2500 });
          return;
        }
        const body =
          action === 'lights-off'
            ? { target: { allWithCapability: 'switch' }, command: { type: 'setPower', on: false } }
            : {
                target: { allWithCapability: 'cover' },
                command: { type: action === 'covers-open' ? 'openCover' : 'closeCover' },
              };
        const result = await guard(() => api('/devices/command', { method: 'POST', body }));
        if (result) {
          toast(`${plural(result.succeeded, "Gerät", "Geräte")} geschaltet.`, {
            kind: result.failed > 0 ? 'warn' : 'success',
            hint: result.failed > 0 ? `${plural(result.failed, "Gerät hat", "Geräte haben")} nicht reagiert.` : "",
          });
          await reloadDevices();
        }
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function refreshSummary() {
  store.summary = await api('/household/summary');
  store.integrations = await api('/integrations');
  renderCurrent();
}

// ---------------------------------------------------------------------------
// Räume
// ---------------------------------------------------------------------------

function renderRooms() {
  const panel = $('#panel-rooms');
  const unassigned = store.devices.filter((device) => device.roomId === null);

  if (store.rooms.length === 0 && unassigned.length === 0) {
    panel.innerHTML = emptyState(
      '🏠',
      'Noch keine Räume angelegt.',
      'Räume fassen Geräte zusammen: Du siehst die Temperatur je Raum und kannst alles darin auf einmal schalten. Anlegen kannst du sie unter Einstellungen.',
    );
    return;
  }

  const groups = store.rooms.map((room) => {
    const devices = store.devices.filter((device) => device.roomId === room.id);
    const covers = devices.filter((device) => device.capabilities.includes('cover'));
    return `<section class="card">
      <div class="row between">
        <div>
          <h2 style="margin:0">${esc(room.name)}</h2>
          <div class="muted small">
            ${esc(fmt.temperature(room.climate?.temperatureC ?? null))} ·
            💧 ${esc(fmt.percent(room.climate?.humidity ?? null))} ·
            ⚡ ${esc(fmt.power(room.climate?.powerW ?? 0))} · ${esc(plural(devices.length, "Gerät", "Geräte"))}
          </div>
        </div>
        <div class="row tight">
          <button class="small" data-room-power="${esc(room.id)}" data-on="1">Alles an</button>
          <button class="small" data-room-power="${esc(room.id)}" data-on="">Alles aus</button>
          ${
            covers.length
              ? `<button class="small" data-room-cover="${esc(room.id)}" data-open="1">Rollläden auf</button>
                 <button class="small" data-room-cover="${esc(room.id)}" data-open="">Rollläden zu</button>`
              : ''
          }
        </div>
      </div>
      <div class="grid">${
        devices.length
          ? devices.map((device) => deviceCard(device)).join('')
          : emptyState('📭', 'Keine Geräte in diesem Raum.')
      }</div>
    </section>`;
  });

  if (unassigned.length > 0) {
    groups.push(`<section class="card">
      <div class="row between">
        <h2 style="margin:0">Ohne Raum</h2>
        <span class="badge warn">${esc(plural(unassigned.length, "Gerät", "Geräte"))}</span>
      </div>
      <div class="grid">${unassigned.map((device) => deviceCard(device)).join('')}</div>
    </section>`);
  }

  panel.innerHTML = groups.join('');
  bindDeviceControls(panel, sendCommand);
  restoreOpenSections(panel);

  panel.querySelectorAll('[data-room-power]').forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() =>
        api(`/rooms/${button.dataset.roomPower}/command`, {
          method: 'POST',
          body: { type: 'setPower', on: Boolean(button.dataset.on) },
        }),
      );
      await reloadDevices();
    });
  });

  panel.querySelectorAll('[data-room-cover]').forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() =>
        api(`/rooms/${button.dataset.roomCover}/command`, {
          method: 'POST',
          body: { type: button.dataset.open ? 'openCover' : 'closeCover' },
        }),
      );
      await reloadDevices();
    });
  });
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

let deviceFilter = { search: '', capability: '' };

function renderDevices() {
  const panel = $('#panel-devices');
  const devices = store.devices.filter((device) => {
    if (deviceFilter.capability && !device.capabilities.includes(deviceFilter.capability)) return false;
    if (
      deviceFilter.search &&
      !device.name.toLowerCase().includes(deviceFilter.search.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  panel.innerHTML = `
    <p class="intro">
      Alle eingebundenen Geräte an einem Ort – Hue, Shelly und Homematic nebeneinander,
      neue Geräte genauso wie alte. Unter jedem Namen steht, was das Gerät kann.
    </p>
    <div class="row">
      <input id="device-search" class="grow" placeholder="Geräte durchsuchen…"
             value="${esc(deviceFilter.search)}" />
      <select id="device-filter">
        ${[
          ['', 'Alle Geräte'],
          ['switch', 'Schaltbar'],
          ['dimmer', 'Dimmbar'],
          ['cover', 'Rollläden'],
          ['sensor.temperature', 'Temperatur'],
          ['sensor.humidity', 'Luftfeuchte'],
          ['sensor.power', 'Verbrauch'],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${deviceFilter.capability === value ? 'selected' : ''}>${label}</option>`,
          )
          .join('')}
      </select>
    </div>
    <div class="grid" id="devices-grid">${
      devices.length
        ? devices
            .map((device) => deviceCard(device, { showMeta: true, roomName: roomName(device.roomId) }))
            .join('')
        : emptyState('🔍', 'Keine passenden Geräte.', 'Setze den Filter zurück oder ändere die Suche.')
    }</div>`;

  bindDeviceControls(panel, sendCommand);
  restoreOpenSections(panel);

  $('#device-search').addEventListener('input', (event) => {
    deviceFilter.search = event.target.value;
    renderDevices();
    // Fokus und Cursor nach dem Neuzeichnen zurückgeben.
    const field = $('#device-search');
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  $('#device-filter').addEventListener('change', (event) => {
    deviceFilter.capability = event.target.value;
    renderDevices();
  });
}

// ---------------------------------------------------------------------------
// Energie
// ---------------------------------------------------------------------------

const PERIODS = [
  ['today', 'Heute'],
  ['yesterday', 'Gestern'],
  ['week', '7 Tage'],
  ['month', '30 Tage'],
  ['year', '12 Monate'],
];

async function renderEnergy() {
  const panel = $('#panel-energy');
  if (!store.energy || store.energy.period.key !== store.energyPeriod) {
    panel.innerHTML = skeletonGrid(3);
    store.energy = await guard(() => api(`/energy/summary?period=${store.energyPeriod}`));
    if (!store.energy) {
      panel.innerHTML = emptyState('⚡', 'Verbrauchsdaten konnten nicht geladen werden.');
      return;
    }
  }

  const energy = store.energy;
  const currency = energy.currency;

  panel.innerHTML = `
    <p class="intro">
      Was verbrauchen deine Geräte – und was kostet das? Gezählt wird nur, was auch messen
      kann: Shelly-Geräte mit Strommessung. Der Preis pro Kilowattstunde steht in den
      Einstellungen.
    </p>
    <div class="chips">${PERIODS.map(
      ([key, label]) =>
        `<button class="chip ${store.energyPeriod === key ? 'active' : ''}" data-period="${key}">${label}</button>`,
    ).join('')}</div>

    <div class="tiles">
      ${tile({ value: fmt.energy(energy.totalKwh), label: `Verbrauch · ${energy.period.label}`, accent: true })}
      ${tile({ value: fmt.money(energy.totalCost, currency), label: 'Kosten', trend: energy.baseCost > 0 ? `inkl. ${fmt.money(energy.baseCost, currency)} Grundgebühr` : '' })}
      ${tile({ value: fmt.power(energy.currentPowerW), label: 'Gerade jetzt' })}
      ${
        energy.projection
          ? tile({
              value: fmt.money(energy.projection.perMonthCost, currency),
              label: 'Hochrechnung pro Monat',
              trend: fmt.energy(energy.projection.perMonthKwh),
            })
          : tile({
              value: '–',
              label: 'Hochrechnung pro Monat',
              trend: 'noch zu wenige Messwerte',
            })
      }
    </div>
    ${
      energy.projection
        ? ''
        : `<p class="muted small">Für eine Hochrechnung braucht der Hub Messwerte über einen
             größeren Teil des Zeitraums – bisher sind es ${Math.round(energy.coverage * 100)} %.
             Wähle einen kürzeren Zeitraum oder warte, bis mehr Daten vorliegen.</p>`
    }

    <div class="card">
      <div class="section-head"><h2>Größte Verbraucher</h2>
        <span class="muted small">${esc(energy.period.label)}</span></div>
      ${barList(
        energy.devices.slice(0, 8).map((device) => ({
          label: device.name,
          sub: device.roomName ?? 'ohne Raum',
          value: device.energyKwh,
        })),
        {
          formatValue: (value) => `${fmt.energy(value)} · ${fmt.money(value * energy.pricePerKwh, currency)}`,
          emptyText: 'Noch keine Verbrauchsdaten – der Hub braucht ein paar Messwerte.',
        },
      )}
    </div>

    <div class="card">
      <div class="section-head"><h2>Verbrauch nach Raum</h2></div>
      ${barList(
        energy.rooms.map((room) => ({
          label: room.roomName,
          sub: plural(room.deviceCount, "Gerät", "Geräte"),
          value: room.energyKwh,
        })),
        { formatValue: (value) => fmt.energy(value), emptyText: 'Keine Räume mit Messgeräten.' },
      )}
    </div>

    <div class="card">
      <div class="section-head"><h2>Dauerverbraucher</h2>
        <span class="muted small">durchgehend unter 15 W</span></div>
      ${
        energy.standby.devices.length
          ? `<p class="muted">Zusammen ${esc(fmt.power(energy.standby.totalPowerW))} –
               das sind etwa <strong>${esc(fmt.money(energy.standby.costPerYear, currency))}</strong> im Jahr.</p>
             ${barList(
               energy.standby.devices.map((device) => ({
                 label: device.name,
                 value: device.powerW,
                 sub: `${fmt.money(device.costPerYear, currency)}/Jahr`,
               })),
               { formatValue: (value) => fmt.power(value) },
             )}`
          : emptyState('✅', 'Keine auffälligen Dauerverbraucher gefunden.')
      }
    </div>

    <p class="muted small">
      Grundlage: ${esc(fmt.money(energy.pricePerKwh, currency))} pro kWh.
      ${
        energy.unmeteredDeviceCount > 0
          ? `${plural(energy.unmeteredDeviceCount, "Gerät misst", "Geräte messen")} keinen Verbrauch und fehlen in der Summe.`
          : ''
      }
    </p>`;

  panel.querySelectorAll('[data-period]').forEach((button) => {
    button.addEventListener('click', () => {
      store.energyPeriod = button.dataset.period;
      store.energy = null;
      void renderEnergy();
    });
  });
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

async function renderHistory() {
  const panel = $('#panel-history');
  const sensors = store.devices.filter((device) =>
    device.capabilities.some((capability) => capability.startsWith('sensor.')),
  );

  if (sensors.length === 0) {
    panel.innerHTML = emptyState('📈', 'Noch keine Sensoren vorhanden.');
    return;
  }

  if (!store.historyDeviceId || !deviceById(store.historyDeviceId)) {
    store.historyDeviceId = sensors[0].id;
  }

  const metrics = availableMetrics(deviceById(store.historyDeviceId));
  if (!metrics.includes(store.historyMetric)) store.historyMetric = metrics[0];

  panel.innerHTML = `
    <p class="intro">
      Wie hat sich ein Messwert entwickelt? Die Linie zeigt den Mittelwert, die Fläche
      darum die Schwankung zwischen kleinstem und größtem Wert im jeweiligen Zeitfenster.
    </p>
    <div class="row">
      <select id="history-device" class="grow">${sensors
        .map(
          (device) =>
            `<option value="${esc(device.id)}" ${device.id === store.historyDeviceId ? 'selected' : ''}>${esc(
              device.name,
            )}</option>`,
        )
        .join('')}</select>
      <select id="history-metric">${metrics
        .map(
          (metric) =>
            `<option value="${metric}" ${metric === store.historyMetric ? 'selected' : ''}>${esc(
              METRIC_LABEL[metric] ?? metric,
            )}</option>`,
        )
        .join('')}</select>
      <select id="history-range">${[
        [6, '6 Stunden'],
        [24, '24 Stunden'],
        [168, '7 Tage'],
        [720, '30 Tage'],
      ]
        .map(
          ([hours, label]) =>
            `<option value="${hours}" ${hours === store.historyHours ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select>
    </div>
    <div class="card chart" id="chart"><div class="skeleton" style="height:240px"></div></div>
    <div class="tiles" id="history-stats"></div>`;

  panel.querySelector('#history-device').addEventListener('change', (event) => {
    store.historyDeviceId = event.target.value;
    void renderHistory();
  });
  panel.querySelector('#history-metric').addEventListener('change', (event) => {
    store.historyMetric = event.target.value;
    void renderHistory();
  });
  panel.querySelector('#history-range').addEventListener('change', (event) => {
    store.historyHours = Number(event.target.value);
    void renderHistory();
  });

  const query = `deviceId=${store.historyDeviceId}&metric=${store.historyMetric}&hours=${store.historyHours}`;
  const [series, aggregate] = await Promise.all([
    guard(() => api(`/telemetry/series?${query}&bucketMinutes=${bucketFor(store.historyHours)}`)),
    guard(() => api(`/telemetry/aggregate?${query}`)),
  ]);
  if (!series) return;

  panel.querySelector('#chart').innerHTML = lineChart(series.series, store.historyMetric);

  const stats = aggregate?.aggregates?.[0];
  panel.querySelector('#history-stats').innerHTML = stats
    ? [
        tile({ value: fmt.metric(stats.min, store.historyMetric), label: 'Minimum' }),
        tile({ value: fmt.metric(stats.avg, store.historyMetric), label: 'Mittelwert', accent: true }),
        tile({ value: fmt.metric(stats.max, store.historyMetric), label: 'Maximum' }),
        tile({ value: String(stats.count), label: 'Messwerte' }),
      ].join('')
    : '';
}

function availableMetrics(device) {
  const map = {
    'sensor.temperature': 'temperatureC',
    'sensor.humidity': 'humidity',
    'sensor.illuminance': 'illuminanceLux',
    'sensor.power': 'powerW',
    'sensor.energy': 'energyWh',
    'sensor.battery': 'batteryPercent',
  };
  const metrics = (device?.capabilities ?? [])
    .map((capability) => map[capability])
    .filter(Boolean);
  return metrics.length > 0 ? metrics : ['temperatureC'];
}

function bucketFor(hours) {
  if (hours <= 6) return 5;
  if (hours <= 24) return 15;
  if (hours <= 168) return 60;
  return 240;
}

// ---------------------------------------------------------------------------
// Automationen
// ---------------------------------------------------------------------------

async function renderAutomations() {
  const panel = $('#panel-automations');
  const sensors = store.devices.filter((device) =>
    device.capabilities.some((capability) => capability.startsWith('sensor.')),
  );
  const switchable = store.devices.filter((device) => device.capabilities.includes('switch'));

  const options = (devices) =>
    devices.map((device) => `<option value="${esc(device.id)}">${esc(device.name)}</option>`).join('');

  if (!store.templates) {
    store.templates = await guard(() => api('/automations/templates'));
  }
  const templates = store.templates?.templates ?? [];

  panel.innerHTML = `
    <p class="intro">
      Eine Automation macht etwas von allein: „Wenn es im Bad unter 19 °C fällt, schalte den
      Heizlüfter ein.“ Am schnellsten geht es mit einer der fertigen Vorlagen – die passenden
      Geräte sind schon ausgewählt.
    </p>

    <div class="section-head"><h2>Fertige Vorlagen</h2>
      <span class="muted small">Ein Klick genügt</span></div>
    <div class="grid">${templates.map(templateCard).join('')}</div>

    <div class="section-head"><h2>Deine Automationen</h2></div>
    <div class="list">${
      store.automations.length
        ? store.automations.map(automationItem).join('')
        : emptyState(
            '🤖',
            'Noch keine Automation angelegt.',
            'Nimm oben eine Vorlage – ändern kannst du sie später jederzeit.',
          )
    }</div>

    <details class="card" data-section="expert-form">
      <summary>Selbst zusammenstellen (für Fortgeschrittene)</summary>
      <form id="form-automation" class="form">
        <label>Name <input name="name" required maxlength="120" placeholder="z. B. Bad heizen" /></label>

        <fieldset>
          <legend>Wenn …</legend>
          <div class="chips" role="group" aria-label="Auslöser">
            <button type="button" class="chip active" data-trigger-kind="sensor">Ein Messwert</button>
            <button type="button" class="chip" data-trigger-kind="schedule">Zu einer Uhrzeit</button>
            <button type="button" class="chip" data-trigger-kind="interval">Immer wieder</button>
          </div>

          <div data-trigger-pane="sensor">
            <div class="row tight">
              <select name="triggerDevice" class="grow" ${sensors.length ? '' : 'disabled'}>${options(sensors)}</select>
              <select name="triggerMetric">
                <option value="temperatureC">Temperatur</option>
                <option value="humidity">Luftfeuchte</option>
                <option value="illuminanceLux">Helligkeit</option>
                <option value="powerW">Leistung</option>
                <option value="batteryPercent">Batterie</option>
              </select>
              <select name="operator">
                <option value="&lt;">kleiner als</option>
                <option value="&gt;">größer als</option>
              </select>
              <input name="value" type="number" step="0.1" value="19" required class="narrow" />
              <input name="forMinutes" type="number" min="0" max="1440" value="5" class="narrow"
                     title="So viele Minuten anhaltend" />
            </div>
            <p class="field-help">
              Die letzte Zahl sind Minuten: So lange muss der Wert anhalten, damit ein
              kurzer Ausreißer nichts auslöst.
            </p>
          </div>

          <div data-trigger-pane="schedule" hidden>
            <div class="row tight">
              <label class="grow">Uhrzeit <input type="time" name="scheduleAt" value="07:30" /></label>
            </div>
            ${weekdayPicker('schedule')}
          </div>

          <div data-trigger-pane="interval" hidden>
            <div class="row tight">
              <label>Alle
                <select name="everyMinutes">${INTERVAL_CHOICES.map(
                  (choice) =>
                    `<option value="${choice.minutes}" ${choice.minutes === 60 ? 'selected' : ''}>${esc(
                      choice.label,
                    )}</option>`,
                ).join('')}</select>
              </label>
              <label>Frühestens ab <input type="time" name="intervalFrom" value="08:00" /></label>
              <label>Spätestens bis <input type="time" name="intervalTo" value="22:00" /></label>
            </div>
            <p class="field-help">
              Wiederholt sich innerhalb des Zeitfensters. Leere Zeiten heißen: rund um die Uhr.
            </p>
            ${weekdayPicker('interval')}
          </div>
        </fieldset>

        <fieldset>
          <legend>… dann</legend>
          <div class="row tight">
            <select name="actionDevice" class="grow" ${switchable.length ? '' : 'disabled'}>${options(switchable)}</select>
            <select name="actionCommand">
              <option value="on">einschalten</option>
              <option value="off">ausschalten</option>
            </select>
            <input name="cooldownMinutes" type="number" min="0" max="1440" value="15" class="narrow"
                   title="Sperrzeit in Minuten" />
          </div>
          <p class="field-help">Die letzte Zahl ist die Sperrzeit: So lange passiert danach nichts erneut.</p>
        </fieldset>

        <button type="submit" class="primary" ${switchable.length ? '' : 'disabled'}>
          Automation speichern
        </button>
        ${
          switchable.length
            ? ''
            : '<p class="muted small">Dafür wird mindestens ein schaltbares Gerät gebraucht.</p>'
        }
      </form>
    </details>`;

  wireTemplates(panel);
  restoreOpenSections(panel);

  // Umschalter zwischen Messwert, Uhrzeit und Wiederholung.
  let triggerKind = 'sensor';
  panel.querySelectorAll('[data-trigger-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      triggerKind = button.dataset.triggerKind;
      panel.querySelectorAll('[data-trigger-kind]').forEach((other) => {
        other.classList.toggle('active', other === button);
      });
      panel.querySelectorAll('[data-trigger-pane]').forEach((pane) => {
        pane.hidden = pane.dataset.triggerPane !== triggerKind;
      });
    });
  });

  panel.querySelector('#form-automation').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const body = {
      name: form.get('name'),
      trigger: buildTrigger(triggerKind, form, event.target),
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
    store.automations = await api('/automations');
    void renderAutomations();
  });

  panel.querySelectorAll('[data-rule-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const { ruleAction: action, ruleId, enabled } = button.dataset;
      if (action === 'run') {
        await guard(() => api(`/automations/${ruleId}/run`, { method: 'POST' }), {
          success: 'Automation ausgeführt.',
        });
      } else if (action === 'toggle') {
        await guard(() =>
          api(`/automations/${ruleId}`, { method: 'PATCH', body: { enabled: !enabled } }),
        );
      } else if (action === 'delete') {
        await guard(() => api(`/automations/${ruleId}`, { method: 'DELETE' }));
      }
      store.automations = await api('/automations');
      void renderAutomations();
    });
  });
}

/**
 * Auswahlmöglichkeiten für Wiederholungen.
 *
 * Kürzer als fünf Minuten lässt der Hub nicht zu – häufiger wäre nur Last
 * ohne Nutzen, und die Messwerte selbst kommen auch nicht schneller.
 */
const INTERVAL_CHOICES = [
  { minutes: 15, label: '15 Minuten' },
  { minutes: 30, label: '30 Minuten' },
  { minutes: 60, label: 'Stunde' },
  { minutes: 120, label: '2 Stunden' },
  { minutes: 240, label: '4 Stunden' },
  { minutes: 480, label: '8 Stunden' },
  { minutes: 720, label: '12 Stunden' },
  { minutes: 1440, label: 'Tag' },
];

/** Wochentage nach ISO: 0 = Sonntag, wie in `Date.getDay()`. */
const WEEKDAYS = [
  { value: 1, short: 'Mo' },
  { value: 2, short: 'Di' },
  { value: 3, short: 'Mi' },
  { value: 4, short: 'Do' },
  { value: 5, short: 'Fr' },
  { value: 6, short: 'Sa' },
  { value: 0, short: 'So' },
];

function weekdayPicker(scope) {
  return `<div class="weekdays" role="group" aria-label="Wochentage">
    ${WEEKDAYS.map(
      (day) => `<label class="weekday">
        <input type="checkbox" name="${esc(scope)}Days" value="${day.value}" />
        <span>${day.short}</span>
      </label>`,
    ).join('')}
    <span class="field-help">Nichts angekreuzt heißt: an jedem Tag.</span>
  </div>`;
}

/** Baut aus dem Formular den passenden Auslöser. */
function buildTrigger(kind, form, element) {
  const days = (scope) =>
    [...element.querySelectorAll(`input[name="${scope}Days"]:checked`)].map((input) =>
      Number(input.value),
    );

  if (kind === 'schedule') {
    return { type: 'schedule', at: form.get('scheduleAt'), days: days('schedule') };
  }

  if (kind === 'interval') {
    const trigger = {
      type: 'interval',
      everyMinutes: Number(form.get('everyMinutes')),
      days: days('interval'),
    };
    // Ein halb ausgefülltes Zeitfenster weist der Hub ab – deshalb nur
    // mitschicken, wenn beide Zeiten dastehen.
    const from = form.get('intervalFrom');
    const to = form.get('intervalTo');
    if (from && to) {
      trigger.from = from;
      trigger.to = to;
    }
    return trigger;
  }

  return {
    type: 'sensor',
    deviceId: form.get('triggerDevice'),
    metric: form.get('triggerMetric'),
    operator: form.get('operator'),
    value: Number(form.get('value')),
    forSeconds: Number(form.get('forMinutes') || 0) * 60,
  };
}

/** Karte einer fertigen Vorlage inklusive anpassbarer Felder. */
function templateCard(template) {
  const fields = template.fields
    .map((field) => templateField(template, field))
    .join('');

  return `<article class="device-card template-card ${template.applicable ? '' : 'unavailable'}"
                   data-template="${esc(template.id)}">
    <header>
      <div>
        <div class="name">${template.emoji} ${esc(template.name)}</div>
        <div class="meta">${esc(template.summary)}</div>
      </div>
    </header>
    <p class="muted small">${esc(template.explanation)}</p>
    ${
      template.applicable
        ? `<details class="template-fields" data-section="tpl:${esc(template.id)}">
             <summary>Anpassen</summary>
             <form class="form" data-template-form="${esc(template.id)}">${fields}</form>
           </details>
           <button class="primary" data-template-apply="${esc(template.id)}">Übernehmen</button>`
        : `<div class="callout warn" style="margin:0">
             <strong>Dafür fehlt noch etwas</strong>
             <span>${esc(template.missing.join(' '))}</span>
           </div>`
    }
  </article>`;
}

function templateField(template, field) {
  const value = template.defaults[field.key];
  const help = `<span class="field-help">${esc(field.help)}</span>`;

  if (field.type === 'number') {
    return `<label>${esc(field.label)}${field.unit ? ` (${esc(field.unit)})` : ''}
      <input type="number" name="${esc(field.key)}" value="${esc(String(value ?? ''))}"
             ${field.min !== undefined ? `min="${field.min}"` : ''}
             ${field.max !== undefined ? `max="${field.max}"` : ''}
             ${field.step !== undefined ? `step="${field.step}"` : ''} />
      ${help}</label>`;
  }

  if (field.type === 'time') {
    return `<label>${esc(field.label)}
      <input type="time" name="${esc(field.key)}" value="${esc(String(value ?? '07:00'))}" />
      ${help}</label>`;
  }

  const options = template.options[field.key] ?? [];
  if (field.type === 'device') {
    return `<label>${esc(field.label)}
      <select name="${esc(field.key)}">${options
        .map(
          (option) =>
            `<option value="${esc(option.id)}" ${option.id === value ? 'selected' : ''}>${esc(
              option.label,
            )}</option>`,
        )
        .join('')}</select>
      ${help}</label>`;
  }

  // Mehrfachauswahl als Ankreuzfelder – ein Mehrfach-Listenfeld ist auf dem
  // Handy kaum bedienbar.
  const selected = new Set(Array.isArray(value) ? value : []);
  return `<fieldset>
    <legend>${esc(field.label)}</legend>
    ${options
      .map(
        (option) => `<label class="check">
          <input type="checkbox" name="${esc(field.key)}" value="${esc(option.id)}"
                 ${selected.has(option.id) ? 'checked' : ''} />
          <span>${esc(option.label)}</span>
        </label>`,
      )
      .join('')}
    ${help}
  </fieldset>`;
}

function wireTemplates(panel) {
  panel.querySelectorAll('[data-template-apply]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.templateApply;
      const template = (store.templates?.templates ?? []).find((entry) => entry.id === id);
      const form = panel.querySelector(`[data-template-form="${CSS.escape(id)}"]`);

      const values = {};
      for (const field of template?.fields ?? []) {
        if (field.type === 'devices') {
          values[field.key] = [...form.querySelectorAll(`input[name="${CSS.escape(field.key)}"]:checked`)].map(
            (input) => input.value,
          );
        } else {
          const input = form.querySelector(`[name="${CSS.escape(field.key)}"]`);
          if (!input) continue;
          values[field.key] = field.type === 'number' ? Number(input.value) : input.value;
        }
      }

      button.disabled = true;
      const rule = await guard(
        () => api(`/automations/templates/${id}`, { method: 'POST', body: { values } }),
        { success: 'Automation angelegt.', successHint: 'Du findest sie unten in der Liste.' },
      );
      button.disabled = false;
      if (!rule) return;

      store.automations = await api('/automations');
      void renderAutomations();
    });
  });
}

function automationItem(rule) {
  return `<div class="item">
    <div>
      <div class="title">${esc(rule.name)}
        ${rule.enabled ? '<span class="badge ok">aktiv</span>' : '<span class="badge">pausiert</span>'}
      </div>
      <div class="sub">${esc(describeTrigger(rule.trigger))} · zuletzt ${esc(fmt.relative(rule.lastTriggeredAt))}</div>
    </div>
    <div class="row tight">
      <button class="small" data-rule-action="run" data-rule-id="${esc(rule.id)}">Testen</button>
      <button class="small" data-rule-action="toggle" data-rule-id="${esc(rule.id)}"
              data-enabled="${rule.enabled ? '1' : ''}">${rule.enabled ? 'Pausieren' : 'Aktivieren'}</button>
      <button class="small danger" data-rule-action="delete" data-rule-id="${esc(rule.id)}">Löschen</button>
    </div>
  </div>`;
}

export function describeTrigger(trigger, lookup = (id) => deviceById(id)?.name ?? id) {
  if (trigger.type === 'sensor') {
    const metric = METRIC_LABEL[trigger.metric] ?? trigger.metric;
    const hold = trigger.forSeconds ? ` für ${Math.round(trigger.forSeconds / 60)} min` : '';
    return `${lookup(trigger.deviceId)}: ${metric} ${trigger.operator} ${trigger.value}${hold}`;
  }
  if (trigger.type === 'deviceState') {
    const property = trigger.property === 'motion' ? 'Bewegung' : 'eingeschaltet';
    return `${lookup(trigger.deviceId)}: ${property} = ${trigger.equals ? 'ja' : 'nein'}`;
  }
  if (trigger.type === 'interval') {
    const every = describeEvery(trigger.everyMinutes);
    const window = trigger.from && trigger.to ? ` zwischen ${trigger.from} und ${trigger.to} Uhr` : '';
    return `Alle ${every}${window}${describeDays(trigger.days)}`;
  }
  return `Um ${trigger.at} Uhr${describeDays(trigger.days)}`;
}

/** „90 Minuten“ ist schwerer zu lesen als „1,5 Stunden“ – aber nur knapp. */
function describeEvery(minutes) {
  if (!minutes || minutes < 60) return `${minutes} Minuten`;
  if (minutes === 60) return 'Stunde';
  if (minutes === 1440) return 'Tag';
  if (minutes % 60 === 0) return `${minutes / 60} Stunden`;
  return `${minutes} Minuten`;
}

/** Aus [1,2,3,4,5] wird „werktags“, aus [0,6] „am Wochenende“. */
function describeDays(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length === 7) return ' – täglich';
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '1,2,3,4,5') return ' – werktags';
  if (set === '0,6') return ' – am Wochenende';
  const names = WEEKDAYS.filter((day) => days.includes(day.value)).map((day) => day.short);
  return ` – ${names.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

async function renderSettings() {
  const panel = $('#panel-settings');
  const household = store.household;
  const updates = store.updates;

  panel.innerHTML = `
    <div class="card">
      <h2>Firmware-Updates</h2>
      <p class="muted small">
        Der Hub prüft zweimal täglich. Automatische Installation läuft nur im gewählten
        Zeitfenster – die Geräte starten dabei neu.
      </p>
      <div class="list">${
        (updates?.integrations ?? []).map(updateItem).join('') ||
        emptyState('📦', 'Keine Integrationen vorhanden.')
      }</div>

      <details data-section="device-firmware">
        <summary>Alle Geräte und ihre Firmware (${(updates?.devices ?? []).length})</summary>
        <p class="muted small">
          Shelly-Geräte aktualisieren sich einzeln. Bei Hue und Homematic verteilt die
          Zentrale die Firmware an ihre Geräte – dort läuft das Update über die Bridge.
        </p>
        <div class="list">${
          (updates?.devices ?? []).map(deviceUpdateItem).join('') ||
          emptyState('📭', 'Noch keine Geräte eingebunden.')
        }</div>
      </details>

      <form id="form-autoupdate" class="form">
        <label class="row tight" style="flex-direction:row;align-items:center;gap:.6rem">
          <span class="switch">
            <input type="checkbox" name="autoUpdate" ${updates?.autoUpdate.enabled ? 'checked' : ''} />
            <span></span>
          </span>
          Updates automatisch installieren
        </label>
        <div class="field-row">
          <label>Von <input type="time" name="autoUpdateFrom" value="${esc(updates?.autoUpdate.from ?? '03:00')}" /></label>
          <label>Bis <input type="time" name="autoUpdateTo" value="${esc(updates?.autoUpdate.to ?? '05:00')}" /></label>
        </div>
        <div class="row tight">
          <button type="submit" class="primary">Speichern</button>
          <button type="button" class="ghost" id="btn-check-updates">Jetzt prüfen</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Stromtarif</h2>
      <form id="form-tariff" class="form">
        <div class="field-row">
          <label>Preis pro kWh
            <input type="number" name="pricePerKwh" step="0.01" min="0" value="${household?.pricePerKwh ?? 0.35}" />
          </label>
          <label>Grundgebühr pro Monat
            <input type="number" name="basePricePerMonth" step="0.01" min="0" value="${household?.basePricePerMonth ?? 0}" />
          </label>
          <label>Währung
            <input name="currency" maxlength="8" value="${esc(household?.currency ?? 'EUR')}" />
          </label>
        </div>
        <button type="submit" class="primary">Speichern</button>
      </form>
    </div>

    ${appearanceCard()}

    <div class="card">
      <h2>Integrationen</h2>
      <div class="row">
        <button class="ghost" id="btn-sync-all">Alle synchronisieren</button>
      </div>
      <div class="list" id="settings-integrations">${store.integrations
        .map(integrationItem)
        .join('')}</div>

      <details data-section="add-integration">
        <summary>Weitere Bridge oder weiteres Gerät hinzufügen</summary>
        <div class="callout">
          <strong>Bei einer Hue Bridge zuerst den runden Knopf drücken</strong>
          <span>Danach hast du etwa 30 Sekunden Zeit für „Verbinden“.</span>
        </div>
        <div class="row">
          <button class="primary" id="btn-settings-discover">Netzwerk durchsuchen</button>
          <button class="ghost" id="btn-settings-scan">Gründlich suchen</button>
        </div>
        <div class="list" id="settings-discovery"></div>
        <h3>Von Hand eintragen</h3>
        ${manualForm('form-settings-manual')}
      </details>
    </div>

    <div class="card">
      <h2>Räume</h2>
      <form id="form-room-settings" class="form inline">
        <input name="name" placeholder="Neuer Raum" maxlength="80" required />
        <button type="submit" class="primary">Anlegen</button>
      </form>
      <div class="list">${store.rooms.map(roomItem).join('')}</div>
    </div>

    <div class="card">
      <h2>Zugriffstoken</h2>
      <p class="muted small">
        Ein Token ist wie ein Schlüssel zu deinem Hub. Dieser Browser hat schon einen.
        Einen weiteren brauchst du nur, wenn ein anderes Gerät oder Programm zugreifen soll –
        widerrufen kannst du ihn jederzeit.
      </p>
      <form id="form-token" class="form inline">
        <input name="name" placeholder="z. B. Handy" maxlength="80" required />
        <button type="submit" class="primary">Token erstellen</button>
      </form>
      <div class="list" id="tokens-list"></div>
    </div>

    <div class="card">
      <h2>Diese Oberfläche</h2>
      <p class="muted small">
        Die Seite prüft von selbst, ob der Hub eine neuere Fassung ausliefert, und lädt sich
        dann nach – meist unbemerkt, während sie im Hintergrund liegt. Der Knopf hier erzwingt
        das sofort, falls doch einmal etwas hängen bleibt.
      </p>
      <div class="list">
        <div class="item">
          <div>
            <div class="title">Fassung ${esc(store.systemInfo?.version ?? '–')}</div>
            <div class="sub">Kennung ${esc(store.systemInfo?.build ?? 'unbekannt')} ·
              Node ${esc(store.systemInfo?.node ?? '–')}</div>
          </div>
          <button class="small" id="btn-reload-ui">Jetzt neu laden</button>
        </div>
      </div>
    </div>

    <details class="card" data-section="glossary">
      <summary>Begriffe kurz erklärt</summary>
      <dl class="glossary">
        <dt>Integration</dt>
        <dd>Eine Verbindung zu einem Hersteller-Gerät: deine Hue Bridge oder ein einzelner
          Shelly. Über sie kommen die Geräte in den Hub.</dd>
        <dt>Gerät</dt>
        <dd>Alles, was du hier siehst und schaltest – eine Lampe, eine Steckdose, ein
          Rollladen oder ein Sensor. Ein Shelly mit zwei Kanälen ergibt zwei Geräte, damit
          du sie verschiedenen Räumen zuordnen kannst.</dd>
        <dt>Fähigkeit</dt>
        <dd>Was ein Gerät kann: schaltbar, dimmbar, Farben, Rollladen, misst Temperatur …
          Kommandos funktionieren nur mit der passenden Fähigkeit.</dd>
        <dt>Automation</dt>
        <dd>Eine Wenn-dann-Regel, die der Hub selbstständig ausführt. Fertige Vorlagen
          findest du unter „Automationen“.</dd>
        <dt>Messwerte</dt>
        <dd>Temperatur, Feuchte und Verbrauch werden dauerhaft mitgeschrieben, damit du
          Verläufe sehen kannst. Wie lange, steht unter „System“.</dd>
        <dt>Abdeckung</dt>
        <dd>Wie viel von einem Zeitraum tatsächlich mit Messwerten belegt ist. Ist sie
          niedrig, verzichtet der Hub bewusst auf eine Hochrechnung, statt zu raten.</dd>
      </dl>
    </details>`;

  wireSettings(panel);
  restoreOpenSections(panel);
  await renderTokens();
}

/**
 * Darstellung: Schriftgröße, Helligkeit, Akzentfarbe, Bewegung.
 *
 * Jede Änderung wirkt sofort – man sieht am Bildschirm, was man einstellt,
 * statt hinterher zu prüfen, ob es das war, was man wollte.
 */
function appearanceCard() {
  const current = { ...store.household?.appearance };
  const scale = Number(current.fontScale ?? 1);
  const theme = current.theme ?? 'auto';
  const accent = current.accentColor ?? null;

  const scaleButtons = FONT_SCALES.map(
    (option) => `<button type="button" class="chip ${
      Math.abs(option.value - scale) < 0.001 ? 'active' : ''
    }" data-font-scale="${option.value}"
        style="font-size:${Math.min(option.value, 1.25)}rem">${esc(option.label)}</button>`,
  ).join('');

  const themeButtons = THEMES.map(
    (option) =>
      `<button type="button" class="chip ${option.value === theme ? 'active' : ''}"
               data-theme-choice="${esc(option.value)}">${esc(option.label)}</button>`,
  ).join('');

  const presets = ACCENT_PRESETS.map((preset) => {
    const selected = (preset.color ?? null) === accent;
    const swatch = preset.color
      ? `background:linear-gradient(135deg, ${preset.color}, ${preset.alt})`
      : 'background:linear-gradient(135deg, var(--accent), var(--accent-2))';
    return `<button type="button" class="accent-preset ${selected ? 'active' : ''}"
                    data-accent="${esc(preset.color ?? '')}" data-accent-alt="${esc(preset.alt ?? '')}"
                    title="${esc(preset.label)}" aria-label="${esc(preset.label)}">
      <span class="accent-dot" style="${swatch}"></span>
      <span>${esc(preset.label)}</span>
    </button>`;
  }).join('');

  return `<div class="card">
    <h2>Darstellung</h2>
    <p class="muted small">
      Gilt für alle Geräte, auf denen du den Hub öffnest – Handy, Tablet und Rechner.
    </p>

    <div class="setting-block">
      <div class="setting-head"><strong>Schriftgröße</strong>
        <span class="muted small">Alles wird mitskaliert, nicht nur der Text</span></div>
      <div class="chips">${scaleButtons}</div>
    </div>

    <div class="setting-block">
      <div class="setting-head"><strong>Helligkeit</strong>
        <span class="muted small">Hell, dunkel oder wie im Betriebssystem eingestellt</span></div>
      <div class="chips">${themeButtons}</div>
    </div>

    <div class="setting-block">
      <div class="setting-head"><strong>Akzentfarbe</strong>
        <span class="muted small">Färbt Knöpfe, Regler und Diagramme</span></div>
      <div class="accent-presets">${presets}</div>
      <div class="field-row">
        <label>Eigene Farbe
          <input type="color" id="accent-custom" value="${esc(accent ?? '#2f6bd8')}" />
        </label>
        <label>Zweite Farbe (Verläufe)
          <input type="color" id="accent-custom-alt" value="${esc(
            current.accentColorAlt ?? '#0f9aa8',
          )}" />
        </label>
      </div>
    </div>

    <label class="check">
      <input type="checkbox" id="reduce-motion" ${current.reduceMotion ? 'checked' : ''} />
      <span>Bewegung reduzieren – Animationen laufen dann nicht mehr</span>
    </label>

    <div class="row tight">
      <button class="ghost small" id="btn-appearance-reset">Auf Standard zurücksetzen</button>
    </div>
  </div>`;
}

function updateItem(entry) {
  const info = entry.updateInfo;
  const badge = !entry.supported
    ? '<span class="badge">nicht unterstützt</span>'
    : info?.updateAvailable
      ? '<span class="badge warn">Update verfügbar</span>'
      : info
        ? '<span class="badge ok">aktuell</span>'
        : '<span class="badge">noch nicht geprüft</span>';

  return `<div class="item">
    <div>
      <div class="title">${esc(entry.name)} ${badge}</div>
      <div class="sub">
        ${esc(VENDOR_LABEL[entry.type] ?? entry.type)} ·
        Version ${esc(info?.currentVersion ?? 'unbekannt')}
        ${info?.availableVersion ? ` → ${esc(info.availableVersion)}` : ''}
        ${info ? ` · geprüft ${esc(fmt.relative(info.checkedAt))}` : ''}
      </div>
      ${info?.note ? `<div class="sub">${esc(info.note)}</div>` : ''}
    </div>
    ${
      info?.updateAvailable && info.installable
        ? `<button class="primary small" data-install="${esc(entry.integrationId)}">Jetzt installieren</button>`
        : entry.supported
          ? `<button class="small" data-check="${esc(entry.integrationId)}">Prüfen</button>`
          : ''
    }
  </div>`;
}

/**
 * Ein Gerät in der Firmware-Übersicht.
 *
 * Der Knopf sitzt bewusst an der Stelle, an der das Update tatsächlich
 * ausgelöst wird: beim Gerät, wenn es sich selbst aktualisiert, und bei der
 * Zentrale, wenn sie es für ihre Geräte tut.
 */
function deviceUpdateItem(entry) {
  const badge = entry.updateAvailable
    ? '<span class="badge warn">Update verfügbar</span>'
    : entry.reachable
      ? ''
      : '<span class="badge">offline</span>';

  const parts = [
    VENDOR_LABEL[entry.vendor] ?? entry.vendor,
    entry.model || 'Modell unbekannt',
    `Firmware ${entry.firmware || 'unbekannt'}`,
  ];

  return `<div class="item">
    <div>
      <div class="title">${esc(entry.name)} ${badge}</div>
      <div class="sub">${esc(parts.join(' · '))}</div>
      <div class="sub">${
        !entry.supported
          ? `Firmware läuft über „${esc(entry.integrationName)}“ – dort, nicht hier.`
          : entry.updatedBy === 'device'
            ? 'Aktualisiert sich selbst.'
            : `Wird über „${esc(entry.integrationName)}“ aktualisiert.`
      }</div>
    </div>
    ${
      !entry.supported
        ? ''
        : entry.updateAvailable
          ? `<button class="primary small" data-install="${esc(entry.integrationId)}">Jetzt installieren</button>`
          : `<button class="small" data-check="${esc(entry.integrationId)}">Prüfen</button>`
    }
  </div>`;
}

function integrationItem(integration) {
  return `<div class="item">
    <div>
      <div class="title">${esc(integration.name)}
        ${
          integration.status === 'linked'
            ? '<span class="badge ok">verbunden</span>'
            : `<span class="badge error">${esc(integration.status)}</span>`
        }
      </div>
      <div class="sub">${esc(VENDOR_LABEL[integration.type] ?? integration.type)} ·
        ${esc(integration.config.host)} · ${esc(plural(integration.deviceCount, "Gerät", "Geräte"))}</div>
      ${integration.lastError ? `<div class="sub">${esc(integration.lastError)}</div>` : ''}
    </div>
    <div class="row tight">
      <button class="small" data-sync="${esc(integration.id)}">Synchronisieren</button>
      <button class="small" data-test="${esc(integration.id)}">Testen</button>
      <button class="small danger" data-remove-integration="${esc(integration.id)}">Entfernen</button>
    </div>
  </div>`;
}

function roomItem(room) {
  return `<div class="item">
    <div>
      <div class="title">${esc(room.name)}</div>
      <div class="sub">${esc(plural(room.deviceCount, "Gerät", "Geräte"))} · ${esc(
        fmt.temperature(room.climate?.temperatureC ?? null),
      )}</div>
    </div>
    <button class="small danger" data-remove-room="${esc(room.id)}">Entfernen</button>
  </div>`;
}

function wireSettings(panel) {
  panel.querySelector('#form-autoupdate').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const updated = await guard(
      () =>
        api('/household', {
          method: 'PATCH',
          body: {
            autoUpdate: form.get('autoUpdate') === 'on',
            autoUpdateFrom: form.get('autoUpdateFrom'),
            autoUpdateTo: form.get('autoUpdateTo'),
          },
        }),
      { success: 'Update-Einstellungen gespeichert.' },
    );
    if (!updated) return;
    store.household = updated;
    store.updates = await api('/updates');
    void renderSettings();
  });

  panel.querySelector('#btn-check-updates').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const result = await guard(() => api('/updates/check', { method: 'POST' }), {
      success: 'Prüfung abgeschlossen.',
    });
    event.target.disabled = false;
    if (!result) return;
    store.updates = result;
    void renderSettings();
  });

  panel.querySelectorAll('[data-install]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Das Gerät startet für die Installation neu. Fortfahren?')) return;
      button.disabled = true;
      const result = await guard(() =>
        api(`/updates/${button.dataset.install}/install`, { method: 'POST' }),
      );
      if (result) {
        toast('Installation gestartet.', { kind: 'success', hint: result.message });
      }
      button.disabled = false;
    });
  });

  panel.querySelectorAll('[data-check]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      await guard(() => api(`/updates/${button.dataset.check}/check`, { method: 'POST' }));
      store.updates = await api('/updates');
      void renderSettings();
    });
  });

  panel.querySelector('#form-tariff').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const updated = await guard(
      () =>
        api('/household', {
          method: 'PATCH',
          body: {
            pricePerKwh: Number(form.get('pricePerKwh')),
            basePricePerMonth: Number(form.get('basePricePerMonth')),
            currency: String(form.get('currency')).toUpperCase(),
          },
        }),
      { success: 'Tarif gespeichert.', successHint: 'Die Kostenrechnung nutzt ab sofort den neuen Preis.' },
    );
    if (!updated) return;
    store.household = updated;
    store.energy = null;
  });

  wireAppearance(panel);

  // Nach dem Verbinden alles neu laden: Geräte, Räume, Kennzahlen.
  const afterConnect = async () => {
    await loadDashboardData();
    void renderSettings();
  };
  bindManualForm(panel.querySelector('#form-settings-manual'), afterConnect);
  panel.querySelector('#btn-settings-discover').addEventListener('click', () => {
    void runDiscovery(panel.querySelector('#settings-discovery'), false, afterConnect);
  });
  panel.querySelector('#btn-settings-scan').addEventListener('click', () => {
    void runDiscovery(panel.querySelector('#settings-discovery'), true, afterConnect);
  });

  panel.querySelector('#btn-sync-all').addEventListener('click', async (event) => {
    event.target.disabled = true;
    for (const integration of store.integrations) {
      await guard(() => api(`/integrations/${integration.id}/sync`, { method: 'POST' }));
    }
    await loadDashboardData();
    event.target.disabled = false;
    toast('Alle Integrationen synchronisiert.', { kind: 'success' });
    void renderSettings();
  });

  panel.querySelectorAll('[data-sync]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await guard(() =>
        api(`/integrations/${button.dataset.sync}/sync`, { method: 'POST' }),
      );
      if (!result) return;
      toast(`${result.added} neu, ${result.updated} aktualisiert, ${result.removed} entfernt.`, {
        kind: 'success',
      });
      await loadDashboardData();
      void renderSettings();
    });
  });

  panel.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await guard(() =>
        api(`/integrations/${button.dataset.test}/test`, { method: 'POST' }),
      );
      if (!result) return;
      toast(result.status === 'linked' ? 'Verbindung steht.' : 'Verbindung gestört.', {
        kind: result.status === 'linked' ? 'success' : 'error',
        hint: result.lastError ?? '',
      });
      store.integrations = await api('/integrations');
      void renderSettings();
    });
  });

  panel.querySelectorAll('[data-remove-integration]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Integration und alle zugehörigen Geräte entfernen?')) return;
      await guard(() =>
        api(`/integrations/${button.dataset.removeIntegration}`, { method: 'DELETE' }),
      );
      await loadDashboardData();
      void renderSettings();
    });
  });

  panel.querySelector('#form-room-settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    const created = await guard(() => api('/rooms', { method: 'POST', body: { name } }));
    if (!created) return;
    event.target.reset();
    await loadDashboardData();
    void renderSettings();
  });

  panel.querySelectorAll('[data-remove-room]').forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api(`/rooms/${button.dataset.removeRoom}`, { method: 'DELETE' }));
      await loadDashboardData();
      void renderSettings();
    });
  });

  panel.querySelector('#btn-reload-ui').addEventListener('click', () => {
    void applyUpdate({ silent: false });
  });

  panel.querySelector('#form-token').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    const result = await guard(() => api('/household/tokens', { method: 'POST', body: { name } }));
    if (!result) return;
    event.target.reset();
    prompt('Neues Token – wird nur einmal angezeigt:', result.accessToken);
    await renderTokens();
  });
}

/**
 * Bedienung der Darstellung.
 *
 * Reihenfolge mit Absicht: erst anwenden, dann speichern. Wer eine Farbe
 * ausprobiert, soll sie sofort sehen; scheitert das Speichern, sagt die
 * Fehlermeldung Bescheid und der letzte gespeicherte Stand kommt zurück.
 */
function wireAppearance(panel) {
  const change = async (changes) => {
    const merged = applyAppearance({ ...store.household?.appearance, ...changes });
    const updated = await guard(() =>
      api('/household', { method: 'PATCH', body: { appearance: changes } }),
    );
    if (!updated) {
      applyAppearance(store.household?.appearance);
      return;
    }
    store.household = updated;
    store.summary = { ...store.summary, household: updated };
    applyAppearance(updated.appearance ?? merged);
    void renderSettings();
  };

  panel.querySelectorAll('[data-font-scale]').forEach((button) => {
    button.addEventListener('click', () => void change({ fontScale: Number(button.dataset.fontScale) }));
  });

  panel.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => void change({ theme: button.dataset.themeChoice }));
  });

  panel.querySelectorAll('[data-accent]').forEach((button) => {
    button.addEventListener('click', () =>
      void change({
        // Leerer Wert = mitgelieferte Farbe. Die ist auf hell und dunkel
        // getrennt abgestimmt, das kann eine feste Farbe nicht.
        accentColor: button.dataset.accent || null,
        accentColorAlt: button.dataset.accentAlt || null,
      }),
    );
  });

  // Beim Farbwähler zählt erst das Loslassen – sonst würde jede
  // Zwischenfarbe des Schiebers zum Hub geschickt.
  const custom = panel.querySelector('#accent-custom');
  const customAlt = panel.querySelector('#accent-custom-alt');
  custom.addEventListener('input', () => {
    applyAppearance({ ...store.household?.appearance, accentColor: custom.value });
  });
  custom.addEventListener('change', () =>
    void change({ accentColor: custom.value, accentColorAlt: customAlt.value }),
  );
  customAlt.addEventListener('change', () =>
    void change({ accentColor: custom.value, accentColorAlt: customAlt.value }),
  );

  panel
    .querySelector('#reduce-motion')
    .addEventListener('change', (event) => void change({ reduceMotion: event.target.checked }));

  panel.querySelector('#btn-appearance-reset').addEventListener('click', () =>
    void change({
      fontScale: 1,
      accentColor: null,
      accentColorAlt: null,
      theme: 'auto',
      reduceMotion: false,
    }),
  );
}

async function renderTokens() {
  const list = $('#tokens-list');
  if (!list) return;
  const tokens = await guard(() => api('/household/tokens'));
  if (!tokens) return;

  list.innerHTML = tokens
    .map(
      (token) => `<div class="item">
        <div>
          <div class="title">${esc(token.name)}</div>
          <div class="sub">erstellt ${esc(fmt.time(token.createdAt))} ·
            zuletzt genutzt ${esc(fmt.relative(token.lastUsedAt))}</div>
        </div>
        <button class="small danger" data-revoke="${esc(token.id)}">Widerrufen</button>
      </div>`,
    )
    .join('');

  list.querySelectorAll('[data-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api(`/household/tokens/${button.dataset.revoke}`, { method: 'DELETE' }));
      await renderTokens();
    });
  });
}
