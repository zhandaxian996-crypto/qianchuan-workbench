const CACHE_NAME = 'qianchuan-v4-v2';
const ASSETS = [
  '/v4',
  '/v4/v4.css',
  '/v4/shared.js',
  '/v4/v4.js',
  '/icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // 只缓存前端静态资源，不缓存 /api 数据接口
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/compass_api')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((response) => {
      // 优先走网络，网络失败（离线）走缓存
      return fetch(event.request).then(netRes => {
        if (netRes && netRes.status === 200) {
          const resClone = netRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        }
        return netRes;
      }).catch(() => response);
    })
  );
});