// GoldenHour service worker: makes the app shell and map tiles available offline.
// It deliberately does NOT touch Firestore, Auth or routing traffic (all cross-origin API calls pass through);
// live data offline is handled by Firestore's own on-device cache and write queue.
const VERSION = 'gh-v2'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`
const TILES = `${VERSION}-tiles`
const TILE_HOST = 'tile.openstreetmap.org'
const MAX_TILES = 250

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)))
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // Map tiles: show cached tiles instantly, refresh in the background.
  if (url.hostname.endsWith(TILE_HOST)) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req)
        const net = fetch(req).then((res) => { if (res.ok) { void cache.put(req, res.clone()).then(() => trim(TILES, MAX_TILES)) } return res }).catch(() => hit)
        return hit ?? net
      }),
    )
    return
  }

  if (url.origin !== self.location.origin) return // Firestore, Auth, routing: never cached here

  // Hashed build assets never change: cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.open(ASSETS).then(async (cache) => {
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok) void cache.put(req, res.clone())
      return res
    }))
    return
  }

  // Page loads: fresh when online, last good shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); void caches.open(SHELL).then((c) => c.put('/', copy)); return res }).catch(() => caches.match('/').then((r) => r ?? new Response('Offline', { status: 503 }))),
    )
  }
})
