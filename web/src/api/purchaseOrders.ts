import type { PurchaseOrder, Qty } from '@contract'
import * as D from '@/domain/decimal'

/**
 * Receiving goods AGAINST an order.
 *
 * An order is a promise and a goods receipt is what actually turned up, and the
 * gap between the two is the only thing on this screen a distributor argues
 * about. Every incumbent lets you raise an order and then key the bill as if the
 * order never existed, so nobody ever finds out that half the lines were dropped
 * — the short line is simply re-ordered next week at the new rate.
 *
 * So the order is laid over the keyed receipt and the differences are named
 * while the delivery man is still at the counter, which is the only moment any
 * of it can be fixed.
 *
 * Pure: the screen owns the draft, this owns the arithmetic.
 */

/** One keyed goods-receipt line, reduced to what the comparison needs. */
export interface KeyedLine {
  medicineId: number | null
  /** Packs charged for. */
  qtyPacks: string
  /** Scheme goods. They arrived, so they count against what was ordered. */
  freePacks: string
  unitsPerPack: number
}

export type OrderLineStatus = 'exact' | 'short' | 'over' | 'missing'

export interface OrderLineCompare {
  medicineId: number
  brandName: string
  packLabel: string
  orderedUnits: Qty
  keyedUnits: Qty
  /** Keyed minus ordered. Negative is short. */
  deltaUnits: Qty
  status: OrderLineStatus
  basis: string
}

export interface OrderReconciliation {
  lines: OrderLineCompare[]
  exact: number
  short: number
  over: number
  missing: number
  /** Keyed medicines that are not on this order at all. */
  extras: number
  orderedUnits: Qty
  keyedUnits: Qty
  /** Delivered as a share of ordered, capped at 100. Null on an empty order. */
  fillPct: string | null
}

const units = (line: KeyedLine): D.Decimal => D.mul(
  D.add(decOrZero(line.qtyPacks), decOrZero(line.freePacks)),
  D.dec(String(line.unitsPerPack || 1)),
)

/** A half-typed cell is not a number. '12.' is a keystroke, not twelve. */
function decOrZero(v: string): D.Decimal {
  const t = (v ?? '').trim()
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return D.ZERO
  return D.dec(t)
}

/**
 * What was ordered against what has been keyed, line by line.
 *
 * Free packs count as delivered. They are on the shelf and they satisfy the
 * demand that caused the order, and a fill rate that ignores a 10+1 scheme
 * under-reports every distributor who runs one — which is all of them.
 */
export function reconcileOrder(
  order: PurchaseOrder,
  keyed: readonly KeyedLine[],
): OrderReconciliation {
  const keyedByMedicine = new Map<number, D.Decimal>()
  for (const line of keyed) {
    if (line.medicineId === null) continue
    const at = keyedByMedicine.get(line.medicineId) ?? D.ZERO
    keyedByMedicine.set(line.medicineId, D.add(at, units(line)))
  }

  let orderedTotal = D.ZERO
  let keyedTotal = D.ZERO
  const lines: OrderLineCompare[] = order.lines.map((line) => {
    const ordered = D.dec(line.qty)
    const got = keyedByMedicine.get(line.medicineId) ?? D.ZERO
    orderedTotal = D.add(orderedTotal, ordered)
    keyedTotal = D.add(keyedTotal, D.min(got, ordered))
    const delta = D.sub(got, ordered)
    const status: OrderLineStatus = D.isZero(got)
      ? 'missing'
      : D.isZero(delta) ? 'exact' : D.isNeg(delta) ? 'short' : 'over'
    return {
      medicineId: line.medicineId,
      brandName: line.brandName,
      packLabel: line.packLabel,
      orderedUnits: D.toStr(ordered, 2),
      keyedUnits: D.toStr(got, 2),
      deltaUnits: D.toStr(delta, 2),
      status,
      basis: line.basis,
    }
  })

  const onOrder = new Set(order.lines.map((l) => l.medicineId))
  const extras = new Set(
    keyed
      .filter((l) => l.medicineId !== null && !onOrder.has(l.medicineId) && D.gt(units(l), D.ZERO))
      .map((l) => l.medicineId as number),
  )

  return {
    lines,
    exact: lines.filter((l) => l.status === 'exact').length,
    short: lines.filter((l) => l.status === 'short').length,
    over: lines.filter((l) => l.status === 'over').length,
    missing: lines.filter((l) => l.status === 'missing').length,
    extras: extras.size,
    orderedUnits: D.toStr(orderedTotal, 2),
    keyedUnits: D.toStr(keyedTotal, 2),
    fillPct: D.isZero(orderedTotal)
      ? null
      : D.toStr(D.min(D.HUNDRED, D.div(D.mul(keyedTotal, D.HUNDRED), orderedTotal)), 1),
  }
}

/**
 * The ordered quantity, in the packs a goods receipt is keyed in.
 *
 * An order counts BASE UNITS — that is what compares against stock and against
 * sales — and a bill is keyed in packs. Where the two do not divide evenly the
 * answer is null rather than a rounded guess: a distributor cannot ship two
 * thirds of a strip, and quietly seeding "6.67" into the packs cell puts a
 * number on the bill that nobody typed and nobody checked.
 */
export function orderedPacks(qty: Qty, unitsPerPack: number): string | null {
  if (!Number.isFinite(unitsPerPack) || unitsPerPack <= 0) return null
  const per = D.dec(String(unitsPerPack))
  const packs = D.div(D.dec(qty), per)
  const whole = D.trunc(packs, 0)
  return D.eq(D.mul(whole, per), D.dec(qty)) ? D.toStr(whole, 0) : null
}
