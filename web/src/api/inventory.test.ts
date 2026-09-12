import { describe, expect, it } from 'vitest'
import { ApiError } from '@contract'
import type { Batch, Medicine } from '@contract'
import type { LedgerBalanceRow, MovementRow } from './inventory'
import {
  applyAdjustment, batchIdentityKey, buildBatchPage, buildBatchRow, buildInventorySummary,
  buildShortbookEntries, lastLedgerBalances, normaliseBatchNo, prepareAdjustment,
  sellableByMedicine, toStockMovements,
} from './inventory'

/**
 * Hand-written fixtures, never the seed. A test that reads the demo catalogue
 * stops asserting what a filter MEANS and starts asserting what the generator
 * happened to produce this week.
 *
 * Everything here is a pure function over arrays, which is the point of the
 * module: these are the rules the Rust server has to reproduce, and none of them
 * needs an IndexedDB to be exercised.
 */

const TODAY = '2026-09-08'

/** Days from TODAY, so an expiry reads as a bucket at a glance. */
const EXPIRED = '2026-08-31'
const D22 = '2026-09-30'
const D53 = '2026-10-31'
const D83 = '2026-11-30'
const D295 = '2027-06-30'

function medicine(id: number, over: Partial<Medicine> = {}): Medicine {
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
    drugSchedule: 'H',
    requiresPrescription: true,
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
    expiryDate: D295,
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

function catalogue(batches: readonly Batch[], medicines: readonly Medicine[] = [medicine(1)]) {
  const byId = new Map(medicines.map((m) => [m.id, m]))
  return { batches, medicineFor: (id: number) => byId.get(id), today: TODAY }
}

/** A ledger that agrees with the batches, so a test can corrupt exactly one thing. */
function reconciledLedger(batches: readonly Batch[]): LedgerBalanceRow[] {
  return batches.map((b, i) => ({
    id: i + 1,
    batchId: b.id,
    at: '2026-09-01T10:00:00.000Z',
    balanceAfter: b.qtyOnHand,
  }))
}

describe('batch identity', () => {
  it('ignores the case and spacing a distributor types it with', () => {
    expect(normaliseBatchNo(' ab 2214 ')).toBe('AB2214')
    expect(normaliseBatchNo('AB2214')).toBe(normaliseBatchNo('ab 2214'))
  })

  it('keeps the hyphen, which can separate two genuinely different lots', () => {
    expect(normaliseBatchNo('AB-2214')).not.toBe(normaliseBatchNo('AB2214'))
  })

  it('treats the same batch number at a revised MRP as a DIFFERENT batch', () => {
    const base = { storeId: 1, medicineId: 7, batchNo: 'AB2214', expiryDate: D295 }
    expect(batchIdentityKey({ ...base, mrpPerPack: '100.00' }))
      .not.toBe(batchIdentityKey({ ...base, mrpPerPack: '112.00' }))
    // Written two ways, the same money is the same batch.
    expect(batchIdentityKey({ ...base, mrpPerPack: '100.5' }))
      .toBe(batchIdentityKey({ ...base, mrpPerPack: '100.50' }))
  })
})

describe('buildBatchRow', () => {
  it('buckets by the printed expiry and values what is on hand', () => {
    const row = buildBatchRow(
      batch(1, 1, { expiryDate: D83, qtyOnHand: '30', mrpPerUnit: '10.0000', landedCostPerUnit: '6.5000' }),
      medicine(1),
      TODAY,
    )
    expect(row.daysToExpiry).toBe(83)
    expect(row.bucket).toBe('d90')
    expect(row.valueAtMrp).toBe('300.00')
    expect(row.valueAtCost).toBe('195.00')
  })

  it('still values expired and quarantined stock — that is the write-off queue', () => {
    const expired = buildBatchRow(
      batch(1, 1, { expiryDate: EXPIRED, qtyOnHand: '10', isQuarantined: true }),
      medicine(1),
      TODAY,
    )
    expect(expired.bucket).toBe('expired')
    expect(expired.daysToExpiry).toBeLessThan(0)
    expect(expired.valueAtCost).toBe('60.00')
  })
})

describe('buildBatchPage', () => {
  const batches = [
    batch(1, 1, { expiryDate: EXPIRED, qtyOnHand: '5' }),
    batch(2, 1, { expiryDate: D22, qtyOnHand: '10' }),
    batch(3, 1, { expiryDate: D83, qtyOnHand: '20' }),
    batch(4, 1, { expiryDate: D295, qtyOnHand: '40' }),
  ]

  it('orders by soonest expiry by default', () => {
    const page = buildBatchPage(catalogue(batches), {})
    expect(page.rows.map((r) => r.batch.id)).toEqual([1, 2, 3, 4])
    expect(page.total).toBe(4)
    expect(page.nextCursor).toBeNull()
  })

  it('reads a bucket filter as a WINDOW, so ≤90 days includes the 22-day batch', () => {
    const page = buildBatchPage(catalogue(batches), { bucket: 'd90' })
    expect(page.rows.map((r) => r.batch.id)).toEqual([2, 3])
  })

  it('keeps expired stock out of every near-expiry window and in its own', () => {
    expect(buildBatchPage(catalogue(batches), { bucket: 'd180' }).rows.map((r) => r.batch.id))
      .toEqual([2, 3])
    expect(buildBatchPage(catalogue(batches), { bucket: 'expired' }).rows.map((r) => r.batch.id))
      .toEqual([1])
  })

  it('answers low and out from the SHELF, not from one batch', () => {
    // 30 sellable units against a reorder level of 100: the shelf is low, even
    // though neither batch is remarkable on its own.
    const low = [batch(1, 1, { qtyOnHand: '10' }), batch(2, 1, { qtyOnHand: '20' })]
    expect(buildBatchPage(catalogue(low), { stock: 'low' }).rows).toHaveLength(2)

    // Everything on hand is expired: nothing is dispensable, so the shelf is
    // out — and the empty batches are exactly what has to be written off.
    const out = [batch(1, 1, { expiryDate: EXPIRED, qtyOnHand: '10' })]
    expect(buildBatchPage(catalogue(out), { stock: 'out' }).rows).toHaveLength(1)
    expect(buildBatchPage(catalogue(out), { stock: 'low' }).rows).toHaveLength(0)
  })

  it('finds a batch by the number on a recall notice', () => {
    const page = buildBatchPage(catalogue(batches), { term: 'b3' })
    expect(page.rows.map((r) => r.batch.id)).toEqual([3])
  })

  it('pages a total ordering, so consecutive pages neither repeat nor skip', () => {
    const first = buildBatchPage(catalogue(batches), { limit: 3 })
    expect(first.rows.map((r) => r.batch.id)).toEqual([1, 2, 3])
    expect(first.nextCursor).toBe(3)
    const second = buildBatchPage(catalogue(batches), { limit: 3, cursor: first.nextCursor ?? 0 })
    expect(second.rows.map((r) => r.batch.id)).toEqual([4])
    expect(second.nextCursor).toBeNull()
  })

  it('drops a batch whose medicine has vanished rather than rendering half a row', () => {
    const orphan = [...batches, batch(9, 404, { expiryDate: D53 })]
    expect(buildBatchPage(catalogue(orphan), {}).total).toBe(4)
  })
})

describe('sellableByMedicine', () => {
  it('counts neither expired nor quarantined stock', () => {
    const stock = sellableByMedicine([
      batch(1, 1, { qtyOnHand: '10' }),
      batch(2, 1, { qtyOnHand: '10', isQuarantined: true }),
      batch(3, 1, { qtyOnHand: '10', expiryDate: EXPIRED }),
    ], TODAY)
    expect(stock.get(1)?.v).toBe(10_000_000n)
  })
})

describe('lastLedgerBalances', () => {
  it('breaks a same-instant tie on id — a multi-line receipt writes several', () => {
    const balances = lastLedgerBalances([
      { id: 1, batchId: 7, at: '2026-09-08T10:00:00.000Z', balanceAfter: '10' },
      { id: 2, batchId: 7, at: '2026-09-08T10:00:00.000Z', balanceAfter: '30' },
    ])
    expect(balances.get(7)?.v).toBe(30_000_000n)
  })
})

describe('buildInventorySummary', () => {
  const medicines = [medicine(1), medicine(2, { reorderLevel: 5 }), medicine(3)]

  it('counts a batch whose quantity disagrees with the ledger', () => {
    const batches = [batch(1, 1, { qtyOnHand: '40' }), batch(2, 1, { qtyOnHand: '10' })]
    const ledger = reconciledLedger(batches)
    expect(buildInventorySummary({ batches, medicines, ledger, today: TODAY, nearExpiryBuckets: [30] })
      .reconciliationDiscrepancies).toBe(0)

    // Stock moved without a movement row. This is the number that proves the
    // ledger, so it has to notice a single corrupted batch.
    const corrupted = [batch(1, 1, { qtyOnHand: '38' }), batch(2, 1, { qtyOnHand: '10' })]
    expect(buildInventorySummary({ batches: corrupted, medicines, ledger, today: TODAY, nearExpiryBuckets: [30] })
      .reconciliationDiscrepancies).toBe(1)
  })

  it('treats stock with no ledger row at all as a discrepancy', () => {
    const batches = [batch(1, 1, { qtyOnHand: '40' })]
    expect(buildInventorySummary({ batches, medicines, ledger: [], today: TODAY, nearExpiryBuckets: [30] })
      .reconciliationDiscrepancies).toBe(1)
  })

  it('reports a batch whose medicine has vanished, which the grid can only drop', () => {
    // `buildBatchPage` cannot render this row — half its columns come off the
    // master — so its value would otherwise sit in the tiles above a grid that
    // never shows it, with nothing on the screen saying so.
    const batches = [batch(9, 99, { qtyOnHand: '10' })]
    const summary = buildInventorySummary({
      batches, medicines, ledger: reconciledLedger(batches), today: TODAY, nearExpiryBuckets: [30],
    })
    expect(summary.reconciliationDiscrepancies).toBe(1)
    expect(buildBatchPage({ batches, medicineFor: () => undefined, today: TODAY }, {}).total).toBe(0)
  })

  it('values the shelf and leaves emptied batches out of the count', () => {
    const batches = [
      batch(1, 1, { qtyOnHand: '10', mrpPerUnit: '10.0000', landedCostPerUnit: '6.0000' }),
      batch(2, 2, { qtyOnHand: '5', mrpPerUnit: '20.0000', landedCostPerUnit: '12.0000' }),
      // Sold through. It stays on file for the ledger to point at, but counting
      // it would make "batches" drift upward forever.
      batch(3, 1, { qtyOnHand: '0' }),
    ]
    const summary = buildInventorySummary({
      batches, medicines, ledger: reconciledLedger(batches), today: TODAY, nearExpiryBuckets: [30],
    })
    expect(summary.totalBatches).toBe(2)
    expect(summary.totalSkus).toBe(2)
    expect(summary.stockValueAtMrp).toBe('200.00')
    expect(summary.stockValueAtCost).toBe('120.00')
  })

  it('counts low and out-of-stock SKUs over the whole catalogue', () => {
    const batches = [
      // Medicine 1 holds 10 against a reorder level of 100 — low.
      batch(1, 1, { qtyOnHand: '10' }),
      // Medicine 2 holds 40 against a level of 5 — healthy.
      batch(2, 2, { qtyOnHand: '40' }),
      // Medicine 3's only stock is quarantined, so nothing is dispensable.
      batch(3, 3, { qtyOnHand: '40', isQuarantined: true }),
    ]
    const summary = buildInventorySummary({
      batches, medicines, ledger: reconciledLedger(batches), today: TODAY, nearExpiryBuckets: [30],
    })
    expect(summary.lowStockSkus).toBe(1)
    expect(summary.outOfStockSkus).toBe(1)
    expect(summary.quarantinedBatches).toBe(1)
  })

  it('nests the at-risk windows and excludes stock that has already expired', () => {
    const batches = [
      batch(1, 1, { expiryDate: D22, qtyOnHand: '10', landedCostPerUnit: '2.0000' }),
      batch(2, 1, { expiryDate: D83, qtyOnHand: '5', landedCostPerUnit: '4.0000' }),
      batch(3, 1, { expiryDate: EXPIRED, qtyOnHand: '9', landedCostPerUnit: '9.0000' }),
      batch(4, 1, { expiryDate: D295, qtyOnHand: '9', landedCostPerUnit: '9.0000' }),
    ]
    const summary = buildInventorySummary({
      batches, medicines, ledger: reconciledLedger(batches), today: TODAY,
      nearExpiryBuckets: [180, 90, 60, 30],
    })
    expect(summary.atRisk).toEqual([
      { bucket: 'd30', days: 30, batches: 1, valueAtCost: '20.00' },
      { bucket: 'd60', days: 60, batches: 1, valueAtCost: '20.00' },
      { bucket: 'd90', days: 90, batches: 2, valueAtCost: '40.00' },
      { bucket: 'd180', days: 180, batches: 2, valueAtCost: '40.00' },
    ])
  })
})

describe('prepareAdjustment', () => {
  const b = batch(1, 1, { qtyOnHand: '40', batchNo: 'AB2214' })

  it('accepts a correction and lands the new balance', () => {
    const prepared = prepareAdjustment(b, { batchId: 1, qtyDelta: '-6', reason: 'ADJUSTMENT', note: 'Counted 34 on the shelf' })
    expect(prepared.balanceAfter.v).toBe(34_000_000n)
    expect(applyAdjustment(b, prepared).qtyOnHand).toBe('34.000')
  })

  it('refuses an unexplained adjustment — it is indistinguishable from shrinkage', () => {
    expect(() => prepareAdjustment(b, { batchId: 1, qtyDelta: '-6', reason: 'ADJUSTMENT', note: '   ' }))
      .toThrow(ApiError)
  })

  it('never drives stock negative', () => {
    try {
      prepareAdjustment(b, { batchId: 1, qtyDelta: '-41', reason: 'ADJUSTMENT', note: 'Damaged' })
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('STOCK_INSUFFICIENT')
    }
    // The boundary itself is legal: writing off the last strip is ordinary.
    expect(prepareAdjustment(b, { batchId: 1, qtyDelta: '-40', reason: 'ADJUSTMENT', note: 'Damaged' })
      .balanceAfter.v).toBe(0n)
  })

  it('rejects a zero, and a write-off keyed with the wrong sign', () => {
    expect(() => prepareAdjustment(b, { batchId: 1, qtyDelta: '0', reason: 'ADJUSTMENT', note: 'nothing' }))
      .toThrow(ApiError)
    // A write-off that ADDS stock would put expired goods back on the shelf
    // under a reason code saying they were destroyed.
    expect(() => prepareAdjustment(b, { batchId: 1, qtyDelta: '5', reason: 'EXPIRY_WRITEOFF', note: 'Expired' }))
      .toThrow(ApiError)
  })

  it('rejects a quantity that is not a number rather than parsing it as one', () => {
    expect(() => prepareAdjustment(b, { batchId: 1, qtyDelta: 'six', reason: 'ADJUSTMENT', note: 'Counted' }))
      .toThrow(ApiError)
  })
})

describe('toStockMovements', () => {
  const rows: MovementRow[] = [
    { id: 1, batchId: 1, medicineId: 1, at: '2026-09-01T10:00:00.000Z', qtyDelta: '100', balanceAfter: '100', reason: 'PURCHASE', refType: 'PURCHASE_INVOICE', refId: 'k1', note: null },
    { id: 2, batchId: 1, medicineId: 1, at: '2026-09-05T10:00:00.000Z', qtyDelta: '-10', balanceAfter: '90', reason: 'SALE', refType: 'SALE_INVOICE', refId: 'k2' },
  ]

  it('reads newest first and carries the names a human needs', () => {
    const batches = new Map([[1, batch(1, 1, { batchNo: 'AB2214' })]])
    const moves = toStockMovements(rows, (id) => batches.get(id), () => medicine(1, { brandName: 'Dolo 650' }), 10)
    expect(moves.map((m) => m.id)).toEqual([2, 1])
    expect(moves[0]?.batchNo).toBe('AB2214')
    expect(moves[0]?.brandName).toBe('Dolo 650')
    expect(moves[0]?.note).toBeNull()
  })

  it('still renders a movement whose batch has gone — the ledger is append-only', () => {
    const moves = toStockMovements(rows, () => undefined, () => undefined, 1)
    expect(moves).toHaveLength(1)
    expect(moves[0]?.batchNo).toBe('#1')
  })
})

describe('buildShortbookEntries', () => {
  it('carries the stock that is on the shelf NOW, so a restocked row can be trimmed', () => {
    const entries = buildShortbookEntries({
      rows: [
        { id: 1, medicineId: 1, term: 'dolo', qty: '10', at: '2026-09-01T10:00:00.000Z' },
        { id: 2, medicineId: null, term: 'something nobody stocks', qty: '2', at: '2026-09-05T10:00:00.000Z' },
      ],
      medicineFor: () => medicine(1, { brandName: 'Dolo 650' }),
      batchesFor: () => [batch(1, 1, { qtyOnHand: '12' }), batch(2, 1, { qtyOnHand: '8', expiryDate: EXPIRED })],
      today: TODAY,
    })
    expect(entries.map((e) => e.id)).toEqual([2, 1])
    // Only the sellable batch counts: expired stock is not an answer to a
    // shortage, and a row that looks restocked because of it would be dropped.
    expect(entries[1]?.stockQty).toBe('12.000')
    expect(entries[1]?.brandName).toBe('Dolo 650')
    expect(entries[0]?.stockQty).toBeNull()
  })
})
