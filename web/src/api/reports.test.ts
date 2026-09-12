import { describe, expect, it } from 'vitest'
import { REPORT_IDS } from '@contract'
import type {
  Batch, CreditNote, Customer, IsoDate, Medicine, PaymentInput, PurchaseInvoice, Quote,
  QuoteAllocation, QuoteLine, ReportId, ReportQuery, ReportResult, ReportRow, SaleInvoice,
  StoreProfile, Supplier,
  LedgerReason,
} from '@contract'
import * as D from '@/domain/decimal'
import { ageBalance, buildReport, normaliseRange, reportInputs } from './reports'
import type { ReportSource } from './reports'

/**
 * Hand-written fixtures, never the seed.
 *
 * Every amount below is internally consistent the way `domain/gst` produces
 * them — taxable back-calculated out of a GST-inclusive amount, the tax taken as
 * a residual — because that consistency is precisely what the reconciliation
 * asserts. A fixture with invented totals would let the report agree with itself
 * while disagreeing with a real bill.
 */

const TODAY: IsoDate = '2026-09-08'

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
    packLabel: '10x15',
    unitsPerPack: 15,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'OTC',
    requiresPrescription: false,
    rackLocation: 'A1',
    reorderLevel: 50,
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
    expiryDate: '2027-12-31',
    mrpPerPack: '150.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '7.0000',
    purchaseGstPct: '5',
    qtyOnHand: '100',
    isQuarantined: false,
    ...over,
  }
}

/** A 5%-rate allocation whose taxable, tax and total foot exactly. */
function alloc(over: Partial<QuoteAllocation> = {}): QuoteAllocation {
  return {
    batchId: 1,
    batchNo: 'B1',
    expiryDate: '2027-12-31',
    qty: '10',
    freeQty: '0',
    mrpPerUnit: '10.5000',
    ratePerUnit: '10.5000',
    grossAmount: '105.00',
    discountAmount: '0.00',
    taxableValue: '100.00',
    cgst: '2.50',
    sgst: '2.50',
    igst: '0.00',
    lineTotal: '105.00',
    gstRatePct: '5',
    costBasis: '60.00',
    ...over,
  }
}

const sumOf = (xs: readonly string[]): string => D.toStr(D.sum(xs.map((x) => D.dec(x))), 2)

/** Line totals are FOLDED from the allocations, exactly as the quote engine
 *  folds them — the reconciliation compares those two paths. */
function line(lineId: string, medicineId: number, allocations: QuoteAllocation[], over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    lineId,
    medicineId,
    brandName: `Brand ${medicineId}`,
    packLabel: '10x15',
    hsnCode: '30049099',
    drugSchedule: 'OTC',
    requestedQty: sumOf(allocations.map((a) => a.qty)),
    allocatedQty: sumOf(allocations.map((a) => a.qty)),
    shortQty: '0',
    allocations,
    discountPct: '0',
    grossAmount: sumOf(allocations.map((a) => a.grossAmount)),
    discountAmount: sumOf(allocations.map((a) => a.discountAmount)),
    taxableValue: sumOf(allocations.map((a) => a.taxableValue)),
    cgst: sumOf(allocations.map((a) => a.cgst)),
    sgst: sumOf(allocations.map((a) => a.sgst)),
    igst: sumOf(allocations.map((a) => a.igst)),
    lineTotal: sumOf(allocations.map((a) => a.lineTotal)),
    manualBatch: false,
    ...over,
  }
}

function quote(lines: QuoteLine[]): Quote {
  const all = lines.flatMap((l) => l.allocations)
  return {
    lines,
    grossAmount: sumOf(all.map((a) => a.grossAmount)),
    itemDiscount: '0.00',
    billDiscountPct: '0',
    billDiscount: '0.00',
    taxableValue: sumOf(lines.map((l) => l.taxableValue)),
    cgst: sumOf(lines.map((l) => l.cgst)),
    sgst: sumOf(lines.map((l) => l.sgst)),
    igst: sumOf(lines.map((l) => l.igst)),
    roundOff: '0.00',
    netAmount: sumOf(lines.map((l) => l.lineTotal)),
    taxBreakup: [],
    warnings: [],
    costOfGoods: sumOf(all.map((a) => a.costBasis)),
  }
}

function invoice(
  id: number,
  date: IsoDate,
  lines: QuoteLine[],
  over: Partial<SaleInvoice> = {},
): SaleInvoice {
  const q = quote(lines)
  const payments: PaymentInput[] = [{ mode: 'CASH', amount: q.netAmount }]
  return {
    id,
    invoiceNo: `RX/2627/${String(id).padStart(5, '0')}`,
    storeId: 1,
    terminalId: 1,
    invoiceDate: date,
    createdAt: `${date}T10:00:00.000Z`,
    customerId: null,
    customerName: null,
    customerPhone: null,
    interState: false,
    quote: q,
    payments,
    amountPaid: q.netAmount,
    changeDue: '0.00',
    status: 'POSTED',
    prescription: null,
    operatorName: 'Counter 1',
    ...over,
  }
}

function customer(id: number, over: Partial<Customer> = {}): Customer {
  return {
    id,
    storeId: 1,
    name: `Customer ${id}`,
    phone: `98220000${id}`,
    address: null,
    gstin: null,
    allergies: [],
    creditLimit: '5000.00',
    outstanding: '0.00',
    ...over,
  }
}

function supplier(id: number, over: Partial<Supplier> = {}): Supplier {
  return {
    id,
    storeId: 1,
    name: `Supplier ${id}`,
    phone: `98110000${id}`,
    address: null,
    gstin: null,
    dlNo: null,
    paymentTermsDays: 30,
    creditLimit: '100000.00',
    outstanding: '0.00',
    ...over,
  }
}

/** A ₹52.50 reversal of five units off bill 1, footing the way `domain/gst`
 *  folds one: taxable back-calculated, each tax taken as a residual. */
function creditNote(over: Partial<CreditNote> = {}): CreditNote {
  return {
    id: 9,
    creditNoteNo: 'CN/2627/00001',
    storeId: 1,
    terminalId: 1,
    invoiceId: 1,
    invoiceNo: 'RX/2627/00001',
    originalInvoiceDate: '2026-09-05',
    issuedOn: '2026-09-09',
    createdAt: '2026-09-09T10:00:00.000Z',
    customerId: null,
    customerName: null,
    interState: false,
    lines: [{
      lineId: 'a',
      medicineId: 1,
      brandName: 'Brand 1',
      packLabel: '10x15',
      hsnCode: '30049099',
      batchId: 1,
      batchNo: 'B1',
      expiryDate: '2027-12-31',
      qty: '5',
      ratePerUnit: '10.5000',
      gstRatePct: '5',
      taxableValue: '50.00',
      cgst: '1.25',
      sgst: '1.25',
      igst: '0.00',
      lineTotal: '52.50',
      disposition: 'RESTOCK',
    }],
    taxableValue: '50.00',
    cgst: '1.25',
    sgst: '1.25',
    igst: '0.00',
    roundOff: '0.00',
    netAmount: '52.50',
    refundMode: 'CASH',
    reason: 'Wrong strength dispensed',
    operatorName: 'Counter 1',
    ...over,
  }
}

const STORE: StoreProfile = {
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
  id: 1,
  name: 'Test Chemist',
  tagline: null,
  addressLine: '1 Main Road',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  phone: '02012345678',
  email: null,
  gstin: '27AAAAA0000A1Z5',
  dlNos: ['MH-PN-123456'],
  invoicePrefix: 'RX',
  financialYearStartMonth: 4,
  currency: 'INR',
  expiryGuardDays: 30,
  nearExpiryBuckets: [30, 60, 90, 180],
  roundOffEnabled: true,
  allowNegativeStock: false,
  footerNote: '',
  upiVpa: null,
}

function source(over: Partial<ReportSource> & { query: ReportQuery }): ReportSource {
  const medicines = over.medicineFor === undefined ? [medicine(1), medicine(2)] : []
  return {
    invoices: [],
    creditNotes: [],
    purchases: [],
    batches: [],
    movements: [],
    medicineFor: (id) => medicines.find((m) => m.id === id),
    customers: [],
    suppliers: [],
    store: STORE,
    productName: 'RxBill',
    today: TODAY,
    generatedAt: '2026-09-08T12:00:00.000Z',
    ...over,
  }
}

const q = (reportId: ReportId, over: Partial<ReportQuery> = {}): ReportQuery => ({
  reportId,
  from: '2026-09-01',
  to: '2026-09-30',
  ...over,
})

const cell = (r: ReportResult, row: number, key: string): string | null =>
  r.rows[row]?.cells[key] ?? null

const find = (r: ReportResult, pred: (row: ReportRow) => boolean): ReportRow | undefined =>
  r.rows.find(pred)

// ------------------------------------------------------------------ range ---

describe('normaliseRange', () => {
  it('swaps a reversed range rather than returning nothing', () => {
    expect(normaliseRange({ from: '2026-09-30', to: '2026-09-01' }, TODAY))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('falls back to today for an unparseable bound', () => {
    expect(normaliseRange({ from: 'yesterday', to: '2026-09-30' }, TODAY))
      .toEqual({ from: TODAY, to: '2026-09-30' })
  })
})

describe('reportInputs', () => {
  it('asks for history only where a window cannot answer the question', () => {
    expect(reportInputs('DAY_BOOK').sales).toBe('range')
    // A balance cannot be aged against a window: the documents behind it are
    // older than any reporting period the user is likely to pick.
    expect(reportInputs('CUSTOMER_OUTSTANDING').sales).toBe('history')
    expect(reportInputs('SUPPLIER_OUTSTANDING').purchases).toBe('history')
    expect(reportInputs('STOCK_VALUATION')).toEqual({
      sales: 'none', purchases: 'none', creditNotes: false, stock: true,
    })
  })

  it('reads credit notes for exactly the statutory reports and the day book', () => {
    const withNotes = (['DAY_BOOK', 'GST_RATE_SUMMARY', 'HSN_SUMMARY'] as const)
    for (const id of withNotes) expect(reportInputs(id).creditNotes, id).toBe(true)
    for (const id of ['ITEM_SALES', 'BATCH_MARGIN', 'H1_REGISTER'] as const) {
      expect(reportInputs(id).creditNotes, id).toBe(false)
    }
  })
})

// -------------------------------------------------------------- GST proof ---

describe('GST rate-wise summary', () => {
  const mixed = invoice(1, '2026-09-05', [
    line('a', 1, [alloc(), alloc({ batchId: 2, batchNo: 'B2', qty: '5', grossAmount: '52.50', taxableValue: '50.00', cgst: '1.25', sgst: '1.25', lineTotal: '52.50', costBasis: '30.00' })]),
    line('b', 2, [alloc({
      gstRatePct: '12', grossAmount: '112.00', taxableValue: '100.00',
      cgst: '6.00', sgst: '6.00', lineTotal: '112.00',
    })], { hsnCode: '30051000' }),
  ])

  it('reconciles rate-wise taxable to the line-wise taxable, to the paisa', () => {
    const r = buildReport(source({ query: q('GST_RATE_SUMMARY'), invoices: [mixed] }))
    const taxable = r.checks.find((c) => c.label === 'Taxable value')
    expect(taxable?.left).toBe('250.00')
    expect(taxable?.right).toBe('250.00')
    expect(taxable?.difference).toBe('0.00')
    expect(taxable?.balanced).toBe(true)
    expect(r.checks.every((c) => c.balanced)).toBe(true)
  })

  it('the reconciliation follows the filter, so a filtered view still proves itself', () => {
    const r = buildReport(source({ query: q('GST_RATE_SUMMARY', { term: '12' }), invoices: [mixed] }))
    expect(r.rows).toHaveLength(1)
    expect(r.totals['taxable']).toBe('100.00')
    const taxable = r.checks.find((c) => c.label === 'Taxable value')
    // Only the 12% supplies on either side — a proof that only holds unfiltered
    // is not a proof.
    expect(taxable?.left).toBe('100.00')
    expect(taxable?.right).toBe('100.00')
    expect(taxable?.balanced).toBe(true)
  })

  it('reports a real difference rather than hiding it', () => {
    // A bill whose line total does not fold from its own allocations: damaged
    // data, and exactly what the check exists to surface.
    const damaged = invoice(2, '2026-09-06', [line('a', 1, [alloc()], { taxableValue: '99.00' })])
    const r = buildReport(source({ query: q('GST_RATE_SUMMARY'), invoices: [damaged] }))
    const taxable = r.checks.find((c) => c.label === 'Taxable value')
    expect(taxable?.difference).toBe('1.00')
    expect(taxable?.balanced).toBe(false)
  })

  it('splits B2B from B2C on the buyer holding a GSTIN, not on being named', () => {
    const named = invoice(3, '2026-09-07', [line('a', 1, [alloc()])], { customerId: 1, customerName: 'Cash regular' })
    const registered = invoice(4, '2026-09-07', [line('a', 1, [alloc()])], { customerId: 2, customerName: 'Clinic' })
    const r = buildReport(source({
      query: q('GST_RATE_SUMMARY'),
      invoices: [named, registered],
      customers: [customer(1), customer(2, { gstin: '27AAECJ1234K1Z5' })],
    }))
    expect(r.rows.map((row) => row.cells['supply'])).toEqual(['B2B', 'B2C'])
    expect(r.checks.every((c) => c.balanced)).toBe(true)
  })

  it('nets a credit note as a negative reversal and still reconciles', () => {
    const r = buildReport(source({ query: q('GST_RATE_SUMMARY'), invoices: [mixed], creditNotes: [creditNote()] }))
    const reversal = find(r, (row) => row.cells['doc'] === 'Credit note')
    expect(reversal?.cells['taxable']).toBe('-50.00')
    // 250 billed less 50 reversed: the net output liability for the period.
    expect(r.totals['taxable']).toBe('200.00')
    expect(r.checks.every((c) => c.balanced)).toBe(true)
  })

  it('leaves a cancelled bill out of the liability entirely', () => {
    const voided = invoice(5, '2026-09-05', [line('a', 1, [alloc()])], { status: 'VOIDED' })
    const r = buildReport(source({ query: q('GST_RATE_SUMMARY'), invoices: [mixed, voided] }))
    expect(r.totals['taxable']).toBe('250.00')
  })
})

describe('HSN summary', () => {
  const withFree = invoice(1, '2026-09-05', [
    line('a', 1, [alloc({ freeQty: '2' })]),
  ])

  it('declares free scheme units in the quantity even though they carry no value', () => {
    const r = buildReport(source({ query: q('HSN_SUMMARY'), invoices: [withFree] }))
    expect(cell(r, 0, 'qty')).toBe('12.000')
    expect(cell(r, 0, 'taxable')).toBe('100.00')
  })

  it('cross-validates against the rate-wise taxable, the way the portal does', () => {
    const r = buildReport(source({ query: q('HSN_SUMMARY'), invoices: [withFree] }))
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0]?.balanced).toBe(true)
    expect(r.checks[0]?.difference).toBe('0.00')
  })

  it('carries no invented HSN description', () => {
    const r = buildReport(source({ query: q('HSN_SUMMARY'), invoices: [withFree] }))
    expect(r.columns.some((c) => c.key === 'description')).toBe(false)
  })

  it('still balances when the reader filters down to one HSN', () => {
    // Two HSNs on one bill. Searching for one of them must not accuse the file
    // of carrying the other as an unexplained difference.
    const twoHsn = invoice(2, '2026-09-05', [
      line('a', 1, [alloc()]),
      line('b', 2, [alloc({
        gstRatePct: '12', grossAmount: '112.00', taxableValue: '100.00',
        cgst: '6.00', sgst: '6.00', lineTotal: '112.00',
      })], { hsnCode: '30051000' }),
    ])
    const r = buildReport(source({ query: q('HSN_SUMMARY', { term: '30051000' }), invoices: [twoHsn] }))
    expect(r.rows).toHaveLength(1)
    expect(r.checks[0]?.left).toBe('100.00')
    expect(r.checks[0]?.right).toBe('100.00')
    expect(r.checks[0]?.balanced).toBe(true)
  })
})

// ----------------------------------------------------------------- margin ---

describe('margin', () => {
  /* The batch has since been repriced: its landed cost is now 9.50, but the
     sale was made against a cost of 6.00 per unit and that is what the bill is
     answerable for. A margin that moves when a later purchase lands is a margin
     nobody believes. */
  const repriced = batch(1, 1, { landedCostPerUnit: '9.5000' })
  const sold = invoice(1, '2026-09-05', [line('a', 1, [alloc({ costBasis: '60.00' })])])

  it('uses the cost snapshotted on the sale line, never the batch as it stands now', () => {
    const r = buildReport(source({ query: q('BATCH_MARGIN'), invoices: [sold], batches: [repriced] }))
    expect(cell(r, 0, 'cost')).toBe('60.00')
    expect(cell(r, 0, 'gp')).toBe('40.00')
    expect(cell(r, 0, 'gpPct')).toBe('40.0')
  })

  it('states the cost basis on the report itself', () => {
    const r = buildReport(source({ query: q('BATCH_MARGIN'), invoices: [sold], batches: [repriced] }))
    expect(r.basis.join(' ')).toContain('SNAPSHOTTED')
    expect(r.notes.join(' ')).toContain('NOT netted')
  })

  it('computes GP% on the ex-GST value, not on what the customer paid', () => {
    const r = buildReport(source({ query: q('ITEM_SALES'), invoices: [sold], batches: [repriced] }))
    // 105 was collected and 100 is taxable; a GP% on 105 would read 42.9%.
    expect(cell(r, 0, 'net')).toBe('105.00')
    expect(cell(r, 0, 'taxable')).toBe('100.00')
    expect(cell(r, 0, 'gpPct')).toBe('40.0')
  })

  it('leaves GP% undefined rather than printing 0% on a nil-rated line', () => {
    const nil = invoice(2, '2026-09-05', [line('a', 1, [alloc({
      gstRatePct: '0', taxableValue: '0.00', cgst: '0.00', sgst: '0.00', lineTotal: '0.00', costBasis: '0.00',
    })])])
    const r = buildReport(source({ query: q('ITEM_SALES'), invoices: [nil] }))
    expect(cell(r, 0, 'gpPct')).toBeNull()
  })

  it('counts distinct bills per item and does not total that column', () => {
    const second = invoice(2, '2026-09-06', [line('a', 1, [alloc()])])
    const r = buildReport(source({ query: q('ITEM_SALES'), invoices: [sold, second] }))
    expect(cell(r, 0, 'bills')).toBe('2')
    expect(r.totals['bills']).toBeUndefined()
    expect(r.totals['taxable']).toBe('200.00')
  })
})

// --------------------------------------------------------------- day book ---

describe('day book', () => {
  const cash = invoice(1, '2026-09-05', [line('a', 1, [alloc()])])
  const credit = invoice(2, '2026-09-05', [line('a', 1, [alloc()])], {
    customerId: 1,
    customerName: 'Customer 1',
    payments: [{ mode: 'CREDIT', amount: '105.00' }],
  })
  const cancelled = invoice(3, '2026-09-05', [line('a', 1, [alloc()])], { status: 'VOIDED' })

  it('lists a cancelled bill, keeps its number and excludes it from every total', () => {
    const r = buildReport(source({ query: q('DAY_BOOK'), invoices: [cash, credit, cancelled] }))
    const row = find(r, (x) => x.cells['status'] === 'Cancelled')
    expect(row?.cells['billNo']).toBe('RX/2627/00003')
    expect(row?.cells['net']).toBeNull()
    expect(r.totals['net']).toBe('210.00')
  })

  it('separates what was collected from what was billed to an account', () => {
    const r = buildReport(source({ query: q('DAY_BOOK'), invoices: [cash, credit] }))
    expect(r.totals['collected']).toBe('105.00')
    expect(r.totals['credit']).toBe('105.00')
  })

  it('takes the change handed back out of what was collected', () => {
    // ₹110 on the counter against a ₹105 bill: the drawer keeps 105.
    const tendered = invoice(4, '2026-09-05', [line('a', 1, [alloc()])], {
      payments: [{ mode: 'CASH', amount: '110.00' }],
      amountPaid: '110.00',
      changeDue: '5.00',
    })
    const r = buildReport(source({ query: q('DAY_BOOK'), invoices: [tendered] }))
    expect(cell(r, 0, 'collected')).toBe('105.00')
  })

  it('totals follow the filter rather than the whole period', () => {
    const r = buildReport(source({
      query: q('DAY_BOOK', { facet: 'CREDIT' }),
      invoices: [cash, credit],
    }))
    expect(r.rows).toHaveLength(1)
    expect(r.totals['net']).toBe('105.00')
  })

  it('drops a document outside the range', () => {
    const august = invoice(4, '2026-08-31', [line('a', 1, [alloc()])])
    const r = buildReport(source({ query: q('DAY_BOOK'), invoices: [cash, august] }))
    expect(r.rows).toHaveLength(1)
  })

  it('counts cancelled bills off the rows on screen, not off the period', () => {
    const r = buildReport(source({
      query: q('DAY_BOOK', { facet: 'CASH' }),
      invoices: [cash, cancelled],
    }))
    expect(r.rows).toHaveLength(1)
    expect(r.headline.find((h) => h.label === 'Cancelled')?.value).toBe('0')
  })

  it('keeps a refund settled against the account out of the drawer', () => {
    // The customer's account is credited; nothing is handed back over the
    // counter, so the day's takings are untouched and what is recoverable falls.
    const r = buildReport(source({
      query: q('DAY_BOOK'),
      invoices: [cash],
      creditNotes: [creditNote({ refundMode: 'CREDIT' })],
    }))
    expect(r.totals['collected']).toBe('105.00')
    expect(r.totals['credit']).toBe('-52.50')
    expect(r.totals['net']).toBe('52.50')
  })

  it('takes a cash refund straight out of what was collected', () => {
    const r = buildReport(source({
      query: q('DAY_BOOK'),
      invoices: [cash],
      creditNotes: [creditNote({ refundMode: 'CASH' })],
    }))
    expect(r.totals['collected']).toBe('52.50')
    expect(r.totals['credit']).toBe('0.00')
  })
})

// -------------------------------------------------------------- registers ---

describe('Schedule H1 register', () => {
  const h1 = invoice(1, '2026-09-05', [
    line('a', 1, [alloc()], { drugSchedule: 'H1', brandName: 'Alprax 0.5' }),
    line('b', 2, [alloc({ batchNo: 'B7' })]),
  ], {
    prescription: {
      prescriberName: 'Dr. Suresh Pawar',
      prescriberRegNo: 'MMC/1995/012477',
      patientName: 'Anil Gokhale',
      prescriptionDate: '2026-09-04',
    },
  })

  it('carries only Schedule H1 supplies, in the Annexure IV column order', () => {
    const r = buildReport(source({ query: q('H1_REGISTER'), invoices: [h1] }))
    expect(r.rows).toHaveLength(1)
    expect(r.columns.map((c) => c.key)).toEqual([
      'sl', 'date', 'prescriber', 'prescriberAddress', 'regNo', 'patient', 'patientAddress',
      'drug', 'batch', 'expiry', 'qty', 'billNo',
    ])
    expect(cell(r, 0, 'prescriber')).toBe('Dr. Suresh Pawar')
    expect(cell(r, 0, 'regNo')).toBe('MMC/1995/012477')
    expect(cell(r, 0, 'billNo')).toBe('RX/2627/00001')
  })

  it('carries the addresses the rule names, and leaves them blank when unknown', () => {
    // The rule's own text asks for the prescriber's address and Annexure IV for
    // the patient's; both reach the invoice, so both belong in the register.
    const withAddresses = invoice(2, '2026-09-05', [
      line('a', 1, [alloc()], { drugSchedule: 'H1', brandName: 'Alprax 0.5' }),
    ], {
      prescription: {
        prescriberName: 'Dr. Suresh Pawar',
        prescriberRegNo: 'MMC/1995/012477',
        prescriberAddress: '12 MG Road, Pune 411001',
        patientName: 'Anil Gokhale',
        patientAddress: 'Flat 4, Kothrud',
        prescriptionDate: '2026-09-04',
      },
    })
    // The register is ordered by date then bill number, so bill 1 — the one with
    // no address on it — reads first.
    const r = buildReport(source({ query: q('H1_REGISTER'), invoices: [withAddresses, h1] }))
    expect(cell(r, 1, 'prescriberAddress')).toBe('12 MG Road, Pune 411001')
    expect(cell(r, 1, 'patientAddress')).toBe('Flat 4, Kothrud')
    // The other bill captured no address. A blank says which bill to go back to;
    // a dash character would export as an entry.
    expect(cell(r, 0, 'prescriberAddress')).toBeNull()
  })

  it('says the serial is a reading aid rather than the statutory one', () => {
    const r = buildReport(source({ query: q('H1_REGISTER'), invoices: [h1] }))
    expect(r.notes.join(' ')).toContain('serial number restarts')
  })
})

// ------------------------------------------------------------- outstanding ---

describe('ageBalance', () => {
  const items = [
    { date: '2026-06-01', dueDate: '2026-07-01', ref: 'A', amount: D.dec('1000') },
    { date: '2026-08-20', dueDate: '2026-09-19', ref: 'B', amount: D.dec('500') },
  ]

  it('applies the balance to the newest documents first', () => {
    const aged = ageBalance(D.dec('600'), items, TODAY)
    // 500 sits on the August bill, which is not due until the 19th.
    expect(D.toStr(aged.notDue, 2)).toBe('500.00')
    // The remaining 100 lands on the June bill, 69 days past its due date.
    expect(D.toStr(aged.d90, 2)).toBe('100.00')
    expect(D.toStr(aged.unmatched, 2)).toBe('0.00')
  })

  it('reports a balance the documents cannot explain instead of ageing it', () => {
    const aged = ageBalance(D.dec('2000'), items, TODAY)
    expect(D.toStr(aged.unmatched, 2)).toBe('500.00')
    expect(D.toStr(D.sum([aged.notDue, aged.d30, aged.d60, aged.d90, aged.older, aged.unmatched]), 2))
      .toBe('2000.00')
  })

  it('buckets on the due date, not the bill date', () => {
    const onTerms = [{ date: '2026-08-20', dueDate: '2026-09-19', ref: 'B', amount: D.dec('500') }]
    expect(D.toStr(ageBalance(D.dec('500'), onTerms, TODAY).notDue, 2)).toBe('500.00')
    const noTerms = [{ date: '2026-08-20', dueDate: '2026-08-20', ref: 'B', amount: D.dec('500') }]
    expect(D.toStr(ageBalance(D.dec('500'), noTerms, TODAY).d30, 2)).toBe('500.00')
  })

  it('ages nothing when there is nothing owed', () => {
    const aged = ageBalance(D.ZERO, items, TODAY)
    expect(aged.oldest).toBeNull()
    expect(D.toStr(aged.unmatched, 2)).toBe('0.00')
  })
})

describe('customer outstanding', () => {
  const owed = invoice(1, '2026-08-01', [line('a', 1, [alloc()])], {
    customerId: 1,
    customerName: 'Customer 1',
    payments: [{ mode: 'CREDIT', amount: '105.00' }],
  })

  it('lists a party carrying a balance and flags the over-limit ones', () => {
    const r = buildReport(source({
      query: q('CUSTOMER_OUTSTANDING', { from: '2026-09-01', to: '2026-09-08' }),
      invoices: [owed],
      customers: [customer(1, { outstanding: '105.00', creditLimit: '100.00' }), customer(2)],
    }))
    expect(r.rows).toHaveLength(1)
    expect(cell(r, 0, 'balance')).toBe('105.00')
    expect(cell(r, 0, 'status')).toBe('Over limit')
    expect(cell(r, 0, 'd60')).toBe('105.00')
  })

  it('leaves a settled account off the report entirely', () => {
    const r = buildReport(source({
      query: q('CUSTOMER_OUTSTANDING'),
      invoices: [owed],
      customers: [customer(1, { outstanding: '0.00' })],
    }))
    expect(r.rows).toEqual([])
  })

  it('says out loud that it ages on the bill date, because there is no term', () => {
    const r = buildReport(source({
      query: q('CUSTOMER_OUTSTANDING'),
      customers: [customer(1, { outstanding: '105.00' })],
    }))
    expect(r.basis.join(' ')).toContain('no credit-days term')
  })
})

describe('supplier outstanding', () => {
  const bill: PurchaseInvoice = {
    id: 1,
    purchaseNo: 'GRN/2627/00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Supplier 1',
    supplierInvoiceNo: 'SI/2526/00123',
    invoiceDate: '2026-07-01',
    createdAt: '2026-07-01T10:00:00.000Z',
    lines: [],
    taxableValue: '1000.00',
    cgst: '25.00',
    sgst: '25.00',
    igst: '0.00',
    freight: '0.00',
    roundOff: '0.00',
    netAmount: '1050.00',
    amountPaid: '50.00',
    status: 'POSTED',
    notes: null,
  }

  it('ages an open goods receipt past its agreed terms', () => {
    const r = buildReport(source({
      query: q('SUPPLIER_OUTSTANDING', { from: '2026-09-01', to: '2026-09-08' }),
      purchases: [bill],
      suppliers: [supplier(1, { outstanding: '1000.00', paymentTermsDays: 30 })],
    }))
    // Due 31 July, so 39 days past due on 8 September.
    expect(cell(r, 0, 'd60')).toBe('1000.00')
    expect(cell(r, 0, 'status')).toBe('39d past due')
    expect(r.totals['balance']).toBe('1000.00')
  })
})

// ------------------------------------------------------------------ stock ---

describe('stock reports', () => {
  const live = batch(1, 1, { qtyOnHand: '100', expiryDate: '2028-01-31' })
  const soon = batch(2, 1, { qtyOnHand: '40', expiryDate: '2026-09-30' })
  const gone = batch(3, 1, { qtyOnHand: '10', expiryDate: '2026-08-31' })
  const empty = batch(4, 1, { qtyOnHand: '0', expiryDate: '2028-01-31' })

  it('values stock at landed cost and excludes emptied batches', () => {
    const r = buildReport(source({
      query: q('STOCK_VALUATION'),
      batches: [live, empty],
    }))
    expect(r.rows).toHaveLength(1)
    expect(cell(r, 0, 'atCost')).toBe('700.00')
    expect(cell(r, 0, 'atMrp')).toBe('1000.00')
    expect(r.notes.join(' ')).toContain('AS IT STANDS NOW')
  })

  it('near-expiry lists only dated stock, expired kept as its own window', () => {
    const r = buildReport(source({ query: q('NEAR_EXPIRY'), batches: [live, soon, gone] }))
    expect(r.rows).toHaveLength(2)
    // A window is offered when it would RETURN something, and its count is what
    // selecting it returns: the batch 22 days out is inside every window from 30
    // days up, so all four are askable and each of them shows exactly one row.
    expect(r.facets).toEqual([
      { value: 'expired', label: 'Already expired', count: 1 },
      { value: 'd30', label: 'Within 30 days', count: 1 },
      { value: 'd60', label: 'Within 60 days', count: 1 },
      { value: 'd90', label: 'Within 90 days', count: 1 },
      { value: 'd180', label: 'Within 180 days', count: 1 },
    ])
  })

  it('the expiry facet is a WINDOW, so ≤90 days includes a batch 22 days out', () => {
    const r = buildReport(source({
      query: q('NEAR_EXPIRY', { facet: 'd90' }),
      batches: [live, soon, gone],
    }))
    expect(r.rows.map((row) => row.cells['batch'])).toEqual(['B2'])
    expect(r.totals['atCost']).toBe('280.00')
  })

  it('a window count is exactly the number of rows selecting it shows', () => {
    const batches = [
      batch(5, 1, { expiryDate: '2026-09-20' }),
      batch(6, 1, { expiryDate: '2026-10-20' }),
      batch(7, 1, { expiryDate: '2026-11-20' }),
    ]
    const listed = buildReport(source({ query: q('NEAR_EXPIRY'), batches }))
    for (const f of listed.facets) {
      const picked = buildReport(source({ query: q('NEAR_EXPIRY', { facet: f.value }), batches }))
      expect(picked.rows, f.value).toHaveLength(f.count)
    }
    expect(listed.facets.find((f) => f.value === 'd90')?.count).toBe(3)
  })
})


// -------------------------------------------------------------- grouping ---

describe('grouping (Index On)', () => {
  /* Four batches over two medicines. Medicine is the only column on the stock
     report that collapses anything here: pack, rack and HSN are identical
     across the fixture, and the batch number is unique per row. */
  const dolo = medicine(1, { brandName: 'Dolo 650' })
  const calpol = medicine(2, { brandName: 'Calpol 500' })
  const stock = {
    medicineFor: (id: number) => (id === 1 ? dolo : id === 2 ? calpol : undefined),
    batches: [
      batch(1, 1, { qtyOnHand: '100', batchNo: 'A1' }),
      batch(2, 1, { qtyOnHand: '40', batchNo: 'A2' }),
      batch(3, 2, { qtyOnHand: '25', batchNo: 'C1' }),
      batch(4, 2, { qtyOnHand: '5', batchNo: 'C2' }),
    ],
  }

  const flat = buildReport(source({ query: q('STOCK_VALUATION'), ...stock }))

  it('offers only columns that would actually merge rows', () => {
    const keys = flat.groupable.map((g) => g.key)
    // Manufacturer takes two values over four rows, so it collapses something.
    expect(keys).toContain('medicine')
    // The batch number is unique per row: grouping on it prints a header above
    // every row, which is strictly worse than the table it replaced.
    expect(keys).not.toContain('batch')
    expect(flat.groupBy).toBeNull()
    expect(flat.groups).toBeNull()
  })

  it('THE FOOTER IS UNCHANGED BY GROUPING — the whole reason it groups in place', () => {
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'medicine' }),
      ...stock,
    }))
    // Same rows, same totals, seen at two grains. Marg's own knowledge base
    // documents its closing stock disagreeing with its stock-and-sale analysis;
    // this assertion is the reason that cannot happen here.
    expect(grouped.rows.map((r) => r.key)).toEqual(flat.rows.map((r) => r.key))
    expect(grouped.totals).toEqual(flat.totals)
  })

  it('band subtotals foot EXACTLY to the report total', () => {
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'medicine' }),
      ...stock,
    }))
    const groups = grouped.groups ?? []
    expect(groups.map((g) => g.label)).toEqual(['Dolo 650', 'Calpol 500'])
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(grouped.rows.length)

    for (const col of grouped.columns) {
      const footed = grouped.totals[col.key]
      if (footed === undefined || footed === null) continue
      // Same decimal places as the footer — a quantity is 3dp and money 2dp, and
      // a subtotal printed at the wrong scale would not compare against the
      // figure directly below it even when the arithmetic agrees.
      const dp = col.kind === 'qty' ? 3 : col.kind === 'count' ? 0 : 2
      const summed = D.sum(groups.map((g) => D.dec(g.totals[col.key] ?? '0')))
      expect(D.toStr(summed, dp), col.key).toBe(footed)
    }
  })

  it('never subtotals a column the footer does not total, so no percentage is averaged', () => {
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'medicine' }),
      ...stock,
    }))
    const pct = grouped.columns.filter((c) => c.kind === 'pct').map((c) => c.key)
    expect(pct).toContain('marginPct')
    for (const g of grouped.groups ?? []) {
      for (const key of pct) expect(g.totals[key], key).toBeUndefined()
    }
  })

  it('every band together is every row, in the report\'s own order', () => {
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'medicine' }),
      ...stock,
    }))
    const walked = (grouped.groups ?? []).flatMap((g) => g.rowKeys)
    expect(new Set(walked).size).toBe(walked.length)
    expect(new Set(walked)).toEqual(new Set(grouped.rows.map((r) => r.key)))
  })


  it('bands near-expiry by the month printed on the strip, in date order', () => {
    // The pharmacist's own unit. A day-window filter answers "what is inside 90
    // days"; this answers "what goes off in December", which is the question
    // that decides which supplier gets called this week.
    const batches = [
      batch(11, 1, { expiryDate: '2026-10-31', qtyOnHand: '10' }),
      batch(12, 1, { expiryDate: '2026-10-31', qtyOnHand: '20' }),
      batch(13, 1, { expiryDate: '2026-11-30', qtyOnHand: '5' }),
      batch(14, 1, { expiryDate: '2026-12-31', qtyOnHand: '7' }),
    ]
    const r = buildReport(source({
      query: q('NEAR_EXPIRY', { groupBy: 'expMonth' }),
      batches,
    }))
    expect(r.groups?.map((g) => g.label)).toEqual(['Oct 2026', 'Nov 2026', 'Dec 2026'])
    expect(r.groups?.map((g) => g.count)).toEqual([2, 1, 1])
    // Every band foots to the page, so "December is ₹X" is defensible.
    const summed = D.sum((r.groups ?? []).map((g) => D.dec(g.totals['atCost'] ?? '0')))
    expect(D.toStr(summed, 2)).toBe(r.totals['atCost'])
  })

  it('ignores a column the report does not have rather than grouping on nothing', () => {
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'supplierWhoDoesNotExistHere' }),
      ...stock,
    }))
    expect(grouped.groupBy).toBeNull()
    expect(grouped.groups).toBeNull()
  })

  it('holds a grouping the filter narrowed past, instead of silently going flat', () => {
    // One row left, so `groupable` is empty — but the operator asked for this
    // index and the control is still showing it. Dropping it here re-shapes the
    // table while they are mid-keystroke in the search box.
    const grouped = buildReport(source({
      query: q('STOCK_VALUATION', { groupBy: 'medicine', term: 'c1' }),
      ...stock,
    }))
    expect(grouped.rows).toHaveLength(1)
    expect(grouped.groupable).toEqual([])
    expect(grouped.groupBy).toBe('medicine')
    expect(grouped.groups?.map((g) => g.label)).toEqual(['Calpol 500'])
  })
})

// ------------------------------------------------------------ day-wise sales ---

describe('day-wise sales', () => {
  const bill = (id: number, date: IsoDate, over: Partial<SaleInvoice> = {}): SaleInvoice =>
    invoice(id, date, [line('a', 1, [alloc()])], over)

  it('folds the day book up by date and leaves shut days out', () => {
    const r = buildReport(source({
      query: q('SALES_BY_DAY'),
      invoices: [bill(1, '2026-09-02'), bill(2, '2026-09-02')],
      creditNotes: [creditNote()],
    }))

    // Two documented dates out of a thirty-day window: a day the shop was shut
    // is not a trading day, and inventing a zero row drags every average down.
    expect(r.rows).toHaveLength(2)
    expect(cell(r, 0, 'date')).toBe('2026-09-02')
    expect(cell(r, 0, 'bills')).toBe('2')
    expect(cell(r, 0, 'net')).toBe('210.00')
    expect(cell(r, 0, 'avgBill')).toBe('105.00')
    expect(cell(r, 0, 'dow')).toBe('Wed')

    // The credit-note day: takings go negative and there is no bill to divide by.
    expect(cell(r, 1, 'returns')).toBe('1')
    expect(cell(r, 1, 'net')).toBe('-52.50')
    expect(cell(r, 1, 'collected')).toBe('-52.50')
    expect(cell(r, 1, 'avgBill')).toBeNull()

    expect(r.totals['net']).toBe('157.50')
  })

  it('counts a cancelled bill on its day and keeps it out of every money column', () => {
    const r = buildReport(source({
      query: q('SALES_BY_DAY'),
      invoices: [bill(1, '2026-09-02'), bill(2, '2026-09-02', { status: 'VOIDED', voidReason: 'Wrong customer' })],
    }))
    expect(cell(r, 0, 'bills')).toBe('1')
    expect(cell(r, 0, 'voided')).toBe('1')
    expect(cell(r, 0, 'net')).toBe('105.00')
  })

  it('names the best day rather than making the reader scan for it', () => {
    const r = buildReport(source({
      query: q('SALES_BY_DAY'),
      invoices: [bill(1, '2026-09-02'), bill(2, '2026-09-03'), bill(3, '2026-09-03')],
    }))
    expect(r.headline.find((h) => h.label === 'Best day')?.value).toBe('2026-09-03')
    expect(r.headline.find((h) => h.label === 'Trading days')?.value).toBe('2')
  })
})

// -------------------------------------------------------- purchase register ---

describe('purchase register', () => {
  const receipt = (over: Partial<PurchaseInvoice> = {}): PurchaseInvoice => ({
    id: 1,
    purchaseNo: 'GRN/2627/00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Supplier 1',
    supplierInvoiceNo: 'SI/2526/00123',
    invoiceDate: '2026-09-04',
    createdAt: '2026-09-04T10:00:00.000Z',
    lines: [],
    taxableValue: '1000.00',
    cgst: '25.00',
    sgst: '25.00',
    igst: '0.00',
    freight: '0.00',
    roundOff: '0.00',
    netAmount: '1050.00',
    amountPaid: '50.00',
    status: 'POSTED',
    notes: null,
    ...over,
  })

  it('reports recorded input tax, the balance, and whether it is past terms', () => {
    const r = buildReport(source({
      query: q('PURCHASE_REGISTER'),
      purchases: [receipt()],
      suppliers: [supplier(1, { paymentTermsDays: 3 })],
    }))
    expect(cell(r, 0, 'tax')).toBe('50.00')
    expect(cell(r, 0, 'balance')).toBe('1000.00')
    // Due 7 September, unpaid on the 8th.
    expect(cell(r, 0, 'due')).toBe('2026-09-07')
    expect(cell(r, 0, 'status')).toBe('Overdue')
    expect(r.rows[0]?.tone).toBe('warning')
    expect(r.totals['tax']).toBe('50.00')
  })

  it('refuses to call recorded tax a claim', () => {
    const r = buildReport(source({ query: q('PURCHASE_REGISTER') }))
    expect(r.notes.join(' ')).toContain('GSTR-2B')
    expect(r.notes.join(' ')).toContain('NOT an input-tax-credit claim')
  })

  it('lists a cancelled receipt and totals nothing from it', () => {
    const r = buildReport(source({
      query: q('PURCHASE_REGISTER'),
      purchases: [receipt(), receipt({ id: 2, purchaseNo: 'GRN/2627/00002', status: 'CANCELLED' })],
      suppliers: [supplier(1)],
    }))
    expect(r.rows).toHaveLength(2)
    expect(cell(r, 1, 'net')).toBeNull()
    expect(r.totals['net']).toBe('1050.00')
    expect(r.headline.find((h) => h.label === 'Bills')?.value).toBe('1')
  })

  it('proves the bill value is the sum of its parts, and says when it is not', () => {
    const clean = buildReport(source({
      query: q('PURCHASE_REGISTER'),
      purchases: [receipt({ freight: '0.00' })],
      suppliers: [supplier(1)],
    }))
    expect(clean.checks[0]?.balanced).toBe(true)

    // A receipt whose stored net does not equal its own parts is damaged data,
    // and the register has to say so rather than print a plausible total.
    const damaged = buildReport(source({
      query: q('PURCHASE_REGISTER'),
      purchases: [receipt({ netAmount: '1049.00' })],
      suppliers: [supplier(1)],
    }))
    expect(damaged.checks[0]?.balanced).toBe(false)
    expect(damaged.checks[0]?.difference).toBe('1.00')
  })
})

// ------------------------------------------------------------- non-moving ---

describe('non-moving stock', () => {
  const idle = batch(2, 2, { qtyOnHand: '100', expiryDate: '2028-01-31' })
  const moved = batch(1, 1, { qtyOnHand: '100', expiryDate: '2028-01-31' })

  it('lists only stock whose medicine did not sell once in the window', () => {
    const r = buildReport(source({
      query: q('NON_MOVING'),
      invoices: [invoice(1, '2026-09-02', [line('a', 1, [alloc()])])],
      batches: [moved, idle],
    }))
    expect(r.rows).toHaveLength(1)
    expect(cell(r, 0, 'medicine')).toBe('Brand 2')
    expect(cell(r, 0, 'atCost')).toBe('700.00')
    expect(r.headline.find((h) => h.label === 'At cost')?.value).toBe('700.00')
  })

  it('says out loud that the window is the whole test', () => {
    const r = buildReport(source({ query: q('NON_MOVING') }))
    expect(r.notes.join(' ')).toContain('window is the whole test')
    expect(r.basis.join(' ')).toContain('FEFO')
  })

  it('separates dead stock that is also expiring from dead stock that is not', () => {
    const r = buildReport(source({
      query: q('NON_MOVING'),
      batches: [idle, batch(3, 2, { qtyOnHand: '5', expiryDate: '2026-09-30' })],
    }))
    expect(r.facets).toEqual([
      { value: 'near', label: 'Expiring within 90 days', count: 1 },
      { value: 'live', label: 'In date', count: 1 },
    ])
  })
})

// ----------------------------------------------------------------- shared ---

describe('every report', () => {
  /* The contract's own list, never a copy of it. A hand-written list here would
     silently stop covering the thirteenth report the day one is added. */
  const ids: ReportId[] = [...REPORT_IDS]

  it('answers a question, states its basis and survives having no data', () => {
    for (const id of ids) {
      const r = buildReport(source({ query: q(id) }))
      expect(r.title, id).not.toBe('')
      expect(r.question, id).toMatch(/\S/)
      expect(r.basis.length, id).toBeGreaterThan(0)
      expect(r.rows, id).toEqual([])
      expect(r.headline.length, id).toBeGreaterThan(0)
    }
  })

  it('gives every column a key the rows can be read by', () => {
    for (const id of ids) {
      const r = buildReport(source({ query: q(id) }))
      expect(new Set(r.columns.map((c) => c.key)).size, id).toBe(r.columns.length)
    }
  })
})

describe('controlled-drug register', () => {
  /**
   * The report exists to answer two questions and it must refuse to answer a
   * third. What moved, does the balance end where the shelf is — and never
   * "are you compliant", which is not a question this code can answer.
   */
  const alprax = medicine(9, { brandName: 'Alprax', packLabel: '10s', drugSchedule: 'X' })
  const dolo = medicine(10, { brandName: 'Dolo 650', drugSchedule: 'OTC' })

  let mvId = 0
  const move = (medicineId: number, at: string, qtyDelta: string, reason: LedgerReason = 'SALE') => ({
    id: (mvId += 1),
    at,
    batchId: 1,
    batchNo: 'B1',
    medicineId,
    brandName: 'x',
    qtyDelta,
    balanceAfter: '0',
    reason,
    refType: 'INVOICE',
    refId: 'RX-1',
    note: null,
  })

  const src = (over: Partial<ReportSource> = {}) => source({
    query: q('CONTROLLED_BALANCE', { from: '2026-09-01', to: TODAY }),
    medicineFor: (id) => [alprax, dolo].find((m) => m.id === id),
    batches: [batch(1, 9, { qtyOnHand: '20' })],
    movements: [
      move(9, '2026-08-20T10:00:00.000Z', '30', 'PURCHASE'),
      move(9, '2026-09-02T10:00:00.000Z', '-10'),
    ],
    ...over,
  })

  it('opens with a brought-forward row and closes with the balance', () => {
    const r = buildReport(src())
    expect(r.rows[0]?.cells['movement']).toBe('Balance brought forward')
    expect(r.rows[0]?.cells['balance']).toBe('30.000')
    expect(r.rows.at(-1)?.cells['balance']).toBe('20.000')
  })

  it('leaves an UNCONTROLLED drug off the register entirely', () => {
    // A register of everything is a stock ledger, not a register.
    const r = buildReport(src({
      movements: [move(10, '2026-09-02T10:00:00.000Z', '-5')],
      batches: [batch(1, 10, { qtyOnHand: '5' })],
    }))
    expect(r.rows).toEqual([])
  })

  it('registers a controlled drug that is on the shelf with NO movements', () => {
    /* The empty register is the one that matters: a controlled drug sitting on
       the shelf with no recorded receipt is exactly what an inspection looks
       for, and omitting it would hide it. */
    const r = buildReport(src({ movements: [] }))
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]?.cells['drug']).toBe('Alprax 10s')
    expect(r.rows.at(-1)?.cells['balance']).toBe('0.000')
  })

  it('RECONCILES the closing balance against the shelf and reports the gap', () => {
    const balanced = buildReport(src())
    expect(balanced.checks[0]?.balanced).toBe(true)

    const short = buildReport(src({ batches: [batch(1, 9, { qtyOnHand: '18' })] }))
    expect(short.checks[0]?.balanced).toBe(false)
    expect(short.checks[0]?.difference).toBe('2.000')
  })

  it('refuses to reconcile a PAST window against today\'s shelf', () => {
    // Six months of trading is not a discrepancy.
    const r = buildReport(src({ query: q('CONTROLLED_BALANCE', { from: '2026-03-01', to: '2026-03-31' }) }))
    expect(r.checks).toEqual([])
  })

  it('states on its face that it is NOT a statutory form', () => {
    /* The form number, its columns and the retention period are unverified.
       This note rides on the printed sheet and the CSV export, which is the
       copy an inspector is handed — deleting it would let the paper imply a
       compliance claim nothing in this repo can support. */
    const r = buildReport(src())
    expect(r.notes.join(' ')).toMatch(/not a rendering of a statutory form/)
    expect(r.columns.map((c) => c.label).join(' ')).not.toMatch(/Form/)
  })
})
