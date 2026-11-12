const CACHE = 'eudi-shell-v7';
const SHELL = [
  '/', '/index.html', '/wallet.html', '/kiosk.html', '/admin.html',
  '/styles.css', '/index.js', '/wallet.js', '/kiosk.js', '/admin.js',
  '/lib/ui.js', '/lib/management.js', '/lib/texts.js', '/lib/sdjwt.js', '/lib/protocol.js', '/lib/credential-status.js', '/manifest.webmanifest',
  '/icons/wallet.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('eudi-shell-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls, cross-origin traffic or arbitrary user data.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.pathname;
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        await cache.put(key, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
