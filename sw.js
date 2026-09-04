// sw.js — caches the app shell so the app opens instantly with no connection.
// Shell requests are stale-while-revalidate: the cached copy is served right
// away while the network copy is fetched and cached for the next load, so
// shipping a new app.js doesn't need a CACHE_NAME bump to reach people.
// Anything that isn't part of the app shell (in particular, calls to /api/...)
// is passed straight through to the network, never cached — sync should
// always hit the real server, never a stale cached response.

const CACHE_NAME = 'bullet-journal-v28';
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
  './apple-touch-icon.png',
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

  // Stale-while-revalidate: ask the network every time and store whatever
  // comes back, so a cached page is served instantly now and the *next* load
  // picks up the new file with no CACHE_NAME bump needed.
  let cacheWrite = null;
  const fetched = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        // Clone before anyone reads the body, then write in the background —
        // the page never waits on the cache.
        const copy = response.clone();
        // A failed write (an odd URL scheme, say) must not break the response.
        cacheWrite = caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(request, copy))
          .catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  // Keep the worker alive until the round trip and the cache write finish,
  // even though we usually answered from the cache long before.
  event.waitUntil(fetched.then(() => cacheWrite));

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      // Nothing cached, so the network is all we have. If it failed too, hand
      // back a real error response — returning undefined would throw.
      return fetched.then((response) => response || Response.error());
    })
  );
});
