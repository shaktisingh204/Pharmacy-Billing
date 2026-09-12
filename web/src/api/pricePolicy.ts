import type { IsoDate, Pct, PriceRevision, PriceRule, PriceScope } from '@contract'
import * as D from '@/domain/decimal'

/**
 * The chain's selling price, decided once and pushed to every branch.
 *
 * A chain that sets its prices at the counter does not have prices, it has
 * habits: the same strip goes out at 8% off in one shop and 3% in another, the
 * customer who visits both notices, and nobody can say what the chain's margin
 * actually is. So HQ publishes a PRICE LIST and every branch bills against it.
 *
 * Three things constrain the design, and they are all consequences of the fact
 * that this is Indian retail pharmacy rather than general retail:
 *
 *  - MRP IS PRINTED ON THE STRIP AND CANNOT BE PUSHED. The customer pays what is
 *    in their hand, and the batch already carries that number as part of its
 *    identity. So the list never sets a price; it sets a DISCOUNT off the MRP
 *    the batch already has. A rule that could raise a rate above the printed MRP
 *    would be an offence, so a negative discount is not representable.
 *
 *  - A REVISION IS A DOCUMENT, not a settings field. It is published, dated,
 *    and thereafter immutable — changing a price means publishing again, exactly
 *    as correcting an invoice means a credit note. That is what makes "what were
 *    we charging in March" answerable at all.
 *
 *  - THE PUSH MUST NEVER BLOCK BILLING. It is data arriving over a link that is
 *    explicitly allowed to be down for a week. A branch that has not received
 *    the newest revision keeps billing on the one it holds, and says so; it does
 *    not stop, and it does not guess forward.
 *
 * Everything in this module is pure. `localAdapter` stores the revisions and the
 * screens render them; the resolution, the conflict check and the diff are here
 * so they can be tested without a database and reproduced by the server later.
 */

/* ------------------------------------------------------------------ rules --- */

/*
 * The shapes come from the contract, they are not restated here.
 *
 * Three scope levels and deliberately not more: a chain's price list is argued
 * about in a meeting, and every extra dimension is another cell somebody has to
 * fill in and nobody can audit. Medicine beats company beats everything.
 *
 * Re-exported so a screen importing the resolution also gets the types it
 * resolves over — one import, and no chance of a second hand-written copy.
 */
export type { PriceRevision, PriceRule, PriceScope }

/** Most specific first. The order IS the precedence — see `resolveDiscount`. */
export const SCOPE_ORDER: readonly PriceScope[] = ['MEDICINE', 'COMPANY', 'ALL']

export const SCOPE_LABEL: Record<PriceScope, string> = {
  MEDICINE: 'One medicine',
  COMPANY: 'A company',
  ALL: 'Everything else',
}

/* ------------------------------------------------------------ resolution --- */

/** What a medicine needs to carry for a rule to be matched against it. */
export interface Priceable {
  id: number
  manufacturer: string
}

const ZERO_PCT: Pct = '0'

/**
 * A percentage, or null when it is not one.
 *
 * `D.dec` THROWS on a non-decimal string, which is correct for a money path
 * where bad input must never be quietly zeroed — but this module's whole job on
 * the validation side is to be handed the typo and describe it. A parser that
 * crashes on the input it exists to reject is no parser.
 */
function parsePct(value: string | null | undefined): D.Decimal | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return D.dec(value)
  } catch {
    return null
  }
}

/** A percentage that has already been validated, or zero. Never throws. */
const pctOr0 = (value: string | null | undefined): D.Decimal => parsePct(value) ?? D.ZERO

/**
 * The discount this medicine sells at under this rule set.
 *
 * Most specific wins, and the loop is over `SCOPE_ORDER` rather than over the
 * rules: a list that happens to arrive with the ALL rule first must not price
 * the whole chain at the fallback. Within a scope the first match wins, which is
 * safe only because `checkRules` refuses to publish two rules for one target.
 *
 * No match is 0%, not "leave it alone". A price list that silently declines to
 * price something is the failure this feature exists to end.
 */
export function resolveDiscount(rules: readonly PriceRule[], medicine: Priceable): Pct {
  return explainDiscount(rules, medicine).discountPct
}

/** Which rule in a scope a medicine would answer to, or null if the scope cannot match it. */
function targetKeyFor(scope: PriceScope, medicine: Priceable): string | null {
  if (scope === 'MEDICINE') return String(medicine.id)
  if (scope === 'COMPANY') return medicine.manufacturer
  return ''
}

/* A company is typed by a human at HQ and again by a distributor's importer, so
   "Cipla", "cipla " and "CIPLA" are one company. Medicine ids are compared the
   same way harmlessly — an id has no case and no spaces to lose. */
const normalize = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ')
const sameTarget = (a: string, b: string): boolean => normalize(a) === normalize(b)

/**
 * The rule that actually decided a price, and the price itself.
 *
 * "Why is this line at 9%" is the question a branch manager asks, and this is
 * the ONE place the precedence is implemented — `resolveDiscount` is a view of
 * it. Two walks of the same rule list is how the number on the bill and the
 * explanation beside it come to disagree.
 */
export function explainDiscount(
  rules: readonly PriceRule[],
  medicine: Priceable,
): { rule: PriceRule | null; discountPct: Pct } {
  for (const scope of SCOPE_ORDER) {
    const key = targetKeyFor(scope, medicine)
    if (key === null) continue
    const hit = rules.find((r) => r.scope === scope && sameTarget(r.target, key))
    if (hit) return { rule: hit, discountPct: hit.discountPct }
  }
  return { rule: null, discountPct: ZERO_PCT }
}

/* ------------------------------------------------------------ validation --- */

export interface RuleRejection {
  /** Index into the rule list, or -1 for a fault of the revision itself. */
  index: number
  reason: string
}

/**
 * The deepest discount a price list may express.
 *
 * Not 100: a line at 100% off is a free good, which travels as free quantity on
 * its own column with its own tax treatment, and expressing it as a discount
 * would put a zero-value line in the tax breakup. 90 is arbitrary but it is the
 * arbitrary number that is obviously not a typo, and the message says so.
 */
export const MAX_POLICY_DISCOUNT = 90

/**
 * Everything wrong with a rule list. Empty means it can be published.
 *
 * Checked at PUBLISH rather than at resolution, deliberately. A revision is
 * immutable once it is out, so a duplicate that survives publication is wrong in
 * every branch until somebody publishes again — whereas a rejection here is one
 * person fixing one cell before anybody bills against it.
 */
export function checkRules(rules: readonly PriceRule[]): RuleRejection[] {
  const rejected: RuleRejection[] = []
  const seen = new Map<string, number>()

  rules.forEach((rule, index) => {
    if (rule.scope !== 'ALL' && rule.target.trim() === '') {
      rejected.push({ index, reason: `Pick which ${rule.scope === 'MEDICINE' ? 'medicine' : 'company'} this rule is for.` })
    }

    const pct = parsePct(rule.discountPct)
    if (pct === null) {
      rejected.push({ index, reason: 'Not a number — write the discount as a percentage, like 7.5.' })
    } else if (D.isNeg(pct)) {
      /* The whole reason discounts and not prices are pushed. A negative
         discount is a markup, and a rate above the printed MRP is an offence,
         not a pricing decision. */
      rejected.push({ index, reason: 'A negative discount would sell above the printed MRP.' })
    } else if (D.gt(pct, D.dec(MAX_POLICY_DISCOUNT))) {
      rejected.push({
        index,
        reason: `${rule.discountPct}% off is almost certainly a typo. `
          + `A price list stops at ${MAX_POLICY_DISCOUNT}%; a genuinely free item goes out as free quantity.`,
      })
    }

    const key = `${rule.scope} ${normalize(rule.target)}`
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
    } else {
      rejected.push({
        index,
        reason: `Already priced by rule ${first + 1}. Two rules for one ${rule.scope === 'ALL' ? 'list' : 'target'} `
          + 'means the price depends on which one is read first.',
      })
    }
  })

  return rejected
}

/**
 * Whether a revision may be published on this day.
 *
 * Back-dating is refused rather than clamped. A list effective last Tuesday
 * would claim to have priced bills that were posted at a different discount, and
 * the register would then disagree with the policy that supposedly produced it.
 */
export function checkEffectiveFrom(effectiveFrom: IsoDate, today: IsoDate): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return 'Pick a date for this list to start.'
  if (effectiveFrom < today) {
    return 'A price list cannot start in the past — bills are already posted at the old price.'
  }
  return null
}

/* -------------------------------------------------------- what is in force --- */

/**
 * The revision a bill dated `on` is priced by.
 *
 * By the BILL's date, not by now, and the same rule the tax rate follows: a
 * revision that starts tomorrow must not reprice a bill being corrected today.
 * Ties on the same effective date are broken by serial, so publishing twice in
 * one day means the later publication wins rather than an arbitrary one.
 */
export function revisionInForce(
  revisions: readonly PriceRevision[],
  on: IsoDate,
): PriceRevision | null {
  const live = revisions.filter((r) => r.effectiveFrom <= on)
  if (live.length === 0) return null
  return live.reduce((best, r) => {
    if (r.effectiveFrom !== best.effectiveFrom) return r.effectiveFrom > best.effectiveFrom ? r : best
    return r.serial > best.serial ? r : best
  })
}

/** Revisions published but not yet started, soonest first — the branch's warning. */
export function pendingRevisions(
  revisions: readonly PriceRevision[],
  on: IsoDate,
): PriceRevision[] {
  return revisions
    .filter((r) => r.effectiveFrom > on)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.serial - b.serial)
}

/* -------------------------------------------------------------- the diff --- */

export type ChangeKind = 'ADDED' | 'REMOVED' | 'CHANGED'

export interface RuleChange {
  kind: ChangeKind
  scope: PriceScope
  target: string
  label: string
  /** Absent on ADDED. */
  from: Pct | null
  /** Absent on REMOVED. */
  to: Pct | null
}

/**
 * What actually moved between two revisions.
 *
 * A branch handed a hundred-rule list learns nothing; a branch told "Cipla went
 * 9% → 7%, three items removed" can check the three prices that changed. This is
 * the difference between a push somebody reads and a push somebody dismisses.
 *
 * A rule whose percentage is unchanged is NOT a change even if it was retyped,
 * reordered, or its label was corrected — the branch cares about the price.
 */
export function diffRules(
  before: readonly PriceRule[],
  after: readonly PriceRule[],
): RuleChange[] {
  const key = (r: PriceRule) => `${r.scope} ${normalize(r.target)}`
  const old = new Map(before.map((r) => [key(r), r]))
  const changes: RuleChange[] = []

  for (const rule of after) {
    const prev = old.get(key(rule))
    if (!prev) {
      changes.push({ kind: 'ADDED', scope: rule.scope, target: rule.target, label: rule.label, from: null, to: rule.discountPct })
    } else if (!D.eq(pctOr0(prev.discountPct), pctOr0(rule.discountPct))) {
      changes.push({ kind: 'CHANGED', scope: rule.scope, target: rule.target, label: rule.label, from: prev.discountPct, to: rule.discountPct })
    }
    old.delete(key(rule))
  }

  for (const gone of old.values()) {
    /* A removed rule is a price CHANGE, not a tidy-up: whatever it covered falls
       through to the next scope, or to zero. Listing it as "removed" without
       that consequence is how a branch is surprised at the counter. */
    changes.push({ kind: 'REMOVED', scope: gone.scope, target: gone.target, label: gone.label, from: gone.discountPct, to: null })
  }

  return changes.sort(
    (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
      || a.label.localeCompare(b.label),
  )
}

/* ------------------------------------------------------------ discretion --- */

/**
 * How much of a line's discount was the OPERATOR's, not the chain's.
 *
 * This is the distinction that makes a price list compatible with a discount
 * ceiling. The chain's 10% off Cipla is the shop's price — a cashier capped at
 * 5% must still be able to sell at it, or the price list would be unbillable by
 * most of the staff. What the cap governs is what the cashier adds ON TOP.
 *
 * Below the policy is not discretion in this sense: the customer paid more, the
 * till is not short, and the register shows it. It is worth seeing, which is why
 * `shortOfPolicy` exists, but it is not what a ceiling is for.
 */
export function discretionOver(applied: Pct, policy: Pct): Pct {
  const over = D.sub(pctOr0(applied), pctOr0(policy))
  return D.toStr(D.isNeg(over) ? D.ZERO : over, 2)
}

/** True when a line was billed at LESS than the chain's discount — visible, never blocked. */
export function shortOfPolicy(applied: Pct, policy: Pct): boolean {
  return D.lt(pctOr0(applied), pctOr0(policy))
}

/**
 * Whether this person may apply this discount without a second signature.
 *
 * `maxDiscountPct` of 0 is a real answer and the common one for a new cashier:
 * it means "bill at the list price, nothing else", NOT "no discounts at all".
 */
export function needsApproval(applied: Pct, policy: Pct, maxDiscountPct: Pct): boolean {
  return D.gt(D.dec(discretionOver(applied, policy)), pctOr0(maxDiscountPct))
}
