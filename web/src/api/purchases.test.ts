import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type { Medicine, PurchaseInvoice, PurchaseInvoiceInput, PurchaseLineInput, Supplier } from '@contract'
import * as D from '@/domain/decimal'
import type { PurchasePricingContext } from './purchases'
import {
  applySupplierUpdate, blendLandedCost, findDuplicatePurchase, isInterStateSupply, normaliseExpiry,
  precheckPurchase, prepareSupplier, pricePurchase,
} from './purchases'

/**
 * The goods-receipt arithmetic, exercised as values.
 *
 * Three of these encode rules that are silently wrong rather than loudly broken
 * when they are got backwards — landed cost divided by the paid quantity, tax
 * split out of a rate that never included it, and an expiry stored as the first
 * of the month — so they are asserted on numbers a person can check by hand.
 */

const STORE_STATE = '27'

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
    packLabel: '10x10',
    unitsPerPack: 10,
    baseUom: 'TAB',
    allowLooseSale: true,
    saleStep: '1',
    hsnCode: '30049099',
    drugSchedule: 'H',
    requiresPrescription: true,
    rackLocation: 'A1',
    reorderLevel: 100,
    saleRank: 0,
    isActive: true,
    ...over,
  }
}

/** A strip of ten, and a single bottle — one unit per pack makes a per-unit
 *  landed cost readable without dividing anything in your head. */
const MEDICINES = new Map<number, Medicine>([
  [1, medicine(1, { brandName: 'Dolo 650' })],
  [2, medicine(2, { brandName: 'Cough Syrup', unitsPerPack: 1, packLabel: '100ml', baseUom: 'BOTTLE', form: 'Syrup' })],
])

function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    id: 1,
    storeId: 1,
    name: 'Sanjivani Pharma Distributors',
    phone: '2026441120',
    address: 'Bhosari MIDC, Pune',
    gstin: '27AACCS4471M1ZB',
    dlNo: 'MH-PN1-114B',
    paymentTermsDays: 30,
    creditLimit: '500000.00',
    outstanding: '0.00',
    ...over,
  }
}

function ctx(over: Partial<PurchasePricingContext> = {}): PurchasePricingContext {
  return {
    storeId: 1,
    storeStateCode: STORE_STATE,
    roundOffEnabled: true,
    supplier: supplier(),
    medicineFor: (id) => MEDICINES.get(id),
    lastRatePerPack: () => null,
    createdAt: '2026-09-08T10:00:00.000Z',
    ...over,
  }
}

function line(over: Partial<PurchaseLineInput> = {}): PurchaseLineInput {
  return {
    lineId: 'l1',
    medicineId: 1,
    batchNo: 'AB2214',
    expiry: '11/27',
    qtyPacks: '10',
    freePacks: '0',
    mrpPerPack: '150.00',
    ratePerPack: '100.00',
    discountPct: '0',
    gstRatePct: '12',
    ...over,
  }
}

function receipt(over: Partial<PurchaseInvoiceInput> = {}): PurchaseInvoiceInput {
  return {
    idempotencyKey: 'k1',
    supplierId: 1,
    supplierInvoiceNo: 'INV-001',
    invoiceDate: '2026-09-08',
    lines: [line()],
    ...over,
  }
}

describe('normaliseExpiry', () => {
  it('takes a printed month to its LAST day', () => {
    // The first of the month would quarantine the pack up to thirty days early,
    // refusing to dispense stock that is still legally saleable.
    expect(normaliseExpiry('11/27')).toBe('2027-11-30')
    expect(normaliseExpiry('01/27')).toBe('2027-01-31')
  })

  it('gets February right, leap year included', () => {
    expect(normaliseExpiry('02/27')).toBe('2027-02-28')
    expect(normaliseExpiry('02/28')).toBe('2028-02-29')
    expect(normaliseExpiry('2/28')).toBe('2028-02-29')
    expect(normaliseExpiry('02/2100')).toBe('2100-02-28')
  })

  it('accepts the other forms a keyboard produces for the same month', () => {
    expect(normaliseExpiry('11-27')).toBe('2027-11-30')
    expect(normaliseExpiry('11/2027')).toBe('2027-11-30')
    expect(normaliseExpiry('2027-11')).toBe('2027-11-30')
    expect(normaliseExpiry(' 11/27 ')).toBe('2027-11-30')
  })

  it('takes a full date to the end of its month too — the pack prints a month', () => {
    expect(normaliseExpiry('2027-11-15')).toBe('2027-11-30')
  })

  it('refuses anything that is not a month', () => {
    for (const bad of ['13/27', '00/27', 'soon', '', '2027', '11/2/27']) {
      expect(() => normaliseExpiry(bad)).toThrow(ApiError)
    }
  })
})

describe('isInterStateSupply', () => {
  it('reads the state code out of the GSTIN rather than trusting a checkbox', () => {
    expect(isInterStateSupply('27AACCS4471M1ZB', STORE_STATE)).toBe(false)
    expect(isInterStateSupply('24AAACM6677R1ZK', STORE_STATE)).toBe(true)
  })

  it('treats an unregistered supplier as local — there is no credit either way', () => {
    expect(isInterStateSupply(null, STORE_STATE)).toBe(false)
  })
})

describe('pricePurchase — tax', () => {
  it('adds GST ON the rate: a purchase bill is EXCLUSIVE, unlike a printed MRP', () => {
    const priced = pricePurchase(receipt(), ctx())
    const l = priced.invoice.lines[0]
    // 10 packs at 100.00 is 1000.00 of taxable value. Splitting 12% OUT of it —
    // the retail rule — would have given 892.86 and under-claimed the credit.
    expect(l?.taxableValue).toBe('1000.00')
    expect(l?.cgst).toBe('60.00')
    expect(l?.sgst).toBe('60.00')
    expect(l?.igst).toBe('0.00')
    expect(l?.lineTotal).toBe('1120.00')
    expect(priced.invoice.netAmount).toBe('1120.00')
  })

  it('takes the second half as a residual, so an odd paisa still foots', () => {
    const priced = pricePurchase(
      receipt({ lines: [line({ medicineId: 2, qtyPacks: '1', ratePerPack: '33.33', gstRatePct: '5' })] }),
      ctx(),
    )
    const l = priced.invoice.lines[0]
    expect(l?.cgst).toBe('0.84')
    expect(l?.sgst).toBe('0.83')
    const foots = D.add(D.add(D.dec(l?.taxableValue ?? '0'), D.dec(l?.cgst ?? '0')), D.dec(l?.sgst ?? '0'))
    expect(D.toStr(foots, 2)).toBe(l?.lineTotal)
  })

  it('bills IGST when the distributor is registered in another state', () => {
    const priced = pricePurchase(receipt(), ctx({ supplier: supplier({ gstin: '24AAACM6677R1ZK' }) }))
    const l = priced.invoice.lines[0]
    expect(priced.interState).toBe(true)
    expect(l?.igst).toBe('120.00')
    expect(l?.cgst).toBe('0.00')
    expect(l?.sgst).toBe('0.00')
  })

  it('applies the trade discount before tax', () => {
    const priced = pricePurchase(receipt({ lines: [line({ discountPct: '10' })] }), ctx())
    const l = priced.invoice.lines[0]
    expect(l?.taxableValue).toBe('900.00')
    expect(l?.lineTotal).toBe('1008.00')
  })
})

describe('pricePurchase — landed cost', () => {
  it('divides by paid PLUS free, with freight, on a 10+1 scheme', () => {
    const priced = pricePurchase(
      receipt({ lines: [line({ qtyPacks: '10', freePacks: '1' })], freight: '100.00' }),
      ctx(),
    )
    const [l] = priced.lines
    // 11 strips of 10 arrive; 1000.00 of goods plus 100.00 of freight is
    // 1100.00 over 110 units, so exactly 10.0000 each. Dividing by the 100 units
    // PAID for would give 11.0000 — 10% high on every scheme line, which is a
    // margin report quietly saying the shop is losing money it is in fact making.
    expect(D.toStr(l?.unitsReceived ?? D.ZERO, 0)).toBe('110')
    expect(l?.line.landedCostPerUnit).toBe('10.0000')
    expect(priced.invoice.netAmount).toBe('1220.00')
    // GST is left out: input credit makes it recoverable, so it is a receivable
    // and not a cost. The seed carries landed cost below PTR for the same reason.
    expect(l?.line.taxableValue).toBe('1000.00')
  })

  it('divides by paid plus free with no freight at all', () => {
    const priced = pricePurchase(receipt({ lines: [line({ qtyPacks: '10', freePacks: '1' })] }), ctx())
    // 1000.00 over 110 units, carried at 4dp for the reason mrpPerUnit is.
    expect(priced.lines[0]?.line.landedCostPerUnit).toBe('9.0909')
  })

  it('apportions freight by line VALUE so the parts sum to it exactly', () => {
    const priced = pricePurchase(
      receipt({
        // One unit per pack, so the landed cost per unit IS the line's share of
        // the bill and the apportionment can be read straight off it.
        lines: [
          line({ lineId: 'a', medicineId: 2, qtyPacks: '1', ratePerPack: '33.33', gstRatePct: '0' }),
          line({ lineId: 'b', medicineId: 2, qtyPacks: '1', ratePerPack: '33.33', gstRatePct: '0' }),
          line({ lineId: 'c', medicineId: 2, qtyPacks: '1', ratePerPack: '33.34', gstRatePct: '0' }),
        ],
        freight: '10.00',
      }),
      ctx(),
    )
    // Largest-remainder, exactly as the apportion golden vector: 3.33/3.33/3.34.
    expect(priced.lines.map((l) => l.line.landedCostPerUnit)).toEqual(['36.6600', '36.6600', '36.6800'])
    const landed = D.sum(priced.lines.map((l) => D.dec(l.line.landedCostPerUnit)))
    const goods = D.dec(priced.invoice.taxableValue)
    // Every paisa of freight reached a line: none invented, none lost.
    expect(D.toStr(D.sub(landed, goods), 2)).toBe('10.00')
    expect(priced.invoice.freight).toBe('10.00')
    // Freight is a bill-level charge, so it stays OUT of the line totals and is
    // added once at the bottom.
    expect(priced.invoice.netAmount).toBe('110.00')
  })

  it('prices a pure-scheme line at nothing without dividing by zero', () => {
    const priced = pricePurchase(
      receipt({ lines: [line({ qtyPacks: '0', freePacks: '5' })] }),
      ctx(),
    )
    expect(priced.lines[0]?.line.taxableValue).toBe('0.00')
    expect(priced.lines[0]?.line.landedCostPerUnit).toBe('0.0000')
    expect(D.toStr(priced.lines[0]?.unitsReceived ?? D.ZERO, 0)).toBe('50')
    // Nothing was charged, so there is no price to the retailer — which is the
    // whole difference between PTR and landed cost.
    expect(D.isZero(priced.lines[0]?.ptrPerUnit ?? D.ONE)).toBe(true)
  })

  it('still carries freight on a bill with no value to weigh it by', () => {
    // A pure-scheme delivery is charged nothing for the goods and something for
    // bringing them. Apportioning by value would hand every line a zero share and
    // carry fifty free bottles at no cost at all — the same understated margin
    // dividing landed cost by paid-only produces.
    const priced = pricePurchase(
      receipt({ freight: '500.00', lines: [line({ qtyPacks: '0', freePacks: '5' })] }),
      ctx(),
    )
    expect(priced.lines[0]?.line.landedCostPerUnit).toBe('10.0000')
    expect(priced.invoice.freight).toBe('500.00')
    // Value is still the weight the moment there is any value on the bill.
    const mixed = pricePurchase(
      receipt({
        freight: '500.00',
        lines: [line({ qtyPacks: '0', freePacks: '5' }), line({ lineId: 'l2', qtyPacks: '10' })],
      }),
      ctx(),
    )
    expect(mixed.lines[0]?.line.landedCostPerUnit).toBe('0.0000')
    expect(mixed.lines[1]?.line.landedCostPerUnit).toBe('15.0000')
  })

  it('echoes the quantities the way a document reads them', () => {
    const priced = pricePurchase(
      receipt({ lines: [line({ qtyPacks: '10', freePacks: '1' }), line({ lineId: 'l2', qtyPacks: '0.5', freePacks: '0' })] }),
      ctx(),
    )
    expect(priced.invoice.lines.map((l) => `${l.qtyPacks}+${l.freePacks}`)).toEqual(['10+1', '0.5+0'])
    expect(priced.invoice.lines[0]?.gstRatePct).toBe('12')
    expect(priced.invoice.lines[0]?.discountPct).toBe('0')
  })
})

describe('pricePurchase — the rest of the document', () => {
  it('keeps the printed expiry on the document and the month-end date off it', () => {
    const priced = pricePurchase(receipt({ lines: [line({ expiry: ' 11/27 ' })] }), ctx())
    // The document records the paper the operator was holding; the last day of
    // that month is a property of the BATCH the receipt creates.
    expect(priced.invoice.lines[0]?.expiry).toBe('11/27')
    expect(priced.lines[0]?.expiryDate).toBe('2027-11-30')
  })

  it('flags a rate that has moved since the last bill, and stays quiet when it has not', () => {
    const changed = pricePurchase(receipt(), ctx({ lastRatePerPack: () => '95.00' }))
    expect(changed.invoice.lines[0]?.rateChangedFrom).toBe('95.00')
    const same = pricePurchase(receipt(), ctx({ lastRatePerPack: () => '100.00' }))
    expect(same.invoice.lines[0]?.rateChangedFrom).toBeNull()
    // Written differently is not a change.
    const equal = pricePurchase(receipt(), ctx({ lastRatePerPack: () => '100' }))
    expect(equal.invoice.lines[0]?.rateChangedFrom).toBeNull()
  })

  it('creates nothing: no batch id, and no document number to allocate', () => {
    const priced = pricePurchase(receipt(), ctx())
    expect(priced.invoice.lines[0]?.batchId).toBeNull()
    expect(priced.invoice).not.toHaveProperty('purchaseNo')
    expect(priced.invoice).not.toHaveProperty('id')
    // A receipt records what is OWED; paying it is a separate document.
    expect(priced.invoice.amountPaid).toBe('0.00')
  })

  it('rounds the payable to the rupee and shows the adjustment', () => {
    const priced = pricePurchase(
      receipt({ lines: [line({ medicineId: 2, qtyPacks: '1', ratePerPack: '99.55', gstRatePct: '0' })] }),
      ctx(),
    )
    expect(priced.invoice.netAmount).toBe('100.00')
    expect(priced.invoice.roundOff).toBe('0.45')
  })

  it('refuses a line the catalogue, the pack or the bill cannot support', () => {
    expect(() => pricePurchase(receipt({ lines: [line({ medicineId: 404 })] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ lines: [line({ mrpPerPack: '0' })] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ lines: [line({ batchNo: '  ' })] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ lines: [line({ qtyPacks: '0', freePacks: '0' })] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ lines: [line({ discountPct: '120' })] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ lines: [] }), ctx())).toThrow(ApiError)
    expect(() => pricePurchase(receipt({ supplierInvoiceNo: ' ' }), ctx())).toThrow(ApiError)
  })
})

describe('blendLandedCost', () => {
  it('weights the new price against the stock already on the shelf', () => {
    const blended = blendLandedCost(
      { qty: D.dec('100'), costPerUnit: D.dec('10.0000') },
      { qty: D.dec('100'), costPerUnit: D.dec('12.0000') },
    )
    expect(D.toStr(blended, 4)).toBe('11.0000')
  })

  it('takes the received price whole when the batch is new or empty', () => {
    const blended = blendLandedCost(
      { qty: D.ZERO, costPerUnit: D.ZERO },
      { qty: D.dec('110'), costPerUnit: D.dec('9.0909') },
    )
    expect(D.toStr(blended, 4)).toBe('9.0909')
  })
})

describe('precheckPurchase', () => {
  const posted: PurchaseInvoice = {
    id: 7,
    purchaseNo: 'GRN2627-00001',
    storeId: 1,
    supplierId: 1,
    supplierName: 'Sanjivani Pharma Distributors',
    supplierInvoiceNo: 'INV-001',
    invoiceDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    lines: [],
    taxableValue: '1000.00',
    cgst: '60.00',
    sgst: '60.00',
    igst: '0.00',
    freight: '0.00',
    roundOff: '0.00',
    netAmount: '1120.00',
    amountPaid: '0.00',
    status: 'POSTED',
    notes: null,
  }

  it('rejects the same distributor bill keyed twice, however it was typed', () => {
    try {
      precheckPurchase({ supplierId: 1, supplierInvoiceNo: ' inv-001 ' }, { replay: undefined, existing: [posted] })
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('PURCHASE_EXISTS')
      // The original rides on the error so the screen can OPEN it instead of
      // leaving the operator to hunt for what they were just told about.
      expect((err as ApiError).details).toBe(posted)
    }
  })

  it('lets the same bill number through for a different distributor', () => {
    expect(precheckPurchase({ supplierId: 2, supplierInvoiceNo: 'INV-001' }, { replay: undefined, existing: [posted] }))
      .toBeNull()
  })

  it('does not let a cancelled receipt block re-entering the bill', () => {
    const cancelled = { ...posted, status: 'CANCELLED' as const }
    expect(findDuplicatePurchase([cancelled], 1, 'INV-001')).toBeUndefined()
  })

  it('returns the ORIGINAL on a replayed key, and lets it beat the duplicate check', () => {
    // A retried receipt whose response was lost is the same bill, not a second
    // one. Reporting a duplicate here would make the offline outbox unable to
    // retry anything it had already succeeded at.
    const replayed = precheckPurchase(
      { supplierId: 1, supplierInvoiceNo: 'INV-001' },
      { replay: posted, existing: [posted] },
    )
    expect(replayed).toBe(posted)
  })
})

describe('suppliers', () => {
  it('validates the GSTIN, because its state code decides the tax treatment', () => {
    expect(() => prepareSupplier({ name: 'A', phone: '2026441120', gstin: '27AACCS4471M1Z' }, []))
      .toThrow(ApiError)
    const ok = prepareSupplier({ name: ' Sanjivani  Pharma ', phone: '+91 20 2644 1120', gstin: '27aaccs4471m1zb' }, [])
    expect(ok.name).toBe('Sanjivani Pharma')
    expect(ok.gstin).toBe('27AACCS4471M1ZB')
    // Stored as digits, so a number typed three ways finds one distributor.
    expect(ok.phone).toBe('912026441120')
    expect(ok.outstanding).toBe('0.00')
  })

  it('refuses a GSTIN whose leading pair is not a state code that was issued', () => {
    // The shape is perfect and the first two digits are the ONE part of a GSTIN
    // this application computes with. "72" for "27" is the commonest way a
    // hand-copied number goes wrong, and it would book IGST on every local bill.
    expect(() => prepareSupplier({ name: 'A', phone: '2026441120', gstin: '72AACCS4471M1ZB' }, []))
      .toThrow(ApiError)
    expect(() => prepareSupplier({ name: 'A', phone: '2026441120', gstin: '00AACCS4471M1ZB' }, []))
      .toThrow(ApiError)
    // 97 is "other territory" and 99 is the centre; both were issued.
    expect(prepareSupplier({ name: 'B', phone: '2026441120', gstin: '97AACCS4471M1ZB' }, []).gstin)
      .toBe('97AACCS4471M1ZB')
  })

  it('accepts a landline, which a distributor is far more likely to answer', () => {
    expect(prepareSupplier({ name: 'Deccan Medical', phone: '020 2553 6677' }, []).phone).toBe('02025536677')
  })

  it('refuses a second row for a business already on the list', () => {
    const existing = [supplier()]
    expect(() => prepareSupplier({ name: 'Totally Different Name', phone: '2026441120', gstin: '27AACCS4471M1ZB' }, existing))
      .toThrow(ApiError)
    expect(() => prepareSupplier({ name: 'sanjivani pharma  distributors', phone: '9999999999' }, existing))
      .toThrow(ApiError)
  })

  it('re-checks the whole row on a partial edit and never touches the balance', () => {
    const current = supplier({ outstanding: '18450.00' })
    const next = applySupplierUpdate(current, { paymentTermsDays: 45 }, [current])
    expect(next.paymentTermsDays).toBe(45)
    expect(next.outstanding).toBe('18450.00')
    expect(() => applySupplierUpdate(current, { gstin: 'NOPE' }, [current])).toThrow(ApiError)
  })
})
