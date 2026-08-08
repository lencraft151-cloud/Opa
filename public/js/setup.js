/** Einrichtungsassistent: Haushalt → Geräte → Räume → Zuordnung → Fertig. */

import { api, errorBanner, guard, toast } from './api.js';
import { esc, plural, VENDOR_LABEL } from './format.js';
import { emptyState, tile } from './components.js';
import { bindManualForm, runDiscovery } from './integrations.js';

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

    // Zwei Passwortfelder, damit ein Tippfehler nicht erst beim nächsten
    // Anmelden auffällt – dann wäre niemand mehr hineingekommen.
    const password = String(form.get('password'));
    if (password !== String(form.get('passwordRepeat'))) {
      toast('Die beiden Passwörter stimmen nicht überein.', {
        kind: 'error',
        hint: 'Tippe beide noch einmal – sie müssen Zeichen für Zeichen gleich sein.',
      });
      return;
    }

    const result = await guard(() =>
      api('/setup/household', {
        method: 'POST',
        body: {
          name: form.get('name'),
          timezone: form.get('timezone'),
          pricePerKwh: Number(form.get('pricePerKwh')) || 0.35,
          username: String(form.get('username')).trim(),
          password,
          displayName: String(form.get('displayName') || '').trim() || undefined,
        },
      }),
    );
    if (!result) return;

    // Die Anmeldung liegt ab jetzt als Cookie im Browser.
    state = result.state;
    event.target.reset();

    toast(`Haushalt angelegt – angemeldet als „${result.user.username}".`, {
      kind: 'success',
      hint: 'Weiter geht es mit deinen Geräten.',
    });
    setTimeout(render, 1400);
  });

  $('#btn-discover').addEventListener('click', () => discover(false));
  $('#btn-discover-scan').addEventListener('click', () => discover(true));

  // Je nach Hersteller werden andere Angaben gebraucht – der Bogen zeigt
  // deshalb nur, was gerade zählt.
  bindManualForm($('#form-manual'), refresh);

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

/** Suche und Verbindungsaufbau stecken in `integrations.js` – siehe dort. */
const discover = (scan) => runDiscovery($('#discovery-results'), scan, refresh);

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
