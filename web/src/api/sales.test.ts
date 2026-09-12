import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type {
  CreditNote, PaymentInput, Quote, QuoteAllocation, QuoteLine, SaleInvoice, SaleReturnInput,
} from '@contract'
import * as D from '@/domain/decimal'
import {
  buildSalesPage, cashInDrawer, checkVoidable, computeDayClose, daysInRange, filterCreditNotes,
  isVoidable, matchesCreditNote, matchesSale, pctChange, priceSaleReturn, previousRange,
  requireReturnReason, resolveRange, returnableAllocations, saleModes, summariseReturns,
  summariseSales, voidMovements,
} from './sales'

/**
 * Hand-written fixtures, never the seed. A test that reads the demo history
 * stops asserting what a return MEANS and starts asserting what the generator
 * happened to produce this week.
 *
 * Every function under test is pure. None of them needs an IndexedDB, which is
 * the point of the module: these are the rules the Rust server has to reproduce.
 */

const TODAY = '2026-09-09'

// ------------------------------------------------------------- fixtures ---

function alloc(over: Partial<QuoteAllocation> = {}): QuoteAllocation {
  return {
    batchId: 1,
    batchNo: 'B1',
    expiryDate: '2027-06-30',
    qty: '10',
    freeQty: '0',
    mrpPerUnit: '11.2000',
    ratePerUnit: '11.2000',
    grossAmount: '112.00',
    discountAmount: '0.00',
    // A 12% line: 112.00 inclusive is 100.00 taxable + 6.00 + 6.00.
    taxableValue: '100.00',
    cgst: '6.00',
    sgst: '6.00',
    igst: '0.00',
    lineTotal: '112.00',
    gstRatePct: '12',
    costBasis: '70.00',
    ...over,
  }
}

function line(over: Partial<QuoteLine> = {}): QuoteLine {
  const allocations = over.allocations ?? [alloc()]
  const fold = (pick: (a: QuoteAllocation) => string): string =>
    D.toStr(D.sum(allocations.map((a) => D.dec(pick(a)))), 2)
  return {
    lineId: 'l1',
    medicineId: 1,
    brandName: 'Dolo 650',
    packLabel: '10x15',
    hsnCode: '30049099',
    drugSchedule: 'OTC',
    requestedQty: '10',
    allocatedQty: D.toStr(D.sum(allocations.map((a) => D.dec(a.qty))), 3),
    shortQty: '0',
    discountPct: '0',
    grossAmount: fold((a) => a.grossAmount),
    discountAmount: fold((a) => a.discountAmount),
    taxableValue: fold((a) => a.taxableValue),
    cgst: fold((a) => a.cgst),
    sgst: fold((a) => a.sgst),
    igst: fold((a) => a.igst),
    lineTotal: fold((a) => a.lineTotal),
    manualBatch: false,
    ...over,
    allocations,
  }
}

function quote(lines: QuoteLine[], over: Partial<Quote> = {}): Quote {
  const allocations = lines.flatMap((l) => l.allocations)
  const fold = (pick: (a: QuoteAllocation) => string): string =>
    D.toStr(D.sum(allocations.map((a) => D.dec(pick(a)))), 2)
  return {
    lines,
    grossAmount: fold((a) => a.grossAmount),
    itemDiscount: '0.00',
    billDiscountPct: '0',
    billDiscount: '0.00',
    taxableValue: fold((a) => a.taxableValue),
    cgst: fold((a) => a.cgst),
    sgst: fold((a) => a.sgst),
    igst: fold((a) => a.igst),
    roundOff: '0.00',
    netAmount: fold((a) => a.lineTotal),
    taxBreakup: [],
    warnings: [],
    costOfGoods: fold((a) => a.costBasis),
    ...over,
  }
}

function invoice(over: Partial<SaleInvoice> = {}): SaleInvoice {
  const q = over.quote ?? quote([line()])
  const payments: PaymentInput[] = over.payments ?? [{ mode: 'CASH', amount: q.netAmount }]
  return {
    id: 1,
    invoiceNo: 'RX2627-T1-00001',
    storeId: 1,
    terminalId: 1,
    invoiceDate: TODAY,
    createdAt: `${TODAY}T10:15:00.000Z`,
    customerId: null,
    customerName: null,
    customerPhone: null,
    interState: false,
    payments,
    amountPaid: D.toStr(D.sum(payments.map((p) => D.dec(p.amount))), 2),
    changeDue: '0.00',
    status: 'POSTED',
    prescription: null,
    operatorName: 'Counter 1',
    ...over,
    quote: q,
  }
}

const RETURN_CTX = { storeId: 1, operatorName: 'Counter 1', issuedOn: TODAY, createdAt: `${TODAY}T18:00:00.000Z` }

function returnInput(over: Partial<SaleReturnInput> = {}): SaleReturnInput {
  return {
    idempotencyKey: 'k1',
    invoiceId: 1,
    terminalId: 1,
    reason: 'Customer brought back an unopened strip',
    refundMode: 'CASH',
    lines: [{ lineId: 'l1', batchId: 1, qty: '5', disposition: 'RESTOCK' }],
    ...over,
  }
}

/** A priced credit note with the two document fields filled in, so it can be
 *  fed back as prior history the way the adapter feeds the stored register. */
function issued(priced: ReturnType<typeof priceSaleReturn>, id: number): CreditNote {
  return { ...priced.note, id, creditNoteNo: `RXCN2627-T1-${String(id).padStart(5, '0')}` }
}

// ---------------------------------------------------------------- ranges ---

describe('resolveRange', () => {
  it('reads the presets off a single day', () => {
    expect(resolveRange('today', TODAY)).toEqual({ from: TODAY, to: TODAY })
    expect(resolveRange('yesterday', TODAY)).toEqual({ from: '2026-09-08', to: '2026-09-08' })
    // 2026-09-09 is a Wednesday; the week starts on the Monday.
    expect(resolveRange('week', TODAY)).toEqual({ from: '2026-09-07', to: TODAY })
    expect(resolveRange('month', TODAY)).toEqual({ from: '2026-09-01', to: TODAY })
  })

  it('starts the week on Monday even when today IS Monday', () => {
    expect(resolveRange('week', '2026-09-07').from).toBe('2026-09-07')
    // Sunday belongs to the week that started six days earlier, not to the next.
    expect(resolveRange('week', '2026-09-13').from).toBe('2026-09-07')
  })

  it('swaps a custom range keyed the wrong way round rather than answering nothing', () => {
    expect(resolveRange('custom', TODAY, { from: '2026-09-30', to: '2026-09-01' }))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' })
  })

  it('falls back to today for a half-typed custom date', () => {
    expect(resolveRange('custom', TODAY, { from: '2026-09', to: '2026-09-30' }))
      .toEqual({ from: TODAY, to: '2026-09-30' })
  })
})

// ---------------------------------------------------------------- search ---

describe('matchesSale', () => {
  const inv = invoice({ customerName: 'Ramesh Kulkarni', customerPhone: '9822041100' })

  it('matches the invoice number, the name and the phone however it is typed', () => {
    expect(matchesSale(inv, '00001')).toBe(true)
    expect(matchesSale(inv, 'kulkarni')).toBe(true)
    expect(matchesSale(inv, '+91 98220 41100')).toBe(true)
    expect(matchesSale(inv, '41100')).toBe(true)
  })

  it('does not let the phone clause match every bill on an empty digit set', () => {
    // `''.includes('')` is true, so an unguarded phone clause matches everything.
    expect(matchesSale(inv, 'zzz')).toBe(false)
    expect(matchesSale(invoice({ customerPhone: null }), 'zzz')).toBe(false)
  })

  it('treats a blank term as no filter at all', () => {
    expect(matchesSale(inv, '   ')).toBe(true)
  })
})

// --------------------------------------------------------------- tenders ---

describe('tenders', () => {
  it('lists split tenders in one stable order', () => {
    const inv = invoice({
      payments: [{ mode: 'UPI', amount: '50.00' }, { mode: 'CASH', amount: '62.00' }],
    })
    expect(saleModes(inv)).toEqual(['CASH', 'UPI'])
  })

  it('nets change out of the cash taken', () => {
    // ₹500 in, ₹112 bill, ₹388 back: the drawer holds ₹112, not ₹500.
    const inv = invoice({ payments: [{ mode: 'CASH', amount: '500.00' }], changeDue: '388.00' })
    expect(D.toStr(cashInDrawer(inv), 2)).toBe('112.00')
  })

  it('lets change given against a card overpayment go negative', () => {
    const inv = invoice({ payments: [{ mode: 'CARD', amount: '200.00' }], changeDue: '88.00' })
    expect(D.toStr(cashInDrawer(inv), 2)).toBe('-88.00')
  })
})

// ------------------------------------------------------- what is returnable ---

describe('returnableAllocations', () => {
  it('caps at what was sold minus what has already come back', () => {
    const inv = invoice()
    const first = priceSaleReturn(inv, [], returnInput({ lines: [{ lineId: 'l1', batchId: 1, qty: '4', disposition: 'RESTOCK' }] }), RETURN_CTX)
    const rows = returnableAllocations(inv, [issued(first, 1)])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.soldQty).toBe('10')
    expect(rows[0]?.returnedQty).toBe('4')
    expect(rows[0]?.returnableQty).toBe('6')
  })

  it('splits a line that fanned across two batches into two returnable rows', () => {
    const inv = invoice({
      quote: quote([line({ allocations: [alloc(), alloc({ batchId: 2, batchNo: 'B2', qty: '3', lineTotal: '33.60' })] })]),
    })
    const rows = returnableAllocations(inv, [])
    expect(rows.map((r) => [r.batchNo, r.returnableQty])).toEqual([['B1', '10'], ['B2', '3']])
  })

  it('never offers free units, because there is nothing to credit against them', () => {
    const inv = invoice({ quote: quote([line({ allocations: [alloc({ freeQty: '2' })] })]) })
    expect(returnableAllocations(inv, [])[0]?.returnableQty).toBe('10')
  })
})

// ---------------------------------------------------------- credit notes ---

describe('priceSaleReturn', () => {
  it('reverses at the ORIGINAL rate, and the note foots', () => {
    const priced = priceSaleReturn(invoice(), [], returnInput(), RETURN_CTX)
    const l = priced.note.lines[0]
    expect(l?.gstRatePct).toBe('12')
    expect(l?.lineTotal).toBe('56.00')
    expect(l?.taxableValue).toBe('50.00')
    expect(l?.cgst).toBe('3.00')
    expect(l?.sgst).toBe('3.00')
    // taxable + cgst + sgst == the refund, by construction (I10, I12).
    expect(D.toStr(D.sum([D.dec(l?.taxableValue ?? '0'), D.dec(l?.cgst ?? '0'), D.dec(l?.sgst ?? '0')]), 2))
      .toBe(l?.lineTotal)
    expect(priced.note.netAmount).toBe('56.00')
  })

  it('reverses a 5% line at 5% even if the slab moved after the sale', () => {
    // The rate is read off the allocation. No rate table is passed in at all,
    // which is what makes re-rating impossible rather than merely discouraged.
    const inv = invoice({
      invoiceDate: '2025-09-01',
      quote: quote([line({ allocations: [alloc({ gstRatePct: '5', lineTotal: '105.00', taxableValue: '100.00', cgst: '2.50', sgst: '2.50' })] })]),
    })
    const priced = priceSaleReturn(inv, [], returnInput({ lines: [{ lineId: 'l1', batchId: 1, qty: '10', disposition: 'RESTOCK' }] }), RETURN_CTX)
    expect(priced.note.lines[0]?.gstRatePct).toBe('5')
    expect(priced.note.taxableValue).toBe('100.00')
    expect(priced.note.originalInvoiceDate).toBe('2025-09-01')
    expect(priced.note.issuedOn).toBe(TODAY)
  })

  it('carries the IGST split of an inter-state bill instead of halving it', () => {
    const inv = invoice({
      interState: true,
      quote: quote([line({ allocations: [alloc({ cgst: '0.00', sgst: '0.00', igst: '12.00' })] })]),
    })
    const l = priceSaleReturn(inv, [], returnInput(), RETURN_CTX).note.lines[0]
    expect([l?.cgst, l?.sgst, l?.igst]).toEqual(['0.00', '0.00', '6.00'])
  })

  it('makes three partial returns of a line sum to EXACTLY the original', () => {
    // 100.00 over 3 units: 33.33 + 33.33 + the remainder, not 33.33 x 3.
    const inv = invoice({
      quote: quote([line({ allocations: [alloc({ qty: '3', gstRatePct: '5', lineTotal: '100.00', taxableValue: '95.24', cgst: '2.38', sgst: '2.38' })] })]),
    })
    const notes: CreditNote[] = []
    for (let i = 0; i < 3; i += 1) {
      const priced = priceSaleReturn(
        inv, notes,
        returnInput({ idempotencyKey: `k${i}`, lines: [{ lineId: 'l1', batchId: 1, qty: '1', disposition: 'RESTOCK' }] }),
        RETURN_CTX,
      )
      notes.push(issued(priced, i + 1))
    }
    expect(notes.map((n) => n.netAmount)).toEqual(['33.33', '33.33', '33.34'])
    expect(D.toStr(D.sum(notes.map((n) => D.dec(n.netAmount))), 2)).toBe('100.00')
  })

  it('hands the invoice round-off back on the CLOSING note and on no other', () => {
    const inv = invoice({
      quote: quote([line()], { roundOff: '0.40', netAmount: '112.40' }),
    })
    const first = priceSaleReturn(inv, [], returnInput(), RETURN_CTX)
    expect(first.note.roundOff).toBe('0.00')
    expect(first.note.netAmount).toBe('56.00')

    const second = priceSaleReturn(inv, [issued(first, 1)], returnInput({ idempotencyKey: 'k2' }), RETURN_CTX)
    expect(second.note.roundOff).toBe('0.40')
    expect(second.note.netAmount).toBe('56.40')
    // The two notes together give back exactly what was collected.
    expect(D.toStr(D.add(D.dec(first.note.netAmount), D.dec(second.note.netAmount)), 2)).toBe('112.40')
  })

  it('refuses to credit more than is left on the allocation', () => {
    const inv = invoice()
    const first = priceSaleReturn(inv, [], returnInput(), RETURN_CTX)
    expect(() =>
      priceSaleReturn(inv, [issued(first, 1)], returnInput({ idempotencyKey: 'k2', lines: [{ lineId: 'l1', batchId: 1, qty: '6', disposition: 'RESTOCK' }] }), RETURN_CTX),
    ).toThrowError(expect.objectContaining({ code: 'RETURN_EXCEEDS_SOLD' }) as unknown as ApiError)
  })

  it('refuses the same allocation twice on one note', () => {
    // Both rows would be checked against the same remaining quantity, so a pair
    // that is individually legal can over-return between them.
    expect(() =>
      priceSaleReturn(invoice(), [], returnInput({
        lines: [
          { lineId: 'l1', batchId: 1, qty: '6', disposition: 'RESTOCK' },
          { lineId: 'l1', batchId: 1, qty: '6', disposition: 'RESTOCK' },
        ],
      }), RETURN_CTX),
    ).toThrowError(expect.objectContaining({ code: 'RETURN_LINE_REPEATED' }) as unknown as ApiError)
  })

  it('refuses a cancelled bill — there is nothing left to credit', () => {
    expect(() => priceSaleReturn(invoice({ status: 'VOIDED' }), [], returnInput(), RETURN_CTX))
      .toThrowError(expect.objectContaining({ code: 'SALE_NOT_POSTED' }) as unknown as ApiError)
  })

  it('prices without a reason, so the counter can quote the refund before explaining it', () => {
    // The screen runs this on every keystroke. If the reason gated the
    // arithmetic, the amount would stay blank until a sentence was typed.
    const priced = priceSaleReturn(invoice(), [], returnInput({ reason: '' }), RETURN_CTX)
    expect(priced.note.netAmount).toBe('56.00')
    expect(priced.note.reason).toBe('')
  })

  it('still refuses to POST one — that guard is separate on purpose', () => {
    expect(requireReturnReason('  Sealed strip, wrong strength  ')).toBe('Sealed strip, wrong strength')
    expect(() => requireReturnReason('ok'))
      .toThrowError(expect.objectContaining({ code: 'RETURN_REASON_REQUIRED' }) as unknown as ApiError)
  })

  describe('dispositions', () => {
    it('puts a RESTOCK straight back on the batch it came off', () => {
      const priced = priceSaleReturn(invoice(), [], returnInput(), RETURN_CTX)
      expect(priced.movements).toEqual([
        { batchId: 1, medicineId: 1, qtyDelta: '5', reason: 'SALE_RETURN', note: null },
      ])
      expect(priced.quarantineBatchIds).toEqual([])
    })

    it('books a DESTROY as a receipt AND a write-off, netting to nothing', () => {
      const priced = priceSaleReturn(invoice(), [], returnInput({
        lines: [{ lineId: 'l1', batchId: 1, qty: '5', disposition: 'DESTROY' }],
      }), RETURN_CTX)
      expect(priced.movements.map((m) => m.qtyDelta)).toEqual(['5', '-5'])
      expect(priced.movements.map((m) => m.reason)).toEqual(['SALE_RETURN', 'ADJUSTMENT'])
      // "It never came back" and "it came back and we binned it" have to stay
      // distinguishable, which is why this is two rows and not zero.
      expect(D.toStr(D.sum(priced.movements.map((m) => D.dec(m.qtyDelta))), 3)).toBe('0.000')
      // The credit note is unaffected: the customer is owed the money either way.
      expect(priced.note.netAmount).toBe('56.00')
    })

    it('names the batch a QUARANTINE line blocks', () => {
      const priced = priceSaleReturn(invoice(), [], returnInput({
        lines: [{ lineId: 'l1', batchId: 1, qty: '5', disposition: 'QUARANTINE' }],
      }), RETURN_CTX)
      expect(priced.quarantineBatchIds).toEqual([1])
      expect(priced.movements).toHaveLength(1)
    })
  })
})

// ----------------------------------------------------------------- voids ---

describe('the void', () => {
  const older = invoice({ invoiceDate: '2026-09-01' })

  it('allows a same-day cancellation with a reason', () => {
    expect(isVoidable(invoice(), [], TODAY)).toBe(true)
    expect(checkVoidable(invoice(), [], TODAY, '  Wrong  customer  attached ')).toBe('Wrong customer attached')
  })

  it('refuses a bill from a closed day — that is what a credit note is for', () => {
    expect(isVoidable(older, [], TODAY)).toBe(false)
    expect(() => checkVoidable(older, [], TODAY, 'Keyed against the wrong customer'))
      .toThrowError(expect.objectContaining({ code: 'SALE_TOO_OLD_TO_VOID' }) as unknown as ApiError)
  })


  it("refuses a TODAY bill once the drawer has been counted for today", () => {
    // The close records an expected cash figure and the variance against it.
    // Cancelling a cash bill afterwards moves the expected figure and leaves the
    // stored variance quoting an amount that no longer reconciles, with the
    // header chip still reporting it as balanced.
    expect(isVoidable(invoice(), [], TODAY, true)).toBe(false)
    expect(() => checkVoidable(invoice(), [], TODAY, 'Wrong customer attached', true))
      .toThrowError(expect.objectContaining({ code: 'DAY_ALREADY_CLOSED' }) as unknown as ApiError)
  })

  it("reports a bill from another day as too old, not as a day close", () => {
    // Both refusals are true of an old bill on a closed day, and only one of
    // them tells the operator anything they can act on.
    expect(() => checkVoidable(older, [], TODAY, 'Keyed against the wrong customer', true))
      .toThrowError(expect.objectContaining({ code: 'SALE_TOO_OLD_TO_VOID' }) as unknown as ApiError)
  })

  it('still voids freely while the day is open', () => {
    expect(isVoidable(invoice(), [], TODAY, false)).toBe(true)
    expect(checkVoidable(invoice(), [], TODAY, 'Wrong customer attached', false))
      .toBe('Wrong customer attached')
  })

  it('refuses a bill a credit note already points at', () => {
    const note = issued(priceSaleReturn(invoice(), [], returnInput(), RETURN_CTX), 1)
    expect(isVoidable(invoice(), [note], TODAY)).toBe(false)
    expect(() => checkVoidable(invoice(), [note], TODAY, 'Keyed against the wrong customer'))
      .toThrowError(expect.objectContaining({ code: 'SALE_HAS_CREDIT_NOTE' }) as unknown as ApiError)
  })

  it('refuses an unexplained cancellation and a second one', () => {
    expect(() => checkVoidable(invoice(), [], TODAY, 'oops'))
      .toThrowError(expect.objectContaining({ code: 'VOID_REASON_REQUIRED' }) as unknown as ApiError)
    expect(() => checkVoidable(invoice({ status: 'VOIDED' }), [], TODAY, 'Keyed twice by mistake'))
      .toThrowError(expect.objectContaining({ code: 'SALE_ALREADY_VOID' }) as unknown as ApiError)
  })

  it('puts free units back too — they left the shelf with the sale', () => {
    const inv = invoice({ quote: quote([line({ allocations: [alloc({ qty: '10', freeQty: '2' })] })]) })
    expect(voidMovements(inv)).toEqual([
      { batchId: 1, medicineId: 1, qtyDelta: '12', reason: 'SALE_RETURN', note: `Void of ${inv.invoiceNo}` },
    ])
  })
})

// -------------------------------------------------------------- register ---

describe('buildSalesPage', () => {
  const bills: SaleInvoice[] = [
    invoice({ id: 1, invoiceNo: 'RX-1', createdAt: `${TODAY}T09:00:00.000Z`, customerName: 'Asha' }),
    invoice({
      id: 2, invoiceNo: 'RX-2', createdAt: `${TODAY}T11:00:00.000Z`, customerName: 'Bhaskar',
      payments: [{ mode: 'UPI', amount: '112.00' }],
    }),
    invoice({ id: 3, invoiceNo: 'RX-3', createdAt: `${TODAY}T12:00:00.000Z`, status: 'VOIDED', voidReason: 'Keyed twice' }),
    invoice({ id: 4, invoiceNo: 'RX-4', invoiceDate: '2026-09-08', createdAt: '2026-09-08T12:00:00.000Z' }),
  ]
  const range = { from: TODAY, to: TODAY }

  it('keeps a voided bill VISIBLE IN PLACE, marked', () => {
    const page = buildSalesPage({ invoices: bills, creditNotes: [] }, range)
    expect(page.rows.map((r) => r.invoiceNo)).toEqual(['RX-3', 'RX-2', 'RX-1'])
    expect(page.rows.find((r) => r.invoiceNo === 'RX-3')?.status).toBe('VOIDED')
  })

  it('leaves a bill out of the range out of the page', () => {
    const page = buildSalesPage({ invoices: bills, creditNotes: [] }, range)
    expect(page.rows.some((r) => r.invoiceNo === 'RX-4')).toBe(false)
    expect(page.total).toBe(3)
  })

  it('sorts newest-first by default, and by amount or number on request', () => {
    const big = invoice({ id: 5, invoiceNo: 'RX-0', createdAt: `${TODAY}T08:00:00.000Z`, quote: quote([line({ allocations: [alloc({ lineTotal: '999.00' })] })]) })
    const deps = { invoices: [...bills, big], creditNotes: [] }
    expect(buildSalesPage(deps, { ...range, sort: 'amount' }).rows[0]?.invoiceNo).toBe('RX-0')
    expect(buildSalesPage(deps, { ...range, sort: 'invoiceNo' }).rows.map((r) => r.invoiceNo))
      .toEqual(['RX-0', 'RX-1', 'RX-2', 'RX-3'])
  })

  it('marks a part-returned bill as such and carries what came back', () => {
    const note = issued(priceSaleReturn(bills[0] as SaleInvoice, [], returnInput(), RETURN_CTX), 1)
    const row = buildSalesPage({ invoices: bills, creditNotes: [note] }, range).rows.find((r) => r.id === 1)
    expect(row?.status).toBe('PART_RETURNED')
    expect(row?.returnedAmount).toBe('56.00')
  })

  it('marks a bill RETURNED only once every charged unit is back', () => {
    const inv = bills[0] as SaleInvoice
    const whole = issued(
      priceSaleReturn(inv, [], returnInput({ lines: [{ lineId: 'l1', batchId: 1, qty: '10', disposition: 'RESTOCK' }] }), RETURN_CTX),
      1,
    )
    expect(buildSalesPage({ invoices: bills, creditNotes: [whole] }, range).rows.find((r) => r.id === 1)?.status)
      .toBe('RETURNED')
  })

  it('filters by tender and by status', () => {
    const deps = { invoices: bills, creditNotes: [] }
    expect(buildSalesPage(deps, { ...range, mode: 'UPI' }).rows.map((r) => r.invoiceNo)).toEqual(['RX-2'])
    expect(buildSalesPage(deps, { ...range, status: 'voided' }).rows.map((r) => r.invoiceNo)).toEqual(['RX-3'])
  })

  it('pages from a cursor and reports where the next page starts', () => {
    const page = buildSalesPage({ invoices: bills, creditNotes: [] }, { ...range, limit: 2 })
    expect(page.rows).toHaveLength(2)
    expect(page.nextCursor).toBe(2)
    expect(buildSalesPage({ invoices: bills, creditNotes: [] }, { ...range, limit: 2, cursor: 2 }).nextCursor).toBeNull()
  })

  it('does NOT let the search box rewrite the day’s numbers', () => {
    // The tiles are the day's takings. If hunting for one bill collapsed them to
    // that bill, the operator would have no way to read the day while filtered.
    const page = buildSalesPage({ invoices: bills, creditNotes: [] }, { ...range, term: 'Asha' })
    expect(page.rows).toHaveLength(1)
    expect(page.summary.bills).toBe(2)
    expect(page.summary.netSales).toBe('224.00')
  })
})

describe('summariseSales', () => {
  it('counts posted bills only, and voided ones separately', () => {
    const s = summariseSales(
      [invoice({ id: 1 }), invoice({ id: 2, status: 'VOIDED' })],
      [], TODAY, TODAY,
    )
    expect(s.bills).toBe(1)
    expect(s.netSales).toBe('112.00')
    expect(s.averageBill).toBe('112.00')
    expect(s.voidedBills).toBe(1)
    expect(s.voidedAmount).toBe('112.00')
  })

  it('does not divide by zero bills', () => {
    expect(summariseSales([], [], TODAY, TODAY).averageBill).toBe('0.00')
  })

  it('splits the tender with cash net of change', () => {
    const s = summariseSales(
      [
        invoice({ id: 1, payments: [{ mode: 'CASH', amount: '500.00' }], changeDue: '388.00' }),
        invoice({ id: 2, payments: [{ mode: 'CASH', amount: '12.00' }, { mode: 'UPI', amount: '100.00' }] }),
      ],
      [], TODAY, TODAY,
    )
    expect(s.byMode.find((m) => m.mode === 'CASH')).toEqual({ mode: 'CASH', amount: '124.00', bills: 2 })
    expect(s.byMode.find((m) => m.mode === 'UPI')).toEqual({ mode: 'UPI', amount: '100.00', bills: 1 })
    expect(s.byMode.find((m) => m.mode === 'CARD')).toEqual({ mode: 'CARD', amount: '0.00', bills: 0 })
  })

  it('counts a credit note in the period it was ISSUED, not the bill’s', () => {
    const old = invoice({ invoiceDate: '2026-08-20' })
    const note = issued(priceSaleReturn(old, [], returnInput(), RETURN_CTX), 1)
    expect(summariseSales([], [note], TODAY, TODAY).returns).toBe('56.00')
    expect(summariseSales([], [note], '2026-08-01', '2026-08-31').returns).toBe('0.00')
  })
})

// ------------------------------------------------------------- day close ---

describe('computeDayClose', () => {
  const deps = (over: Partial<Parameters<typeof computeDayClose>[1]> = {}) => ({
    invoices: [
      invoice({ id: 1, payments: [{ mode: 'CASH', amount: '500.00' }], changeDue: '388.00' }),
      invoice({ id: 2, payments: [{ mode: 'UPI', amount: '112.00' }] }),
      invoice({ id: 3, status: 'VOIDED' }),
    ],
    creditNotes: [],
    operatorName: 'Counter 1',
    closedAt: `${TODAY}T20:14:00.000Z`,
    ...over,
  })

  const input = { date: TODAY, terminalId: 1, openingFloat: '2000.00', countedCash: '2112.00' }

  it('expects the float plus the cash actually taken, and nets the variance', () => {
    const close = computeDayClose(input, deps())
    expect(close.expectedCash).toBe('2112.00')
    expect(close.variance).toBe('0.00')
    // A voided bill contributed nothing, and the UPI bill left no cash.
    expect(close.bills).toBe(2)
  })

  it('reads a short drawer as a negative variance', () => {
    expect(computeDayClose({ ...input, countedCash: '2062.00' }, deps()).variance).toBe('-50.00')
    expect(computeDayClose({ ...input, countedCash: '2150.00' }, deps()).variance).toBe('38.00')
  })

  it('takes a CASH refund out of the drawer and leaves a UPI refund alone', () => {
    const inv = invoice({ id: 1 })
    const cash = issued(priceSaleReturn(inv, [], returnInput(), RETURN_CTX), 1)
    const upi = issued(priceSaleReturn(inv, [], returnInput({ idempotencyKey: 'k2', refundMode: 'UPI' }), RETURN_CTX), 2)

    expect(computeDayClose(input, deps({ creditNotes: [cash] })).expectedCash).toBe('2056.00')
    // Money that went back the way it came never touched the till.
    expect(computeDayClose(input, deps({ creditNotes: [upi] })).expectedCash).toBe('2112.00')
    expect(computeDayClose(input, deps({ creditNotes: [cash, upi] })).returns).toBe('112.00')
  })

  it('refuses a count that is not an amount', () => {
    expect(() => computeDayClose({ ...input, countedCash: '' }, deps()))
      .toThrowError(expect.objectContaining({ code: 'DAY_CLOSE_INVALID' }) as unknown as ApiError)
    expect(() => computeDayClose({ ...input, openingFloat: 'two thousand' }, deps()))
      .toThrowError(expect.objectContaining({ code: 'DAY_CLOSE_INVALID' }) as unknown as ApiError)
  })
})

// -------------------------------------------------- the period comparison ---

describe('previousRange', () => {
  it('answers yesterday for a single day', () => {
    expect(previousRange(TODAY, TODAY)).toEqual({ from: '2026-09-08', to: '2026-09-08' })
  })

  it('takes the SAME NUMBER OF DAYS immediately before, not the calendar unit', () => {
    // Month-to-date on the 9th is nine days, and it is compared with the nine
    // days before it. Comparing it with the whole of last month would report
    // every month as collapsing until its final week.
    expect(previousRange('2026-09-01', '2026-09-09')).toEqual({ from: '2026-08-23', to: '2026-08-31' })
  })

  it('walks across a month boundary without losing or repeating a day', () => {
    expect(daysInRange('2026-09-01', '2026-09-09')).toBe(9)
    const prev = previousRange('2026-03-01', '2026-03-31')
    expect(daysInRange(prev.from, prev.to)).toBe(31)
    expect(prev.to).toBe('2026-02-28')
  })
})

describe('pctChange', () => {
  it('reports the move against the earlier figure', () => {
    expect(pctChange('100.00', '112.00')).toBe('12.0')
    expect(pctChange('200.00', '100.00')).toBe('-50.0')
    expect(pctChange('100.00', '100.00')).toBe('0.0')
  })

  it('refuses to invent a basis where there was none', () => {
    // "Up 100% from nothing" is not a fact, and ∞ is not a figure a shopkeeper
    // can act on. The screen says "new" instead.
    expect(pctChange('0.00', '4500.00')).toBeNull()
    expect(pctChange('0.00', '0.00')).toBeNull()
  })
})

// ------------------------------------------------------------- the profile ---

/** Built from LOCAL clock parts, so the assertion holds in any timezone. */
const atLocal = (hour: number, minute = 0): string =>
  new Date(2026, 8, 9, hour, minute).toISOString()

describe('summariseSales — the trading profile', () => {
  it('files a bill under the hour on the SHOP’s clock, and emits all 24', () => {
    const s = summariseSales(
      [
        invoice({ id: 1, createdAt: atLocal(11, 5) }),
        invoice({ id: 2, createdAt: atLocal(11, 55) }),
        invoice({ id: 3, createdAt: atLocal(19) }),
        // A cancelled bill is not trade and must not raise a bar.
        invoice({ id: 4, createdAt: atLocal(19, 30), status: 'VOIDED' }),
      ],
      [], TODAY, TODAY,
    )
    expect(s.byHour).toHaveLength(24)
    expect(s.byHour.map((h) => h.hour)).toEqual([...Array(24).keys()])
    expect(s.byHour[11]).toEqual({ hour: 11, bills: 2, amount: '224.00' })
    expect(s.byHour[19]).toEqual({ hour: 19, bills: 1, amount: '112.00' })
    expect(s.byHour[3]).toEqual({ hour: 3, bills: 0, amount: '0.00' })
  })

  it('adds up to the day’s takings', () => {
    const s = summariseSales(
      [invoice({ id: 1, createdAt: atLocal(9) }), invoice({ id: 2, createdAt: atLocal(21) })],
      [], TODAY, TODAY,
    )
    expect(D.toStr(D.sum(s.byHour.map((h) => D.dec(h.amount))), 2)).toBe(s.netSales)
  })
})

describe('summariseSales — the operator leaderboard', () => {
  const bills = [
    invoice({ id: 1, operatorName: 'Asha' }),
    invoice({ id: 2, operatorName: 'Asha' }),
    invoice({
      id: 3, operatorName: 'Bhaskar',
      quote: quote([line({ allocations: [alloc({ qty: '4', lineTotal: '500.00' })] })]),
    }),
    invoice({ id: 4, operatorName: 'Bhaskar', status: 'VOIDED' }),
  ]

  it('ranks by takings and carries the average bill', () => {
    const board = summariseSales(bills, [], TODAY, TODAY).byOperator
    expect(board.map((o) => o.operatorName)).toEqual(['Bhaskar', 'Asha'])
    expect(board[0]).toEqual({
      operatorName: 'Bhaskar', bills: 1, amount: '500.00', averageBill: '500.00', itemsSold: '4',
    })
    // Two bills of 112.00, and the cancelled one is not one of them.
    expect(board[1]).toEqual({
      operatorName: 'Asha', bills: 2, amount: '224.00', averageBill: '112.00', itemsSold: '20',
    })
  })

  it('keeps an unnamed operator visible rather than dropping the bill', () => {
    const board = summariseSales([invoice({ id: 1, operatorName: '  ' })], [], TODAY, TODAY).byOperator
    expect(board.map((o) => o.operatorName)).toEqual(['Unattributed'])
  })
})

// ---------------------------------------------------------- return register ---

describe('the returns register', () => {
  const inv = invoice({ id: 1, invoiceNo: 'RX-1', customerName: 'Asha Kulkarni' })
  const first = issued(priceSaleReturn(inv, [], returnInput(), RETURN_CTX), 1)
  const second = issued(
    priceSaleReturn(
      inv, [first],
      returnInput({
        idempotencyKey: 'k2', refundMode: 'UPI',
        lines: [{ lineId: 'l1', batchId: 1, qty: '2', disposition: 'QUARANTINE' }],
      }),
      { ...RETURN_CTX, createdAt: `${TODAY}T19:00:00.000Z` },
    ),
    2,
  )

  it('finds a note by the BILL it reverses, not only by its own number', () => {
    // Somebody at the counter has the bill in their hand, not the credit note.
    expect(matchesCreditNote(first, 'RX-1')).toBe(true)
    expect(matchesCreditNote(first, first.creditNoteNo)).toBe(true)
    expect(matchesCreditNote(first, 'asha')).toBe(true)
    expect(matchesCreditNote(first, 'RX-9')).toBe(false)
  })

  it('filters by how the money went back, and orders three ways', () => {
    const all = [first, second]
    expect(filterCreditNotes(all, { refundMode: 'UPI' }).map((n) => n.id)).toEqual([2])
    expect(filterCreditNotes(all, {}).map((n) => n.id)).toEqual([2, 1])
    expect(filterCreditNotes(all, { sort: 'amount' }).map((n) => n.id)).toEqual([1, 2])
    expect(filterCreditNotes(all, { sort: 'noteNo' }).map((n) => n.id)).toEqual([1, 2])
  })

  it('counts what came back and where the goods went', () => {
    const totals = summariseReturns([first, second])
    expect(totals.notes).toBe(2)
    expect(totals.value).toBe(D.toStr(D.add(D.dec(first.netAmount), D.dec(second.netAmount)), 2))
    expect(totals.units).toBe('7')
    // A held batch is off the shelf but still credited: the two facts are
    // separate and the register has to carry both.
    expect(totals.quarantined).toBe(1)
    expect(totals.destroyed).toBe(0)
    expect(totals.byRefundMode.find((m) => m.mode === 'CASH')?.amount).toBe(first.netAmount)
    expect(totals.byRefundMode.find((m) => m.mode === 'CARD')).toEqual({ mode: 'CARD', amount: '0.00', bills: 0 })
  })
})
