// Minimal service worker: makes the app installable and opens it offline with the last good page.
// Bump CACHE to drop everything cached by an older version.
const CACHE = 'pt-app-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only same-origin reads. Supabase lives on another origin, so API calls are never cached.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network first: bookings and credits must be fresh. Offline, serve the last page that loaded.
    // One shell per origin; the query is kept because the shared demo origin picks the trainer with ?t=.
    const key = `/${url.search}`;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
          }
          return res;
        })
        .catch(() => caches.match(key).then((hit) => hit || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Cache first: Vite puts a content hash in every file name, so a cached copy never goes stale.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
            }
            return res;
          }),
      ),
    );
  }
});
