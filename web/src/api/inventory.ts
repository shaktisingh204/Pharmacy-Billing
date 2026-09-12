import type {
  Batch, BatchRow, InventoryFilters, InventorySummary, IsoDate, LedgerReason, Medicine, Money,
  Qty, ShortbookEntry, StockAdjustmentInput, StockMovement,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { daysToExpiry, isExpired, isSellable } from '@/domain/fefo'
import { expiryBucket } from '@/lib/expiry'
import type { ExpiryBucket } from '@/lib/expiry'

/**
 * Batch-wise stock, as pure value logic.
 *
 * Same split as `./medicines`: every rule the inventory screen leans on — what a
 * bucket filter means, what "low" is for a batch, which numbers make the ledger
 * self-checking — lives here as a function over arrays, and `localAdapter` only
 * feeds it from the warm index and Dexie. Rules reachable only through IndexedDB
 * get tested once and then trusted forever; these get tested every run, and the
 * Phase-5 Rust server gets a readable specification of the same arithmetic.
 *
 * Nothing below re-derives an expiry boundary or does arithmetic on a money
 * string: `@/lib/expiry` owns the bucket edges, `@/domain/fefo` decides what is
 * sellable, `@/domain/decimal` does the sums.
 */

const money = (d: D.Decimal): Money => D.toStr(d, 2)
const qty = (d: D.Decimal): Qty => D.toStr(d, 3)

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ')

// -------------------------------------------------------------- identity ---

/**
 * The batch number as it participates in IDENTITY (invariant I7).
 *
 * A distributor prints "AB-2214", keys it as "ab-2214" on the next bill, and
 * pastes " AB - 2214 " on the one after that. Those are one batch of one physical
 * medicine, and treating them as three splits the stock of a recalled lot across
 * rows nobody can find. Case and whitespace are therefore not part of the
 * identity; the hyphen IS, because it can be a real separator in a lot code and
 * dropping it would merge two genuinely different lots — which is also why
 * "ab 2214" is deliberately NOT the same lot as "AB-2214".
 */
export function normaliseBatchNo(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase()
}

/**
 * (store, medicine, normalised batch no, expiry, MRP) — invariant I7.
 *
 * MRP is in the key because the same printed batch number legitimately arrives
 * at a revised MRP, and the customer pays what is printed on the strip in their
 * hand. Merging the two would sell the older stock at the newer price.
 */
export function batchIdentityKey(parts: {
  storeId: number
  medicineId: number
  batchNo: string
  expiryDate: IsoDate
  mrpPerPack: Money
}): string {
  return [
    parts.storeId,
    parts.medicineId,
    normaliseBatchNo(parts.batchNo),
    parts.expiryDate,
    // Through the decimal so "100.5" and "100.50" are one MRP rather than two.
    D.toStr(D.dec(parts.mrpPerPack), 2),
  ].join('|')
}

// ------------------------------------------------------------------ rows ---

export interface InventoryCatalogue {
  /** EVERY batch, expired and quarantined included — this screen is where they
   *  are found and written off, so filtering them out upstream hides the work. */
  batches: readonly Batch[]
  medicineFor: (medicineId: number) => Medicine | undefined
  today: IsoDate
}

/** Local midnight of the given day, so `daysUntil` measures whole calendar days. */
const asOf = (today: IsoDate): Date => new Date(`${today}T00:00:00`)

/**
 * One batch row, valued as it stands.
 *
 * Unlike a catalogue row, an expired or quarantined batch is still valued here:
 * the write-off queue needs to say how much money is sitting in it, and that
 * number is exactly what the medicine master leaves out.
 */
export function buildBatchRow(batch: Batch, medicine: Medicine, today: IsoDate): BatchRow {
  const onHand = D.dec(batch.qtyOnHand)
  return {
    batch,
    medicine,
    daysToExpiry: daysToExpiry(batch, today),
    bucket: expiryBucket(batch.expiryDate, asOf(today)),
    valueAtMrp: money(D.mul(onHand, D.dec(batch.mrpPerUnit))),
    valueAtCost: money(D.mul(onHand, D.dec(batch.landedCostPerUnit))),
  }
}

/**
 * Sellable base units per medicine.
 *
 * "Low" and "out" are properties of the SHELF, not of one batch: a batch holding
 * four strips is neither low nor healthy on its own, and the answer changes with
 * whatever else is behind it.
 */
export function sellableByMedicine(batches: readonly Batch[], today: IsoDate): Map<number, D.Decimal> {
  const out = new Map<number, D.Decimal>()
  for (const b of batches) {
    if (!isSellable(b, today)) continue
    out.set(b.medicineId, D.add(out.get(b.medicineId) ?? D.ZERO, D.dec(b.qtyOnHand)))
  }
  return out
}

interface BatchFacts {
  row: BatchRow
  onHand: D.Decimal
  cost: D.Decimal
  /** Sellable stock of the whole medicine, for the low/out filters. */
  shelf: D.Decimal
  haystack: string
}

// --------------------------------------------------------------- filters ---

type BucketFilter = NonNullable<InventoryFilters['bucket']>
type StockFilter = NonNullable<InventoryFilters['stock']>
type SortKey = NonNullable<InventoryFilters['sort']>

/**
 * `expiryBucket` returns DISJOINT bands; a filter is a WINDOW.
 *
 * A batch twenty days out is in band d30, and an operator filtering "≤90 days"
 * must still see it — asking for a window and being shown a band is how a screen
 * loses the trust of the person reading it. Expressing the window as "this band
 * or an earlier one" keeps the boundaries in `@/lib/expiry` where they belong
 * instead of re-deriving 30/60/90/180 here.
 */
const BUCKET_ORDER: readonly ExpiryBucket[] = ['expired', 'd30', 'd60', 'd90', 'd180', 'ok']

const bucketRank = (b: ExpiryBucket): number => BUCKET_ORDER.indexOf(b)

function matchesBucket(bucket: ExpiryBucket, filter: BucketFilter): boolean {
  if (filter === 'all') return true
  // Expired stock is its own queue. It is not "within 30 days"; it is a
  // write-off, and mixing the two makes the near-expiry list unactionable.
  if (filter === 'expired') return bucket === 'expired'
  return bucket !== 'expired' && bucketRank(bucket) <= bucketRank(filter)
}

function matchesStock(f: BatchFacts, mode: StockFilter): boolean {
  if (mode === 'quarantined') return f.row.batch.isQuarantined
  const shelfHasStock = D.gt(f.shelf, D.ZERO)
  // At or below the trigger but NOT empty; zero belongs to the out-of-stock
  // queue, which is a different conversation with the distributor.
  if (mode === 'low') return shelfHasStock && D.lte(f.shelf, D.dec(f.row.medicine.reorderLevel))
  if (mode === 'out') return !shelfHasStock
  return true
}

interface Query {
  term: string
  bucket: BucketFilter
  stock: StockFilter
  manufacturer: string
}

function matches(f: BatchFacts, q: Query): boolean {
  if (q.term && !f.haystack.includes(q.term)) return false
  if (q.manufacturer && collapse(f.row.medicine.manufacturer).toLowerCase() !== q.manufacturer) return false
  if (!matchesBucket(f.row.bucket, q.bucket)) return false
  return matchesStock(f, q.stock)
}

function compare(sort: SortKey, a: BatchFacts, b: BatchFacts): number {
  const primary =
    sort === 'value' ? D.cmp(b.cost, a.cost)
      : sort === 'qty' ? D.cmp(b.onHand, a.onHand)
        : sort === 'name' ? a.row.medicine.brandName.localeCompare(b.row.medicine.brandName)
          // Soonest expiry first: the default, and the reason this screen exists.
          : a.row.batch.expiryDate.localeCompare(b.row.batch.expiryDate)
  // Ties break on batch id, without exception — a page boundary inside a tie
  // under an unstable order repeats one row and silently drops another.
  return primary || a.row.batch.id - b.row.batch.id
}

// ---------------------------------------------------------------- paging ---

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function clampCursor(cursor: number | undefined, total: number): number {
  if (cursor === undefined || !Number.isFinite(cursor) || cursor <= 0) return 0
  return Math.min(Math.floor(cursor), total)
}

export interface BatchPage {
  rows: BatchRow[]
  total: number
  nextCursor: number | null
}

/**
 * The inventory grid's one query.
 *
 * The cursor is an OFFSET into a single total ordering, exactly as in
 * `buildMedicinePage`: every comparator ends in a tie-break on batch id, so
 * consecutive pages concatenate to precisely the filtered set.
 */
export function buildBatchPage(cat: InventoryCatalogue, filters: InventoryFilters): BatchPage {
  const shelf = sellableByMedicine(cat.batches, cat.today)
  const q: Query = {
    term: collapse(filters.term ?? '').toLowerCase(),
    bucket: filters.bucket ?? 'all',
    stock: filters.stock ?? 'all',
    manufacturer: collapse(filters.manufacturer ?? '').toLowerCase(),
  }

  const matching = cat.batches
    .flatMap<BatchFacts>((batch) => {
      const medicine = cat.medicineFor(batch.medicineId)
      // A batch whose medicine has vanished cannot be rendered: half its columns
      // come off the master. It is a data fault, not a row to hide, so it is
      // dropped HERE and counted by `buildInventorySummary` as a discrepancy —
      // otherwise its value would sit in the tiles above a grid that cannot show
      // it, and nothing on the screen would ever say so.
      if (!medicine) return []
      const row = buildBatchRow(batch, medicine, cat.today)
      return [{
        row,
        onHand: D.dec(batch.qtyOnHand),
        cost: D.dec(row.valueAtCost),
        shelf: shelf.get(batch.medicineId) ?? D.ZERO,
        haystack: [
          medicine.brandName,
          medicine.genericName ?? '',
          medicine.compositionText,
          medicine.manufacturer,
          medicine.hsnCode,
          // Searchable because a recall notice names a batch number and nothing
          // else, and that is the one moment this screen has to answer fast.
          batch.batchNo,
        ].join(' ').toLowerCase(),
      }]
    })
    .filter((f) => matches(f, q))
    .sort((a, b) => compare(filters.sort ?? 'expiry', a, b))

  const start = clampCursor(filters.cursor, matching.length)
  const page = matching.slice(start, start + clampLimit(filters.limit))
  const next = start + page.length

  return {
    rows: page.map((f) => f.row),
    total: matching.length,
    nextCursor: next < matching.length ? next : null,
  }
}

// --------------------------------------------------------------- summary ---

/** The only ledger columns reconciliation needs. */
export interface LedgerBalanceRow {
  id?: number
  batchId: number
  at: string
  balanceAfter: Qty
}

/**
 * The last `balanceAfter` the ledger recorded for each batch.
 *
 * Ordered by (at, id) rather than by insertion: two movements can share a
 * timestamp to the millisecond — a multi-line goods receipt does exactly that —
 * and the id then decides which one came last.
 */
export function lastLedgerBalances(rows: readonly LedgerBalanceRow[]): Map<number, D.Decimal> {
  const latest = new Map<number, LedgerBalanceRow>()
  for (const row of rows) {
    const seen = latest.get(row.batchId)
    if (!seen || row.at > seen.at || (row.at === seen.at && (row.id ?? 0) >= (seen.id ?? 0))) {
      latest.set(row.batchId, row)
    }
  }
  const out = new Map<number, D.Decimal>()
  for (const [batchId, row] of latest) out.set(batchId, D.dec(row.balanceAfter))
  return out
}

export interface InventorySummaryDeps {
  batches: readonly Batch[]
  /**
   * The WHOLE catalogue, delisted rows included. Out-of-stock SKUs have no batch
   * to be counted from, and a batch whose medicine is missing from this list is
   * read as orphaned — so handing this a filtered list reports every batch as a
   * discrepancy, which is the correct answer to "these are all the medicines".
   */
  medicines: readonly Medicine[]
  ledger: readonly LedgerBalanceRow[]
  today: IsoDate
  /** `stores.nearExpiryBuckets`, in any order. */
  nearExpiryBuckets: readonly number[]
}

/**
 * The numbers above the grid.
 *
 * `reconciliationDiscrepancies` is the one that earns the ledger its keep: if
 * `qtyOnHand` and the ledger's last `balanceAfter` ever disagree, stock moved
 * without a movement row and every valuation below is fiction. It is counted on
 * every summary rather than nightly, because a number nobody looks at is not a
 * control (invariant I17).
 */
export function buildInventorySummary(deps: InventorySummaryDeps): InventorySummary {
  const balances = lastLedgerBalances(deps.ledger)
  const shelf = sellableByMedicine(deps.batches, deps.today)
  const catalogued = new Set(deps.medicines.map((m) => m.id))

  let totalBatches = 0
  let valueAtCost = D.ZERO
  let valueAtMrp = D.ZERO
  let quarantinedBatches = 0
  let discrepancies = 0
  const skus = new Set<number>()

  for (const b of deps.batches) {
    const onHand = D.dec(b.qtyOnHand)
    // Two faults, one alarm, because the operator's next move is the same for
    // both: stop trusting these numbers and go and look.
    //
    //  - A batch with no ledger row at all is not "in balance at zero": stock
    //    that appeared without a movement is exactly what this count exists for.
    //  - A batch whose medicine is not in the catalogue is dropped by
    //    `buildBatchPage`, so its value would otherwise sit in the tiles above a
    //    grid that never shows it, and no screen would ever mention it.
    const orphaned = !catalogued.has(b.medicineId)
    if (orphaned || !D.eq(onHand, balances.get(b.id) ?? D.ZERO)) discrepancies += 1
    if (b.isQuarantined) quarantinedBatches += 1
    // An emptied batch is history, not inventory. It stays on file for the
    // ledger to point at, but counting it would make "batches" drift upward
    // forever and stop meaning anything about the shelf.
    if (!D.gt(onHand, D.ZERO)) continue
    totalBatches += 1
    skus.add(b.medicineId)
    valueAtCost = D.add(valueAtCost, D.mul(onHand, D.dec(b.landedCostPerUnit)))
    valueAtMrp = D.add(valueAtMrp, D.mul(onHand, D.dec(b.mrpPerUnit)))
  }

  let lowStockSkus = 0
  let outOfStockSkus = 0
  for (const m of deps.medicines) {
    // A delisted medicine has no reorder queue to be in; telling the counter to
    // buy more of something the shop has stopped selling is worse than silence.
    if (!m.isActive) continue
    const onHand = shelf.get(m.id) ?? D.ZERO
    if (D.isZero(onHand)) outOfStockSkus += 1
    else if (D.lte(onHand, D.dec(m.reorderLevel))) lowStockSkus += 1
  }

  return {
    totalBatches,
    totalSkus: skus.size,
    stockValueAtCost: money(valueAtCost),
    stockValueAtMrp: money(valueAtMrp),
    atRisk: atRiskBuckets(deps),
    lowStockSkus,
    outOfStockSkus,
    quarantinedBatches,
    reconciliationDiscrepancies: discrepancies,
  }
}

/**
 * Value inside each configured near-expiry window.
 *
 * The windows are the STORE's (`nearExpiryBuckets`), and they NEST: ≤90 days
 * contains ≤60, which contains ≤30. That is deliberate — each tile answers "how
 * much expires within N days", which is the question that gets asked, and it
 * matches what the grid shows when the matching bucket filter is applied. A
 * consumer must therefore render these as tiles, never stack them.
 */
function atRiskBuckets(deps: InventorySummaryDeps): InventorySummary['atRisk'] {
  const windows = [...new Set(deps.nearExpiryBuckets.filter((d) => Number.isFinite(d) && d > 0))]
    .sort((a, b) => a - b)

  return windows.map((days) => {
    let batches = 0
    let value = D.ZERO
    for (const b of deps.batches) {
      const onHand = D.dec(b.qtyOnHand)
      if (!D.gt(onHand, D.ZERO)) continue
      // Expired stock is not "at risk"; it is already lost, and it has its own
      // filter. Folding it in here would hide the deadline that can still be met.
      if (isExpired(b, deps.today) || daysToExpiry(b, deps.today) > days) continue
      batches += 1
      value = D.add(value, D.mul(onHand, D.dec(b.landedCostPerUnit)))
    }
    return { bucket: `d${days}`, days, batches, valueAtCost: money(value) }
  })
}

// ------------------------------------------------------------- movements ---

export interface MovementRow {
  id?: number
  batchId: number
  medicineId: number
  at: string
  qtyDelta: Qty
  balanceAfter: Qty
  reason: LedgerReason
  refType: string
  refId: string
  note?: string | null
}

/**
 * Ledger rows joined to the names a human needs, newest first.
 *
 * A batch or medicine that has since been deleted does not remove the movement:
 * the ledger is append-only and has to stay readable, so the id is rendered
 * rather than the row being dropped.
 */
export function toStockMovements(
  rows: readonly MovementRow[],
  batchFor: (id: number) => Batch | undefined,
  medicineFor: (id: number) => Medicine | undefined,
  limit: number,
): StockMovement[] {
  return rows
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.id ?? 0) - (a.id ?? 0)))
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      id: row.id ?? 0,
      at: row.at,
      batchId: row.batchId,
      batchNo: batchFor(row.batchId)?.batchNo ?? `#${row.batchId}`,
      medicineId: row.medicineId,
      brandName: medicineFor(row.medicineId)?.brandName ?? `#${row.medicineId}`,
      qtyDelta: row.qtyDelta,
      balanceAfter: row.balanceAfter,
      reason: row.reason,
      refType: row.refType,
      refId: row.refId,
      note: row.note ?? null,
    }))
}

// ------------------------------------------------------------ adjustment ---

export interface PreparedAdjustment {
  qtyDelta: D.Decimal
  balanceAfter: D.Decimal
  reason: Extract<LedgerReason, 'ADJUSTMENT' | 'EXPIRY_WRITEOFF'>
  note: string
}

function invalid(field: string, message: string): ApiError {
  return new ApiError({ code: 'ADJUSTMENT_INVALID', message, details: { field } })
}

/**
 * Check a manual stock correction before it touches anything.
 *
 * The note is mandatory because an unexplained adjustment is indistinguishable
 * from shrinkage: the row it writes is the only record of why the count moved,
 * and "someone fixed it" is not an audit trail. The floor at zero is the same
 * invariant the conditional decrement enforces on the sale path (I14) — stock
 * that does not exist cannot be written off twice.
 */
export function prepareAdjustment(batch: Batch, input: StockAdjustmentInput): PreparedAdjustment {
  const note = collapse(input.note ?? '')
  if (!note) throw invalid('note', 'Say why the count is being corrected')

  // Guarded even though the type says so: this is what keeps SALE and PURCHASE
  // out of the ledger through a path with no document behind it, which would
  // make the reason code — the only thing explaining a movement — a guess.
  if (input.reason !== 'ADJUSTMENT' && input.reason !== 'EXPIRY_WRITEOFF') {
    throw invalid('reason', 'A manual correction is an adjustment or an expiry write-off')
  }

  let qtyDelta: D.Decimal
  try {
    qtyDelta = D.dec(input.qtyDelta)
  } catch {
    throw invalid('qtyDelta', 'Enter a quantity like 12 or -0.5')
  }
  if (D.isZero(qtyDelta)) throw invalid('qtyDelta', 'An adjustment of zero changes nothing')

  // A write-off that ADDS stock is a mis-keyed sign, and it would put expired
  // goods back on the shelf under a reason code that says they were destroyed.
  if (input.reason === 'EXPIRY_WRITEOFF' && !D.isNeg(qtyDelta)) {
    throw invalid('qtyDelta', 'An expiry write-off removes stock, so the quantity is negative')
  }

  const balanceAfter = D.add(D.dec(batch.qtyOnHand), qtyDelta)
  if (D.isNeg(balanceAfter)) {
    throw new ApiError({
      code: 'STOCK_INSUFFICIENT',
      // The stored string, not a rounded one: an operator reconciling a count
      // against a shelf needs the exact figure the refusal was measured against.
      message: `Batch ${batch.batchNo} holds ${batch.qtyOnHand} — it cannot go negative`,
      details: { batchId: batch.id, qtyOnHand: batch.qtyOnHand },
    })
  }
  return { qtyDelta, balanceAfter, reason: input.reason, note }
}

/** The batch as it stands after an accepted adjustment. Quantity only: an
 *  adjustment corrects a COUNT and must never silently reprice the stock. */
export function applyAdjustment(batch: Batch, prepared: PreparedAdjustment): Batch {
  return { ...batch, qtyOnHand: qty(prepared.balanceAfter) }
}

// ------------------------------------------------------------- shortbook ---

export interface ShortbookSource {
  rows: ReadonlyArray<{ id?: number; medicineId: number | null; term: string; qty: Qty; at: string }>
  medicineFor: (medicineId: number) => Medicine | undefined
  batchesFor: (medicineId: number) => readonly Batch[]
  today: IsoDate
}

/**
 * The short book, newest first, each row carrying what is on the shelf NOW.
 *
 * The live stock is the whole point of the join: a request logged on Tuesday for
 * something that arrived on Wednesday is noise, and a short book nobody trims
 * stops being read. The row is still returned — deciding it is stale is the
 * screen's call, not this function's.
 */
export function buildShortbookEntries(src: ShortbookSource): ShortbookEntry[] {
  return src.rows
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.id ?? 0) - (a.id ?? 0)))
    .map((row) => {
      const medicine = row.medicineId === null ? undefined : src.medicineFor(row.medicineId)
      const stock = medicine
        ? D.sum(
            src.batchesFor(medicine.id)
              .filter((b) => isSellable(b, src.today))
              .map((b) => D.dec(b.qtyOnHand)),
          )
        : null
      return {
        id: row.id ?? 0,
        medicineId: row.medicineId,
        term: row.term,
        qty: row.qty,
        at: row.at,
        brandName: medicine?.brandName ?? null,
        stockQty: stock === null ? null : qty(stock),
      }
    })
}
