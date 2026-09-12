import { describe, expect, it } from 'vitest'
import type { PurchaseInvoice, PurchaseLine, Supplier, SupplierReturn } from '@contract'
import {
  boardSavings, buildPaymentPlan, groupPlanBySupplier, licenceState, monthlySpend, rateBoard,
  returnsPosition, selectionTotal,
} from './supplierInsights'

/**
 * The clock is injected everywhere, so it is fixed here. A payables screen tested
 * against `new Date()` passes in the morning and fails after midnight.
 */
const TODAY = new Date(2026, 8, 9) // 9 Sep 2026, local — the same basis daysUntil uses

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** N days before today, as the ISO string a bill would carry. */
function daysAgo(n: number): string {
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - n)
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    id: 1,
    storeId: 1,
    name: 'Sanjivani Pharma Distributors',
    phone: '2026441120',
    address: 'Bhosari MIDC, Pune',
    gstin: '27AACCS4471M1ZB',
    dlNo: 'MH-PN1-114B',
    dlValidUpto: null,
    paymentTermsDays: 30,
    creditLimit: '500000.00',
    outstanding: '0.00',
    ...over,
  }
}

function line(over: Partial<PurchaseLine> = {}): PurchaseLine {
  return {
    lineId: 'l1',
    medicineId: 1,
    brandName: 'Dolo 650',
    packLabel: '15 tab',
    unitsPerPack: 15,
    batchNo: 'B1',
    expiry: '2028-11-30',
    qtyPacks: '10',
    freePacks: '0',
    mrpPerPack: '450.00',
    ratePerPack: '300.00',
    discountPct: '0',
    gstRatePct: '12',
    taxableValue: '3000.00',
    cgst: '180.00',
    sgst: '180.00',
    igst: '0.00',
    lineTotal: '3360.00',
    landedCostPerUnit: '20.0000',
    rateChangedFrom: null,
    batchId: 1,
    ...over,
  }
}

function invoice(over: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id: 1,
    purchaseNo: 'GRN/2627/0001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani Pharma Distributors',
    supplierInvoiceNo: 'SPD/1201',
    invoiceDate: daysAgo(10),
    createdAt: '2026-08-30T10:00:00.000Z',
    lines: [line()],
    taxableValue: '3000.00',
    cgst: '180.00',
    sgst: '180.00',
    igst: '0.00',
    freight: '0.00',
    roundOff: '0.00',
    netAmount: '3360.00',
    amountPaid: '0.00',
    status: 'POSTED',
    notes: null,
    ...over,
  }
}

function claim(over: Partial<SupplierReturn> = {}): SupplierReturn {
  return {
    id: 1,
    documentNo: 'EC/2627/0001',
    kind: 'EXPIRY_CLAIM',
    storeId: 1,
    terminalId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani Pharma Distributors',
    againstPurchaseId: null,
    againstPurchaseNo: null,
    issuedOn: daysAgo(40),
    createdAt: '2026-07-30T10:00:00.000Z',
    reason: 'Time expired stock issued for claim',
    operatorName: 'Harshad Kulkarni',
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

// --------------------------------------------------------------- licence ---

describe('licenceState', () => {
  it('separates "no number" from "number but no date"', () => {
    // Both are gaps, and only one of them is a finding at inspection. Collapsing
    // them into a single "incomplete" would either cry wolf on every master that
    // has not been backfilled or hide the bill that legally cannot be raised.
    expect(licenceState(supplier({ dlNo: null }), TODAY).key).toBe('missing')
    expect(licenceState(supplier({ dlValidUpto: null }), TODAY).key).toBe('undated')
  })

  it('calls a licence lapsed the day after it runs out, and says how long ago', () => {
    const s = supplier({ dlValidUpto: daysAgo(3) })
    const state = licenceState(s, TODAY)
    expect(state.key).toBe('lapsed')
    expect(state.days).toBe(-3)
    expect(state.label).toContain('3d')
  })

  it('warns for the whole renewal window and not a day past it', () => {
    const at = (days: number) => {
      const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + days)
      return iso(d.getFullYear(), d.getMonth() + 1, d.getDate())
    }
    expect(licenceState(supplier({ dlValidUpto: at(0) }), TODAY).key).toBe('expiring')
    expect(licenceState(supplier({ dlValidUpto: at(60) }), TODAY).key).toBe('expiring')
    expect(licenceState(supplier({ dlValidUpto: at(61) }), TODAY).key).toBe('valid')
  })

  it('treats an unreadable date as no date rather than as an expiry', () => {
    // A half-migrated row must never render as a lapsed licence: that reads as
    // "stop buying from him", which is an expensive thing to say by accident.
    expect(licenceState(supplier({ dlValidUpto: 'soon' }), TODAY).key).toBe('undated')
  })
})

// -------------------------------------------------------- payment planner ---

describe('buildPaymentPlan', () => {
  const entries = [
    {
      // 30-day terms: a bill 40 days old is 10 days past.
      supplier: supplier({ id: 1, paymentTermsDays: 30 }),
      invoices: [
        invoice({ id: 1, supplierId: 1, invoiceDate: daysAgo(40), netAmount: '10000.00', amountPaid: '0.00' }),
        invoice({ id: 2, supplierId: 1, invoiceDate: daysAgo(28), netAmount: '5000.00', amountPaid: '0.00' }),
      ],
    },
    {
      // Cash on delivery: the bill was due the day it was raised.
      supplier: supplier({ id: 2, name: 'Pawar Medical Traders', paymentTermsDays: 0 }),
      invoices: [
        invoice({ id: 3, supplierId: 2, invoiceDate: daysAgo(1), netAmount: '2000.00', amountPaid: '0.00' }),
      ],
    },
  ]

  it('dates each bill from ITS OWN supplier terms, not a shop-wide default', () => {
    const plan = buildPaymentPlan(entries, TODAY)
    const byId = new Map(plan.bills.map((b) => [b.purchaseId, b]))
    expect(byId.get(1)?.daysToDue).toBe(-10)
    // 28 days old on 30-day terms: two days left, so it is this week's run.
    expect(byId.get(2)?.daysToDue).toBe(2)
    expect(byId.get(2)?.bucket).toBe('week')
    // Zero terms means it fell due on the bill date; a day old is a day late.
    expect(byId.get(3)?.daysToDue).toBe(-1)
    expect(byId.get(3)?.bucket).toBe('overdue')
  })

  it('orders by due date and carries a running total down the list', () => {
    const plan = buildPaymentPlan(entries, TODAY)
    expect(plan.bills.map((b) => b.purchaseId)).toEqual([1, 3, 2])
    // The cumulative is what makes the list actionable: releasing 12,000 clears
    // everything down to the second row.
    expect(plan.bills.map((b) => b.cumulative)).toEqual(['10000.00', '12000.00', '17000.00'])
    expect(plan.total).toBe('17000.00')
  })

  it('counts the week as overdue plus today plus the next seven days', () => {
    const plan = buildPaymentPlan(entries, TODAY)
    expect(plan.dueThisWeek).toBe('17000.00')
    expect(plan.dueThisWeekCount).toBe(3)
    expect(plan.suppliersThisWeek).toBe(2)
    expect(plan.overdue).toBe('12000.00')
    expect(plan.overdueCount).toBe(2)
  })

  it('ignores a cancelled bill and a bill already settled', () => {
    const plan = buildPaymentPlan(
      [{
        supplier: supplier(),
        invoices: [
          invoice({ id: 9, status: 'CANCELLED', netAmount: '9999.00' }),
          invoice({ id: 10, netAmount: '500.00', amountPaid: '500.00' }),
        ],
      }],
      TODAY,
    )
    expect(plan.bills).toEqual([])
    expect(plan.total).toBe('0.00')
  })

  it('groups to one row per distributor, urgency taken from his soonest bill', () => {
    const plan = buildPaymentPlan(entries, TODAY)
    const groups = groupPlanBySupplier(plan.bills)
    expect(groups.map((g) => g.supplierId)).toEqual([1, 2])
    const first = groups[0]
    expect(first?.total).toBe('15000.00')
    // Only the 10,000 bill is past terms; the other one is due in two days.
    expect(first?.overdue).toBe('10000.00')
    expect(first?.bucket).toBe('overdue')
    expect(first?.bills).toHaveLength(2)
  })

  it('adds up only the bills that were ticked, and names how many suppliers', () => {
    const plan = buildPaymentPlan(entries, TODAY)
    expect(selectionTotal(plan.bills, new Set([1, 3])))
      .toEqual({ amount: '12000.00', count: 2, suppliers: 2 })
    expect(selectionTotal(plan.bills, new Set())).toEqual({ amount: '0.00', count: 0, suppliers: 0 })
  })
})

// ------------------------------------------------------ rate comparison ---

describe('rateBoard', () => {
  /* Same medicine, two distributors. The second is dearer per pack but the
     numbers are landed cost, so the scheme is already in them. */
  const cheap = invoice({
    id: 1,
    supplierId: 1,
    supplierName: 'Sanjivani Pharma Distributors',
    invoiceDate: daysAgo(20),
    lines: [line({ qtyPacks: '10', freePacks: '0', landedCostPerUnit: '20.0000', ratePerPack: '300.00' })],
  })
  const dear = invoice({
    id: 2,
    supplierId: 2,
    supplierName: 'Deccan Medical Agencies',
    invoiceDate: daysAgo(5),
    lines: [line({ qtyPacks: '20', freePacks: '0', landedCostPerUnit: '22.0000', ratePerPack: '330.00' })],
  })

  it('compares on landed cost per pack and puts the cheapest quote first', () => {
    const [row] = rateBoard([cheap, dear], TODAY)
    expect(row?.quotes.map((q) => q.supplierId)).toEqual([1, 2])
    expect(row?.best.landedPerPack).toBe('300.0000')
    expect(row?.worst.landedPerPack).toBe('330.0000')
    expect(row?.spread).toBe('30.00')
    expect(row?.spreadPct).toBe('10.0')
  })

  it('prices the overpayment against every pack actually received', () => {
    // 20 packs at 330 where 300 was available: ₹600 of the window is recoverable.
    const [row] = rateBoard([cheap, dear], TODAY)
    expect(row?.overpaid).toBe('600.00')
    expect(row?.packsReceived).toBe('30.000')
    expect(boardSavings(rateBoard([cheap, dear], TODAY))).toBe('600.00')
  })

  it('divides a free scheme through, so the cheaper RATE can be the dearer deal', () => {
    /* 10+2 at 300 lands at 250/pack; a flat 280 with no scheme does not beat it.
       Comparing printed rates would have picked the 280 and lost money on every
       pack — which is exactly how a distributor wins a line he is dearer on. */
    const scheme = invoice({
      id: 3,
      supplierId: 1,
      supplierName: 'Sanjivani Pharma Distributors',
      invoiceDate: daysAgo(3),
      lines: [line({ qtyPacks: '10', freePacks: '2', ratePerPack: '300.00', landedCostPerUnit: '16.6667' })],
    })
    const flat = invoice({
      id: 4,
      supplierId: 2,
      supplierName: 'Deccan Medical Agencies',
      invoiceDate: daysAgo(2),
      lines: [line({ qtyPacks: '10', freePacks: '0', ratePerPack: '280.00', landedCostPerUnit: '18.6667' })],
    })
    const [row] = rateBoard([scheme, flat], TODAY)
    expect(row?.best.supplierId).toBe(1)
    expect(row?.best.ratePerPack).toBe('300.00')
    expect(row?.worst.ratePerPack).toBe('280.00')
  })

  it('holds a distributor to his own best line when one bill quotes twice', () => {
    /* Two batches of one medicine on a single bill is ordinary. Whichever of
       the two is kept has to be a rule rather than an accident of iteration
       order, and the cheaper one is the number he can be held to. */
    const twice = invoice({
      id: 7,
      supplierId: 1,
      supplierName: 'Sanjivani Pharma Distributors',
      invoiceDate: daysAgo(4),
      lines: [
        line({ lineId: 'a', landedCostPerUnit: '21.0000', ratePerPack: '315.00' }),
        line({ lineId: 'b', batchNo: 'B2', landedCostPerUnit: '19.0000', ratePerPack: '285.00' }),
      ],
    })
    const [row] = rateBoard([twice, dear], TODAY)
    expect(row?.best.supplierId).toBe(1)
    expect(row?.best.ratePerPack).toBe('285.00')
  })

  it('drops a medicine only one distributor has ever supplied', () => {
    // A single-source row carries no comparison, and padding the board with them
    // buries the rows where a phone call is worth making.
    expect(rateBoard([cheap], TODAY)).toEqual([])
  })

  it('keeps the newest bill as a supplier’s current quote', () => {
    const older = invoice({
      id: 5,
      supplierId: 2,
      supplierName: 'Deccan Medical Agencies',
      invoiceDate: daysAgo(200),
      lines: [line({ landedCostPerUnit: '30.0000', ratePerPack: '450.00' })],
    })
    const [row] = rateBoard([cheap, older, dear], TODAY)
    const deccan = row?.quotes.find((q) => q.supplierId === 2)
    expect(deccan?.ratePerPack).toBe('330.00')
  })

  it('ignores bills outside the comparison window', () => {
    const stale = invoice({
      id: 6,
      supplierId: 2,
      supplierName: 'Deccan Medical Agencies',
      invoiceDate: daysAgo(400),
      lines: [line({ landedCostPerUnit: '22.0000' })],
    })
    expect(rateBoard([cheap, stale], TODAY)).toEqual([])
  })
})

// ------------------------------------------------------ returns and claims ---

describe('returnsPosition', () => {
  it('never adds a debit note to an expiry claim', () => {
    /* A debit note is already off the payable; a claim is a fresh invoice he has
       not paid. Summing them would understate what the shop owes by the claim
       value, which is the exact defect the two document kinds exist to prevent. */
    const pos = returnsPosition(
      [
        claim({ id: 1, kind: 'PURCHASE_RETURN', documentNo: 'DN/2627/0001', netAmount: '500.00' }),
        claim({ id: 2, netAmount: '1120.00' }),
      ],
      TODAY,
    )
    expect(pos.debitNotes).toBe('500.00')
    expect(pos.debitNoteCount).toBe(1)
    expect(pos.claimed).toBe('1120.00')
    expect(pos.awaiting).toBe('1120.00')
  })

  it('reports what a settled claim was short by, and never nets it away', () => {
    const pos = returnsPosition(
      [claim({ id: 3, netAmount: '1000.00', creditReceived: '850.00', creditNoteRef: 'CN-9912' })],
      TODAY,
    )
    expect(pos.received).toBe('850.00')
    expect(pos.shortfall).toBe('150.00')
    expect(pos.awaitingCount).toBe(0)
  })

  it('ages the oldest unsettled claim, which is what chasing one needs', () => {
    const pos = returnsPosition([claim({ id: 4, issuedOn: daysAgo(95) })], TODAY)
    expect(pos.oldestAwaitingDays).toBe(95)
  })

  it('skips a cancelled document entirely', () => {
    const pos = returnsPosition([claim({ id: 5, status: 'CANCELLED', netAmount: '9999.00' })], TODAY)
    expect(pos.claimed).toBe('0.00')
    expect(pos.claimCount).toBe(0)
  })
})

// ----------------------------------------------------------------- spend ---

describe('monthlySpend', () => {
  it('emits every month in the window, including the ones with no bill', () => {
    const spend = monthlySpend([invoice({ invoiceDate: daysAgo(2), netAmount: '3360.00' })], TODAY, 12)
    expect(spend).toHaveLength(12)
    expect(spend[11]?.key).toBe('2026-09')
    // A gap month is a zero, not an absence: a series drawn over only the months
    // that had a purchase makes a supplier the shop stopped buying from look
    // steady right up to the final point.
    expect(spend[0]?.amount).toBe('0.00')
    expect(spend[11]?.amount).toBe('3360.00')
  })

  it('leaves a cancelled bill out of the trend', () => {
    const spend = monthlySpend(
      [invoice({ invoiceDate: daysAgo(2), status: 'CANCELLED', netAmount: '3360.00' })],
      TODAY,
      12,
    )
    expect(spend[11]?.amount).toBe('0.00')
  })
})
