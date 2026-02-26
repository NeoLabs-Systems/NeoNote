/**
 * NeoNote — Service Worker
 * Provides offline-first caching for the app shell.
 */

const CACHE_NAME = 'neonote-v1';
const SHELL_ASSETS = [
  '/app',
  '/login',
  '/js/app.js',
  '/js/canvas.js',
  '/css/app.css',
  '/icon.svg',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
];

/* ── Install: pre-cache app shell ─────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL_ASSETS).catch(err => console.warn('[SW] Pre-cache partial failure:', err))
    ).then(() => self.skipWaiting())
  );
});

/* ── Activate: remove old caches ──────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: shell = cache-first, API = network-first ──────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Skip non-GET and API calls (don't cache strokes etc.) */
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  /* For navigations: network first, fall back to cached /app */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match('/app'))
    );
    return;
  }

  /* Static assets: cache first */
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
