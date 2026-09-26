// Offline support: network-first for everything in the viewer folder, falling
// back to the last cached copy when there's no connection. Always fresh when
// online (so edits and regenerated model data show up immediately), and the
// whole app - model included - keeps working in a shop with no signal once
// it's been opened once.
const CACHE = 'woodmodels-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      // keep the worker alive until the copy is stored (scene.obj is large)
      if (res.ok) e.waitUntil(cache.put(req, res.clone()));
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
