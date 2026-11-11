'use strict';
// Service worker: оболочка приложения работает быстро и открывается без сети,
// картинки скинов кэшируются. API и вход НЕ кэшируются — баланс и игры всегда с сервера.
const SHELL = 'grum-shell-v2';
const IMG = 'grum-img-v1';
const SHELL_FILES = ['/', '/app.js', '/manifest.webmanifest', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png'];
const IMG_LIMIT = 400;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimImages() {
  const c = await caches.open(IMG);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - IMG_LIMIT; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // картинки скинов из Steam CDN: сначала кэш
  if (/steamstatic\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimImages(); }
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  // своя статика: сначала сеть (чтобы обновления приходили сразу), без сети — кэш
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req.mode === 'navigate' ? '/' : req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req)) || caches.match('/')));
});
