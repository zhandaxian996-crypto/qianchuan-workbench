const CACHE_NAME = 'qianchuan-v4-v7';
const ASSETS = [
  '/v4',
  '/v4/v4.css',
  '/v4/shared.js',
  '/v4/v4.js',
  '/v4/account-ui-fixes.js',
  '/v4/cozy-theme.css',
  '/v4/demo-mode.css',
  '/v4/cozy-v2.css',
  '/v4/cozy-v3.css',
  '/v4/cozy-v4.css',
  '/v4/cozy-v5.css?v=5',
  '/v4/cozy-theme.js',
  '/v4/demo-mode.js',
  '/v4/cozy-v3.js',
  '/v4/cozy-v4.js',
  '/v4/assets/cozy-day.svg',
  '/v4/assets/cozy-night.svg',
  '/v4/assets/cozy-hero-day.svg',
  '/v4/assets/cozy-hero-night.svg',
  '/v4/assets/cozy-side.svg',
  '/v4/assets/cozy-side-night.svg',
  '/v4/assets/cozy-strip.svg',
  '/v4/assets/cozy-strip-night.svg',
  '/icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/compass_api')) return;

  event.respondWith(
    fetch(event.request).then(netRes => {
      if (netRes && netRes.status === 200) {
        const resClone = netRes.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
      }
      return netRes;
    }).catch(() => caches.match(event.request))
  );
});
