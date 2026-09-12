import { describe, expect, it } from 'vitest'
import { CHANGE_DENOMINATIONS, amountInWords, changeBreakdown } from './words'

/**
 * `amountInWords` is covered end to end by `src/print/receipt.test.ts`, which is
 * where it was born. What is new — and what a counter reads out loud while a
 * queue watches — is the note breakdown.
 */
describe('changeBreakdown', () => {
  it('counts the notes back largest first', () => {
    expect(changeBreakdown('870.00')).toEqual([
      { value: 500, count: 1 },
      { value: 200, count: 1 },
      { value: 100, count: 1 },
      { value: 50, count: 1 },
      { value: 20, count: 1 },
    ])
  })

  it('repeats a denomination rather than inventing one', () => {
    // ₹400 is two two-hundreds, not a note the RBI does not print.
    expect(changeBreakdown('400')).toEqual([{ value: 200, count: 2 }])
  })

  it('drops paise: a drawer with round-off on never owes them', () => {
    expect(changeBreakdown('105.60')).toEqual([
      { value: 100, count: 1 },
      { value: 5, count: 1 },
    ])
  })

  it('is empty for nothing owed, for a negative, and for a non-amount', () => {
    expect(changeBreakdown('0.00')).toEqual([])
    expect(changeBreakdown('-50.00')).toEqual([])
    expect(changeBreakdown('not money')).toEqual([])
  })

  /*
   * Greedy is only the RIGHT answer because the Indian note set happens to be
   * canonical — 500 does not divide into 200, so that is a fact about this
   * particular set and not about greedy algorithms. Checked against a true
   * minimum rather than asserted, so that adding a denomination that breaks it
   * fails here instead of quietly handing back more paper than necessary.
   */
  it('hands back the fewest possible notes', () => {
    const denoms = [...CHANGE_DENOMINATIONS]
    const LIMIT = 1000
    const best = new Array<number>(LIMIT + 1).fill(Number.MAX_SAFE_INTEGER)
    best[0] = 0
    for (let n = 1; n <= LIMIT; n += 1) {
      for (const d of denoms) {
        if (d <= n) best[n] = Math.min(best[n] as number, (best[n - d] as number) + 1)
      }
    }
    for (let n = 1; n <= LIMIT; n += 1) {
      const greedy = changeBreakdown(String(n)).reduce((sum, x) => sum + x.count, 0)
      expect(greedy, `${n} rupees`).toBe(best[n])
    }
  })

  it('always adds back up to the rupees it was given', () => {
    for (const amount of ['1', '17', '283', '999', '1234', '10000']) {
      const total = changeBreakdown(amount).reduce((sum, n) => sum + n.value * n.count, 0)
      expect(total).toBe(Number(amount))
    }
  })
})

describe('amountInWords at the counter', () => {
  it('spells change the way it is said across a counter', () => {
    expect(amountInWords('245.50')).toBe('Two Hundred Forty Five Rupees and Fifty Paise Only')
  })
})
