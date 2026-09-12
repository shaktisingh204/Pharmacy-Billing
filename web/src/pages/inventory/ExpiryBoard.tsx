import { AlertTriangle, Ban, CalendarClock, Clock3, RotateCcwSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { InventorySummary, Money } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { compactINR } from '@/components/charts'
import { formatMoney } from '@/lib/format'
import type { Basis } from './analysis'
import { BASIS_SUFFIX } from './analysis'

/**
 * The near-expiry board — cards that are also the bucket filter.
 *
 * Marg ships Expiry Stock, Near Expiry Stock, Stock Life and Stock Ageing as four
 * separate reports, each behind its own parameter dialog. Every one of them is a
 * predicate over the same batch table, so they are cards over that grid here and
 * the answer arrives without a navigation.
 *
 * Three things this component gets right that are easy to get wrong:
 *
 *  - The windows are the STORE's (`stores.nearExpiryBuckets`), read off
 *    `summary.atRisk` rather than hardcoded. A shop that works to a 120-day
 *    supplier policy gets a 120-day card.
 *  - They NEST. "Within 180 days" already contains "within 30", so the cards must
 *    never be added up — and the board says so out loud, because a row of five
 *    numbers is an invitation to sum them.
 *  - The widest window is indigo, not a danger hue. Stock still inside the
 *    supplier's return window is an OPPORTUNITY; a screen that paints it red
 *    teaches the operator to ignore red.
 *
 * These cards are valued at COST whatever basis the valuation band is showing,
 * and they say so. A return claim, a write-off and an insurance loss are all
 * settled at what the shelf cost; quoting a deadline in MRP would inflate every
 * one of them by the margin.
 */

export type ExpiryBucketKey = 'd180' | 'd90' | 'd60' | 'd30' | 'expired'

/** The windows the contract's `InventoryFilters.bucket` can actually express. A
 *  store-configured window outside this set still counts; it just cannot filter. */
const FILTERABLE = new Set<string>(['d30', 'd60', 'd90', 'd180'])

/** Only for the shape of the skeleton, so the row does not jump when data lands. */
const PLACEHOLDER_DAYS = [180, 90, 60, 30]

function toneFor(days: number): string {
  if (days > 90) return 'var(--status-expiry-180)'
  if (days > 60) return 'var(--status-expiry-90)'
  if (days > 30) return 'var(--status-expiry-60)'
  return 'var(--status-expiry-30)'
}

function iconFor(days: number): LucideIcon {
  if (days > 90) return RotateCcwSquare
  if (days > 60) return Clock3
  if (days > 30) return CalendarClock
  return AlertTriangle
}

function noteFor(days: number): string {
  /* Six months is the retail norm, not a rule — the window is contractual and
     differs per supplier, so the card says "most", never "all". */
  if (days > 90) return 'Inside most suppliers’ window'
  if (days > 60) return 'Last call for a saleable return'
  if (days > 30) return 'Sell it, or claim it'
  /* FEFO holds this band back from auto-allocation (domain/fefo expiryGuardDays):
     a customer buying a month's course must not be handed a strip that dies
     inside it. So these batches stop moving on their own. */
  return 'FEFO will not auto-allocate'
}

interface Card {
  id: string
  label: string
  icon: LucideIcon
  tone: string
  note: string
  batches: number | null
  value: Money | null
  /** True when the count and the value are floors rather than whole figures. */
  approx: boolean
  filter: ExpiryBucketKey | null
}

const DECIMALISH = /^-?\d+(\.\d+)?$/

/** Display only — `D.toNumber` is the sanctioned way out of a decimal string. */
function amount(v: string): number | null {
  const s = v.trim()
  return DECIMALISH.test(s) ? D.toNumber(D.dec(s)) : null
}

export function ExpiryBoard({
  summary,
  expired,
  pending,
  selected,
  basis,
  onSelect,
}: {
  summary: InventorySummary | null
  /**
   * Expired stock, which `atRisk` deliberately excludes — it is not "at risk",
   * it is already lost, and folding it into a window would hide a deadline that
   * can still be met. It arrives from its own count, so it lands as its own prop.
   */
  expired: { batches: number; valueAtCost: Money; exact: boolean } | null
  pending: boolean
  /** The bucket currently filtering the grid, or null for "everything". */
  selected: ExpiryBucketKey | null
  /** Only so the board can say it is NOT following the page's basis. */
  basis: Basis
  /** Called with the same key to clear it — the cards toggle. */
  onSelect: (bucket: ExpiryBucketKey | null) => void
}) {
  const windows = [...(summary?.atRisk ?? [])].sort((a, b) => b.days - a.days)

  const cards: Card[] = windows.length > 0
    ? windows.map((w) => ({
      id: w.bucket,
      label: `Within ${w.days} days`,
      icon: iconFor(w.days),
      tone: toneFor(w.days),
      note: noteFor(w.days),
      batches: w.batches,
      value: w.valueAtCost,
      approx: false,
      filter: FILTERABLE.has(w.bucket) ? (w.bucket as ExpiryBucketKey) : null,
    }))
    : PLACEHOLDER_DAYS.map((days) => ({
      id: `d${days}`,
      label: `Within ${days} days`,
      icon: iconFor(days),
      tone: toneFor(days),
      note: noteFor(days),
      batches: null,
      value: null,
      approx: false,
      filter: FILTERABLE.has(`d${days}`) ? (`d${days}` as ExpiryBucketKey) : null,
    }))

  cards.push({
    id: 'expired',
    label: 'Expired',
    icon: Ban,
    tone: 'var(--status-expired)',
    note: 'Quarantine it or write it off',
    batches: expired?.batches ?? null,
    value: expired?.valueAtCost ?? null,
    approx: expired !== null && !expired.exact,
    filter: 'expired',
  })

  return (
    <section className="card flex min-w-0 flex-col gap-[var(--card-gap)] p-[var(--card-px)]" aria-label="Expiry windows">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="micro-label">Money against a deadline</h2>
        <span className="truncate text-2xs text-fg-subtle">
          {/* Stated even when the page is showing MRP elsewhere: a claim, a
              write-off and a return are all settled at what the shelf cost. */}
          Always at cost{basis === 'mrp' ? ', unlike the valuation above' : ''}
        </span>
      </div>

      <div
        role="group"
        aria-label="Expiry windows"
        aria-busy={pending}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
      >
        {cards.map((card) => (
          <BucketCard
            key={card.id}
            card={card}
            on={card.filter !== null && selected === card.filter}
            pending={pending && card.batches === null}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Stated, not implied. Five numbers in a row is an invitation to add them,
          and the sum would double-count every batch in the narrower windows. */}
      <p className="text-2xs text-fg-subtle">
        Windows nest — “within 180 days” already contains “within 30”, so read one card and
        never the total. Expired stock is counted apart: it is a write-off, not a deadline.
      </p>
    </section>
  )
}

function BucketCard({
  card, on, pending, onSelect,
}: {
  card: Card
  on: boolean
  pending: boolean
  onSelect: (bucket: ExpiryBucketKey | null) => void
}) {
  const value = card.value === null ? null : amount(card.value)
  /* Empty windows stay quiet. Tinting a card that counts zero trains the operator
     to stop reading the tint. */
  const quiet = !on && card.batches === 0

  /* One hedge covers both numbers or neither: when the scan behind this card was
     capped, the count is as much a floor as the value, and hedging the money
     while stating the count flat would read as a precise number of batches
     holding an approximate sum. */
  const atLeast = card.approx ? 'at least ' : ''
  const title = card.value === null
    ? card.label
    : `${atLeast}${card.batches} batch${card.batches === 1 ? '' : 'es'} · ${atLeast}${formatMoney(card.value)} ${BASIS_SUFFIX.cost}`

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1">
        <card.icon
          size={13}
          aria-hidden
          className="shrink-0"
          style={{ color: quiet ? 'var(--fg-subtle)' : card.tone }}
        />
        <span
          className="truncate text-2xs font-semibold"
          style={{ color: quiet ? 'var(--fg-muted)' : card.tone }}
        >
          {card.label}
        </span>
      </span>

      <span className="flex min-w-0 items-baseline gap-1">
        {pending ? (
          <span aria-hidden className="my-1 h-6 w-20 animate-pulse rounded-[var(--radius-md)] bg-inset" />
        ) : (
          <>
            <span className="text-xs font-medium text-fg-muted">₹</span>
            <span className="display-num truncate text-xl text-fg 2xl:text-2xl">
              {value === null ? '—' : `${card.approx ? '≥' : ''}${compactINR(value)}`}
            </span>
          </>
        )}
      </span>

      <span className="truncate text-2xs text-fg-muted">
        <span className="num font-semibold text-fg">
          {card.batches === null ? '—' : `${card.approx ? '≥' : ''}${card.batches}`}
        </span>
        {card.batches === 1 ? ' batch' : ' batches'} · {card.note}
      </span>
    </>
  )

  const shell = 'flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] border px-3 py-2.5 text-left'
  const style = {
    borderColor: on
      ? card.tone
      : quiet
        ? 'var(--border-subtle)'
        : `color-mix(in srgb, ${card.tone} 32%, transparent)`,
    backgroundColor: quiet ? 'transparent' : `color-mix(in srgb, ${card.tone} ${on ? 14 : 6}%, transparent)`,
    boxShadow: on ? `inset 0 0 0 1px ${card.tone}` : undefined,
  }

  if (card.filter === null) {
    return <div className={shell} style={style} title={title}>{body}</div>
  }

  const filter = card.filter
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onSelect(on ? null : filter)}
      title={title}
      className={cn(shell, 'transition-[background-color,border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease)] hover:border-[currentColor]')}
      style={style}
    >
      {body}
    </button>
  )
}
