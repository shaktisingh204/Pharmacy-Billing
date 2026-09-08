import type { Batch, Medicine } from '@contract'
import { db } from './schema'
import { DEMO_CUSTOMERS, DEMO_STORE, buildTaxRates } from './bootstrap'

const SEED_VERSION = '5'

/**
 * Populates IndexedDB on first run.
 *
 * Versioned so changing the generator refreshes the data rather than silently
 * leaving a stale catalogue behind — a half-migrated local database produces bug
 * reports that cannot be reproduced.
 */
export async function ensureSeeded(now: Date): Promise<{ seeded: boolean; medicines: number; batches: number }> {
  const current = await db.meta.get('seedVersion')
  if (current?.value === SEED_VERSION) {
    return { seeded: false, medicines: await db.medicines.count(), batches: await db.batches.count() }
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

  await db.stores.put(DEMO_STORE)
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
  await db.batches.bulkAdd(batches)

  // Opening stock is a real ledger movement, not an invisible starting value:
  // the ledger must reconcile to qtyOnHand from the very first row.
  await db.ledger.bulkAdd(
    batches.map((b) => ({
      storeId: DEMO_STORE.id,
      batchId: b.id,
      medicineId: b.medicineId,
      at: now.toISOString(),
      qtyDelta: b.qtyOnHand,
      balanceAfter: b.qtyOnHand,
      reason: 'OPENING' as const,
      refType: 'SEED',
      refId: SEED_VERSION,
    })),
  )

  await db.meta.put({ key: 'seedVersion', value: SEED_VERSION })
  return { seeded: true, medicines: medicines.length, batches: batches.length }
}
