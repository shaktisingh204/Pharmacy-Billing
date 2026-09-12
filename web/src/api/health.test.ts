import { describe, expect, it } from 'vitest'
import type { Batch, Medicine } from '@contract'
import type { StockLedgerRow } from '@/db/schema'
import { healthSummary, reconcileStock } from './health'

/**
 * Invariant I17: the ledger and the shelf are two records of one fact, kept
 * apart precisely so they can be compared. Each test below is a way they drift.
 */

function batch(id: number, over: Partial<Batch> = {}): Batch {
  return {
    id,
    storeId: 1,
    medicineId: 1,
    batchNo: `B${id}`,
    expiryDate: '2028-06-30',
    mrpPerPack: '100.00',
    mrpPerUnit: '10.0000',
    ptrPerUnit: '7.0000',
    landedCostPerUnit: '6.0000',
    purchaseGstPct: '12',
    qtyOnHand: '0',
    isQuarantined: false,
    ...over,
  }
}

function row(over: Partial<StockLedgerRow> & { id: number }): StockLedgerRow {
  return {
    storeId: 1,
    batchId: 1,
    medicineId: 1,
    at: '2026-09-01T10:00:00.000Z',
    qtyDelta: '0',
    balanceAfter: '0',
    reason: 'PURCHASE',
    refType: 'PURCHASE_INVOICE',
    refId: 'GRN1',
    ...over,
  }
}

const medicine = { brandName: 'Dolo 650' } as Medicine

const run = (batches: Batch[], ledger: StockLedgerRow[]) =>
  reconcileStock({
    batches,
    ledger,
    medicineFor: () => medicine,
    generatedAt: '2026-09-09T12:00:00.000Z',
  })

describe('a book that balances', () => {
  it('replays the movements and lands on the shelf', () => {
    const r = run(
      [batch(1, { qtyOnHand: '40' })],
      [
        row({ id: 1, qtyDelta: '100', balanceAfter: '100' }),
        row({ id: 2, qtyDelta: '-60', balanceAfter: '40', reason: 'SALE' }),
      ],
    )
    expect(r.balanced).toBe(true)
    expect(r.discrepancies).toEqual([])
    expect(r.movementsChecked).toBe(2)
    expect(healthSummary(r)).toMatch(/balanced — 1 batches, 2 movements/)
  })

  it('orders two movements sharing a millisecond by insertion, not by chance', () => {
    // One sale allocating a batch twice writes both rows at the same instant.
    // Replayed in the wrong order the chain breaks on a book that is sound.
    const at = '2026-09-01T10:00:00.000Z'
    const r = run(
      [batch(1, { qtyOnHand: '85' })],
      [
        row({ id: 3, at, qtyDelta: '-5', balanceAfter: '85' }),
        row({ id: 1, at, qtyDelta: '100', balanceAfter: '100' }),
        row({ id: 2, at, qtyDelta: '-10', balanceAfter: '90' }),
      ],
    )
    expect(r.balanced).toBe(true)
  })

  it('says nothing about an emptied batch with no history', () => {
    expect(run([batch(1, { qtyOnHand: '0' })], []).balanced).toBe(true)
  })
})

describe('a broken chain — the history itself is wrong', () => {
  it('catches a balanceAfter that does not follow from the row before it', () => {
    const r = run(
      [batch(1, { qtyOnHand: '40' })],
      [
        row({ id: 1, qtyDelta: '100', balanceAfter: '100' }),
        // A movement written outside the ledger, or one lost: the delta says 90
        // but the row claims 40.
        row({ id: 2, qtyDelta: '-10', balanceAfter: '40', reason: 'SALE' }),
      ],
    )
    expect(r.balanced).toBe(false)
    expect(r.discrepancies[0]?.kind).toBe('chain')
    expect(r.discrepancies[0]?.ledger).toBe('90.000')
    expect(r.discrepancies[0]?.shelf).toBe('40')
    expect(r.discrepancies[0]?.difference).toBe('50.000')
    expect(healthSummary(r)).toMatch(/broken movement history/)
  })

  it('names the document the chain broke at, which is where to look', () => {
    const r = run(
      [batch(1, { qtyOnHand: '100' })],
      [
        row({ id: 1, qtyDelta: '100', balanceAfter: '100' }),
        row({ id: 2, qtyDelta: '-10', balanceAfter: '95', refId: 'RX2627-T1-00042' }),
      ],
    )
    expect(r.discrepancies[0]?.refId).toBe('RX2627-T1-00042')
    expect(r.discrepancies[0]?.at).toBe('2026-09-01T10:00:00.000Z')
  })

  it('ranks a broken chain above a drifted balance', () => {
    // A wrong history is worse than a sound one that stopped matching the shelf.
    const r = run(
      [batch(1, { qtyOnHand: '10' }), batch(2, { qtyOnHand: '5' })],
      [
        row({ id: 1, batchId: 1, qtyDelta: '100', balanceAfter: '100' }),
        row({ id: 2, batchId: 1, qtyDelta: '-10', balanceAfter: '10' }),
        row({ id: 3, batchId: 2, qtyDelta: '20', balanceAfter: '20' }),
      ],
    )
    expect(r.discrepancies.map((d) => d.kind)).toEqual(['chain', 'drift'])
  })
})

describe('a drifted balance — a write that skipped the ledger', () => {
  it('catches a sound history that no longer matches the shelf', () => {
    const r = run(
      [batch(1, { qtyOnHand: '35' })],
      [
        row({ id: 1, qtyDelta: '100', balanceAfter: '100' }),
        row({ id: 2, qtyDelta: '-60', balanceAfter: '40', reason: 'SALE' }),
      ],
    )
    expect(r.discrepancies[0]?.kind).toBe('drift')
    expect(r.discrepancies[0]?.ledger).toBe('40.000')
    expect(r.discrepancies[0]?.shelf).toBe('35')
  })

  it('values the gap at LANDED cost — the money actually at risk', () => {
    const r = run(
      [batch(1, { qtyOnHand: '35', landedCostPerUnit: '6.0000' })],
      [row({ id: 1, qtyDelta: '40', balanceAfter: '40' })],
    )
    // 5 units adrift at 6.00 landed.
    expect(r.valueAtRisk).toBe('30.00')
  })

  it('reports the value as a magnitude however the gap points', () => {
    const r = run(
      [batch(1, { qtyOnHand: '45', landedCostPerUnit: '6.0000' })],
      [row({ id: 1, qtyDelta: '40', balanceAfter: '40' })],
    )
    expect(r.valueAtRisk).toBe('30.00')
  })
})

describe('what has gone missing entirely', () => {
  it('counts stock holding units with no movement behind it', () => {
    const r = run([batch(1, { qtyOnHand: '40' })], [])
    expect(r.batchesWithoutHistory).toBe(1)
    // Not a discrepancy: there is no history to disagree with. It is its own
    // fact and gets its own counter.
    expect(r.discrepancies).toEqual([])
  })

  it('counts a history whose batch has been deleted, and calls the book unbalanced', () => {
    const r = run([], [row({ id: 1, batchId: 99, qtyDelta: '10', balanceAfter: '10' })])
    expect(r.orphanedLedgers).toBe(1)
    expect(r.balanced).toBe(false)
  })
})

describe('reporting', () => {
  it('caps the list but keeps the count honest in the summary', () => {
    const batches = Array.from({ length: 40 }, (_, i) => batch(i + 1, { qtyOnHand: '1' }))
    const ledger = batches.map((b) => row({ id: b.id, batchId: b.id, qtyDelta: '5', balanceAfter: '5' }))
    const r = run(batches, ledger)
    expect(r.discrepancies).toHaveLength(25)
    expect(r.batchesChecked).toBe(40)
    expect(r.balanced).toBe(false)
  })
})
