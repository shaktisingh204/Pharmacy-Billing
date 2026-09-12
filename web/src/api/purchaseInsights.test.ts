import { describe, expect, it } from 'vitest'
import type {
  PurchaseInvoice, PurchaseLine, PurchaseOrder, Supplier, SupplierReturn,
} from '@contract'
import {
  purchaseSummary, rateAlerts, rateMoves, spendByMonth, spendBySupplier, supplierScorecards,
} from './purchaseInsights'

/**
 * Each of these is a claim the screen makes to a pharmacist about a distributor.
 * Getting one wrong is not a rounding error — it is an argument at the counter
 * lost with the wrong number in hand.
 */

const TODAY = new Date(2026, 8, 9) // 9 September 2026, local

function line(over: Partial<PurchaseLine> = {}): PurchaseLine {
  return {
    lineId: 'l1',
    medicineId: 1,
    batchNo: 'B1',
    expiry: '2028-06-30',
    qtyPacks: '10',
    freePacks: '0',
    mrpPerPack: '100.00',
    ratePerPack: '70.00',
    discountPct: '0',
    gstRatePct: '12',
    brandName: 'Dolo 650',
    packLabel: '1x15',
    unitsPerPack: 15,
    taxableValue: '700.00',
    cgst: '42.00',
    sgst: '42.00',
    igst: '0.00',
    lineTotal: '784.00',
    landedCostPerUnit: '4.6667',
    rateChangedFrom: null,
    batchId: null,
    ...over,
  }
}

function bill(over: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: 1,
    purchaseNo: 'GRN2627-00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani',
    supplierInvoiceNo: 'SPD/0001',
    invoiceDate: '2026-09-01',
    createdAt: '2026-09-01T05:00:00.000Z',
    lines: [line()],
    taxableValue: '700.00',
    cgst: '42.00',
    sgst: '42.00',
    igst: '0.00',
    freight: '0.00',
    roundOff: '0.00',
    netAmount: '784.00',
    amountPaid: '0.00',
    status: 'POSTED',
    notes: null,
    ...over,
  }
}

function supplier(id: number, name: string, over: Partial<Supplier> = {}): Supplier {
  return {
    id,
    storeId: 1,
    name,
    phone: '2026441120',
    address: null,
    gstin: null,
    dlNo: null,
    paymentTermsDays: 30,
    creditLimit: '100000.00',
    outstanding: '0.00',
    ...over,
  }
}

function order(over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 1,
    orderNo: 'PO2627-00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani',
    placedOn: '2026-09-01',
    expectedOn: null,
    createdAt: '2026-09-01T05:00:00.000Z',
    operatorName: 'Akib',
    note: null,
    status: 'OPEN',
    lines: [{
      lineId: 'o1', medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15',
      qty: '150', receivedQty: '0', basis: 'sells ~5 a month',
    }],
    ...over,
  }
}

function claim(over: Partial<SupplierReturn> = {}): SupplierReturn {
  return {
    id: 1,
    documentNo: 'EC2627-00001',
    kind: 'EXPIRY_CLAIM',
    storeId: 1,
    terminalId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani',
    againstPurchaseId: null,
    againstPurchaseNo: null,
    issuedOn: '2026-08-01',
    createdAt: '2026-08-01T05:00:00.000Z',
    reason: 'Expired on the shelf',
    operatorName: 'Akib',
    lines: [],
    taxableValue: '1000.00',
    cgst: '60.00',
    sgst: '60.00',
    igst: '0.00',
    roundOff: '0.00',
    netAmount: '1120.00',
    creditReceived: null,
    creditNoteRef: null,
    status: 'POSTED',
    ...over,
  }
}

// ------------------------------------------------------------------ spend ---

describe('spend', () => {
  it('keeps the months nothing was bought in', () => {
    // A chart drawn only from months with data closes the gap where a shop
    // stopped buying — which is the shape worth seeing.
    const months = spendByMonth([bill({ invoiceDate: '2026-09-02' })], { months: 3, today: TODAY })
    expect(months.map((m) => m.key)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(months.map((m) => m.amount)).toEqual(['0.00', '0.00', '784.00'])
    expect(months[2]?.label).toBe('Sep 26')
  })

  it('excludes a cancelled bill rather than netting it off', () => {
    const rows = spendByMonth(
      [bill(), bill({ id: 2, status: 'CANCELLED', netAmount: '9999.00' })],
      { months: 1, today: TODAY },
    )
    expect(rows[0]?.amount).toBe('784.00')
    expect(rows[0]?.bills).toBe(1)
  })

  it('ranks suppliers by spend and states each share', () => {
    const rows = spendBySupplier([
      bill({ id: 1, supplierId: 1, supplierName: 'A', netAmount: '750.00' }),
      bill({ id: 2, supplierId: 2, supplierName: 'B', netAmount: '250.00' }),
    ])
    expect(rows.map((r) => r.supplierName)).toEqual(['A', 'B'])
    expect(rows[0]?.sharePct).toBe('75.0')
    expect(rows[1]?.sharePct).toBe('25.0')
  })

  it('reports no month-on-month move when last month was nothing', () => {
    // A rise from zero has no percentage, and "+Infinity%" on a card is worse
    // than saying nothing.
    const summary = purchaseSummary([bill({ invoiceDate: '2026-09-02' })], TODAY)
    expect(summary.monthSpend).toBe('784.00')
    expect(summary.monthMovePct).toBeNull()
    expect(summary.avgBill).toBe('784.00')
    expect(summary.suppliersUsed).toBe(1)
  })

  it('computes the month-on-month move against the previous calendar month', () => {
    const summary = purchaseSummary([
      bill({ id: 1, invoiceDate: '2026-08-10', netAmount: '1000.00' }),
      bill({ id: 2, invoiceDate: '2026-09-03', netAmount: '1200.00' }),
    ], TODAY)
    expect(summary.monthMovePct).toBe('20.0')
  })
})

// -------------------------------------------------------------- rate moves ---

describe('rate moves', () => {
  it('reads the move out of the history when the bill did not record one', () => {
    // An imported bill carries no rateChangedFrom. An alert the shop cannot see
    // because of how the document arrived is worse than no alert at all.
    const moves = rateMoves([
      bill({ id: 1, invoiceDate: '2026-07-01', lines: [line({ ratePerPack: '70.00' })] }),
      bill({ id: 2, invoiceDate: '2026-08-01', lines: [line({ ratePerPack: '77.00' })] }),
    ])
    expect(moves).toHaveLength(1)
    expect(moves[0]?.from).toBe('70.00')
    expect(moves[0]?.to).toBe('77.00')
    expect(moves[0]?.movePct).toBe('10.0')
  })

  it('states the margin the new rate leaves at the same MRP', () => {
    const moves = rateMoves([
      bill({ id: 1, invoiceDate: '2026-07-01', lines: [line({ ratePerPack: '70.00' })] }),
      bill({ id: 2, invoiceDate: '2026-08-01', lines: [line({ ratePerPack: '80.00' })] }),
    ])
    expect(moves[0]?.marginPctBefore).toBe('30.0')
    expect(moves[0]?.marginPct).toBe('20.0')
  })

  it('compares a supplier against THEMSELVES, never against another distributor', () => {
    // Two distributors charging different rates is ordinary. Alerting on it puts
    // a warning on every line of every bill, and the feature is noise in a week.
    const moves = rateMoves([
      bill({ id: 1, supplierId: 1, invoiceDate: '2026-07-01', lines: [line({ ratePerPack: '70.00' })] }),
      bill({ id: 2, supplierId: 2, invoiceDate: '2026-08-01', lines: [line({ ratePerPack: '90.00' })] }),
    ])
    expect(moves).toHaveLength(0)
  })

  it('honours rateChangedFrom on a bill with no earlier purchase on file', () => {
    const moves = rateMoves([
      bill({ lines: [line({ ratePerPack: '77.00', rateChangedFrom: '70.00' })] }),
    ])
    expect(moves[0]?.movePct).toBe('10.0')
  })

  it('alerts on falls as well as rises, above the threshold only', () => {
    const moves = rateMoves([
      bill({ id: 1, invoiceDate: '2026-06-01', lines: [line({ ratePerPack: '100.00' })] }),
      bill({ id: 2, invoiceDate: '2026-07-01', lines: [line({ ratePerPack: '102.00' })] }),
      bill({ id: 3, invoiceDate: '2026-08-01', lines: [line({ ratePerPack: '90.00' })] }),
    ])
    const alerts = rateAlerts(moves, { thresholdPct: '5' })
    // The 2% rise is under the bar; the fall back to 90 is not, and a rate that
    // quietly dropped is money the shop has been over-paying.
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.movePct).toBe('-11.8')
  })

  it('puts the newest alert first', () => {
    const moves = rateMoves([
      bill({ id: 1, invoiceDate: '2026-06-01', lines: [line({ ratePerPack: '100.00' })] }),
      bill({ id: 2, invoiceDate: '2026-07-01', lines: [line({ ratePerPack: '120.00' })] }),
      bill({ id: 3, invoiceDate: '2026-08-01', lines: [line({ ratePerPack: '140.00' })] }),
    ])
    expect(rateAlerts(moves, { thresholdPct: '5' })[0]?.invoiceDate).toBe('2026-08-01')
  })
})

// -------------------------------------------------------------- scorecard ---

describe('the supplier scorecard', () => {
  const suppliers = [supplier(1, 'Sanjivani'), supplier(2, 'Deccan')]

  it('has NO fill rate for a supplier nothing was ordered from', () => {
    // 0% beside a distributor who has never been ordered from through this
    // software is a lie, and it is the kind that gets quoted back to them.
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [bill()],
      orders: [],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.pct).toBeNull()
    expect(row?.fill.orders).toBe(0)
    expect(row?.leadTimeDays).toBeNull()
  })

  it('counts free packs as delivered', () => {
    // A 10+1 scheme fills the order. Ignoring the free packs under-reports every
    // distributor who runs one, which is all of them.
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      // 9 paid + 1 free packs of 15 = 150 units, against 150 ordered.
      purchases: [bill({
        invoiceDate: '2026-09-03',
        lines: [line({ qtyPacks: '9', freePacks: '1' })],
      })],
      orders: [order()],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.pct).toBe('100.0')
    expect(row?.leadTimeDays).toBe(2)
  })

  it('does not let one delivery fill two orders', () => {
    // The shop ordered twice and was delivered once. A per-order match reports
    // 100% twice, and the supplier this number exists to catch goes unnoticed.
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [bill({ invoiceDate: '2026-09-03', lines: [line({ qtyPacks: '10', freePacks: '0' })] })],
      orders: [order({ id: 1 }), order({ id: 2, orderNo: 'PO2627-00002', placedOn: '2026-09-02' })],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.orderedUnits).toBe('300.00')
    expect(row?.fill.receivedUnits).toBe('150.00')
    expect(row?.fill.pct).toBe('50.0')
  })

  it('leaves an order alone while it is still inside its delivery window', () => {
    // A fill rate that drops the moment you place an order measures the
    // calendar, not the supplier — and it is at its worst exactly when it is
    // being read, because the reason anybody is on this screen is that they
    // just ordered something.
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [],
      orders: [order({ placedOn: '2026-09-09', expectedOn: null })],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.pct).toBeNull()

    // Past the date they agreed, it counts — and it counts as nothing arrived.
    const [late] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [],
      orders: [order({ placedOn: '2026-09-08', expectedOn: '2026-09-08' })],
      returns: [],
      today: TODAY,
    })
    expect(late?.fill.pct).toBe('0.0')
  })

  it('ignores goods that arrived before the order was placed', () => {
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [bill({ invoiceDate: '2026-08-20' })],
      orders: [order({ placedOn: '2026-09-01' })],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.pct).toBe('0.0')
    expect(row?.leadTimeDays).toBeNull()
  })

  it('believes a receivedQty the backend recorded over anything it can infer', () => {
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [],
      orders: [order({
        lines: [{
          lineId: 'o1', medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15',
          qty: '150', receivedQty: '75', basis: '',
        }],
      })],
      returns: [],
      today: TODAY,
    })
    expect(row?.fill.pct).toBe('50.0')
  })

  it('rates the claim settlement over SETTLED claims only', () => {
    // Counting the ones still open makes the rate fall every time a claim is
    // raised, which says nothing about the supplier and everything about the
    // calendar.
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [],
      orders: [],
      returns: [
        claim({ id: 1, netAmount: '1000.00', creditReceived: '800.00' }),
        claim({ id: 2, netAmount: '5000.00', creditReceived: null }),
      ],
      today: TODAY,
    })
    expect(row?.claims.settledPct).toBe('80.0')
    expect(row?.claims.shortfall).toBe('200.00')
    expect(row?.claims.open).toBe(1)
    expect(row?.claims.settled).toBe(1)
  })

  it('reports the scheme as free packs over packs paid for', () => {
    const [row] = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [bill({ lines: [line({ qtyPacks: '20', freePacks: '2' })] })],
      orders: [],
      returns: [],
      today: TODAY,
    })
    expect(row?.schemePct).toBe('10.0')
  })

  it('ranks by spend and shares the window total between suppliers', () => {
    const rows = supplierScorecards({
      suppliers,
      purchases: [
        bill({ id: 1, supplierId: 2, supplierName: 'Deccan', netAmount: '3000.00' }),
        bill({ id: 2, supplierId: 1, netAmount: '1000.00' }),
      ],
      orders: [],
      returns: [],
      today: TODAY,
    })
    expect(rows.map((r) => r.supplierName)).toEqual(['Deccan', 'Sanjivani'])
    expect(rows[0]?.sharePct).toBe('75.0')
  })

  it('leaves a bill older than the window out of the score', () => {
    const rows = supplierScorecards({
      suppliers: [supplier(1, 'Sanjivani')],
      purchases: [bill({ invoiceDate: '2025-01-01' })],
      orders: [],
      returns: [],
      today: TODAY,
    })
    expect(rows[0]?.bills).toBe(0)
    expect(rows[0]?.spend).toBe('0.00')
  })
})
