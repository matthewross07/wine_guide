// Offline support for the cellar (basements rarely have signal).
// Same-origin GETs are network-first with a short timeout, falling back to the
// last cached copy. Cross-origin requests (map tiles, weather, the Apps Script)
// are left alone.

const CACHE = 'cellar-book-v1';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/storage.js',
  'js/config.js',
  'data/wines.json',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cellar-book-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3500));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch {}
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || network;
  })());
});
