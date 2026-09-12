/**
 * Registering the till's service worker, and handling the one hard part:
 * WHEN a new version is allowed to take over.
 *
 * The worker deliberately does not `skipWaiting`. A running document holds
 * references to hashed chunks that a new build no longer has, so an update that
 * activates underneath a half-finished bill breaks the next lazy route — which,
 * at a counter, is the payment screen. So a waiting worker is reported to the
 * app and activated only when somebody says so, from a screen where nobody is
 * mid-sale.
 */

type UpdateHandler = (activate: () => void) => void

let waiting: ServiceWorker | null = null

export function registerServiceWorker(onUpdate: UpdateHandler): void {
  if (!('serviceWorker' in navigator)) return
  /* Dev has no built assets to cache and Vite's own HMR client fights a worker
     that intercepts navigations. Registering only in a real build keeps the
     development loop honest — a stale cached module during development is an
     hour lost to a bug that does not exist. */
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((reg) => {
      const announce = (worker: ServiceWorker | null) => {
        if (!worker) return
        waiting = worker
        onUpdate(activate)
      }

      // Already waiting when this tab loaded.
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting)

      reg.addEventListener('updatefound', () => {
        const next = reg.installing
        if (!next) return
        next.addEventListener('statechange', () => {
          /* `controller` distinguishes an UPDATE from the first install. On the
             very first visit a worker also reaches `installed`, and telling the
             operator a brand-new till has "an update ready" is nonsense. */
          if (next.state === 'installed' && navigator.serviceWorker.controller) announce(next)
        })
      })
    }).catch(() => {
      // A till that cannot register a worker still bills. It simply will not
      // boot without the network, which is the situation it was already in.
    })
  })

  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Guarded: Chrome can fire this more than once and a reload loop on a POS is
    // unrecoverable without clearing site data.
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}

function activate(): void {
  waiting?.postMessage('SKIP_WAITING')
}
