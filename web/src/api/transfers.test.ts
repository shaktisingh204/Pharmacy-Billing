import { describe, expect, it } from 'vitest'
import type { ApiError, Batch, Medicine, StoreProfile } from '@contract'
import {
  basisFor, documentFor, findDestinationBatch, newDestinationBatch, priceTransfer,
} from './transfers'
import type { TransferContext, TransferInput, TransferLine } from './transfers'

/**
 * Moving stock between branches. The GST rule decides the document, and every
 * other test here is a way stock goes missing between two shelves.
 */

const HEAD: StoreProfile = {
  id: 1, name: 'Sanjeevani Medical Store', tagline: null, addressLine: '12 MG Road',
  city: 'Pune', state: 'Maharashtra', stateCode: '27', phone: '1', email: null,
  gstin: '27AABCS1429P1ZQ', dlNos: ['MH-PN2-20B'], invoicePrefix: 'RX',
  financialYearStartMonth: 4, currency: '₹', expiryGuardDays: 30,
  nearExpiryBuckets: [30], roundOffEnabled: true, allowNegativeStock: false,
  upiVpa: null, footerNote: '',
  filing: { b2clMinimum: '250000.00', rule46Minimum: '50000.00', hsnDigits: 6 },
}

/** Same GSTIN — one legal person, two shelves. */
const BRANCH: StoreProfile = { ...HEAD, id: 2, name: 'Kothrud', invoicePrefix: 'KT' }

/** Another state, so a different GSTIN: a distinct person under GST. */
const OTHER_CO: StoreProfile = { ...HEAD, id: 3, name: 'Surat', gstin: '24AABCS1429P1ZQ', stateCode: '24' }

function medicine(id: number): Medicine {
  return {
    id, storeId: 1, brandName: 'Dolo 650', genericName: null, compositionText: 'x',
    manufacturer: 'Acme', form: 'Tablet', strengthText: '650mg', packLabel: '1x15',
    unitsPerPack: 15, baseUom: 'TAB', allowLooseSale: true, saleStep: '1',
    hsnCode: '30049099', drugSchedule: 'H', requiresPrescription: true, rackLocation: 'A1',
    reorderLevel: 0, saleRank: 0, isActive: true,
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

const BATCHES = new Map<number, Batch>([[1, batch()]])

function ctx(over: Partial<TransferContext> = {}): TransferContext {
  return {
    from: HEAD,
    to: BRANCH,
    batchOf: (id) => BATCHES.get(id),
    medicineOf: (id) => (id === 1 ? medicine(1) : undefined),
    operatorName: 'Akib',
    createdAt: '2026-09-09T10:00:00.000Z',
    ...over,
  }
}

function input(over: Partial<TransferInput> = {}): TransferInput {
  return {
    idempotencyKey: 'k1',
    fromStoreId: 1,
    toStoreId: 2,
    issuedOn: '2026-09-09',
    reason: 'Kothrud is short before the weekend',
    lines: [{ lineId: 'l1', batchId: 1, qty: '10' }],
    ...over,
  }
}

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return (e as ApiError).code
  }
  return 'DID_NOT_THROW'
}

// ------------------------------------------------------------------- GST ---

describe('which document the movement needs', () => {
  it('is a CHALLAN between two branches on one GSTIN — this is not a supply', () => {
    // One legal person moving its own stock. Raising a tax invoice instead would
    // declare an outward supply that never happened and pay tax on own stock.
    expect(documentFor(HEAD, BRANCH)).toBe('CHALLAN')
    expect(basisFor(HEAD, BRANCH)).toContain('one legal person')
    expect(basisFor(HEAD, BRANCH)).toContain('no tax is charged')
  })

  it('is a TAX INVOICE between two GSTINs, even on the same PAN', () => {
    // A branch in another state is a distinct person under GST.
    expect(documentFor(HEAD, OTHER_CO)).toBe('TAX_INVOICE')
    expect(basisFor(HEAD, OTHER_CO)).toContain('distinct persons')
  })

  it('treats a branch with no GSTIN as a distinct person — the safe direction', () => {
    // Tax raised where a challan would have done is reclaimable; taxable goods
    // moved on a challan that should have been an invoice is an unreported supply.
    expect(documentFor(HEAD, { ...BRANCH, gstin: '' })).toBe('TAX_INVOICE')
  })

  it('puts the reason on the document, in words', () => {
    const t = priceTransfer(input(), ctx())
    expect(t.document).toBe('CHALLAN')
    expect(t.basis).toContain('27AABCS1429P1ZQ')
  })
})

// ----------------------------------------------------------------- stock ---

describe('what may be sent', () => {
  it('refuses more than the shelf holds', () => {
    expect(code(() => priceTransfer(
      input({ lines: [{ lineId: 'l1', batchId: 1, qty: '41' }] }), ctx(),
    ))).toBe('TRANSFER_EXCEEDS_STOCK')
  })

  it('sums two lines against ONE batch before checking it', () => {
    // 25 + 20 each pass alone against 40 and overdraw it together.
    expect(code(() => priceTransfer(
      input({
        lines: [
          { lineId: 'l1', batchId: 1, qty: '25' },
          { lineId: 'l2', batchId: 1, qty: '20' },
        ],
      }),
      ctx(),
    ))).toBe('TRANSFER_EXCEEDS_STOCK')
  })

  it('refuses expired stock — moving it only relocates a write-off', () => {
    const dead = new Map([[1, batch({ expiryDate: '2026-08-31' })]])
    expect(code(() => priceTransfer(input(), ctx({ batchOf: (id) => dead.get(id) }))))
      .toBe('TRANSFER_EXPIRED')
  })

  it('refuses a batch that belongs to another branch', () => {
    const foreign = new Map([[1, batch({ storeId: 9 })]])
    expect(code(() => priceTransfer(input(), ctx({ batchOf: (id) => foreign.get(id) }))))
      .toBe('BATCH_WRONG_STORE')
  })

  it('refuses a branch sending to itself', () => {
    expect(code(() => priceTransfer(input({ toStoreId: 1 }), ctx()))).toBe('TRANSFER_SAME_STORE')
  })

  it('will not move stock out of a building unexplained', () => {
    expect(code(() => priceTransfer(input({ reason: '  ' }), ctx())))
      .toBe('TRANSFER_REASON_REQUIRED')
  })

  it('refuses a document with nothing on it', () => {
    expect(code(() => priceTransfer(input({ lines: [] }), ctx()))).toBe('TRANSFER_EMPTY')
    expect(code(() => priceTransfer(
      input({ lines: [{ lineId: 'l1', batchId: 1, qty: '0' }] }), ctx(),
    ))).toBe('TRANSFER_EMPTY')
  })
})

// ------------------------------------------------------------------ cost ---

describe('what travels with the stock', () => {
  it('carries the LANDED COST, so margin at the branch is not fiction', () => {
    const t = priceTransfer(input(), ctx())
    expect(t.lines[0]?.costPerUnit).toBe('6.0000')
    // 10 units at 6.00: the value of the movement, not a price.
    expect(t.totalValue).toBe('60.00')
  })

  it('carries the printed MRP, which the customer pays whatever branch sells it', () => {
    expect(priceTransfer(input(), ctx()).lines[0]?.mrpPerPack).toBe('150.00')
  })
})

// -------------------------------------------------------------- identity ---

describe('the batch arriving is the SAME batch', () => {
  const line: TransferLine = {
    lineId: 'l1', batchId: 1, medicineId: 1, brandName: 'Dolo 650', packLabel: '1x15',
    batchNo: 'AX2314', expiryDate: '2027-11-30', hsnCode: '30049099', qty: '10',
    costPerUnit: '6.0000', mrpPerPack: '150.00', lineValue: '60.00',
  }

  it('matches on medicine, batch number, expiry AND printed MRP', () => {
    const dest = [batch({ id: 9, storeId: 2 })]
    expect(findDestinationBatch(line, dest)?.id).toBe(9)
  })

  it('does NOT merge two batches that share a number at different MRPs', () => {
    // The same printed batch number legitimately arrives at a revised MRP, and
    // merging them would sell one at the other's price.
    const dest = [batch({ id: 9, storeId: 2, mrpPerPack: '160.00' })]
    expect(findDestinationBatch(line, dest)).toBeUndefined()
  })

  it('does not merge across a different expiry', () => {
    const dest = [batch({ id: 9, storeId: 2, expiryDate: '2027-12-31' })]
    expect(findDestinationBatch(line, dest)).toBeUndefined()
  })

  it('builds a destination batch that keeps the identity and the cost', () => {
    const made = newDestinationBatch(line, batch(), 2)
    expect(made).toMatchObject({
      storeId: 2,
      medicineId: 1,
      batchNo: 'AX2314',
      expiryDate: '2027-11-30',
      mrpPerPack: '150.00',
      landedCostPerUnit: '6.0000',
      qtyOnHand: '10',
    })
  })

  it('never arrives quarantined', () => {
    // A held batch is held for a reason at the shop that held it, and expired
    // stock is refused before it gets here.
    expect(newDestinationBatch(line, batch({ isQuarantined: true }), 2).isQuarantined).toBe(false)
  })
})
