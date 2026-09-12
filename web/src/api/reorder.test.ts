import { describe, expect, it } from 'vitest'
import type { Batch, Medicine, PurchaseOrder, ShortbookEntry } from '@contract'
import * as D from '@/domain/decimal'
import { DEFAULT_SETTINGS, onOrderQuantities, suggestReorder, usableStock } from './reorder'
import type { ReorderInputs } from './reorder'

/**
 * Each of these is a real reorder mistake, not a unit of arithmetic.
 */

const TODAY = '2026-09-09'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  return {
    id,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: null,
    compositionText: 'Paracetamol 650mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '650mg',
    packLabel: '1x10',
    unitsPerPack: 10,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A1',
    reorderLevel: 0,
    saleRank: 0,
    isActive: true,
    ...over,
  }
}

function batch(id: number, medicineId: number, over: Partial<Batch> = {}): Batch {
  return {
    id,
    storeId: 1,
    medicineId,
    batchNo: `B${id}`,
    expiryDate: '2028-06-30',
    mrpPerPack: '100.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '0',
    isQuarantined: false,
    ...over,
  }
}

function inputs(over: Partial<ReorderInputs> = {}): ReorderInputs {
  return {
    medicines: [medicine(1)],
    batchesOf: () => [],
    soldInWindow: new Map(),
    onOrder: new Map(),
    shortbook: [],
    lastSupplier: () => ({ id: 1, name: 'Sai Distributors' }),
    today: TODAY,
    ...over,
  }
}

const only = (over: Partial<ReorderInputs> = {}) => suggestReorder(inputs(over))[0]

// --------------------------------------------------------------- on order ---

describe('what is already on the way', () => {
  it('SUBTRACTS open order quantity — the most expensive reorder mistake there is', () => {
    // 60 days, 120 sold → 2/day. Horizon 28 days → needs 56. Nothing on hand.
    const base = only({ soldInWindow: new Map([[1, D.dec('120')]]) })
    expect(base?.suggestedQty).toBe('60.000') // 56 rounded up to 6 packs of 10

    // With 50 already ordered and not yet arrived, only the gap is needed.
    const after = only({
      soldInWindow: new Map([[1, D.dec('120')]]),
      onOrder: new Map([[1, D.dec('50')]]),
    })
    expect(after?.suggestedQty).toBe('10.000')
    expect(after?.basis).toContain('50 already on order')
  })

  it('counts the OUTSTANDING part of a part-received order, not the whole line', () => {
    const orders: PurchaseOrder[] = [{
      id: 1, orderNo: 'PO1', storeId: 1, supplierId: 1, supplierName: 'S',
      placedOn: TODAY, expectedOn: null, createdAt: '', operatorName: 'A', note: null,
      status: 'PART',
      lines: [{
        lineId: 'l1', medicineId: 1, brandName: 'B', packLabel: '1x10',
        qty: '100', receivedQty: '60', basis: '',
      }],
    }]
    expect(D.toStr(onOrderQuantities(orders).get(1) ?? D.ZERO, 0)).toBe('40')
  })

  it('ignores a cancelled order entirely', () => {
    const orders: PurchaseOrder[] = [{
      id: 1, orderNo: 'PO1', storeId: 1, supplierId: 1, supplierName: 'S',
      placedOn: TODAY, expectedOn: null, createdAt: '', operatorName: 'A', note: null,
      status: 'CANCELLED',
      lines: [{
        lineId: 'l1', medicineId: 1, brandName: 'B', packLabel: '1x10',
        qty: '100', receivedQty: '0', basis: '',
      }],
    }]
    expect(onOrderQuantities(orders).size).toBe(0)
  })
})

// ----------------------------------------------------------------- expiry ---

describe('stock that expires before it can sell', () => {
  it('is NOT counted as cover', () => {
    // 2/day, horizon 28. Forty units expiring in 5 days cover ten, not forty.
    const dying = [batch(1, 1, { qtyOnHand: '40', expiryDate: '2026-09-14' })]
    const s = only({
      soldInWindow: new Map([[1, D.dec('120')]]),
      batchesOf: () => dying,
    })
    expect(s?.onHand).toBe('40.000')
    expect(s?.usableOnHand).toBe('10.000')
    expect(s?.basis).toContain('only 10 of it usable before it expires')
    // Needs 56, has 10 usable → 46, rounded up to 5 packs.
    expect(s?.suggestedQty).toBe('50.000')
  })

  it('counts stock that outlives the horizon in full', () => {
    const good = [batch(1, 1, { qtyOnHand: '40', expiryDate: '2028-01-31' })]
    expect(usableStock(good, D.dec('2'), 28, TODAY)).toEqual(D.dec('40'))
  })

  it('counts an already-expired batch as nothing at all', () => {
    const gone = [batch(1, 1, { qtyOnHand: '40', expiryDate: '2026-08-31' })]
    expect(usableStock(gone, D.dec('2'), 28, TODAY)).toEqual(D.ZERO)
  })

  it('counts quarantined stock as nothing — it is held, not available', () => {
    const held = [batch(1, 1, { qtyOnHand: '40', isQuarantined: true })]
    expect(usableStock(held, D.dec('2'), 28, TODAY)).toEqual(D.ZERO)
  })

  it('gives a dying batch with NO sales rate no cover at all', () => {
    // Not a pessimism: stock that does not move and is about to expire is a
    // write-off waiting to be counted, never a reason to skip an order.
    const dying = [batch(1, 1, { qtyOnHand: '40', expiryDate: '2026-09-14' })]
    expect(usableStock(dying, D.ZERO, 28, TODAY)).toEqual(D.ZERO)
  })
})

// -------------------------------------------------------------- shortbook ---

describe('a customer standing at the counter', () => {
  const asked: ShortbookEntry[] = [
    { id: 1, medicineId: 1, term: 'Brand 1', qty: '5', at: '', brandName: 'Brand 1', stockQty: '0' },
    { id: 2, medicineId: 1, term: 'Brand 1', qty: '3', at: '', brandName: 'Brand 1', stockQty: '0' },
  ]

  it('sums two requests for ONE medicine rather than reading the last one', () => {
    const s = only({ shortbook: asked })
    expect(s?.shortbookQty).toBe('8.000')
  })

  it('orders for them even when nothing has ever sold', () => {
    // No history, no rate, no statistical reason to order — and somebody asked.
    const s = only({ shortbook: asked })
    expect(s?.suggestedQty).toBe('10.000')
    expect(s?.urgency).toBe('waiting')
    expect(s?.basis).toContain('8 asked for at the counter')
  })

  it('outranks a bigger statistical gap in the ordering', () => {
    const list = suggestReorder(inputs({
      medicines: [medicine(1), medicine(2)],
      soldInWindow: new Map([[2, D.dec('600')]]),
      shortbook: asked,
    }))
    expect(list[0]?.medicineId).toBe(1)
    expect(list[0]?.urgency).toBe('waiting')
  })
})

// ------------------------------------------------------------------- caps ---

describe('the ceiling', () => {
  it('caps a spike at the maximum level instead of ordering a year of stock', () => {
    const s = only({
      medicines: [medicine(1, { reorderLevel: 20 })],
      soldInWindow: new Map([[1, D.dec('600')]]),
    })
    expect(s?.suggestedQty).toBe('20.000')
    expect(s?.basis).toContain('capped at the maximum level')
  })

  it('treats an unset level as UNSET, never as "order nothing"', () => {
    // A shop that has not filled the field in must not silently lose the ability
    // to order.
    const s = only({
      medicines: [medicine(1, { reorderLevel: 0 })],
      soldInWindow: new Map([[1, D.dec('120')]]),
    })
    expect(s?.suggestedQty).toBe('60.000')
  })

  it('still sends a waiting customer their stock above the ceiling', () => {
    const s = only({
      medicines: [medicine(1, { reorderLevel: 2 })],
      shortbook: [{
        id: 1, medicineId: 1, term: 'x', qty: '25', at: '', brandName: 'B', stockQty: '0',
      }],
    })
    expect(Number(s?.suggestedQty)).toBeGreaterThanOrEqual(25)
  })
})

// ------------------------------------------------------------------ packs ---

describe('what a distributor actually ships', () => {
  it('rounds UP to whole packs and says so in units', () => {
    // Needs 56 of a 25-unit pack → 3 packs → 75 units.
    const s = only({
      medicines: [medicine(1, { unitsPerPack: 25, packLabel: '1x25' })],
      soldInWindow: new Map([[1, D.dec('120')]]),
    })
    expect(s?.suggestedPacks).toBe(3)
    expect(s?.suggestedQty).toBe('75.000')
  })

  it('offers nothing for a line that is already covered', () => {
    const stocked = [batch(1, 1, { qtyOnHand: '500' })]
    expect(suggestReorder(inputs({
      soldInWindow: new Map([[1, D.dec('120')]]),
      batchesOf: () => stocked,
    }))).toEqual([])
  })

  it('skips a discontinued medicine even when it is out of stock', () => {
    expect(suggestReorder(inputs({ medicines: [medicine(1, { isActive: false })] }))).toEqual([])
  })
})

// ---------------------------------------------------------------- working ---

describe('the working, which is the whole point', () => {
  it('says in words where the number came from', () => {
    const s = only({
      soldInWindow: new Map([[1, D.dec('120')]]),
      batchesOf: () => [batch(1, 1, { qtyOnHand: '14' })],
      onOrder: new Map([[1, D.dec('6')]]),
    })
    expect(s?.basis).toContain('sells ~60 a month')
    expect(s?.basis).toContain('14 on hand')
    expect(s?.basis).toContain('6 already on order')
    expect(s?.basis).toContain("7 days' cover")
    expect(s?.basis).toContain('covering 28 days')
  })

  it('does not invent a days-of-cover for something that never sells', () => {
    const s = only({
      shortbook: [{ id: 1, medicineId: 1, term: 'x', qty: '4', at: '', brandName: 'B', stockQty: '0' }],
      batchesOf: () => [batch(1, 1, { qtyOnHand: '9' })],
    })
    expect(s?.daysOfCover).toBeNull()
    expect(s?.basis).toContain('no rate to project')
  })

  it('uses a horizon of cover PLUS lead time, not cover alone', () => {
    expect(DEFAULT_SETTINGS.coverDays + DEFAULT_SETTINGS.leadTimeDays).toBe(28)
    const s = only({ soldInWindow: new Map([[1, D.dec('120')]]) })
    // 2/day × 28 = 56, not 2 × 21 = 42. Ordering for cover alone runs the shelf
    // dry for exactly as long as the distributor takes to deliver.
    expect(s?.basis).toContain('covering 28 days')
    expect(s?.suggestedQty).toBe('60.000')
  })
})
