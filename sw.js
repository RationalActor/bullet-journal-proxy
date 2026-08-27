// sw.js — caches the app shell so the app opens instantly with no connection.
// Anything that isn't part of the app shell (in particular, calls to /api/...)
// is passed straight through to the network, never cached — sync should
// always hit the real server, never a stale cached response.

const CACHE_NAME = 'bullet-journal-v24';
const SHELL_FILES = [
  './',
  './index.html',
  './liz.html',
  './style.css',
  './app.js',
  './manifest.json',
  './liz-manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never intercept anything other than simple GETs for our own shell —
  // API sync calls (POST/PUT/GET to /api/...) always go straight to network.
  if (request.method !== 'GET' || request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => cached);
    })
  );
});
