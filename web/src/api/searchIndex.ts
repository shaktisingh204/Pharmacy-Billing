import type { Batch, Medicine, MedicineSearchHit } from '@contract'
import * as D from '@/domain/decimal'
import { fefoOrder, isSellable } from '@/domain/fefo'

/**
 * Warm in-memory search over the whole catalogue.
 *
 * The most-cited complaint about incumbent pharmacy software is that billing is
 * slow, and almost all of that is search latency. Going to storage per keystroke
 * cannot hit the sub-100ms budget on a counter PC, so the catalogue is normalised
 * once at startup and every keystroke is a scan over primitive arrays.
 *
 * Ranking is by MATCH QUALITY first and then by `saleRank` — the last-90-days
 * dispense count. That ordering beats any similarity score here: a pharmacist
 * typing "do" wants Dolo 650, not Dobutamine, and the shop's own history is the
 * only signal that knows which.
 */

interface IndexRow {
  medicine: Medicine
  brand: string
  generic: string
  composition: string
  manufacturer: string
  /** brand with spaces and punctuation stripped, so "montek lc" matches "MontekLC". */
  brandSquashed: string
}

const normalise = (s: string): string => s.toLowerCase().trim()
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Match quality, highest first. The gap to `saleRank` must be large enough that a
 *  brand-prefix hit always outranks a popular composition-only hit. */
const RANK = {
  barcode: 1_000_000,
  brandPrefix: 100_000,
  brandWordPrefix: 60_000,
  brandContains: 30_000,
  genericPrefix: 20_000,
  compositionContains: 8_000,
  manufacturerContains: 2_000,
} as const

export class SearchIndex {
  private rows: IndexRow[] = []
  private byId = new Map<number, IndexRow>()
  private barcodeToId = new Map<string, number>()
  private batchesByMedicine = new Map<number, Batch[]>()

  load(medicines: readonly Medicine[], batches: readonly Batch[], barcodes: ReadonlyMap<string, number>) {
    this.rows = medicines.filter((m) => m.isActive).map((m) => ({
      medicine: m,
      brand: normalise(m.brandName),
      generic: normalise(m.genericName ?? ''),
      composition: normalise(m.compositionText),
      manufacturer: normalise(m.manufacturer),
      brandSquashed: squash(m.brandName),
    }))
    this.byId = new Map(this.rows.map((r) => [r.medicine.id, r]))
    this.barcodeToId = new Map(barcodes)

    this.batchesByMedicine = new Map()
    for (const b of batches) {
      const list = this.batchesByMedicine.get(b.medicineId)
      if (list) list.push(b)
      else this.batchesByMedicine.set(b.medicineId, [b])
    }
  }

  /**
   * Patch the batches a sale touched, in place.
   *
   * A sale changes the quantity on a handful of batches. Re-reading the whole
   * catalogue to learn that costs a full IndexedDB scan on the one code path the
   * operator is actually waiting on — and it scales with the catalogue rather
   * than with the bill.
   */
  updateBatches(changed: readonly Batch[]): void {
    for (const next of changed) {
      const list = this.batchesByMedicine.get(next.medicineId)
      if (!list) continue
      const i = list.findIndex((b) => b.id === next.id)
      if (i >= 0) list[i] = next
      else list.push(next)
    }
  }

  batchesFor(medicineId: number): Batch[] {
    return this.batchesByMedicine.get(medicineId) ?? []
  }

  allBatches(): ReadonlyMap<number, Batch[]> {
    return this.batchesByMedicine
  }

  medicines(): ReadonlyMap<number, Medicine> {
    const m = new Map<number, Medicine>()
    for (const r of this.rows) m.set(r.medicine.id, r.medicine)
    return m
  }

  byBarcode(code: string, today: string): MedicineSearchHit | null {
    const id = this.barcodeToId.get(code)
    if (id === undefined) return null
    const row = this.byId.get(id)
    return row ? this.toHit(row, 'barcode', today) : null
  }

  search(term: string, today: string, limit = 8, includeOutOfStock = true): MedicineSearchHit[] {
    const q = normalise(term)
    if (q.length === 0) return []

    // A pure-digit query is almost always a scan or a hand-keyed barcode.
    const exactBarcode = this.byBarcode(term.trim(), today)
    const qSquashed = squash(q)
    const scored: Array<{ row: IndexRow; score: number; matchedOn: MedicineSearchHit['matchedOn'] }> = []

    for (const row of this.rows) {
      let score = 0
      let matchedOn: MedicineSearchHit['matchedOn'] = 'brand'

      if (row.brand.startsWith(q) || row.brandSquashed.startsWith(qSquashed)) {
        score = RANK.brandPrefix
      } else if (wordPrefix(row.brand, q)) {
        score = RANK.brandWordPrefix
      } else if (row.brand.includes(q)) {
        score = RANK.brandContains
      } else if (row.generic.startsWith(q)) {
        score = RANK.genericPrefix
        matchedOn = 'generic'
      } else if (row.composition.includes(q)) {
        score = RANK.compositionContains
        matchedOn = 'composition'
      } else if (row.manufacturer.includes(q)) {
        score = RANK.manufacturerContains
        matchedOn = 'manufacturer'
      }

      if (score > 0) {
        // saleRank is additive rather than multiplicative so it orders WITHIN a
        // match tier and can never promote a weak match over a strong one.
        scored.push({ row, score: score + Math.min(row.medicine.saleRank, 9_999), matchedOn })
      }
    }

    scored.sort((a, b) => b.score - a.score || a.row.brand.localeCompare(b.row.brand))

    const hits: MedicineSearchHit[] = []
    if (exactBarcode) hits.push(exactBarcode)

    // In-stock first. The caller renders a "Not in stock" divider before the rest —
    // an out-of-stock hit is still useful (it drives the short book) but must never
    // sit above something that can actually be dispensed.
    const inStock: MedicineSearchHit[] = []
    const outOfStock: MedicineSearchHit[] = []
    for (const s of scored) {
      if (s.row.medicine.id === exactBarcode?.medicine.id) continue
      const hit = this.toHit(s.row, s.matchedOn, today)
      if (hit.outOfStock) {
        if (includeOutOfStock && outOfStock.length < limit) outOfStock.push(hit)
      } else if (inStock.length < limit) {
        inStock.push(hit)
      }
      if (inStock.length >= limit && (!includeOutOfStock || outOfStock.length >= limit)) break
    }

    return [...hits, ...inStock, ...outOfStock].slice(0, limit * 2)
  }

  private toHit(row: IndexRow, matchedOn: MedicineSearchHit['matchedOn'], today: string): MedicineSearchHit {
    const batches = this.batchesFor(row.medicine.id)
    const sellable = batches.filter((b) => isSellable(b, today))
    const stock = D.sum(sellable.map((b) => D.dec(b.qtyOnHand)))
    const ordered = fefoOrder(batches, today)
    return {
      medicine: row.medicine,
      stockQty: D.toStr(stock, 0),
      fefoBatch: ordered[0] ?? null,
      batchCount: sellable.length,
      matchedOn,
      outOfStock: sellable.length === 0,
    }
  }
}

/** "lc" matches "Montek LC" but not "Calcium". */
function wordPrefix(haystack: string, q: string): boolean {
  let i = haystack.indexOf(q)
  while (i > 0) {
    const prev = haystack[i - 1]
    if (prev === ' ' || prev === '-' || prev === '/') return true
    i = haystack.indexOf(q, i + 1)
  }
  return false
}
