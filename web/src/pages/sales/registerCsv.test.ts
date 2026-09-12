import { describe, expect, it } from 'vitest'
import type { CreditNote, CreditNoteLine, SaleRegisterRow, SalesSummary } from '@contract'
import { summariseSales } from '@/api/sales'
import { toCsv } from '@/pages/reports/exportCsv'
import { creditNoteRegisterCsv, invoiceRegisterCsv } from './registerCsv'

/**
 * The register export.
 *
 * These assert the CONTRACT the file makes with whoever opens it — that a
 * cancelled bill is listed and contributes nothing, that a filtered export says
 * so in its own manifest, and that a truncated one refuses to look complete.
 * The escaping itself is `exportCsv`'s own suite; this is about what the rows
 * and the manifest mean.
 */

const CTX = {
  productName: 'RxBill',
  from: '2026-09-09',
  to: '2026-09-09',
  generatedAt: '2026-09-09T20:10:00.000Z',
  appliedFilters: [] as string[],
  truncated: false,
}

function row(over: Partial<SaleRegisterRow> = {}): SaleRegisterRow {
  return {
    id: 1,
    invoiceNo: 'RX2627-T1-00001',
    invoiceDate: '2026-09-09',
    createdAt: '2026-09-09T10:15:00.000Z',
    customerName: 'Asha Kulkarni',
    customerPhone: '9822041100',
    lineCount: 2,
    itemQty: '12',
    netAmount: '1240.00',
    modes: ['CASH'],
    status: 'POSTED',
    returnedAmount: '0.00',
    terminalId: 1,
    operatorName: 'Counter 1',
    ...over,
  }
}

const EMPTY_SUMMARY: SalesSummary = summariseSales([], [], '2026-09-09', '2026-09-09')

const summaryWith = (netSales: string): SalesSummary => ({ ...EMPTY_SUMMARY, netSales })

function creditLine(over: Partial<CreditNoteLine> = {}): CreditNoteLine {
  return {
    lineId: 'l1',
    medicineId: 1,
    brandName: 'Dolo 650',
    packLabel: '10x15',
    hsnCode: '30049099',
    batchId: 1,
    batchNo: 'B1',
    expiryDate: '2027-06-30',
    qty: '5',
    ratePerUnit: '11.2000',
    gstRatePct: '12',
    taxableValue: '50.00',
    cgst: '3.00',
    sgst: '3.00',
    igst: '0.00',
    lineTotal: '56.00',
    disposition: 'RESTOCK',
    ...over,
  }
}

function note(over: Partial<CreditNote> = {}): CreditNote {
  const lines = over.lines ?? [creditLine()]
  return {
    id: 1,
    creditNoteNo: 'RXCN2627-T1-00001',
    storeId: 1,
    terminalId: 1,
    invoiceId: 1,
    invoiceNo: 'RX2627-T1-00001',
    originalInvoiceDate: '2026-08-20',
    issuedOn: '2026-09-09',
    createdAt: '2026-09-09T18:00:00.000Z',
    customerId: null,
    customerName: 'Asha Kulkarni',
    interState: false,
    taxableValue: '50.00',
    cgst: '3.00',
    sgst: '3.00',
    igst: '0.00',
    roundOff: '0.00',
    netAmount: '56.00',
    refundMode: 'CASH',
    reason: 'Customer brought back an unopened strip',
    operatorName: 'Counter 1',
    ...over,
    lines,
  }
}

describe('invoiceRegisterCsv', () => {
  it('lists a cancelled bill and gives it no value', () => {
    const result = invoiceRegisterCsv(
      [row(), row({ id: 2, invoiceNo: 'RX-2', status: 'VOIDED', netAmount: '900.00' })],
      summaryWith('1240.00'),
      CTX,
    )
    expect(result.rows).toHaveLength(2)
    const voided = result.rows.find((r) => r.key === 'sale-2')
    // Null, not zero: a cancelled bill did not take nothing, it did not happen —
    // and a zero would be summed by whoever pivots the file.
    expect(voided?.cells['net']).toBeNull()
    expect(voided?.cells['status']).toBe('Cancelled')
    expect(result.totals['net']).toBe('1240.00')
  })

  it('reconciles against the range summary, and only when nothing is filtered', () => {
    const clean = invoiceRegisterCsv([row()], summaryWith('1240.00'), CTX)
    expect(clean.checks[0]?.balanced).toBe(true)
    expect(clean.checks[0]?.difference).toBe('0.00')

    const wrong = invoiceRegisterCsv([row()], summaryWith('2000.00'), CTX)
    expect(wrong.checks[0]?.balanced).toBe(false)

    // A filtered register is a subset by design. A check that can never balance
    // teaches the reader to ignore the one control on the file.
    const filtered = invoiceRegisterCsv([row()], summaryWith('2000.00'), {
      ...CTX, appliedFilters: ['cash bills only'],
    })
    expect(filtered.checks).toHaveLength(0)
    expect(filtered.basis.some((b) => b.includes('cash bills only'))).toBe(true)
  })

  it('says in the file itself when the export was cut short', () => {
    const cut = invoiceRegisterCsv([row()], summaryWith('1240.00'), { ...CTX, truncated: true })
    expect(cut.notes[0]).toMatch(/NOT the whole range/)
    // A truncated file cannot claim to reconcile either.
    expect(cut.checks).toHaveLength(0)
  })

  it('survives the serialiser with the phone intact and the manifest attached', () => {
    const csv = toCsv(invoiceRegisterCsv([row({ customerPhone: '09822041100' })], summaryWith('1240.00'), CTX))
    expect(csv.startsWith('﻿')).toBe(true)
    // The RESELLER's name heads the file, and the register names itself.
    expect(csv).toContain('"RxBill report",Sale register')
    // A leading zero is eaten by a spreadsheet unless the cell is guarded, and
    // 0982… and 982… are different phone numbers.
    expect(csv).toContain('="09822041100"')
    expect(csv).toContain('1240.00')
  })
})

describe('creditNoteRegisterCsv', () => {
  it('carries the original bill and its date beside the issue date', () => {
    const result = creditNoteRegisterCsv([note()], CTX)
    const only = result.rows[0]
    expect(only?.cells['issuedOn']).toBe('2026-09-09')
    // The tax reversed is the tax that was charged, and the slab can have moved
    // between the two dates (invariant I21). Both dates travel.
    expect(only?.cells['billDate']).toBe('2026-08-20')
    expect(only?.cells['invoiceNo']).toBe('RX2627-T1-00001')
    expect(result.totals['net']).toBe('56.00')
  })

  it('names every disposition on the note, in a fixed order', () => {
    const mixed = note({
      lines: [
        creditLine({ disposition: 'DESTROY' }),
        creditLine({ lineId: 'l2', disposition: 'RESTOCK' }),
      ],
    })
    expect(creditNoteRegisterCsv([mixed], CTX).rows[0]?.cells['disposition'])
      .toBe('Back on the shelf, Destroyed')
  })

  it('foots: taxable plus tax plus round-off is the refund', () => {
    const check = creditNoteRegisterCsv([note()], CTX).checks[0]
    expect(check?.balanced).toBe(true)
    expect(check?.left).toBe('56.00')

    const broken = creditNoteRegisterCsv([note({ netAmount: '60.00' })], CTX).checks[0]
    expect(broken?.balanced).toBe(false)
    expect(broken?.difference).toBe('-4.00')
  })

  it('counts what did not go back on the shelf', () => {
    const held = note({
      lines: [creditLine({ disposition: 'QUARANTINE' }), creditLine({ lineId: 'l2' })],
    })
    const headline = creditNoteRegisterCsv([held], CTX).headline
    expect(headline.find((h) => h.label === 'Not resaleable')?.value).toBe('1')
  })
})
