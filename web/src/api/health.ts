import type { Batch, Medicine, Money, Qty } from '@contract'
import type { StockLedgerRow } from '@/db/schema'
import * as D from '@/domain/decimal'

/**
 * Does the stock ledger still agree with the shelf? — invariant I17.
 *
 * The ledger is append-only and audit truth; `batches.qtyOnHand` is the number
 * the counter reads and decrements under contention. They are two records of the
 * same fact, kept deliberately separate — and the whole point of keeping both is
 * that they can be COMPARED. A system where they silently drift has neither an
 * audit trail nor a stock figure, it has two guesses.
 *
 * Two distinct failures are checked, and they mean different things:
 *
 *  - A BROKEN CHAIN. Each row carries `balanceAfter`, so replaying a batch's
 *    movements in order must reproduce every one of them. A row whose
 *    `balanceAfter` is not the previous balance plus its own delta means a
 *    movement was written outside the ledger, or one was lost. This is the
 *    serious one: it says the history itself is wrong.
 *
 *  - A DRIFTED BALANCE. The last `balanceAfter` disagrees with `qtyOnHand`. The
 *    history may be perfectly consistent and still not match the shelf, which
 *    is what a write that skipped the ledger looks like.
 *
 * Reported as a HEALTH CHIP rather than a log line, because the plan's own note
 * is right: a reconciliation nobody sees is a reconciliation nobody acts on.
 */

export interface Discrepancy {
  batchId: number
  batchNo: string
  brandName: string
  kind: 'chain' | 'drift'
  /** What the ledger says. */
  ledger: Qty
  /** What the batch row says. */
  shelf: Qty
  difference: Qty
  /** The movement the chain broke at, when it is a chain break. */
  at: string | null
  refId: string | null
}

export interface HealthReport {
  batchesChecked: number
  movementsChecked: number
  discrepancies: Discrepancy[]
  /** Batches with movements but no batch row at all — an orphaned history. */
  orphanedLedgers: number
  /** Batches holding stock with NO movement behind it. */
  batchesWithoutHistory: number
  balanced: boolean
  /** Value at risk where the two disagree, at landed cost. */
  valueAtRisk: Money
  generatedAt: string
}

/** Beyond this the count is the truth — nobody reads four hundred batch numbers. */
const MAX_LISTED = 25

export function reconcileStock(inputs: {
  batches: readonly Batch[]
  /** Every ledger row. Order within a batch is by `at`, then insertion id. */
  ledger: readonly StockLedgerRow[]
  medicineFor: (id: number) => Medicine | undefined
  generatedAt: string
}): HealthReport {
  const byBatch = new Map<number, StockLedgerRow[]>()
  for (const row of inputs.ledger) {
    const list = byBatch.get(row.batchId) ?? []
    list.push(row)
    byBatch.set(row.batchId, list)
  }

  const batchById = new Map(inputs.batches.map((b) => [b.id, b]))
  const discrepancies: Discrepancy[] = []
  let movements = 0
  let batchesWithoutHistory = 0
  let valueAtRisk = D.ZERO

  for (const batch of inputs.batches) {
    const rows = byBatch.get(batch.id)
    if (!rows || rows.length === 0) {
      /* Stock with no history behind it. Zero-quantity batches are ordinary —
         an emptied batch whose rows were never written is not — so only a batch
         actually HOLDING stock counts as a finding. */
      if (D.gt(D.dec(batch.qtyOnHand), D.ZERO)) batchesWithoutHistory += 1
      continue
    }

    /* Sorted by time, then by insertion id: two movements can share a
       millisecond — a sale allocating one batch twice does exactly that — and
       replaying them in the wrong order breaks a chain that is perfectly sound. */
    const ordered = [...rows].sort(
      (a, b) => a.at.localeCompare(b.at) || (a.id ?? 0) - (b.id ?? 0),
    )
    movements += ordered.length

    const medicine = inputs.medicineFor(batch.medicineId)
    let running = D.ZERO
    let broken: StockLedgerRow | null = null

    for (const row of ordered) {
      running = D.add(running, D.dec(row.qtyDelta))
      if (D.cmp(running, D.dec(row.balanceAfter)) !== 0) {
        broken = row
        break
      }
    }

    if (broken) {
      discrepancies.push({
        batchId: batch.id,
        batchNo: batch.batchNo,
        brandName: medicine?.brandName ?? `#${batch.medicineId}`,
        kind: 'chain',
        ledger: D.toStr(running, 3) as Qty,
        shelf: broken.balanceAfter as Qty,
        difference: D.toStr(D.sub(running, D.dec(broken.balanceAfter)), 3) as Qty,
        at: broken.at,
        refId: broken.refId,
      })
      valueAtRisk = D.add(
        valueAtRisk,
        D.abs(D.mul(D.sub(running, D.dec(broken.balanceAfter)), D.dec(batch.landedCostPerUnit))),
      )
      continue
    }

    const shelf = D.dec(batch.qtyOnHand)
    if (D.cmp(running, shelf) !== 0) {
      discrepancies.push({
        batchId: batch.id,
        batchNo: batch.batchNo,
        brandName: medicine?.brandName ?? `#${batch.medicineId}`,
        kind: 'drift',
        ledger: D.toStr(running, 3) as Qty,
        shelf: batch.qtyOnHand,
        difference: D.toStr(D.sub(running, shelf), 3) as Qty,
        at: ordered[ordered.length - 1]?.at ?? null,
        refId: ordered[ordered.length - 1]?.refId ?? null,
      })
      valueAtRisk = D.add(
        valueAtRisk,
        D.abs(D.mul(D.sub(running, shelf), D.dec(batch.landedCostPerUnit))),
      )
    }
  }

  /* Ledger rows pointing at a batch that no longer exists. Counted rather than
     listed: there is no batch to name, and the number is what says whether
     anything was deleted that should not have been. */
  let orphanedLedgers = 0
  for (const batchId of byBatch.keys()) {
    if (!batchById.has(batchId)) orphanedLedgers += 1
  }

  return {
    batchesChecked: inputs.batches.length,
    movementsChecked: movements,
    /* Chain breaks first: a wrong history is worse than a balance that drifted
       off a sound one, and it is the one to investigate first. */
    discrepancies: discrepancies
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'chain' ? -1 : 1)
        || Math.abs(Number(b.difference)) - Math.abs(Number(a.difference)))
      .slice(0, MAX_LISTED),
    orphanedLedgers,
    batchesWithoutHistory,
    balanced: discrepancies.length === 0 && orphanedLedgers === 0,
    valueAtRisk: D.toStr(valueAtRisk, 2) as Money,
    generatedAt: inputs.generatedAt,
  }
}

/** The one line the health chip shows. Plain words, and a real number. */
export function healthSummary(r: HealthReport): string {
  if (r.balanced) {
    return `Stock ledger balanced — ${r.batchesChecked.toLocaleString('en-IN')} batches, ${r.movementsChecked.toLocaleString('en-IN')} movements, no discrepancies`
  }
  const n = r.discrepancies.length
  const chains = r.discrepancies.filter((d) => d.kind === 'chain').length
  return chains > 0
    ? `${chains} batch${chains === 1 ? '' : 'es'} have a broken movement history`
    : `${n} batch${n === 1 ? '' : 'es'} disagree with the ledger`
}
