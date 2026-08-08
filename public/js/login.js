/**
 * Anmeldung.
 *
 * Der Sitzungsschlüssel liegt als HttpOnly-Cookie im Browser; diese Datei
 * bekommt ihn nie zu sehen. Sie kennt nur zwei Zustände: angemeldet oder
 * nicht.
 */

import { api, errorBanner, showError } from './api.js';

const $ = (selector) => document.querySelector(selector);

let onSignedIn = () => {};
let wired = false;

/**
 * Zeigt die Anmeldemaske.
 * @param {() => void} signedInCallback Wird nach erfolgreicher Anmeldung gerufen.
 * @param {{ reason?: string }} options
 */
export function showLogin(signedInCallback, options = {}) {
  onSignedIn = signedInCallback;

  for (const id of ['view-setup', 'view-app']) $(`#${id}`)?.classList.add('hidden');
  $('#view-login').classList.remove('hidden');

  const banner = $('#login-banner');
  banner.innerHTML = '';
  if (options.reason) {
    banner.append(errorBanner({ title: options.reason, kind: 'info' }));
  }

  wire();
  // Auf dem Handy den Fokus nicht erzwingen – sonst springt die Tastatur auf.
  if (window.matchMedia('(min-width: 720px)').matches) {
    $('#form-login').querySelector('[name="username"]').focus();
  }
}

export function hideLogin() {
  $('#view-login').classList.add('hidden');
}

function wire() {
  if (wired) return;
  wired = true;

  $('#form-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const button = form.querySelector('button[type="submit"]');

    button.disabled = true;
    button.textContent = 'Melde an…';
    try {
      await api('/auth/login', {
        method: 'POST',
        body: {
          username: String(data.get('username')).trim(),
          password: String(data.get('password')),
        },
        // Ein falsches Passwort führt nicht zurück zur Anmeldemaske –
        // wir sind schon dort.
        silent401: true,
      });
      form.reset();
      hideLogin();
      onSignedIn();
    } catch (err) {
      showError(err);
      form.querySelector('[name="password"]').value = '';
      form.querySelector('[name="password"]').focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Anmelden';
    }
  });
}

/**
 * Nachrüstung: Ein Hub aus einer früheren Fassung hat einen Haushalt, aber
 * noch kein Konto. Das alte Zugriffstoken liegt in diesem Browser – `api()`
 * sendet es automatisch mit, und der Hub erlaubt damit genau ein erstes
 * Konto. Danach wird das Token nicht mehr gebraucht.
 */
export async function createFirstAccount({ username, password, displayName }) {
  return api('/auth/users', { method: 'POST', body: { username, password, displayName } });
}
