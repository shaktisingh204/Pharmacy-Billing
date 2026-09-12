import type { ReportHeadline, ReportId } from '@contract'
import * as D from '@/domain/decimal'

/**
 * This period against the one before it.
 *
 * The comparison is the SAME report run twice over two ranges — never a second
 * query, never a stored aggregate — so a figure and its comparison can only ever
 * disagree if the documents did. The screen prints both ranges beside the
 * numbers for the same reason every report prints its basis.
 *
 * Two things this deliberately does not do:
 *
 *  1. IT DOES NOT COLOUR A CHANGE GOOD OR BAD. A dashboard tile can, because it
 *     knows that rising receivables are bad news. A report screen does not: more
 *     output tax charged is more sales, and more purchase value is either a
 *     stock-up or an overstock. Painting an unknowable direction green is the
 *     kind of confident wrongness that stops a report being read at all, so the
 *     delta is stated in words and an arrow, in text colours.
 *  2. IT DOES NOT INVENT A PERCENTAGE OUT OF ZERO. Going from nothing to
 *     ₹40,000 is not "+100%", and "+∞%" is not a figure either. The change is
 *     shown as an absolute movement and the percentage is left out.
 */

/**
 * Reports whose numbers move with the PERIOD, and can therefore be compared.
 *
 * Everything absent from this set values the shelf or a party balance AS IT
 * STANDS NOW: `stockValuation` says so in its own basis, and an outstanding
 * report ages the master balance rather than a historical one. Running either
 * over an earlier window returns today's stock with a different label on it, and
 * a comparison built from that would be a fabricated trend.
 */
const COMPARABLE: ReadonlySet<ReportId> = new Set<ReportId>([
  'DAY_BOOK', 'SALES_BY_DAY', 'ITEM_SALES', 'BATCH_MARGIN',
  'GST_RATE_SUMMARY', 'HSN_SUMMARY', 'PURCHASE_REGISTER', 'H1_REGISTER',
])

export function isComparable(reportId: ReportId): boolean {
  return COMPARABLE.has(reportId)
}

/** Why the comparison is off, in the reader's terms rather than ours. */
export function whyNotComparable(reportId: ReportId): string {
  return reportId === 'NON_MOVING'
    ? 'Non-moving stock already reads a window against the shelf as it stands now, so comparing two windows would compare the same shelf against itself.'
    : 'This report values the shelf, or a balance, as it stands right now. Running it over an earlier period would return today’s figures under an older date, which is not a comparison.'
}

/** Only kinds whose values are decimal strings can be subtracted. */
const NUMERIC: ReadonlySet<ReportHeadline['kind']> = new Set<ReportHeadline['kind']>([
  'money', 'qty', 'pct', 'count',
])

const DECIMALISH = /^-?\d+(\.\d+)?$/

function parse(v: string | undefined): D.Decimal | null {
  if (v === undefined) return null
  const s = v.trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

export interface HeadlineDelta {
  headline: ReportHeadline
  /** The same figure over the previous period, or null when there is none. */
  previous: string | null
  /** Signed movement, in the same units as the value. */
  change: string | null
  /** Signed percentage movement, 1dp. Null when the base was zero. */
  changePct: string | null
  direction: 'up' | 'down' | 'flat' | 'unknown'
}

const dp = (kind: ReportHeadline['kind']): number => (kind === 'qty' ? 3 : kind === 'count' ? 0 : kind === 'pct' ? 1 : 2)

/**
 * Pair this period's headline figures with the previous period's, BY LABEL.
 *
 * Position would be the obvious key and the wrong one: the headline is computed
 * from the filtered rows, so a report that has no credit notes in the earlier
 * window can legitimately produce a shorter list, and pairing by index would
 * then compare "Collected" against "On credit".
 */
export function compareHeadlines(
  current: readonly ReportHeadline[],
  previous: readonly ReportHeadline[] | null,
): HeadlineDelta[] {
  const before = new Map((previous ?? []).map((h) => [h.label, h]))

  return current.map((headline) => {
    const prior = before.get(headline.label)
    const blank: HeadlineDelta = {
      headline,
      previous: prior?.value ?? null,
      change: null,
      changePct: null,
      direction: 'unknown',
    }
    if (previous === null || prior === undefined || !NUMERIC.has(headline.kind)) return blank

    const now = parse(headline.value)
    const then = parse(prior.value)
    if (now === null || then === null) return blank

    const change = D.sub(now, then)
    const digits = dp(headline.kind)
    return {
      headline,
      previous: prior.value,
      change: D.toStr(change, digits),
      // A percentage of nothing is not a percentage. The absolute change above
      // still says what happened, which is the honest half of the answer.
      changePct: D.isZero(then) ? null : D.toStr(D.mul(D.div(change, D.abs(then)), D.HUNDRED), 1),
      direction: D.isZero(change) ? 'flat' : D.isNeg(change) ? 'down' : 'up',
    }
  })
}
