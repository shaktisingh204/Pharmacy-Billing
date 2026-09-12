import type {
  Batch, IsoDate, Medicine, PurchaseOrder, Qty, ReorderSettings, ReorderSuggestion,
  ShortbookEntry,
} from '@contract'
import * as D from '@/domain/decimal'

/**
 * What to order, as pure value logic.
 *
 * Marg offers TWELVE reorder bases — its own formula, sales, all-issues, last
 * year, shortage, today's sale and the rest — and then arbitrates between them
 * by taking whichever yields the largest quantity. That is not twelve features.
 * An operator picks one on the day they are shown the menu, never revisits it,
 * and no screen afterwards says what the number they are about to order came
 * from. The suggestion is then either trusted blindly or overtyped every time,
 * and both make the engine ornamental.
 *
 * So: ONE suggestion, and its working travels with it. `basis` is a sentence in
 * plain words, shown on the row and stored on the order line, so six weeks later
 * the question "why did we order forty of these" has an answer on the document.
 *
 * Four rules, each of which is a real mistake this avoids:
 *
 *  1. SUBTRACT WHAT IS ALREADY ON ORDER. Ordering twice because the first order
 *     has not landed yet is the most expensive error in this whole area and the
 *     hardest to notice — nothing looks wrong until the stock arrives twice.
 *
 *  2. STOCK THAT EXPIRES INSIDE THE COVER WINDOW IS NOT COVER. Forty strips
 *     going out of date in nine days do not cover the next thirty, and counting
 *     them means ordering nothing and then writing the shelf off.
 *
 *  3. A SHORTBOOK ENTRY OUTRANKS THE STATISTICS. Somebody stood at the counter
 *     and asked for it. No trailing average knows that, and a suggestion that
 *     ranks a slow-moving customer request below a fast mover has the priority
 *     exactly backwards.
 *
 *  4. NEVER ORDER ABOVE THE CEILING. `reorderLevel` on the medicine is the
 *     shop's own maximum, and a spike in one week's sales must not turn into a
 *     year of stock — which is precisely what an unbounded days-of-cover formula
 *     does after a viral fever season.
 */

export const DEFAULT_SETTINGS: ReorderSettings = {
  /* Three weeks of cover, one week of lead time. Both are what a Pune retail
     chemist actually runs on: distributors deliver next-day or day-after, and
     holding more than a month ties up money on a shelf that expires. */
  coverDays: 21,
  leadTimeDays: 7,
  /* Sixty days of history. Thirty is too jumpy — one festival week doubles the
     rate — and ninety drags a discontinued line along for a quarter. */
  historyDays: 60,
}

const qty = (d: D.Decimal): Qty => D.toStr(d, 3) as Qty

/** Sale quantities per medicine over the window, as the caller has counted them. */
export interface ReorderInputs {
  medicines: readonly Medicine[]
  batchesOf: (medicineId: number) => readonly Batch[]
  /** Base units sold over `historyDays`. Absent means nothing sold. */
  soldInWindow: ReadonlyMap<number, D.Decimal>
  /** Open purchase-order quantity, in base units, per medicine. */
  onOrder: ReadonlyMap<number, D.Decimal>
  shortbook: readonly ShortbookEntry[]
  /** Who last supplied this medicine, so the order can be split by distributor. */
  lastSupplier: (medicineId: number) => { id: number; name: string } | null
  today: IsoDate
}

const MS_PER_DAY = 86_400_000

function daysUntil(date: IsoDate, today: IsoDate): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY)
}

/**
 * Stock that will still be sellable when it is needed.
 *
 * A batch expiring inside the horizon contributes only the part of itself that
 * could realistically sell before it goes — at the current daily rate. A strip
 * expiring tomorrow contributes one day's sales, not forty units of comfort.
 */
export function usableStock(
  batches: readonly Batch[],
  dailySale: D.Decimal,
  horizonDays: number,
  today: IsoDate,
): D.Decimal {
  let usable = D.ZERO
  for (const batch of batches) {
    if (batch.isQuarantined) continue
    const on = D.dec(batch.qtyOnHand)
    if (!D.gt(on, D.ZERO)) continue
    const left = daysUntil(batch.expiryDate, today)
    if (left <= 0) continue
    if (left >= horizonDays) { usable = D.add(usable, on); continue }
    /* Sellable-before-expiry, capped at what is actually there. With no sales
       history the rate is zero and such a batch contributes nothing — which is
       right: stock that does not move and is about to expire is not cover, it is
       a write-off waiting to be counted. */
    const sellable = D.mul(dailySale, D.dec(String(left)))
    usable = D.add(usable, D.min(on, sellable))
  }
  return usable
}

/** Words, not a formula. This is stored on the order line and printed. */
function describe(v: {
  dailySale: D.Decimal
  onHand: D.Decimal
  usable: D.Decimal
  onOrder: D.Decimal
  shortbookQty: D.Decimal
  daysOfCover: number | null
  horizon: number
  capped: boolean
}): string {
  const parts: string[] = []
  if (D.gt(v.shortbookQty, D.ZERO)) {
    parts.push(`${D.toStr(v.shortbookQty, 0)} asked for at the counter`)
  }
  parts.push(
    D.gt(v.dailySale, D.ZERO)
      ? `sells ~${D.toStr(D.mul(v.dailySale, D.dec('30')), 0)} a month`
      : 'no sales in the window',
  )
  parts.push(`${D.toStr(v.onHand, 0)} on hand`)
  if (D.lt(v.usable, v.onHand)) {
    parts.push(`only ${D.toStr(v.usable, 0)} of it usable before it expires`)
  }
  if (D.gt(v.onOrder, D.ZERO)) parts.push(`${D.toStr(v.onOrder, 0)} already on order`)
  parts.push(
    v.daysOfCover === null ? 'no rate to project' : `${v.daysOfCover} days' cover`,
  )
  parts.push(`covering ${v.horizon} days`)
  if (v.capped) parts.push('capped at the maximum level')
  return parts.join(' · ')
}

export function suggestReorder(
  inputs: ReorderInputs,
  settings: ReorderSettings = DEFAULT_SETTINGS,
): ReorderSuggestion[] {
  const horizon = Math.max(1, settings.coverDays + settings.leadTimeDays)
  const window = Math.max(1, settings.historyDays)

  /* Shortbook demand summed per medicine BEFORE the loop: two customers asking
     for the same thing on different days is two rows and one requirement, and
     reading them one at a time orders for whichever row happened to be last. */
  const wanted = new Map<number, D.Decimal>()
  for (const entry of inputs.shortbook) {
    if (entry.medicineId === null) continue
    wanted.set(entry.medicineId, D.add(wanted.get(entry.medicineId) ?? D.ZERO, D.dec(entry.qty)))
  }

  const out: ReorderSuggestion[] = []
  for (const medicine of inputs.medicines) {
    if (!medicine.isActive) continue

    const sold = inputs.soldInWindow.get(medicine.id) ?? D.ZERO
    const dailySale = D.div(sold, D.dec(String(window)))
    const batches = inputs.batchesOf(medicine.id)
    const onHand = D.sum(batches.filter((b) => !b.isQuarantined).map((b) => D.dec(b.qtyOnHand)))
    const usable = usableStock(batches, dailySale, horizon, inputs.today)
    const onOrder = inputs.onOrder.get(medicine.id) ?? D.ZERO
    const shortbookQty = wanted.get(medicine.id) ?? D.ZERO

    const daysOfCover = D.gt(dailySale, D.ZERO)
      ? Math.floor(Number(D.toStr(D.div(usable, dailySale), 0)))
      : null

    /* The target: enough to cover the horizon, at the current rate, PLUS
       anything a customer is already waiting for. Then take off what is on the
       shelf and what is on its way. */
    const target = D.add(D.mul(dailySale, D.dec(String(horizon))), shortbookQty)
    let need = D.sub(D.sub(target, usable), onOrder)

    /* The ceiling. `reorderLevel` is the shop's own maximum for this line, and
       without it one festival week's rate becomes a year of stock. Zero means
       "not set", never "order nothing" — a shop that has not filled the field in
       must not silently stop being able to order. */
    const ceiling = D.dec(String(medicine.reorderLevel))
    const capped = D.gt(ceiling, D.ZERO) && D.gt(need, ceiling)
    if (capped) need = ceiling

    /* A customer waiting is ordered for even when the statistics say no. This is
       applied AFTER the cap for the same reason it exists at all: somebody is
       standing at the counter, and a maximum-level rule is not a reason to send
       them away. */
    if (D.lt(need, shortbookQty)) need = shortbookQty
    if (!D.gt(need, D.ZERO)) continue

    const perPack = Math.max(1, medicine.unitsPerPack)
    const packs = Math.ceil(Number(D.toStr(need, 3)) / perPack)
    /* Rounded UP to whole packs, and the suggestion is restated in units to
       match — a distributor ships packs, and ordering 7 of a 10-strip pack
       arrives as 10 whether the screen said so or not. */
    const suggested = D.mul(D.dec(String(packs)), D.dec(String(perPack)))

    const supplier = inputs.lastSupplier(medicine.id)
    out.push({
      medicineId: medicine.id,
      brandName: medicine.brandName,
      packLabel: medicine.packLabel,
      onHand: qty(onHand),
      usableOnHand: qty(usable),
      onOrder: qty(onOrder),
      dailySale: qty(dailySale),
      daysOfCover,
      shortbookQty: qty(shortbookQty),
      suggestedQty: qty(suggested),
      suggestedPacks: packs,
      basis: describe({
        dailySale, onHand, usable, onOrder, shortbookQty, daysOfCover, horizon, capped,
      }),
      urgency: D.gt(shortbookQty, D.ZERO) ? 'waiting'
        : !D.gt(usable, D.ZERO) ? 'out'
          : daysOfCover !== null && daysOfCover <= settings.leadTimeDays ? 'low'
            : 'watch',
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
    })
  }

  /* Ordered by URGENCY first, then by how much money the gap represents — a
     customer waiting, then the shelf that is empty, then the one that runs out
     before the next delivery could land. Sorting by value alone buries the
     out-of-stock cheap line that somebody is standing there asking for. */
  const rank: Record<ReorderSuggestion['urgency'], number> = {
    waiting: 0, out: 1, low: 2, watch: 3,
  }
  return out.sort((a, b) =>
    rank[a.urgency] - rank[b.urgency]
    || D.cmp(D.dec(b.suggestedQty), D.dec(a.suggestedQty))
    || a.medicineId - b.medicineId)
}

export const URGENCY_LABEL: Record<ReorderSuggestion['urgency'], string> = {
  waiting: 'Customer waiting',
  out: 'Out of stock',
  low: 'Runs out before delivery',
  watch: 'Getting low',
}

/** Open quantity per medicine across the orders still outstanding. */
export function onOrderQuantities(orders: readonly PurchaseOrder[]): Map<number, D.Decimal> {
  const out = new Map<number, D.Decimal>()
  for (const order of orders) {
    if (order.status === 'CANCELLED' || order.status === 'RECEIVED') continue
    for (const line of order.lines) {
      /* What is OUTSTANDING, not what was ordered. A part-received line has
         already put some of its stock on the shelf, and counting the whole line
         again would under-order for the rest of it. */
      const open = D.sub(D.dec(line.qty), D.dec(line.receivedQty))
      if (!D.gt(open, D.ZERO)) continue
      out.set(line.medicineId, D.add(out.get(line.medicineId) ?? D.ZERO, open))
    }
  }
  return out
}
