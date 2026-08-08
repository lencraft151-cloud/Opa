/**
 * API-Zugriff und Fehlerdarstellung.
 *
 * Grundsatz: Ein Fehler wird nie verschluckt und nie als roher Statuscode
 * angezeigt. Jede Meldung besteht aus „was ist passiert“ und – wenn der Server
 * einen liefert – „was kannst du tun“.
 */

import { esc } from './format.js';

/**
 * Die Anmeldung reist als HttpOnly-Cookie mit und ist für JavaScript
 * unsichtbar – genau das ist der Punkt. Hier bleibt nur der Fall übrig, dass
 * jemand von außen mit einem Zugriffstoken arbeitet (Skripte, andere
 * Programme); der Browser braucht keines mehr.
 */
const TOKEN_KEY = 'smarthome.token';

export const auth = {
  /** Nur noch für Programme, die kein Cookie setzen können. */
  get token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },
  set token(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

/** Wird gerufen, wenn der Hub eine Anmeldung verlangt. */
let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(message, { code, status, hint, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code ?? 'unknown';
    this.status = status ?? 0;
    this.hint = hint ?? '';
    this.details = details;
  }

  /** Fehler, bei denen ein erneuter Versuch sinnvoll ist. */
  get retryable() {
    return ['upstream_error', 'timeout', 'network', 'internal_error'].includes(this.code);
  }
}

export async function api(path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (auth.token) headers['authorization'] = `Bearer ${auth.token}`;

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      // Ohne Cookie keine Anmeldung – auch beim Neuladen der Seite.
      credentials: 'same-origin',
      cache: options.cache,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Der Hub ist gerade nicht erreichbar.', {
      code: 'network',
      hint: 'Prüfe deine Verbindung. Läuft der Hub noch? Die Seite versucht es automatisch weiter.',
    });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = data?.error ?? {};
    // Eine abgelaufene Anmeldung ist kein Fehler, den der Nutzer beheben
    // kann – sie führt zurück zur Anmeldemaske.
    if (response.status === 401 && !options.silent401) onUnauthorized?.();

    throw new ApiError(error.message || `Der Hub hat mit HTTP ${response.status} geantwortet.`, {
      code: error.code,
      status: response.status,
      hint: error.hint,
      details: error.details,
    });
  }

  return data;
}

// ---------------------------------------------------------------------------
// Rückmeldungen an den Nutzer
// ---------------------------------------------------------------------------

let toastHost = null;

function host() {
  toastHost ??= document.getElementById('toasts');
  return toastHost;
}

export function toast(message, { kind = 'info', hint = '', timeout = 6000 } = {}) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML =
    `<div class="toast-title">${esc(message)}</div>` +
    (hint ? `<div class="toast-hint">${esc(hint)}</div>` : '');
  host().append(node);

  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return node;
}

export function showError(err) {
  if (err?.name === 'AbortError') return;
  const isWarning = err instanceof ApiError && err.code === 'link_button_required';
  toast(err?.message ?? 'Unbekannter Fehler', {
    kind: isWarning ? 'warn' : 'error',
    hint: err instanceof ApiError ? err.hint : '',
    timeout: isWarning ? 9000 : 8000,
  });
}

/**
 * Führt eine Aktion aus und meldet Fehler verständlich.
 * Gibt `null` zurück, wenn es schiefging – Aufrufer prüfen darauf.
 */
export async function guard(fn, { success, successHint } = {}) {
  try {
    const result = await fn();
    if (success) toast(success, { kind: 'success', hint: successHint ?? '', timeout: 4000 });
    return result;
  } catch (err) {
    showError(err);
    return null;
  }
}

/**
 * Fehlerbanner mit konkreter Handlungsoption – für dauerhafte Probleme,
 * die ein Toast zu schnell wieder wegnimmt.
 */
export function errorBanner({ title, hint, actionLabel, onAction, kind = 'error' }) {
  const node = document.createElement('div');
  node.className = `callout ${kind}`;
  node.innerHTML =
    `<strong>${esc(title)}</strong>` +
    (hint ? `<span>${esc(hint)}</span>` : '') +
    (actionLabel ? `<div class="callout-actions"><button class="small">${esc(actionLabel)}</button></div>` : '');
  if (actionLabel && onAction) {
    node.querySelector('button').addEventListener('click', onAction);
  }
  return node;
}
