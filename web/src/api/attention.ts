import type {
  Batch, Customer, DayClose, IsoDate, Medicine, Money, PurchaseOrder, SupplierReturn,
} from '@contract'
import * as D from '@/domain/decimal'

/**
 * What needs somebody's attention, as pure value logic.
 *
 * Every one of these facts is already computed somewhere — near-expiry on the
 * inventory screen, overdue balances on customers, unsettled claims on
 * purchases, an unclosed day on sales. The gap is that a shopkeeper has to go
 * and LOOK at six screens to find out, and nobody does that daily. So the six
 * are gathered into one list behind the bell, and every item deep-links to the
 * screen that fixes it.
 *
 * Three rules, and the first is the one that decides whether the feature works
 * at all:
 *
 *  1. NOTHING IS RAISED THAT CANNOT BE ACTED ON. A count of near-expiry stock
 *     that has been near expiry for a month is not news; it is wallpaper, and a
 *     bell that is permanently lit is one nobody reads. So every item has a
 *     threshold that a normal shop clears, and the list is usually short.
 *
 *  2. SEVERITY IS ABOUT MONEY OR LAW, not about how alarming it sounds. An
 *     expired strip on a shelf is a legal problem and outranks a large overdue
 *     balance, which is only a commercial one.
 *
 *  3. EACH ITEM SAYS THE NUMBER. "12 batches expire within 30 days" is
 *     actionable; "expiry warning" is not.
 */

export type AttentionKind =
  | 'expired'
  | 'nearExpiry'
  | 'outOfStock'
  | 'overdue'
  | 'claimsUnsettled'
  | 'ordersOverdue'
  | 'dayUnclosed'

export interface AttentionItem {
  kind: AttentionKind
  /** `now` is a legal or money problem today; `soon` is this week's work. */
  severity: 'now' | 'soon'
  title: string
  detail: string
  /** How many things. Shown, because a count is what makes it actionable. */
  count: number
  /** Money behind it, where there is any. */
  amount: Money | null
  /** The screen that fixes it, already filtered. */
  href: string
}

export interface AttentionInputs {
  batches: readonly Batch[]
  medicineFor: (id: number) => Medicine | undefined
  customers: readonly Customer[]
  supplierReturns: readonly SupplierReturn[]
  purchaseOrders: readonly PurchaseOrder[]
  /** Today's close for this till, or null when the day is still open. */
  todayClose: DayClose | null
  /** Bills posted today. An unclosed day with no trade is not a problem. */
  invoicesToday: number
  /** Local clock hour, 0–23. Deciding when "the day should have been closed". */
  hour: number
  today: IsoDate
}

const MS_PER_DAY = 86_400_000

const daysUntil = (date: IsoDate, today: IsoDate): number =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY)

const money = (d: D.Decimal): Money => D.toStr(d, 2) as Money

/**
 * Past this hour, a day that has taken money and not been closed is worth
 * raising. Before it, the shop is simply still open — and a bell that complains
 * at two in the afternoon that the day is not closed is the fastest way to teach
 * staff to ignore the bell.
 */
const CLOSING_HOUR = 20

/** Near-expiry only counts inside this window; beyond it, it is wallpaper. */
const NEAR_EXPIRY_DAYS = 30

export function attentionItems(inputs: AttentionInputs): AttentionItem[] {
  const out: AttentionItem[] = []

  // --------------------------------------------------------------- stock ---

  let expiredCount = 0
  let expiredValue = D.ZERO
  let nearCount = 0
  let nearValue = D.ZERO

  for (const batch of inputs.batches) {
    const qty = D.dec(batch.qtyOnHand)
    if (!D.gt(qty, D.ZERO)) continue
    const left = daysUntil(batch.expiryDate, inputs.today)
    const value = D.mul(qty, D.dec(batch.landedCostPerUnit))
    if (left < 0) {
      expiredCount += 1
      expiredValue = D.add(expiredValue, value)
    } else if (left <= NEAR_EXPIRY_DAYS) {
      nearCount += 1
      nearValue = D.add(nearValue, value)
    }
  }

  if (expiredCount > 0) {
    /* First, and always `now`: expired stock on a shelf is a legal problem
       rather than a commercial one, and it is the thing a Drug Inspector opens
       a cabinet to find. */
    out.push({
      kind: 'expired',
      severity: 'now',
      title: `${expiredCount} batch${expiredCount === 1 ? '' : 'es'} on the shelf are expired`,
      detail: 'Expired stock must come off the shelf. Issue it as a breakage/expiry claim so the value is chased rather than written off quietly.',
      count: expiredCount,
      amount: money(expiredValue),
      href: '/inventory?bucket=expired',
    })
  }

  if (nearCount > 0) {
    out.push({
      kind: 'nearExpiry',
      severity: 'soon',
      title: `${nearCount} batch${nearCount === 1 ? '' : 'es'} expire within ${NEAR_EXPIRY_DAYS} days`,
      detail: 'Still returnable to most suppliers, and still sellable. After the window it is a write-off.',
      count: nearCount,
      amount: money(nearValue),
      href: '/inventory?bucket=d30',
    })
  }

  /* Out of stock, but only for lines the shop has said it cares about — a
     `reorderLevel` above zero. Every discontinued line in a 2,000-row catalogue
     is technically out of stock, and listing those buries the ten that matter. */
  const stocked = new Set<number>()
  for (const b of inputs.batches) {
    if (D.gt(D.dec(b.qtyOnHand), D.ZERO)) stocked.add(b.medicineId)
  }
  const wanted = new Set<number>()
  for (const b of inputs.batches) {
    const m = inputs.medicineFor(b.medicineId)
    if (m && m.isActive && m.reorderLevel > 0 && !stocked.has(b.medicineId)) wanted.add(b.medicineId)
  }
  if (wanted.size > 0) {
    out.push({
      kind: 'outOfStock',
      severity: 'soon',
      title: `${wanted.size} line${wanted.size === 1 ? '' : 's'} you stock are empty`,
      detail: 'These have a reorder level set, so the shop has said it wants them on the shelf.',
      count: wanted.size,
      amount: null,
      href: '/purchases?tab=order',
    })
  }

  // ---------------------------------------------------------------- money ---

  let overdueCount = 0
  let overdueValue = D.ZERO
  for (const c of inputs.customers) {
    const owed = D.dec(c.outstanding)
    if (!D.gt(owed, D.ZERO)) continue
    const limit = D.dec(c.creditLimit)
    /* Over the limit, not merely owing. Half a shop's customers carry a khata
       balance permanently; the ones worth raising are those past the ceiling the
       shop itself set. */
    if (D.gt(limit, D.ZERO) && D.gt(owed, limit)) {
      overdueCount += 1
      overdueValue = D.add(overdueValue, owed)
    }
  }
  if (overdueCount > 0) {
    out.push({
      kind: 'overdue',
      severity: 'soon',
      title: `${overdueCount} customer${overdueCount === 1 ? '' : 's'} are over their credit limit`,
      detail: 'Past the ceiling the shop set for them. Nothing stops a sale; this is a prompt to ask.',
      count: overdueCount,
      amount: money(overdueValue),
      href: '/customers?view=over',
    })
  }

  let claims = 0
  let claimValue = D.ZERO
  for (const r of inputs.supplierReturns) {
    if (r.kind !== 'EXPIRY_CLAIM' || r.status !== 'POSTED') continue
    if (r.creditReceived !== null) continue
    claims += 1
    claimValue = D.add(claimValue, D.dec(r.netAmount))
  }
  if (claims > 0) {
    out.push({
      kind: 'claimsUnsettled',
      severity: 'soon',
      title: `${claims} expiry claim${claims === 1 ? '' : 's'} have had nothing back`,
      detail: 'The goods went to the supplier and no credit note has arrived. Unchased, this is money written off by default.',
      count: claims,
      amount: money(claimValue),
      href: '/purchases?tab=returns',
    })
  }

  // -------------------------------------------------------------- orders ---

  let lateOrders = 0
  for (const o of inputs.purchaseOrders) {
    if (o.status !== 'OPEN' && o.status !== 'PART') continue
    /* Only orders that named a date. An order with no agreed date cannot be
       late, and calling it late is the screen inventing a commitment. */
    if (o.expectedOn === null) continue
    if (o.expectedOn < inputs.today) lateOrders += 1
  }
  if (lateOrders > 0) {
    out.push({
      kind: 'ordersOverdue',
      severity: 'soon',
      title: `${lateOrders} order${lateOrders === 1 ? '' : 's'} are past their delivery date`,
      detail: 'The stock has not arrived and the reorder engine is still counting it as on its way.',
      count: lateOrders,
      amount: null,
      href: '/purchases?tab=order',
    })
  }

  // ----------------------------------------------------------- the drawer ---

  if (inputs.todayClose === null && inputs.invoicesToday > 0 && inputs.hour >= CLOSING_HOUR) {
    out.push({
      kind: 'dayUnclosed',
      severity: 'now',
      title: `Today has not been closed — ${inputs.invoicesToday} bill${inputs.invoicesToday === 1 ? '' : 's'} taken`,
      detail: 'The drawer has not been counted. A count done tomorrow is not a count: the variance it produces belongs to two days at once.',
      count: inputs.invoicesToday,
      amount: null,
      href: '/sales',
    })
  }

  /* Legal and cash problems first, then this week's work; within each, the
     larger count. Sorting by money would put a big near-expiry number above
     expired stock, which has the priority exactly backwards. */
  return out.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'now' ? -1 : 1) || b.count - a.count)
}

/** What the bell's badge shows: the things that are a problem TODAY. */
export const urgentCount = (items: readonly AttentionItem[]): number =>
  items.filter((i) => i.severity === 'now').length
