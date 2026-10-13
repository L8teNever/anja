/* Anja Service Worker
 * - App-Dateien liegen in einem Cache pro Version ("anja-app-<version>").
 *   Neue Version => neuer Cache, alte App-Caches werden beim Aktivieren geloescht.
 * - Offline gespeicherte Videos liegen getrennt in "anja-videos" und ueberleben Updates.
 * - Videos werden aus dem Cache mit Range-Unterstuetzung ausgeliefert (Spulen offline).
 */
const VERSION = '__APP_VERSION__';
const APP_CACHE = `anja-app-${VERSION}`;
const VIDEO_CACHE = 'anja-videos';
const LIST_CACHE = 'anja-list';

const SHELL = [
  '/',
  '/index.html',
  `/style.css?v=${VERSION}`,
  `/app.js?v=${VERSION}`,
  '/viewer.js',
  '/vr-menu.js',
  '/vr-settings.js',
  '/projection.js',
  '/band.js',
  '/room.js',
  '/figure.js',
  '/icons.js',
  '/vendor/three.module.min.js',
  '/vendor/VRButton.js',
  '/vendor/GLTFLoader.js',
  '/vendor/BufferGeometryUtils.js',
  '/vendor/SkeletonUtils.js',
  '/models/michelle.glb',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // cache: 'reload' umgeht den HTTP-Cache, damit wirklich der neue Code gespeichert wird
    await Promise.all(SHELL.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res.ok) await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('anja-app-') && k !== APP_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'sw-activated', version: VERSION }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  if (event.data === 'get-version') event.source?.postMessage({ type: 'sw-version', version: VERSION });
});

function parseRange(header, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

async function videoFromCache(request) {
  const url = new URL(request.url);
  const cache = await caches.open(VIDEO_CACHE);
  const cached = await cache.match(url.pathname);
  if (!cached) return null;
  const blob = await cached.blob();
  const type = cached.headers.get('Content-Type') || 'video/mp4';
  const range = request.headers.get('Range');
  if (!range) {
    return new Response(blob, { status: 200, headers: {
      'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } });
  }
  const r = parseRange(range, blob.size);
  if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const part = blob.slice(r.start, r.end + 1, type);
  return new Response(part, { status: 206, headers: {
    'Content-Type': type,
    'Content-Length': String(part.size),
    'Content-Range': `bytes ${r.start}-${r.end}/${blob.size}`,
    'Accept-Ranges': 'bytes' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Versions-Check, Worker selbst und Hochladen: immer direkt zum Server
  if (url.pathname === '/version.json' || url.pathname === '/sw.js' || url.pathname.startsWith('/upload')) return;

  // Videoliste: Netz zuerst, offline die letzte bekannte Liste
  if (url.pathname === '/videos/') {
    event.respondWith((async () => {
      const cache = await caches.open(LIST_CACHE);
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok) await cache.put('/videos/', res.clone());
        return res;
      } catch {
        return (await cache.match('/videos/')) || new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Videos: offline gespeicherte aus dem Cache, sonst normal streamen
  if (url.pathname.startsWith('/videos/')) {
    event.respondWith((async () => (await videoFromCache(req)) || fetch(req))());
    return;
  }

  // Seite selbst: Netz zuerst (neuer Code sofort), offline aus dem Cache
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        return res;
      } catch {
        const cache = await caches.open(APP_CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Restliche App-Dateien: Cache dieser Version zuerst, sonst Netz
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return Response.error();
    }
  })());
});
