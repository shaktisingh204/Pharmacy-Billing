import type { Pct } from '@contract'
import * as D from './decimal'
import type { Decimal } from './decimal'

/**
 * Indian GST arithmetic for MRP-inclusive retail pricing.
 *
 * The printed MRP on a strip is tax-INCLUSIVE and is a legal ceiling: you may not
 * sell above it. So the taxable value is back-calculated out of the amount the
 * customer actually pays, never built up from a base price.
 *
 * Every split here is taken as a RESIDUAL rather than computed independently:
 *
 *     taxable  = round(inclusive / (1 + r/100), 2)
 *     taxTotal = inclusive - taxable          <- residual, not round(taxable*r)
 *     cgst     = round(taxTotal / 2, 2)
 *     sgst     = taxTotal - cgst              <- residual again
 *
 * Computing each independently lets `taxable + cgst + sgst` miss `inclusive` by a
 * paisa, which shows up as an invoice that does not foot, a GSTR-1 rate-wise total
 * that disagrees with the sum of the lines, and a reprint that differs from the
 * original. Taking residuals makes those impossible by construction.
 */

export interface TaxSplit {
  taxableValue: Decimal
  cgst: Decimal
  sgst: Decimal
  igst: Decimal
  taxTotal: Decimal
  /** The inclusive amount this split came from. Always equals taxable + taxes. */
  inclusive: Decimal
}

/**
 * Split a GST-inclusive amount at `ratePct`.
 *
 * @param interState IGST replaces CGST+SGST; it is never both, and never neither.
 */
export function splitInclusive(inclusive: Decimal, ratePct: Pct, interState: boolean): TaxSplit {
  const r = D.dec(ratePct)
  const divisor = D.add(D.ONE, D.div(r, D.HUNDRED))
  const taxableValue = D.round(D.div(inclusive, divisor), 2)
  const taxTotal = D.sub(inclusive, taxableValue)

  if (interState) {
    return { taxableValue, cgst: D.ZERO, sgst: D.ZERO, igst: taxTotal, taxTotal, inclusive }
  }
  const cgst = D.round(D.div(taxTotal, D.dec(2)), 2)
  const sgst = D.sub(taxTotal, cgst)
  return { taxableValue, cgst, sgst, igst: D.ZERO, taxTotal, inclusive }
}

/**
 * Per-unit MRP at 4dp.
 *
 * Four places, not two, is load-bearing. A 12-tablet pack at MRP 100.00 is 8.3333
 * per tablet; storing 8.33 and selling the full strip yields 99.96, so the customer
 * is charged less than the price printed on the box they are holding. At 4dp,
 * 8.3333 x 12 = 99.9996 which rounds to exactly 100.00.
 */
export function mrpPerUnit(mrpPerPack: Decimal, unitsPerPack: number): Decimal {
  if (unitsPerPack <= 0) throw new RangeError('unitsPerPack must be positive')
  return D.round(D.div(mrpPerPack, D.dec(unitsPerPack)), 4)
}

export interface TaxRateRow {
  hsnCode: string
  effectiveFrom: string
  effectiveTo: string | null
  ratePct: Pct
  notificationRef: string
}

/**
 * Resolve the OUTPUT rate by INVOICE DATE, never from the batch or the product.
 *
 * Slabs move. A batch bought while its HSN sat at one rate must be SOLD at whatever
 * rate is in force on the day of sale, and a credit note against that sale must
 * reverse at the ORIGINAL sale's rate. A `gst_rate` column on the product cannot
 * express any of that, which is why there isn't one.
 */
export function resolveGstRate(
  hsnCode: string,
  invoiceDate: string,
  rates: readonly TaxRateRow[],
): { ratePct: Pct; notificationRef: string } {
  const hit = rates.find(
    (r) =>
      r.hsnCode === hsnCode &&
      r.effectiveFrom <= invoiceDate &&
      (r.effectiveTo === null || invoiceDate <= r.effectiveTo),
  )
  if (!hit) {
    throw new Error(
      `no GST rate for HSN ${hsnCode} on ${invoiceDate} — seed/tax_rates is incomplete`,
    )
  }
  return { ratePct: hit.ratePct, notificationRef: hit.notificationRef }
}

/**
 * Apportion a bill-level amount across lines in proportion to their value, using
 * largest-remainder so the parts sum to EXACTLY the total.
 *
 * Rounding each share independently loses or invents paise, and a bill discount
 * that does not sum to itself makes the tax breakup disagree with the total.
 */
export function apportion(total: Decimal, weights: readonly Decimal[]): Decimal[] {
  const weightSum = D.sum(weights)
  if (D.isZero(weightSum) || D.isZero(total)) return weights.map(() => D.ZERO)

  // Classic largest-remainder: truncate every share, then hand the leftover paise
  // to the shares that lost the most. Rounding each share instead can over-allocate
  // and then need clawing back, and the claw-back order is arbitrary.
  const exact = weights.map((w) => D.div(D.mul(total, w), weightSum))
  const parts = exact.map((e) => D.trunc(e, 2))

  const paisa = D.dec('0.01')
  const step = D.isNeg(total) ? D.neg(paisa) : paisa
  let drift = D.sub(total, D.sum(parts))

  // Ties break on the original index: the same cart must apportion identically on
  // every re-quote, and identically in Rust.
  const order = exact
    .map((e, i) => ({ i, rem: D.abs(D.sub(e, parts[i] ?? D.ZERO)) }))
    .sort((a, b) => D.cmp(b.rem, a.rem) || a.i - b.i)

  for (const { i } of order) {
    if (D.isZero(drift)) break
    parts[i] = D.add(parts[i] ?? D.ZERO, step)
    drift = D.sub(drift, step)
  }
  return parts
}

/**
 * Round the payable to the nearest rupee and return the adjustment.
 * Bounded to ±0.50 by construction; the invoice shows it as an explicit line
 * because an unexplained rupee is the single most common counter dispute.
 */
export function roundOff(net: Decimal): { rounded: Decimal; adjustment: Decimal } {
  const rounded = D.round(net, 0)
  return { rounded, adjustment: D.sub(rounded, net) }
}
