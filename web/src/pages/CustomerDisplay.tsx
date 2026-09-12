import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { BadgeIndianRupee, CircleCheck, MonitorSmartphone, ShoppingBasket } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '@/api'
import { currentAccentBase, deriveDarkAccent } from '@/brand/applyBrand'
import { useBrand } from '@/brand/useBrand'
import { cn } from '@/lib/cn'
import { formatAmount, formatQty } from '@/lib/format'
import { amountInWords } from '@/lib/words'
import type { DisplaySnapshot } from '@/lib/counterDisplay'
import { subscribe } from '@/lib/counterDisplay'

/**
 * The customer-facing display, at /display.
 *
 * Opened once on the second monitor and left there. It is the only screen in
 * RxBill that is DARK: it is read from two metres away across a lit shop by
 * someone who is not operating it, and a white panel at that distance is a lamp
 * pointed at the customer. The palette is the same token set with the surface
 * and text roles swapped, so every utility on the page keeps working — the
 * design language is not forked, only re-grounded.
 *
 * It computes NOTHING. Every figure arrives already decided by the till, which
 * is the same rule the receipt follows: two implementations of a total are two
 * totals, and the one the customer is looking at must be the one being charged.
 */

/** The panel the whole screen is painted on, and what the accent is judged against. */
const GROUND = '#0A101C'

/* The neutrals and the semantic status steps. These are NOT the brand: a
   reseller overrides an accent, not the meaning of green, and a shop whose brand
   is red would otherwise repaint "paid" in its own colour. */
const NEUTRALS: CSSProperties = {
  ['--bg-app' as string]: GROUND,
  ['--bg-surface' as string]: '#111A2B',
  ['--bg-subtle' as string]: '#162134',
  ['--bg-inset' as string]: '#0D1626',
  ['--bg-hover' as string]: '#1A2537',
  ['--bg-raised' as string]: '#131E30',
  ['--fg' as string]: '#F6F9FD',
  ['--fg-muted' as string]: '#A9B6C8',
  ['--fg-subtle' as string]: '#7C8BA0',
  ['--border-subtle' as string]: '#1C2839',
  ['--border' as string]: '#28374F',
  ['--border-strong' as string]: '#485973',
  ['--success-3' as string]: '#0D2E1E',
  ['--success-9' as string]: '#34D399',
  ['--success-11' as string]: '#6EE7A8',
  colorScheme: 'dark',
}

/**
 * The accent, re-grounded for this panel.
 *
 * The three accent steps used to be written here as teal literals, which meant
 * the one screen a CUSTOMER looks at was the one screen a white-label could not
 * reach. They are derived instead — from the reseller's own base when there is
 * one, otherwise from whatever `--accent-9` the document is currently painted
 * with, which is the built-in ramp.
 */
function useDarkAccent(): CSSProperties {
  const brand = useBrand()
  const base = brand.accent?.base

  return useMemo(() => {
    const source = base ?? currentAccentBase(document.documentElement) ?? '#0D9488'
    const dark = deriveDarkAccent(source, GROUND)
    if (!dark) return {}
    return {
      ['--accent-3' as string]: dark.tint,
      ['--accent-9' as string]: dark.base,
      ['--accent-11' as string]: dark.text,
    }
  }, [base])
}

/** The one number the screen exists to show, sized for the back of the queue. */
const HERO = 'clamp(var(--text-5xl), 8.5vw, 128px)'

export default function CustomerDisplay() {
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const accent = useDarkAccent()
  const api = useApi()

  /* The SHOP's identity, and specifically not the software's.
     A live snapshot wins because in a chain it names the branch actually
     billing; between customers there is no snapshot, so the store profile
     answers instead. Neither source is the vendor. */
  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const shopName = snapshot?.storeName ?? store.data?.name ?? ''
  const tagline =
    snapshot?.tagline ?? store.data?.tagline ?? 'Your prescription, itemised as it is billed.'

  useEffect(() => subscribe(setSnapshot), [])

  /* This is the one screen an actual customer looks at, and it hardcoded the
     software's name — so a shop that bought this white-labelled would show its
     customers the name of a product they have never heard of. */
  useEffect(() => {
    document.title = shopName ? `${shopName} — customer display` : 'Customer display'
  }, [shopName])

  /* The newest line is the one being discussed, so it stays in view. `auto`
     rather than `smooth`: a scan lands every second or two and a queued smooth
     scroll is still travelling when the next item arrives. */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [snapshot?.lines.length])

  const stage = snapshot?.stage ?? 'IDLE'
  const idle = snapshot === null || stage === 'IDLE' || snapshot.lines.length === 0

  return (
    <div
      data-density="spacious"
      style={{ ...NEUTRALS, ...accent, background: 'var(--bg-app)', color: 'var(--fg)' }}
      className="flex h-full min-h-0 flex-col"
    >
      <header
        className="page-header flex shrink-0 items-center gap-4"
        style={{ paddingInline: 'var(--page-px)', paddingBlock: 'var(--space-4)' }}
      >
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-semibold tracking-tight">
            {/* The shop's name, or a plain description of the screen while the
                profile loads — never the vendor's. An idle display showing the
                software's brand is an advertisement the shop did not agree to. */}
            {shopName || 'Counter display'}
          </h1>
          <p className="truncate text-base text-fg-muted">
            {tagline}
          </p>
        </div>
        {snapshot?.customerName && (
          <div className="shrink-0 rounded-[var(--radius-full)] border border-border bg-surface px-4 py-1.5 text-lg">
            {snapshot.customerName}
          </div>
        )}
      </header>

      {idle ? (
        <IdleScreen snapshot={snapshot} />
      ) : (
        <div className="flex min-h-0 flex-1" style={{ gap: 'var(--card-gap)', padding: 'var(--page-px)' }}>
          <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-subtle px-5 py-2.5">
              <ShoppingBasket size={16} className="text-fg-subtle" aria-hidden />
              <span className="micro-label">Your items</span>
              <span className="num ml-auto text-sm text-fg-muted">
                {snapshot.itemCount} {snapshot.itemCount === 1 ? 'item' : 'items'}
              </span>
            </div>

            <div ref={listRef} className="scroll-region min-h-0 flex-1">
              {snapshot.lines.map((l, i) => (
                <div
                  key={l.lineId}
                  className={cn(
                    'flex items-center gap-4 border-b border-border-subtle px-5 py-2.5 last:border-0',
                    i === snapshot.lines.length - 1 && 'bg-hover',
                  )}
                >
                  <span className="num w-8 shrink-0 text-base text-fg-subtle">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xl font-medium">{l.brandName}</div>
                    <div className="truncate text-sm text-fg-muted">
                      {l.packLabel}
                      {Number(l.freeQty) > 0 && ` · ${formatQty(l.freeQty)} free`}
                      {l.note && ` · ${l.note}`}
                    </div>
                  </div>
                  <span className="num shrink-0 text-base text-fg-muted">
                    {formatQty(l.qty)} × {formatAmount(l.ratePerUnit)}
                  </span>
                  <span className="num w-32 shrink-0 text-xl font-medium">{formatAmount(l.amount)}</span>
                </div>
              ))}
            </div>
          </section>

          <aside className="flex w-[420px] shrink-0 flex-col" style={{ gap: 'var(--card-gap)' }}>
            <div className="card flex flex-1 flex-col justify-center px-6 py-5">
              <span className="micro-label">
                {stage === 'PAID' ? 'Bill total' : stage === 'PAYMENT' ? 'Amount payable' : 'Running total'}
              </span>
              <div
                className="display-num mt-1 leading-none"
                style={{ fontSize: HERO }}
                data-testid="display-net"
              >
                <span className="mr-1 text-[0.42em] font-medium text-fg-muted">₹</span>
                {formatAmount(snapshot.netAmount)}
              </div>
              <p className="mt-3 text-sm leading-snug text-fg-subtle">
                {amountInWords(snapshot.netAmount)}
              </p>

              {Number(snapshot.savedAmount) > 0 && (
                <p className="mt-4 flex items-center gap-2 text-lg font-medium text-accent-11">
                  <BadgeIndianRupee size={18} aria-hidden />
                  You saved <span className="num">{formatAmount(snapshot.savedAmount)}</span>
                </p>
              )}

              {snapshot.billNote && (
                <p className="mt-4 rounded-[var(--radius-md)] border border-border bg-subtle px-3 py-2 text-base text-fg-muted">
                  {snapshot.billNote}
                </p>
              )}
            </div>

            {stage === 'PAID' && (
              <div className="card border-success-9/40 px-6 py-4" style={{ background: 'var(--success-3)' }}>
                <p className="flex items-center gap-2 text-xl font-semibold text-success-11">
                  <CircleCheck size={20} aria-hidden /> Thank you
                </p>
                <p className="mono mt-1 text-sm text-fg-muted">{snapshot.invoiceNo}</p>
                {Number(snapshot.changeDue ?? '0') > 0 && (
                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="text-lg text-fg-muted">Change</span>
                    <span className="display-num text-4xl text-success-11">
                      {formatAmount(snapshot.changeDue ?? '0')}
                    </span>
                  </div>
                )}
              </div>
            )}

            {stage === 'PAYMENT' && snapshot.upiVpa && (
              <div className="card px-6 py-4">
                <span className="micro-label">Pay by UPI</span>
                <p className="mono mt-1 text-xl">{snapshot.upiVpa}</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}

function IdleScreen({ snapshot }: { snapshot: DisplaySnapshot | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
      <MonitorSmartphone size={56} strokeWidth={1.25} className="text-fg-subtle" aria-hidden />
      <p className="text-3xl font-semibold tracking-tight">
        {snapshot ? 'Ready for the next customer' : 'Waiting for the counter'}
      </p>
      <p className="max-w-[46ch] text-lg text-fg-muted">
        {snapshot
          ? 'Every item will appear here as it is scanned, with the price printed on the pack.'
          : 'Open this window on the customer-facing screen and start a bill at the till.'}
      </p>
      {snapshot?.upiVpa && (
        <p className="mono mt-2 rounded-[var(--radius-md)] border border-border bg-surface px-4 py-2 text-base text-fg-muted">
          UPI · {snapshot.upiVpa}
        </p>
      )}
    </div>
  )
}
