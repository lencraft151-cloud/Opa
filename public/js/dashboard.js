/** Dashboard: Übersicht, Räume, Geräte, Energie, Verlauf, Automationen, Einstellungen. */

import { api, errorBanner, guard, toast } from './api.js';
import { ACCENT_PRESETS, applyAppearance, FONT_SCALES, THEMES } from './appearance.js';
import { barList, gauge, lineChart } from './charts.js';
import {
  bindDeviceControls,
  cardHead,
  deviceCard,
  emptyState,
  help,
  skeletonGrid,
  tile,
} from './components.js';
import {
  CAPABILITY_LABEL,
  changelogHtml,
  esc,
  fmt,
  METRIC_LABEL,
  plural,
  VENDOR_LABEL,
} from './format.js';
import { bindManualForm, manualForm, runDiscovery } from './integrations.js';
import { loadMusic, renderMusic, startMusicTicker, stopMusicTicker } from './music.js';
import { applyUpdate } from './selfupdate.js';
import { restoreDrafts } from './drafts.js';
import { renderWiki, setWikiArticle } from './wiki.js';

const $ = (selector) => document.querySelector(selector);

/** Gemeinsamer Datenstand aller Ansichten. */
export const store = {
  /** Antwort von `/system/info` – Fassung, Kennung, verfügbare Adapter. */
  systemInfo: null,
  /**
   * Antwort von `/system/version` – Fassung des Hubs samt Änderungsprotokoll.
   * Wird erst beim Öffnen der Einstellungen geholt: Die Abfrage startet einen
   * `git`-Prozess und hat auf jedem anderen Weg nichts zu suchen.
   */
  hubVersion: null,
  /**
   * Antwort von `/nextcloud` – verbundenes Konto und offene
   * Benachrichtigungen. Wird wie die Fassung erst in den Einstellungen
   * geholt; wer keine Nextcloud hat, soll dafür keine Anfrage bezahlen.
   */
  nextcloud: null,
  /** Angemeldeter Benutzer. */
  me: null,
  scenes: [],
  presence: null,
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
  const [summary, rooms, devices, integrations, automations, climate, updates, energy, scenes, presence, me] =
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
      api('/scenes'),
      api('/presence'),
      api('/auth/me'),
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
    scenes,
    presence,
    me,
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
  home: renderHome,
  scenes: renderScenes,
  insights: renderInsights,
  services: renderServices,
  automations: renderAutomations,
  history: renderActivity,
  settings: renderSettings,
  wiki: renderWiki,
};

/**
 * Aus einer Ansicht heraus ins Wiki springen.
 *
 * Der Weg „lies dort nach" ist nur dann einer, wenn er ein Klick ist. Steht
 * er als Satz da („siehe Wiki"), sucht ihn niemand.
 */
/**
 * Ein Verweis ins Wiki, der wie ein Verweis aussieht und einer ist.
 *
 * Absichtlich ein Knopf im Fließtext statt eines Satzes „siehe Wiki": Der
 * Weg dorthin muss ein Klick sein, sonst geht ihn niemand.
 */
export function wikiLink(articleId, label = 'Mehr dazu im Wiki') {
  return `<button class="wiki-jump" data-wiki="${esc(articleId)}"
    title="Öffnet die Erklärung im Wiki">${esc(label)}</button>`;
}

export function showWiki(articleId) {
  setWikiArticle(articleId);
  renderPanel('wiki');
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === 'wiki');
  });
}

/**
 * Welche Ansichten überhaupt von Gerätezuständen abhängen.
 *
 * Der Hub fragt die Geräte alle 15 Sekunden ab. Früher wurde bei jeder
 * Antwort die *gesamte* aktive Ansicht neu aufgebaut – auch „Automationen"
 * und „Einstellungen". Wer dort ein Formular ausfüllte, hatte 15 Sekunden
 * Zeit, dann war die Eingabe weg. Diese beiden Ansichten zeigen keine
 * Messwerte; sie werden nur noch nach dem Speichern neu gezeichnet.
 */
const DEVICE_DEPENDENT = new Set(['overview', 'home', 'scenes', 'insights']);

let current = 'overview';

export function renderPanel(name) {
  current = name;
  for (const key of Object.keys(RENDERERS)) {
    $(`#panel-${key}`)?.classList.toggle('hidden', key !== name);
  }
  // Beim Betreten darf die Ansicht auffahren – das ist der Moment, für den
  // die Animation gedacht ist.
  $(`#panel-${name}`)?.classList.remove('quiet');

  // Musik lebt nur, solange jemand hinsieht – siehe music.js.
  if (name === 'services') startMusicTicker();
  else stopMusicTicker();

  renderCurrent({ reason: 'manual' });
}

/**
 * Schreibt HTML nur, wenn es sich geändert hat.
 *
 * Der Hub fragt seine Geräte im eingestellten Takt ab, und bis hierher wurde
 * danach *immer* die ganze Ansicht neu geschrieben – auch wenn kein einziger
 * Wert anders war. Zwei Dinge gingen dabei kaputt:
 *
 * 1. **Angefangene Eingaben.** Ein halb ausgefülltes Formular war weg, weil
 *    seine Felder neue Elemente wurden.
 * 2. **Das Bild.** Jede neu eingefügte Karte startet ihre Auffahr-Animation
 *    von vorn, und die beginnt bei Deckkraft 0. Alle paar Sekunden wurde die
 *    Seite deshalb kurz hell – das „Weißblitzen".
 *
 * Ein Zeichenkettenvergleich kostet nichts gegen einen DOM-Umbau. Ändert sich
 * nichts, passiert jetzt auch nichts.
 *
 * Wichtig für Aufrufer: Gibt `paint` `false` zurück, steht im DOM noch
 * *genau* das, was beim letzten Mal verdrahtet wurde. Dann darf auch nicht
 * erneut verdrahtet werden – sonst hinge an jedem Knopf ein Zuhörer mehr und
 * ein Klick löste die Aktion zweimal aus.
 *
 * @returns {boolean} ob wirklich geschrieben wurde
 */
const lastPainted = new WeakMap();

export function paint(element, html) {
  if (!element) return false;
  // Verglichen wird gegen das, was wir geschrieben haben – nicht gegen
  // `innerHTML`. Der Browser schreibt Attribute um, und dann wäre nie etwas
  // gleich.
  if (lastPainted.get(element) === html) return false;
  element.innerHTML = html;
  lastPainted.set(element, html);
  return true;
}

/**
 * Zeichnet die aktive Ansicht neu.
 *
 * @param {{ reason?: 'devices' | 'manual' }} options `devices` bedeutet: Es
 *   kam nur ein neuer Messwert herein. Ansichten ohne Gerätebezug bleiben
 *   dann unangetastet.
 */
/**
 * Verweise ins Wiki funktionieren überall gleich – deshalb einmal zentral
 * statt in jeder Ansicht neu.
 */
document.addEventListener('click', (event) => {
  const jump = event.target.closest?.('[data-wiki]');
  if (!jump) return;
  event.preventDefault();
  showWiki(jump.dataset.wiki);
});

export function renderCurrent(options = {}) {
  if (options.reason === 'devices' && !DEVICE_DEPENDENT.has(current)) return;
  const panel = $(`#panel-${current}`);
  if (!panel) return;

  /*
   * Auffahren darf die Ansicht beim Betreten – dort ist die Bewegung
   * Orientierung. Kommt nur ein neuer Messwert herein, wäre sie das Gegenteil:
   * Die Karten begännen wieder bei Deckkraft 0, und die ganze Seite blitzte
   * im Abfragetakt hell auf. `quiet` schaltet genau diese Einstiegsanimation
   * ab und bleibt gesetzt, bis der Reiter erneut gewählt wird.
   */
  if (options.reason !== 'manual') panel.classList.add('quiet');

  withPreservedInput(panel, () => RENDERERS[current]?.());
}

/**
 * Nummeriert Karten durch, damit sie gestaffelt auffahren statt alle
 * gleichzeitig. Der Wert landet als `--i` im Stil; die Verzögerung rechnet
 * das Stylesheet daraus aus.
 */
function stagger(root) {
  const groups = ['.device-card', '.tile', '.list > .item', '.template-card'];
  for (const selector of groups) {
    root.querySelectorAll(selector).forEach((element, index) => {
      // Nach dem zwölften Element bringt die Staffelung nichts mehr – sie
      // würde den Aufbau nur künstlich in die Länge ziehen.
      element.style.setProperty('--i', String(Math.min(index, 12)));
    });
  }
}

/**
 * Führt das Neuzeichnen aus, ohne wegzunehmen, woran gerade jemand arbeitet.
 *
 * Gesichert werden Eingabefelder außerhalb der Gerätekarten – die Karten
 * *sollen* dem Gerät folgen, ein Helligkeitsregler muss den neuen Wert
 * zeigen. Alles andere (Suchfeld, Automations-Formular, Einstellungen)
 * behält seinen Inhalt, dazu Cursorposition und Scrollstand.
 */
function withPreservedInput(panel, render) {
  const fields = () => [...panel.querySelectorAll('input, select, textarea')].filter(
    (field) => !field.closest('.device-card'),
  );

  const before = new Map();
  for (const field of fields()) {
    const key = fieldKey(field);
    if (key) before.set(key, readField(field));
  }

  const active = document.activeElement;
  const focusKey = active && panel.contains(active) ? fieldKey(active) : null;
  const caret =
    focusKey && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const scrollY = window.scrollY;

  const result = render();
  // Manche Ansichten laden nach; die Staffelung wartet darauf.
  const after = () => {
    stagger(panel);
    /*
     * Entwürfe aus einem früheren Seitenaufbau wieder einsetzen. Muss nach
     * dem Zeichnen passieren – vorher gibt es die Felder noch gar nicht.
     */
    restoreDrafts(panel);
  };
  if (result && typeof result.then === 'function') void result.then(after);
  else after();

  for (const field of fields()) {
    const key = fieldKey(field);
    if (key && before.has(key)) writeField(field, before.get(key));
    if (key && key === focusKey) {
      field.focus({ preventScroll: true });
      if (caret && typeof field.setSelectionRange === 'function') {
        try {
          field.setSelectionRange(caret[0], caret[1]);
        } catch {
          /* Felder wie type=number lassen keine Auswahl zu */
        }
      }
    }
  }

  if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY });
}

/** Wiedererkennungsmerkmal eines Feldes über das Neuzeichnen hinweg. */
function fieldKey(field) {
  if (!field || !field.tagName) return null;
  if (field.id) return `#${field.id}`;
  const form = field.closest('form, fieldset, .card');
  const scope = form?.id || form?.className || '';
  const name = field.name || field.dataset.field || '';
  if (!name) return null;
  // Gleichnamige Felder (Wochentage) über ihren Wert unterscheiden.
  return `${scope}::${name}::${field.type === 'checkbox' || field.type === 'radio' ? field.value : ''}`;
}

function readField(field) {
  return field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value;
}

function writeField(field, value) {
  if (field.type === 'checkbox' || field.type === 'radio') field.checked = value;
  else field.value = value;
}

// ---------------------------------------------------------------------------
// Übersicht
// ---------------------------------------------------------------------------

function renderOverview() {
  const panel = $('#panel-overview');
  const summary = store.summary;
  if (!summary) {
    paint(panel, skeletonGrid(4));
    return;
  }

  /*
   * Zwei Bereiche, weil sie verschieden entstehen: Die Banner sind Elemente
   * mit eigenen Zuhörern (der Knopf „Erneut versuchen" ruft etwas auf), der
   * Rest ist reines HTML. Beide werden nur angefasst, wenn sich wirklich
   * etwas geändert hat – der Abfragetakt allein ist kein Grund, die Übersicht
   * neu aufzubauen.
   */
  if (!panel.querySelector('#overview-banners')) {
    panel.innerHTML = '<div id="overview-banners"></div><div id="overview-body"></div>';
  }
  const banners = panel.querySelector('#overview-banners');
  const body = panel.querySelector('#overview-body');

  const problems = summary.integrations.problems ?? [];
  const bannerKey = JSON.stringify([
    problems.map((problem) => [problem.id, problem.error]),
    store.updates?.updatesAvailable ?? 0,
    store.updates?.autoUpdate?.enabled ?? false,
  ]);

  if (banners.dataset.key !== bannerKey) {
    banners.dataset.key = bannerKey;
    banners.innerHTML = '';
    renderOverviewBanners(banners, problems);
  }

  renderOverviewBody(body, summary);
}

/** Die Meldungen, die einen Knopf tragen – deshalb Elemente statt HTML. */
function renderOverviewBanners(panel, problems) {
  // Probleme zuerst – sie sind der Grund, warum jemand das Dashboard öffnet.
  for (const problem of problems) {
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
}

function renderOverviewBody(panel, summary) {
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

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = '<h2>Klima nach Raum</h2>';

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.innerHTML = climateRooms.length
    ? climateRooms.map(climateCard).join('')
    : emptyState(
        '🌡️',
        'Noch keine Messwerte.',
        'Ordne Temperatursensoren einem Raum zu, dann erscheinen sie hier.',
      );

  // Erst zusammenbauen, dann einmal vergleichen und nur bei einer echten
  // Änderung einsetzen.
  const draft = document.createElement('div');
  draft.append(hero, tiles, quick, head, grid);
  if (!paint(panel, draft.innerHTML)) return;

  wireQuickActions(panel.querySelector('.quick-actions'));
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
// Räume und Geräte
// ---------------------------------------------------------------------------

/**
 * Eine Ansicht für beides.
 *
 * Vorher waren es zwei Reiter, dann zwei Unterreiter – und immer noch zwei
 * Suchfelder, zwei Filter und zwei Antworten auf dieselbe Frage. Dabei ist
 * „Räume" keine andere Sache als „Geräte": Es ist dieselbe Liste, nur
 * gruppiert.
 *
 * Jetzt gibt es **eine** Werkzeugleiste, die für beides gilt. Ob nach Räumen
 * gruppiert oder am Stück angezeigt wird, ist eine Einstellung darin – keine
 * zweite Seite.
 */
const homeView = {
  search: '',
  /** `''` = alle Räume, `__none` = die ohne Raum. */
  roomId: '',
  capability: '',
  /** `room` | `name` | `power` | `recent` */
  sort: 'room',
  /** `rooms` = nach Räumen gruppiert, `list` = alles am Stück. */
  layout: 'rooms',
  /** Schnellfilter, siehe `HOME_CHIPS`. */
  chip: 'all',
  /** Ausgewählte Geräte für Sammelaktionen. */
  selected: new Set(),
  /** Steht der Bogen zum Hinzufügen offen? */
  adding: false,
};

/**
 * Schnellfilter.
 *
 * Jeder beantwortet eine Frage, die man wirklich stellt – „was ist noch an?",
 * „was hängt nirgends dran?", „was antwortet nicht?". Ein Filter für jede
 * denkbare Eigenschaft wäre eine Suchmaske; das hier sind sechs Knöpfe.
 */
const HOME_CHIPS = [
  { id: 'all', label: 'Alle', match: () => true },
  { id: 'favorites', label: '⭐ Favoriten', match: (device) => device.favorite === true },
  { id: 'on', label: '💡 An', match: (device) => device.state?.on === true },
  { id: 'off', label: '🌙 Aus', match: (device) => device.state?.on === false },
  { id: 'unassigned', label: '🚪 Ohne Raum', match: (device) => device.roomId === null },
  { id: 'offline', label: '⚠️ Offline', match: (device) => device.reachable === false },
];

const HOME_SORTS = [
  ['room', 'Raum'],
  ['name', 'Name'],
  ['power', 'Verbrauch'],
  ['recent', 'Zuletzt gesehen'],
];

const HOME_CAPABILITIES = [
  ['', 'Alle Fähigkeiten'],
  ['switch', 'Schaltbar'],
  ['dimmer', 'Dimmbar'],
  ['color', 'Farbe'],
  ['cover', 'Rollläden'],
  ['thermostat', 'Heizung'],
  ['sensor.temperature', 'Temperatur'],
  ['sensor.humidity', 'Luftfeuchte'],
  ['sensor.power', 'Verbrauch'],
];

/** Die Geräte, die gerade durch alle Filter kommen. */
function visibleDevices() {
  const needle = homeView.search.trim().toLowerCase();
  const chip = HOME_CHIPS.find((entry) => entry.id === homeView.chip) ?? HOME_CHIPS[0];

  const list = store.devices.filter((device) => {
    if (homeView.capability && !device.capabilities.includes(homeView.capability)) return false;
    if (homeView.roomId === '__none' && device.roomId !== null) return false;
    else if (homeView.roomId && homeView.roomId !== '__none' && device.roomId !== homeView.roomId) {
      return false;
    }
    if (!chip.match(device)) return false;
    if (!needle) return true;

    /*
     * Gesucht wird über alles, wonach jemand sucht: den Namen, den Raum, den
     * Hersteller und das Modell. Wer „hue" tippt, meint meist alle Lampen der
     * Bridge – nicht nur die, die zufällig „Hue" im Namen tragen.
     */
    const haystack = [
      device.name,
      roomName(device.roomId),
      VENDOR_LABEL[device.vendor] ?? device.vendor,
      device.model ?? '',
      device.manufacturer ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });

  return sortDevices(list);
}

function sortDevices(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'de');
  const sorted = [...list];

  switch (homeView.sort) {
    case 'name':
      sorted.sort(byName);
      break;
    case 'power':
      // Ohne Messwert ganz nach unten: Eine Liste, die mit zwanzig „–" beginnt,
      // beantwortet die Frage „wer verbraucht am meisten?" nicht.
      sorted.sort((a, b) => (b.state?.powerW ?? -1) - (a.state?.powerW ?? -1) || byName(a, b));
      break;
    case 'recent':
      sorted.sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || byName(a, b));
      break;
    default:
      sorted.sort((a, b) => roomName(a.roomId).localeCompare(roomName(b.roomId), 'de') || byName(a, b));
  }

  // Favoriten immer zuerst – dafür sind sie da.
  return [...sorted.filter((device) => device.favorite), ...sorted.filter((device) => !device.favorite)];
}

/**
 * Räume und Geräte in einer Ansicht.
 */
async function renderHome() {
  const panel = $('#panel-home');
  if (!panel) return;

  const devices = visibleDevices();
  const total = store.devices.length;
  const on = devices.filter((device) => device.state?.on === true).length;
  const filtered = devices.length !== total;

  const html = `
    <p class="intro">
      Alles, was im Haus hängt – nach Räumen gruppiert oder am Stück, mit einer
      Suche für beides. ${wikiLink('raeume', 'Was bringen Räume?')}
    </p>

    ${homeToolbar()}

    <div class="chips home-chips">${HOME_CHIPS.map(
      (chip) => `<button type="button" class="chip ${chip.id === homeView.chip ? 'active' : ''}"
                         data-home-chip="${esc(chip.id)}">${esc(chip.label)}</button>`,
    ).join('')}</div>

    <div class="row between home-summary">
      <span class="muted small">
        ${
          filtered
            ? `${esc(plural(devices.length, 'Gerät', 'Geräte'))} von ${total}`
            : esc(plural(total, 'Gerät', 'Geräte'))
        }${on > 0 ? ` · ${on} an` : ''}
      </span>
      ${
        /*
         * Der Knopf hängt daran, ob ein Filter *gesetzt* ist – nicht daran, ob
         * er gerade etwas wegnimmt. Sonst verschwände er genau dann, wenn die
         * Suche auf alle Geräte passt, und man käme aus ihr nicht mehr heraus,
         * ohne das Feld von Hand zu leeren.
         */
        isFiltering()
          ? '<button class="small ghost" id="home-reset">Filter zurücksetzen</button>'
          : ''
      }
    </div>

    ${addDevicePanel()}

    ${selectionBar()}

    <div id="home-body">${
      homeView.layout === 'rooms' ? groupedByRoom(devices) : flatList(devices)
    }</div>`;

  if (!paint(panel, html)) return;

  bindDeviceControls(panel, sendCommand, deviceById);
  wireDeviceEditors(panel);
  wireHomeToolbar(panel);
  wireDeviceSlots(panel);
  wireRoomActions(panel);
  restoreOpenSections(panel);
  restoreDrafts(panel);
}

/**
 * Geräte hinzufügen – dort, wo die Geräte stehen.
 *
 * Es gab diesen Weg schon: Einstellungen → Integrationen → aufklappen. Nur
 * hat ihn niemand gefunden. Wer ein Gerät vermisst, sucht es dort, wo die
 * anderen stehen – und nicht in den Einstellungen. Derselbe Bogen, dieselbe
 * Suche, nur an der richtigen Stelle.
 */
function addDevicePanel() {
  if (!homeView.adding) return '';
  return `<section class="card" id="home-add">
    <h2 style="margin:0 0 0.4rem">Gerät hinzufügen</h2>
    <p class="muted small">
      Der Hub sucht Bridges und Geräte im eigenen Netz. Was sich nicht meldet –
      im Gastnetz, hinter einem Repeater –, trägst du mit seiner Adresse von Hand ein.
      ${wikiLink('geraete', 'Wie kommen Geräte hierher?')}
    </p>
    <div class="callout">
      <strong>Bei einer Hue Bridge zuerst den runden Knopf drücken</strong>
      <span>Danach hast du etwa 30 Sekunden Zeit für „Verbinden".</span>
    </div>
    <div class="row">
      <button class="primary" id="btn-home-discover">Netzwerk durchsuchen</button>
      <button class="ghost" id="btn-home-scan"
              title="Klopft zusätzlich jede Adresse im Netz ab – dauert länger, findet mehr.">
        Gründlich suchen
      </button>
    </div>
    <div class="list" id="home-discovery"></div>
    <h3>Von Hand eintragen</h3>
    ${manualForm('form-home-manual')}
  </section>`;
}

function homeToolbar() {
  const rooms = store.rooms ?? [];
  const option = (value, label, current) =>
    `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;

  return `<div class="home-toolbar">
    <div class="search-field">
      <span aria-hidden="true">🔍</span>
      <input id="home-search" type="search" value="${esc(homeView.search)}"
             placeholder="Geräte, Räume, Hersteller durchsuchen …"
             aria-label="Geräte und Räume durchsuchen" />
      <kbd title="Drücke / für die Suche">/</kbd>
    </div>

    <select id="home-room" aria-label="Raum">
      ${option('', 'Alle Räume', homeView.roomId)}
      ${rooms.map((room) => option(room.id, room.name, homeView.roomId)).join('')}
      ${option('__none', 'Ohne Raum', homeView.roomId)}
    </select>

    <select id="home-capability" aria-label="Fähigkeit">
      ${HOME_CAPABILITIES.map(([value, label]) => option(value, label, homeView.capability)).join('')}
    </select>

    <select id="home-sort" aria-label="Sortierung">
      ${HOME_SORTS.map(([value, label]) => option(value, `Sortiert nach ${label}`, homeView.sort)).join('')}
    </select>

    <div class="segmented" role="group" aria-label="Darstellung">
      <button type="button" data-home-layout="rooms"
              class="${homeView.layout === 'rooms' ? 'active' : ''}"
              title="Geräte nach Räumen gruppiert">🛋️ Räume</button>
      <button type="button" data-home-layout="list"
              class="${homeView.layout === 'list' ? 'active' : ''}"
              title="Alle Geräte in einer Liste">📋 Liste</button>
    </div>

    <button class="primary" id="btn-home-add"
            title="Bridges und Geräte im Netz suchen oder von Hand eintragen">
      ${homeView.adding ? '✕ Schließen' : '+ Gerät hinzufügen'}
    </button>
  </div>`;
}

/**
 * Die Leiste für Sammelaktionen.
 *
 * Erscheint erst, wenn etwas ausgewählt ist – vorher wäre sie eine leere
 * Werkzeugleiste, die nur Platz kostet.
 */
function selectionBar() {
  const count = homeView.selected.size;
  if (count === 0) return '';

  const rooms = store.rooms ?? [];
  return `<div class="selection-bar">
    <strong>${esc(plural(count, 'Gerät', 'Geräte'))} ausgewählt</strong>
    <div class="row tight">
      <button class="small" data-bulk="on">Alle an</button>
      <button class="small" data-bulk="off">Alle aus</button>
      ${
        rooms.length
          ? `<select id="bulk-room" aria-label="In einen Raum verschieben">
               <option value="">In Raum verschieben …</option>
               ${rooms.map((room) => `<option value="${esc(room.id)}">${esc(room.name)}</option>`).join('')}
               <option value="__none">— aus dem Raum nehmen —</option>
             </select>`
          : ''
      }
      <button class="small" data-bulk="favorite" title="Angeheftete Geräte stehen immer oben">⭐ Anheften</button>
      <button class="small ghost" data-bulk="hide">Ausblenden</button>
      <button class="small ghost" data-bulk="clear">Auswahl aufheben</button>
    </div>
  </div>`;
}

/** Die Geräte, gruppiert nach ihren Räumen. */
function groupedByRoom(devices) {
  const rooms = store.rooms ?? [];
  const unassigned = devices.filter((device) => device.roomId === null);

  if (rooms.length === 0 && unassigned.length === 0) {
    return emptyState(
      '🏠',
      store.devices.length === 0 ? 'Noch keine Geräte da.' : 'Nichts passt zu diesen Filtern.',
      store.devices.length === 0
        ? 'Unter Einstellungen → Integrationen kannst du Bridges und Geräte hinzufügen.'
        : 'Setze die Filter zurück oder ändere die Suche.',
    );
  }

  const sections = rooms
    .map((room) => {
      const inRoom = devices.filter((device) => device.roomId === room.id);
      // Leere Räume nur zeigen, wenn nicht gefiltert wird – sonst stünden bei
      // einer Suche zehn leere Überschriften über dem einen Treffer.
      if (inRoom.length === 0 && isFiltering()) return '';
      const covers = inRoom.filter((device) => device.capabilities.includes('cover'));

      return `<section class="card">
        <div class="row between">
          <div>
            <h2 style="margin:0">${esc(room.name)}</h2>
            <div class="muted small">
              ${esc(fmt.temperature(room.climate?.temperatureC ?? null))} ·
              💧 ${esc(fmt.percent(room.climate?.humidity ?? null))} ·
              ⚡ ${esc(fmt.power(room.climate?.powerW ?? 0))} · ${esc(plural(inRoom.length, 'Gerät', 'Geräte'))}
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
          inRoom.length
            ? inRoom.map((device) => deviceSlot(device)).join('')
            : emptyState('📭', 'Keine Geräte in diesem Raum.')
        }</div>
      </section>`;
    })
    .filter(Boolean);

  if (unassigned.length > 0) {
    /*
     * Der Bogen steht hier offen und nicht hinter einem Aufklapper: Ein Gerät
     * ohne Raum *ist* die unfertige Stelle. Wer hier landet, will genau das
     * erledigen – und nicht erst suchen, wo man es erledigt.
     */
    sections.push(`<section class="card">
      <div class="row between">
        <h2 style="margin:0">Ohne Raum</h2>
        <span class="badge warn">${esc(plural(unassigned.length, 'Gerät', 'Geräte'))}</span>
      </div>
      <p class="muted small">
        Diese Geräte sind da, gehören aber nirgends hin. Ohne Raum fehlen sie in den
        Raumkacheln, in der Klimaanzeige und bei „alles im Wohnzimmer aus". Name, Raum
        und Gruppe lassen sich gleich hier setzen – oder das Gerät entfernen, wenn es
        nicht gebraucht wird.
      </p>
      <div class="unassigned">${unassigned
        .map(
          (device) => `<div class="unassigned-item device-slot ${
            homeView.selected.has(device.id) ? 'selected' : ''
          }">
            ${slotTools(device)}
            ${deviceCard(device)}
            ${deviceEditor(device)}
          </div>`,
        )
        .join('')}</div>
    </section>`);
  }

  if (sections.length === 0) {
    return emptyState(
      '🔍',
      'Nichts passt zu diesen Filtern.',
      'Setze die Filter zurück oder ändere die Suche.',
    );
  }
  return sections.join('');
}

/** Alle Geräte am Stück, ohne Raumüberschriften. */
function flatList(devices) {
  if (devices.length === 0) {
    return emptyState(
      '🔍',
      store.devices.length === 0 ? 'Noch keine Geräte da.' : 'Nichts passt zu diesen Filtern.',
      store.devices.length === 0
        ? 'Unter Einstellungen → Integrationen kannst du Bridges und Geräte hinzufügen.'
        : 'Setze die Filter zurück oder ändere die Suche.',
    );
  }
  return `<div class="grid">${devices
    .map((device) => deviceSlot(device, { showMeta: true }))
    .join('')}</div>`;
}

function isFiltering() {
  return Boolean(
    homeView.search.trim() || homeView.capability || homeView.roomId || homeView.chip !== 'all',
  );
}

/**
 * Eine Gerätekachel mit dem, was drumherum gehört.
 *
 * Der Stern und das Häkchen sitzen *über* der Karte statt darin: Die Karte
 * gehört dem Gerät und zeigt seinen Zustand; anheften und auswählen sind
 * Dinge, die der Nutzer mit ihr tut.
 */
function slotTools(device) {
  const selected = homeView.selected.has(device.id);
  return `<div class="slot-tools">
    <label class="pick" title="Für eine Sammelaktion auswählen">
      <input type="checkbox" data-pick="${esc(device.id)}" ${selected ? 'checked' : ''} />
    </label>
    <button type="button" class="star ${device.favorite ? 'on' : ''}"
            data-favorite="${esc(device.id)}"
            title="${device.favorite ? 'Nicht mehr anheften' : 'Anheften – steht dann ganz oben'}"
            aria-pressed="${device.favorite ? 'true' : 'false'}">${device.favorite ? '★' : '☆'}</button>
  </div>`;
}

function deviceSlot(device, options = {}) {
  const selected = homeView.selected.has(device.id);
  return `<div class="device-slot ${selected ? 'selected' : ''}">
    ${slotTools(device)}
    ${deviceCard(device, { ...options, roomName: roomName(device.roomId) })}
    <details class="device-edit" data-section="edit-${esc(device.id)}">
      <summary>Umbenennen, Raum, Gruppe, entfernen</summary>
      ${deviceEditor(device)}
    </details>
  </div>`;
}

function wireHomeToolbar(panel) {
  const search = panel.querySelector('#home-search');
  search?.addEventListener('input', (event) => {
    homeView.search = event.target.value;
    void renderHome();
    // Nach dem Neuzeichnen sitzt der Cursor sonst am Anfang.
    const field = $('#home-search');
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  });
  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return;
    homeView.search = '';
    void renderHome();
    $('#home-search')?.focus();
  });

  panel.querySelector('#home-room')?.addEventListener('change', (event) => {
    homeView.roomId = event.target.value;
    void renderHome();
  });
  panel.querySelector('#home-capability')?.addEventListener('change', (event) => {
    homeView.capability = event.target.value;
    void renderHome();
  });
  panel.querySelector('#home-sort')?.addEventListener('change', (event) => {
    homeView.sort = event.target.value;
    void renderHome();
  });

  panel.querySelectorAll('[data-home-layout]').forEach((button) => {
    button.addEventListener('click', () => {
      homeView.layout = button.dataset.homeLayout;
      void renderHome();
    });
  });

  panel.querySelectorAll('[data-home-chip]').forEach((button) => {
    button.addEventListener('click', () => {
      homeView.chip = button.dataset.homeChip;
      void renderHome();
    });
  });

  panel.querySelector('#btn-home-add')?.addEventListener('click', () => {
    homeView.adding = !homeView.adding;
    void renderHome();
    if (homeView.adding) $('#home-add')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  if (homeView.adding) {
    // Nach dem Verbinden alles neu laden – das neue Gerät soll sofort dastehen.
    const afterConnect = async () => {
      await loadDashboardData();
      void renderHome();
    };
    bindManualForm(panel.querySelector('#form-home-manual'), afterConnect);
    panel.querySelector('#btn-home-discover')?.addEventListener('click', () => {
      void runDiscovery(panel.querySelector('#home-discovery'), false, afterConnect);
    });
    panel.querySelector('#btn-home-scan')?.addEventListener('click', () => {
      void runDiscovery(panel.querySelector('#home-discovery'), true, afterConnect);
    });
  }

  panel.querySelector('#home-reset')?.addEventListener('click', () => {
    homeView.search = '';
    homeView.roomId = '';
    homeView.capability = '';
    homeView.chip = 'all';
    void renderHome();
  });

  wireSelection(panel);
}

function wireDeviceSlots(panel) {
  panel.querySelectorAll('[data-favorite]').forEach((button) => {
    button.addEventListener('click', async () => {
      const device = deviceById(button.dataset.favorite);
      if (!device) return;
      const updated = await guard(() =>
        api(`/devices/${device.id}`, { method: 'PATCH', body: { favorite: !device.favorite } }),
      );
      if (!updated) return;
      device.favorite = updated.favorite;
      void renderHome();
    });
  });

  panel.querySelectorAll('[data-pick]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) homeView.selected.add(box.dataset.pick);
      else homeView.selected.delete(box.dataset.pick);
      void renderHome();
    });
  });
}

function wireSelection(panel) {
  const ids = () => [...homeView.selected];

  panel.querySelectorAll('[data-bulk]').forEach((button) => {
    button.addEventListener('click', async () => {
      const what = button.dataset.bulk;
      if (what === 'clear') {
        homeView.selected.clear();
        void renderHome();
        return;
      }

      if (what === 'on' || what === 'off') {
        await guard(
          () =>
            api('/devices/command', {
              method: 'POST',
              body: {
                target: { deviceIds: ids() },
                command: { type: 'setPower', on: what === 'on' },
              },
            }),
          { success: what === 'on' ? 'Eingeschaltet.' : 'Ausgeschaltet.' },
        );
        await reloadDevices();
        return;
      }

      if (what === 'favorite' || what === 'hide') {
        const body = what === 'favorite' ? { favorite: true } : { hidden: true };
        await guard(
          () => Promise.all(ids().map((id) => api(`/devices/${id}`, { method: 'PATCH', body }))),
          { success: what === 'favorite' ? 'Angeheftet.' : 'Ausgeblendet.' },
        );
        homeView.selected.clear();
        await loadDashboardData();
        renderCurrent({ reason: 'devices' });
      }
    });
  });

  panel.querySelector('#bulk-room')?.addEventListener('change', async (event) => {
    const value = event.target.value;
    if (!value) return;
    const roomId = value === '__none' ? null : value;
    await guard(
      () =>
        Promise.all(ids().map((id) => api(`/devices/${id}`, { method: 'PATCH', body: { roomId } }))),
      { success: roomId ? 'Verschoben.' : 'Aus dem Raum genommen.' },
    );
    homeView.selected.clear();
    await loadDashboardData();
    renderCurrent({ reason: 'devices' });
  });
}

function wireRoomActions(panel) {
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

/**
 * `/` springt in die Suche.
 *
 * Der Kniff, den jede Liste hat, in der man wirklich sucht. Nicht, wenn man
 * ohnehin schon in einem Feld tippt – dann ist ein Schrägstrich ein
 * Schrägstrich.
 */
export function startHomeShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    const tag = active?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) {
      return;
    }
    const field = $('#home-search');
    if (!field) return;
    event.preventDefault();
    field.focus();
    field.select();
  });
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

/**
 * Was wann passiert ist.
 *
 * Bewusst getrennt von der Auswertung: Dort liegen Kurven – wie warm es war,
 * wie viel Strom floss. Hier steht die Erzählung: Wer hat geschaltet, welche
 * Automation lief, wann war ein Gerät weg. Die eine Frage beantwortet man mit
 * einer Zahlenreihe, die andere mit Sätzen.
 */
const historyView = { kind: 'all', search: '', entries: [], counts: null, loading: false };

const HISTORY_KINDS = [
  { id: 'all', label: 'Alles', icon: '🕘' },
  { id: 'device', label: 'Geräte', icon: '🔌' },
  { id: 'automation', label: 'Automationen', icon: '⚙️' },
  { id: 'scene', label: 'Szenen', icon: '🎬' },
  { id: 'integration', label: 'Integrationen', icon: '🔗' },
  { id: 'system', label: 'Hub', icon: '🏠' },
];

/** Holt den Verlauf neu und zeichnet ihn – für den Ereignisstrom. */
export async function refreshHistory() {
  await loadHistory();
  void renderActivity();
}

export async function loadHistory() {
  const query = new URLSearchParams({ limit: '300' });
  if (historyView.kind !== 'all') query.set('kind', historyView.kind);
  if (historyView.search.trim()) query.set('search', historyView.search.trim());
  try {
    const data = await api(`/activity?${query}`);
    historyView.entries = data.entries ?? [];
    historyView.counts = data.counts ?? null;
  } catch {
    historyView.entries = [];
  }
}

async function renderActivity() {
  const panel = $('#panel-history');
  if (!panel) return;

  if (!historyView.counts && !historyView.loading) {
    historyView.loading = true;
    await loadHistory();
    historyView.loading = false;
  }

  const chips = HISTORY_KINDS.map((kind) => {
    const count = historyView.counts?.[kind.id];
    return `<button type="button" class="chip ${kind.id === historyView.kind ? 'active' : ''}"
                    data-history-kind="${esc(kind.id)}">${kind.icon} ${esc(kind.label)}${
                      typeof count === 'number' ? ` ${count}` : ''
                    }</button>`;
  }).join('');

  const html = `
    <p class="intro">
      Was in deinem Zuhause passiert ist – geschaltet, ausgelöst, ausgefallen.
      Zahlen und Kurven stehen unter „Auswertung"; hier steht, <em>was</em> geschehen
      ist. ${wikiLink('auswertung', 'Was ist der Unterschied?')}
    </p>

    <div class="home-toolbar">
      <div class="search-field">
        <span aria-hidden="true">🔍</span>
        <input id="history-search" type="search" value="${esc(historyView.search)}"
               placeholder="Im Verlauf suchen …" aria-label="Im Verlauf suchen" />
      </div>
      <button class="small ghost danger" id="btn-history-clear"
              title="Löscht nur den Verlauf. Messwerte, Geräte und Einstellungen bleiben.">
        Verlauf leeren
      </button>
    </div>

    <div class="chips">${chips}</div>

    ${activityTimeline(historyView.entries)}`;

  if (!paint(panel, html)) return;

  panel.querySelectorAll('[data-history-kind]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      historyView.kind = chip.dataset.historyKind;
      await loadHistory();
      void renderActivity();
    });
  });

  const search = panel.querySelector('#history-search');
  search?.addEventListener('input', () => {
    historyView.search = search.value;
    clearTimeout(search.dataset.timer);
    // Nicht bei jedem Buchstaben fragen – der Verlauf liegt beim Hub.
    search.dataset.timer = String(
      setTimeout(async () => {
        await loadHistory();
        void renderActivity();
        const again = $('#history-search');
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      }, 300),
    );
  });

  panel.querySelector('#btn-history-clear')?.addEventListener('click', async () => {
    if (!confirm('Den ganzen Verlauf löschen?\n\nMesswerte, Geräte und Einstellungen bleiben unberührt.')) {
      return;
    }
    await guard(() => api('/activity', { method: 'DELETE' }), { success: 'Verlauf geleert.' });
    await loadHistory();
    void renderActivity();
  });

  restoreDrafts(panel);
}

/**
 * Die Einträge, nach Tagen gebündelt.
 *
 * Ohne diese Bündelung steht in einer langen Liste hundertmal dasselbe Datum.
 * Mit ihr sieht man auf einen Blick, was *heute* war – und das ist fast immer
 * die Frage.
 */
function activityTimeline(entries) {
  if (entries.length === 0) {
    return emptyState(
      '🕘',
      historyView.search || historyView.kind !== 'all'
        ? 'Nichts passt zu dieser Suche.'
        : 'Noch nichts passiert.',
      historyView.search || historyView.kind !== 'all'
        ? 'Ändere die Suche oder wähle „Alles".'
        : 'Sobald etwas geschaltet wird oder eine Automation läuft, steht es hier.',
    );
  }

  const days = new Map();
  for (const entry of entries) {
    const day = new Date(entry.at).toLocaleDateString('de-DE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(entry);
  }

  return [...days.entries()]
    .map(
      ([day, list]) => `<section class="card">
        <h2 style="margin:0 0 0.6rem">${esc(day)}</h2>
        <div class="timeline">${list.map(activityItem).join('')}</div>
      </section>`,
    )
    .join('');
}

const HISTORY_ICON = {
  device: '🔌',
  automation: '⚙️',
  scene: '🎬',
  integration: '🔗',
  system: '🏠',
};

function activityItem(entry) {
  const time = new Date(entry.at).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const room = entry.roomId ? roomName(entry.roomId) : '';
  return `<div class="timeline-row ${esc(entry.level)}">
    <time datetime="${esc(entry.at)}">${esc(time)}</time>
    <span class="timeline-icon" aria-hidden="true">${HISTORY_ICON[entry.kind] ?? '•'}</span>
    <div>
      <div>${esc(entry.message)}</div>
      ${room ? `<div class="sub">${esc(room)}</div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Szenen
// ---------------------------------------------------------------------------

/**
 * Szenen sichern den *aktuellen* Zustand: Man stellt sein Zuhause ein, wie
 * man es haben will, und drückt auf sichern. Das ist der Grund, warum es
 * hier keinen Editor für einzelne Kommandos gibt – der wäre der umständliche
 * Weg zum selben Ziel.
 */
async function renderScenes() {
  const panel = $('#panel-scenes');
  const scenes = store.scenes ?? [];
  const presence = store.presence;

  const controllable = store.devices.filter(
    (device) =>
      !device.hidden &&
      device.capabilities.some((capability) =>
        ['switch', 'dimmer', 'color', 'color_temperature', 'cover', 'thermostat'].includes(
          capability,
        ),
      ),
  );

  panel.innerHTML = `
    <p class="intro">
      Eine Szene merkt sich, wie dein Zuhause gerade ist – Licht, Farbe, Rollläden, Heizung.
      Ein Tipp später steht alles wieder genauso. Du klickst dafür keine Kommandos
      zusammen: Du stellst ein, wie du es magst, und drückst auf sichern.
      ${wikiLink('raeume', 'Wie Szenen funktionieren')}
    </p>

    <div class="grid scenes">
      ${
        scenes.map(sceneCard).join('') ||
        emptyState(
          '✨',
          'Noch keine Szene.',
          'Stell dein Zuhause so ein, wie du es magst – und sichere es unten als Szene.',
        )
      }
    </div>

    <details class="card" data-section="new-scene">
      <summary>Neue Szene aus dem jetzigen Zustand sichern</summary>
      <form id="form-scene" class="form">
        <div class="field-row">
          <label>Name <input name="name" required maxlength="80" placeholder="z. B. Fernsehabend" /></label>
          <label>Zeichen <input name="emoji" maxlength="4" value="✨" class="narrow" /></label>
          <label>Raum (optional)
            <select name="roomId">
              <option value="">– ganzer Haushalt –</option>
              ${store.rooms
                .map((room) => `<option value="${esc(room.id)}">${esc(room.name)}</option>`)
                .join('')}
            </select>
          </label>
        </div>

        <div class="setting-head">
          <strong>Welche Geräte gehören dazu?</strong>
          <span class="row tight">
            <button type="button" class="small ghost" data-scene-select="all">Alle</button>
            <button type="button" class="small ghost" data-scene-select="none">Keine</button>
          </span>
        </div>
        <div class="picker">
          ${
            controllable
              .map(
                (device) => `<label class="pick">
                  <input type="checkbox" name="deviceIds" value="${esc(device.id)}" />
                  <span>
                    <b>${esc(device.name)}</b>
                    <small>${esc(roomName(device.roomId))} · ${esc(describeDeviceState(device))}</small>
                  </span>
                </label>`,
              )
              .join('') || '<p class="muted small">Es sind noch keine steuerbaren Geräte da.</p>'
          }
        </div>
        <p class="field-help">
          Gesichert wird der Zustand von jetzt. Ausgeschaltete Geräte bleiben in der Szene aus –
          Helligkeit und Farbe einer dunklen Lampe mitzuschreiben würde sie beim Abrufen nur
          kurz aufblitzen lassen.
        </p>
        <button type="submit" class="primary" ${controllable.length ? '' : 'disabled'}>
          Szene sichern
        </button>
      </form>
    </details>

    <div class="card">
      <h2>Urlaubsmodus</h2>
      <p class="muted small">
        Eine Wohnung, in der abends nie ein Licht angeht, fällt auf. Im gewählten Zeitfenster
        schaltet der Hub deshalb einzelne Lampen an und aus – in unregelmäßigen Abständen,
        denn ein festes Muster wäre schlimmer als gar nichts.
      </p>
      <form id="form-presence" class="form">
        <label class="check">
          <span class="switch">
            <input type="checkbox" name="enabled" ${presence?.settings.enabled ? 'checked' : ''} />
            <span></span>
          </span>
          <span>Urlaubsmodus einschalten</span>
        </label>
        <div class="field-row">
          <label>Von <input type="time" name="from" value="${esc(presence?.settings.from ?? '17:30')}" /></label>
          <label>Bis <input type="time" name="to" value="${esc(presence?.settings.to ?? '22:45')}" /></label>
          <label>Im Schnitt alle
            <select name="averageIntervalMinutes">
              ${[10, 15, 20, 25, 30, 45, 60, 90]
                .map(
                  (minutes) =>
                    `<option value="${minutes}" ${
                      (presence?.settings.averageIntervalMinutes ?? 25) === minutes ? 'selected' : ''
                    }>${minutes} Minuten</option>`,
                )
                .join('')}
            </select>
          </label>
        </div>
        <div class="setting-head"><strong>Nur in diesen Räumen</strong>
          <span class="muted small">Nichts angekreuzt heißt: überall, wo Licht ist</span></div>
        <div class="chips">
          ${store.rooms
            .map(
              (room) => `<label class="weekday">
                <input type="checkbox" name="roomIds" value="${esc(room.id)}"
                  ${presence?.settings.roomIds?.includes(room.id) ? 'checked' : ''} />
                <span>${esc(room.name)}</span>
              </label>`,
            )
            .join('')}
        </div>
        <div class="row tight">
          <button type="submit" class="primary">Speichern</button>
          <span class="badge ${presence?.active ? 'warn' : ''}">${
            presence?.active
              ? `läuft gerade · ${plural(presence.devicesOn, 'Lampe an', 'Lampen an')}`
              : presence?.settings.enabled
                ? 'aktiv, aber außerhalb der Zeit'
                : 'aus'
          }</span>
          <span class="muted small">${esc(
            plural(presence?.candidates ?? 0, 'Lampe kommt infrage', 'Lampen kommen infrage'),
          )}</span>
        </div>
      </form>
    </div>`;

  wireScenes(panel);
  restoreOpenSections(panel);
}

function sceneCard(scene) {
  const room = scene.roomId ? roomName(scene.roomId) : 'ganzer Haushalt';
  return `<article class="device-card scene-card">
    <header>
      <div>
        <div class="name"><span class="scene-emoji">${esc(scene.emoji)}</span> ${esc(scene.name)}</div>
        <div class="meta">${esc(room)} · ${esc(
          plural(scene.entries.length, 'Gerät', 'Geräte'),
        )}${scene.lastAppliedAt ? ` · zuletzt ${esc(fmt.relative(scene.lastAppliedAt))}` : ''}</div>
      </div>
    </header>
    <div class="row tight">
      <button class="primary" data-scene-apply="${esc(scene.id)}">Herstellen</button>
      <button class="small" data-scene-restamp="${esc(scene.id)}"
              title="Den jetzigen Zustand als neue Vorlage sichern">Neu aufnehmen</button>
      <button class="small danger" data-scene-remove="${esc(scene.id)}">Löschen</button>
    </div>
  </article>`;
}

/** Eine Zeile, die den aktuellen Zustand eines Geräts beschreibt. */
function describeDeviceState(device) {
  const state = device.state ?? {};
  const parts = [];
  if (device.capabilities.includes('cover')) {
    parts.push(`Rollladen ${fmt.percent(state.position)} offen`);
  } else if (device.capabilities.includes('thermostat')) {
    parts.push(`Soll ${fmt.temperature(state.targetTemperatureC)}`);
  } else if (state.on === true) {
    parts.push('an');
    if (typeof state.brightness === 'number') parts.push(fmt.percent(state.brightness));
  } else if (state.on === false) {
    parts.push('aus');
  }
  return parts.join(', ') || 'kein Zustand bekannt';
}

function wireScenes(panel) {
  panel.querySelectorAll('[data-scene-apply]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      // Kurz aufleuchten – die Geräte brauchen einen Moment, die Rückmeldung
      // soll trotzdem sofort da sein.
      const card = button.closest('.scene-card');
      card?.classList.add('applying');
      setTimeout(() => card?.classList.remove('applying'), 800);
      const result = await guard(() =>
        api(`/scenes/${button.dataset.sceneApply}/apply`, { method: 'POST' }),
      );
      button.disabled = false;
      if (!result) return;
      toast(
        result.failed === 0
          ? `„${result.name}" hergestellt.`
          : `„${result.name}" teilweise hergestellt.`,
        {
          kind: result.failed === 0 ? 'success' : 'warn',
          hint:
            result.failed === 0
              ? `${plural(result.applied, 'Gerät', 'Geräte')} geschaltet.`
              : `${result.failed} von ${result.applied + result.failed} Geräten haben nicht reagiert.`,
        },
      );
      await reloadDevices();
    });
  });

  panel.querySelectorAll('[data-scene-restamp]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Die Szene mit dem jetzigen Zustand überschreiben?')) return;
      const updated = await guard(
        () => api(`/scenes/${button.dataset.sceneRestamp}/restamp`, { method: 'POST' }),
        { success: 'Szene neu aufgenommen.' },
      );
      if (!updated) return;
      await loadScenes();
      void renderScenes();
    });
  });

  panel.querySelectorAll('[data-scene-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Szene wirklich löschen?')) return;
      await guard(() => api(`/scenes/${button.dataset.sceneRemove}`, { method: 'DELETE' }));
      await loadScenes();
      void renderScenes();
    });
  });

  panel.querySelectorAll('[data-scene-select]').forEach((button) => {
    button.addEventListener('click', () => {
      const checked = button.dataset.sceneSelect === 'all';
      panel
        .querySelectorAll('input[name="deviceIds"]')
        .forEach((input) => (input.checked = checked));
    });
  });

  panel.querySelector('#form-scene')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const deviceIds = [...event.target.querySelectorAll('input[name="deviceIds"]:checked')].map(
      (input) => input.value,
    );
    if (deviceIds.length === 0) {
      toast('Wähle mindestens ein Gerät aus.', {
        kind: 'warn',
        hint: 'Eine Szene ohne Geräte hätte nichts herzustellen.',
      });
      return;
    }

    const created = await guard(
      () =>
        api('/scenes', {
          method: 'POST',
          body: {
            name: form.get('name'),
            emoji: String(form.get('emoji') || '').trim() || undefined,
            roomId: form.get('roomId') || null,
            deviceIds,
          },
        }),
      { success: 'Szene gesichert.' },
    );
    if (!created) return;
    event.target.reset();
    await loadScenes();
    void renderScenes();
  });

  panel.querySelector('#form-presence')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const roomIds = [...event.target.querySelectorAll('input[name="roomIds"]:checked')].map(
      (input) => input.value,
    );

    const status = await guard(
      () =>
        api('/presence', {
          method: 'PATCH',
          body: {
            enabled: form.get('enabled') === 'on',
            from: form.get('from'),
            to: form.get('to'),
            averageIntervalMinutes: Number(form.get('averageIntervalMinutes')),
            roomIds,
          },
        }),
      { success: 'Urlaubsmodus gespeichert.' },
    );
    if (!status) return;
    store.presence = status;
    void renderScenes();
  });
}

/** Szenen und Urlaubsmodus nachladen. */
export async function loadScenes() {
  const [scenes, presence] = await Promise.all([api('/scenes'), api('/presence')]);
  store.scenes = scenes;
  store.presence = presence;
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

/**
 * Auswertung: Stromverbrauch und Messwertverlauf auf einem Bildschirm.
 *
 * Die beiden Teile behalten ihre eigenen Bereiche – und damit ihre eigenen
 * Kennungen –, damit ein neuer Messwert nur den betroffenen Teil neu zeichnet
 * und nicht die halb ausgefüllte Auswahl darüber wegreißt.
 */
async function renderInsights() {
  const panel = $('#panel-insights');
  if (!panel.querySelector('#panel-energy')) {
    panel.innerHTML = `<p class="intro">
        Was war? Links der Stromverbrauch mit Kosten, darunter die Messwertkurven.
        Beide beantworten dieselbe Frage aus zwei Richtungen.
        ${wikiLink('auswertung', 'Woher die Zahlen kommen')}
      </p>
      <div id="panel-energy"></div><div id="panel-history"></div>`;
  }
  await Promise.all([renderEnergy(), renderHistory()]);
}

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
      Geräte sind schon ausgewählt. ${wikiLink('automationen', 'Auslöser, Takte und Dauer erklärt')}
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
                <select name="everySeconds">${INTERVAL_CHOICES.map(
                  (choice) => {
                    const seconds = choice.seconds ?? choice.minutes * 60;
                    return `<option value="${seconds}" ${seconds === 3600 ? 'selected' : ''}>${esc(
                      choice.label,
                    )}</option>`;
                  },
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
          <label class="check">
            <input type="checkbox" name="autoUndo" />
            <span>… und danach von selbst wieder zurück</span>
          </label>
          <label>Nach wie vielen Sekunden zurück?
            <input name="forSeconds" type="number" min="1" max="3600" value="10" class="narrow" />
          </label>
          <p class="field-help">
            Damit lassen sich Regeln bauen, die von selbst wieder aufhören – „alle
            20 Sekunden das Licht für 10 Sekunden an". Die Zahl davor ist die Sperrzeit:
            So lange passiert danach nichts erneut. Bei einer Wiederholung im
            Sekundentakt gehört dort eine 0 hin.
          </p>
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
          // Nur mitschicken, wenn die Rücknahme auch gewollt ist.
          ...(form.get('autoUndo') === 'on'
            ? { forSeconds: Number(form.get('forSeconds') || 10) }
            : {}),
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
/*
 * Die Auswahl deckt zwei Größenordnungen ab: Sekunden für kurze Spielereien
 * („alle 20 Sekunden kurz an") und Minuten bis Stunden für das Übliche
 * („alle zwei Stunden lüften"). Intern zählt der Hub in Sekunden; Minuten
 * sind nur die bequemere Schreibweise.
 */
const INTERVAL_CHOICES = [
  { seconds: 20, label: '20 Sekunden' },
  { seconds: 30, label: '30 Sekunden' },
  { minutes: 1, label: '1 Minute' },
  { minutes: 5, label: '5 Minuten' },
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
      everySeconds: Number(form.get('everySeconds')),
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
    const every = describeEvery(
      trigger.everySeconds !== undefined ? trigger.everySeconds / 60 : trigger.everyMinutes,
    );
    const window = trigger.from && trigger.to ? ` zwischen ${trigger.from} und ${trigger.to} Uhr` : '';
    return `Alle ${every}${window}${describeDays(trigger.days)}`;
  }
  return `Um ${trigger.at} Uhr${describeDays(trigger.days)}`;
}

/** „90 Minuten“ ist schwerer zu lesen als „1,5 Stunden“ – aber nur knapp. */
function describeEvery(minutes) {
  // Unter einer Minute liest sich „0,33 Minuten" niemand gern.
  if (minutes && minutes < 1) return `${Math.round(minutes * 60)} Sekunden`;
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
    <p class="intro">
      Hier stellst du ein, wie sich der Hub verhält: wie oft er nachsieht, was er kostet,
      wie er aussieht – und hier verbindest du weitere Geräte.
      ${wikiLink('start', 'Wo fange ich an?')}
    </p>

    <div class="card">
      <h2>Firmware-Updates ${help(
        'Der Hub prüft zweimal täglich, ob es für Bridges und Geräte neue Firmware gibt. Installiert wird nur auf Knopfdruck oder im gewählten Nachtfenster.',
      )}</h2>
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
      <h2>Wie oft der Hub nachsieht ${help(
        'Kurz heißt: Was du am Lichtschalter machst, steht schneller auf dem Bildschirm. Lang heißt: weniger Last für Bridges und Batteriegeräte. Die Hue Bridge meldet ohnehin von selbst.',
      )}</h2>
      <p class="muted small">
        In diesem Takt fragt der Hub alle Geräte nach ihrem Zustand. Kurz heißt: Was du
        am Lichtschalter oder von Hand am Rollladen machst, steht schneller auf dem
        Bildschirm. Lang heißt: weniger Last für Bridges und Batteriegeräte.
        Push-fähige Verbindungen – die Hue Bridge – melden Änderungen ohnehin sofort;
        für sie ändert der Takt wenig.
      </p>
      <form id="form-polling" class="form">
        <div class="chips">${POLL_PRESETS.map(
          (preset) => `<button type="button" class="chip ${
            (household?.pollIntervalSeconds ?? 15) === preset.seconds ? 'active' : ''
          }" data-poll="${preset.seconds}">${esc(preset.label)}</button>`,
        ).join('')}</div>
        <label>Eigener Takt in Sekunden (3 – 300)
          <input type="number" name="pollIntervalSeconds" min="3" max="300" step="1"
                 class="narrow" value="${household?.pollIntervalSeconds ?? 15}" />
        </label>
        <button type="submit" class="primary">Speichern</button>
      </form>
    </div>

    <div class="card">
      <h2>Stromtarif ${help(
        'Grundlage der Kostenrechnung unter „Auswertung". Ohne Preis zeigt der Hub Kilowattstunden, aber keine Kosten.',
      )}</h2>
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

    ${fritzboxCard()}

    <div class="card">
      <h2>Integrationen ${help(
        'Eine Integration ist die Verbindung zu einem Hersteller – deine Hue Bridge, ein Shelly, die FRITZ!Box. Über sie kommen die Geräte in den Hub.',
      )}</h2>
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

    ${accountCard()}

    ${storageCard()}

    <div class="card">
      <h2>Sicherung ${help(
        'Räume, Namen, Zuordnungen, Szenen und Automationen als Datei – ohne Passwörter. Sie darf deshalb auf einem USB-Stick liegen.',
      )}</h2>
      <p class="muted small">
        Räume, Geräte­namen, Automationen, Szenen und alle Einstellungen als Datei –
        für den Umzug auf neue Hardware oder als Rückweg, wenn etwas schiefgeht.
      </p>
      <div class="callout">
        <strong>In der Datei stehen keine Passwörter</strong>
        <span>
          Weder die Zugangsdaten deiner Bridges noch die Anmeldedaten der Bewohner. Die
          Datei darf also auf einem USB-Stick liegen. Der Preis: Auf einem <em>anderen</em>
          Hub muss jede Verbindung einmal neu hergestellt werden.
        </span>
      </div>
      <div class="row tight">
        <button class="primary small" id="btn-backup">Sicherung herunterladen</button>
        <button class="ghost small" id="btn-restore">Sicherung zurückspielen</button>
        <input type="file" id="restore-file" accept="application/json,.json" class="hidden" />
      </div>
    </div>

    <div class="card" id="card-hub-version">${hubVersionCard()}</div>

    <details class="card danger-zone" data-section="danger">
      <summary>Haushalt löschen</summary>
      <p class="muted small">
        Löscht diesen Haushalt mit allem, was daran hängt: Räume, Geräte, Automationen,
        Szenen, alle Benutzerkonten, die hinterlegten Zugangsdaten deiner Bridges und das
        gesamte Messwertarchiv. Danach startet der Hub wieder mit der Einrichtung.
      </p>
      <div class="callout warn">
        <strong>Das lässt sich nicht rückgängig machen</strong>
        <span>
          Wenn du dir nicht sicher bist: Lade zuerst eine Sicherung herunter. Damit
          bekommst du Räume, Namen, Szenen und Automationen zurück – die Zugangsdaten
          deiner Bridges allerdings nicht.
        </span>
      </div>
      <div id="danger-zone-body"></div>
    </details>

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
  wireAccount(panel);
  restoreOpenSections(panel);
  await Promise.all([renderTokens(), renderSessions(), renderUsers(), loadHubVersion()]);
}

/**
 * Der Reiter „Dienste": Sonos, Spotify, Nextcloud.
 *
 * Die Musik bringt ihre eigene Datei mit (`music.js`); die Nextcloud-Karte
 * wohnte bis hierher in den Einstellungen und ist mit umgezogen – sie gehört
 * zu denselben Nachbarn.
 */
/** Welcher Unterreiter der Dienste zuletzt offen war. */
let serviceTab = 'sonos';

/**
 * Welche Unterreiter es gibt.
 *
 * Die FRITZ!Box erscheint nur, wenn eine verbunden ist – ein Reiter für ein
 * Gerät, das niemand hat, ist eine leere Versprechung. Sonos und Spotify
 * stehen dagegen immer da: Dort steht auch, *wie* man sie einrichtet.
 */
function serviceTabs() {
  const boxes = (store.integrations ?? []).filter((entry) => entry.type === 'fritzbox');
  return [
    { id: 'sonos', label: 'Sonos', icon: '🔈' },
    { id: 'spotify', label: 'Spotify', icon: '🎧' },
    { id: 'nextcloud', label: 'Nextcloud', icon: '☁️' },
    ...(boxes.length > 0
      ? [{ id: 'fritzbox', label: 'FRITZ!Box', icon: '📶', badge: boxes.length > 1 ? String(boxes.length) : '' }]
      : []),
  ];
}

async function renderServices() {
  const panel = $('#panel-services');
  if (!panel) return;

  const tabs = serviceTabs();
  if (!tabs.some((tab) => tab.id === serviceTab)) serviceTab = 'sonos';

  // Gerüst einmalig aufbauen; danach werden nur die Unterbereiche gefüllt.
  if (!panel.querySelector('#service-tabs')) {
    panel.innerHTML = `
      <p class="intro">
        Alles, was kein Gerät ist: Lautsprecher, Musik, Benachrichtigungen – und die
        FRITZ!Box, sobald eine verbunden ist. Bei einer Lampe gibt es an und aus; hier
        gibt es Titel, Konten und Meldungen. Deshalb stehen sie getrennt.
      </p>
      <div class="subtabs" id="service-tabs" role="tablist"></div>
      <div id="service-body"></div>`;
  }

  const bar = panel.querySelector('#service-tabs');
  const nextBar = tabs
    .map(
      (tab) =>
        `<button role="tab" data-service-tab="${esc(tab.id)}" aria-selected="${tab.id === serviceTab}"
           class="${tab.id === serviceTab ? 'active' : ''}">${tab.icon} ${esc(tab.label)}${
             tab.badge ? `<span class="badge">${esc(tab.badge)}</span>` : ''
           }</button>`,
    )
    .join('');

  if (paint(bar, nextBar)) {
    bar.querySelectorAll('[data-service-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        serviceTab = button.dataset.serviceTab;
        void renderServices();
      });
    });
  }

  const body = panel.querySelector('#service-body');
  const wanted = `sub-${serviceTab}`;
  if (!body.querySelector(`#${wanted}`)) {
    body.innerHTML = `<div class="card" id="${wanted}"></div>`;
  }

  if (serviceTab === 'sonos' || serviceTab === 'spotify') {
    await loadMusic();
    renderMusic(serviceTab);
  } else if (serviceTab === 'nextcloud') {
    await loadNextcloud();
    renderNextcloudCard();
  } else {
    await renderFritzboxPanel(body.querySelector('#sub-fritzbox'));
  }
}

/**
 * Der FRITZ!Box-Reiter: Zustand, ihre Geräte und ihre eigene Oberfläche.
 *
 * Warum die Geräte hier noch einmal auftauchen, obwohl sie auch unter
 * „Geräte" stehen: Wer wissen will, ob die Box tut, was sie soll, will sie
 * *zusammen* sehen – Steckdose, Heizkörperregler und Rollladen an derselben
 * Box, mit dem Verbindungszustand darüber. Unter „Geräte" stehen sie
 * zwischen Hue und Shelly, nach Räumen sortiert.
 */
async function renderFritzboxPanel(card) {
  if (!card) return;

  const boxes = (store.integrations ?? []).filter((entry) => entry.type === 'fritzbox');
  const devices = store.devices.filter((device) => device.vendor === 'fritzbox');
  const url = store.household?.fritzboxUrl ?? '';

  const status = boxes
    .map((box) => {
      const ok = box.status === 'linked';
      return `<div class="item">
        <div>
          <div class="title">${esc(box.name)} ${
            ok
              ? '<span class="badge ok">verbunden</span>'
              : `<span class="badge error">${esc(box.status)}</span>`
          }</div>
          <div class="sub">${esc(box.config.host)}${
            box.config.model ? ` · ${esc(box.config.model)}` : ''
          } · ${esc(plural(box.deviceCount ?? 0, 'Gerät', 'Geräte'))}</div>
          ${box.lastError ? `<div class="sub">${esc(box.lastError)}</div>` : ''}
        </div>
        <div class="row tight">
          <button class="small" data-box-test="${esc(box.id)}"
            title="Fragt die Box einmal ab und meldet, ob die Anmeldung noch steht.">Verbindung prüfen</button>
          <button class="small" data-box-sync="${esc(box.id)}"
            title="Liest die Geräteliste der Box neu ein – nach neuen DECT-Geräten.">Geräte neu einlesen</button>
        </div>
      </div>`;
    })
    .join('');

  paint(
    card,
    `${cardHead(
      'FRITZ!Box',
      'Alles, was per DECT an der Box hängt: Schaltsteckdosen, Heizkörperregler, ' +
        'Lampen und Rollläden. Darunter die Oberfläche der Box selbst.',
      {
        tip:
          'Der Hub spricht die AHA-Schnittstelle der Box. Klemmt die Anmeldung, ' +
          'liegt es fast immer am Benutzernamen oder an der fehlenden Berechtigung ' +
          '„Smart-Home-Geräte und Automatisierung steuern".',
      },
    )}

     <div class="list">${status}</div>

     <h3>Geräte an dieser Box ${help(
       'Dieselben Geräte stehen auch unter „Geräte" – dort nach Räumen sortiert, hier nach Herkunft.',
     )}</h3>
     <div class="grid" id="fritzbox-devices">${
       devices.length
         ? devices.map((device) => deviceCard(device)).join('')
         : emptyState(
             '🔌',
             'An dieser Box hängt noch kein Gerät.',
             'DECT-Geräte müssen zuerst an der Box angemeldet werden (Taste „Connect/DECT"). ' +
               'Danach hilft „Geräte neu einlesen".',
           )
     }</div>

     <hr class="divider" />
     <h3>Oberfläche der Box ${help(
       'Der direkte Weg in die Box – nützlich für alles, was der Hub nicht kann: WLAN, Telefonie, Anrufliste.',
     )}</h3>
     ${
       url
         ? `<div class="row tight" style="margin:.4rem 0">
              <a class="linkbutton" href="${esc(url)}" target="_blank" rel="noreferrer noopener"
                 title="Öffnet die Box in einem eigenen Fenster – das klappt immer.">
                In neuem Fenster öffnen ↗
              </a>
              <span class="muted small">Adresse ändern: Einstellungen → FRITZ!Box-Oberfläche</span>
            </div>
            <div class="embed-frame">
              <iframe src="${esc(url)}" title="FRITZ!Box" loading="lazy" referrerpolicy="no-referrer"></iframe>
            </div>
            <p class="muted small">
              Bleibt der Rahmen leer, verbietet deine Box das Einbetten. Dann führt nur der
              Knopf darüber zum Ziel – das ist eine Einstellung der Box, keine des Hubs.
            </p>`
         : `<p class="muted small">
              Noch keine Adresse hinterlegt. Unter <b>Einstellungen → FRITZ!Box-Oberfläche</b>
              eintragen (meist <code>http://fritz.box</code>), dann erscheint sie hier.
            </p>`
     }`,
  ) && wireFritzboxPanel(card);
}

function wireFritzboxPanel(card) {
  bindDeviceControls(card, sendCommand, deviceById);

  card.querySelectorAll('[data-box-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await guard(() =>
        api(`/integrations/${button.dataset.boxTest}/test`, { method: 'POST' }),
      );
      button.disabled = false;
      if (!result) return;
      toast(
        result.status === 'linked' ? 'Die Box antwortet.' : `Zustand: ${result.status}`,
        { kind: result.status === 'linked' ? 'success' : 'warn' },
      );
      store.integrations = await api('/integrations');
      void renderServices();
    });
  });

  card.querySelectorAll('[data-box-sync]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Liest ein …';
      const result = await guard(() =>
        api(`/integrations/${button.dataset.boxSync}/sync`, { method: 'POST' }),
      );
      button.disabled = false;
      button.textContent = 'Geräte neu einlesen';
      if (!result) return;
      toast(
        `${plural(result.added ?? 0, 'neues Gerät', 'neue Geräte')}, ${
          result.updated ?? 0
        } aktualisiert.`,
        { kind: 'success' },
      );
      await reloadDevices();
      void renderServices();
    });
  });
}

/** Konto, Personen und angemeldete Geräte bedienen. */
function wireAccount(panel) {
  panel.querySelector('#form-password')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    if (String(form.get('newPassword')) !== String(form.get('newPasswordRepeat'))) {
      toast('Die beiden neuen Passwörter stimmen nicht überein.', { kind: 'error' });
      return;
    }
    const result = await guard(() =>
      api('/auth/password', {
        method: 'POST',
        body: {
          currentPassword: form.get('currentPassword'),
          newPassword: form.get('newPassword'),
        },
      }),
    );
    if (!result) return;
    event.target.reset();
    toast(result.message, { kind: 'success' });
    await renderSessions();
  });

  panel.querySelector('#btn-logout')?.addEventListener('click', async () => {
    await guard(() => api('/auth/logout', { method: 'POST' }));
    location.reload();
  });

  panel.querySelector('#btn-end-others')?.addEventListener('click', async () => {
    const result = await guard(() => api('/auth/sessions/end-others', { method: 'POST' }));
    if (!result) return;
    toast(plural(result.ended, 'Gerät abgemeldet', 'Geräte abgemeldet'), { kind: 'success' });
    await renderSessions();
  });

  panel.querySelector('#form-user')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const created = await guard(() =>
      api('/auth/users', {
        method: 'POST',
        body: {
          username: String(form.get('username')).trim(),
          displayName: String(form.get('displayName') || '').trim() || undefined,
          password: form.get('password'),
          role: form.get('role'),
        },
      }),
    );
    if (!created) return;
    event.target.reset();
    toast(`„${created.displayName}" kann sich jetzt anmelden.`, {
      kind: 'success',
      hint: `Anmeldename: ${created.username}`,
    });
    await renderUsers();
  });
}

async function renderSessions() {
  const list = $('#sessions-list');
  if (!list) return;
  const sessions = await guard(() => api('/auth/sessions'));
  if (!sessions) return;

  list.innerHTML =
    sessions
      .map(
        (session) => `<div class="item">
          <div>
            <div class="title">${esc(session.device ?? 'Unbekanntes Gerät')}
              ${session.current ? '<span class="badge ok">dieses Gerät</span>' : ''}</div>
            <div class="sub">zuletzt genutzt ${esc(fmt.relative(session.lastUsedAt))} ·
              angemeldet ${esc(fmt.time(session.createdAt))}</div>
          </div>
          ${
            session.current
              ? ''
              : `<button class="small danger" data-end-session="${esc(session.id)}">Abmelden</button>`
          }
        </div>`,
      )
      .join('') || emptyState('💤', 'Keine weiteren Anmeldungen.');

  list.querySelectorAll('[data-end-session]').forEach((button) => {
    button.addEventListener('click', async () => {
      await guard(() => api(`/auth/sessions/${button.dataset.endSession}`, { method: 'DELETE' }));
      await renderSessions();
    });
  });
}

async function renderUsers() {
  const list = $('#users-list');
  if (!list) return;
  const users = await guard(() => api('/auth/users'));
  if (!users) return;

  const me = store.me?.user;
  list.innerHTML = users
    .map(
      (user) => `<div class="item">
        <div>
          <div class="title">${esc(user.displayName)}
            <span class="badge ${user.role === 'admin' ? 'ok' : ''}">${
              user.role === 'admin' ? 'Administrator' : 'Mitbewohner'
            }</span>
            ${user.id === me?.id ? '<span class="badge">du</span>' : ''}
          </div>
          <div class="sub">Anmeldename ${esc(user.username)} ·
            ${user.lastLoginAt ? `zuletzt angemeldet ${esc(fmt.relative(user.lastLoginAt))}` : 'noch nie angemeldet'}</div>
        </div>
        ${
          user.id === me?.id
            ? ''
            : `<div class="row tight">
                 <button class="small" data-reset-password="${esc(user.id)}"
                         data-username="${esc(user.username)}">Passwort setzen</button>
                 <button class="small danger" data-remove-user="${esc(user.id)}">Entfernen</button>
               </div>`
        }
      </div>`,
    )
    .join('');

  list.querySelectorAll('[data-reset-password]').forEach((button) => {
    button.addEventListener('click', async () => {
      const newPassword = prompt(
        `Neues Passwort für „${button.dataset.username}" (mindestens 10 Zeichen):`,
      );
      if (!newPassword) return;
      const result = await guard(() =>
        api(`/auth/users/${button.dataset.resetPassword}/password`, {
          method: 'POST',
          body: { newPassword },
        }),
      );
      if (result) toast(result.message, { kind: 'success' });
    });
  });

  list.querySelectorAll('[data-remove-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Diese Person wirklich entfernen? Sie kann sich danach nicht mehr anmelden.')) {
        return;
      }
      await guard(() => api(`/auth/users/${button.dataset.removeUser}`, { method: 'DELETE' }));
      await renderUsers();
    });
  });
}

/**
 * Konto, weitere Personen, angemeldete Geräte – und ganz unten die
 * Zugriffstoken, die es weiterhin gibt, aber nur noch für Programme.
 */
function accountCard() {
  const me = store.me?.user;
  const isAdmin = me?.role === 'admin';

  return `<div class="card">
    <h2>Dein Konto</h2>
    ${
      me
        ? `<p class="muted small">
             Angemeldet als <strong>${esc(me.displayName)}</strong> (${esc(me.username)}) ·
             ${me.role === 'admin' ? 'Administrator' : 'Mitbewohner'}
           </p>`
        : `<p class="muted small">
             Dieser Hub läuft ohne Anmeldepflicht (<code>AUTH_DISABLED</code>). Für den
             Zugriff von außerhalb des Heimnetzes ist das nicht gedacht.
           </p>`
    }

    ${
      me
        ? `<form id="form-password" class="form">
             <div class="field-row">
               <label>Bisheriges Passwort
                 <input name="currentPassword" type="password" required autocomplete="current-password" />
               </label>
               <label>Neues Passwort
                 <input name="newPassword" type="password" required minlength="10" autocomplete="new-password" />
               </label>
               <label>Wiederholen
                 <input name="newPasswordRepeat" type="password" required minlength="10" autocomplete="new-password" />
               </label>
             </div>
             <p class="field-help">
               Mindestens zehn Zeichen. Nach der Änderung werden alle anderen angemeldeten
               Geräte abgemeldet – genau dafür ändert man üblicherweise sein Passwort.
             </p>
             <div class="row tight">
               <button type="submit" class="primary">Passwort ändern</button>
               <button type="button" class="ghost" id="btn-logout">Abmelden</button>
             </div>
           </form>

           <details data-section="sessions">
             <summary>Angemeldete Geräte</summary>
             <div class="list" id="sessions-list"></div>
             <button class="small" id="btn-end-others">Alle anderen Geräte abmelden</button>
           </details>`
        : ''
    }

    ${
      isAdmin
        ? `<details data-section="users">
             <summary>Personen im Haushalt</summary>
             <p class="muted small">
               Jede Person bekommt einen eigenen Zugang. „Mitbewohner" dürfen alles bedienen,
               „Administratoren" zusätzlich Geräte und Konten verwalten.
             </p>
             <div class="list" id="users-list"></div>
             <form id="form-user" class="form">
               <div class="field-row">
                 <label>Anmeldename
                   <input name="username" required minlength="3" maxlength="32" placeholder="z. B. ben"
                          autocapitalize="none" autocorrect="off" spellcheck="false" />
                 </label>
                 <label>Angezeigter Name
                   <input name="displayName" maxlength="80" placeholder="z. B. Ben" />
                 </label>
                 <label>Passwort
                   <input name="password" type="password" required minlength="10" autocomplete="new-password" />
                 </label>
                 <label>Rolle
                   <select name="role">
                     <option value="member">Mitbewohner</option>
                     <option value="admin">Administrator</option>
                   </select>
                 </label>
               </div>
               <button type="submit" class="primary">Person hinzufügen</button>
             </form>
           </details>`
        : ''
    }

    <details data-section="tokens">
      <summary>Zugänge für Programme (Zugriffstoken)</summary>
      <p class="muted small">
        Für Skripte und andere Programme, die sich nicht anmelden können. Menschen brauchen
        das nicht – für dich reicht dein Name und dein Passwort.
      </p>
      <form id="form-token" class="form inline">
        <input name="name" placeholder="z. B. Backup-Skript" maxlength="80" required />
        <button type="submit" class="primary">Token erstellen</button>
      </form>
      <div class="list" id="tokens-list"></div>
    </details>
  </div>`;
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

    <div class="setting-block">
      <div class="setting-head"><strong>Bewegung und Vorschau</strong></div>
      <label class="check">
        <input type="checkbox" id="live-preview" ${current.livePreview !== false ? 'checked' : ''} />
        <span>
          Lichtvorschau – beim Verstellen zeigt die Gerätekarte sofort, wie das Licht
          aussehen wird, statt auf die Antwort der Lampe zu warten
        </span>
      </label>
      <label class="check">
        <input type="checkbox" id="reduce-motion" ${current.reduceMotion ? 'checked' : ''} />
        <span>Bewegung reduzieren – Animationen laufen dann nicht mehr</span>
      </label>
    </div>

    <div class="row tight">
      <button class="ghost small" id="btn-appearance-reset">Auf Standard zurücksetzen</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Haushalt löschen
// ---------------------------------------------------------------------------

/**
 * Fünfmal nachfragen – aber nicht fünfmal dasselbe.
 *
 * Fünf gleichlautende „Bist du sicher?" klickt man in fünf Sekunden weg; sie
 * erziehen nur dazu, nicht mehr hinzusehen. Jeder Schritt hier nennt deshalb
 * etwas anderes, das gleich verschwindet – mit den tatsächlichen Zahlen aus
 * diesem Haushalt. Wer bis zum Ende kommt, hat es fünfmal schwarz auf weiß
 * gelesen. Der letzte Schritt lässt sich überhaupt nicht klicken, sondern nur
 * tippen.
 */
let dangerStep = 0;

function dangerSteps() {
  const counts = {
    devices: store.devices.length,
    rooms: store.rooms.length,
    automations: store.automations.length,
    scenes: store.scenes.length,
    integrations: store.integrations.length,
  };

  return [
    {
      question: `„${store.household?.name ?? 'Dieser Haushalt'}" wirklich löschen?`,
      detail: 'Ab hier wird es ernst. Abbrechen geht bis zum letzten Schritt.',
      confirm: 'Ja, ich will löschen',
    },
    {
      question: `${plural(counts.devices, 'Gerät', 'Geräte')} und ${plural(
        counts.rooms,
        'Raum',
        'Räume',
      )} verschwinden.`,
      detail:
        'Die Geräte selbst bleiben natürlich, wo sie sind – aber ihre Namen, ihre ' +
        'Raumzuordnung und alles, was du hier eingestellt hast, sind weg.',
      confirm: 'Verstanden, weiter',
    },
    {
      question: `${plural(counts.automations, 'Automation', 'Automationen')} und ${plural(
        counts.scenes,
        'Szene',
        'Szenen',
      )} verschwinden.`,
      detail: 'Auch das gesamte Messwertarchiv – jede aufgezeichnete Temperatur, jede kWh.',
      confirm: 'Auch das ist mir klar',
    },
    {
      question: `Alle Zugänge werden gelöscht – auch deiner.`,
      detail:
        `Und die hinterlegten Zugangsdaten von ${plural(
          counts.integrations,
          'Verbindung',
          'Verbindungen',
        )}${store.nextcloud?.account ? ' samt dem App-Passwort der Nextcloud' : ''}. ` +
        'Nach dem Löschen musst du dich neu einrichten und jede Bridge neu koppeln.',
      confirm: 'Ja, auch meinen Zugang',
    },
    {
      question: 'Zum Schluss: Tippe den Namen des Haushalts ab.',
      detail:
        'Das ist der einzige Schritt, den man nicht wegklicken kann – und genau ' +
        'deshalb steht er hier.',
      confirm: 'Haushalt endgültig löschen',
      typed: true,
    },
  ];
}

function renderDangerZone() {
  const body = $('#danger-zone-body');
  if (!body) return;

  const isAdmin = store.me?.user?.role === 'admin' || store.me?.authDisabled;
  if (!isAdmin) {
    body.innerHTML =
      '<p class="muted small">Einen Haushalt löschen dürfen nur Administratoren.</p>';
    return;
  }

  const steps = dangerSteps();

  if (dangerStep === 0) {
    body.innerHTML = `<button class="danger" id="danger-start">Haushalt löschen …</button>`;
    body.querySelector('#danger-start').addEventListener('click', () => {
      dangerStep = 1;
      renderDangerZone();
    });
    return;
  }

  const step = steps[dangerStep - 1];
  body.innerHTML = `
    <div class="danger-step">
      <div class="danger-count">Schritt ${dangerStep} von ${steps.length}</div>
      <div class="title">${esc(step.question)}</div>
      <p class="muted small">${esc(step.detail)}</p>
      ${
        step.typed
          ? `<label>Name des Haushalts
               <input id="danger-name" autocomplete="off" autocapitalize="none"
                      spellcheck="false" placeholder="${esc(store.household?.name ?? '')}" />
             </label>`
          : ''
      }
      <div class="row tight">
        <button class="danger" id="danger-next" ${step.typed ? 'disabled' : ''}>
          ${esc(step.confirm)}
        </button>
        <button class="ghost" id="danger-cancel">Abbrechen</button>
      </div>
    </div>`;

  body.querySelector('#danger-cancel').addEventListener('click', () => {
    dangerStep = 0;
    renderDangerZone();
  });

  const next = body.querySelector('#danger-next');

  if (!step.typed) {
    next.addEventListener('click', () => {
      dangerStep += 1;
      renderDangerZone();
    });
    return;
  }

  // Letzter Schritt: Der Knopf bleibt gesperrt, bis der Name genau stimmt.
  const field = body.querySelector('#danger-name');
  const expected = (store.household?.name ?? '').trim();
  field.addEventListener('input', () => {
    next.disabled = field.value.trim() !== expected;
  });
  field.focus();

  next.addEventListener('click', async () => {
    next.disabled = true;
    next.textContent = 'Wird gelöscht …';
    const result = await guard(() =>
      api('/household', { method: 'DELETE', body: { confirmName: field.value.trim() } }),
    );
    if (!result) {
      next.disabled = false;
      next.textContent = step.confirm;
      return;
    }
    // Der eigene Zugang ist mit gelöscht – ein Neuladen führt in den Assistenten.
    toast(result.message, { kind: 'success', timeout: 10_000 });
    setTimeout(() => location.reload(), 1200);
  });
}

// ---------------------------------------------------------------------------
// Sicherung
// ---------------------------------------------------------------------------

/**
 * Herunterladen und Zurückspielen.
 *
 * Der Download läuft nicht über `api()`: Der Hub liefert die Datei mit
 * `Content-Disposition` aus, und der Browser soll sie speichern, nicht
 * anzeigen. Deshalb der Umweg über einen unsichtbaren Link.
 */
function wireBackup(panel) {
  panel.querySelector('#btn-backup')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const response = await fetch('/api/system/backup', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `smarthome-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast('Sicherung heruntergeladen.', {
        kind: 'success',
        hint: 'Bewahre sie außerhalb des Hubs auf – auf dem Hub nützt sie im Ernstfall nichts.',
      });
    } catch {
      toast('Die Sicherung konnte nicht erstellt werden.', { kind: 'error' });
    } finally {
      event.target.disabled = false;
    }
  });

  const file = panel.querySelector('#restore-file');
  panel.querySelector('#btn-restore')?.addEventListener('click', () => file?.click());

  file?.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;

    if (
      !confirm(
        'Zurückspielen ersetzt Räume, Geräte, Automationen und Szenen vollständig. ' +
          'Der aktuelle Stand geht dabei verloren. Fortfahren?',
      )
    ) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await chosen.text());
    } catch {
      toast('Die Datei lässt sich nicht lesen.', {
        kind: 'error',
        hint: 'Wähle die JSON-Datei, die der Hub unter „Sicherung herunterladen“ erzeugt hat.',
      });
      return;
    }

    const result = await guard(() => api('/system/restore', { method: 'POST', body: parsed }));
    if (!result) return;

    toast(
      `Wiederhergestellt: ${plural(result.rooms, 'Raum', 'Räume')}, ` +
        `${plural(result.devices, 'Gerät', 'Geräte')}, ` +
        `${plural(result.rules, 'Automation', 'Automationen')}.`,
      {
        kind: 'success',
        timeout: 12_000,
        hint: result.needRelink.length
          ? `Noch zu verbinden: ${result.needRelink.join(', ')}`
          : 'Alle Verbindungen bestehen weiter.',
      },
    );
    await loadDashboardData();
    void renderSettings();
  });
}

// ---------------------------------------------------------------------------
// Diagnose und Gerätetyp richtigstellen
// ---------------------------------------------------------------------------

/**
 * Gerätearten, die man von Hand einstellen kann.
 *
 * Bewusst keine Liste einzelner Fähigkeiten: „schaltbar, dimmbar, Farben,
 * Weißtöne“ einzeln anzuklicken ist die Aufgabe des Hubs, nicht die des
 * Bewohners. Hier steht, was das Gerät *ist* – die Fähigkeiten ergeben sich
 * daraus.
 */
const DEVICE_KIND_PRESETS = [
  { id: 'auto', label: 'wie gemeldet', capabilities: null },
  { id: 'switch', label: 'Schalter', capabilities: ['switch'] },
  { id: 'dimmer', label: 'dimmbares Licht', capabilities: ['switch', 'dimmer'] },
  {
    id: 'color',
    label: 'Farblicht',
    capabilities: ['switch', 'dimmer', 'color', 'color_temperature'],
  },
  { id: 'cover', label: 'Rollladen', capabilities: ['cover'] },
  { id: 'cover_tilt', label: 'Jalousie mit Lamellen', capabilities: ['cover', 'cover.tilt'] },
  { id: 'thermostat', label: 'Heizung', capabilities: ['thermostat', 'sensor.temperature'] },
];

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Welche Voreinstellung passt zur aktuellen Richtigstellung? */
function currentKind(device) {
  const override = device.capabilityOverride;
  if (!override || override.length === 0) return 'auto';
  const actuators = override.filter((capability) => !capability.startsWith('sensor.'));
  const match = DEVICE_KIND_PRESETS.find(
    (preset) => preset.capabilities && sameSet(preset.capabilities.filter(
      (capability) => !capability.startsWith('sensor.'),
    ), actuators),
  );
  return match?.id ?? 'custom';
}

/**
 * Ein Gerät mit Wahlmöglichkeit für seinen Typ.
 *
 * Sensorfähigkeiten bleiben erhalten, egal was gewählt wird: Ein Shelly, der
 * als Rollladen richtiggestellt wird, misst weiterhin Strom – das eine hat
 * mit dem anderen nichts zu tun.
 */
function capabilityFixItem(device) {
  const kind = currentKind(device);
  const chips = DEVICE_KIND_PRESETS.map(
    (preset) => `<button type="button" class="chip ${preset.id === kind ? 'active' : ''}"
                         data-fix-kind="${esc(preset.id)}">${esc(preset.label)}</button>`,
  ).join('');

  const capabilities = device.capabilities ?? [];
  const abilities = capabilities
    .map((capability) => CAPABILITY_LABEL[capability])
    .filter(Boolean)
    .join(', ');

  // Die Sensorfähigkeiten reisen im Markup mit: Der Bericht kennt auch
  // ausgeblendete Geräte, die im normalen Datenstand gar nicht auftauchen.
  const sensors = capabilities.filter((capability) => capability.startsWith('sensor.'));

  return `<div class="item column">
    <div>
      <div class="title">${esc(device.name)}
        ${device.capabilityOverride?.length ? '<span class="badge">richtiggestellt</span>' : ''}
        ${device.reachable === false ? '<span class="badge">offline</span>' : ''}
      </div>
      <div class="sub">${esc(abilities || 'keine Fähigkeiten erkannt')}</div>
    </div>
    <div class="chips" data-fix-device="${esc(device.id)}" data-fix-sensors="${esc(sensors.join(','))}">
      ${chips}
    </div>
  </div>`;
}

/**
 * Der kleine Bogen, mit dem sich ein Gerät geraderücken lässt.
 *
 * Vier Dinge an einer Stelle: Name, Raum, Gruppe, und der Weg hinaus. Sie
 * gehören zusammen, weil sie zusammen auftreten – ein frisch gefundenes Gerät
 * heißt „Shelly 1PM 34AB9F", steckt in keinem Raum, gilt als Schalter und ist
 * in Wahrheit der Rollladen im Bad. Bisher lagen die vier Handgriffe an vier
 * verschiedenen Orten in der Oberfläche.
 *
 * Die eigene Kennung am Formular ist kein Schmuck: Ohne sie hielte der
 * Entwurfsspeicher (`drafts.js`) die Namensfelder aller Geräte für dasselbe
 * Feld.
 */
function deviceEditor(device) {
  const rooms = store.rooms ?? [];
  const kind = currentKind(device);
  const sensors = (device.capabilities ?? []).filter((capability) =>
    capability.startsWith('sensor.'),
  );

  const roomOptions = [
    `<option value="" ${device.roomId ? '' : 'selected'}>— ohne Raum —</option>`,
    ...rooms.map(
      (room) =>
        `<option value="${esc(room.id)}" ${room.id === device.roomId ? 'selected' : ''}>${esc(
          room.name,
        )}</option>`,
    ),
  ].join('');

  const kindOptions = DEVICE_KIND_PRESETS.map(
    (preset) =>
      `<option value="${esc(preset.id)}" ${preset.id === kind ? 'selected' : ''}>${esc(
        preset.label,
      )}</option>`,
  ).join('');

  /*
   * Wer genau einen Raum hat, soll nicht durch eine Auswahlliste mit einem
   * Eintrag müssen. Ein Knopf sagt dasselbe in einem Klick.
   */
  const only = rooms.length === 1 ? rooms[0] : null;
  const quick =
    only && device.roomId === null
      ? `<button type="button" class="small primary" data-quick-room="${esc(only.id)}">
           In „${esc(only.name)}“
         </button>`
      : '';

  return `<form class="form device-editor" id="edit-${esc(device.id)}"
                data-edit-device="${esc(device.id)}"
                data-sensors="${esc(sensors.join(','))}">
    <div class="row">
      <label class="grow">Name
        <input name="name" value="${esc(device.name)}" maxlength="120" required />
      </label>
      <label>Raum
        <select name="roomId">${roomOptions}</select>
      </label>
      <label>Gruppe ${help(
        'Wofür der Hub das Gerät hält. Stimmt es nicht, lässt es sich hier richtigstellen – ' +
          'die Angabe gilt dann überall: auf der Karte, in Automationen und in Szenen.',
      )}
        <select name="kind">${kindOptions}</select>
      </label>
    </div>
    <div class="row tight">
      ${quick}
      <button type="submit" class="small primary">Speichern</button>
      <button type="button" class="small ghost danger" data-delete-device="${esc(device.id)}"
              title="Entfernt das Gerät aus dem Hub. Am Gerät selbst ändert das nichts.">
        Entfernen
      </button>
    </div>
  </form>`;
}

/**
 * @param {ParentNode} root
 */
function wireDeviceEditors(root) {
  if (!root) return;

  root.querySelectorAll('[data-edit-device]').forEach((form) => {
    const deviceId = form.dataset.editDevice;
    const sensors = form.dataset.sensors ? form.dataset.sensors.split(',').filter(Boolean) : [];

    const save = async (overrides = {}) => {
      const data = new FormData(form);
      const preset = DEVICE_KIND_PRESETS.find((entry) => entry.id === data.get('kind'));
      const body = {
        name: String(data.get('name') ?? '').trim(),
        roomId: String(data.get('roomId') ?? '') || null,
        // Sensorfähigkeiten bleiben erhalten: Ein Shelly, der als Rollladen
        // richtiggestellt wird, misst weiterhin Strom.
        capabilityOverride: preset?.capabilities
          ? [...new Set([...preset.capabilities, ...sensors])]
          : null,
        ...overrides,
      };
      if (!body.name) return;

      const updated = await guard(() => api(`/devices/${deviceId}`, { method: 'PATCH', body }), {
        success: 'Gespeichert.',
      });
      if (!updated) return;
      await loadDashboardData();
      renderCurrent({ reason: 'devices' });
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void save();
    });

    form.querySelector('[data-quick-room]')?.addEventListener('click', (event) => {
      void save({ roomId: event.currentTarget.dataset.quickRoom });
    });

    form.querySelector('[data-delete-device]')?.addEventListener('click', async () => {
      const name = String(new FormData(form).get('name') ?? 'dieses Gerät');
      if (
        !confirm(
          `„${name}" aus dem Hub entfernen?\n\n` +
            'Das Gerät selbst bleibt unberührt und taucht bei der nächsten Suche wieder auf. ' +
            'Verloren gehen sein Name, seine Raumzuordnung und sein Platz in Szenen und Automationen.',
        )
      ) {
        return;
      }
      await guard(() => api(`/devices/${deviceId}`, { method: 'DELETE' }), {
        success: 'Gerät entfernt.',
      });
      await loadDashboardData();
      renderCurrent({ reason: 'devices' });
    });
  });
}

function wireCapabilityFix(root) {
  root.querySelectorAll('[data-fix-device]').forEach((group) => {
    const deviceId = group.dataset.fixDevice;
    const sensors = group.dataset.fixSensors ? group.dataset.fixSensors.split(',') : [];

    group.querySelectorAll('[data-fix-kind]').forEach((button) => {
      button.addEventListener('click', async () => {
        const preset = DEVICE_KIND_PRESETS.find((entry) => entry.id === button.dataset.fixKind);
        if (!preset) return;
        const capabilityOverride = preset.capabilities
          ? [...new Set([...preset.capabilities, ...sensors])]
          : null;

        const updated = await guard(() =>
          api(`/devices/${deviceId}`, { method: 'PATCH', body: { capabilityOverride } }),
        );
        if (!updated) return;

        group.querySelectorAll('[data-fix-kind]').forEach((chip) => {
          chip.classList.toggle('active', chip === button);
        });
        toast(
          capabilityOverride
            ? `„${updated.name}" gilt jetzt als ${preset.label}.`
            : `„${updated.name}" folgt wieder dem, was das Gerät meldet.`,
          { kind: 'success' },
        );
        await loadDashboardData();
        renderCurrent({ reason: 'devices' });
      });
    });
  });
}

/**
 * Der Bericht zu einer Integration.
 *
 * Die übersprungenen Kanäle stehen mit Begründung da. Das ist der
 * eigentliche Zweck: „Rollladen fehlt“ ist keine Fehlermeldung, mit der man
 * etwas anfangen kann – „Kanal 4 übersprungen, weil Typ MAINTENANCE“ schon.
 */
function diagnosticsReport(report) {
  const devices = report.devices.length
    ? report.devices.map(capabilityFixItem).join('')
    : emptyState('📭', 'Diese Verbindung hat kein einziges Gerät geliefert.');

  const skipped = report.supportsDiagnostics
    ? report.skipped.length
      ? report.skipped
          .map(
            (entry) => `<div class="item">
              <div>
                <div class="title">${esc(entry.address)}</div>
                <div class="sub">${esc(entry.channelType)} · ${esc(entry.reason)}</div>
              </div>
            </div>`,
          )
          .join('')
      : '<p class="muted small">Nichts übersprungen – alles, was gemeldet wurde, ist da.</p>'
    : '<p class="muted small">Diese Verbindung führt keine Liste übersprungener Kanäle.</p>';

  return `<h3>${esc(plural(report.devices.length, 'Gerät gefunden', 'Geräte gefunden'))}</h3>
    <p class="muted small">
      Stimmt ein Typ nicht, lässt er sich hier richtigstellen – die Angabe gilt ab sofort
      überall, auch in Automationen und Szenen.
    </p>
    ${devices}
    <h3>Übersprungen</h3>
    ${skipped}`;
}

/**
 * Wo die Daten liegen.
 *
 * Die Karte beantwortet eine Frage, die sich erst beim nächsten Update
 * stellt – und dann zu spät: Was muss ich behalten, wenn ich mir die neueste
 * Fassung hole? Antwort: diesen einen Ordner. Er liegt außerhalb des
 * Projektordners, damit ihn ein `git pull`, ein neues Archiv oder ein
 * frischer Klon nicht anfasst.
 */
function storageCard() {
  const storage = store.systemInfo?.storage;
  if (!storage) return '';

  const ok = storage.separateFromCode;

  return `<div class="card" id="card-storage">
    <h2>Wo deine Daten liegen ${help(
      'Datenbank, Messwerte und der Schlüssel, mit dem Zugangsdaten verschlüsselt sind. Diesen Ordner sichern – und beim Aktualisieren stehen lassen.',
    )}</h2>
    <p class="muted small card-explain">
      Hier liegen Haushalt, Räume, Geräte, Szenen, Automationen, das Messwertarchiv und
      der Schlüssel für die gespeicherten Zugangsdaten.
    </p>

    <div class="list">
      <div class="item">
        <div>
          <div class="title">${
            ok
              ? '<span class="badge ok">außerhalb des Programmordners</span>'
              : '<span class="badge warn">im Programmordner</span>'
          }</div>
          <div class="sub"><code>${esc(storage.dataDir)}</code></div>
          <div class="sub">Schlüssel: ${
            storage.secretKeySource === 'env'
              ? 'aus der Umgebung (SECRET_KEY)'
              : 'als <code>secret.key</code> in diesem Ordner'
          }</div>
        </div>
      </div>
    </div>

    ${
      ok
        ? `<div class="callout">
             <strong>Aktualisieren ist damit gefahrlos</strong>
             <span>
               Du kannst dir jederzeit die neueste Fassung von GitHub holen – als
               <code>git pull</code>, als Archiv oder als frischen Ordner. Deine Einrichtung
               liegt woanders und bleibt, wie sie ist. ${wikiLink(
                 'sicherung',
                 'Wie ich richtig aktualisiere',
               )}
             </span>
           </div>`
        : `<div class="callout warn">
             <strong>Dieser Ordner liegt im Programmordner</strong>
             <span>
               Beim nächsten Neu-Herunterladen wäre er weg. Setze <code>DATA_DIR</code> auf
               einen Ort daneben – oder verschiebe den Ordner und starte den Hub neu, dann
               findet er ihn selbst.
             </span>
           </div>`
    }
  </div>`;
}

/**
 * Die FRITZ!Box-Oberfläche im Hub.
 *
 * Der Notausgang für den Fall, dass die Smart-Home-Anbindung partout nicht
 * will. Statt zu behaupten, es gäbe keinen Weg, zeigt der Hub die Oberfläche
 * der Box selbst – dort funktioniert alles, was die Box kann.
 *
 * Ehrlich dazugesagt: Viele FRITZ!Boxen verbieten das Einbetten in fremde
 * Seiten (`X-Frame-Options`). Ob es klappt, entscheidet die Box, nicht der
 * Hub – deshalb steht „in neuem Fenster öffnen" gleichberechtigt daneben.
 * Der Weg geht immer.
 */
function fritzboxCard() {
  const url = store.household?.fritzboxUrl ?? '';

  return `<div class="card" id="card-fritzbox">
    <h2>FRITZ!Box-Oberfläche ${help(
      'Der direkte Weg in die Box – für alles, was der Hub nicht kann: WLAN, Telefonie, Anrufliste. Die Ansicht erscheint auch unter Dienste → FRITZ!Box.',
    )}</h2>
    <p class="muted small">
      Trage hier die Adresse deiner Box ein, dann kannst du sie direkt aus dem Hub heraus
      bedienen. Nützlich, solange die Smart-Home-Anbindung klemmt: In der Box-Oberfläche
      funktioniert alles wie gewohnt.
    </p>
    <form id="form-fritzbox" class="form inline">
      <input name="fritzboxUrl" class="grow" maxlength="200" placeholder="http://fritz.box"
             value="${esc(url)}" />
      <button type="submit" class="primary">Speichern</button>
    </form>
    ${
      url
        ? `<div class="row tight" style="margin:.6rem 0">
             <a class="linkbutton" href="${esc(url)}" target="_blank" rel="noreferrer noopener">
               In neuem Fenster öffnen ↗
             </a>
             <span class="muted small">Klappt immer – auch wenn die Box das Einbetten verbietet.</span>
           </div>
           <div class="embed-frame">
             <iframe src="${esc(url)}" title="FRITZ!Box" loading="lazy"
                     referrerpolicy="no-referrer"></iframe>
           </div>
           <p class="muted small">
             Bleibt der Rahmen leer, verbietet deine Box das Einbetten. Dann führt nur der
             Knopf darüber zum Ziel – das ist eine Einstellung der Box, keine des Hubs.
           </p>`
        : ''
    }
  </div>`;
}

// ---------------------------------------------------------------------------
// Nextcloud
// ---------------------------------------------------------------------------

/** Auswahl für den Abruftakt der Benachrichtigungen. */
const NEXTCLOUD_INTERVALS = [
  { seconds: 15, label: '15 Sekunden' },
  { seconds: 30, label: '30 Sekunden' },
  { seconds: 60, label: '1 Minute' },
  { seconds: 300, label: '5 Minuten' },
];

/**
 * Verbindung zur eigenen Nextcloud und die offenen Benachrichtigungen.
 *
 * Warum das hier steht und nicht bei den Integrationen: Eine Nextcloud ist
 * kein Gerät. Es gibt nichts zu schalten und nichts zu messen – sie erzählt
 * nur, was passiert ist. Sie in dieselbe Liste wie eine Hue Bridge zu
 * stellen, würde beide Begriffe verwischen.
 */
function nextcloudCard() {
  const state = store.nextcloud;

  if (!state) {
    return `<h2>Nextcloud</h2>
      <div class="list"><div class="item"><div>
        <div class="title skeleton-line"></div>
        <div class="sub skeleton-line short"></div>
      </div></div></div>`;
  }

  if (!state.account) return nextcloudSetupCard();

  const account = state.account;
  const badge = account.lastError
    ? '<span class="badge warn">Problem</span>'
    : account.enabled
      ? '<span class="badge ok">verbunden</span>'
      : '<span class="badge">pausiert</span>';

  const host = (() => {
    try {
      return new URL(account.baseUrl).host;
    } catch {
      return account.baseUrl;
    }
  })();

  const problem = account.lastError
    ? `<div class="callout warn">
         <strong>Der letzte Abruf ging schief</strong>
         <span>${esc(account.lastError)}</span>
       </div>`
    : '';

  const notifications = state.notifications ?? [];
  const list = notifications.length
    ? notifications.map(nextcloudNotificationItem).join('')
    : emptyState('📭', 'Nichts Offenes. Neue Meldungen erscheinen hier und als Einblendung.');

  return `<h2>Nextcloud ${badge}</h2>
    <div class="list">
      <div class="item">
        <div>
          <div class="title">${esc(account.displayName || account.username)} @ ${esc(host)}</div>
          <div class="sub">
            ${account.serverVersion ? `Nextcloud ${esc(account.serverVersion)} · ` : ''}
            Takt ${esc(String(account.pollIntervalSeconds))} s ·
            ${
              account.lastSeenAt
                ? `zuletzt ${esc(fmt.relative(account.lastSeenAt))}`
                : 'noch kein Abruf'
            }
          </div>
        </div>
        <div class="row tight">
          <button class="small" id="btn-nextcloud-refresh">Jetzt nachsehen</button>
        </div>
      </div>
    </div>

    ${problem}

    <h3>Offene Benachrichtigungen (${notifications.length})</h3>
    <div class="list" id="nextcloud-notifications">${list}</div>
    ${
      notifications.length
        ? '<button class="ghost small" id="btn-nextcloud-dismiss-all">Alle als gelesen markieren</button>'
        : ''
    }

    <hr class="divider" />
    <form id="form-nextcloud-settings" class="form">
      <label class="row tight" style="flex-direction:row;align-items:center;gap:.6rem">
        <span class="switch">
          <input type="checkbox" name="enabled" ${account.enabled ? 'checked' : ''} />
          <span></span>
        </span>
        Benachrichtigungen abholen
      </label>
      <label>Wie oft nachgesehen wird
        <select name="pollIntervalSeconds">
          ${NEXTCLOUD_INTERVALS.map(
            (choice) =>
              `<option value="${choice.seconds}" ${
                account.pollIntervalSeconds === choice.seconds ? 'selected' : ''
              }>${esc(choice.label)}</option>`,
          ).join('')}
        </select>
      </label>
      <button type="submit" class="primary">Speichern</button>
    </form>

    <details data-section="nextcloud-relink">
      <summary>Verbindung ändern oder trennen</summary>
      ${nextcloudForm()}
      <hr class="divider" />
      <button class="ghost small danger" id="btn-nextcloud-disconnect">Verbindung trennen</button>
      <p class="muted small">
        Dabei wird auch das gespeicherte App-Passwort gelöscht. In Nextcloud selbst
        bleibt es bestehen – dort kannst du es unter „Sicherheit“ endgültig entfernen.
      </p>
    </details>`;
}

function nextcloudSetupCard() {
  return `<h2>Nextcloud</h2>
    <p class="muted small">
      Neue Talk-Nachrichten, geteilte Dateien, Kalendererinnerungen: Der Hub holt die
      Benachrichtigungen deiner Nextcloud ab und blendet sie hier ein – auf dem Tablet
      an der Wand ebenso wie auf dem Handy.
    </p>
    <div class="callout">
      <strong>Bitte ein App-Passwort verwenden, nicht dein Anmeldepasswort</strong>
      <span>
        In Nextcloud: Einstellungen → Sicherheit → ganz unten „Neues App-Passwort
        erstellen“. Das funktioniert auch mit Zwei-Faktor-Anmeldung und lässt sich
        einzeln widerrufen, ohne dass du dein Konto anfassen musst.
      </span>
    </div>
    ${nextcloudForm()}`;
}

function nextcloudForm() {
  const account = store.nextcloud?.account;
  return `<form id="form-nextcloud" class="form">
    <label>Adresse deiner Nextcloud
      <input name="baseUrl" placeholder="https://cloud.example.de" maxlength="300"
             value="${esc(account?.baseUrl ?? '')}" required />
    </label>
    <div class="field-row">
      <label>Benutzername
        <input name="username" maxlength="120" autocomplete="off"
               value="${esc(account?.username ?? '')}" required />
      </label>
      <label>App-Passwort
        <input name="appPassword" type="password" maxlength="300" autocomplete="new-password"
               placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" required />
      </label>
    </div>
    <button type="submit" class="primary">Verbinden</button>
  </form>`;
}

function nextcloudNotificationItem(notification) {
  const title = notification.subject || 'Neue Benachrichtigung';
  const when = notification.datetime ? fmt.relative(notification.datetime) : '';
  const open = notification.link
    ? `<a class="linkbutton" href="${esc(notification.link)}" target="_blank" rel="noreferrer noopener">Öffnen ↗</a>`
    : '';
  return `<div class="item" data-notification="${esc(String(notification.id))}">
    <div>
      <div class="title">${esc(title)}</div>
      <div class="sub">${esc(notification.app)}${when ? ` · ${esc(when)}` : ''}${
        notification.message ? ` · ${esc(notification.message.slice(0, 120))}` : ''
      }</div>
    </div>
    <div class="row tight">
      ${open}
      <button class="small" data-dismiss="${esc(String(notification.id))}">Gelesen</button>
    </div>
  </div>`;
}

/**
 * Es ist eine neue Meldung eingetroffen – die Liste auffrischen, aber nur,
 * wenn sie gerade jemand ansieht. Sonst wäre jedes Popup eine zusätzliche
 * Anfrage für eine Karte, die niemand offen hat.
 */
export function refreshNextcloudCard() {
  if (!$('#sub-nextcloud')) return;
  void loadNextcloud({ force: true });
}

async function loadNextcloud({ force = false } = {}) {
  if (!store.nextcloud || force) {
    const state = await guard(() => api('/nextcloud'));
    if (state) store.nextcloud = state;
  }
  renderNextcloudCard();
}

function renderNextcloudCard() {
  const card = $('#sub-nextcloud');
  if (!card) return;
  card.innerHTML = nextcloudCard();
  wireNextcloud(card);
  restoreOpenSections(card);
}

function wireNextcloud(card) {
  card.querySelector('#form-nextcloud')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Verbinde …';
    const account = await guard(
      () =>
        api('/nextcloud', {
          method: 'POST',
          body: {
            baseUrl: String(form.get('baseUrl')).trim(),
            username: String(form.get('username')).trim(),
            appPassword: String(form.get('appPassword')),
          },
        }),
      { success: 'Nextcloud verbunden.', successHint: 'Neue Benachrichtigungen erscheinen ab jetzt als Einblendung.' },
    );
    button.disabled = false;
    button.textContent = 'Verbinden';
    if (!account) return;
    await loadNextcloud({ force: true });
  });

  card.querySelector('#form-nextcloud-settings')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const saved = await guard(
      () =>
        api('/nextcloud', {
          method: 'PATCH',
          body: {
            enabled: form.get('enabled') === 'on',
            pollIntervalSeconds: Number(form.get('pollIntervalSeconds')),
          },
        }),
      { success: 'Gespeichert.' },
    );
    if (!saved) return;
    await loadNextcloud({ force: true });
  });

  card.querySelector('#btn-nextcloud-refresh')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    const result = await guard(() => api('/nextcloud/refresh', { method: 'POST' }));
    event.target.disabled = false;
    if (!result) return;
    await loadNextcloud({ force: true });
  });

  /*
   * Die drei folgenden Aktionen antworten mit „204 – nichts zu sagen“. Der
   * Rückgabewert taugt deshalb nicht als Erfolgsprüfung; Fehler hat `guard`
   * bereits angezeigt. Danach wird schlicht der Stand vom Hub neu geholt –
   * er ist die Wahrheit, nicht das, was hier gerade auf dem Bildschirm steht.
   */
  card.querySelector('#btn-nextcloud-dismiss-all')?.addEventListener('click', async () => {
    await guard(() => api('/nextcloud/notifications', { method: 'DELETE' }), {
      success: 'Alles als gelesen markiert.',
    });
    await loadNextcloud({ force: true });
  });

  card.querySelectorAll('[data-dismiss]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const id = button.dataset.dismiss;
      await guard(() => api(`/nextcloud/notifications/${id}`, { method: 'DELETE' }));
      await loadNextcloud({ force: true });
    });
  });

  card.querySelector('#btn-nextcloud-disconnect')?.addEventListener('click', async () => {
    if (!confirm('Verbindung zur Nextcloud trennen? Das gespeicherte App-Passwort wird gelöscht.')) {
      return;
    }
    await guard(() => api('/nextcloud', { method: 'DELETE' }), {
      success: 'Verbindung getrennt.',
    });
    await loadNextcloud({ force: true });
  });
}

// ---------------------------------------------------------------------------
// Die Fassung des Hubs selbst
// ---------------------------------------------------------------------------

/**
 * Was hier läuft, was neu wäre – und der Knopf, der es holt.
 *
 * Bewusst getrennt von der Firmware der Geräte: Das eine ist die Software,
 * die alles steuert, das andere sind die Geräte, die gesteuert werden. Wer
 * „Update" liest, soll wissen, wovon die Rede ist.
 *
 * Das Änderungsprotokoll steht *vor* dem Knopf, nicht dahinter. Eine
 * Aktualisierung, deren Inhalt man erst danach erfährt, ist eine Zumutung.
 */
function hubVersionCard() {
  const info = store.hubVersion;

  if (!info) {
    return `<h2>Diese Fassung</h2>
      <div class="list"><div class="item"><div>
        <div class="title skeleton-line"></div>
        <div class="sub skeleton-line short"></div>
      </div></div></div>`;
  }

  const badge = info.updateAvailable
    ? '<span class="badge warn">neue Fassung verfügbar</span>'
    : '<span class="badge ok">aktuell</span>';

  const pending = info.pending.length
    ? `<div class="changelog pending">
         <h3>Was die Aktualisierung bringt</h3>
         ${info.pending.map(changelogEntry).join('')}
       </div>`
    : '';

  const current = info.current
    ? `<details data-section="changelog-current">
         <summary>Was in ${esc(info.currentVersion)} neu war</summary>
         <div class="changelog">${changelogHtml(info.current.body)}</div>
       </details>`
    : '';

  const action = info.updateAvailable
    ? info.canUpdate
      ? '<button class="primary small" id="btn-hub-install">Jetzt aktualisieren</button>'
      : ''
    : '';

  /*
   * Der Hinweis ist zweierlei: eine Erklärung, wenn es nicht geht, und eine
   * Ankündigung, wenn es geht, aber mehr passiert als sonst. „Der Hub holt
   * sich erst eine Arbeitskopie" gehört vor den Klick, nicht danach.
   */
  const note =
    info.reason && (info.updateAvailable || !info.canUpdate)
      ? `<div class="callout ${info.canUpdate ? '' : 'warn'}">
           <strong>${
             info.canUpdate
               ? 'Beim ersten Mal dauert es etwas länger'
               : 'Der Hub kann sich hier nicht selbst aktualisieren'
           }</strong>
           <span>${esc(info.reason)}</span>
         </div>`
      : '';

  /*
   * Die Warnung, die einen halben Tag gekostet hat.
   *
   * Der Hub aktualisiert auf den eingestellten Zweig. Steht dort ein anderer
   * als der, auf dem die Arbeitskopie liegt, ist das kein Update, sondern ein
   * Zweigwechsel – und wenn der andere Zweig älter ist, sieht es hinterher
   * aus, als sei alles verschwunden. Genau das passiert stillschweigend, wenn
   * jemand seinen Hub von einem Entwicklungszweig aufsetzt und `HUB_BRANCH`
   * nicht kennt.
   */
  const branchWarning =
    info.branch && info.updateBranch && info.branch !== info.updateBranch
      ? `<div class="callout warn">
           <strong>Das Aktualisieren würde den Zweig wechseln</strong>
           <span>
             Der Hub läuft auf <code>${esc(info.branch)}</code>, gezogen würde aber
             <code>${esc(info.updateBranch)}</code>. Ist dort ein älterer Stand, verschwindet
             hinterher alles, was es nur auf deinem Zweig gibt. Setze
             <code>HUB_BRANCH=${esc(info.branch)}</code>, wenn du auf diesem Zweig bleiben willst.
           </span>
         </div>`
      : '';

  return `<h2>Diese Fassung ${badge}</h2>
    ${branchWarning}
    <div class="list">
      <div class="item">
        <div>
          <div class="title">Hub ${esc(info.currentVersion)}${
            info.updateAvailable ? ` → ${esc(info.latestVersion)}` : ''
          }</div>
          <div class="sub">
            Node ${esc(store.systemInfo?.node ?? '–')} ·
            Oberfläche ${esc(store.systemInfo?.build ?? 'unbekannt')} ·
            ${info.branch ? `Zweig <code>${esc(info.branch)}</code>` : 'keine Arbeitskopie'}${
              info.commit ? ` (${esc(info.commit)})` : ''
            } ·
            ${info.checkedAt ? `geprüft ${esc(fmt.relative(info.checkedAt))}` : 'noch nicht geprüft'}
          </div>
        </div>
        <div class="row tight">
          ${action}
          <button class="small" id="btn-hub-check">Nach neuer Fassung sehen</button>
        </div>
      </div>
    </div>

    ${pending}
    ${note}
    ${current}

    <details data-section="changelog-all">
      <summary>Alle bisherigen Änderungen</summary>
      <div class="changelog" id="changelog-all">
        <p class="muted small">Wird geladen …</p>
      </div>
    </details>

    <hr class="divider" />
    <p class="muted small">
      Die <strong>Oberfläche</strong> aktualisiert sich getrennt davon: Sie merkt selbst,
      wenn der Hub eine neuere Fassung ausliefert, und lädt sich nach – meist unbemerkt,
      während sie im Hintergrund liegt.
    </p>
    <button class="ghost small" id="btn-reload-ui">Oberfläche jetzt neu laden</button>`;
}

function changelogEntry(entry) {
  return `<article class="changelog-entry">
    <h4>${esc(entry.version)}${entry.date ? ` <span class="muted small">${esc(entry.date)}</span>` : ''}</h4>
    ${changelogHtml(entry.body)}
  </article>`;
}

/** Holt Fassung und Protokoll und zeichnet nur diese eine Karte neu. */
async function loadHubVersion({ force = false } = {}) {
  if (!store.hubVersion || force) {
    const info = await guard(() => api('/system/version'));
    if (info) store.hubVersion = info;
  }
  renderHubVersionCard();
}

function renderHubVersionCard() {
  const card = $('#card-hub-version');
  if (!card) return;
  card.innerHTML = hubVersionCard();
  wireHubVersion(card);
  restoreOpenSections(card);
}

function wireHubVersion(card) {
  card.querySelector('#btn-hub-check')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    const info = await guard(() => api('/system/version/check', { method: 'POST' }));
    event.target.disabled = false;
    if (!info) return;
    store.hubVersion = info;
    renderHubVersionCard();
    toast(
      info.updateAvailable
        ? `Fassung ${info.latestVersion} steht bereit.`
        : 'Der Hub ist auf dem neuesten Stand.',
      { kind: info.updateAvailable ? 'info' : 'success' },
    );
  });

  card.querySelector('#btn-hub-install')?.addEventListener('click', async (event) => {
    const bootstrap = store.hubVersion?.mode === 'bootstrap';
    if (
      !confirm(
        (bootstrap
          ? 'Der Hub holt sich zuerst den Quelltext und legt danach die neue Fassung an. ' +
            'Datenbank, Messwerte und Einstellungen bleiben dabei unangetastet.\n\n'
          : '') +
          'Er lädt die neue Fassung und baut sie. Das dauert ein paar Minuten; ' +
          'danach muss der Dienst neu gestartet werden. Fortfahren?',
      )
    ) {
      return;
    }
    event.target.disabled = true;
    event.target.textContent = 'Wird aktualisiert …';
    const result = await guard(() => api('/system/version/install', { method: 'POST' }));
    event.target.disabled = false;
    event.target.textContent = 'Jetzt aktualisieren';
    if (!result) return;
    toast('Die neue Fassung liegt bereit.', {
      kind: 'success',
      hint: 'Sie läuft, sobald der Dienst neu gestartet wurde.',
      timeout: 12_000,
    });
    await loadHubVersion({ force: true });
  });

  card.querySelector('#btn-reload-ui')?.addEventListener('click', () => {
    void applyUpdate({ silent: false });
  });

  // Das vollständige Protokoll erst holen, wenn jemand danach fragt.
  card.querySelector('details[data-section="changelog-all"]')?.addEventListener(
    'toggle',
    async (event) => {
      if (!event.target.open) return;
      const target = card.querySelector('#changelog-all');
      if (!target || target.dataset.loaded) return;
      const result = await guard(() => api('/system/changelog'));
      if (!result) return;
      target.dataset.loaded = 'yes';
      target.innerHTML =
        result.entries.map(changelogEntry).join('') ||
        '<p class="muted small">Kein Änderungsprotokoll gefunden.</p>';
    },
  );
}

/**
 * Vorschläge für den Abfragetakt.
 *
 * Die Zahlen sind nicht beliebig: Unter drei Sekunden fangen ältere Bridges
 * an zu klemmen, über fünf Minuten wirkt die Oberfläche tot. Dazwischen ist
 * es Geschmackssache – deshalb ein paar Vorschläge und ein Feld für alles
 * andere.
 */
const POLL_PRESETS = [
  { seconds: 5, label: '5 s – sehr flott' },
  { seconds: 15, label: '15 s – Standard' },
  { seconds: 30, label: '30 s – sparsam' },
  { seconds: 60, label: '1 min – sehr sparsam' },
];

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

/**
 * Eine Integration in den Einstellungen.
 *
 * Unter dem Eintrag hängen zwei Dinge, die man selten braucht und dann sehr:
 * das erneute Verbinden (neue Zugangsdaten, neuer Knopfdruck an der Bridge)
 * und die Diagnose – die Antwort auf „wo ist mein Rollladen?“.
 */
function integrationItem(integration) {
  const id = esc(integration.id);
  return `<div class="item-block">
    <div class="item">
      <div>
        <div class="title">${esc(integration.name)}
          ${
            integration.status === 'linked'
              ? '<span class="badge ok">verbunden</span>'
              : `<span class="badge error">${esc(integration.status)}</span>`
          }
        </div>
        <div class="sub">${esc(VENDOR_LABEL[integration.type] ?? integration.type)} ·
          ${esc(integration.config.host)} · ${esc(plural(integration.deviceCount, 'Gerät', 'Geräte'))}</div>
        ${integration.lastError ? `<div class="sub">${esc(integration.lastError)}</div>` : ''}
      </div>
      <div class="row tight">
        <button class="small" data-sync="${id}">Synchronisieren</button>
        <button class="small" data-test="${id}">Testen</button>
        <button class="small danger" data-remove-integration="${id}">Entfernen</button>
      </div>
    </div>

    <details data-section="integration-${id}" class="sub-details">
      <summary>Erneut verbinden und nachsehen, was fehlt</summary>

      <p class="muted small">
        ${
          integration.type === 'hue'
            ? 'Wenn die Bridge den Hub vergessen hat: den runden Knopf drücken und hier ' +
              'innerhalb von 30 Sekunden „Erneut verbinden“ wählen. Geräte, Räume, Szenen ' +
              'und Automationen bleiben erhalten.'
            : 'Passwort geändert oder das Gerät hat eine neue Adresse? Hier eintragen. ' +
              'Geräte, Räume, Szenen und Automationen bleiben erhalten.'
        }
      </p>
      <form class="form" data-relink="${id}">
        <div class="field-row">
          <label>Adresse
            <input name="host" value="${esc(integration.config.host)}" maxlength="255" />
          </label>
          ${
            integration.type === 'hue'
              ? ''
              : `<label>Benutzername
                   <input name="username" maxlength="64" autocomplete="off"
                          placeholder="${integration.type === 'shelly' ? 'admin' : 'Admin'}" />
                 </label>
                 <label>Passwort
                   <input name="password" type="password" maxlength="128" autocomplete="off"
                          placeholder="unverändert lassen: leer" />
                 </label>`
          }
        </div>
        <button type="submit" class="primary small">Erneut verbinden</button>
      </form>

      <h3>Wo ist mein Gerät?</h3>
      <p class="muted small">
        Alles, was der Hub bei dieser Verbindung gesehen hat – auch das, was er
        übersprungen hat, und warum.
      </p>
      <button class="small" data-diagnose="${id}">Nachsehen</button>
      <div class="list" data-diagnostics="${id}"></div>
    </details>
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

  const pollForm = panel.querySelector('#form-polling');
  const pollField = pollForm?.querySelector('[name="pollIntervalSeconds"]');
  pollForm?.querySelectorAll('[data-poll]').forEach((chip) => {
    chip.addEventListener('click', () => {
      pollField.value = chip.dataset.poll;
      pollForm.querySelectorAll('[data-poll]').forEach((other) => {
        other.classList.toggle('active', other === chip);
      });
    });
  });
  pollForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const seconds = Number(pollField.value);
    const updated = await guard(
      () =>
        api('/household', { method: 'PATCH', body: { pollIntervalSeconds: seconds } }),
      {
        success: `Der Hub sieht jetzt alle ${seconds} Sekunden nach.`,
        successHint: 'Der neue Takt gilt sofort – kein Neustart nötig.',
      },
    );
    if (!updated) return;
    store.household = updated;
    void renderSettings();
  });

  panel.querySelector('#form-fritzbox')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = String(new FormData(event.target).get('fritzboxUrl') ?? '').trim();
    const updated = await guard(
      () => api('/household', { method: 'PATCH', body: { fritzboxUrl: value } }),
      { success: value ? 'Adresse gespeichert.' : 'Ansicht ausgeblendet.' },
    );
    if (!updated) return;
    store.household = updated;
    void renderSettings();
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

  wireBackup(panel);
  // Ein halb durchlaufener Löschvorgang soll ein Neuzeichnen nicht überleben.
  dangerStep = 0;
  renderDangerZone();

  panel.querySelectorAll('[data-relink]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      // Leere Felder heißen „lass es, wie es ist“ – ein leeres Passwort wäre
      // sonst eine stille Löschung der hinterlegten Zugangsdaten.
      const body = {};
      for (const key of ['host', 'username', 'password']) {
        const value = String(data.get(key) ?? '').trim();
        if (value) body[key] = value;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      const result = await guard(() =>
        api(`/integrations/${form.dataset.relink}/relink`, { method: 'POST', body }),
      );
      button.disabled = false;
      if (!result) return;
      toast('Verbindung steht wieder.', {
        kind: 'success',
        hint: `${result.sync.added} neu, ${result.sync.updated} aktualisiert.`,
      });
      await loadDashboardData();
      void renderSettings();
    });
  });

  panel.querySelectorAll('[data-diagnose]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.diagnose;
      const target = panel.querySelector(`[data-diagnostics="${id}"]`);
      button.disabled = true;
      const report = await guard(() => api(`/integrations/${id}/diagnostics`));
      button.disabled = false;
      if (!report || !target) return;
      target.innerHTML = diagnosticsReport(report);
      wireCapabilityFix(target);
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

  panel.querySelector('#form-token')?.addEventListener('submit', async (event) => {
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
    ?.addEventListener('change', (event) => void change({ reduceMotion: event.target.checked }));

  panel
    .querySelector('#live-preview')
    ?.addEventListener('change', (event) => void change({ livePreview: event.target.checked }));

  panel.querySelector('#btn-appearance-reset').addEventListener('click', () =>
    void change({
      fontScale: 1,
      accentColor: null,
      accentColorAlt: null,
      theme: 'auto',
      reduceMotion: false,
      livePreview: true,
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
