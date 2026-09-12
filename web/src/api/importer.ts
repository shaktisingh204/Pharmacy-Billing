import type { Medicine, Money, Pct, PurchaseLineInput, Qty } from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { normaliseExpiry } from './purchases'

/**
 * Importing a distributor's bill, as pure value logic.
 *
 * This is the strongest switching lever the product has. A pharmacy changing
 * software does not stop buying stock, and if the first week means re-keying
 * every distributor bill by hand they go back. Every incumbent has an importer;
 * what they do not have is one that gets FASTER each time it is used.
 *
 * Marg's flow is the reference and also the thing to beat. It asks for a saved
 * per-party "format", shows an Item Mapping window listing what it could not
 * match, and makes you resolve those by hand — every time, because the mapping
 * is not remembered. Three decisions here are deliberately different:
 *
 *  1. THE COLUMN MAPPING IS GUESSED, THEN SAVED PER SUPPLIER. A distributor's
 *     export layout does not change between bills, so it should be asked once.
 *
 *  2. RESOLVING AN ITEM WRITES AN ALIAS. "SUPPLIER'S NAME → our medicine" is the
 *     durable fact, not a one-off decision inside one import. The second bill
 *     from that distributor matches the same line without being asked.
 *
 *  3. NOTHING POSTS UNTIL EVERY ROW IS DECIDED. A partially-matched import that
 *     posts what it understood and drops the rest is how stock silently goes
 *     missing — and the operator has no way to know which lines were lost.
 *
 * One hazard the research names explicitly and this must not repeat: the older
 * "standard formats" predate GST and carry NO HSN column and no CGST/SGST split.
 * A file in that shape imports cleanly and leaves every line without an HSN,
 * which surfaces months later as a GSTR-1 that cannot be filed. So a missing
 * HSN column is reported as a WARNING on the import, not silently defaulted.
 */

// ---------------------------------------------------------------- parsing ---

/** The delimiters a distributor export actually uses. */
const DELIMITERS = [',', '\t', ';', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

/**
 * Which delimiter this text uses.
 *
 * Decided by CONSISTENCY across lines, not by raw frequency. A bill whose
 * product names contain commas ("Vitamin B1, B6, B12") has more commas than
 * tabs, and picking the commonest character splits every one of those names into
 * three columns. The right delimiter is the one that gives every line the same
 * field count.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 12)
  if (lines.length === 0) return ','

  let best: Delimiter = ','
  let bestScore = -1
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => splitRow(l, d).length)
    const first = counts[0] ?? 1
    if (first < 2) continue
    const consistent = counts.filter((c) => c === first).length
    // Consistency first, then width: two delimiters that both split every line
    // evenly are separated by which one found more columns.
    const score = consistent * 100 + first
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

/**
 * One line into fields, honouring RFC-4180 quoting.
 *
 * Distributor exports quote inconsistently — some quote every field, some only
 * the ones containing the delimiter, some quote nothing and hope. All three have
 * to parse, and a doubled quote inside a quoted field is an escaped quote.
 */
export function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1 }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field.trim() === '') { quoted = true; field = ''; continue }
    if (ch === delimiter) { out.push(field.trim()); field = ''; continue }
    field += ch
  }
  out.push(field.trim())
  return out
}

export interface ParsedSheet {
  delimiter: Delimiter
  headers: string[]
  rows: string[][]
  /** Lines dropped because they had a different field count from the header. */
  ragged: number
}

/**
 * Find the header row and read the table under it.
 *
 * The header is rarely line 1. Distributor exports open with the firm's name,
 * its GSTIN, a bill number and a blank line, and only then the column titles —
 * so the header is taken to be the first line whose fields look like LABELS
 * rather than data: mostly non-numeric, and the widest such line near the top.
 */
export function parseSheet(text: string, delimiter?: Delimiter): ParsedSheet {
  const d = delimiter ?? detectDelimiter(text)
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) {
    throw new ApiError({ code: 'IMPORT_EMPTY', message: 'There is nothing in that file' })
  }

  let headerAt = 0
  let bestLabels = 0
  for (let i = 0; i < Math.min(lines.length, 15); i += 1) {
    const fields = splitRow(lines[i] ?? '', d)
    if (fields.length < 3) continue
    const labels = fields.filter((f) => f !== '' && !/^-?[\d.,]+$/.test(f)).length
    /* Scored on LABEL COUNT, not on width, and ties go to the earliest line.
       Width alone picks the wrong row: a misaligned data line carrying one extra
       field is wider than the header, and the header then gets read as a product
       while every real row is discarded as ragged. A data row has two or three
       text cells (name, batch, expiry) and the rest are numbers, so counting the
       non-numeric cells separates the two cleanly. Letterhead lines are one or
       two fields and never reach the `< 3` guard. */
    if (labels > fields.length / 2 && labels > bestLabels) {
      bestLabels = labels
      headerAt = i
    }
  }

  const headers = splitRow(lines[headerAt] ?? '', d)
  const rows: string[][] = []
  let ragged = 0
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const fields = splitRow(lines[i] ?? '', d)
    /* A short row is PADDED rather than dropped: trailing empty cells are
       routinely omitted by exporters. A row with MORE fields than the header is
       genuinely misaligned and is counted, not guessed at — silently trimming it
       would put the discount into the GST column. */
    if (fields.length > headers.length) { ragged += 1; continue }
    if (fields.every((f) => f === '')) continue
    while (fields.length < headers.length) fields.push('')
    rows.push(fields)
  }
  return { delimiter: d, headers, rows, ragged }
}

// ---------------------------------------------------------------- columns ---

/** Every field a goods receipt needs, plus the ones it can live without. */
export const IMPORT_FIELDS = [
  'name', 'batchNo', 'expiry', 'qtyPacks', 'freePacks',
  'mrpPerPack', 'ratePerPack', 'discountPct', 'gstRatePct', 'hsnCode', 'barcode',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** Without these a line is not a line. */
export const REQUIRED_FIELDS: readonly ImportField[] = [
  'name', 'batchNo', 'expiry', 'qtyPacks', 'mrpPerPack', 'ratePerPack',
]

export const FIELD_LABEL: Record<ImportField, string> = {
  name: 'Product name',
  batchNo: 'Batch',
  expiry: 'Expiry',
  qtyPacks: 'Qty (packs)',
  freePacks: 'Free',
  mrpPerPack: 'MRP per pack',
  ratePerPack: 'Rate per pack',
  discountPct: 'Discount %',
  gstRatePct: 'GST %',
  hsnCode: 'HSN',
  barcode: 'Barcode',
}

/**
 * Header spellings seen in the wild, in priority order.
 *
 * Ordered because several overlap: a column headed "RATE" is the purchase rate,
 * but "MRP RATE" is the MRP — so the MRP patterns are tested first and win the
 * header before the looser rate pattern sees it.
 */
const HEADER_HINTS: Array<[ImportField, RegExp]> = [
  ['hsnCode', /\bhsn\b|hsn\s*code|hsncode/i],
  ['barcode', /barcode|bar\s*code|\bean\b|\bupc\b/i],
  ['mrpPerPack', /\bmrp\b|m\.?r\.?p|max.*retail/i],
  ['freePacks', /\bfree\b|scheme\s*qty|\bfree\s*qty\b|\bfr\b/i],
  ['qtyPacks', /\bqty\b|quantity|\bpcs\b|\bpack\b|\bqnty\b/i],
  ['ratePerPack', /\brate\b|\bptr\b|purchase\s*rate|\bcost\b|\bbasic\b/i],
  ['discountPct', /disc|\bdis\s*%|\bdiscount\b/i],
  ['gstRatePct', /\bgst\b|\btax\b|\bvat\b|gst\s*%/i],
  ['expiry', /\bexp\b|expiry|expiration|\bexp\.?\s*dt\b/i],
  ['batchNo', /batch|\bbat\b|\bb\.?no\b|lot/i],
  ['name', /product|item|description|particular|\bname\b|\bgoods\b/i],
]

export type ColumnMap = Partial<Record<ImportField, number>>

/**
 * Guess which column is which from the header text.
 *
 * A guess, offered for correction — never applied silently. Getting MRP and rate
 * the wrong way round produces a bill that posts cleanly and prices every batch
 * at cost, so the mapping is always shown with sample values beside it.
 */
export function guessColumns(headers: readonly string[]): ColumnMap {
  const map: ColumnMap = {}
  const taken = new Set<number>()
  for (const [field, pattern] of HEADER_HINTS) {
    for (let i = 0; i < headers.length; i += 1) {
      if (taken.has(i)) continue
      if (!pattern.test(headers[i] ?? '')) continue
      map[field] = i
      taken.add(i)
      break
    }
  }
  return map
}

export function missingRequired(map: ColumnMap): ImportField[] {
  return REQUIRED_FIELDS.filter((f) => map[f] === undefined)
}

// ---------------------------------------------------------------- matching ---

/** Punctuation, pack notation and casing removed, so "TAB." and "TABLET" meet. */
export function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|inj|syp|syrup|susp|oint|cream|drops?)\b\.?/g, ' ')
    .replace(/\b\d+\s*(mg|mcg|ml|gm|g|iu|%)\b/g, ' ')
    .replace(/\d+\s*[x*]\s*\d+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export type MatchKind = 'barcode' | 'alias' | 'exact' | 'mrp' | 'fuzzy' | 'new' | 'ambiguous'

export interface MatchResult {
  kind: MatchKind
  medicineId: number | null
  /** The candidates, when the operator has to choose. Never more than 5. */
  candidates: Medicine[]
}

export interface MatchContext {
  medicines: readonly Medicine[]
  /** `barcode -> medicineId`, from the barcode master. */
  barcodes: ReadonlyMap<string, number>
  /** `normalised supplier name -> medicineId`, learned from earlier imports. */
  aliases: ReadonlyMap<string, number>
  /**
   * `medicineId -> the pack MRPs already seen on that medicine's batches`.
   *
   * The tie-breaker for the commonest ambiguity there is. "DOLO 650 TAB" matches
   * Dolo 650 in four pack sizes and the name cannot separate them — but the bill
   * states an MRP per pack, and only one of those packs has ever been received
   * at that MRP. Without this the operator hand-picks a pack on nearly every
   * line of every bill, which is most of the work the importer was built to
   * remove.
   */
  packMrps: ReadonlyMap<number, ReadonlySet<string>>
}

/**
 * Match one imported product name to the catalogue.
 *
 * The order is by CERTAINTY, and it matters. A barcode is an identity; an alias
 * is a human decision already made; an exact normalised name is near-certain; a
 * fuzzy hit is a suggestion and is never applied without being confirmed.
 *
 * `ambiguous` is deliberately its own outcome rather than "pick the first". Two
 * medicines whose names normalise identically are usually the same brand at two
 * strengths, and quietly choosing one puts the stock on the wrong SKU at the
 * wrong MRP — which the counter then sells at a price the strip does not carry.
 */
export function matchItem(
  name: string,
  barcode: string | undefined,
  ctx: MatchContext,
  /** The MRP per pack stated on the bill, which identifies the pack size. */
  mrpPerPack?: string,
): MatchResult {
  const none = { medicineId: null, candidates: [] as Medicine[] }

  const code = (barcode ?? '').trim()
  if (code !== '') {
    const id = ctx.barcodes.get(code)
    if (id !== undefined) return { kind: 'barcode', medicineId: id, candidates: [] }
  }

  const key = normaliseName(name)
  if (key === '') return { kind: 'new', ...none }

  const aliased = ctx.aliases.get(key)
  if (aliased !== undefined) return { kind: 'alias', medicineId: aliased, candidates: [] }

  const exact = ctx.medicines.filter((m) => normaliseName(m.brandName) === key)
  if (exact.length === 1 && exact[0]) {
    return { kind: 'exact', medicineId: exact[0].id, candidates: [] }
  }
  if (exact.length > 1) {
    /* One brand, several pack sizes — and the bill's MRP says which. Narrowed
       only when it lands on EXACTLY one: two packs sharing an MRP is a real
       possibility, and there the operator still chooses. */
    const narrowed = narrowByMrp(exact, mrpPerPack, ctx)
    if (narrowed.matched && narrowed.list.length === 1 && narrowed.list[0]) {
      return { kind: 'mrp', medicineId: narrowed.list[0].id, candidates: [] }
    }
    return { kind: 'ambiguous', medicineId: null, candidates: exact.slice(0, 5) }
  }

  /* Prefix, then containment. A distributor writes "AMOXYCILLIN 500 CAP" for our
     "Amoxycillin 500"; the reverse also happens. Anything shorter than four
     characters is not offered at all — "CAL" matches forty products and a list
     of forty is not a suggestion. */
  if (key.length < 4) return { kind: 'new', ...none }
  const near = ctx.medicines.filter((m) => {
    const b = normaliseName(m.brandName)
    return b.startsWith(key) || key.startsWith(b) || b.includes(key)
  })
  if (near.length === 0) return { kind: 'new', ...none }
  const narrowed = narrowByMrp(near, mrpPerPack, ctx)
  if (narrowed.matched && narrowed.list.length === 1 && narrowed.list[0]) {
    return { kind: 'mrp', medicineId: narrowed.list[0].id, candidates: [] }
  }
  return { kind: 'fuzzy', medicineId: null, candidates: near.slice(0, 5) }
}

/**
 * Keep only the candidates that have actually been received at this MRP.
 *
 * Compared as a normalised DECIMAL STRING, not as text: a distributor writes
 * "1500", "1500.00" and "1,500.00" for the same money, and a string comparison
 * matches none of them against a stored "1500.00". Returns the input unchanged
 * when there is nothing to go on, so this can only ever narrow.
 */
function narrowByMrp(
  candidates: readonly Medicine[],
  mrpPerPack: string | undefined,
  ctx: MatchContext,
): { list: Medicine[]; matched: boolean } {
  const raw = (mrpPerPack ?? '').replace(/[₹,\s]/g, '')
  if (raw === '' || !/^\d*\.?\d+$/.test(raw)) return { list: [...candidates], matched: false }
  const want = D.toStr(D.dec(raw), 2)
  const hits = candidates.filter((m) => {
    const seen = ctx.packMrps.get(m.id)
    return seen !== undefined && seen.has(want)
  })
  /* `matched` is what stops this from applying a hit it did not earn.
     With no MRP evidence at all the list comes back unchanged, and a single
     fuzzy candidate would then look like it had been confirmed by MRP — quietly
     turning "here is a suggestion" into "this is the product", which is the one
     thing fuzzy matching must never do. */
  return hits.length > 0 ? { list: hits, matched: true } : { list: [...candidates], matched: false }
}

// ------------------------------------------------------------------- rows ---

export interface ImportRow {
  index: number
  raw: string[]
  name: string
  barcode: string
  match: MatchResult
  /** Set by the operator, or by the match when it was certain. */
  medicineId: number | null
  /** Excluded from the posting. A line nobody can resolve is skipped ALOUD. */
  skipped: boolean
  /** Anything read out of the row that will not parse. */
  problems: string[]
  line: Omit<PurchaseLineInput, 'medicineId' | 'lineId'>
}

const cell = (row: readonly string[], at: number | undefined): string =>
  at === undefined ? '' : (row[at] ?? '').trim()

/** A number out of a distributor's cell: strips grouping, currency and blanks. */
function num(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[₹,\s]/g, '')
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return fallback
  return cleaned
}

export function buildRows(sheet: ParsedSheet, map: ColumnMap, ctx: MatchContext): ImportRow[] {
  return sheet.rows.map((raw, index) => {
    const name = cell(raw, map.name)
    const barcode = cell(raw, map.barcode)
    const mrpCell = num(cell(raw, map.mrpPerPack), '0')
    const match = matchItem(name, barcode, ctx, mrpCell)
    const problems: string[] = []

    const expiryRaw = cell(raw, map.expiry)
    let expiry = expiryRaw
    try {
      normaliseExpiry(expiryRaw)
    } catch {
      problems.push(`Expiry "${expiryRaw}" is not a month`)
      expiry = ''
    }

    const qty = num(cell(raw, map.qtyPacks), '0')
    if (D.isZero(D.dec(qty))) problems.push('Quantity is zero or unreadable')
    const mrp = mrpCell
    if (D.isZero(D.dec(mrp))) problems.push('MRP is zero or unreadable')
    const rate = num(cell(raw, map.ratePerPack), '0')

    /* Rate above MRP is a MAPPING error nine times out of ten — the two columns
       swapped — and it is caught here rather than at post time because the fix is
       to change the mapping, which is two screens back by then. */
    if (D.gt(D.dec(rate), D.dec(mrp)) && !D.isZero(D.dec(mrp))) {
      problems.push('Rate is above MRP — are the rate and MRP columns the right way round?')
    }

    return {
      index,
      raw,
      name,
      barcode,
      match,
      medicineId: match.medicineId,
      skipped: false,
      problems,
      line: {
        batchNo: cell(raw, map.batchNo),
        expiry,
        qtyPacks: qty as Qty,
        freePacks: num(cell(raw, map.freePacks), '0') as Qty,
        mrpPerPack: mrp as Money,
        ratePerPack: rate as Money,
        discountPct: num(cell(raw, map.discountPct), '0') as Pct,
        gstRatePct: num(cell(raw, map.gstRatePct), '0') as Pct,
      },
    }
  })
}

export interface ImportReadiness {
  /** Rows that will be posted. */
  ready: number
  /** Rows still needing a decision — matched to nothing and not skipped. */
  unresolved: number
  skipped: number
  /** Rows carrying a problem. Blocking: a bad expiry cannot be posted. */
  problems: number
  /** Not blocking, but said out loud. */
  warnings: string[]
  canPost: boolean
}

export function readiness(rows: readonly ImportRow[], map: ColumnMap): ImportReadiness {
  const live = rows.filter((r) => !r.skipped)
  const unresolved = live.filter((r) => r.medicineId === null).length
  const problems = live.filter((r) => r.problems.length > 0).length
  const warnings: string[] = []

  /* The pre-GST "standard format" hazard, named in the research: those layouts
     carry no HSN column at all. The file imports cleanly, every line lands
     without an HSN, and it surfaces months later as a return that cannot be
     filed. Warned about here, where it can still be fixed by mapping a column. */
  if (map.hsnCode === undefined) {
    warnings.push('No HSN column was mapped. These lines will take the HSN already on each medicine — check it before filing.')
  }
  if (map.gstRatePct === undefined) {
    warnings.push('No GST column was mapped, so each line falls back to the rate on the medicine master.')
  }
  if (map.freePacks === undefined) {
    warnings.push('No free-quantity column was mapped. If this bill carries a scheme, landed cost will be overstated.')
  }

  return {
    ready: live.length - unresolved - problems,
    unresolved,
    skipped: rows.length - live.length,
    problems,
    warnings,
    canPost: live.length > 0 && unresolved === 0 && problems === 0,
  }
}

/** The lines a resolved import posts, in the shape `postPurchase` already takes. */
export function toPurchaseLines(rows: readonly ImportRow[]): PurchaseLineInput[] {
  return rows
    .filter((r) => !r.skipped && r.medicineId !== null)
    .map((r, i) => ({ lineId: `i${i + 1}`, medicineId: r.medicineId as number, ...r.line }))
}

/**
 * What this import teaches the next one.
 *
 * Only rows the operator actually DECIDED — a barcode or alias hit taught
 * nothing new, and re-writing it would just churn the store. An exact name match
 * is recorded too: it was free this time, but the supplier's spelling is now
 * known and a later catalogue edit must not silently break it.
 */
export function learnedAliases(rows: readonly ImportRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    if (row.skipped || row.medicineId === null) continue
    if (row.match.kind === 'barcode' || row.match.kind === 'alias') continue
    const key = normaliseName(row.name)
    if (key !== '') out.set(key, row.medicineId)
  }
  return out
}
