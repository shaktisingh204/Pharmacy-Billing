import { describe, expect, it } from 'vitest'
import type {
  CreditNote, Customer, Quote, QuoteLine, SaleInvoice, StoreProfile,
} from '@contract'
import { DEFAULT_THRESHOLDS, checkFiling, seriesSummaries } from './filing'
import type { FilingInputs } from './filing'

/**
 * Every case here is a document the portal would reject, or a judgement a human
 * has to make — and the file's whole job is telling those two apart.
 */

const STORE: StoreProfile = {
  id: 1,
  name: 'Sanjeevani Medical Store',
  tagline: null,
  addressLine: '12 Laxmi Road',
  city: 'Pune',
  state: 'Maharashtra',
  stateCode: '27',
  phone: '2025551234',
  email: null,
  gstin: '27AACCS4471M1ZB',
  dlNos: ['MH-PN1-114B'],
  invoicePrefix: 'RX',
  financialYearStartMonth: 4,
  currency: 'INR',
  expiryGuardDays: 30,
  nearExpiryBuckets: [30, 60, 90, 180],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: null,
  footerNote: '',
  filing: DEFAULT_THRESHOLDS,
}

function line(over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    lineId: 'l1',
    medicineId: 1,
    brandName: 'Dolo 650',
    packLabel: '1x15',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requestedQty: '10',
    allocatedQty: '10',
    shortQty: '0',
    allocations: [],
    discountPct: '0',
    grossAmount: '100.00',
    discountAmount: '0.00',
    taxableValue: '89.29',
    cgst: '5.36',
    sgst: '5.35',
    igst: '0.00',
    lineTotal: '100.00',
    manualBatch: false,
    ...over,
  }
}

function quote(over: Partial<Quote> = {}): Quote {
  return {
    lines: [line()],
    taxableValue: '89.29',
    cgst: '5.36',
    sgst: '5.35',
    igst: '0.00',
    discountTotal: '0.00',
    billDiscount: '0.00',
    roundOff: '0.00',
    netAmount: '100.00',
    rateBreakup: [],
    errors: [],
    ...over,
  } as Quote
}

function invoice(over: Partial<SaleInvoice> = {}): SaleInvoice {
  return {
    id: 1,
    invoiceNo: 'RX2627-T1-00001',
    storeId: 1,
    terminalId: 1,
    invoiceDate: '2026-09-05',
    createdAt: '2026-09-05T10:00:00.000Z',
    customerId: null,
    customerName: null,
    customerPhone: null,
    interState: false,
    quote: quote(),
    payments: [],
    amountPaid: '100.00',
    changeDue: '0.00',
    status: 'POSTED',
    prescription: null,
    operatorName: 'A',
    ...over,
  }
}

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    storeId: 1,
    name: 'Dr Joshi Clinic',
    phone: '9822114477',
    address: null,
    gstin: '27AABFD9012K1Z7',
    allergies: [],
    doctorName: null,
    creditLimit: '0.00',
    outstanding: '0.00',
    ...over,
  } as Customer
}

const run = (over: Partial<FilingInputs> = {}, from = '2026-09-01', to = '2026-09-30') =>
  checkFiling(from, to, {
    invoices: [invoice()],
    creditNotes: [],
    customers: [],
    store: STORE,
    generatedAt: '2026-09-09T12:00:00.000Z',
    ...over,
  })

const codes = (r: ReturnType<typeof run>): string[] => r.issues.map((i) => i.code)
const of = (r: ReturnType<typeof run>, code: string) => r.issues.find((i) => i.code === code)

// ------------------------------------------------------------- blockers ---

describe('what the portal will reject', () => {
  it('catches an invoice that does not add up — the defect no summary shows', () => {
    // The summary totals add up either way; only the line-by-line check finds it.
    const broken = invoice({ quote: quote({ netAmount: '101.00' }) })
    const r = run({ invoices: [broken] })
    expect(codes(r)).toContain('INVOICE_DOES_NOT_FOOT')
    expect(of(r, 'INVOICE_DOES_NOT_FOOT')?.severity).toBe('blocker')
    expect(r.ready).toBe(false)
  })

  it('catches a B2B buyer whose GSTIN is not a GSTIN', () => {
    const r = run({
      invoices: [invoice({ customerId: 1 })],
      customers: [customer({ gstin: '27AABFD9012K1' })],
    })
    expect(of(r, 'BUYER_GSTIN_INVALID')?.severity).toBe('blocker')
  })

  it('catches a line with no HSN, and reads it OFF THE INVOICE', () => {
    // Not off today's master: fixing the medicine last week does not fix a
    // document that was filed without one.
    const r = run({ invoices: [invoice({ quote: quote({ lines: [line({ hsnCode: '' })] }) })] })
    expect(of(r, 'HSN_MISSING')?.severity).toBe('blocker')
  })

  it('refuses a store GSTIN that will fail at upload', () => {
    const r = run({}, '2026-09-01', '2026-09-30')
    expect(codes(r)).not.toContain('STORE_GSTIN_INVALID')

    const bad = checkFiling('2026-09-01', '2026-09-30', {
      invoices: [invoice()],
      creditNotes: [],
      customers: [],
      store: { ...STORE, gstin: 'NOT-A-GSTIN' },
      generatedAt: '',
    })
    expect(of(bad, 'STORE_GSTIN_INVALID')?.severity).toBe('blocker')
    expect(bad.ready).toBe(false)
  })
})

// ------------------------------------------------------------- warnings ---

describe('what a human has to judge', () => {
  it('flags a place-of-supply that disagrees with the buyer\'s state', () => {
    // A Gujarat GSTIN taxed as an intra-state supply: one of the two is wrong.
    const r = run({
      invoices: [invoice({ customerId: 1, interState: false })],
      customers: [customer({ gstin: '24AAACM6677R1ZK' })],
    })
    expect(of(r, 'PLACE_OF_SUPPLY_MISMATCH')?.severity).toBe('warning')
    // A warning, not a blocker — the period is still filable while it is looked at.
    expect(r.ready).toBe(true)
  })

  it('treats an unnamed high-value counter bill as a WARNING, never a breach', () => {
    // The threshold itself is unverified, and a shop with the details on paper
    // is not non-compliant because RxBill cannot see them.
    const big = invoice({ quote: quote({ netAmount: '75000.00', taxableValue: '75000.00', cgst: '0.00', sgst: '0.00' }) })
    const r = run({ invoices: [big] })
    expect(of(r, 'RULE_46_DETAILS_MISSING')?.severity).toBe('warning')
    expect(r.ready).toBe(true)
  })

  it('flags a nil-rated line without calling it an error', () => {
    const nil = line({ cgst: '0.00', sgst: '0.00', igst: '0.00', taxableValue: '100.00' })
    const r = run({ invoices: [invoice({ quote: quote({ lines: [nil] }) })] })
    expect(of(r, 'NIL_RATED_LINES')?.severity).toBe('warning')
    expect(of(r, 'NIL_RATED_LINES')?.detail).toMatch(/genuinely nil-rated/i)
  })

  it('says an empty period might just be the wrong dates', () => {
    const r = run({ invoices: [] })
    expect(of(r, 'PERIOD_EMPTY')?.severity).toBe('warning')
    expect(r.ready).toBe(true)
  })

  it('lists blockers before warnings, because that is the order to work in', () => {
    const r = run({
      invoices: [invoice({ quote: quote({ netAmount: '101.00', lines: [line({ hsnCode: '' })] }) })],
    })
    const severities = r.issues.map((i) => i.severity)
    expect(severities.indexOf('warning') === -1 || severities.indexOf('blocker') < severities.indexOf('warning'))
      .toBe(true)
  })
})

// --------------------------------------------------------------- buckets ---

describe('the shape of the period', () => {
  it('splits B2B from the counter by the buyer holding a GSTIN', () => {
    const r = run({
      invoices: [invoice({ customerId: 1 }), invoice({ id: 2, invoiceNo: 'RX2627-T1-00002' })],
      customers: [customer()],
    })
    expect(r.buckets.find((b) => b.key === 'b2b')?.count).toBe(1)
    expect(r.buckets.find((b) => b.key === 'b2cs')?.count).toBe(1)
  })

  it('uses the CONFIGURED B2CL threshold and says which figure it used', () => {
    const big = invoice({
      interState: true,
      quote: quote({ netAmount: '260000.00' }),
    })
    const r = run({ invoices: [big] })
    expect(r.buckets.find((b) => b.key === 'b2cl')?.count).toBe(1)
    expect(r.basis.join(' ')).toContain('250000.00')
    // And it says the sources disagree rather than asserting the figure.
    expect(r.basis.join(' ')).toMatch(/conflict/i)
  })

  it('subtracts credit notes from the period totals', () => {
    const note: CreditNote = {
      id: 1, creditNoteNo: 'RXCN2627-T1-00001', invoiceId: 1, invoiceNo: 'RX2627-T1-00001',
      storeId: 1, terminalId: 1, issuedOn: '2026-09-06', createdAt: '', reason: 'x',
      refundMode: 'CASH', operatorName: 'A', lines: [],
      originalInvoiceDate: '2026-09-05', customerId: null, customerName: null, interState: false,
      taxableValue: '89.29', cgst: '5.36', sgst: '5.35', igst: '0.00',
      roundOff: '0.00', netAmount: '100.00',
    }
    const r = run({ creditNotes: [note] })
    expect(r.taxableValue).toBe('0.00')
    expect(r.buckets.find((b) => b.key === 'cdnr')?.count).toBe(1)
  })

  it('flags a credit note that points at no invoice in the book', () => {
    const orphan = { creditNoteNo: 'RXCN2627-T1-00009', invoiceId: 999, issuedOn: '2026-09-06',
      taxableValue: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00' } as CreditNote
    expect(codes(run({ creditNotes: [orphan] }))).toContain('CREDIT_NOTE_ORPHANED')
  })
})

// ---------------------------------------------------------------- series ---

describe('documents issued (Table 13)', () => {
  it('reports a cancelled document as issued AND cancelled — it burned its number', () => {
    const s = seriesSummaries(
      [invoice(), invoice({ id: 2, invoiceNo: 'RX2627-T1-00002', status: 'VOIDED' })],
      [],
    )
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ total: 2, cancelled: 1, net: 1 })
    expect(s[0]?.from).toBe('RX2627-T1-00001')
    expect(s[0]?.to).toBe('RX2627-T1-00002')
  })

  it('keeps two terminals as two series, because the numbering is per terminal', () => {
    const s = seriesSummaries(
      [invoice(), invoice({ id: 2, invoiceNo: 'RX2627-T2-00001' })],
      [],
    )
    expect(s).toHaveLength(2)
  })

  it('counts credit notes as their own series', () => {
    const note = { creditNoteNo: 'RXCN2627-T1-00001' } as CreditNote
    const s = seriesSummaries([invoice()], [note])
    expect(s.map((x) => x.label).sort()).toEqual(['Credit note', 'Tax invoice'])
  })
})

// ----------------------------------------------------------------- basis ---

describe('what it refuses to claim', () => {
  it('says plainly that it files nothing and generates no JSON', () => {
    const r = run()
    expect(r.basis.join(' ')).toMatch(/generates no GSTR-1 JSON and files nothing/)
  })

  it('names every threshold it applied, with the figure', () => {
    const r = run()
    const basis = r.basis.join(' ')
    expect(basis).toContain('250000.00')
    expect(basis).toContain('50000.00')
    expect(basis).toMatch(/HSN digits expected: 6/)
    expect(basis).toMatch(/unverified/i)
  })

  it('excludes a voided invoice from the totals but keeps it in the series', () => {
    const r = run({
      invoices: [invoice({ status: 'VOIDED' })],
    })
    expect(r.taxableValue).toBe('0.00')
    expect(r.series[0]).toMatchObject({ total: 1, cancelled: 1, net: 0 })
  })
})
