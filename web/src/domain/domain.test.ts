import { describe, expect, it } from 'vitest'
import vectors from '../../../contract/fixtures/tax-vectors.json'
import * as D from './decimal'
import { apportion, mrpPerUnit, resolveGstRate, roundOff, splitInclusive } from './gst'
import type { TaxRateRow } from './gst'
import { allocateFefo, fefoOrder } from './fefo'
import type { Batch } from '@contract'

/**
 * These run the SAME contract/fixtures/tax-vectors.json that crates/domain will
 * run in Phase 4. If the two engines ever disagree, one of these files fails.
 */

describe('golden fixtures — splitInclusive', () => {
  for (const v of vectors.splitInclusive) {
    it(v.name, () => {
      const got = splitInclusive(D.dec(v.inclusive), v.ratePct, v.interState)
      expect(D.toStr(got.taxableValue)).toBe(v.taxableValue)
      expect(D.toStr(got.cgst)).toBe(v.cgst)
      expect(D.toStr(got.sgst)).toBe(v.sgst)
      expect(D.toStr(got.igst)).toBe(v.igst)

      // The invariant the whole design exists to guarantee.
      const refooted = D.sum([got.taxableValue, got.cgst, got.sgst, got.igst])
      expect(D.toStr(refooted)).toBe(D.toStr(D.dec(v.inclusive)))
    })
  }
})

describe('golden fixtures — mrpPerUnit', () => {
  for (const v of vectors.mrpPerUnit) {
    it(`${v.mrpPerPack} over ${v.unitsPerPack} units`, () => {
      const unit = mrpPerUnit(D.dec(v.mrpPerPack), v.unitsPerPack)
      expect(D.toStr(unit, 4)).toBe(v.expected)
      // Selling the whole pack must total the price printed on the pack.
      const full = D.round(D.mul(unit, D.dec(v.unitsPerPack)), 2)
      expect(D.toStr(full)).toBe(v.fullPackTotal)
    })
  }
})

describe('golden fixtures — roundOff', () => {
  for (const v of vectors.roundOff) {
    it(`${v.net} rounds to ${v.rounded}`, () => {
      const { rounded, adjustment } = roundOff(D.dec(v.net))
      expect(D.toStr(rounded, 0)).toBe(v.rounded)
      expect(D.toStr(adjustment)).toBe(v.adjustment)
      // Bounded by construction: an unexplained rupee is a counter dispute.
      expect(D.lte(D.abs(adjustment), D.dec('0.50'))).toBe(true)
    })
  }
})

describe('golden fixtures — apportion', () => {
  for (const v of vectors.apportion) {
    it(`${v.total} across ${v.weights.length} weights`, () => {
      const got = apportion(D.dec(v.total), v.weights.map(D.dec))
      expect(got.map((g) => D.toStr(g))).toEqual(v.expected)
      expect(D.toStr(D.sum(got))).toBe(D.toStr(D.dec(v.total)))
    })
  }
})

describe('golden fixtures — decimal', () => {
  for (const v of vectors.decimal) {
    it(`${v.op}(${v.a}${'b' in v ? `, ${v.b}` : ''})`, () => {
      const a = D.dec(v.a)
      if (v.op === 'round') expect(D.toStr(D.round(a, v.dp ?? 2), v.dp ?? 2)).toBe(v.expected)
      if (v.op === 'add') expect(D.toStr(D.add(a, D.dec(v.b ?? '0')))).toBe(v.expected)
      if (v.op === 'mul') expect(D.toStr(D.mul(a, D.dec(v.b ?? '0')))).toBe(v.expected)
      if (v.op === 'div') expect(D.toStr(D.div(a, D.dec(v.b ?? '1')))).toBe(v.expected)
    })
  }
})

describe('tax property: every split foots exactly', () => {
  it('holds over 10,000 pseudo-random (amount, rate) pairs', () => {
    // Deterministic PRNG: a failing case must be reproducible.
    let s = 0x2f6e2b1
    const next = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
    const rates = ['0', '5', '12', '18', '28', '40']
    for (let i = 0; i < 10_000; i += 1) {
      const paise = Math.floor(next() * 5_000_000)
      const inclusive = D.div(D.dec(paise), D.dec(100))
      const rate = rates[Math.floor(next() * rates.length)] ?? '5'
      const inter = next() < 0.3

      const s1 = splitInclusive(inclusive, rate, inter)
      const refooted = D.sum([s1.taxableValue, s1.cgst, s1.sgst, s1.igst])
      expect(D.toStr(refooted)).toBe(D.toStr(inclusive))
      // IGST xor (CGST + SGST) — never both, never neither.
      if (inter) expect(D.isZero(D.add(s1.cgst, s1.sgst))).toBe(true)
      else expect(D.isZero(s1.igst)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------- rates -----

const RATES: TaxRateRow[] = [
  { hsnCode: '30049099', effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', ratePct: '12', notificationRef: 'seed:legacy' },
  { hsnCode: '30049099', effectiveFrom: '2025-09-22', effectiveTo: null, ratePct: '5', notificationRef: 'seed:current' },
]

describe('output GST resolves by INVOICE date, never from the batch', () => {
  it('returns the rate in force on the day of sale', () => {
    expect(resolveGstRate('30049099', '2025-08-01', RATES).ratePct).toBe('12')
    expect(resolveGstRate('30049099', '2026-09-08', RATES).ratePct).toBe('5')
  })

  it('a batch bought under the old rate SELLS at the new one', () => {
    // This is precisely the defect a `gst_rate` column on the product cannot
    // express, and why there isn't one.
    const boughtUnder = resolveGstRate('30049099', '2025-08-15', RATES).ratePct
    const soldUnder = resolveGstRate('30049099', '2026-01-10', RATES).ratePct
    expect(boughtUnder).toBe('12')
    expect(soldUnder).toBe('5')
  })

  it('refuses to guess when the seed is incomplete', () => {
    expect(() => resolveGstRate('99999999', '2026-01-01', RATES)).toThrow(/no GST rate/)
  })
})

// ----------------------------------------------------------------- FEFO -----

const batch = (o: Partial<Batch> & Pick<Batch, 'id' | 'expiryDate' | 'qtyOnHand'>): Batch => ({
  storeId: 1, medicineId: 1, batchNo: `B-${o.id}`, mrpPerPack: '100.00',
  mrpPerUnit: '10.0000', ptrPerUnit: '8.0000', landedCostPerUnit: '7.8000',
  purchaseGstPct: '5', isQuarantined: false, ...o,
})

const TODAY = '2026-09-08'
const OPTS = { today: TODAY, expiryGuardDays: 30 }

describe('FEFO', () => {
  it('orders by expiry, then by id so re-quotes are stable', () => {
    const bs = [
      batch({ id: 3, expiryDate: '2027-05-31', qtyOnHand: '10' }),
      batch({ id: 1, expiryDate: '2027-01-31', qtyOnHand: '10' }),
      batch({ id: 2, expiryDate: '2027-01-31', qtyOnHand: '10' }),
    ]
    expect(fefoOrder(bs, TODAY).map((b) => b.id)).toEqual([1, 2, 3])
  })

  it('never allocates expired or quarantined stock', () => {
    const bs = [
      batch({ id: 1, expiryDate: '2026-08-31', qtyOnHand: '50' }),
      batch({ id: 2, expiryDate: '2027-06-30', qtyOnHand: '50', isQuarantined: true }),
      batch({ id: 3, expiryDate: '2027-12-31', qtyOnHand: '50' }),
    ]
    const r = allocateFefo(bs, D.dec('10'), OPTS)
    expect(r.allocations.map((a) => a.batch.id)).toEqual([3])
  })

  it('holds back stock inside the expiry guard, but uses it rather than refusing a sale', () => {
    const bs = [
      batch({ id: 1, expiryDate: '2026-09-20', qtyOnHand: '5' }), // inside the 30-day guard
      batch({ id: 2, expiryDate: '2027-12-31', qtyOnHand: '4' }),
    ]
    // Fillable from long-dated stock alone: the guarded batch is skipped.
    expect(allocateFefo(bs, D.dec('4'), OPTS).allocations.map((a) => a.batch.id)).toEqual([2])
    // Not fillable otherwise: the guarded batch is used rather than short-shipping.
    expect(allocateFefo(bs, D.dec('9'), OPTS).allocations.map((a) => a.batch.id)).toEqual([2, 1])
  })

  it('reports the shortfall instead of silently under-filling', () => {
    const bs = [batch({ id: 1, expiryDate: '2027-12-31', qtyOnHand: '3' })]
    const r = allocateFefo(bs, D.dec('10'), OPTS)
    expect(D.toStr(r.shortQty, 0)).toBe('7')
  })

  it('flags a split across different printed MRPs', () => {
    const bs = [
      batch({ id: 1, expiryDate: '2027-01-31', qtyOnHand: '2', mrpPerUnit: '10.0000' }),
      batch({ id: 2, expiryDate: '2027-06-30', qtyOnHand: '5', mrpPerUnit: '11.5000' }),
    ]
    expect(allocateFefo(bs, D.dec('5'), OPTS).mixedMrp).toBe(true)
    expect(allocateFefo(bs, D.dec('2'), OPTS).mixedMrp).toBe(false)
  })
})
