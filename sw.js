// Folio EPUB Reader — Service Worker v2.0
// Strategies: Cache-first for assets, Network-first for dynamic content

const CACHE_NAME = 'folio-v2.0.0';
// Injected at build time by vite-plugin-pwa (hashed JS/CSS/HTML assets)
const BASE = new URL('./', self.location).pathname; // '/' or '/epub/'
const PRECACHE = (self.__WB_MANIFEST || []).map((e) => BASE + String(e.url).replace(/^\//, ''));
const STATIC_ASSETS = [BASE, BASE + 'manifest.json', ...PRECACHE];

const FONT_CACHE = 'folio-fonts-v1';
const BOOK_CACHE = 'folio-books-v1';

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== FONT_CACHE && k !== BOOK_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch Strategy ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Google Fonts — cache first
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Same-origin static assets — cache first, then network
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // Default — network only
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

// ─── Background Sync ──────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-annotations') {
    event.waitUntil(syncAnnotations());
  }
  if (event.tag === 'sync-progress') {
    event.waitUntil(syncReadingProgress());
  }
});

async function syncAnnotations() {
  // Cloud sync stub — wire up your backend here
  const clients = await self.clients.matchAll();
  clients.forEach((client) => client.postMessage({ type: 'SYNC_COMPLETE', payload: 'annotations' }));
}

async function syncReadingProgress() {
  const clients = await self.clients.matchAll();
  clients.forEach((client) => client.postMessage({ type: 'SYNC_COMPLETE', payload: 'progress' }));
}

// ─── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  const title = data.title ?? 'Folio';
  const options = {
    body: data.body ?? 'Continue your reading session.',
    icon: BASE + 'icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag ?? 'folio-reminder',
    data: data.url ?? BASE,
    actions: [
      { action: 'open', title: 'Open Folio' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(event.notification.data);
    })
  );
});

// ─── Message Handler ──────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CACHE_EPUB') {
    const { url, id } = event.data;
    caches.open(BOOK_CACHE).then(async (cache) => {
      try {
        const response = await fetch(url);
        await cache.put(`epub:${id}`, response);
        event.source?.postMessage({ type: 'EPUB_CACHED', id });
      } catch (err) {
        event.source?.postMessage({ type: 'EPUB_CACHE_ERROR', id, error: err.message });
      }
    });
  }
});
