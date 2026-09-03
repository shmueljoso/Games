/* Service worker: המשחק כולו נשמר במטמון כדי שירוץ גם בלי רשת. */
const CACHE = 'color-loop-v1';
const ASSETS = ['./', './index.html', './engine.js', './levels.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-180.png', './icon-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* גופנים חיצוניים: מהרשת, ואם אין — מהמטמון */
  if (url.origin !== self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  /* קבצי המשחק: מהמטמון קודם, ורענון ברקע */
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
