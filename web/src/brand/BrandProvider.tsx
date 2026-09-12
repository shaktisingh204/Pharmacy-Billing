import { useEffect, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BrandProfile } from '@contract'
import { useApi } from '@/api'
import { DEFAULT_BRAND, applyBrandToDocument, currentAccentBase } from './applyBrand'
import { applyManifest } from './installable'
import { BrandContext, brandQueryOptions } from './useBrand'

/**
 * Loads the brand, writes it onto the document, and publishes it to the tree.
 *
 * The requirement that shapes this file is that the product's own teal must
 * never flash before a reseller's colour. Two mechanisms, in order:
 *
 *  1. the last resolved profile is mirrored into localStorage and read
 *     SYNCHRONOUSLY on the next boot, so the accent is on the document element
 *     in the same commit as the first paint;
 *  2. on the very first boot on a terminal there is nothing to read, so the tree
 *     is held back until getBrand() resolves. That is one IndexedDB read, on a
 *     boot that already awaits seeding, and it is the only way to be honest —
 *     rendering the shell under the wrong name for two frames is worse than
 *     rendering it two frames later.
 */

const CACHE_KEY = 'rxbill.brand'

/**
 * A cache entry is untrusted input: it survives upgrades, and half a profile
 * would render a nameless shell. Anything unexpected is discarded and the query
 * decides instead.
 */
function parseBrand(raw: string): BrandProfile | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const b = value as Record<string, unknown>

  const nullableString = (v: unknown) => v === null || typeof v === 'string'
  if (typeof b['productName'] !== 'string') return null
  if (typeof b['markText'] !== 'string') return null
  if (typeof b['hidePoweredBy'] !== 'boolean') return null
  if (!nullableString(b['logoUrl'])) return null
  if (!nullableString(b['tagline'])) return null
  if (!nullableString(b['documentFooter'])) return null

  const accent = b['accent']
  if (accent !== null) {
    if (typeof accent !== 'object' || accent === null) return null
    const a = accent as Record<string, unknown>
    for (const key of ['base', 'hover', 'text', 'tint', 'ring']) {
      if (typeof a[key] !== 'string') return null
    }
  }

  return value as BrandProfile
}

function readCache(): BrandProfile | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw === null ? null : parseBrand(raw)
  } catch {
    // Private mode, or storage disabled by policy. Costs a frame, not the app.
    return null
  }
}

function writeCache(brand: BrandProfile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(brand))
  } catch {
    // A 64KB logo can push a full quota over. The next boot just waits instead.
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  // Lazy initialiser: read once, at mount, before the first paint.
  const [cached] = useState(readCache)
  const { data, isError } = useQuery(brandQueryOptions(api))

  // The cache is only a paint-time stand-in; the resolved profile always wins.
  // A failed read must not hold the shell hostage — the app is still a till.
  const brand = data ?? cached ?? (isError ? DEFAULT_BRAND : null)

  // Layout, not passive: this runs after the commit that renders `children` and
  // before the browser paints it, which is what keeps the default ramp offscreen.
  useLayoutEffect(() => {
    if (!brand) return
    applyBrandToDocument(brand, document.documentElement)
    /* The installable manifest is rebuilt from the same brand, so a reseller who
       renames the product renames the app somebody installs tomorrow. An app
       ALREADY installed keeps the name it was installed with — browsers do not
       re-title one — which the Settings copy says out loud. */
    /* Read back off the document AFTER the brand is applied, so the manifest's
       theme colour is the accent that actually won — a brand with no accent
       override falls through to the built-in teal, and reading the profile
       would give null and paint the installed app's splash the wrong colour. */
    applyManifest(brand, currentAccentBase(document.documentElement) ?? '#0D9488')
  }, [brand])

  // Mirroring is for the NEXT boot, so it stays off the critical path.
  useEffect(() => {
    if (data) writeCache(data)
  }, [data])

  if (!brand) return null
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}
