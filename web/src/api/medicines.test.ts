import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type { Batch, BrandProfile, Medicine, MedicineInput, StockMovement } from '@contract'
import { DEFAULT_BRAND } from '@/db/bootstrap'
import type { MedicineCatalogue } from './medicines'
import {
  applyMedicineUpdate, buildMedicinePage, buildMedicineRow, buildPriceHistory, coerceBrand,
  hasGap, marginOverMrp, medicineIdentity, parseBrand, prepareBarcodeLink, prepareMedicine,
  resolveExpiryWindow, salesVelocity,
} from './medicines'

/**
 * Fixtures are hand-written rather than seeded. A master-data test that reads
 * the demo catalogue stops asserting what a filter MEANS and starts asserting
 * what the seed happens to contain this week.
 *
 * Everything here is a pure function over arrays, which is the point of the
 * module: these are the rules the Rust server has to reproduce, and none of them
 * needs an IndexedDB to be exercised.
 */

const TODAY = '2026-09-08'

/** Days from TODAY, so an expiry can be read as a bucket at a glance. */
const D22 = '2026-09-30'
const D83 = '2026-11-30'
const D173 = '2027-02-28'
const EXPIRED = '2026-08-31'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
  const drugSchedule = over.drugSchedule ?? 'H'
  return {
    id,
    storeId: 1,
    brandName: `Brand ${id}`,
    genericName: null,
    compositionText: 'Amlodipine 5mg',
    manufacturer: 'Acme',
    form: 'Tablet',
    strengthText: '5mg',
    packLabel: '10x10',
    unitsPerPack: 10,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule,
    requiresPrescription: drugSchedule !== 'OTC',
    rackLocation: 'A1',
    reorderLevel: 100,
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
    mrpPerPack: '100.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '40',
    isQuarantined: false,
    ...over,
  }
}

function catalogue(
  medicines: readonly Medicine[],
  batches: readonly Batch[] = [],
  barcodes: ReadonlyMap<number, string[]> = new Map(),
  nearExpiryBuckets: readonly number[] = [180, 90, 60, 30],
): MedicineCatalogue {
  const byMedicine = new Map<number, Batch[]>()
  for (const b of batches) {
    const list = byMedicine.get(b.medicineId)
    if (list) list.push(b)
    else byMedicine.set(b.medicineId, [b])
  }
  return {
    medicines,
    batchesFor: (id) => byMedicine.get(id) ?? [],
    barcodesFor: (id) => barcodes.get(id) ?? [],
    today: TODAY,
    nearExpiryBuckets,
  }
}

function input(over: Partial<MedicineInput> = {}): MedicineInput {
  return {
    brandName: 'Dolo 650',
    compositionText: 'Paracetamol 650mg',
    manufacturer: 'Micro Labs',
    form: 'Tablet',
    strengthText: '650mg',
    packLabel: '10x15',
    unitsPerPack: 15,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'OTC',
    reorderLevel: 100,
    ...over,
  }
}

/** Asserts an ApiError was thrown and hands it back for inspection. */
function apiError(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected an ApiError, nothing was thrown')
}

const names = (rows: ReadonlyArray<{ medicine: Medicine }>): string[] =>
  rows.map((r) => r.medicine.brandName)

// ------------------------------------------------------------------ fixture ---

const M1 = medicine(1, { brandName: 'Amlogard', manufacturer: 'Cipla', drugSchedule: 'H', reorderLevel: 100 })
const M2 = medicine(2, { brandName: 'Brufen', manufacturer: 'Abbott', drugSchedule: 'OTC', reorderLevel: 100 })
const M3 = medicine(3, { brandName: 'Crocin', manufacturer: 'Cipla', drugSchedule: 'H', reorderLevel: 50 })
const M4 = medicine(4, { brandName: 'Dolo 650', manufacturer: 'Micro Labs', drugSchedule: 'OTC', reorderLevel: 10 })
const M5 = medicine(5, { brandName: 'Enteroquinol', manufacturer: 'Abbott', drugSchedule: 'H1', reorderLevel: 20 })
const M6 = medicine(6, { brandName: 'Zyrtec', manufacturer: 'UCB', drugSchedule: 'OTC', isActive: false })

/** m1 9 units, m2 100, m3 none, m4 500, m5 only an expired batch, m6 nothing. */
const SHOP = catalogue(
  [M1, M2, M3, M4, M5, M6],
  [
    batch(1, 1, { qtyOnHand: '9', expiryDate: D173 }),
    batch(2, 2, { qtyOnHand: '100', expiryDate: D83 }),
    batch(4, 4, { qtyOnHand: '500', expiryDate: D22 }),
    batch(5, 5, { qtyOnHand: '40', expiryDate: EXPIRED }),
  ],
  new Map([[4, ['8901234567893']]]),
)

// --------------------------------------------------------------------- rows ---

describe('catalogue rows', () => {
  it('joins stock, batch count, nearest expiry and both valuations', () => {
    const row = buildMedicineRow(
      M4,
      [
        batch(10, 4, { qtyOnHand: '100', expiryDate: D22 }),
        batch(11, 4, { qtyOnHand: '50', expiryDate: D83, mrpPerUnit: '12.0000', landedCostPerUnit: '8.0000' }),
      ],
      ['8901234567893'],
      TODAY,
    )
    expect(row.stockQty).toBe('150.000')
    expect(row.batchCount).toBe(2)
    expect(row.nearestExpiry).toBe(D22)
    expect(row.valueAtMrp).toBe('1600.00') // 100x10 + 50x12
    expect(row.valueAtCost).toBe('1000.00') // 100x6 + 50x8
    expect(row.barcodes).toEqual(['8901234567893'])
  })

  it('values only sellable stock — an expired or quarantined strip is a write-off, not shelf value', () => {
    const row = buildMedicineRow(
      M4,
      [
        batch(10, 4, { qtyOnHand: '100' }),
        batch(11, 4, { qtyOnHand: '999', expiryDate: EXPIRED }),
        batch(12, 4, { qtyOnHand: '999', isQuarantined: true }),
      ],
      [],
      TODAY,
    )
    expect(row.stockQty).toBe('100.000')
    expect(row.batchCount).toBe(1)
    expect(row.valueAtMrp).toBe('1000.00')
  })
})

// -------------------------------------------------------------------- sorts ---

describe('sorting', () => {
  it('orders stock as a NUMBER, so 9 does not beat 100', () => {
    const cat = catalogue(
      [medicine(1, { brandName: 'Nine' }), medicine(2, { brandName: 'Hundred' })],
      [batch(1, 1, { qtyOnHand: '9' }), batch(2, 2, { qtyOnHand: '100' })],
    )
    const page = buildMedicinePage(cat, { sort: 'stock' })
    // The quantities really are the pair that mis-sorts as text: '100.000'
    // sorts BELOW '9.000' lexicographically, which is the classic bug.
    expect(page.rows.map((r) => r.stockQty)).toEqual(['100.000', '9.000'])
    expect(names(page.rows)).toEqual(['Hundred', 'Nine'])
  })

  it('orders value as a number too, largest first', () => {
    const page = buildMedicinePage(SHOP, { sort: 'value' })
    expect(names(page.rows).slice(0, 3)).toEqual(['Dolo 650', 'Brufen', 'Amlogard'])
  })

  it('orders saleRank highest first and name A-Z', () => {
    const cat = catalogue([
      medicine(1, { brandName: 'Zinetac', saleRank: 900 }),
      medicine(2, { brandName: 'Allegra', saleRank: 12 }),
    ])
    expect(names(buildMedicinePage(cat, { sort: 'saleRank' }).rows)).toEqual(['Zinetac', 'Allegra'])
    expect(names(buildMedicinePage(cat, { sort: 'name' }).rows)).toEqual(['Allegra', 'Zinetac'])
  })
})

// ------------------------------------------------------------------ filters ---

describe('filters', () => {
  it('shows live rows by default and delisted ones only on request', () => {
    expect(names(buildMedicinePage(SHOP, {}).rows)).not.toContain('Zyrtec')
    expect(names(buildMedicinePage(SHOP, { onlyInactive: true }).rows)).toEqual(['Zyrtec'])
  })

  it('matches a term across brand, manufacturer and barcode', () => {
    expect(names(buildMedicinePage(SHOP, { term: 'cipla' }).rows)).toEqual(['Amlogard', 'Crocin'])
    expect(names(buildMedicinePage(SHOP, { term: 'DOLO' }).rows)).toEqual(['Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { term: '8901234567893' }).rows)).toEqual(['Dolo 650'])
  })

  it('finds a typed GTIN whichever padding it carries, as lookupBarcode does', () => {
    // Filed as the EAN-13, typed as the zero-padded GTIN-14 off a DataMatrix.
    // A plain substring search misses this direction and reports no such pack.
    expect(names(buildMedicinePage(SHOP, { term: '08901234567893' }).rows)).toEqual(['Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { term: '008901234567893' }).rows)).toEqual([])
  })

  it('filters by schedule and by manufacturer, case-insensitively', () => {
    expect(names(buildMedicinePage(SHOP, { schedule: 'H' }).rows)).toEqual(['Amlogard', 'Crocin'])
    expect(names(buildMedicinePage(SHOP, { manufacturer: 'abbott' }).rows)).toEqual(['Brufen', 'Enteroquinol'])
  })

  it('separates in, low and out', () => {
    expect(names(buildMedicinePage(SHOP, { stock: 'in' }).rows)).toEqual(['Amlogard', 'Brufen', 'Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { stock: 'low' }).rows)).toEqual(['Amlogard', 'Brufen'])
    expect(names(buildMedicinePage(SHOP, { stock: 'out' }).rows)).toEqual(['Crocin', 'Enteroquinol'])
  })

  it("'low' excludes zero stock — an empty shelf is the out-of-stock queue, not the reorder list", () => {
    const low = buildMedicinePage(SHOP, { stock: 'low' })
    expect(names(low.rows)).not.toContain('Crocin') // 0 on hand, reorder 50
    expect(names(low.rows)).not.toContain('Enteroquinol') // only an expired batch
    // Brufen sits exactly ON its reorder level, which is still a reorder.
    expect(low.rows.map((r) => r.stockQty)).toEqual(['9.000', '100.000'])
  })

  it("'out' counts a shelf holding only expired stock as empty", () => {
    expect(names(buildMedicinePage(SHOP, { stock: 'out' }).rows)).toContain('Enteroquinol')
  })

  it('buckets expiry against the sellable stock, and lists expired stock separately', () => {
    expect(names(buildMedicinePage(SHOP, { expiry: 'd30' }).rows)).toEqual(['Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { expiry: 'd90' }).rows)).toEqual(['Brufen', 'Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { expiry: 'd180' }).rows)).toEqual(['Amlogard', 'Brufen', 'Dolo 650'])
    expect(names(buildMedicinePage(SHOP, { expiry: 'expired' }).rows)).toEqual(['Enteroquinol'])
  })

  it("reads the window from the store's buckets, not from the number in the key", () => {
    expect(resolveExpiryWindow('d30', [180, 90, 60, 30])).toBe(30)
    expect(resolveExpiryWindow('d90', [45, 120])).toBe(120)
    expect(resolveExpiryWindow('d180', [])).toBe(180)

    // A store that only watches 15 days does not call a 22-day batch near-expiry.
    const tight = catalogue(SHOP.medicines, [batch(4, 4, { qtyOnHand: '500', expiryDate: D22 })], new Map(), [15])
    expect(tight.medicines).toHaveLength(6)
    expect(buildMedicinePage(tight, { expiry: 'd30' }).rows).toEqual([])
  })

  it('composes filters with AND', () => {
    // Schedule H has two rows and 'low' has two rows; only Amlogard is in both.
    expect(names(buildMedicinePage(SHOP, { schedule: 'H', stock: 'low' }).rows)).toEqual(['Amlogard'])
    // Abbott has two rows; only Enteroquinol is sitting on expired stock.
    expect(names(buildMedicinePage(SHOP, { manufacturer: 'Abbott', expiry: 'expired' }).rows))
      .toEqual(['Enteroquinol'])
  })

  it('offers every manufacturer in the catalogue, not just the filtered ones', () => {
    const page = buildMedicinePage(SHOP, { manufacturer: 'Cipla' })
    expect(page.total).toBe(2)
    expect(page.manufacturers).toEqual(['Abbott', 'Cipla', 'Micro Labs', 'UCB'])
  })
})

// ------------------------------------------------------------------- paging ---

describe('paging', () => {
  /**
   * Every row shares a brand name, so the sort key ties on all seven and only
   * the id tie-break keeps the ordering total. That is where paging breaks.
   *
   * The ids are fed in SCRAMBLED on purpose: `Array.prototype.sort` is stable,
   * so a fixture already in id order would come out right with no tie-break at
   * all and this would assert nothing.
   */
  const TIED = catalogue([5, 1, 7, 3, 6, 2, 4].map((id) => medicine(id, { brandName: 'Same' })))

  it('walks the whole set once: no row repeated, none dropped', () => {
    const seen: number[] = []
    const cursors: Array<number | null> = []
    let cursor: number | undefined

    for (let guard = 0; guard < 10; guard += 1) {
      const page = buildMedicinePage(TIED, { limit: 3, cursor })
      expect(page.total).toBe(7)
      seen.push(...page.rows.map((r) => r.medicine.id))
      cursors.push(page.nextCursor)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }

    expect(cursors).toEqual([3, 6, null])
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(seen).size).toBe(7)
  })

  it('returns the same page for the same cursor', () => {
    const a = buildMedicinePage(TIED, { limit: 3, cursor: 3 })
    const b = buildMedicinePage(TIED, { limit: 3, cursor: 3 })
    expect(a.rows.map((r) => r.medicine.id)).toEqual([4, 5, 6])
    expect(b.rows.map((r) => r.medicine.id)).toEqual(a.rows.map((r) => r.medicine.id))
  })

  it('runs off the end without inventing a cursor', () => {
    const page = buildMedicinePage(TIED, { limit: 3, cursor: 99 })
    expect(page.rows).toEqual([])
    expect(page.total).toBe(7)
    expect(page.nextCursor).toBeNull()
  })
})

// --------------------------------------------------------------- validation ---

describe('createMedicine validation', () => {
  it('rejects an empty brand name', () => {
    expect(apiError(() => prepareMedicine(input({ brandName: '   ' }), [])).details)
      .toEqual({ field: 'brandName' })
  })

  it('rejects a non-positive or fractional pack size', () => {
    for (const unitsPerPack of [0, -10, 1.5, Number.NaN]) {
      expect(apiError(() => prepareMedicine(input({ unitsPerPack }), [])).details)
        .toEqual({ field: 'unitsPerPack' })
    }
  })

  it('accepts an HSN of 4, 6 or 8 digits and nothing else', () => {
    for (const hsnCode of ['3004', '300490', '30049099']) {
      expect(prepareMedicine(input({ hsnCode }), []).hsnCode).toBe(hsnCode)
    }
    // '30049' and '3004909' are the keystroke-short and keystroke-long typos.
    // The tariff has no odd-length code, and GSTR-1 rejects one at filing.
    for (const hsnCode of ['', '300', '30049', '3004909', '300490991', '3004a099', '3004.90', ' 30 04 ']) {
      expect(apiError(() => prepareMedicine(input({ hsnCode }), [])).details)
        .toEqual({ field: 'hsnCode' })
    }
  })

  it('rejects a reorder level that is not a whole count of base units', () => {
    // Every one of these survives validation as a plain `number` and only fails
    // later, inside the low-stock filter, as a TypeError out of `D.dec`.
    for (const reorderLevel of [Number.NaN, Number.POSITIVE_INFINITY, 1e21, -1, 2.5]) {
      expect(apiError(() => prepareMedicine(input({ reorderLevel }), [])).details)
        .toEqual({ field: 'reorderLevel' })
    }
    expect(prepareMedicine(input({ reorderLevel: 0 }), []).reorderLevel).toBe(0)
  })

  it('keeps the low-stock filter listable whatever the form sent', () => {
    // The regression this guards: one poisoned row took down the whole grid,
    // including the view the operator would have used to find and fix it.
    const bad = apiError(() => prepareMedicine(input({ reorderLevel: Number.NaN }), []))
    expect(bad.code).toBe('MEDICINE_INVALID')
    const cat = catalogue([M1, M2], [batch(1, 1, { qtyOnHand: '9' })])
    expect(() => buildMedicinePage(cat, { stock: 'low' })).not.toThrow()
  })

  it('requires the sale step to tile the pack when the strip may not be cut', () => {
    const uncuttable = { allowLooseSale: false, unitsPerPack: 10 }
    expect(apiError(() => prepareMedicine(input({ ...uncuttable, saleStep: '3' }), [])).details)
      .toEqual({ field: 'saleStep' })
    expect(prepareMedicine(input({ ...uncuttable, saleStep: '5' }), []).saleStep).toBe('5')
    expect(prepareMedicine(input({ ...uncuttable, saleStep: '10' }), []).saleStep).toBe('10')
    // A cuttable strip carries no such rule: loose sale is the whole point.
    expect(prepareMedicine(input({ allowLooseSale: true, unitsPerPack: 10, saleStep: '3' }), []).saleStep).toBe('3')
  })

  it('rejects a sale step that is not a positive quantity', () => {
    for (const saleStep of ['0', '-1', 'half', '']) {
      expect(apiError(() => prepareMedicine(input({ saleStep }), [])).details)
        .toEqual({ field: 'saleStep' })
    }
  })

  it('derives requiresPrescription from the schedule rather than trusting a form', () => {
    expect(prepareMedicine(input({ drugSchedule: 'OTC' }), []).requiresPrescription).toBe(false)
    expect(prepareMedicine(input({ drugSchedule: 'H1' }), []).requiresPrescription).toBe(true)
  })

  it('starts a new row live and unranked', () => {
    const row = prepareMedicine(input(), [])
    expect(row.isActive).toBe(true)
    expect(row.saleRank).toBe(0)
  })
})

describe('duplicate detection', () => {
  const existing = medicine(7, { brandName: 'Dolo 650', packLabel: '10x15', manufacturer: 'Micro Labs' })

  it('ignores case and spacing across all three parts of the identity', () => {
    expect(medicineIdentity('Dolo 650', '10x15', 'Micro Labs'))
      .toBe(medicineIdentity('  DOLO   650 ', '10X15', 'micro labs'))

    const err = apiError(() => prepareMedicine(
      input({ brandName: '  dolo   650', packLabel: '10X15', manufacturer: 'MICRO LABS' }),
      [existing],
    ))
    expect(err.code).toBe('MEDICINE_EXISTS')
    // The existing row rides along so the screen can offer to open it.
    expect(err.details).toEqual(existing)
  })

  it('treats a different pack of the same brand as a different product', () => {
    expect(prepareMedicine(input({ packLabel: '10x10' }), [existing]).packLabel).toBe('10x10')
  })

  it('does not report a row as a duplicate of itself when it is edited', () => {
    const renamed = applyMedicineUpdate(existing, { rackLocation: 'B2' }, [existing])
    expect(renamed.rackLocation).toBe('B2')
    expect(renamed.id).toBe(7)
  })

  it('blocks an edit that collides with another row', () => {
    const other = medicine(8, { brandName: 'Calpol', packLabel: '10x15', manufacturer: 'Micro Labs' })
    const err = apiError(() => applyMedicineUpdate(other, { brandName: 'DOLO 650' }, [existing, other]))
    expect(err.code).toBe('MEDICINE_EXISTS')
  })

  it('re-validates the whole row, because an edit can invalidate an untouched field', () => {
    const cuttable = medicine(9, { unitsPerPack: 10, saleStep: '3', allowLooseSale: true })
    const err = apiError(() => applyMedicineUpdate(cuttable, { allowLooseSale: false }, [cuttable]))
    expect(err.details).toEqual({ field: 'saleStep' })
  })
})

// ----------------------------------------------------------------- barcodes ---

describe('linking a barcode', () => {
  const owners = new Map([['8901234567893', 4]])
  const meds = new Map([[4, M4], [1, M1]])

  it('links a free code', () => {
    expect(prepareBarcodeLink(' 8909999999992 ', 1, owners, meds))
      .toEqual({ barcode: '8909999999992', alreadyLinked: false })
  })

  it('treats a re-scan of the same medicine as a no-op', () => {
    expect(prepareBarcodeLink('8901234567893', 4, owners, meds).alreadyLinked).toBe(true)
  })

  it('refuses to re-point a code that belongs to another medicine', () => {
    const err = apiError(() => prepareBarcodeLink('8901234567893', 1, owners, meds))
    expect(err.code).toBe('BARCODE_TAKEN')
    expect(err.details).toEqual(M4)
  })

  it('sees through GTIN padding, so a DataMatrix scan cannot steal an EAN-13', () => {
    const err = apiError(() => prepareBarcodeLink('08901234567893', 1, owners, meds))
    expect(err.code).toBe('BARCODE_TAKEN')
  })

  it('rejects an empty code', () => {
    expect(apiError(() => prepareBarcodeLink('  ', 1, owners, meds)).code).toBe('BARCODE_INVALID')
  })
})

// -------------------------------------------------------------------- brand ---

describe('brand profile', () => {
  const accent: NonNullable<BrandProfile['accent']> = {
    base: 'var(--accent-9)',
    hover: 'var(--accent-10)',
    text: 'var(--accent-contrast)',
    tint: 'var(--accent-3)',
    ring: 'var(--accent-8)',
  }

  it('ships an unbranded default', () => {
    expect(DEFAULT_BRAND).toEqual({
      productName: 'RxBill',
      markText: 'Rx',
      logoUrl: null,
      accent: null,
      tagline: 'Pharmacy POS',
      documentFooter: null,
      hidePoweredBy: false,
    })
  })

  it('falls back rather than booting a shell with no name on it', () => {
    expect(parseBrand(undefined, DEFAULT_BRAND)).toEqual(DEFAULT_BRAND)
    expect(parseBrand('{ not json', DEFAULT_BRAND)).toEqual(DEFAULT_BRAND)
    expect(parseBrand('null', DEFAULT_BRAND)).toEqual(DEFAULT_BRAND)
    expect(parseBrand('"a string"', DEFAULT_BRAND)).toEqual(DEFAULT_BRAND)
  })

  it('fills the gaps in a row written by an older build', () => {
    const brand = parseBrand(JSON.stringify({ productName: 'MediCount' }), DEFAULT_BRAND)
    expect(brand.productName).toBe('MediCount')
    expect(brand.markText).toBe('Rx')
    expect(brand.hidePoweredBy).toBe(false)
  })

  it('trims the mark to what fits the square, and blanks to null', () => {
    const brand = coerceBrand({ ...DEFAULT_BRAND, markText: ' MEDIC ', tagline: '   ' }, DEFAULT_BRAND)
    expect(brand.markText).toBe('MED')
    expect(brand.tagline).toBeNull()
  })

  it('takes an accent ramp only when every step is present', () => {
    expect(coerceBrand({ ...DEFAULT_BRAND, accent }, DEFAULT_BRAND).accent).toEqual(accent)
    const partial = { ...accent, ring: '' }
    expect(coerceBrand({ ...DEFAULT_BRAND, accent: partial }, DEFAULT_BRAND).accent).toBeNull()
  })

  it('round-trips through storage', () => {
    const saved = coerceBrand({ ...DEFAULT_BRAND, productName: 'MediCount', accent }, DEFAULT_BRAND)
    expect(parseBrand(JSON.stringify(saved), DEFAULT_BRAND)).toEqual(saved)
  })
})

// ------------------------------------------------------------------- gaps ---

describe('data-quality gaps', () => {
  const noHsn = medicine(11, { brandName: 'Aciloc', hsnCode: '' })
  const noRack = medicine(12, { brandName: 'Betnovate', rackLocation: null })
  const noReorder = medicine(13, { brandName: 'Combiflam', reorderLevel: 0 })
  const neverSold = medicine(14, { brandName: 'Dexona', saleRank: 0 })
  const sold = medicine(15, { brandName: 'Evion', saleRank: 12 })
  const delisted = medicine(16, { brandName: 'Folvite', hsnCode: '', isActive: false })

  const GAPPY = catalogue(
    [noHsn, noRack, noReorder, neverSold, sold, delisted],
    [],
    new Map([[15, ['8901234567893']]]),
  )

  it('reads each hole off the medicine and its codes', () => {
    expect(hasGap(noHsn, [], 'hsn')).toBe(true)
    expect(hasGap(sold, [], 'hsn')).toBe(false)
    expect(hasGap(sold, [], 'barcode')).toBe(true)
    expect(hasGap(sold, ['8901234567893'], 'barcode')).toBe(false)
    expect(hasGap(noReorder, [], 'reorder')).toBe(true)
    expect(hasGap(noRack, [], 'rack')).toBe(true)
    // Whitespace is not a rack. It came from an import and nobody can walk to it.
    expect(hasGap(medicine(17, { rackLocation: '   ' }), [], 'rack')).toBe(true)
    expect(hasGap(neverSold, [], 'neverSold')).toBe(true)
    expect(hasGap(sold, [], 'neverSold')).toBe(false)
  })

  it('narrows the grid to exactly the rows carrying that hole', () => {
    expect(names(buildMedicinePage(GAPPY, { gap: 'hsn' }).rows)).toEqual(['Aciloc'])
    expect(names(buildMedicinePage(GAPPY, { gap: 'reorder' }).rows)).toEqual(['Combiflam'])
    expect(names(buildMedicinePage(GAPPY, { gap: 'rack' }).rows)).toEqual(['Betnovate'])
    // Only Evion carries a code, so every other live row is in the barcode gap.
    expect(names(buildMedicinePage(GAPPY, { gap: 'barcode' }).rows))
      .toEqual(['Aciloc', 'Betnovate', 'Combiflam', 'Dexona'])
  })

  it('composes with the other predicates rather than replacing them', () => {
    const page = buildMedicinePage(GAPPY, { gap: 'barcode', term: 'aci' })
    expect(names(page.rows)).toEqual(['Aciloc'])
  })

  it('counts the holes over the LIVE catalogue, whatever the page is showing', () => {
    // A delisted row with no HSN cannot reach an invoice, so it is not work.
    const filtered = buildMedicinePage(GAPPY, { gap: 'hsn', limit: 1 })
    expect(filtered.quality.hsn).toBe(1)
    expect(filtered.quality.active).toBe(5)
    expect(filtered.quality.inactive).toBe(1)
    expect(filtered.quality.barcode).toBe(4)
    expect(filtered.quality.reorder).toBe(1)
    expect(filtered.quality.rack).toBe(1)
    expect(filtered.quality.neverSold).toBe(4)
    // The counts do not move when the view does.
    expect(buildMedicinePage(GAPPY, {}).quality).toEqual(filtered.quality)
  })
})

// ---------------------------------------------------------- price history ---

describe('price history', () => {
  it('reads the price series off the batches, earliest expiry first', () => {
    const history = buildPriceHistory([
      batch(3, 1, { batchNo: 'C', expiryDate: D173, mrpPerPack: '132.00', mrpPerUnit: '13.2000' }),
      batch(1, 1, { batchNo: 'A', expiryDate: D22, mrpPerPack: '110.00', mrpPerUnit: '11.0000' }),
      batch(2, 1, { batchNo: 'B', expiryDate: D83, mrpPerPack: '120.00', mrpPerUnit: '12.0000' }),
    ])
    expect(history.points.map((p) => p.batchNo)).toEqual(['A', 'B', 'C'])
    expect(history.latestMrpPerPack).toBe('132.00')
    expect(history.previousMrpPerPack).toBe('120.00')
    expect(history.mrpChangePct).toBe('10.0')
  })

  it('skips back past a repeated price to find the last real change', () => {
    const history = buildPriceHistory([
      batch(1, 1, { expiryDate: D22, mrpPerPack: '100.00' }),
      batch(2, 1, { expiryDate: D83, mrpPerPack: '120.00' }),
      batch(3, 1, { expiryDate: D173, mrpPerPack: '120.00' }),
    ])
    expect(history.previousMrpPerPack).toBe('100.00')
    expect(history.mrpChangePct).toBe('20.0')
  })

  it('reports no change when every batch is priced the same', () => {
    const history = buildPriceHistory([
      batch(1, 1, { expiryDate: D22 }),
      batch(2, 1, { expiryDate: D83 }),
    ])
    expect(history.previousMrpPerPack).toBeNull()
    expect(history.mrpChangePct).toBeNull()
  })

  it('states the margin over MRP, and refuses to invent one at zero MRP', () => {
    expect(marginOverMrp('10.0000', '6.0000')).toBe('40.0')
    expect(marginOverMrp('0.0000', '6.0000')).toBeNull()
    expect(marginOverMrp('not a number', '6.0000')).toBeNull()
  })

  it('fills the first-seen stamp from the ledger when the caller has it', () => {
    const movements = [
      movement(1, { batchId: 1, at: '2026-04-02T10:00:00.000Z', reason: 'SALE' }),
      movement(2, { batchId: 1, at: '2026-03-01T09:00:00.000Z', reason: 'PURCHASE' }),
    ]
    const [point] = buildPriceHistory([batch(1, 1)], movements).points
    expect(point?.receivedAt).toBe('2026-03-01T09:00:00.000Z')
    // Absent a ledger the series still orders, it just cannot date itself.
    expect(buildPriceHistory([batch(1, 1)]).points[0]?.receivedAt).toBeNull()
  })
})

// -------------------------------------------------------------- velocity ---

function movement(id: number, over: Partial<StockMovement> = {}): StockMovement {
  return {
    id,
    at: '2026-09-01T08:00:00.000Z',
    batchId: 1,
    batchNo: 'B1',
    medicineId: 1,
    brandName: 'Dolo 650',
    qtyDelta: '-10',
    balanceAfter: '90',
    reason: 'SALE',
    refType: 'SALE_INVOICE',
    refId: '1',
    note: null,
    ...over,
  }
}

describe('sales velocity', () => {
  const opts = { today: TODAY, months: 3, stockQty: '300' }

  it('buckets dispensed units by month and pads the months with none', () => {
    const v = salesVelocity(
      [
        movement(1, { at: '2026-07-04T08:00:00.000Z', qtyDelta: '-30' }),
        movement(2, { at: '2026-09-02T08:00:00.000Z', qtyDelta: '-60' }),
      ],
      opts,
    )
    expect(v.points.map((p) => p.key)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(v.points.map((p) => p.units)).toEqual(['30.000', '0.000', '60.000'])
    expect(v.totalUnits).toBe('90.000')
    expect(v.perMonth).toBe('30.0')
  })

  it('nets a sale return off, rather than counting it as demand', () => {
    const v = salesVelocity(
      [
        movement(1, { at: '2026-09-02T08:00:00.000Z', qtyDelta: '-50' }),
        movement(2, { at: '2026-09-03T08:00:00.000Z', qtyDelta: '10', reason: 'SALE_RETURN' }),
      ],
      opts,
    )
    expect(v.totalUnits).toBe('40.000')
  })

  it('ignores movements that are not demand at all', () => {
    const v = salesVelocity(
      [
        movement(1, { at: '2026-09-02T08:00:00.000Z', qtyDelta: '500', reason: 'PURCHASE' }),
        movement(2, { at: '2026-09-03T08:00:00.000Z', qtyDelta: '-20', reason: 'EXPIRY_WRITEOFF' }),
        movement(3, { at: '2026-09-04T08:00:00.000Z', qtyDelta: '-40', reason: 'TRANSFER' }),
      ],
      opts,
    )
    expect(v.totalUnits).toBe('0.000')
    expect(v.daysOfCover).toBeNull()
    expect(v.lastSoldAt).toBeNull()
  })

  it('drops anything older than the window instead of folding it into month one', () => {
    const v = salesVelocity([movement(1, { at: '2026-01-04T08:00:00.000Z', qtyDelta: '-99' })], opts)
    expect(v.totalUnits).toBe('0.000')
  })

  it('turns the rate into days of cover against the stock on hand', () => {
    // 90 units over three 30-day months is one a day; 300 on the shelf is 300 days.
    const v = salesVelocity([movement(1, { at: '2026-09-02T08:00:00.000Z', qtyDelta: '-90' })], opts)
    expect(v.daysOfCover).toBe(300)
  })

  it('reports the last dispense, not the last movement of any kind', () => {
    const v = salesVelocity(
      [
        movement(1, { at: '2026-09-06T08:00:00.000Z', qtyDelta: '-5' }),
        movement(2, { at: '2026-09-07T08:00:00.000Z', qtyDelta: '900', reason: 'PURCHASE' }),
      ],
      opts,
    )
    expect(v.lastSoldAt).toBe('2026-09-06T08:00:00.000Z')
    expect(v.last30Units).toBe('5.000')
  })
})
