/**
 * Service Worker.
 *
 * Aufgabe ist ausschließlich die App-Hülle: HTML, CSS und JavaScript werden
 * zwischengespeichert, damit sich der Hub auf dem Handy wie eine installierte
 * App öffnet – auch wenn das WLAN gerade hakt.
 *
 * Gerätedaten werden bewusst NICHT zwischengespeichert. Ein veralteter
 * Schaltzustand wäre schlimmer als eine ehrliche Fehlermeldung.
 */

const CACHE = 'smarthome-shell-v4';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/app.js',
  '/js/api.js',
  '/js/appearance.js',
  '/js/dashboard.js',
  '/js/setup.js',
  '/js/components.js',
  '/js/charts.js',
  '/js/colorwheel.js',
  '/js/format.js',
  '/js/icons.js',
  '/js/integrations.js',
  '/js/selfupdate.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API und Ereignisstrom immer direkt vom Hub – niemals aus dem Cache.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      // Im Hintergrund auffrischen, damit nach einem Update die neue Version
      // spätestens beim übernächsten Start aktiv ist.
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? caches.match('/index.html'));

      return cached ?? network;
    }),
  );
});
