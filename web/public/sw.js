/*
 * The service worker that makes this a till rather than a web page.
 *
 * A pharmacy counter is not a browsing session. It is opened in the morning and
 * closed at night, on a machine whose network is a shop wifi router that a
 * customer will unplug to charge a phone. "The internet is down and the till
 * still works" is the requirement; this file is what makes it true.
 *
 * TWO STRATEGIES, chosen by what the request is:
 *
 *  - HASHED ASSETS ARE CACHE-FIRST. Vite names them by content, so `index-a1b2.js`
 *    can never mean two different things. Fetching them again is pure latency,
 *    and serving them from cache is what lets a cold boot happen with no network
 *    at all.
 *
 *  - NAVIGATIONS ARE NETWORK-FIRST, falling back to the cached shell. The
 *    document is the one thing that must be allowed to change: it is what points
 *    at the new hashed assets after a deploy, and caching it first would pin the
 *    till to whatever version it happened to see once.
 *
 * WHAT IS DELIBERATELY NOT CACHED: anything under /api. The offline story for
 * data is IndexedDB, which is a real database with real transactions. A cached
 * API response is a stale figure that looks live, and a stale stock figure is
 * how a counter oversells.
 */

const VERSION = 'v1'
const SHELL = `shell-${VERSION}`
const ASSETS = `assets-${VERSION}`

/* The document is precached at install so the very first offline boot works.
   Everything else arrives through the fetch handler as it is used — a build
   manifest would have to be regenerated in lockstep with this file, and a
   precache list that drifts from the build is worse than none. */
const SHELL_URLS = ['/', '/index.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  )
  /* NOT skipWaiting. A till mid-sale must not have its assets swapped underneath
     it — the running document would then be asking for chunks that the new
     version no longer has, and a lazy route would fail to load in the middle of
     taking money. The app decides when to activate, from a screen where nobody
     is halfway through a bill. */
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  // The app asking for the update it has just told the operator about.
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

/*
 * Vite/Rolldown emits `name-HASH.ext`, and the hash is base64-ish — mixed case,
 * with `-` and `_` in it: `db-DT85gwXl.js`, `index--_1w-Ici.js`. An earlier
 * version of this looked for lowercase hex and therefore matched NOTHING, which
 * is the worst possible failure here: everything appears to work online and the
 * first offline boot finds an empty cache.
 *
 * A hyphen before the hash and eight or more hash characters is enough to
 * separate a content-addressed asset from anything else under /assets.
 */
const isHashedAsset = (url) =>
  url.origin === self.location.origin
  && /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpe?g|webp)$/.test(url.pathname)

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never the API: a cached figure that looks live is how a counter oversells.
  if (url.pathname.startsWith('/api/')) return
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(SHELL).then((c) => c.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html').then((r) => r ?? Response.error())),
    )
    return
  }

  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        /* Only a real response is stored. Caching an opaque or error response
           pins a broken asset until the cache is cleared by hand, and on a
           counter machine nobody ever clears it. */
        if (response.ok) {
          const copy = response.clone()
          void caches.open(ASSETS).then((c) => c.put(request, copy))
        }
        return response
      })),
    )
  }
})
