// Service worker: приложение работает офлайн. При выпуске новой версии увеличьте VERSION.
const VERSION = 'familysplit-v2.0.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/i18n.js',
  './js/model.js',
  './js/calc.js',
  './js/store.js',
  './js/sync.js',
  './js/config.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  "./fonts/inter-cyrillic-400-normal.woff2",
  "./fonts/inter-cyrillic-600-normal.woff2",
  "./fonts/inter-cyrillic-700-normal.woff2",
  "./fonts/inter-cyrillic-800-normal.woff2",
  "./fonts/inter-cyrillic-ext-400-normal.woff2",
  "./fonts/inter-cyrillic-ext-600-normal.woff2",
  "./fonts/inter-cyrillic-ext-700-normal.woff2",
  "./fonts/inter-cyrillic-ext-800-normal.woff2",
  "./fonts/inter-latin-400-normal.woff2",
  "./fonts/inter-latin-600-normal.woff2",
  "./fonts/inter-latin-700-normal.woff2",
  "./fonts/inter-latin-800-normal.woff2",
  "./fonts/unbounded-cyrillic-700-normal.woff2",
  "./fonts/unbounded-cyrillic-900-normal.woff2",
  "./fonts/unbounded-cyrillic-ext-700-normal.woff2",
  "./fonts/unbounded-cyrillic-ext-900-normal.woff2",
  "./fonts/unbounded-latin-700-normal.woff2",
  "./fonts/unbounded-latin-900-normal.woff2"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Свои файлы: сначала кэш, параллельно обновляем из сети (stale-while-revalidate).
// Чужие запросы (Supabase, курсы валют) не трогаем.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached || cache.match('./index.html'));
      return cached || network;
    })
  );
});
