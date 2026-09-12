import { describe, expect, it } from 'vitest'
import type { PurchaseOrder } from '@contract'
import { orderedPacks, reconcileOrder } from './purchaseOrders'
import type { KeyedLine } from './purchaseOrders'

/**
 * The gap between what was ordered and what turned up. Every case here is one a
 * distributor's driver is standing at the counter for.
 */

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 1,
    orderNo: 'PO2627-00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani',
    placedOn: '2026-09-01',
    expectedOn: '2026-09-03',
    createdAt: '2026-09-01T05:00:00.000Z',
    operatorName: 'Akib',
    note: null,
    status: 'OPEN',
    lines: [
      {
        lineId: 'o1', medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15',
        qty: '150', receivedQty: '0', basis: 'sells ~90 a month',
      },
      {
        lineId: 'o2', medicineId: 2, brandName: 'Azithral 500', packLabel: '1x5',
        qty: '50', receivedQty: '0', basis: 'customer waiting',
      },
    ],
    ...over,
  }
}

function keyed(over: Partial<KeyedLine> = {}): KeyedLine {
  return { medicineId: 1, qtyPacks: '10', freePacks: '0', unitsPerPack: 15, ...over }
}

describe('receiving against an order', () => {
  it('names the line that did not turn up at all', () => {
    const r = reconcileOrder(order(), [keyed()])
    expect(r.exact).toBe(1)
    expect(r.missing).toBe(1)
    expect(r.lines[1]?.status).toBe('missing')
    expect(r.fillPct).toBe('75.0')
  })

  it('counts free packs as delivered', () => {
    // 9 paid + 1 free of 15 fills a 150-unit line. A fill rate that ignores the
    // scheme under-reports every distributor who runs one.
    const r = reconcileOrder(order(), [keyed({ qtyPacks: '9', freePacks: '1' })])
    expect(r.lines[0]?.status).toBe('exact')
    expect(r.lines[0]?.keyedUnits).toBe('150.00')
  })

  it('calls a short delivery short and an over-supply over', () => {
    const r = reconcileOrder(order(), [
      keyed({ qtyPacks: '6' }),
      keyed({ medicineId: 2, qtyPacks: '12', unitsPerPack: 5 }),
    ])
    expect(r.lines[0]?.status).toBe('short')
    expect(r.lines[0]?.deltaUnits).toBe('-60.00')
    expect(r.lines[1]?.status).toBe('over')
    expect(r.lines[1]?.deltaUnits).toBe('10.00')
    // Over-supply on one line never covers a shortfall on another: they are
    // different medicines. 90 of 150 and a capped 50 of 50 is 140 of 200.
    expect(r.fillPct).toBe('70.0')
  })

  it('counts a keyed medicine that is not on the order', () => {
    const r = reconcileOrder(order(), [keyed(), keyed({ medicineId: 9 })])
    expect(r.extras).toBe(1)
  })

  it('ignores a half-typed quantity rather than reading it as a number', () => {
    // '12.' is a keystroke on the way to 12.5, not twelve.
    const r = reconcileOrder(order(), [keyed({ qtyPacks: '12.' })])
    expect(r.lines[0]?.keyedUnits).toBe('0.00')
    expect(r.lines[0]?.status).toBe('missing')
  })

  it('ignores an unresolved row — a name with no medicine behind it', () => {
    const r = reconcileOrder(order(), [keyed({ medicineId: null })])
    expect(r.missing).toBe(2)
    expect(r.extras).toBe(0)
  })
})

describe('ordered units as packs', () => {
  it('converts when the pack divides the order evenly', () => {
    expect(orderedPacks('150', 15)).toBe('10')
  })

  it('refuses to seed a fraction of a strip', () => {
    // A distributor cannot ship 6.67 packs, and a number nobody typed and
    // nobody checked has no business on a bill.
    expect(orderedPacks('100', 15)).toBeNull()
  })

  it('is null for a pack size that makes no sense', () => {
    expect(orderedPacks('150', 0)).toBeNull()
  })
})
