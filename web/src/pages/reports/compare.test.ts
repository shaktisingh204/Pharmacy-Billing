import { describe, expect, it } from 'vitest'
import type { ReportHeadline } from '@contract'
import { compareHeadlines, isComparable, whyNotComparable } from './compare'

const h = (label: string, value: string, kind: ReportHeadline['kind'] = 'money'): ReportHeadline =>
  ({ label, value, kind })

describe('isComparable', () => {
  it('allows the reports whose figures move with the period', () => {
    expect(isComparable('DAY_BOOK')).toBe(true)
    expect(isComparable('GST_RATE_SUMMARY')).toBe(true)
  })

  it('refuses the ones that value the shelf or a balance as it stands now', () => {
    // Running these over an earlier window returns TODAY'S stock under an older
    // date, which would be a fabricated trend rather than a comparison.
    expect(isComparable('STOCK_VALUATION')).toBe(false)
    expect(isComparable('NEAR_EXPIRY')).toBe(false)
    expect(isComparable('CUSTOMER_OUTSTANDING')).toBe(false)
    expect(whyNotComparable('STOCK_VALUATION')).toMatch(/as it stands right now/)
    expect(whyNotComparable('NON_MOVING')).toMatch(/same shelf against itself/)
  })
})

describe('compareHeadlines', () => {
  it('pairs by label, not by position', () => {
    // The earlier period had no returns, so its headline list is shorter and a
    // positional pairing would compare Collected against On credit.
    const now = [h('Billed', '1000.00'), h('Returns', '2', 'count'), h('Collected', '900.00')]
    const then = [h('Billed', '800.00'), h('Collected', '800.00')]
    const deltas = compareHeadlines(now, then)

    expect(deltas.map((d) => d.headline.label)).toEqual(['Billed', 'Returns', 'Collected'])
    expect(deltas[0]?.change).toBe('200.00')
    expect(deltas[0]?.changePct).toBe('25.0')
    expect(deltas[1]?.previous).toBeNull()
    expect(deltas[1]?.direction).toBe('unknown')
    expect(deltas[2]?.changePct).toBe('12.5')
  })

  it('reports a fall as a signed movement', () => {
    const deltas = compareHeadlines([h('Billed', '750.00')], [h('Billed', '1000.00')])
    expect(deltas[0]?.change).toBe('-250.00')
    expect(deltas[0]?.changePct).toBe('-25.0')
    expect(deltas[0]?.direction).toBe('down')
  })

  it('never invents a percentage out of zero', () => {
    const deltas = compareHeadlines([h('Billed', '40000.00')], [h('Billed', '0.00')])
    expect(deltas[0]?.change).toBe('40000.00')
    expect(deltas[0]?.changePct).toBeNull()
  })

  it('leaves a text figure alone rather than subtracting dates', () => {
    const deltas = compareHeadlines(
      [h('Best day', '2026-09-03', 'text')],
      [h('Best day', '2026-08-27', 'text')],
    )
    expect(deltas[0]?.previous).toBe('2026-08-27')
    expect(deltas[0]?.change).toBeNull()
    expect(deltas[0]?.direction).toBe('unknown')
  })

  it('has nothing to say when there is no previous period', () => {
    const deltas = compareHeadlines([h('Billed', '1000.00')], null)
    expect(deltas[0]?.previous).toBeNull()
    expect(deltas[0]?.changePct).toBeNull()
  })

  it('counts an unchanged figure as flat rather than as a rise', () => {
    const deltas = compareHeadlines([h('Billed', '1000.00')], [h('Billed', '1000.00')])
    expect(deltas[0]?.direction).toBe('flat')
    expect(deltas[0]?.changePct).toBe('0.0')
  })
})
