const CACHE = 'timeclock-v1';
const STATIC = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

// Install: cache static shell
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {})));
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network first, fall back to cache
// API calls always go to network — never serve stale clock data
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network for API and external requests
  if (url.pathname.startsWith('/api/') || url.origin !== location.origin) {
    return; // let it pass through normally
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache fresh copy of static assets
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
