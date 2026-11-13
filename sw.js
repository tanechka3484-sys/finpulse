/**
 * FinPulse — service worker для установки сайта как приложения.
 *
 * Стратегия «сначала сеть»: файлы сайта всегда берутся свежие с сервера, а их копия
 * сохраняется в кэш. Если сети нет, приложение откроется из кэша (с последними
 * загруженными страницами, без новых котировок). Данные бирж, /api и чужие сайты
 * не кэшируются никогда — котировки всегда живые.
 */
const CACHE = 'finpulse-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Только свои файлы и только GET; /api и данные бирж — всегда напрямую в сеть
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
