import { describe, expect, it } from 'vitest'
import type { Batch, Customer, DayClose, Medicine, PurchaseOrder, SupplierReturn } from '@contract'
import { attentionItems, urgentCount } from './attention'
import type { AttentionInputs } from './attention'

/**
 * The bell only works if it is usually quiet. Half these tests are about what it
 * REFUSES to raise, because a permanently lit indicator is one nobody reads.
 */

const TODAY = '2026-09-09'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  return {
    id, storeId: 1, brandName: `Brand ${id}`, genericName: null,
    compositionText: 'x', manufacturer: 'Acme', form: 'Tablet', strengthText: '1mg',
    packLabel: '1x10', unitsPerPack: 10, baseUom: 'TAB', allowLooseSale: true, saleStep: '1',
    hsnCode: '30049099', drugSchedule: 'H', requiresPrescription: true, rackLocation: 'A1',
    reorderLevel: 50, saleRank: 0, isActive: true, ...over,
  }
}

function batch(id: number, over: Partial<Batch> = {}): Batch {
  return {
    id, storeId: 1, medicineId: 1, batchNo: `B${id}`, expiryDate: '2028-06-30',
    mrpPerPack: '100.00', mrpPerUnit: '10.0000', ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000', purchaseGstPct: '12', qtyOnHand: '10',
    isQuarantined: false, ...over,
  }
}

function inputs(over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    batches: [],
    medicineFor: (id) => medicine(id),
    customers: [],
    supplierReturns: [],
    purchaseOrders: [],
    todayClose: null,
    invoicesToday: 0,
    hour: 12,
    today: TODAY,
    ...over,
  }
}

const kinds = (over: Partial<AttentionInputs> = {}) =>
  attentionItems(inputs(over)).map((i) => i.kind)

const find = (over: Partial<AttentionInputs>, kind: string) =>
  attentionItems(inputs(over)).find((i) => i.kind === kind)

describe('a quiet shop raises nothing', () => {
  it('says nothing at all when everything is in order', () => {
    expect(attentionItems(inputs())).toEqual([])
    expect(urgentCount([])).toBe(0)
  })
})

describe('stock', () => {
  it('puts expired stock first, because it is a legal problem not a commercial one', () => {
    const list = attentionItems(inputs({
      batches: [
        batch(1, { expiryDate: '2026-08-31' }),
        batch(2, { expiryDate: '2026-09-20' }),
      ],
      customers: [{ id: 1, outstanding: '9999.00', creditLimit: '10.00' } as Customer],
    }))
    expect(list[0]?.kind).toBe('expired')
    expect(list[0]?.severity).toBe('now')
    // A big overdue balance does not outrank a strip a Drug Inspector can find.
    expect(list.findIndex((i) => i.kind === 'overdue')).toBeGreaterThan(0)
  })

  it('values expired stock at LANDED cost — the money actually lost', () => {
    const item = find({ batches: [batch(1, { expiryDate: '2026-08-31', qtyOnHand: '10' })] }, 'expired')
    expect(item?.amount).toBe('60.00')
    expect(item?.count).toBe(1)
  })

  it('does not call an emptied batch expired, however far out of date it is', () => {
    // Nothing on the shelf is nothing to take off it. The line still shows up as
    // out of stock, which is a different fact and the right one.
    const kindsOf = kinds({ batches: [batch(1, { expiryDate: '2020-01-31', qtyOnHand: '0' })] })
    expect(kindsOf).not.toContain('expired')
    expect(kindsOf).not.toContain('nearExpiry')
    expect(kindsOf).toContain('outOfStock')
  })

  it('raises near-expiry only inside the window, not as permanent wallpaper', () => {
    expect(kinds({ batches: [batch(1, { expiryDate: '2026-09-20' })] })).toContain('nearExpiry')
    // Four months out is not news.
    expect(kinds({ batches: [batch(1, { expiryDate: '2027-01-31' })] })).toEqual([])
  })

  it('counts an empty line ONLY when the shop said it stocks it', () => {
    // Every discontinued line in a 2,000-row catalogue is technically out of
    // stock, and listing those buries the ten that matter.
    const empty = [batch(1, { qtyOnHand: '0' })]
    expect(kinds({ batches: empty })).toContain('outOfStock')
    expect(kinds({ batches: empty, medicineFor: (id) => medicine(id, { reorderLevel: 0 }) }))
      .not.toContain('outOfStock')
    expect(kinds({ batches: empty, medicineFor: (id) => medicine(id, { isActive: false }) }))
      .not.toContain('outOfStock')
  })

  it('does not call a line empty when another batch of it has stock', () => {
    expect(kinds({ batches: [batch(1, { qtyOnHand: '0' }), batch(2, { qtyOnHand: '5' })] }))
      .not.toContain('outOfStock')
  })
})

describe('money', () => {
  it('raises a customer OVER their limit, not merely one who owes', () => {
    // Half a shop's customers carry a khata balance permanently.
    const owing = [{ id: 1, outstanding: '500.00', creditLimit: '5000.00' } as Customer]
    expect(kinds({ customers: owing })).not.toContain('overdue')

    const over = [{ id: 1, outstanding: '6000.00', creditLimit: '5000.00' } as Customer]
    expect(find({ customers: over }, 'overdue')?.amount).toBe('6000.00')
  })

  it('ignores a customer with no limit set — there is no ceiling to be past', () => {
    expect(kinds({ customers: [{ id: 1, outstanding: '9999.00', creditLimit: '0.00' } as Customer] }))
      .not.toContain('overdue')
  })

  it('chases an expiry claim that has had nothing back', () => {
    const claim = {
      id: 1, kind: 'EXPIRY_CLAIM', status: 'POSTED', netAmount: '4000.00', creditReceived: null,
    } as SupplierReturn
    expect(find({ supplierReturns: [claim] }, 'claimsUnsettled')?.amount).toBe('4000.00')
  })

  it('stops chasing one that has been settled, however short', () => {
    const settled = {
      id: 1, kind: 'EXPIRY_CLAIM', status: 'POSTED', netAmount: '4000.00',
      creditReceived: '3000.00',
    } as SupplierReturn
    expect(kinds({ supplierReturns: [settled] })).not.toContain('claimsUnsettled')
  })

  it('never chases a debit note — it settles when it is raised', () => {
    const dn = {
      id: 1, kind: 'PURCHASE_RETURN', status: 'POSTED', netAmount: '400.00', creditReceived: null,
    } as SupplierReturn
    expect(kinds({ supplierReturns: [dn] })).not.toContain('claimsUnsettled')
  })
})

describe('orders', () => {
  const order = (over: Partial<PurchaseOrder>): PurchaseOrder => ({
    id: 1, orderNo: 'PO1', storeId: 1, supplierId: 1, supplierName: 'S',
    placedOn: '2026-09-01', expectedOn: '2026-09-05', createdAt: '', operatorName: 'A',
    note: null, status: 'OPEN', lines: [], ...over,
  })

  it('raises an order past the date it promised', () => {
    expect(kinds({ purchaseOrders: [order({})] })).toContain('ordersOverdue')
  })

  it('never calls an order late when no date was agreed', () => {
    // Calling it late would be the screen inventing a commitment.
    expect(kinds({ purchaseOrders: [order({ expectedOn: null })] })).not.toContain('ordersOverdue')
  })

  it('ignores an order already received or cancelled', () => {
    expect(kinds({ purchaseOrders: [order({ status: 'RECEIVED' })] })).not.toContain('ordersOverdue')
    expect(kinds({ purchaseOrders: [order({ status: 'CANCELLED' })] })).not.toContain('ordersOverdue')
  })
})

describe('the day close', () => {
  it('says nothing at two in the afternoon — the shop is simply still open', () => {
    // Complaining early is the fastest way to teach staff to ignore the bell.
    expect(kinds({ invoicesToday: 40, hour: 14 })).not.toContain('dayUnclosed')
  })

  it('raises it in the evening once money has been taken', () => {
    const item = find({ invoicesToday: 40, hour: 21 }, 'dayUnclosed')
    expect(item?.severity).toBe('now')
    // The count is in the TITLE now, which is where every other item carries it.
    expect(item?.title).toContain('40 bills')
  })

  it('says nothing on an evening with no trade', () => {
    expect(kinds({ invoicesToday: 0, hour: 21 })).not.toContain('dayUnclosed')
  })

  it('says nothing once the drawer has been counted', () => {
    expect(kinds({ invoicesToday: 40, hour: 21, todayClose: {} as DayClose }))
      .not.toContain('dayUnclosed')
  })
})

describe('the badge', () => {
  it('counts only what is a problem TODAY', () => {
    const list = attentionItems(inputs({
      batches: [batch(1, { expiryDate: '2026-08-31' }), batch(2, { expiryDate: '2026-09-20' })],
    }))
    expect(list).toHaveLength(2)
    // Near-expiry is this week's work and must not light the badge.
    expect(urgentCount(list)).toBe(1)
  })
})

describe('every item', () => {
  it('states a number and points at the screen that fixes it', () => {
    const list = attentionItems(inputs({
      batches: [batch(1, { expiryDate: '2026-08-31' }), batch(2, { qtyOnHand: '0' })],
      customers: [{ id: 1, outstanding: '6000.00', creditLimit: '5000.00' } as Customer],
      invoicesToday: 5,
      hour: 22,
    }))
    expect(list.length).toBeGreaterThan(2)
    for (const item of list) {
      expect(item.count, item.kind).toBeGreaterThan(0)
      expect(item.href, item.kind).toMatch(/^\//)
      expect(item.title, item.kind).toMatch(/\d/)
    }
  })
})
