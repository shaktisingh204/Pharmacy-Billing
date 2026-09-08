import { describe, expect, it } from 'vitest'
import { SEED_MEDICINES, generateBatches } from '../../../seed/medicines'
import { isValidEan13 } from '@/lib/gs1'
import * as D from '@/domain/decimal'
import { buildTaxRates } from './bootstrap'
import { resolveGstRate } from '@/domain/gst'

const TODAY = new Date(2026, 8, 8)
const withIds = SEED_MEDICINES.map((m, i) => ({ ...m, id: i + 1 }))
const batches = generateBatches(withIds, TODAY)

describe('seed data integrity', () => {
  it('has a realistic catalogue size', () => {
    expect(SEED_MEDICINES.length).toBeGreaterThan(1200)
  })

  it('is deterministic: two runs produce identical batches', () => {
    expect(JSON.stringify(generateBatches(withIds, TODAY))).toBe(JSON.stringify(batches))
  })

  it('every barcode is a valid EAN-13', () => {
    const bad = SEED_MEDICINES.flatMap((m) => m.barcodes).filter((b) => b.length === 13 && !isValidEan13(b))
    expect(bad).toEqual([])
  })

  it('every expiry is the LAST DAY of its printed month', () => {
    const bad = batches.filter((b) => {
      const [y, m, d] = b.expiryDate.split('-').map(Number)
      const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate()
      return d !== last
    })
    expect(bad.slice(0, 3)).toEqual([])
  })

  it('mrpPerUnit equals mrpPerPack / unitsPerPack at 4dp', () => {
    const byId = new Map(withIds.map((m) => [m.id, m]))
    const bad = batches.filter((b) => {
      const m = byId.get(b.medicineId)
      if (!m) return true
      const expected = D.toStr(D.round(D.div(D.dec(b.mrpPerPack), D.dec(m.unitsPerPack)), 4), 4)
      return expected !== D.toStr(D.dec(b.mrpPerUnit), 4)
    })
    expect(bad.slice(0, 3)).toEqual([])
  })

  it('no money field is a JS number', () => {
    const bad = batches.filter((b) =>
      [b.mrpPerPack, b.mrpPerUnit, b.ptrPerUnit, b.landedCostPerUnit, b.qtyOnHand]
        .some((v) => typeof v !== 'string'))
    expect(bad).toEqual([])
  })

  it('has enough medicines with two live batches at DIFFERENT MRPs', () => {
    // The case the batch-chip strip and the reprice warning exist for.
    const live = batches.filter((b) => b.expiryDate >= '2026-09-08' && !b.isQuarantined && Number(b.qtyOnHand) > 0)
    const byMed = new Map<number, Set<string>>()
    for (const b of live) {
      const s = byMed.get(b.medicineId) ?? new Set()
      s.add(b.mrpPerPack)
      byMed.set(b.medicineId, s)
    }
    const multi = [...byMed.values()].filter((s) => s.size > 1).length
    expect(multi).toBeGreaterThanOrEqual(40)
  })

  it('exercises the expiry buckets and the out-of-stock path', () => {
    const expired = batches.filter((b) => b.expiryDate < '2026-09-08').length
    expect(expired).toBeGreaterThan(0)
    const stocked = new Set(batches.filter((b) => Number(b.qtyOnHand) > 0 && b.expiryDate >= '2026-09-08').map((b) => b.medicineId))
    const outOfStock = withIds.filter((m) => !stocked.has(m.id)).length
    expect(outOfStock).toBeGreaterThan(20)
  })

  it('saleRank is skewed, not flat — search ranking depends on it', () => {
    const ranks = SEED_MEDICINES.map((m) => m.saleRank).sort((a, b) => b - a)
    const top = ranks.slice(0, 20).reduce((a, b) => a + b, 0)
    const total = ranks.reduce((a, b) => a + b, 0)
    expect(top / total).toBeGreaterThan(0.05)
  })

  it('schedule and requiresPrescription agree, and H1/X exist', () => {
    const contradictions = SEED_MEDICINES.filter(
      (m) => (m.drugSchedule === 'OTC') === m.requiresPrescription,
    )
    expect(contradictions.slice(0, 3)).toEqual([])
    expect(SEED_MEDICINES.filter((m) => m.drugSchedule === 'H1').length).toBeGreaterThanOrEqual(25)
    expect(SEED_MEDICINES.filter((m) => m.drugSchedule === 'X').length).toBeGreaterThanOrEqual(3)
  })
})

describe('tax rate coverage', () => {
  it('every HSN code in the catalogue resolves to a rate on any plausible date', () => {
    // Regression: the rate list was hand-written with 30042000 while the catalogue
    // used 30042099. resolveGstRate threw, the quote failed, and the totals rail
    // rendered a confident ₹0.00 — the most dangerous failure mode at a till.
    const rates = buildTaxRates(SEED_MEDICINES.map((m) => m.hsnCode))
    const dates = ['2025-08-01', '2025-09-22', '2026-09-08']
    for (const m of SEED_MEDICINES) {
      for (const d of dates) {
        expect(() => resolveGstRate(m.hsnCode, d, rates)).not.toThrow()
      }
    }
  })

  it('produces a genuinely mixed-rate catalogue, not one flat slab', () => {
    const rates = buildTaxRates(SEED_MEDICINES.map((m) => m.hsnCode))
    const today = new Set(
      SEED_MEDICINES.map((m) => resolveGstRate(m.hsnCode, '2026-09-08', rates).ratePct),
    )
    // A real pharmacy bill mixes nil-rated, 5% and 18%; the GST breakup panel and
    // the filing both depend on that being true.
    expect(today.size).toBeGreaterThanOrEqual(3)
    expect(today.has('0')).toBe(true)
    expect(today.has('18')).toBe(true)
  })

  it('models a slab change so the resolve-by-invoice-date path is exercised', () => {
    const rates = buildTaxRates(['30049099'])
    expect(resolveGstRate('30049099', '2025-08-01', rates).ratePct).toBe('12')
    expect(resolveGstRate('30049099', '2026-09-08', rates).ratePct).toBe('5')
  })
})
