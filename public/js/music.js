/**
 * Der Reiter „Dienste": Sonos, Spotify und Nextcloud.
 *
 * Warum diese drei zusammen und getrennt von den Geräten: Es sind keine
 * Geräte im Sinne des Hubs. Bei einer Lampe gibt es an und aus, eine
 * Helligkeit, eine Farbe – bei einem Lautsprecher gibt es einen Titel, eine
 * Warteschlange und eine Gruppe. Beides in dieselbe Kachelform zu pressen
 * hätte beiden geschadet.
 */

import { api, guard, showError, toast } from './api.js';
import { cardHead, emptyState, help } from './components.js';
import { esc } from './format.js';

const $ = (selector) => document.querySelector(selector);

/** Stand der drei Dienste, wie ihn die Oberfläche gerade zeigt. */
export const music = {
  sonos: null,
  spotify: null,
  /** Läuft gerade eine Suche nach Lautsprechern? */
  searching: false,
};

/** Läuft im Hintergrund, solange der Reiter offen ist. */
let ticker = null;

// ---------------------------------------------------------------------------
// Laden und Auffrischen
// ---------------------------------------------------------------------------

export async function loadMusic({ force = false } = {}) {
  const jobs = [];
  if (force || !music.sonos) {
    jobs.push(
      api('/sonos')
        .then((data) => {
          music.sonos = data;
        })
        .catch(() => {
          music.sonos = { players: [], groups: 0 };
        }),
    );
  }
  if (force || !music.spotify) {
    jobs.push(
      api('/spotify')
        .then((data) => {
          music.spotify = data;
        })
        .catch(() => {
          music.spotify = { account: null, playback: null, devices: [], note: null };
        }),
    );
  }
  await Promise.all(jobs);
}

/**
 * Hält den Reiter aktuell, solange er zu sehen ist.
 *
 * Bewusst nur dann: Spotify begrenzt die Zahl der Anfragen, und ein Hub, der
 * rund um die Uhr nach der Wiedergabe fragt, verbraucht dieses Kontingent für
 * einen Bildschirm, auf den niemand schaut.
 */
export function startMusicTicker() {
  stopMusicTicker();
  ticker = setInterval(async () => {
    if (document.hidden) return;
    await loadMusic({ force: true });
    renderMusic();
  }, 5000);
  ticker.unref?.();
}

export function stopMusicTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

/**
 * Zeichnet den offenen Unterreiter.
 *
 * Der Behälter kommt aus `dashboard.js` (dort liegt die Reiterleiste); hier
 * wird nur gefüllt. Ohne Angabe wird gezeichnet, was gerade da ist – das
 * braucht der Fünf-Sekunden-Takt, der nicht wissen muss, welcher Reiter offen
 * ist.
 */
export function renderMusic(which) {
  const sonos = $('#sub-sonos');
  const spotify = $('#sub-spotify');

  if (sonos && which !== 'spotify') renderSonos(sonos);
  if (spotify && which !== 'sonos') renderSpotify(spotify);
}

// ---------------------------------------------------------------------------
// Sonos
// ---------------------------------------------------------------------------

function renderSonos(card) {
  const state = music.sonos;
  const players = state?.players ?? [];

  const head = cardHead(
    'Sonos',
    'Lautsprecher im eigenen Netz. Kein Konto, kein Passwort – der Hub spricht direkt ' +
      'mit ihnen. Gefunden werden sie von allein; sonst hilft die Adresse von Hand.',
    {
      tip:
        'Sind zwei Lautsprecher in der Sonos-App gruppiert, gelten Play und Pause für die ' +
        'ganze Gruppe. Die Lautstärke bleibt bei jedem Lautsprecher einzeln.',
      actions: `<button class="small" id="btn-sonos-search" ${music.searching ? 'disabled' : ''}
          title="Sucht per SSDP im Netz und klopft notfalls Port 1400 ab.">
          ${music.searching ? 'Suche läuft …' : 'Lautsprecher suchen'}
        </button>`,
    },
  );

  if (!state) {
    paintCard(card, `${head}<div class="list"><div class="item"><div>
      <div class="title skeleton-line"></div><div class="sub skeleton-line short"></div>
    </div></div></div>`);
    return;
  }

  const body = players.length
    ? `<div class="music-list">${players.map(playerCard).join('')}</div>`
    : emptyState(
        '🔈',
        'Noch keine Lautsprecher gefunden.',
        'Der Hub sucht per SSDP im eigenen Netz. Kommt dort nichts an – etwa hinter einem ' +
          'Repeater oder im Gastnetz –, kannst du die Adresse des Lautsprechers unten von Hand eintragen.',
      );

  const grouped =
    state.groups > 0
      ? `<p class="muted small">
           ${state.groups === 1 ? 'Eine Gruppe' : `${state.groups} Gruppen`} aktiv. Play und Pause
           gelten für die ganze Gruppe – die Lautstärke bleibt bei jedem Lautsprecher einzeln.
         </p>`
      : '';

  paintCard(
    card,
    `${head}
     ${grouped}
     ${body}
     <details data-section="sonos-manual">
       <summary>Lautsprecher von Hand eintragen</summary>
       <p class="muted small">
         Nur nötig, wenn die Suche nichts findet. Die Adresse steht in der Sonos-App unter
         Einstellungen → System → Produkte → (Lautsprecher) → Netzwerk.
       </p>
       <form id="form-sonos-manual" class="form inline">
         <input name="host" placeholder="192.168.1.42" maxlength="120" required />
         <button type="submit" class="primary">Hinzufügen</button>
       </form>
     </details>`,
  );

  wireSonos(card);
}

function playerCard(player) {
  const state = player.state ?? {};
  const playing = state.transport === 'playing';
  const title = state.title ?? (state.reachable ? 'Nichts ausgewählt' : 'Nicht erreichbar');
  const line2 = [state.artist, state.album].filter(Boolean).join(' · ');

  const group =
    state.groupMembers && state.groupMembers.length > 1
      ? `<span class="badge">mit ${esc(
          state.groupMembers.filter((name) => name !== player.roomName).join(', '),
        )}</span>`
      : '';

  const progress =
    state.durationSeconds && state.positionSeconds !== null
      ? `<div class="music-progress"><span style="width:${Math.min(
          100,
          Math.round((state.positionSeconds / state.durationSeconds) * 100),
        )}%"></span></div>
        <div class="muted small">${esc(clock(state.positionSeconds))} / ${esc(
          clock(state.durationSeconds),
        )}</div>`
      : '';

  return `<article class="music-player ${state.reachable ? '' : 'offline'}" data-player="${esc(player.id)}">
    <div class="music-cover">${
      state.artworkUrl
        ? `<img src="${esc(state.artworkUrl)}" alt="" loading="lazy" />`
        : '<span>🎵</span>'
    }</div>
    <div class="music-info">
      <div class="row between tight">
        <strong>${esc(player.roomName)}</strong>
        ${group}
      </div>
      <div class="music-title">${esc(title)}</div>
      <div class="muted small">${esc(line2 || player.model || 'Sonos')}</div>
      ${progress}
      ${
        state.error
          ? `<div class="muted small">${esc(state.error)}</div>`
          : `<div class="row tight music-controls">
               <button class="small" data-cmd="previous" title="Vorheriger Titel">⏮</button>
               <button class="small primary" data-cmd="${playing ? 'pause' : 'play'}">
                 ${playing ? '⏸ Pause' : '▶ Abspielen'}
               </button>
               <button class="small" data-cmd="next" title="Nächster Titel">⏭</button>
               <input type="range" class="volume" min="0" max="100" step="1"
                      value="${state.volume ?? 0}" data-volume aria-label="Lautstärke"
                      title="Lautstärke dieses Lautsprechers – in einer Gruppe bleiben die anderen unberührt." />
               <span class="muted small volume-value">${state.volume ?? '–'}%</span>
             </div>`
      }
    </div>
  </article>`;
}

function wireSonos(card) {
  card.querySelector('#btn-sonos-search')?.addEventListener('click', () => void searchSonos());

  card.querySelector('#form-sonos-manual')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const host = String(new FormData(event.target).get('host') ?? '').trim();
    if (host) void searchSonos({ host });
  });

  card.querySelectorAll('[data-player]').forEach((node) => {
    const playerId = node.dataset.player;

    node.querySelectorAll('[data-cmd]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await sendSonos(playerId, { type: button.dataset.cmd });
        button.disabled = false;
      });
    });

    const slider = node.querySelector('[data-volume]');
    const readout = node.querySelector('.volume-value');
    if (!slider) return;

    // Beim Ziehen nur die Anzeige mitführen; gesendet wird beim Loslassen.
    slider.addEventListener('input', () => {
      if (readout) readout.textContent = `${slider.value}%`;
    });
    slider.addEventListener('change', async () => {
      await sendSonos(playerId, { type: 'setVolume', volume: Number(slider.value) });
    });
  });
}

async function sendSonos(playerId, command) {
  const state = await guard(() =>
    api(`/sonos/${playerId}/command`, { method: 'POST', body: command }),
  );
  if (!state) return;
  const player = music.sonos?.players.find((entry) => entry.id === playerId);
  if (player) player.state = state;
  renderMusic();
}

async function searchSonos(options = {}) {
  music.searching = true;
  renderMusic();
  try {
    const result = await api('/sonos/discover', {
      method: 'POST',
      body: options.host ? { host: options.host } : {},
    });
    toast(
      result.found === 0
        ? 'Es wurde kein Lautsprecher gefunden.'
        : `${result.found === 1 ? 'Ein Lautsprecher' : `${result.found} Lautsprecher`} gefunden.`,
      { kind: result.found === 0 ? 'warn' : 'success' },
    );
  } catch (err) {
    showError(err);
  } finally {
    music.searching = false;
    await loadMusic({ force: true });
    renderMusic();
  }
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

function renderSpotify(card) {
  const state = music.spotify;
  if (!state) {
    paintCard(
      card,
      '<h2>Spotify</h2><div class="list"><div class="item"><div class="title skeleton-line"></div></div></div>',
    );
    return;
  }

  if (!state.account?.connected) {
    paintCard(card, spotifySetup(state));
    wireSpotify(card);
    return;
  }

  const playback = state.playback;
  const line2 = playback ? [playback.artist, playback.album].filter(Boolean).join(' · ') : '';

  const devices = state.devices ?? [];
  const deviceOptions = devices
    .map(
      (device) =>
        `<option value="${esc(device.id)}" ${device.active ? 'selected' : ''}>${esc(
          device.name,
        )}</option>`,
    )
    .join('');

  paintCard(
    card,
    `<div class="row between">
       <h2 style="margin:0">Spotify <span class="badge ok">verbunden</span> ${help(
         'Steuern (Play, Pause, Lautstärke) erlaubt Spotify nur mit Premium. Anzeigen, was läuft, geht auch ohne.',
       )}</h2>
       <span class="muted small">${esc(state.account.displayName ?? state.account.clientId)}</span>
     </div>

     ${state.note ? `<div class="callout warn"><span>${esc(state.note)}</span></div>` : ''}

     ${
       playback
         ? `<article class="music-player">
              <div class="music-cover">${
                playback.artworkUrl
                  ? `<img src="${esc(playback.artworkUrl)}" alt="" loading="lazy" />`
                  : '<span>🎧</span>'
              }</div>
              <div class="music-info">
                <div class="music-title">${esc(playback.title ?? 'Nichts ausgewählt')}</div>
                <div class="muted small">${esc(line2)}</div>
                ${
                  playback.durationSeconds
                    ? `<div class="music-progress"><span style="width:${Math.min(
                        100,
                        Math.round(
                          ((playback.positionSeconds ?? 0) / playback.durationSeconds) * 100,
                        ),
                      )}%"></span></div>`
                    : ''
                }
                <div class="row tight music-controls">
                  <button class="small" data-spotify="previous">⏮</button>
                  <button class="small primary" data-spotify="${playback.playing ? 'pause' : 'play'}">
                    ${playback.playing ? '⏸ Pause' : '▶ Abspielen'}
                  </button>
                  <button class="small" data-spotify="next">⏭</button>
                  <input type="range" class="volume" min="0" max="100" step="1"
                         value="${playback.volume ?? 0}" data-spotify-volume aria-label="Lautstärke" />
                </div>
                <div class="muted small">Läuft auf: ${esc(playback.deviceName ?? 'unbekannt')}</div>
              </div>
            </article>`
         : emptyState(
             '🎧',
             'Spotify spielt gerade nirgends.',
             'Starte die Wiedergabe einmal auf dem Handy oder am Rechner – danach kann der Hub übernehmen.',
           )
     }

     ${
       devices.length
         ? `<label>Auf welchem Gerät
              <select id="spotify-device">${deviceOptions}</select>
            </label>`
         : ''
     }

     <details data-section="spotify-settings">
       <summary>Verbindung</summary>
       <p class="muted small">
         Angemeldet mit der Client-ID <code>${esc(state.account.clientId)}</code>.
         Der Hub speichert nur die Token, kein Passwort.
       </p>
       <button class="ghost small danger" id="btn-spotify-disconnect">Verbindung trennen</button>
     </details>`,
  );

  wireSpotify(card);
}

function spotifySetup(state) {
  const redirect = `${location.origin}/api/spotify/callback`;
  return `<h2>Spotify</h2>
    <p class="muted small">
      Zeigt an, was gerade läuft, und steuert die Wiedergabe – auf dem Handy, am Rechner
      oder auf einem Lautsprecher, der bei Spotify angemeldet ist.
    </p>
    <div class="callout">
      <strong>Einmalige Einrichtung bei Spotify</strong>
      <span>
        1. Auf <em>developer.spotify.com/dashboard</em> anmelden und „Create app" wählen.<br />
        2. Als <em>Redirect URI</em> genau diese Adresse eintragen:
           <code>${esc(redirect)}</code><br />
        3. Die <em>Client ID</em> von dort hier einsetzen. Ein Client-Geheimnis wird
           <strong>nicht</strong> gebraucht – der Hub meldet sich mit PKCE an.
      </span>
    </div>
    ${
      state.account?.lastError
        ? `<div class="callout warn"><strong>Letzter Versuch ging schief</strong><span>${esc(
            state.account.lastError,
          )}</span></div>`
        : ''
    }
    <form id="form-spotify" class="form">
      <label>Client-ID
        <input name="clientId" maxlength="200" autocomplete="off" required
               value="${esc(state.account?.clientId ?? '')}" />
      </label>
      <label>Rückleitungsadresse
        <input name="redirectUri" maxlength="300" value="${esc(
          state.account?.redirectUri ?? redirect,
        )}" required />
      </label>
      <button type="submit" class="primary">Mit Spotify verbinden</button>
    </form>
    <p class="muted small">
      Steuern (Play, Pause, Lautstärke) erlaubt Spotify nur mit Premium. Anzeigen,
      was läuft, geht auch ohne.
    </p>`;
}

function wireSpotify(card) {
  card.querySelector('#form-spotify')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const result = await guard(() =>
      api('/spotify/authorize', {
        method: 'POST',
        body: {
          clientId: String(form.get('clientId')).trim(),
          redirectUri: String(form.get('redirectUri')).trim(),
        },
      }),
    );
    if (!result) return;
    /*
     * Der Umweg über Spotify muss im selben Fenster passieren: Ein neuer Tab
     * wird von Handy-Browsern häufig blockiert, und die Rückleitung führt
     * ohnehin wieder hierher.
     */
    toast('Weiter geht es bei Spotify …', { kind: 'info', timeout: 3000 });
    location.href = result.authorizeUrl;
  });

  card.querySelectorAll('[data-spotify]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await guard(() =>
        api('/spotify/command', { method: 'POST', body: { type: button.dataset.spotify } }),
      );
      button.disabled = false;
      if (!result) return;
      if (music.spotify) music.spotify.playback = result.playback;
      renderMusic();
    });
  });

  const volume = card.querySelector('[data-spotify-volume]');
  volume?.addEventListener('change', async () => {
    await guard(() =>
      api('/spotify/command', {
        method: 'POST',
        body: { type: 'setVolume', volume: Number(volume.value) },
      }),
    );
  });

  card.querySelector('#spotify-device')?.addEventListener('change', async (event) => {
    const result = await guard(
      () =>
        api('/spotify/transfer', {
          method: 'POST',
          body: { deviceId: event.target.value, play: true },
        }),
      { success: 'Wiedergabe umgezogen.' },
    );
    if (!result) return;
    if (music.spotify) music.spotify.playback = result.playback;
    renderMusic();
  });

  card.querySelector('#btn-spotify-disconnect')?.addEventListener('click', async () => {
    if (!confirm('Verbindung zu Spotify trennen? Die gespeicherten Token werden gelöscht.')) return;
    await guard(() => api('/spotify', { method: 'DELETE' }), { success: 'Verbindung getrennt.' });
    await loadMusic({ force: true });
    renderMusic();
  });
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

/**
 * Schreibt nur, wenn sich etwas geändert hat – und verdrahtet nur dann neu.
 *
 * Der Reiter frischt sich alle fünf Sekunden auf. Ohne diesen Vergleich
 * würde dabei jedes Mal das Titelbild neu geladen (es flackert) und ein
 * gerade gezogener Lautstärkeregler spränge zurück.
 */
const lastCard = new WeakMap();

function paintCard(card, html) {
  if (!card) return false;
  if (lastCard.get(card) === html) return false;
  // Einen Regler, den gerade jemand in der Hand hat, nicht wegziehen.
  const active = document.activeElement;
  if (active && card.contains(active) && active.matches('input[type="range"]')) return false;
  card.innerHTML = html;
  lastCard.set(card, html);
  return true;
}

function clock(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '–';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
