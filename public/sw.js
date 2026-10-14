/* قعدة محبة: يحفظ ملفات الصفحة حتى تفتح بسرعة وتعمل التجربة الفردية دون إنترنت */
const V = 'mahabba-v3';
const CORE = ['/', '/index.html', '/qr.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/fonts/plex-arabic-400.woff2', '/fonts/plex-arabic-500.woff2', '/fonts/plex-arabic-600.woff2',
  '/fonts/plex-latin-400.woff2', '/fonts/plex-latin-500.woff2', '/fonts/plex-latin-600.woff2',
  '/fonts/alex-arabic-600.woff2', '/fonts/alex-arabic-800.woff2', '/fonts/alex-latin-600.woff2', '/fonts/alex-latin-800.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/ws') || u.pathname.startsWith('/stats') || u.pathname.startsWith('/api')) return;
  if (e.request.mode === 'navigate' || u.pathname === '/' || u.pathname.endsWith('.html')) {
    // الصفحة: من الشبكة أولاً حتى يصل أي تحديث، ومن الحفظ إن انقطع الإنترنت
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put('/index.html', c)); return r; }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(m => m || fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })));
});
