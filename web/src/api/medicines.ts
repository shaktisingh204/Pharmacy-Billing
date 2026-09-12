import type {
  Batch, BrandProfile, DrugSchedule, IsoDate, Medicine, MedicineFilters, MedicineGap,
  MedicineInput, MedicinePage, MedicineQuality, MedicineRow, Money, Pct, Qty, StockMovement,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { daysToExpiry, fefoOrder, isExpired, isSellable } from '@/domain/fefo'

/**
 * The medicine master, as pure value logic.
 *
 * Every rule the catalogue screen leans on — what a filter means, how a column
 * orders, what makes two rows the same medicine, what a barcode may be
 * re-pointed at — lives here as a function over arrays, and `localAdapter` only
 * feeds it from the warm search index and Dexie. Rules that can only be reached
 * through IndexedDB get tested once and then trusted forever; these get tested
 * every run, and the Phase-5 Rust server has a readable specification of exactly
 * which inputs it must reject.
 *
 * Nothing below recomputes an expiry rule or does arithmetic on a money string:
 * `@/domain/fefo` decides what is sellable and `@/domain/decimal` does the sums.
 */

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ')

// --------------------------------------------------------------- identity ---

/**
 * What makes two catalogue rows the same medicine.
 *
 * The brand alone is not it: "Dolo 650" ships as a 10x15 strip and a 10x10
 * strip from the same house, and those are two products with two printed MRPs.
 * The manufacturer is in the key because generic brand names repeat across
 * houses. Case and spacing are deliberately NOT in it — "DOLO  650" typed at the
 * counter is the row that already exists, and a master holding both spellings
 * cannot answer how much of it is in stock.
 */
export function medicineIdentity(brandName: string, packLabel: string, manufacturer: string): string {
  return [brandName, packLabel, manufacturer].map((part) => collapse(part).toLowerCase()).join('|')
}

/**
 * '08901234567893' <-> '8901234567893' <-> '901234567893' (GTIN-14/13/12).
 *
 * A GS1 DataMatrix carries AI 01 as a zero-padded 14-digit GTIN, so an EAN-13
 * printed on the pack reaches the app with a leading zero. Every lookup and
 * every already-taken check has to try each form, or one pack reads as two
 * different barcodes and the second one is free to be linked elsewhere.
 */
export function gtinForms(code: string): string[] {
  const trimmed = code.trim()
  const forms = new Set([trimmed])
  if (/^\d{12,14}$/.test(trimmed)) {
    forms.add(trimmed.replace(/^0+/, ''))
    forms.add(trimmed.padStart(14, '0'))
    forms.add(trimmed.replace(/^0+/, '').padStart(13, '0'))
  }
  return [...forms]
}

// ------------------------------------------------------------- validation ---

/**
 * Heading, sub-heading or tariff item — 4, 6 or 8 digits and nothing between.
 *
 * The tariff has no odd-length codes, so a 5- or 7-digit entry is a keystroke
 * short or long, and it lands on every invoice and in the GSTR-1 HSN summary
 * before anyone notices. `\d{4,8}` would wave both through.
 */
const HSN_RE = /^(?:\d{4}|\d{6}|\d{8})$/

function invalid(field: string, message: string): ApiError {
  return new ApiError({ code: 'MEDICINE_INVALID', message, details: { field } })
}

function decimalField(raw: string, field: string, message: string): D.Decimal {
  try {
    return D.dec(raw)
  } catch {
    throw invalid(field, message)
  }
}

/**
 * Exact divisibility.
 *
 * The obvious quotient-and-compare is wrong here: `div` rounds at scale 6, so a
 * step of 0.0000003 would divide a pack of 1 cleanly. The remainder on the
 * scaled integers is the only form of this question with no rounding in it.
 */
function dividesEvenly(step: D.Decimal, whole: D.Decimal): boolean {
  return !D.isZero(step) && whole.v % step.v === 0n
}

type MedicineFields = Omit<Medicine, 'id' | 'storeId' | 'saleRank' | 'isActive'>

/** Everything a new or edited row must satisfy before it can reach the master. */
export function validateMedicine(input: MedicineInput): MedicineFields {
  const brandName = collapse(input.brandName ?? '')
  if (!brandName) throw invalid('brandName', 'Brand name is required')

  const unitsPerPack = input.unitsPerPack
  if (!Number.isSafeInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw invalid('unitsPerPack', 'A pack holds a whole number of base units, at least one')
  }

  // Checked here or it is never checked at all, and the failure lands somewhere
  // else entirely: the low-stock filter compares against `D.dec(reorderLevel)`,
  // and NaN, Infinity and anything past the safe range all stringify to
  // something `dec` refuses — so an unvalidated row throws a raw TypeError out
  // of the grid query rather than an ApiError out of the form. The catalogue
  // then cannot be listed, which is also how the bad row would be found.
  const reorderLevel = input.reorderLevel
  if (!Number.isSafeInteger(reorderLevel) || reorderLevel < 0) {
    throw invalid('reorderLevel', 'The reorder level is a whole number of base units, zero or more')
  }

  const hsnCode = (input.hsnCode ?? '').trim()
  if (!HSN_RE.test(hsnCode)) {
    throw invalid('hsnCode', 'HSN must be 4, 6 or 8 digits')
  }

  const saleStepText = (input.saleStep ?? '').trim()
  const saleStep = decimalField(saleStepText, 'saleStep', 'Sale step must be a quantity like 1 or 0.5')
  if (!D.gt(saleStep, D.ZERO)) throw invalid('saleStep', 'Sale step must be greater than zero')

  // A strip that may not be cut leaves the counter in whole steps only, so the
  // step has to tile the pack exactly. Otherwise the last sale off a pack is a
  // quantity the shop is not allowed to dispense, and the POS discovers that
  // with a customer standing in front of it.
  if (!input.allowLooseSale && !dividesEvenly(saleStep, D.dec(unitsPerPack))) {
    throw invalid('saleStep', `A sale step of ${saleStepText} does not divide a pack of ${unitsPerPack}`)
  }

  const genericName = collapse(input.genericName ?? '')
  const rackLocation = collapse(input.rackLocation ?? '')
  return {
    brandName,
    genericName: genericName ? genericName : null,
    compositionText: collapse(input.compositionText ?? ''),
    manufacturer: collapse(input.manufacturer ?? ''),
    form: input.form,
    strengthText: collapse(input.strengthText ?? ''),
    packLabel: collapse(input.packLabel ?? ''),
    unitsPerPack,
    baseUom: input.baseUom,
    allowLooseSale: input.allowLooseSale,
    saleStep: saleStepText,
    hsnCode,
    drugSchedule: input.drugSchedule,
    // DERIVED, never typed. The catalogue's standing invariant is that everything
    // but OTC needs a prescription (asserted over the seed in db/seed.test.ts),
    // and a row where the flag and the schedule disagree makes the POS warning
    // mean nothing at all.
    requiresPrescription: input.drugSchedule !== 'OTC',
    rackLocation: rackLocation ? rackLocation : null,
    reorderLevel,
  }
}

export function findExistingMedicine(
  rows: readonly Medicine[],
  candidate: { brandName: string; packLabel: string; manufacturer: string },
): Medicine | undefined {
  const key = medicineIdentity(candidate.brandName, candidate.packLabel, candidate.manufacturer)
  return rows.find((m) => medicineIdentity(m.brandName, m.packLabel, m.manufacturer) === key)
}

function duplicate(clash: Medicine): ApiError {
  return new ApiError({
    code: 'MEDICINE_EXISTS',
    message: `${clash.brandName} ${clash.packLabel} (${clash.manufacturer}) is already in the catalogue`,
    // The existing row rides on the error so the screen can offer to OPEN it,
    // rather than leaving the operator to go and find the thing they were just
    // told about. A second "Dolo 650 10x15" is stock nobody can locate again.
    details: clash,
  })
}

export function prepareMedicine(input: MedicineInput, existing: readonly Medicine[]): Omit<Medicine, 'id' | 'storeId'> {
  const fields = validateMedicine(input)
  const clash = findExistingMedicine(existing, fields)
  if (clash) throw duplicate(clash)
  // A brand-new row has dispensed nothing, so its search ranking starts at zero
  // and is earned. Seeding it would put an unsold product above the shop's
  // actual best-seller on the first keystroke.
  return { ...fields, saleRank: 0, isActive: true }
}

/**
 * Apply a partial edit.
 *
 * An absent key means "unchanged", so the merge happens BEFORE validation and
 * the whole row is re-checked: editing only `allowLooseSale` can invalidate a
 * sale step that was legal a moment ago.
 */
export function applyMedicineUpdate(
  current: Medicine,
  patch: Partial<MedicineInput>,
  existing: readonly Medicine[],
): Medicine {
  const merged: MedicineInput = {
    brandName: patch.brandName ?? current.brandName,
    genericName: patch.genericName ?? current.genericName ?? undefined,
    compositionText: patch.compositionText ?? current.compositionText,
    manufacturer: patch.manufacturer ?? current.manufacturer,
    form: patch.form ?? current.form,
    strengthText: patch.strengthText ?? current.strengthText,
    packLabel: patch.packLabel ?? current.packLabel,
    unitsPerPack: patch.unitsPerPack ?? current.unitsPerPack,
    baseUom: patch.baseUom ?? current.baseUom,
    allowLooseSale: patch.allowLooseSale ?? current.allowLooseSale,
    saleStep: patch.saleStep ?? current.saleStep,
    hsnCode: patch.hsnCode ?? current.hsnCode,
    drugSchedule: patch.drugSchedule ?? current.drugSchedule,
    rackLocation: patch.rackLocation ?? current.rackLocation ?? undefined,
    reorderLevel: patch.reorderLevel ?? current.reorderLevel,
  }
  const fields = validateMedicine(merged)
  const clash = findExistingMedicine(existing.filter((m) => m.id !== current.id), fields)
  if (clash) throw duplicate(clash)
  // `saleRank` is measured and `isActive` belongs to setMedicineActive; neither
  // is editable through the form that produced this patch.
  return { ...current, ...fields }
}

// --------------------------------------------------------------- barcodes ---

export interface BarcodeLink {
  barcode: string
  /** Already on THIS medicine — a no-op to re-scan, not an error to report. */
  alreadyLinked: boolean
}

/**
 * Decide whether a barcode may be attached to this medicine.
 *
 * Re-pointing a code that already belongs to something else is refused rather
 * than performed, because the failure mode is not a tidy-up job: the next scan
 * of that pack silently puts a different drug on the bill and into the
 * customer's hand. The owning row is carried in `details` so the screen can say
 * which medicine holds it instead of only that something does.
 */
export function prepareBarcodeLink(
  raw: string,
  medicineId: number,
  owners: ReadonlyMap<string, number>,
  medicines: ReadonlyMap<number, Medicine>,
): BarcodeLink {
  const barcode = raw.trim()
  if (!barcode) {
    throw new ApiError({
      code: 'BARCODE_INVALID',
      message: 'Scan or type a barcode to link',
      details: { field: 'barcode' },
    })
  }
  for (const form of gtinForms(barcode)) {
    const ownerId = owners.get(form)
    if (ownerId === undefined) continue
    if (ownerId === medicineId) return { barcode, alreadyLinked: true }
    const owner = medicines.get(ownerId)
    throw new ApiError({
      code: 'BARCODE_TAKEN',
      message: owner
        ? `${barcode} already scans as ${owner.brandName} ${owner.packLabel}`
        : `${barcode} is already linked to another medicine`,
      details: owner ?? { medicineId: ownerId },
    })
  }
  return { barcode, alreadyLinked: false }
}

// ------------------------------------------------------------------- rows ---

export interface MedicineCatalogue {
  /** EVERY medicine, delisted ones included — `onlyInactive` has to find them. */
  medicines: readonly Medicine[]
  batchesFor: (medicineId: number) => readonly Batch[]
  barcodesFor: (medicineId: number) => readonly string[]
  today: IsoDate
  /** `stores.nearExpiryBuckets`, in any order. The d30/d90/d180 filters snap to it. */
  nearExpiryBuckets: readonly number[]
}

/**
 * One catalogue row, joined to its stock.
 *
 * Quantity and both valuations count only SELLABLE batches. Valuing an expired
 * or quarantined strip at MRP tells the owner the shelf is worth money that no
 * customer is ever going to pay for it; that stock is a write-off queue, and it
 * has its own screen.
 */
export function buildMedicineRow(
  medicine: Medicine,
  batches: readonly Batch[],
  barcodes: readonly string[],
  today: IsoDate,
): MedicineRow {
  const sellable = batches.filter((b) => isSellable(b, today))
  return {
    medicine,
    stockQty: D.toStr(D.sum(sellable.map((b) => D.dec(b.qtyOnHand))), 3),
    batchCount: sellable.length,
    nearestExpiry: fefoOrder(batches, today)[0]?.expiryDate ?? null,
    valueAtMrp: D.toStr(D.sum(sellable.map((b) => D.mul(D.dec(b.qtyOnHand), D.dec(b.mrpPerUnit)))), 2),
    valueAtCost: D.toStr(D.sum(sellable.map((b) => D.mul(D.dec(b.qtyOnHand), D.dec(b.landedCostPerUnit)))), 2),
    barcodes: [...barcodes],
  }
}

interface RowFacts {
  row: MedicineRow
  /**
   * Sellable stock as a DECIMAL, not the string on the row.
   *
   * Comparing the strings puts '9' above '100' — that is the whole reason the
   * numbers are parsed once here instead of at each comparison in the sort.
   */
  stock: D.Decimal
  value: D.Decimal
  /** Days to the nearest sellable expiry; null when nothing is sellable. */
  daysLeft: number | null
  /** Stock still sitting on a batch that is past its printed expiry. */
  hasExpiredStock: boolean
  haystack: string
}

function factsFor(medicine: Medicine, cat: MedicineCatalogue): RowFacts {
  const batches = cat.batchesFor(medicine.id)
  const barcodes = cat.barcodesFor(medicine.id)
  const nearest = fefoOrder(batches, cat.today)[0]
  return {
    row: buildMedicineRow(medicine, batches, barcodes, cat.today),
    stock: D.sum(batches.filter((b) => isSellable(b, cat.today)).map((b) => D.dec(b.qtyOnHand))),
    value: D.sum(
      batches
        .filter((b) => isSellable(b, cat.today))
        .map((b) => D.mul(D.dec(b.qtyOnHand), D.dec(b.mrpPerUnit))),
    ),
    daysLeft: nearest ? daysToExpiry(nearest, cat.today) : null,
    // Quarantined too: a blocked expired strip is still expired stock the owner
    // has to see, and blocking it from sale is not the same as writing it off.
    hasExpiredStock: batches.some((b) => isExpired(b, cat.today) && D.gt(D.dec(b.qtyOnHand), D.ZERO)),
    haystack: [
      medicine.brandName,
      medicine.genericName ?? '',
      medicine.compositionText,
      medicine.manufacturer,
      medicine.hsnCode,
      ...barcodes,
    ].join(' ').toLowerCase(),
  }
}

// ---------------------------------------------------------------- filters ---

type StockFilter = NonNullable<MedicineFilters['stock']>
type ExpiryFilter = NonNullable<MedicineFilters['expiry']>
type SortKey = NonNullable<MedicineFilters['sort']>

/**
 * Which window `d30`/`d90`/`d180` actually means for THIS store.
 *
 * The key carries a nominal day count, but the windows a shop works to are
 * `stores.nearExpiryBuckets`: a store watching 45 and 120 days must filter the
 * grid on the same numbers the dashboard counts at risk, or the two screens
 * quietly disagree about how much stock is in trouble. The nominal is only the
 * fallback for a store that has configured no buckets at all.
 */
export function resolveExpiryWindow(key: 'd30' | 'd90' | 'd180', buckets: readonly number[]): number {
  const nominal = Number(key.slice(1))
  const usable = buckets.filter((b) => Number.isFinite(b) && b > 0)
  let best = usable[0]
  if (best === undefined) return nominal
  for (const b of usable) {
    if (Math.abs(b - nominal) < Math.abs(best - nominal)) best = b
  }
  return best
}

interface Query {
  term: string
  schedule: DrugSchedule | undefined
  manufacturer: string
  stock: StockFilter
  expiry: ExpiryFilter
  expiryWindow: number
  gap: MedicineGap | undefined
  onlyInactive: boolean
}

/**
 * Does this row carry that hole?
 *
 * Written against the medicine and its codes rather than against a joined row so
 * the same predicate answers the filter and the counts, and the two can never
 * disagree about what "no HSN" means. HSN is checked for emptiness, not for
 * shape: `validateMedicine` already refuses a malformed one, so anything that
 * reaches here with a code has a usable code, and a row with a blank one came
 * from an import or an older build.
 */
export function hasGap(m: Medicine, barcodes: readonly string[], gap: MedicineGap): boolean {
  switch (gap) {
    case 'hsn': return m.hsnCode.trim() === ''
    case 'barcode': return barcodes.length === 0
    // Zero is not "no trigger, order freely" — it is a row the reorder
    // suggestion can never propose, because nothing is ever at or below it.
    case 'reorder': return m.reorderLevel <= 0
    case 'rack': return collapse(m.rackLocation ?? '') === ''
    case 'neverSold': return m.saleRank <= 0
  }
}

function matchesStock(f: RowFacts, mode: StockFilter): boolean {
  const inStock = D.gt(f.stock, D.ZERO)
  if (mode === 'in') return inStock
  // "Out" is nothing the counter can dispense. An expired or quarantined strip
  // on the shelf is not stock, however much of it there is.
  if (mode === 'out') return !inStock
  // At or below the trigger but NOT empty. Zero belongs to the out-of-stock
  // queue, which is a different conversation with the distributor; mixing the
  // two makes the reorder list unreadable and it stops being used.
  if (mode === 'low') return inStock && D.lte(f.stock, D.dec(f.row.medicine.reorderLevel))
  return true
}

function matchesExpiry(f: RowFacts, mode: ExpiryFilter, window: number): boolean {
  if (mode === 'expired') return f.hasExpiredStock
  if (mode === 'all') return true
  return f.daysLeft !== null && f.daysLeft <= window
}

/**
 * A hand-keyed GTIN finds the pack whichever form it was filed under.
 *
 * The haystack is a substring match, so a term with LESS padding than the stored
 * code already hits. The other direction does not: '08901234567893' typed off a
 * DataMatrix does not occur inside the '8901234567893' on file, and the grid
 * then says the shop does not stock a pack it is holding. `lookupBarcode`
 * already tries every form; the master's search box has to agree with it.
 */
function matchesBarcode(f: RowFacts, term: string): boolean {
  if (!/^\d{12,14}$/.test(term)) return false
  const forms = gtinForms(term)
  return f.row.barcodes.some((code) => forms.includes(code))
}

/** Filters compose with AND: every clause narrows what the ones before it left. */
function matches(f: RowFacts, q: Query): boolean {
  const m = f.row.medicine
  // The master shows live rows; `onlyInactive` is how a delisted one is found
  // again to be brought back. Neither view mixes the two.
  if (m.isActive === q.onlyInactive) return false
  if (q.term && !f.haystack.includes(q.term) && !matchesBarcode(f, q.term)) return false
  if (q.schedule && m.drugSchedule !== q.schedule) return false
  if (q.manufacturer && collapse(m.manufacturer).toLowerCase() !== q.manufacturer) return false
  if (q.gap !== undefined && !hasGap(m, f.row.barcodes, q.gap)) return false
  if (!matchesStock(f, q.stock)) return false
  return matchesExpiry(f, q.expiry, q.expiryWindow)
}

/**
 * The counts behind the "needs attention" strip.
 *
 * Live rows only. A delisted item with no HSN cannot appear on an invoice, so
 * it cannot break a return, and putting it in the count would send somebody to
 * fix rows that do not matter — which is how a data-quality list stops being
 * read at all.
 */
function buildQuality(all: readonly RowFacts[]): MedicineQuality {
  const live = all.filter((f) => f.row.medicine.isActive)
  const count = (gap: MedicineGap): number =>
    live.filter((f) => hasGap(f.row.medicine, f.row.barcodes, gap)).length
  return {
    active: live.length,
    inactive: all.length - live.length,
    hsn: count('hsn'),
    barcode: count('barcode'),
    reorder: count('reorder'),
    rack: count('rack'),
    neverSold: count('neverSold'),
  }
}

function compare(sort: SortKey, a: RowFacts, b: RowFacts): number {
  const primary =
    sort === 'stock' ? D.cmp(b.stock, a.stock)
      : sort === 'saleRank' ? b.row.medicine.saleRank - a.row.medicine.saleRank
        : sort === 'value' ? D.cmp(b.value, a.value)
          : a.row.medicine.brandName.localeCompare(b.row.medicine.brandName)
  // Ties break on id, without exception. A page boundary that lands inside a
  // tie under an unstable order repeats one row and drops another, and the
  // operator has no way to tell that the row they wanted was never shown.
  return primary || a.row.medicine.id - b.row.medicine.id
}

// ------------------------------------------------------------------ paging ---

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

/**
 * Distinct manufacturers across the WHOLE catalogue.
 *
 * Deliberately not across the filtered rows: a filter list that shrinks as it
 * is used cannot be used to change your mind, and picking the wrong maker would
 * leave no way back to the right one without clearing everything.
 */
function distinctManufacturers(medicines: readonly Medicine[]): string[] {
  const byKey = new Map<string, string>()
  for (const m of medicines) {
    const name = collapse(m.manufacturer)
    if (!name) continue
    const key = name.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, name)
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * The catalogue grid's one query.
 *
 * The cursor is an OFFSET into a single total ordering rather than a key into
 * the sorted column, which is what makes the pages foot: every comparator ends
 * in a tie-break on id, so the ordering is total and consecutive pages
 * concatenate to exactly the filtered set — no row served twice, none skipped.
 */
export function buildMedicinePage(cat: MedicineCatalogue, filters: MedicineFilters): MedicinePage {
  const expiry = filters.expiry ?? 'all'
  const q: Query = {
    term: collapse(filters.term ?? '').toLowerCase(),
    schedule: filters.schedule,
    manufacturer: collapse(filters.manufacturer ?? '').toLowerCase(),
    stock: filters.stock ?? 'all',
    expiry,
    expiryWindow: expiry === 'all' || expiry === 'expired' ? 0 : resolveExpiryWindow(expiry, cat.nearExpiryBuckets),
    gap: filters.gap,
    onlyInactive: filters.onlyInactive === true,
  }
  const sort = filters.sort ?? 'name'

  // Built once and used twice: the page's rows are a subset of these, and the
  // quality counts are taken over ALL of them. Facts are the expensive part —
  // they join every batch — so computing them a second time for the counts
  // would double the cost of the one query this screen makes.
  const all = cat.medicines.map((m) => factsFor(m, cat))
  const matching = all
    .filter((f) => matches(f, q))
    .sort((a, b) => compare(sort, a, b))

  const start = clampCursor(filters.cursor, matching.length)
  const page = matching.slice(start, start + clampLimit(filters.limit))
  const next = start + page.length

  return {
    rows: page.map((f) => f.row),
    total: matching.length,
    nextCursor: next < matching.length ? next : null,
    manufacturers: distinctManufacturers(cat.medicines),
    quality: buildQuality(all),
  }
}

// --------------------------------------------------------- price history ---

/**
 * What one batch cost and what it is priced at.
 *
 * There is no "price history" table in this app and there should not be: the
 * MRP a shop charges is the one PRINTED on the strip in the customer's hand, so
 * the history of a medicine's price is exactly the sequence of batches it has
 * received. Reading it off the batches keeps the two from ever disagreeing.
 */
export interface BatchPricePoint {
  batchId: number
  batchNo: string
  expiryDate: IsoDate
  /** First ledger movement on this batch — when the stock actually landed. */
  receivedAt: string | null
  mrpPerPack: Money
  mrpPerUnit: Money
  ptrPerUnit: Money
  landedCostPerUnit: Money
  purchaseGstPct: Pct
  qtyOnHand: Qty
  isQuarantined: boolean
  /** Margin over the RETAIL price, which is the number a distributor quotes. */
  marginPct: Pct | null
}

export interface PriceHistory {
  /** Earliest expiry first: the price series read left to right. */
  points: BatchPricePoint[]
  latestMrpPerPack: Money | null
  /** The last DIFFERENT pack MRP before the current one, if there was one. */
  previousMrpPerPack: Money | null
  /** Change from that previous MRP to the latest, in percent. */
  mrpChangePct: Pct | null
}

/** Margin over the retail price: (MRP − cost) / MRP. Null when MRP is zero. */
export function marginOverMrp(mrpPerUnit: Money, costPerUnit: Money): Pct | null {
  let mrp: D.Decimal
  let cost: D.Decimal
  try {
    mrp = D.dec(mrpPerUnit)
    cost = D.dec(costPerUnit)
  } catch {
    return null
  }
  if (D.isZero(mrp) || D.isNeg(mrp)) return null
  return D.toStr(D.mul(D.div(D.sub(mrp, cost), mrp), D.HUNDRED), 1)
}

/** Epoch millis, or null for an absent or unparseable stamp. */
function instant(stamp: string | undefined): number | null {
  if (stamp === undefined) return null
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? null : t
}

/**
 * Ordered by EXPIRY, not by the ledger.
 *
 * The obvious ordering is the receipt date, and it is the wrong one to depend
 * on: `listMovements` serves the most recent rows within a cap, so on a fast
 * mover the opening and purchase rows — the oldest ones — are exactly what
 * falls outside the window, and half the series would sort as "unknown". Expiry
 * is carried on the batch itself, is always present, and on the same product
 * from the same maker it moves in step with receipt order. `movements`, when a
 * caller has them, only fills in the first-seen stamp as a displayed fact.
 */
export function buildPriceHistory(
  batches: readonly Batch[],
  movements: readonly StockMovement[] = [],
): PriceHistory {
  const firstSeen = new Map<number, string>()
  for (const mv of movements) {
    const seen = firstSeen.get(mv.batchId)
    if (seen === undefined || mv.at < seen) firstSeen.set(mv.batchId, mv.at)
  }

  const points: BatchPricePoint[] = batches
    .map((b) => ({
      batchId: b.id,
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      receivedAt: firstSeen.get(b.id) ?? null,
      mrpPerPack: b.mrpPerPack,
      mrpPerUnit: b.mrpPerUnit,
      ptrPerUnit: b.ptrPerUnit,
      landedCostPerUnit: b.landedCostPerUnit,
      purchaseGstPct: b.purchaseGstPct,
      qtyOnHand: b.qtyOnHand,
      isQuarantined: b.isQuarantined,
      marginPct: marginOverMrp(b.mrpPerUnit, b.landedCostPerUnit),
    }))
    // Ties break on id, without exception: two batches of one strip legitimately
    // share an expiry at two printed MRPs, and an unstable order would swap
    // which of them the header calls the current price between two renders.
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.batchId - b.batchId)

  const latest = points.at(-1)?.mrpPerPack ?? null
  let previous: Money | null = null
  for (let i = points.length - 2; i >= 0; i--) {
    const candidate = points[i]?.mrpPerPack
    if (candidate !== undefined && candidate !== latest) {
      previous = candidate
      break
    }
  }

  let changePct: Pct | null = null
  if (latest !== null && previous !== null) {
    try {
      const before = D.dec(previous)
      if (!D.isZero(before)) {
        changePct = D.toStr(D.mul(D.div(D.sub(D.dec(latest), before), before), D.HUNDRED), 1)
      }
    } catch {
      changePct = null
    }
  }

  return { points, latestMrpPerPack: latest, previousMrpPerPack: previous, mrpChangePct: changePct }
}

// -------------------------------------------------------------- velocity ---

/**
 * How fast this medicine actually leaves the shelf.
 *
 * Measured off the stock LEDGER rather than off `saleRank`. saleRank is a
 * 90-day dispense count kept for search ranking and it answers "is this
 * popular"; a buyer needs "how many units a month", over a window they can see,
 * with returns netted off — otherwise a month with one big return reads as a
 * month of strong demand.
 */
export interface VelocityPoint {
  /** 'YYYY-MM'. */
  key: string
  label: string
  units: Qty
}

export interface SalesVelocity {
  /** One entry per month in the window, oldest first, zero months included. */
  points: VelocityPoint[]
  totalUnits: Qty
  /** Average over the whole window, not over the months that had sales. */
  perMonth: Qty
  last30Units: Qty
  lastSoldAt: string | null
  /** Days the sellable stock covers at that rate. Null when nothing sells. */
  daysOfCover: number | null
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const MS_PER_DAY = 86_400_000

function monthKeys(today: IsoDate, count: number): string[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const anchor = year * 12 + (month - 1)
  return Array.from({ length: count }, (_, i) => {
    const z = anchor - (count - 1 - i)
    return `${Math.floor(z / 12)}-${String((z % 12) + 1).padStart(2, '0')}`
  })
}

/** The two reasons that move stock across the counter. Everything else — a
 *  goods receipt, a write-off, a branch transfer — is not demand. */
function dispensedUnits(mv: StockMovement): D.Decimal | null {
  if (mv.reason !== 'SALE' && mv.reason !== 'SALE_RETURN') return null
  try {
    // Deltas are signed from the shelf's point of view: a sale is negative, so
    // dispensed units are the negation and a return nets straight back off.
    return D.neg(D.dec(mv.qtyDelta))
  } catch {
    return null
  }
}

export function salesVelocity(
  movements: readonly StockMovement[],
  opts: { today: IsoDate; months: number; stockQty: Qty },
): SalesVelocity {
  const keys = monthKeys(opts.today, Math.max(1, opts.months))
  const byMonth = new Map<string, D.Decimal>()
  let total = D.ZERO
  let last30 = D.ZERO
  let lastSoldAt: string | null = null

  const cutoff = Date.parse(`${opts.today}T00:00:00Z`) - 29 * MS_PER_DAY
  const earliest = keys[0] ?? ''

  for (const mv of movements) {
    const units = dispensedUnits(mv)
    if (units === null) continue
    /* The month is taken off the UTC stamp the ledger writes. A sale in the
       first hours of an Indian morning therefore lands in the previous UTC
       month a few times a year, which moves single units between two adjacent
       bars and cannot move a rate. */
    const key = mv.at.slice(0, 7)
    if (key < earliest) continue
    byMonth.set(key, D.add(byMonth.get(key) ?? D.ZERO, units))
    total = D.add(total, units)

    if (D.gt(units, D.ZERO) && (lastSoldAt === null || mv.at > lastSoldAt)) lastSoldAt = mv.at
    const at = instant(mv.at)
    if (at !== null && at >= cutoff) last30 = D.add(last30, units)
  }

  const points = keys.map((key) => ({
    key,
    label: MONTH_LABELS[Number(key.slice(5, 7)) - 1] ?? key,
    units: D.toStr(byMonth.get(key) ?? D.ZERO, 3),
  }))

  const perMonth = D.div(total, D.dec(keys.length))
  let daysOfCover: number | null = null
  if (D.gt(total, D.ZERO)) {
    try {
      const perDay = D.div(total, D.dec(keys.length * 30))
      daysOfCover = Math.round(Number(D.toStr(D.div(D.dec(opts.stockQty), perDay), 0)))
    } catch {
      daysOfCover = null
    }
  }

  return {
    points,
    totalUnits: D.toStr(total, 3),
    perMonth: D.toStr(perMonth, 1),
    last30Units: D.toStr(last30, 3),
    lastSoldAt,
    daysOfCover,
  }
}

// ------------------------------------------------------------------- brand ---

/**
 * The white-label profile is stored as one JSON row, so it arrives as `unknown`.
 *
 * It is coerced on the way IN (a row written by an older build is missing
 * whatever has been added since) and on the way OUT (a form leaves fields
 * blank), because a half-filled profile must never be able to boot the shell
 * with no name on it.
 */

const MARK_MAX = 3

function trimmed(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s : undefined
}

function accentOf(raw: unknown): BrandProfile['accent'] {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const base = trimmed(r.base)
  const hover = trimmed(r.hover)
  const onAccent = trimmed(r.text)
  const tint = trimmed(r.tint)
  const ring = trimmed(r.ring)
  // All five or none. A partial ramp falls back to the built-in teal for the
  // missing steps, and the accent then reads as two unrelated colours sharing
  // one button.
  if (!base || !hover || !onAccent || !tint || !ring) return null
  return { base, hover, text: onAccent, tint, ring }
}

export function coerceBrand(raw: unknown, fallback: BrandProfile): BrandProfile {
  if (typeof raw !== 'object' || raw === null) return fallback
  const r = raw as Record<string, unknown>
  return {
    productName: trimmed(r.productName) ?? fallback.productName,
    // The mark is drawn into a rounded square. A fourth character does not fit
    // the box, so it is cut once here rather than clipped by CSS on every
    // surface that draws it.
    markText: (trimmed(r.markText) ?? fallback.markText).slice(0, MARK_MAX),
    logoUrl: trimmed(r.logoUrl) ?? null,
    accent: accentOf(r.accent),
    tagline: trimmed(r.tagline) ?? null,
    documentFooter: trimmed(r.documentFooter) ?? null,
    hidePoweredBy: r.hidePoweredBy === true,
  }
}

/** Anything unreadable — absent, corrupt, hand-edited — falls all the way back
 *  to the built-in profile. An unbranded shell beats a shell that will not boot. */
export function parseBrand(json: string | undefined, fallback: BrandProfile): BrandProfile {
  if (json === undefined) return fallback
  try {
    return coerceBrand(JSON.parse(json), fallback)
  } catch {
    return fallback
  }
}
