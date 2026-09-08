import type { Batch, IsoDate, Qty } from '@contract'
import * as D from './decimal'

export interface FefoOptions {
  /** Today, as an ISO date. Injected so allocation is testable and deterministic. */
  today: IsoDate
  /**
   * Batches expiring within this window are not auto-allocated. A strip that
   * expires in a fortnight should not be handed to a customer buying a month's
   * course; the pharmacist can still pick it deliberately with F3.
   */
  expiryGuardDays: number
}

export interface Allocation {
  batch: Batch
  qty: D.Decimal
}

export interface AllocationResult {
  allocations: Allocation[]
  /** Requested minus allocated. Non-zero drives the short-book prompt. */
  shortQty: D.Decimal
  /** True when the picked batches carry different printed MRPs. */
  mixedMrp: boolean
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

export function isExpired(batch: Batch, today: IsoDate): boolean {
  return batch.expiryDate < today
}

/** Sellable at all: has stock, is not quarantined, and has not expired. */
export function isSellable(batch: Batch, today: IsoDate): boolean {
  return (
    !batch.isQuarantined &&
    !isExpired(batch, today) &&
    D.gt(D.dec(batch.qtyOnHand), D.ZERO)
  )
}

/**
 * First-expiry-first-out ordering.
 *
 * Ties break on id so two terminals quoting the same cart get the same answer —
 * a non-deterministic order would make the batch chips jump between re-quotes.
 */
export function fefoOrder(batches: readonly Batch[], today: IsoDate): Batch[] {
  return batches
    .filter((b) => isSellable(b, today))
    .slice()
    .sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : a.expiryDate > b.expiryDate ? 1 : a.id - b.id))
}

/**
 * Allocate `requested` base units across batches, nearest expiry first.
 *
 * Batches inside the guard window are held back on the first pass and only used if
 * the sale cannot otherwise be filled — refusing to sell stock that exists is worse
 * than dispensing something short-dated, but it should never be the default.
 */
export function allocateFefo(
  batches: readonly Batch[],
  requested: D.Decimal,
  opts: FefoOptions,
): AllocationResult {
  const ordered = fefoOrder(batches, opts.today)
  const preferred = ordered.filter(
    (b) => daysBetween(opts.today, b.expiryDate) >= opts.expiryGuardDays,
  )
  const held = ordered.filter((b) => daysBetween(opts.today, b.expiryDate) < opts.expiryGuardDays)

  const allocations: Allocation[] = []
  let remaining = requested

  for (const batch of [...preferred, ...held]) {
    if (D.lte(remaining, D.ZERO)) break
    const available = D.dec(batch.qtyOnHand)
    const take = D.min(available, remaining)
    if (D.gt(take, D.ZERO)) {
      allocations.push({ batch, qty: take })
      remaining = D.sub(remaining, take)
    }
  }

  const mrps = new Set(allocations.map((a) => a.batch.mrpPerUnit))
  return {
    allocations,
    shortQty: D.max(remaining, D.ZERO),
    mixedMrp: mrps.size > 1,
  }
}

/** Honour an explicit pharmacist override exactly, capped at what each batch holds. */
export function allocateManual(
  batches: readonly Batch[],
  override: ReadonlyArray<{ batchId: number; qty: Qty }>,
  requested: D.Decimal,
): AllocationResult {
  const byId = new Map(batches.map((b) => [b.id, b]))
  const allocations: Allocation[] = []
  let taken = D.ZERO

  for (const o of override) {
    const batch = byId.get(o.batchId)
    if (!batch) continue
    const qty = D.min(D.dec(o.qty), D.dec(batch.qtyOnHand))
    if (D.gt(qty, D.ZERO)) {
      allocations.push({ batch, qty })
      taken = D.add(taken, qty)
    }
  }

  const mrps = new Set(allocations.map((a) => a.batch.mrpPerUnit))
  return {
    allocations,
    shortQty: D.max(D.sub(requested, taken), D.ZERO),
    mixedMrp: mrps.size > 1,
  }
}

export function daysToExpiry(batch: Batch, today: IsoDate): number {
  return daysBetween(today, batch.expiryDate)
}
