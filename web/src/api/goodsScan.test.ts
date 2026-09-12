import { describe, expect, it } from 'vitest'
import type { Medicine } from '@contract'
import { describeScan, gtinVariants, readGoodsScan, toPrintedExpiry } from './goodsScan'
import type { GoodsScanContext } from './goodsScan'

/**
 * Receiving is where the most error-prone typing in the app happens, and the two
 * fields being typed — batch and expiry — are the ones printed on the customer's
 * bill and checked against the strip in somebody's hand. Every test here is a
 * carton somebody actually scans.
 */

function medicine(id: number, brandName: string): Medicine {
  return {
    id, storeId: 1, brandName, genericName: null, compositionText: 'Paracetamol 650mg',
    manufacturer: 'Acme', form: 'Tablet', strengthText: '650mg', packLabel: '1x15',
    unitsPerPack: 15, baseUom: 'TAB', allowLooseSale: true, saleStep: '1',
    hsnCode: '30049099', drugSchedule: 'H', requiresPrescription: true, rackLocation: 'A1',
    reorderLevel: 0, saleRank: 0, isActive: true,
  }
}

const DOLO = medicine(1, 'Dolo 650')

/* The master holds what was scanned at the COUNTER, which is the 13-digit retail
   form — GS1 pads every GTIN to 14. */
const ctx = (over: Partial<GoodsScanContext> = {}): GoodsScanContext => ({
  barcodes: new Map([['8901234567890', 1]]),
  medicineOf: (id) => (id === 1 ? DOLO : undefined),
  ...over,
})

/** FNC1: the separator a scanner sends between variable-length element strings. */
const GS = '\u001D'

describe('a distributor carton', () => {
  it('fills the medicine, batch AND expiry from one scan', () => {
    // 01 GTIN(14) · 17 expiry(6) · 10 batch(variable, and last so it needs no FNC1)
    const out = readGoodsScan('010890123456789017271130' + '10AX2314', ctx())
    expect(out.kind).toBe('matched')
    if (out.kind !== 'matched') return
    expect(out.medicine.brandName).toBe('Dolo 650')
    expect(out.batchNo).toBe('AX2314')
    // Back to the MM/YY the grid and the pack both use.
    expect(out.expiry).toBe('11/27')
  })

  it('reads a batch terminated by the group separator', () => {
    // AI 10 is variable-length, so it needs an FNC1 before whatever follows.
    const out = readGoodsScan('0108901234567890' + '10AX2314' + GS + '17271130', ctx())
    expect(out.kind).toBe('matched')
    if (out.kind !== 'matched') return
    expect(out.batchNo).toBe('AX2314')
    expect(out.expiry).toBe('11/27')
  })

  it('matches a 14-digit GTIN against the 13-digit code the counter scanned', () => {
    // GS1 pads to 14; the barcode master holds the retail EAN-13. Requiring the
    // master to be populated in GS1's padding would mean every existing barcode
    // silently failing to match at goods receipt.
    expect(gtinVariants('08901234567890')).toContain('8901234567890')
    expect(gtinVariants('8901234567890')).toContain('08901234567890')
    // A UPC-A is an EAN-13 with a leading zero, and imported stock carries them.
    expect(gtinVariants('890123456789')).toContain('0890123456789')
  })

  it('says what it filled, naming the fields', () => {
    const out = readGoodsScan('01089012345678901727113010AX2314', ctx())
    expect(describeScan(out)).toContain('batch and expiry filled from the carton')
  })
})

describe('what it refuses to do', () => {
  it('never fills a QUANTITY, even when the carton states one', () => {
    // AI 30 means "units in this carton", which is not the number of packs being
    // billed on the line. A quantity arriving from somewhere the operator did not
    // type, on the field that decides what is paid for, must stay manual.
    const out = readGoodsScan('0108901234567890' + '30000024' + GS + '10AX2314', ctx())
    expect(out.kind).toBe('matched')
    expect(JSON.stringify(out)).not.toContain('qty')
  })

  it('does not treat a plain barcode as a carton with a missing batch', () => {
    // A retail EAN-13 carries no element strings at all. Reading it as a GS1
    // code whose batch happens to be absent would blank a batch already typed.
    const out = readGoodsScan('8901234567890', ctx())
    expect(out.kind).toBe('plainBarcode')
    expect(describeScan(out)).toContain('no batch or expiry')
  })

  it('refuses a batch with no product attached to it', () => {
    // Some cartons carry only 10 and 17. Applying those to whichever row happens
    // to be focused is how a batch lands on the wrong medicine.
    expect(readGoodsScan('10AX2314' + GS + '17271130', ctx()).kind).toBe('unknown')
  })

  it('reports an empty scan as nothing, not as a match', () => {
    expect(readGoodsScan('   ', ctx()).kind).toBe('unknown')
  })
})

describe('a GTIN this shop has never seen', () => {
  it('is offered for linking, and KEEPS the batch and expiry', () => {
    // The ordinary case on the first delivery of a line. Handing the batch and
    // expiry over means linking the code fills the whole row at once.
    const out = readGoodsScan('01099999999999991727113010ZZ99', ctx())
    expect(out.kind).toBe('unknownGtin')
    if (out.kind !== 'unknownGtin') return
    expect(out.gtin).toBe('09999999999999')
    expect(out.batchNo).toBe('ZZ99')
    expect(out.expiry).toBe('11/27')
  })

  it('says so rather than silently doing nothing', () => {
    const out = readGoodsScan('0109999999999999', ctx())
    expect(describeScan(out)).toContain('not linked to anything yet')
  })
})

describe('the expiry, which is the field that must not be wrong', () => {
  it('converts an ISO date to the MM/YY printed on the pack', () => {
    expect(toPrintedExpiry('2027-11-30')).toBe('11/27')
    expect(toPrintedExpiry('2030-01-31')).toBe('01/30')
  })
})
