import type { BrandProfile } from '@contract'
import { faviconDataUri } from './applyBrand'

/**
 * Making the app installable, under the RESELLER's name.
 *
 * A web app manifest is normally a static file. It cannot be one here: the
 * product name, the mark and the accent are all data that a reseller edits in
 * Settings, and an installed app showing `RxBill` on the desktop of a shop that
 * bought `MedSoft` is the white-label promise broken at the most visible point
 * there is — the icon somebody taps every morning.
 *
 * So the manifest is BUILT from the brand and served as a blob URL. The browser
 * reads it the same way; the difference is that renaming the product renames the
 * installed app on the next install.
 *
 * One caveat worth stating rather than discovering: an app ALREADY installed
 * keeps the name and icon it was installed with. Browsers re-read the manifest
 * lazily and none of them re-title an installed app promptly. Re-branding after
 * deployment therefore wants a re-install, which is what the Settings copy says.
 */

let current: string | null = null

export function applyManifest(brand: BrandProfile, accentBase: string): void {
  const icon = faviconDataUri(brand, accentBase)
  const manifest = {
    name: brand.productName,
    short_name: brand.productName.slice(0, 12),
    description: brand.tagline ?? 'Pharmacy billing and inventory',
    start_url: '/billing',
    /* Standalone, not fullscreen. A counter operator needs the OS back gesture
       and the clock; fullscreen takes both away and there is no way out of it
       without a keyboard shortcut nobody at a till knows. */
    display: 'standalone',
    orientation: 'landscape',
    background_color: '#F7F8F8',
    theme_color: accentBase,
    icons: [
      /* One SVG, marked `any maskable`. A raster set would mean shipping PNGs
         that cannot carry a reseller's accent — the whole reason this is
         generated rather than static. */
      { src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
    shortcuts: [
      { name: 'New bill', url: '/billing' },
      { name: 'Sales register', url: '/sales' },
    ],
  }

  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' })
  const url = URL.createObjectURL(blob)

  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'manifest'
    document.head.append(link)
  }
  link.href = url

  /* The previous blob is revoked AFTER the new one is in place. Revoking first
     leaves a window in which the document has no readable manifest, and a
     browser that happens to read it there decides the app is not installable. */
  if (current) URL.revokeObjectURL(current)
  current = url
}

// ------------------------------------------------------------- installing ---

/** Chrome's install prompt, captured so it can be offered where it makes sense
 *  rather than wherever the browser felt like showing a bar. */
interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPrompt | null = null
const listeners = new Set<(available: boolean) => void>()

export function watchInstallability(): () => void {
  const onPrompt = (e: Event) => {
    e.preventDefault()
    deferred = e as InstallPrompt
    for (const l of listeners) l(true)
  }
  const onInstalled = () => {
    deferred = null
    for (const l of listeners) l(false)
  }
  window.addEventListener('beforeinstallprompt', onPrompt)
  window.addEventListener('appinstalled', onInstalled)
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt)
    window.removeEventListener('appinstalled', onInstalled)
  }
}

export const canInstall = (): boolean => deferred !== null

export function onInstallabilityChange(fn: (available: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable'
  await deferred.prompt()
  const { outcome } = await deferred.userChoice
  /* Spent either way. Chrome allows one use per event, and a stale prompt object
     throws on the second call — which presents as an install button that works
     once and then silently does nothing. */
  deferred = null
  for (const l of listeners) l(false)
  return outcome
}

/** True when running as an installed app rather than in a browser tab. */
export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true
}
