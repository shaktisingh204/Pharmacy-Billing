import type { Batch, Medicine } from '@contract'
import { db } from './schema'
import type { DocSeriesRow } from './schema'
import { DEMO_CUSTOMERS, DEMO_STORE, DEMO_STORE_2, buildTaxRates } from './bootstrap'

const SEED_VERSION = '13'

/** Half, floored, never below zero — a branch holds less of everything. */
function D_HALF(qty: string): string {
  const n = Math.floor(Number(qty) / 2)
  return String(Number.isFinite(n) && n > 0 ? n : 0)
}

/**
 * Populates IndexedDB on first run.
 *
 * Versioned so changing the generator refreshes the data rather than silently
 * leaving a stale catalogue behind — a half-migrated local database produces bug
 * reports that cannot be reproduced.
 */
export interface SeedResult {
  seeded: boolean
  medicines: number
  batches: number
  invoices: number
}

export async function ensureSeeded(now: Date): Promise<SeedResult> {
  const current = await db.meta.get('seedVersion')
  if (current?.value === SEED_VERSION) {
    return {
      seeded: false,
      medicines: await db.medicines.count(),
      batches: await db.batches.count(),
      invoices: await db.invoices.count(),
    }
  }

  // Loaded on demand: the demo catalogue is ~1MB of literals and is needed once,
  // on a cold database. Bundling it into the entry chunk would delay first paint
  // on every subsequent boot for no benefit.
  const { SEED_MEDICINES, generateBatches } = await import('../../../seed/medicines')

  await Promise.all([
    db.stores.clear(), db.medicines.clear(), db.barcodes.clear(), db.batches.clear(),
    db.customers.clear(), db.taxRates.clear(), db.invoices.clear(), db.ledger.clear(),
    db.docSeries.clear(), db.heldBills.clear(), db.shortbook.clear(), db.idempotency.clear(),
  ])

  await db.stores.bulkPut([DEMO_STORE, DEMO_STORE_2])
  // Derived from the catalogue, so a code can never exist without a rate.
  await db.taxRates.bulkAdd(buildTaxRates(SEED_MEDICINES.map((m) => m.hsnCode)))
  await db.customers.bulkAdd(DEMO_CUSTOMERS as unknown as Parameters<typeof db.customers.bulkAdd>[0])

  const medicines: Medicine[] = SEED_MEDICINES.map((m, i) => ({
    ...m,
    id: i + 1,
    storeId: DEMO_STORE.id,
    isActive: true,
  }))
  await db.medicines.bulkAdd(medicines)

  const barcodeRows = SEED_MEDICINES.flatMap((m, i) =>
    m.barcodes.map((barcode) => ({
      medicineId: i + 1,
      barcode,
      symbology: barcode.length === 13 ? 'ean13' : 'internal',
    })),
  )
  if (barcodeRows.length) await db.barcodes.bulkAdd(barcodeRows)

  const withIds = SEED_MEDICINES.map((m, i) => ({ ...m, id: i + 1 }))
  const batches: Batch[] = generateBatches(withIds, now).map((b, i) => ({
    ...b,
    id: i + 1,
    storeId: DEMO_STORE.id,
  }))

  /*
   * The branch gets its OWN batches, from a slice of the same catalogue.
   *
   * A quarter of the range, at different quantities: a branch is a smaller shop
   * with a narrower shelf, and making the two identical would let a store filter
   * be broken without anything looking wrong. The batch NUMBERS differ too —
   * `KT-` prefixed — so a batch on screen says which branch it belongs to even
   * when somebody is looking at it out of context.
   */
  const branchBatches: Batch[] = batches
    .filter((_, i) => i % 4 === 0)
    .map((b, i) => ({
      ...b,
      id: batches.length + i + 1,
      storeId: DEMO_STORE_2.id,
      batchNo: `KT-${b.batchNo}`,
      qtyOnHand: D_HALF(b.qtyOnHand),
    }))

  await db.batches.bulkAdd([...batches, ...branchBatches])

  /*
   * Seeded INLINE, not in the background.
   *
   * Backgrounding this to speed up first paint looked like a free win and was
   * not: the seed holds the invoices and ledger tables for several seconds, and a
   * sale posted during that window contends with it for the same Dexie
   * transaction scope and stalls indefinitely. The three test contexts that
   * booted FASTEST were the ones that hung, which is the signature of a race
   * rather than of slowness.
   *
   * Seeding is a development-only cost paid once per browser profile. A sale that
   * silently never completes is not worth two seconds of boot.
   */
  const invoices = await seedHistory(medicines, batches, now)

  return {
    seeded: true,
    medicines: medicines.length,
    batches: batches.length + branchBatches.length,
    invoices,
  }
}

/**
 * Four hundred days of priced, posted bills.
 *
 * The generator plans the sales FIRST and derives an opening quantity of
 * (authored + sold), so replaying forward lands the closing balance back on
 * exactly the stock the catalogue authored. Three things stay true at once:
 * current stock matches the catalogue, the ledger reconciles to it, and every
 * invoice was produced by the same computeQuote the POS uses — not decorated
 * with plausible-looking numbers.
 */
async function seedHistory(
  medicines: Medicine[],
  batches: Batch[],
  now: Date,
): Promise<number> {
  const { generateSalesHistory } = await import('../../../seed/sales')
  const [customers, taxRates] = await Promise.all([
    db.customers.toArray(),
    db.taxRates.toArray(),
  ])

  const history = generateSalesHistory({
    medicines,
    batches,
    taxRates,
    store: DEMO_STORE,
    customers: customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone })),
    today: now,
    /*
     * Six months, not thirteen.
     *
     * Thirteen months put ~19,000 invoices and ~54MB into IndexedDB, and every
     * Playwright context seeds its own copy — six of those in parallel made the
     * whole app slow enough that unrelated POS tests timed out. Six months is
     * still half a year of trend, every month populated, at under a third of the
     * weight. The chart renders the months that have data rather than padding a
     * fixed twelve with empties.
     */
    days: 180,
  })

  /*
   * Advance the counter BEFORE the bulk inserts.
   *
   * doc_series is what the POS reads when it allocates the next invoice number.
   * Left at 1, the first real sale asks for RX2627-T1-00001 — which the history
   * also uses — and the unique index on invoiceNo rejects one of them.
   *
   * Writing it first rather than last is what lets a sale post DURING seeding:
   * the generator is deterministic and already knows every number it will use, so
   * the counter can be correct long before the rows land. The alternative — making
   * postSale wait for the whole history — cost the first sale after a cold boot
   * nine seconds to avoid a collision that was already knowable.
   */
  const highest = new Map<string, { row: DocSeriesRow; seq: number }>()
  for (const inv of history.invoices) {
    const parts = inv.invoiceNo.split('-')
    const head = parts[0]
    const seqText = parts[2]
    if (!head || !seqText || parts.length !== 3) continue
    const fy = head.slice(DEMO_STORE.invoicePrefix.length)
    const key = `${inv.storeId}:${fy}:${inv.terminalId}:SALE`
    const seq = Number(seqText)
    const seen = highest.get(key)
    if (!seen || seq > seen.seq) {
      highest.set(key, {
        seq,
        row: {
          key,
          storeId: inv.storeId,
          financialYear: fy,
          terminalId: inv.terminalId,
          docType: 'SALE',
          prefix: DEMO_STORE.invoicePrefix,
          nextNumber: seq + 1,
        },
      })
    }
  }
  await db.docSeries.bulkPut([...highest.values()].map((v) => v.row))

  // Opening stock is a real ledger movement, not an invisible starting value.
  await db.ledger.bulkAdd(
    batches.map((b) => {
      const opening = history.openingQty.get(b.id) ?? b.qtyOnHand
      return {
        storeId: DEMO_STORE.id,
        batchId: b.id,
        medicineId: b.medicineId,
        at: history.invoices[0]?.createdAt ?? now.toISOString(),
        qtyDelta: opening,
        balanceAfter: opening,
        reason: 'OPENING' as const,
        refType: 'SEED',
        refId: SEED_VERSION,
      }
    }),
  )

  await db.invoices.bulkAdd(history.invoices)
  await db.ledger.bulkAdd(
    history.movements.map((m) => ({
      storeId: DEMO_STORE.id,
      batchId: m.batchId,
      medicineId: m.medicineId,
      at: m.at,
      qtyDelta: m.qtyDelta,
      balanceAfter: m.balanceAfter,
      reason: 'SALE' as const,
      refType: 'SALE_INVOICE',
      refId: SEED_VERSION,
    })),
  )

  await db.meta.put({ key: 'seedVersion', value: SEED_VERSION })
  return history.invoices.length
}
