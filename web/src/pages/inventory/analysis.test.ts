import { describe, expect, it } from 'vitest'
import type { BatchRow, StockMovement } from '@contract'
import {
  AGE_BANDS, bandOf, compareRack, daysSince, deadStock, groupByRack, idleDays,
  marginPct, readBatchAge, sharePct, summariseAgeing, totalUnits, totalValue, valueOf,
} from './analysis'

/**
 * Hand-written fixtures, never the seed — the same rule the API tests follow. A
 * test that reads the demo catalogue stops asserting what an ageing band MEANS
 * and starts asserting what the generator happened to produce this week.
 */

const TODAY = '2026-09-08'

function row(id: number, over: Partial<BatchRow['batch']> = {}, med: Partial<BatchRow['medicine']> = {}): BatchRow {
  const batch: BatchRow['batch'] = {
    id,
    storeId: 1,
    medicineId: id,
    batchNo: `B${id}`,
    expiryDate: '2027-06-30',
    mrpPerPack: '100.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '10',
    isQuarantined: false,
    ...over,
  }
  const medicine: BatchRow['medicine'] = {
    id: batch.medicineId,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: null,
    compositionText: 'Amlodipine 5mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '5mg',
    packLabel: '10x10',
    unitsPerPack: 10,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A-1',
    reorderLevel: 100,
    saleRank: 0,
    isActive: true,
    ...med,
  }
  return {
    batch,
    medicine,
    daysToExpiry: 295,
    bucket: 'ok',
    valueAtMrp: '100.00',
    valueAtCost: '60.00',
  }
}

function movement(over: Partial<StockMovement> & Pick<StockMovement, 'at' | 'qtyDelta'>): StockMovement {
  return {
    id: 1,
    batchId: 1,
    batchNo: 'B1',
    medicineId: 1,
    brandName: 'Brand 1',
    balanceAfter: '10',
    reason: 'SALE',
    refType: 'SALE_INVOICE',
    refId: 'x',
    note: null,
    ...over,
  }
}

describe('valuation basis', () => {
  it('reads the two bases off the row rather than recomputing either', () => {
    const r = row(1)
    expect(valueOf(r, 'cost')).toBe('60.00')
    expect(valueOf(r, 'mrp')).toBe('100.00')
  })

  it('sums a shelf at whichever basis is asked for', () => {
    const rows = [row(1), row(2)]
    expect(totalValue(rows, 'cost')).toBe('120.00')
    expect(totalValue(rows, 'mrp')).toBe('200.00')
    expect(totalUnits(rows)).toBe('20.000')
  })

  it('skips a value it cannot parse instead of reading it as zero', () => {
    const broken = { ...row(1), valueAtCost: '' }
    expect(totalValue([broken, row(2)], 'cost')).toBe('60.00')
  })

  it('leaves an emptied batch out of every total', () => {
    const empty = row(3, { qtyOnHand: '0' })
    expect(groupByRack([row(1), empty], 'cost')[0]?.rows).toHaveLength(1)
  })

  it('states margin over the retail price, which is how a distributor quotes it', () => {
    expect(marginPct('100.00', '60.00')).toBe('40.0')
    // Not a ratio at all when there is no retail price to be a share of.
    expect(marginPct('0.00', '60.00')).toBeNull()
  })

  it('refuses to express a share of nothing', () => {
    expect(sharePct('10.00', '40.00')).toBe('25.0')
    expect(sharePct('0.00', '0.00')).toBeNull()
  })
})

describe('readBatchAge', () => {
  it('separates the last movement from the last movement OUT', () => {
    // A second receipt onto the same lot is recent activity and is not a sale:
    // the batch has still not left the shelf since June.
    const age = readBatchAge(1, [
      movement({ at: '2026-09-01T10:00:00.000Z', qtyDelta: '25', reason: 'PURCHASE' }),
      movement({ at: '2026-06-02T10:00:00.000Z', qtyDelta: '-5' }),
      movement({ at: '2026-01-04T10:00:00.000Z', qtyDelta: '50', reason: 'OPENING' }),
    ])
    expect(age.receivedAt).toBe('2026-01-04T10:00:00.000Z')
    expect(age.lastMovedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(age.lastIssuedAt).toBe('2026-06-02T10:00:00.000Z')
    expect(age.movements).toBe(3)
  })

  it('ignores rows belonging to another batch', () => {
    const age = readBatchAge(1, [movement({ at: '2026-09-01T10:00:00.000Z', qtyDelta: '-1', batchId: 2 })])
    expect(age.lastIssuedAt).toBeNull()
    expect(age.movements).toBe(0)
  })

  it('has no opinion about a batch with no ledger at all', () => {
    const age = readBatchAge(1, [])
    expect(idleDays(age, TODAY)).toBeNull()
  })
})

describe('idleDays', () => {
  it('measures from the last movement OUT', () => {
    const age = readBatchAge(1, [
      movement({ at: '2026-09-01T10:00:00.000Z', qtyDelta: '25', reason: 'PURCHASE' }),
      movement({ at: '2026-08-29T10:00:00.000Z', qtyDelta: '-5' }),
    ])
    expect(idleDays(age, TODAY)).toBe(10)
  })

  it('ages a never-sold batch from the day it arrived', () => {
    const age = readBatchAge(1, [movement({ at: '2026-03-08T10:00:00.000Z', qtyDelta: '50', reason: 'OPENING' })])
    expect(idleDays(age, TODAY)).toBe(184)
  })

  it('never reports a negative age for a movement stamped later today', () => {
    expect(daysSince('2026-09-08T23:30:00.000Z', TODAY)).toBe(0)
  })
})

describe('age bands', () => {
  it('are disjoint, so unlike the expiry windows they do add up', () => {
    expect(bandOf(30)?.key).toBe('a30')
    expect(bandOf(31)?.key).toBe('a60')
    expect(bandOf(180)?.key).toBe('a180')
    expect(bandOf(181)?.key).toBe('a181')
    expect(bandOf(null)).toBeNull()
    expect(AGE_BANDS).toHaveLength(5)
  })

  it('splits a shelf into bands and reports each band as a share of the aged value', () => {
    const ages = new Map([
      [1, readBatchAge(1, [movement({ at: '2026-09-01T10:00:00.000Z', qtyDelta: '-1', batchId: 1 })])],
      [2, readBatchAge(2, [movement({ at: '2026-01-01T10:00:00.000Z', qtyDelta: '-1', batchId: 2 })])],
    ])
    const s = summariseAgeing([row(1), row(2)], ages, 'cost', TODAY)
    expect(s.agedBatches).toBe(2)
    expect(s.agedValue).toBe('120.00')
    expect(s.bands.find((b) => b.band.key === 'a30')?.batches).toBe(1)
    expect(s.bands.find((b) => b.band.key === 'a181')?.batches).toBe(1)
    expect(s.bands.find((b) => b.band.key === 'a181')?.sharePct).toBe('50.0')
    expect(s.oldestDays).toBe(250)
  })

  it('counts a batch the ledger cannot place rather than dropping it', () => {
    const s = summariseAgeing([row(1)], new Map(), 'cost', TODAY)
    expect(s.unknown).toBe(1)
    expect(s.agedBatches).toBe(0)
    expect(s.agedValue).toBe('0.00')
  })
})

describe('deadStock', () => {
  const ages = new Map([
    [1, readBatchAge(1, [movement({ at: '2026-09-06T10:00:00.000Z', qtyDelta: '-1', batchId: 1 })])],
    [2, readBatchAge(2, [movement({ at: '2026-02-01T10:00:00.000Z', qtyDelta: '-1', batchId: 2 })])],
    [3, readBatchAge(3, [movement({ at: '2026-05-01T10:00:00.000Z', qtyDelta: '-1', batchId: 3 })])],
  ])

  it('lists only what has not moved for the threshold, valued at the chosen basis', () => {
    const dead = deadStock([row(1), row(2), row(3)], ages, 'cost', TODAY, 90)
    expect(dead.rows.map((d) => d.row.batch.id)).toEqual([2, 3])
    expect(dead.value).toBe('120.00')
    expect(dead.sharePct).toBe('66.7')
  })

  it('sorts by money, because that is the order the list gets worked', () => {
    const rich = { ...row(3), valueAtCost: '900.00' }
    const dead = deadStock([row(2), rich], ages, 'cost', TODAY, 90)
    expect(dead.rows.map((d) => d.row.batch.id)).toEqual([3, 2])
  })

  it('includes quarantined stock — held money that never got returned is the point', () => {
    const held = row(2, { isQuarantined: true })
    expect(deadStock([held], ages, 'cost', TODAY, 90).rows).toHaveLength(1)
  })

  it('reports what it could not judge instead of calling it alive', () => {
    const dead = deadStock([row(1), row(9)], ages, 'cost', TODAY, 30)
    expect(dead.unknown).toBe(1)
    expect(dead.judged).toBe(1)
    expect(dead.rows).toHaveLength(0)
  })

  it('values the same shelf higher at MRP, and says nothing else changes', () => {
    const atCost = deadStock([row(2)], ages, 'cost', TODAY, 90)
    const atMrp = deadStock([row(2)], ages, 'mrp', TODAY, 90)
    expect(atCost.value).toBe('60.00')
    expect(atMrp.value).toBe('100.00')
    expect(atMrp.rows).toHaveLength(atCost.rows.length)
  })
})

describe('groupByRack', () => {
  it('sorts racks the way somebody walks them, so A-10 follows A-9', () => {
    expect(['A-10', 'A-9', 'A-2'].sort(compareRack)).toEqual(['A-2', 'A-9', 'A-10'])
  })

  it('groups by rack and counts what to pull off each shelf', () => {
    const groups = groupByRack([
      row(1, { expiryDate: '2026-09-20' }, { rackLocation: 'B-2' }),
      row(2, {}, { rackLocation: 'A-1' }),
      row(3, {}, { rackLocation: 'A-1' }),
    ].map((r, i) => (i === 0 ? { ...r, bucket: 'd30' as const } : r)), 'cost')

    expect(groups.map((g) => g.rack)).toEqual(['A-1', 'B-2'])
    expect(groups[0]?.skus).toBe(2)
    expect(groups[0]?.value).toBe('120.00')
    expect(groups[1]?.urgent).toBe(1)
  })

  it('puts the unracked pile last — it is a data gap, not a shelf', () => {
    const groups = groupByRack([
      row(1, {}, { rackLocation: null }),
      row(2, {}, { rackLocation: 'Z-9' }),
    ], 'cost')
    expect(groups.map((g) => g.rack)).toEqual(['Z-9', null])
  })

  it('treats a blank rack string as unracked rather than as its own shelf', () => {
    const groups = groupByRack([
      row(1, {}, { rackLocation: '   ' }),
      row(2, {}, { rackLocation: null }),
    ], 'cost')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.rack).toBeNull()
    expect(groups[0]?.rows).toHaveLength(2)
  })
})
