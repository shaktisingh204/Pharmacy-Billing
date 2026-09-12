import { describe, expect, it } from 'vitest'
import {
  MAX_POLICY_DISCOUNT,
  checkEffectiveFrom,
  checkRules,
  diffRules,
  discretionOver,
  explainDiscount,
  needsApproval,
  pendingRevisions,
  resolveDiscount,
  revisionInForce,
  shortOfPolicy,
} from './pricePolicy'
import type { PriceRevision, PriceRule } from './pricePolicy'

/**
 * The chain's price list.
 *
 * Two properties carry the feature and most of these tests are about one or the
 * other: the list PRICES EVERY MEDICINE DETERMINISTICALLY (most specific wins,
 * and a tie is refused at publication rather than resolved by array order), and
 * it never reaches a bill that was posted before it started.
 */

const rule = (over: Partial<PriceRule> = {}): PriceRule => ({
  scope: 'ALL', target: '', label: 'Everything else', discountPct: '5', ...over,
})

const DOLO = { id: 101, manufacturer: 'Micro Labs' }
const AZEE = { id: 202, manufacturer: 'Cipla' }

describe('which discount a medicine sells at', () => {
  const rules: PriceRule[] = [
    rule({ scope: 'ALL', target: '', discountPct: '3' }),
    rule({ scope: 'COMPANY', target: 'Cipla', label: 'Cipla', discountPct: '9' }),
    rule({ scope: 'MEDICINE', target: '202', label: 'Azee 500', discountPct: '12' }),
  ]

  it('lets the MOST SPECIFIC rule win, whatever order the list arrives in', () => {
    // The list is ALL-first here on purpose: a walk over the rules rather than
    // over the scopes would price the whole chain at the fallback.
    expect(resolveDiscount(rules, AZEE)).toBe('12')
  })

  it('falls back a level at a time', () => {
    const noItem = rules.filter((r) => r.scope !== 'MEDICINE')
    expect(resolveDiscount(noItem, AZEE)).toBe('9')      // company
    expect(resolveDiscount(noItem, DOLO)).toBe('3')      // everything else
  })

  it('prices at ZERO when nothing matches, rather than leaving the line alone', () => {
    // A list that silently declines to price something is the failure this
    // feature exists to end.
    expect(resolveDiscount([rule({ scope: 'COMPANY', target: 'Cipla' })], DOLO)).toBe('0')
    expect(resolveDiscount([], DOLO)).toBe('0')
  })

  it('treats a company typed differently as the same company', () => {
    // HQ types it once and a distributor's importer types it again.
    const messy = [rule({ scope: 'COMPANY', target: '  CIPLA  ', discountPct: '9' })]
    expect(resolveDiscount(messy, AZEE)).toBe('9')
  })

  it('names the rule that decided, so the screen never re-derives it', () => {
    const { rule: won } = explainDiscount(rules, AZEE)
    expect(won?.scope).toBe('MEDICINE')
    expect(won?.label).toBe('Azee 500')
  })

  it('says NOTHING decided rather than inventing a rule at zero', () => {
    expect(explainDiscount([], DOLO)).toEqual({ rule: null, discountPct: '0' })
  })
})

describe('what may be published', () => {
  it('accepts a clean list', () => {
    expect(checkRules([rule({ discountPct: '7.5' })])).toEqual([])
  })

  it('REFUSES a negative discount — it would sell above the printed MRP', () => {
    // The whole reason the chain pushes discounts and not prices.
    const [bad] = checkRules([rule({ discountPct: '-2' })])
    expect(bad?.reason).toMatch(/above the printed MRP/)
  })

  it('refuses a percentage that is obviously a typo', () => {
    const [bad] = checkRules([rule({ discountPct: String(MAX_POLICY_DISCOUNT + 1) })])
    expect(bad?.reason).toMatch(/free quantity/)
  })

  it('refuses a discount that is not a number, without crashing on it', () => {
    // The validator is handed the typo by definition; a parser that throws on
    // its own input is no parser.
    expect(checkRules([rule({ discountPct: 'ten' })])[0]?.reason).toMatch(/Not a number/)
    expect(checkRules([rule({ discountPct: '' })])[0]?.reason).toMatch(/Not a number/)
  })

  it('refuses TWO rules for one target, naming the first', () => {
    // Resolution takes the first match. That is only safe because this exists —
    // otherwise the price depends on which row somebody typed first.
    const dup = [
      rule({ scope: 'COMPANY', target: 'Cipla', discountPct: '9' }),
      rule({ scope: 'COMPANY', target: ' cipla ', discountPct: '4' }),
    ]
    const [bad] = checkRules(dup)
    expect(bad?.index).toBe(1)
    expect(bad?.reason).toMatch(/Already priced by rule 1/)
  })

  it('does not confuse a medicine id with a company of the same text', () => {
    expect(checkRules([
      rule({ scope: 'MEDICINE', target: '202' }),
      rule({ scope: 'COMPANY', target: '202' }),
    ])).toEqual([])
  })

  it('refuses a targeted rule with no target', () => {
    expect(checkRules([rule({ scope: 'COMPANY', target: '  ' })])[0]?.reason).toMatch(/which company/)
  })

  it('reports every fault at once rather than one per publish attempt', () => {
    expect(checkRules([rule({ discountPct: '-1' }), rule({ discountPct: 'x' })])).toHaveLength(3)
  })
})

describe('when a list starts', () => {
  it('refuses to BACK-DATE a price list', () => {
    // Bills are already posted at the old price; a list claiming to have priced
    // them makes the register disagree with the policy that produced it.
    expect(checkEffectiveFrom('2026-09-08', '2026-09-09')).toMatch(/cannot start in the past/)
  })

  it('allows today and any future day', () => {
    expect(checkEffectiveFrom('2026-09-09', '2026-09-09')).toBeNull()
    expect(checkEffectiveFrom('2026-10-01', '2026-09-09')).toBeNull()
  })

  it('refuses a date it cannot read', () => {
    expect(checkEffectiveFrom('next monday', '2026-09-09')).toMatch(/Pick a date/)
  })
})

describe('which revision a bill is priced by', () => {
  const rev = (over: Partial<PriceRevision>): PriceRevision => ({
    id: 'r1', serial: 1, publishedAt: '2026-09-01T00:00:00.000Z', publishedBy: 'HQ',
    effectiveFrom: '2026-09-01', note: '', rules: [], ...over,
  })

  const march = rev({ id: 'a', serial: 1, effectiveFrom: '2026-03-01' })
  const sept = rev({ id: 'b', serial: 2, effectiveFrom: '2026-09-01' })
  const oct = rev({ id: 'c', serial: 3, effectiveFrom: '2026-10-01' })

  it('uses the BILL\'s date, not today', () => {
    // The same rule the tax rate follows. Correcting a March bill in September
    // must not reprice it at September's list.
    expect(revisionInForce([march, sept, oct], '2026-05-05')?.id).toBe('a')
    expect(revisionInForce([march, sept, oct], '2026-09-09')?.id).toBe('b')
  })

  it('ignores a revision that has not started', () => {
    expect(revisionInForce([march, sept, oct], '2026-09-30')?.id).toBe('b')
    expect(revisionInForce([oct], '2026-09-30')).toBeNull()
  })

  it('breaks a same-day tie by serial, so the LATER publication wins', () => {
    const first = rev({ id: 'x', serial: 4, effectiveFrom: '2026-09-01' })
    const second = rev({ id: 'y', serial: 5, effectiveFrom: '2026-09-01' })
    expect(revisionInForce([second, first], '2026-09-02')?.id).toBe('y')
  })

  it('has no list at all before the first one starts', () => {
    // Not "assume zero discount was a policy". Nothing was published.
    expect(revisionInForce([march], '2026-01-01')).toBeNull()
  })

  it('lists what is coming, soonest first', () => {
    expect(pendingRevisions([oct, march, sept], '2026-09-09').map((r) => r.id)).toEqual(['c'])
  })
})

describe('what changed between two lists', () => {
  const before: PriceRule[] = [
    rule({ scope: 'COMPANY', target: 'Cipla', label: 'Cipla', discountPct: '9' }),
    rule({ scope: 'COMPANY', target: 'Sun Pharma', label: 'Sun Pharma', discountPct: '6' }),
    rule({ scope: 'ALL', target: '', label: 'Everything else', discountPct: '3' }),
  ]

  it('reports only what MOVED', () => {
    const after = [
      rule({ scope: 'COMPANY', target: 'Cipla', label: 'Cipla', discountPct: '7' }),
      rule({ scope: 'COMPANY', target: 'Sun Pharma', label: 'Sun Pharma', discountPct: '6' }),
      rule({ scope: 'ALL', target: '', label: 'Everything else', discountPct: '3' }),
    ]
    expect(diffRules(before, after)).toEqual([
      { kind: 'CHANGED', scope: 'COMPANY', target: 'Cipla', label: 'Cipla', from: '9', to: '7' },
    ])
  })

  it('does not call a REORDERED or relabelled rule a price change', () => {
    // The branch cares about the price, not about the spreadsheet.
    const after = [
      rule({ scope: 'ALL', target: '', label: 'All other items', discountPct: '3' }),
      rule({ scope: 'COMPANY', target: 'Sun Pharma', label: 'Sun', discountPct: '6' }),
      rule({ scope: 'COMPANY', target: 'CIPLA', label: 'Cipla Ltd', discountPct: '9.00' }),
    ]
    expect(diffRules(before, after)).toEqual([])
  })

  it('reports a REMOVED rule, because removal is a price change', () => {
    // Whatever it covered falls through to the next scope, or to zero.
    const gone = diffRules(before, before.filter((r) => r.target !== 'Cipla'))
    expect(gone).toHaveLength(1)
    expect(gone[0]).toMatchObject({ kind: 'REMOVED', label: 'Cipla', from: '9', to: null })
  })

  it('reports an added rule', () => {
    const added = diffRules(before, [...before, rule({ scope: 'MEDICINE', target: '5', label: 'Azee', discountPct: '12' })])
    expect(added).toEqual([
      { kind: 'ADDED', scope: 'MEDICINE', target: '5', label: 'Azee', from: null, to: '12' },
    ])
  })

  it('orders the changes most-specific first, so the sharpest edits read first', () => {
    const after = [
      rule({ scope: 'MEDICINE', target: '5', label: 'Azee', discountPct: '12' }),
      rule({ scope: 'COMPANY', target: 'Cipla', label: 'Cipla', discountPct: '7' }),
      rule({ scope: 'ALL', target: '', label: 'Everything else', discountPct: '4' }),
    ]
    // Four changes, not three: dropping Sun Pharma from the list IS one of them.
    expect(diffRules(before, after).map((c) => `${c.scope} ${c.kind}`)).toEqual([
      'MEDICINE ADDED', 'COMPANY CHANGED', 'COMPANY REMOVED', 'ALL CHANGED',
    ])
  })

  it('treats a first list as all additions rather than as no change', () => {
    expect(diffRules([], before)).toHaveLength(3)
  })
})

describe('the chain price versus the operator\'s own discount', () => {
  it('does not count the CHAIN\'s discount against the operator', () => {
    // The chain's 10% off Cipla is the shop's price. A cashier capped at 5%
    // must still be able to bill it, or most of the staff cannot sell at the
    // price list at all.
    expect(discretionOver('10', '10')).toBe('0.00')
    expect(needsApproval('10', '10', '0')).toBe(false)
  })

  it('counts only what the operator added on top', () => {
    expect(discretionOver('13', '10')).toBe('3.00')
    expect(needsApproval('13', '10', '5')).toBe(false)
    expect(needsApproval('16', '10', '5')).toBe(true)
  })

  it('reads a cap of ZERO as "bill at the list price", not "no discounts"', () => {
    // Zero is a real and common answer for a new cashier, so it must not be a
    // sentinel for unset.
    expect(needsApproval('9', '9', '0')).toBe(false)
    expect(needsApproval('9.01', '9', '0')).toBe(true)
  })

  it('flags a line billed SHORT of the list without blocking it', () => {
    // The customer paid more, the till is not short — worth seeing, not worth
    // stopping the queue for.
    expect(shortOfPolicy('4', '9')).toBe(true)
    expect(discretionOver('4', '9')).toBe('0.00')
    expect(needsApproval('4', '9', '0')).toBe(false)
  })

  it('survives a blank or missing percentage on either side', () => {
    expect(discretionOver('', '')).toBe('0.00')
    expect(needsApproval('7', '', '5')).toBe(true)
  })
})
