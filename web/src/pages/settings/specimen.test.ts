import { describe, expect, it } from 'vitest'
import type { StoreProfile } from '@contract'
import * as D from '@/domain/decimal'
import { specimenInvoice } from './specimen'

/**
 * The specimen bill on the branding preview has to FOOT.
 *
 * It is hand-written data rather than the output of the quote engine, which
 * means it is the one bill in this app nothing else checks — and the first thing
 * a pharmacist does with a sample receipt is add the column up. A preview that
 * does not balance discredits every other claim on the panel.
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
  nearExpiryBuckets: [180, 90, 60, 30],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: 'sanjeevani@okhdfc',
  footerNote: 'Store below 25°C.',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

const AT = new Date('2026-09-09T10:00:00.000Z')
const sum = (xs: string[]) => D.toStr(D.sum(xs.map(D.dec)))

describe('the specimen bill', () => {
  const invoice = specimenInvoice(STORE, AT)
  const { quote } = invoice

  it('adds its lines up to the gross', () => {
    expect(sum(quote.lines.map((l) => l.lineTotal))).toBe(quote.grossAmount)
  })

  it('has a taxable value and a tax that reconstruct the gross', () => {
    expect(sum([quote.taxableValue, quote.cgst, quote.sgst, quote.igst])).toBe(quote.grossAmount)
  })

  it('sums each line\'s tax to the bill\'s tax', () => {
    expect(sum(quote.lines.map((l) => l.cgst))).toBe(quote.cgst)
    expect(sum(quote.lines.map((l) => l.sgst))).toBe(quote.sgst)
    expect(sum(quote.lines.map((l) => l.taxableValue))).toBe(quote.taxableValue)
  })

  it('has a rate breakup that adds to the same gross', () => {
    expect(sum(quote.taxBreakup.map((r) => r.total))).toBe(quote.grossAmount)
    expect(sum(quote.taxBreakup.map((r) => r.taxableValue))).toBe(quote.taxableValue)
  })

  it('rounds off to the net, and the change is the net against what was paid', () => {
    expect(sum([quote.grossAmount, quote.roundOff])).toBe(quote.netAmount)
    expect(sum([quote.netAmount, invoice.changeDue])).toBe(invoice.amountPaid)
  })

  it('does not round off when the shop has round-off turned off', () => {
    const plain = specimenInvoice({ ...STORE, roundOffEnabled: false }, AT).quote
    expect(plain.roundOff).toBe('0.00')
    expect(plain.netAmount).toBe(plain.grossAmount)
  })

  it('every allocation reconstructs its own line', () => {
    for (const l of quote.lines) {
      expect(sum(l.allocations.map((a) => a.lineTotal))).toBe(l.lineTotal)
    }
  })

  it('says on its face that it is not a document', () => {
    // It renders the real receipt component; if it ever reaches paper, the
    // number is the first thing anybody reads.
    expect(invoice.invoiceNo).toContain('SPECIMEN')
    expect(invoice.customerName).toMatch(/not a real bill/i)
  })

  it('carries two GST rates and a Schedule H line, so the preview is a real receipt', () => {
    expect(new Set(quote.taxBreakup.map((r) => r.gstRatePct)).size).toBe(2)
    expect(quote.lines.some((l) => l.drugSchedule === 'H')).toBe(true)
  })

  it('is stamped with the branch being previewed, not a fixed shop', () => {
    const other = specimenInvoice({ ...STORE, id: 4, invoicePrefix: 'KT' }, AT)
    expect(other.storeId).toBe(4)
    expect(other.invoiceNo).toBe('KT/SPECIMEN')
  })
})
