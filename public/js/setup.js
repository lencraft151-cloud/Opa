/** Einrichtungsassistent: Haushalt → Geräte → Räume → Zuordnung → Fertig. */

import { api, auth, errorBanner, guard, toast } from './api.js';
import { esc, plural, VENDOR_LABEL } from './format.js';
import { emptyState, tile } from './components.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let state = null;
let onFinished = () => {};

export function initSetup(initialState, finishedCallback) {
  state = initialState;
  onFinished = finishedCallback;
  wireOnce();
  render();
}

async function refresh() {
  state = await api('/setup/state');
  render();
}

function render() {
  $('#wizard-steps').innerHTML = state.steps
    .map(
      (step, index) =>
        `<li class="${step.current ? 'current' : ''} ${step.done ? 'done' : ''}">
           ${index + 1}. ${esc(step.title)}
         </li>`,
    )
    .join('');

  for (const id of ['household', 'integrations', 'rooms', 'assign', 'done']) {
    $(`#step-${id}`).classList.toggle('hidden', state.currentStep !== id);
  }

  const banner = $('#setup-banner');
  banner.innerHTML = '';
  const description = state.steps.find((step) => step.current)?.description;
  if (description && state.currentStep !== 'integrations') {
    banner.append(errorBanner({ title: description, kind: 'info' }));
  }

  if (state.currentStep === 'household') fillTimezones();
  if (state.currentStep === 'integrations') void renderIntegrations();
  if (state.currentStep === 'rooms') void renderRooms();
  if (state.currentStep === 'assign') void renderAssign();
  if (state.currentStep === 'done') renderDone();
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
    .map(
      (zone) =>
        `<option value="${esc(zone)}" ${zone === current ? 'selected' : ''}>${esc(zone)}</option>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------

let wired = false;

function wireOnce() {
  if (wired) return;
  wired = true;

  $('#form-household').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const result = await guard(() =>
      api('/setup/household', {
        method: 'POST',
        body: {
          name: form.get('name'),
          timezone: form.get('timezone'),
          pricePerKwh: Number(form.get('pricePerKwh')) || 0.35,
        },
      }),
    );
    if (!result) return;

    auth.token = result.accessToken;
    $('#token-value').textContent = result.accessToken;
    $('#token-box').classList.remove('hidden');
    state = result.state;

    toast('Haushalt angelegt.', { kind: 'success', hint: 'Weiter geht es mit deinen Geräten.' });
    setTimeout(render, 1400);
  });

  $('#btn-discover').addEventListener('click', () => discover(false));
  $('#btn-discover-scan').addEventListener('click', () => discover(true));

  $('#form-manual').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const body = { type: form.get('type'), host: String(form.get('host')).trim(), importRooms: true };
    const name = String(form.get('name') || '').trim();
    const password = String(form.get('password') || '');
    if (name) body.name = name;
    if (password) body.password = password;

    const result = await guard(() => api('/integrations', { method: 'POST', body }));
    if (!result) return;
    toast(`${result.integration.name} verbunden.`, {
      kind: 'success',
      hint: `${plural(result.devices.length, "Gerät", "Geräte")} übernommen.`,
    });
    event.target.reset();
    await refresh();
  });

  $('#btn-to-rooms').addEventListener('click', () => goToStep('rooms'));
  $('#btn-to-assign').addEventListener('click', () => goToStep('assign'));

  $('#form-room').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    await guard(() => api('/setup/rooms', { method: 'POST', body: { names: [name] } }));
    event.target.reset();
    await renderRooms();
  });

  $('#btn-save-assign').addEventListener('click', async () => {
    const assignments = $$('[data-assign]').map((select) => ({
      deviceId: select.dataset.assign,
      roomId: select.value || null,
    }));
    if (assignments.length > 0) {
      const saved = await guard(() => api('/setup/assign', { method: 'POST', body: { assignments } }), {
        success: 'Zuordnung gespeichert.',
      });
      if (!saved) return;
    }
    await goToStep('done');
  });

  $('#btn-complete').addEventListener('click', async () => {
    const result = await guard(() => api('/setup/complete', { method: 'POST' }), {
      success: 'Einrichtung abgeschlossen.',
      successHint: 'Der Hub sammelt ab jetzt Messwerte und führt Automationen aus.',
    });
    if (!result) return;
    onFinished();
  });
}

async function goToStep(step) {
  const next = await guard(() => api('/setup/step', { method: 'POST', body: { step } }));
  if (!next) return;
  state = next;
  render();
}

// ---------------------------------------------------------------------------
// Schritt 2: Geräte finden und verbinden
// ---------------------------------------------------------------------------

async function discover(scan) {
  const target = $('#discovery-results');
  target.innerHTML = `<div class="item"><span class="sub">Suche läuft${
    scan ? ' – der Subnetz-Scan dauert bis zu einer Minute' : ''
  }…</span></div>`;

  const result = await guard(() => api(`/integrations/discover?scan=${scan ? 'true' : 'false'}`));
  if (!result) {
    target.innerHTML = '';
    return;
  }

  if (result.found.length === 0) {
    target.innerHTML = emptyState(
      '🔍',
      'Nichts gefunden.',
      scan
        ? 'Auch der Subnetz-Scan war leer. Läuft der Hub im selben Netz wie deine Geräte? In Docker braucht er "--network host".'
        : 'Versuche es mit „Gründlich suchen“ – oder trage die IP-Adresse unten manuell ein.',
    );
    return;
  }

  target.innerHTML = result.found.map(discoveryItem).join('');
  $$('[data-connect]', target).forEach((button) => {
    button.addEventListener('click', () => connect(button));
  });
}

function discoveryItem(entry) {
  const notes = [esc(entry.host), esc(entry.model || 'Modell unbekannt'), `gefunden per ${esc(entry.source)}`];
  if (entry.requiresLinkButton) notes.push('<strong>Knopf auf der Bridge drücken</strong>');
  if (entry.authRequired) notes.push('passwortgeschützt');

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

async function connect(button) {
  const body = { type: button.dataset.type, host: button.dataset.connect, importRooms: true };
  if (button.dataset.auth) {
    const password = prompt(`Passwort für das Shelly-Gerät ${button.dataset.connect}:`);
    if (password === null) return;
    body.password = password;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Verbinde…';

  const result = await guard(() => api('/integrations', { method: 'POST', body }));

  button.disabled = false;
  button.textContent = label;
  if (!result) return;

  toast(`${result.integration.name} verbunden.`, {
    kind: 'success',
    hint: `${plural(result.devices.length, "Gerät", "Geräte")} übernommen.`,
  });
  await refresh();
}

async function renderIntegrations() {
  const integrations = await guard(() => api('/integrations'));
  if (!integrations) return;

  $('#setup-integrations').innerHTML = integrations.length
    ? integrations
        .map(
          (integration) => `<div class="item">
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
          </div>`,
        )
        .join('')
    : emptyState('🔌', 'Noch nichts verbunden.', 'Starte oben die Netzwerksuche.');

  $('#btn-to-rooms').disabled = integrations.length === 0;
}

// ---------------------------------------------------------------------------
// Schritt 3 & 4
// ---------------------------------------------------------------------------

async function renderRooms() {
  const [suggestions, rooms] = await Promise.all([api('/setup/suggested-rooms'), api('/rooms')]);
  const existing = new Set(rooms.map((room) => room.name.toLowerCase()));

  $('#room-suggestions').innerHTML = suggestions.rooms
    .map((name) => {
      const added = existing.has(name.toLowerCase());
      return `<button class="chip ${added ? 'active' : ''}" data-room="${esc(name)}" ${
        added ? 'disabled' : ''
      }>${esc(name)}</button>`;
    })
    .join('');

  $$('[data-room]', $('#room-suggestions')).forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() =>
        api('/setup/rooms', { method: 'POST', body: { names: [button.dataset.room] } }),
      );
      await renderRooms();
    });
  });

  $('#setup-rooms').innerHTML = rooms.length
    ? rooms
        .map(
          (room) => `<div class="item">
            <div class="title">${esc(room.name)}</div>
            <button class="danger small" data-delete-room="${esc(room.id)}">Entfernen</button>
          </div>`,
        )
        .join('')
    : emptyState('🏠', 'Noch keine Räume.', 'Klicke oben auf einen Vorschlag.');

  $$('[data-delete-room]', $('#setup-rooms')).forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api(`/rooms/${button.dataset.deleteRoom}`, { method: 'DELETE' }));
      await renderRooms();
    });
  });

  $('#btn-to-assign').disabled = rooms.length === 0;
}

async function renderAssign() {
  const [devices, rooms] = await Promise.all([api('/devices?includeHidden=true'), api('/rooms')]);

  $('#assign-list').innerHTML = devices.length
    ? devices
        .map(
          (device) => `<div class="item">
            <div>
              <div class="title">${esc(device.name)}</div>
              <div class="sub">${esc(VENDOR_LABEL[device.vendor] ?? device.vendor)} ·
                ${esc(device.capabilities.join(', ') || 'keine Fähigkeiten')}</div>
            </div>
            <select data-assign="${esc(device.id)}">
              <option value="">– kein Raum –</option>
              ${rooms
                .map(
                  (room) =>
                    `<option value="${esc(room.id)}" ${room.id === device.roomId ? 'selected' : ''}>${esc(
                      room.name,
                    )}</option>`,
                )
                .join('')}
            </select>
          </div>`,
        )
        .join('')
    : emptyState('📭', 'Keine Geräte gefunden.', 'Gehe zurück und verbinde zuerst eine Bridge.');
}

function renderDone() {
  const counts = state.counts;
  $('#setup-summary').innerHTML = [
    tile({ value: counts.integrations, label: 'Integrationen' }),
    tile({ value: counts.devices, label: 'Geräte' }),
    tile({ value: counts.rooms, label: 'Räume' }),
    tile({ value: counts.temperatureSensors, label: 'Temperatursensoren' }),
  ].join('');

  $('#setup-warnings').innerHTML = (state.warnings ?? [])
    .map(
      (warning) =>
        `<div class="item"><div><span class="badge warn">Hinweis</span> ${esc(warning)}</div></div>`,
    )
    .join('');
}
