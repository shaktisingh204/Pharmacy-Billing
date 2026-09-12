import { describe, expect, it } from 'vitest'
import type { Quote, SaleInvoice, StoreProfile } from '@contract'
import { DEFAULT_BRAND } from '@/brand/applyBrand'
import {
  CMD, drawerBytes, encodeLine, receiptBytes, shouldOpenDrawer, testPageBytes, transliterate,
  wrapText,
} from './escpos'

/**
 * Byte generation is where a printer integration goes wrong, and it goes wrong
 * silently — the paper comes out, it is just subtly unreadable. Every test here
 * is a bill somebody would be handed.
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
  dlNos: ['MH-PN1-114B', 'MH-PN1-115C'],
  invoicePrefix: 'RX',
  financialYearStartMonth: 4,
  currency: 'INR',
  expiryGuardDays: 30,
  nearExpiryBuckets: [30, 60, 90, 180],
  roundOffEnabled: true,
  allowNegativeStock: false,
  upiVpa: null,
  footerNote: 'Medicines once sold are not returnable — store below 25°C.',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

const quote = (over: Partial<Quote> = {}): Quote => ({
  lines: [{
    lineId: 'l1', medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15',
    hsnCode: '30049099', drugSchedule: 'H', requestedQty: '10', allocatedQty: '10',
    shortQty: '0', discountPct: '0', grossAmount: '100.00', discountAmount: '0.00',
    taxableValue: '89.29', cgst: '5.36', sgst: '5.35', igst: '0.00',
    lineTotal: '100.00', manualBatch: false,
    allocations: [{
      batchId: 1, batchNo: 'AX2314', expiryDate: '2027-11-30', qty: '10', freeQty: '0',
      mrpPerUnit: '10.0000', lineTotal: '100.00',
    }],
  }],
  taxableValue: '89.29', cgst: '5.36', sgst: '5.35', igst: '0.00',
  discountTotal: '0.00', billDiscount: '0.00', roundOff: '0.00', netAmount: '100.00',
  rateBreakup: [], errors: [],
  ...over,
} as Quote)

const invoice = (over: Partial<SaleInvoice> = {}): SaleInvoice => ({
  id: 1,
  invoiceNo: 'RX2627-T1-00001',
  storeId: 1,
  terminalId: 1,
  invoiceDate: '2026-09-09',
  createdAt: '2026-09-09T10:00:00.000Z',
  customerId: null,
  customerName: null,
  customerPhone: null,
  interState: false,
  quote: quote(),
  payments: [{ mode: 'CASH', amount: '100.00' }],
  amountPaid: '100.00',
  changeDue: '0.00',
  status: 'POSTED',
  prescription: null,
  operatorName: 'Akib',
  ...over,
})

/**
 * The printable text, with command sequences SKIPPED rather than filtered.
 *
 * Filtering only the non-printable bytes leaves the printable ones that are part
 * of a command — `ESC a 0` leaves an `a`, `GS ! 0` leaves a `!` — which glues
 * them onto the next line and makes every width assertion lie.
 */
const COMMAND_LENGTH: Record<string, number> = {
  '27,64': 2, '27,69': 3, '27,97': 3, '27,116': 3, '27,100': 3, '27,112': 5,
  '29,33': 3, '29,86': 4,
}

const text = (bytes: Uint8Array): string => {
  const a = [...bytes]
  let out = ''
  for (let i = 0; i < a.length;) {
    const len = COMMAND_LENGTH[`${a[i]},${a[i + 1]}`]
    if ((a[i] === 27 || a[i] === 29) && len !== undefined) { i += len; continue }
    const b = a[i] ?? 0
    out += b === 0x0a ? '\n' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ''
    i += 1
  }
  return out
}

const has = (bytes: Uint8Array, seq: readonly number[]): boolean => {
  const a = [...bytes]
  return a.some((_, i) => seq.every((v, j) => a[i + j] === v))
}

// ------------------------------------------------------------ the ₹ sign ---

describe('the rupee sign, which is what breaks', () => {
  it('transliterates ₹ by default — it is in NO classic ESC/POS code page', () => {
    // U+20B9 was adopted in 2010; CP437, CP850 and CP1252 all predate it. Sent
    // raw it prints one garbage glyph on every money line of every bill.
    expect(transliterate('₹1,234.50')).toBe('Rs1,234.50')
    expect(text(receiptBytes(invoice(), STORE, null))).not.toContain('?')
  })

  it('can be turned off for a printer known to carry it', () => {
    const raw = encodeLine('₹100', { transliterateRupee: false })
    // Out of the 7-bit range, so it lands as `?` rather than shortening the line.
    expect(raw).toEqual([0x3f, 0x31, 0x30, 0x30, 0x0a])
  })

  it('substitutes a character rather than DROPPING it, so columns still line up', () => {
    // A dropped character shortens the line and silently breaks the grid the
    // whole receipt depends on. A `?` is visibly wrong in the right place.
    const line = encodeLine('a☃b')
    expect(line).toHaveLength(4)
    expect(line[1]).toBe(0x3f)
  })


  it('never changes a line\'s WIDTH while encoding it', () => {
    // fitCell truncates to exactly the width the grid allocated and marks the
    // cut with a single "…". Expanding that to "..." afterwards made every
    // truncated cell two columns too wide — invisible on a short brand name and
    // quietly wrecking the alignment on every long one.
    for (const sample of ['abc…', '25°C', 'don’t', 'a—b', '₹100']) {
      expect(encodeLine(sample), sample).toHaveLength(sample.length + 1)
    }
  })

  it('fixes the typographic punctuation the copy is actually written with', () => {
    expect(transliterate('returnable — store below 25°C')).toBe('returnable -- store below 25degC')
    expect(transliterate('don’t')).toBe("don't")
  })
})

// ------------------------------------------------------------- the drawer ---

describe('the cash drawer', () => {
  it('opens on a cash sale', () => {
    expect(shouldOpenDrawer(invoice())).toBe(true)
  })

  it('stays SHUT on a card or UPI sale', () => {
    // A drawer that opens on every sale is one nobody notices being open.
    expect(shouldOpenDrawer(invoice({ payments: [{ mode: 'UPI', amount: '100.00' }] }))).toBe(false)
    expect(shouldOpenDrawer(invoice({ payments: [{ mode: 'CARD', amount: '100.00' }] }))).toBe(false)
  })

  it('opens on a split tender that includes cash', () => {
    expect(shouldOpenDrawer(invoice({
      payments: [{ mode: 'UPI', amount: '60.00' }, { mode: 'CASH', amount: '40.00' }],
    }))).toBe(true)
  })

  it('kicks BEFORE the cut, so the till is open as the paper is cut', () => {
    const bytes = receiptBytes(invoice(), STORE, null, { openDrawer: true })
    const a = [...bytes]
    const kick = a.findIndex((_, i) => CMD.drawerKick.every((v, j) => a[i + j] === v))
    const cut = a.findIndex((_, i) => CMD.cut.every((v, j) => a[i + j] === v))
    expect(kick).toBeGreaterThan(-1)
    expect(kick).toBeLessThan(cut)
  })

  it('sends nothing but a reset and a pulse on its own', () => {
    expect([...drawerBytes()]).toEqual([...CMD.init, ...CMD.drawerKick])
  })
})

// -------------------------------------------------------------- the sheet ---

describe('the printed bill', () => {
  it('RESETS first, so a crashed job does not print the next bill bold', () => {
    const a = [...receiptBytes(invoice(), STORE, null)]
    expect(a.slice(0, 2)).toEqual([...CMD.init])
  })

  it('carries the drug licence numbers — a bill without them is not compliant', () => {
    expect(text(receiptBytes(invoice(), STORE, null))).toContain('DL MH-PN1-114B, MH-PN1-115C')
  })

  it('prints batch and expiry, which are checked against the strip in the hand', () => {
    const out = text(receiptBytes(invoice(), STORE, null))
    expect(out).toContain('AX2314')
    expect(out).toContain('11/27')
  })

  it('prints CGST and SGST for a local sale, IGST for an inter-state one — never both', () => {
    const local = text(receiptBytes(invoice(), STORE, null))
    expect(local).toContain('CGST')
    expect(local).not.toContain('IGST')

    const inter = text(receiptBytes(
      invoice({ quote: quote({ cgst: '0.00', sgst: '0.00', igst: '10.71' }) }), STORE, null,
    ))
    expect(inter).toContain('IGST')
    expect(inter).not.toContain('CGST')
  })

  it('feeds the paper clear of the head before cutting', () => {
    // Without the feed the cut lands mid-total and the customer gets half a bill.
    const a = [...receiptBytes(invoice(), STORE, null)]
    const feed = a.findIndex((_, i) => CMD.feed(3).every((v, j) => a[i + j] === v))
    const cut = a.findIndex((_, i) => CMD.cut.every((v, j) => a[i + j] === v))
    expect(feed).toBeGreaterThan(-1)
    expect(feed).toBeLessThan(cut)
  })

  it('marks a cancelled bill on the paper', () => {
    expect(text(receiptBytes(invoice({ status: 'VOIDED' }), STORE, null))).toContain('*** VOIDED ***')
  })

  it('carries the reseller credit, and drops it when it is turned off', () => {
    const branded = { ...DEFAULT_BRAND, documentFooter: 'Powered by MedSoft' }
    expect(text(receiptBytes(invoice(), STORE, branded))).toContain('Powered by MedSoft')

    const hidden = { ...DEFAULT_BRAND, hidePoweredBy: true }
    expect(text(receiptBytes(invoice(), STORE, hidden))).not.toMatch(/Powered by/)
  })

  it('respects a narrower roll everywhere, not just in the header', () => {
    const narrow = text(receiptBytes(invoice(), STORE, null, { columns: 32 }))
    const over = narrow.split('\n').filter((l) => l.length > 32)
    expect(over, `too wide: ${JSON.stringify(over)}`).toEqual([])
  })
})

// ---------------------------------------------------------------- testing ---

describe('the test page', () => {
  it('prints a ruler exactly as wide as the configured roll', () => {
    const out = text(testPageBytes(STORE, { columns: 42 }))
    expect(out).toContain('123456789012345678901234567890123456789012')
  })

  it('shows the rupee sign so a wrong code page is visible before a queue forms', () => {
    expect(text(testPageBytes(STORE))).toContain('Rs1,234.50')
  })

  it('cuts, so the test page can be torn off like a bill', () => {
    expect(has(testPageBytes(STORE), CMD.cut)).toBe(true)
  })
})

describe('wrapping the sentences', () => {
  it('wraps on words, not mid-word', () => {
    expect(wrapText('Medicines once sold are not returnable', 20))
      .toEqual(['Medicines once sold', 'are not returnable'])
  })

  it('breaks a word that is longer than the roll rather than overflowing', () => {
    // Nothing else can be done with it, and overflowing is the worse option:
    // the printer hard-wraps wherever the character falls and the centring is
    // applied only to the first fragment.
    expect(wrapText('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic'])
  })

  it('leaves a short sentence exactly as it was', () => {
    expect(wrapText('Thank you', 42)).toEqual(['Thank you'])
  })
})
