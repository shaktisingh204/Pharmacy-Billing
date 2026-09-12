import { describe, expect, it } from 'vitest'
import type { Batch, Medicine, StoreProfile } from '@contract'
import { DEFAULT_LABEL, labelBytes, labelFor, renderLabels, testLabel, tspl, zpl } from './labels'
import type { LabelData, LabelOptions } from './labels'

/**
 * A label is wrong in front of a customer or it is not wrong at all, so most of
 * these are about the price and the barcode rather than about layout.
 */

function medicine(over: Partial<Medicine> = {}): Medicine {
  return {
    id: 1, storeId: 1, brandName: 'Dolo 650', genericName: null, compositionText: 'x',
    manufacturer: 'Acme', form: 'Tablet', strengthText: '650mg', packLabel: '1x15',
    unitsPerPack: 15, baseUom: 'TAB', allowLooseSale: true, saleStep: '1',
    hsnCode: '30049099', drugSchedule: 'H', requiresPrescription: true, rackLocation: 'A1',
    reorderLevel: 0, saleRank: 0, isActive: true, ...over,
  }
}

function batch(over: Partial<Batch> = {}): Batch {
  return {
    id: 1, storeId: 1, medicineId: 1, batchNo: 'AX2314', expiryDate: '2027-11-30',
    mrpPerPack: '150.00', mrpPerUnit: '10.0000', ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000', purchaseGstPct: '12', qtyOnHand: '40',
    isQuarantined: false, ...over,
  }
}

const data = (over: Partial<LabelData> = {}): LabelData => ({
  brandName: 'Dolo 650', packLabel: '1x15', batchNo: 'AX2314', expiry: '11/27',
  mrp: '150.00', barcode: '8901234567890', rack: 'A1', ...over,
})

const opts = (over: Partial<LabelOptions> = {}): LabelOptions => ({ ...DEFAULT_LABEL, ...over })

// ------------------------------------------------------------------ price ---

describe('the price on the label', () => {
  it('comes from the BATCH, because there is no product-level MRP', () => {
    // A shelf legitimately holds one medicine in two batches at two printed
    // MRPs. A product-level label is wrong about half the stock behind it, and
    // the customer pays what is printed on the strip in their hand.
    const older = labelFor(batch({ mrpPerPack: '150.00' }), medicine(), null)
    const newer = labelFor(batch({ id: 2, batchNo: 'AX2401', mrpPerPack: '162.00' }), medicine(), null)
    expect(older.mrp).toBe('150.00')
    expect(newer.mrp).toBe('162.00')
    // And each label says which batch it is for, which is also how staff know
    // which strip to pull first.
    expect(older.batchNo).not.toBe(newer.batchNo)
  })

  it('can be left off entirely for a rack label', () => {
    // A rack label that carries a price can contradict the pack behind it.
    expect(renderLabels([data()], opts({ showPrice: false }))).not.toContain('MRP')
    expect(renderLabels([data()], opts({ showPrice: true }))).toContain('MRP Rs150.00')
  })

  it('never sends ₹ to a printer that has no glyph for it', () => {
    expect(renderLabels([data()], opts())).not.toContain('₹')
    expect(renderLabels([data()], opts({ language: 'ZPL' }))).not.toContain('₹')
  })
})

// ---------------------------------------------------------------- barcode ---

describe('the barcode', () => {
  it('uses EAN13 for a 13-digit code, so the shelf matches the till', () => {
    // A 13-digit code sent as CODE128 scans — but not as the retail barcode the
    // counter already knows, so label and pack would disagree at the till.
    expect(tspl([data({ barcode: '8901234567890' })], opts())).toContain('"EAN13"')
    expect(zpl([data({ barcode: '8901234567890' })], opts({ language: 'ZPL' }))).toContain('^BEN')
  })

  it('falls back to CODE128 for an internal code', () => {
    expect(tspl([data({ barcode: 'INT-4471' })], opts())).toContain('"128"')
    expect(zpl([data({ barcode: 'INT-4471' })], opts({ language: 'ZPL' }))).toContain('^BCN')
  })

  it('prints a label with no barcode at all rather than an empty one', () => {
    const out = tspl([data({ barcode: null })], opts())
    expect(out).not.toContain('BARCODE')
    expect(out).toContain('Dolo 650')
  })
})

// --------------------------------------------------------------- language ---

describe('the two printer languages', () => {
  it('emits TSPL for TSC and the units rebadged from it', () => {
    const out = renderLabels([data()], opts({ language: 'TSPL' }))
    expect(out).toContain('SIZE 50 mm,25 mm')
    expect(out).toContain('CLS')
    expect(out).toMatch(/^PRINT 1,1$/m)
    expect(out).not.toContain('^XA')
  })

  it('emits ZPL for Zebra, and sets the label size every time', () => {
    // Left unset, a printer keeps whatever the last job used — one wrong job
    // then makes every later label the wrong length until it is power-cycled.
    const out = renderLabels([data()], opts({ language: 'ZPL' }))
    expect(out).toContain('^XA')
    expect(out).toContain('^PW400')
    expect(out).toContain('^LL200')
    expect(out).toContain('^XZ')
  })

  it('scales every coordinate from dpmm, not from a 203dpi assumption', () => {
    // A layout written for 203dpi silently prints at two-thirds scale on a
    // 300dpi head and clips.
    const at203 = zpl([data()], opts({ language: 'ZPL', dpmm: 8 }))
    const at300 = zpl([data()], opts({ language: 'ZPL', dpmm: 12 }))
    expect(at203).toContain('^PW400')
    expect(at300).toContain('^PW600')
    expect(at203).not.toBe(at300)
  })

  it('honours the copy count in both languages', () => {
    expect(tspl([data()], opts({ copies: 12 }))).toContain('PRINT 12,1')
    expect(zpl([data()], opts({ language: 'ZPL', copies: 12 }))).toContain('^PQ12')
  })
})

// ----------------------------------------------------------------- safety ---

describe('text that would break the command stream', () => {
  it('strips quotes and backslashes, which end a command early', () => {
    // Left in, the label prints half a name and stops.
    const out = tspl([data({ brandName: 'Brand "X" \\ Co' })], opts())
    expect(out).not.toMatch(/"Brand "X"/)
    expect(out).toContain('Brand  X')
  })

  it('truncates a long name rather than wrapping it onto the price line', () => {
    const out = tspl([data({ brandName: 'A'.repeat(120) })], opts())
    const nameLine = out.split('\n').find((l) => l.includes('AAA')) ?? ''
    expect(nameLine.length).toBeLessThan(80)
    expect(nameLine).toContain('.')
  })

  it('emits 7-bit bytes only', () => {
    const bytes = labelBytes([data({ brandName: 'Café ☃' })], opts())
    expect([...bytes].every((b) => b <= 0x7f)).toBe(true)
  })
})

describe('the test label', () => {
  it('proves the language and the scale, which are what actually go wrong', () => {
    const store = { name: 'Sanjeevani Medical Store' } as StoreProfile
    const out = new TextDecoder().decode(testLabel(store, opts()))
    expect(out).toContain('Sanjeevani Medical Store')
    // The configured size is printed ON the label, so a wrong dpmm is visible.
    expect(out).toContain('50x25mm')
    expect(out).toContain('8901234567890')
  })
})
