import { Suspense, lazy } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info, Receipt, ShoppingBasket, Sparkles } from 'lucide-react'
import type { BrandProfile, StoreProfile } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { SkeletonRows } from '@/components/states'
import { DEFAULT_BRAND } from '@/brand/applyBrand'
import { specimenInvoice } from './specimen'

/* The receipt pulls in bwip-js for the UPI QR — about a megabyte. Nobody opening
   Settings to change a phone number should pay for it, so it loads only when the
   branding panel is on screen. */
const ThermalReceipt = lazy(() =>
  import('@/print').then((m) => ({ default: m.ThermalReceipt })),
)

/**
 * What the reseller is actually buying, both halves of it at once.
 *
 * A brand panel that previews a swatch and a sidebar answers the easy half. The
 * half a white-label buyer is paying for is the PAPER: a customer keeps the
 * receipt, shows it to somebody, brings it back with a complaint, and every one
 * of those is a moment where somebody else's product name would appear.
 *
 * So the screen and the roll are shown together, from the same draft, and the
 * receipt is the real `ThermalReceipt` on its real 42-column grid rather than a
 * drawing of one. It also makes visible the thing that surprises every reseller
 * exactly once: a thermal head prints black on white and nothing else, so the
 * accent and the logo simply do not exist on paper. The footer and the
 * powered-by line are the whole of the branding a customer ever holds.
 */

/* React's CSSProperties has no slot for custom properties; the codebase casts at
   this boundary (see print/ThermalReceipt). */
function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties
}

export interface PreviewDraft {
  productName: string
  markText: string
  logoUrl: string | null
  tagline: string
  documentFooter: string
  hidePoweredBy: boolean
}

export function WhiteLabelPreview({
  draft, accentVars: vars, accentRefused,
}: {
  draft: PreviewDraft
  /** The accent to paint, already resolved to a full ramp. */
  accentVars: Record<string, string>
  /** The typed colour was refused, so the built-in ramp is on show instead. */
  accentRefused: boolean
}) {
  const api = useApi()
  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })

  const brand: BrandProfile = {
    ...DEFAULT_BRAND,
    productName: draft.productName.trim() || DEFAULT_BRAND.productName,
    markText: draft.markText.trim() || DEFAULT_BRAND.markText,
    logoUrl: draft.logoUrl,
    tagline: draft.tagline.trim() === '' ? null : draft.tagline.trim(),
    documentFooter: draft.documentFooter.trim() === '' ? null : draft.documentFooter.trim(),
    hidePoweredBy: draft.hidePoweredBy,
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--card-gap)' }}>
      <div className="card overflow-hidden" style={cssVars(vars)}>
        <header className="flex h-12 items-center justify-between gap-3 border-b border-border-subtle bg-subtle px-4">
          <span className="flex items-center gap-2 text-base font-semibold text-fg">
            <Sparkles size={15} className="text-accent-9" aria-hidden />
            On screen
          </span>
          <span className="micro-label">Live</span>
        </header>

        <div className="flex flex-col gap-4 p-4">
          {accentRefused ? (
            <p className="text-xs text-fg-subtle">
              Showing the built-in accent — the colour above was refused.
            </p>
          ) : null}

          {/* The sidebar header, at the size it actually renders. */}
          <div className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-border-subtle bg-subtle p-2.5">
            <span
              aria-hidden
              className={cn(
                'grid size-7 shrink-0 place-items-center overflow-hidden',
                'rounded-[var(--radius-md)] bg-accent-10 text-2xs font-semibold tracking-tight text-fg-on-accent',
              )}
            >
              {draft.logoUrl ? (
                <img src={draft.logoUrl} alt="" className="size-full object-contain" />
              ) : (
                brand.markText
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold leading-[18px] text-fg">
                {brand.productName}
              </span>
              {brand.tagline ? (
                <span className="block truncate text-2xs leading-[14px] text-fg-subtle">
                  {brand.tagline}
                </span>
              ) : null}
            </span>
          </div>

          {/* The active nav item — tint, accent text and the gutter bar. */}
          <div className="ps-2">
            <span className="relative flex h-[34px] items-center gap-2.5 rounded-[var(--radius-md)] bg-accent-3 pe-2 ps-2.5 text-base font-medium text-accent-11">
              <span
                aria-hidden
                className="absolute inset-y-1 -start-2 w-[3px] rounded-e-[var(--radius-full)] bg-accent-9"
              />
              <ShoppingBasket size={16} strokeWidth={2.25} aria-hidden className="shrink-0" />
              Billing
              <span className="num ms-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[var(--radius-full)] bg-accent-10 px-1.5 text-2xs font-medium text-fg-on-accent">
                3
              </span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="primary">Pay ₹1,284.50</Button>
            <Button type="button">Hold</Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="var(--accent-11)">Accent chip</Chip>
            <span
              aria-hidden
              className="h-8 flex-1 rounded-[var(--radius-md)] border-2 border-accent-6 bg-surface"
            />
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------------- paper */}
      <div className="card overflow-hidden">
        <header className="flex h-12 items-center justify-between gap-3 border-b border-border-subtle bg-subtle px-4">
          <span className="flex items-center gap-2 text-base font-semibold text-fg">
            <Receipt size={15} className="text-fg-muted" aria-hidden />
            On paper
          </span>
          <span className="micro-label">80 mm · 42 cols</span>
        </header>

        <p className="flex items-start gap-2 border-b border-border-subtle bg-subtle px-4 py-2.5 text-xs text-fg-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            A thermal head prints black on white: the accent, the logo and the mark do not reach
            the roll. The footer line and the powered-by line are the whole of the branding a
            customer takes home.
          </span>
        </p>

        <div className="flex justify-center overflow-x-auto bg-inset p-4">
          {store.data ? (
            <Suspense fallback={<SkeletonRows rows={8} cols={2} />}>
              <ThermalReceipt
                invoice={specimenInvoice(store.data, PREVIEW_AT)}
                store={store.data as StoreProfile}
                brand={brand}
                preview
              />
            </Suspense>
          ) : (
            <SkeletonRows rows={8} cols={2} />
          )}
        </div>
      </div>
    </div>
  )
}

/* Fixed, not `new Date()`. The specimen is re-rendered on every keystroke in the
   branding form, and a stamp that moved with the clock would re-render the whole
   receipt — QR included — for no reason anyone can see. */
const PREVIEW_AT = new Date('2026-04-01T11:24:00')
