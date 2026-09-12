import type {
  Batch, CreditNote, Customer, IsoDate, Medicine, Money, PurchaseInvoice, Qty, ReportCheck,
  ReportColumn, ReportGroup, ReportHeadline, ReportId, ReportQuery, ReportResult, ReportRow,
  SaleInvoice,
  StockMovement,
  StoreProfile, Supplier,
} from '@contract'
import {
  MOVEMENT_LABEL, REGISTERED_SCHEDULES, buildRegister, sortRegisters,
} from './controlledRegister'
import * as D from '@/domain/decimal'
import { buildBatchRow, sellableByMedicine } from './inventory'

/**
 * Every report, as pure value logic.
 *
 * The same split the dashboard uses: the adapter reads the tables, this decides
 * what the rows MEAN. Nothing below reads a clock, and nothing below does
 * arithmetic on a money string outside `@/domain/decimal`.
 *
 * THREE RULES, all of them learned from what breaks in the incumbents:
 *
 *  1. ONE SHAPE. Every report is columns + rows + footed totals, so the filter,
 *     the footer and the CSV have one implementation instead of ten that drift.
 *     Marg's own knowledge base carries an article explaining why its closing
 *     stock disagrees with its stock-and-sale analysis — two reports over one
 *     dataset at different grains. That cannot happen here: stock is valued by
 *     `buildBatchRow` for every report that values stock, full stop.
 *
 *  2. THE BASIS IS PRINTED, never a hidden setting. Marg's gross profit switches
 *     between taxable value and bill value from a control three menus deep and
 *     neither number is labelled on the report. Every `basis` line here ends up
 *     on screen and in the export header.
 *
 *  3. MARGIN USES THE COST SNAPSHOTTED ON THE SALE LINE — `QuoteAllocation
 *     .costBasis`, frozen at post time — never a product average and never
 *     today's landed cost. A margin figure that changes when you reopen the
 *     report is a margin figure nobody believes.
 *
 * Totals are computed over the whole FILTERED set rather than the rendered page.
 * Getting that wrong once destroys trust in every number on the screen.
 */

// ------------------------------------------------------------------ money ---

const DECIMALISH = /^-?\d+(\.\d+)?$/

const money = (d: D.Decimal): Money => D.toStr(d, 2)
const qty = (d: D.Decimal): Qty => D.toStr(d, 3)
const count = (n: number): string => String(n)

/** Null rather than zero for anything unparseable: a blank cell is not a nil. */
function parse(v: string | null | undefined): D.Decimal | null {
  if (v === null || v === undefined) return null
  const s = v.trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

const dec = (v: string): D.Decimal => parse(v) ?? D.ZERO

/** Percentage of a base, 1dp. Null when the base is zero — a margin on nothing
 *  is not 0%, it is undefined, and printing 0% invents a fact. */
function ratioPct(part: D.Decimal, base: D.Decimal): string | null {
  if (D.isZero(base)) return null
  return D.toStr(D.mul(D.div(part, base), D.HUNDRED), 1)
}

const taxOf = (cgst: string, sgst: string, igst: string): D.Decimal =>
  D.sum([dec(cgst), dec(sgst), dec(igst)])

// ------------------------------------------------------------------ dates ---

const MS_PER_DAY = 86_400_000

/** Whole calendar days between two ISO dates, in UTC so a machine in another
 *  zone buckets an invoice identically. */
function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY)
}

function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** ISO dates sort lexically, which is the whole reason the range is a string
 *  comparison and not a parse. An unparseable bound is clamped, never guessed. */
export function normaliseRange(q: { from: IsoDate; to: IsoDate }, today: IsoDate): { from: IsoDate; to: IsoDate } {
  const from = ISO.test(q.from) ? q.from : today
  const to = ISO.test(q.to) ? q.to : today
  return from <= to ? { from, to } : { from: to, to: from }
}

const inRange = (date: IsoDate, from: IsoDate, to: IsoDate): boolean => date >= from && date <= to

// ------------------------------------------------------------------ input ---

/**
 * What each report has to READ, declared rather than inferred.
 *
 * The adapter is the only thing that knows how expensive a read is, and a day
 * book that pulled four months of invoices to render one day would be the kind
 * of query that only hurts once the shop has history. Ageing is the exception:
 * a balance cannot be aged against a window, so those two ask for everything up
 * to the as-on date.
 */
export interface ReportInputs {
  sales: 'none' | 'range' | 'history'
  purchases: 'none' | 'range' | 'history'
  /** Credit notes reverse output tax, so anything statutory has to read them. */
  creditNotes: boolean
  stock: boolean
  /**
   * The stock ledger.
   *
   * 'none' for almost everything, and that is the point: the ledger is the
   * largest table in the database and grows with every strip that moves. Only a
   * report that has to show MOVEMENT rather than a position asks for it, and
   * such a report needs history — a running balance cannot start mid-stream, so
   * there is no windowed variant to offer.
   */
  movements?: 'none' | 'history'
}

export function reportInputs(id: ReportId): ReportInputs {
  switch (id) {
    case 'DAY_BOOK':
    case 'SALES_BY_DAY':
      return { sales: 'range', purchases: 'none', creditNotes: true, stock: false }
    case 'ITEM_SALES':
    case 'BATCH_MARGIN':
      return { sales: 'range', purchases: 'none', creditNotes: false, stock: true }
    case 'GST_RATE_SUMMARY':
    case 'HSN_SUMMARY':
      return { sales: 'range', purchases: 'none', creditNotes: true, stock: false }
    case 'PURCHASE_REGISTER':
      return { sales: 'none', purchases: 'range', creditNotes: false, stock: false }
    case 'H1_REGISTER':
      return { sales: 'range', purchases: 'none', creditNotes: false, stock: false }
    case 'CUSTOMER_OUTSTANDING':
      return { sales: 'history', purchases: 'none', creditNotes: false, stock: false }
    case 'SUPPLIER_OUTSTANDING':
      return { sales: 'none', purchases: 'history', creditNotes: false, stock: false }
    case 'STOCK_VALUATION':
    case 'NEAR_EXPIRY':
      return { sales: 'none', purchases: 'none', creditNotes: false, stock: true }
    /* The one report that needs BOTH sides: what is on the shelf, and what left
       it during the window. Reading only stock would list the whole shelf. */
    case 'NON_MOVING':
      return { sales: 'range', purchases: 'none', creditNotes: false, stock: true }
    /* Stock to reconcile the closing balance against the shelf, and the whole
       ledger because an opening balance is folded from everything before the
       window. Neither side is optional: without stock it cannot say whether it
       balances, and without history its first row would start from nowhere. */
    case 'CONTROLLED_BALANCE':
      return { sales: 'none', purchases: 'none', creditNotes: false, stock: true, movements: 'history' }
  }
}

export interface ReportSource {
  query: ReportQuery
  /** Windowed or historical per `reportInputs`; builders never assume which. */
  invoices: readonly SaleInvoice[]
  /** Reversals, on their ISSUE date — the period whose liability they reduce. */
  creditNotes: readonly CreditNote[]
  purchases: readonly PurchaseInvoice[]
  batches: readonly Batch[]
  /** Empty unless `reportInputs` asked for them; builders never assume otherwise. */
  movements: readonly StockMovement[]
  medicineFor: (id: number) => Medicine | undefined
  customers: readonly Customer[]
  suppliers: readonly Supplier[]
  store: StoreProfile
  /** The branded product name. Every caveat that names the software uses it. */
  productName: string
  today: IsoDate
  generatedAt: string
}

// ----------------------------------------------------------------- shapes ---

/** A row before the term and facet filters have had their say. */
interface Candidate {
  row: ReportRow
  /** The value of this row on the report's one facet axis. '' opts out. */
  facet: string
  /** Lower-cased text the free-text filter searches. */
  haystack: string
}

interface ReportBuild {
  title: string
  question: string
  basis: string[]
  notes: string[]
  columns: ReportColumn[]
  candidates: Candidate[]
  facetLabel: string | null
  facetOrder: string[]
  facetName: (value: string) => string
  /** Computed over the FILTERED rows, so the headline always describes the
   *  table underneath it rather than something the reader cannot see. */
  headline: (rows: readonly ReportRow[]) => ReportHeadline[]
  checks?: (rows: readonly ReportRow[]) => ReportCheck[]
}

/** Sums one column across rows. The cell is a decimal string or nothing. */
function columnTotal(rows: readonly ReportRow[], key: string): D.Decimal {
  return D.sum(rows.map((r) => parse(r.cells[key]) ?? D.ZERO))
}

const headline = (label: string, value: string, kind: ReportHeadline['kind'], hint?: string): ReportHeadline =>
  hint === undefined ? { label, value, kind } : { label, value, kind, hint }

// ------------------------------------------------------------- sale facts ---

type DocType = 'INVOICE' | 'CREDIT_NOTE'

interface TaxFact {
  docType: DocType
  docId: number
  docNo: string
  date: IsoDate
  medicineId: number
  brandName: string
  packLabel: string
  hsnCode: string
  gstRatePct: string
  batchNo: string
  expiryDate: IsoDate
  qty: D.Decimal
  freeQty: D.Decimal
  taxable: D.Decimal
  cgst: D.Decimal
  sgst: D.Decimal
  igst: D.Decimal
  lineTotal: D.Decimal
  /** Frozen at post time. Never re-derived from the batch as it stands today. */
  cost: D.Decimal
  b2b: boolean
}

/**
 * One row per batch allocation, across both documents that carry output tax.
 *
 * The allocation, not the cart line, is the honest grain: a single cart row
 * legitimately fans out across two batches with two printed MRPs and two landed
 * costs, and margin computed at line level would average them away.
 *
 * A CREDIT NOTE is carried as the same shape with every amount NEGATED, on its
 * issue date. It reverses the tax that was charged at the rate that was charged,
 * which is why the note snapshots its own rate rather than resolving today's.
 * Netting it here is not a nicety: a period whose returns are left out does not
 * tie to GSTR-1, and post-hard-locking there is no 3B fudge left to fix it with.
 *
 * VOIDED invoices are excluded everywhere except the day book, which shows them
 * as cancelled so the document series still reconciles.
 */
function taxFacts(src: ReportSource): TaxFact[] {
  const { from, to } = src.query
  const gstinById = new Map<number, string | null>(src.customers.map((c) => [c.id, c.gstin]))
  const isB2b = (customerId: number | null): boolean =>
    customerId !== null && (gstinById.get(customerId) ?? null) !== null
  const out: TaxFact[] = []

  for (const invoice of src.invoices) {
    if (invoice.status !== 'POSTED') continue
    if (!inRange(invoice.invoiceDate, from, to)) continue
    // B2B is decided by the buyer holding a GSTIN, which is what splits GSTR-1
    // Table 12 into its B2B and B2C tabs. A named cash customer is still B2C.
    const b2b = isB2b(invoice.customerId)

    for (const line of invoice.quote.lines) {
      for (const a of line.allocations) {
        out.push({
          docType: 'INVOICE',
          docId: invoice.id,
          docNo: invoice.invoiceNo,
          date: invoice.invoiceDate,
          medicineId: line.medicineId,
          brandName: line.brandName,
          packLabel: line.packLabel,
          hsnCode: line.hsnCode,
          gstRatePct: a.gstRatePct,
          batchNo: a.batchNo,
          expiryDate: a.expiryDate,
          qty: dec(a.qty),
          freeQty: dec(a.freeQty),
          taxable: dec(a.taxableValue),
          cgst: dec(a.cgst),
          sgst: dec(a.sgst),
          igst: dec(a.igst),
          lineTotal: dec(a.lineTotal),
          cost: dec(a.costBasis),
          b2b,
        })
      }
    }
  }

  for (const note of src.creditNotes) {
    if (!inRange(note.issuedOn, from, to)) continue
    const b2b = isB2b(note.customerId)
    for (const line of note.lines) {
      out.push({
        docType: 'CREDIT_NOTE',
        docId: note.id,
        docNo: note.creditNoteNo,
        date: note.issuedOn,
        medicineId: line.medicineId,
        brandName: line.brandName,
        packLabel: line.packLabel,
        hsnCode: line.hsnCode,
        gstRatePct: line.gstRatePct,
        batchNo: line.batchNo,
        expiryDate: line.expiryDate,
        qty: D.neg(dec(line.qty)),
        freeQty: D.ZERO,
        taxable: D.neg(dec(line.taxableValue)),
        cgst: D.neg(dec(line.cgst)),
        sgst: D.neg(dec(line.sgst)),
        igst: D.neg(dec(line.igst)),
        lineTotal: D.neg(dec(line.lineTotal)),
        // A credit note carries no cost basis, so it cannot reverse cost. The
        // margin reports therefore exclude returns outright and say so, rather
        // than reversing revenue against a cost that was never snapshotted.
        cost: D.ZERO,
        b2b,
      })
    }
  }
  return out
}

/** Sales only. Margin is computed on facts that carry a cost basis. */
const saleFacts = (src: ReportSource): TaxFact[] =>
  taxFacts(src).filter((f) => f.docType === 'INVOICE')

/** The basis line every margin report carries, verbatim. */
const COST_BASIS =
  'Cost is the landed cost SNAPSHOTTED on each sale line when the bill was posted — not a product average, not today’s cost.'

const GP_BASIS =
  'Gross profit is taxable value (ex-GST) minus that cost; GP% is on the ex-GST value, so it is not inflated by the tax the customer paid.'

/**
 * Why margin excludes returns.
 *
 * A credit note reverses revenue but carries no cost basis of its own, so
 * netting one here would take the sale value out and leave the cost in — which
 * makes a returned pack look like a pure loss and quietly understates margin on
 * every fast mover. Stating it is better than a number nobody can reproduce.
 */
const RETURNS_NOTE =
  'Sale returns are NOT netted here. A credit note reverses the sale value but snapshots no cost basis, so netting it would leave the cost of the returned goods in this report. The Day book and the GST summary do include credit notes.'

// --------------------------------------------------------------- day book ---

function modeOf(invoice: SaleInvoice): string {
  const modes = [...new Set(invoice.payments.map((p) => p.mode))]
  const first = modes[0]
  if (first === undefined) return 'NONE'
  return modes.length === 1 ? first : 'SPLIT'
}

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Credit',
  SPLIT: 'Split', NONE: 'Unpaid', VOIDED: 'Cancelled', RETURN: 'Credit notes',
}

function dayBook(src: ReportSource): ReportBuild {
  const { from, to } = src.query
  const candidates: Candidate[] = []

  for (const invoice of src.invoices) {
    if (!inRange(invoice.invoiceDate, from, to)) continue
    const voided = invoice.status !== 'POSTED'
    // Tendered LESS the change handed back. A cash payment is recorded as what
    // the customer put on the counter, so summing payments alone reports ₹590
    // collected against a ₹589 bill and the day never balances to the drawer.
    const collected = D.sub(
      D.sum(invoice.payments.filter((p) => p.mode !== 'CREDIT').map((p) => dec(p.amount))),
      dec(invoice.changeDue),
    )
    const credit = D.sum(
      invoice.payments.filter((p) => p.mode === 'CREDIT').map((p) => dec(p.amount)),
    )
    const party = invoice.customerName ?? 'Cash customer'
    const mode = voided ? 'VOIDED' : modeOf(invoice)

    candidates.push({
      facet: mode,
      haystack: `${invoice.invoiceNo} ${party} ${invoice.customerPhone ?? ''} ${invoice.operatorName}`.toLowerCase(),
      row: {
        key: `sale-${invoice.id}`,
        ...(voided ? { tone: 'muted' as const } : {}),
        cells: {
          date: invoice.invoiceDate,
          billNo: invoice.invoiceNo,
          party,
          mode: MODE_LABEL[mode] ?? mode,
          lines: count(invoice.quote.lines.length),
          // A cancelled bill keeps its number and its row and contributes
          // nothing to the day's takings. It is never deleted: GSTR-1 Table 13
          // wants a gapless series with an explicit cancelled count, and a
          // deleted bill makes that unreconstructable.
          net: voided ? null : invoice.quote.netAmount,
          collected: voided ? null : money(collected),
          credit: voided ? null : money(credit),
          status: voided ? 'Cancelled' : 'Posted',
        },
      },
    })
  }

  for (const note of src.creditNotes) {
    if (!inRange(note.issuedOn, from, to)) continue
    const party = note.customerName ?? 'Cash customer'
    const refund = D.neg(dec(note.netAmount))
    // A refund settled against the account never reaches the drawer. Carrying
    // it in `collected` reported the day short by the value of the note while
    // the cash in the till was right, and left the account credit at zero.
    const toAccount = note.refundMode === 'CREDIT'
    candidates.push({
      facet: 'RETURN',
      haystack: `${note.creditNoteNo} ${note.invoiceNo} ${party} ${note.reason}`.toLowerCase(),
      row: {
        key: `cn-${note.id}`,
        cells: {
          date: note.issuedOn,
          billNo: note.creditNoteNo,
          party,
          // Cash, UPI or card leaves the drawer by the mode it is paid back in,
          // so the day's collected line carries it as a negative rather than as
          // a separate figure the operator has to subtract in their head.
          mode: `Return · ${MODE_LABEL[note.refundMode] ?? note.refundMode}`,
          lines: count(note.lines.length),
          net: money(refund),
          collected: toAccount ? '0.00' : money(refund),
          credit: toAccount ? money(refund) : '0.00',
          status: 'Credit note',
        },
      },
    })
  }

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'billNo', label: 'Bill no', kind: 'code' },
    { key: 'party', label: 'Customer', kind: 'text' },
    { key: 'mode', label: 'Mode', kind: 'status' },
    { key: 'lines', label: 'Lines', kind: 'count' },
    { key: 'net', label: 'Bill value ₹', kind: 'money', total: true, hint: 'Net of discount, inclusive of GST and round-off' },
    { key: 'collected', label: 'Collected ₹', kind: 'money', total: true, hint: 'Cash, UPI and card taken against this bill' },
    { key: 'credit', label: 'On credit ₹', kind: 'money', total: true, hint: 'Billed to an account, not collected at the counter' },
    { key: 'status', label: 'Status', kind: 'status' },
  ]

  return {
    title: 'Day book',
    question: 'What was billed at the counter, bill by bill, and how much of it was actually collected.',
    basis: [
      'One row per counter voucher: a bill on its invoice date, a credit note on its issue date.',
      'A credit note carries negative values, so the totals below are the day\u2019s NET takings rather than its gross billing.',
      'Cancelled bills are listed and excluded from every total. They are never deleted — the document series has to stay gapless.',
    ],
    notes: [
      `Counter vouchers only. ${src.productName} has no receipt, payment or journal voucher yet, and goods receipts have their own register on Purchases — folding them in here would produce a total that adds money in to money out.`,
      'The closing-cash line a full day book carries needs a counted drawer, which is the day-close document, not this report.',
    ],
    columns,
    candidates,
    facetLabel: 'Payment mode',
    facetOrder: ['CASH', 'UPI', 'CARD', 'CREDIT', 'SPLIT', 'RETURN', 'VOIDED'],
    facetName: (v) => MODE_LABEL[v] ?? v,
    headline: (rows) => [
      headline('Bills', count(rows.filter((r) => r.cells['status'] === 'Posted').length), 'count'),
      headline('Returns', count(rows.filter((r) => r.cells['status'] === 'Credit note').length), 'count', 'Credit notes issued in the range'),
      headline('Billed', money(columnTotal(rows, 'net')), 'money'),
      headline('Collected', money(columnTotal(rows, 'collected')), 'money', 'Cash, UPI and card'),
      headline('On credit', money(columnTotal(rows, 'credit')), 'money', 'Recoverable from accounts'),
      // Counted off the rows on screen like every other tile: a "Cancelled 3"
      // beside a table showing none of them is a figure the reader cannot check.
      headline('Cancelled', count(rows.filter((r) => r.cells['status'] === 'Cancelled').length), 'count', 'Listed, numbered, excluded from totals'),
    ],
  }
}

// --------------------------------------------------------- day-wise sales ---

/** Fixed, never locale-derived: the counter machine and the owner's laptop have
 *  to band the same Tuesday the same way, or the two reports disagree. */
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** UTC, so a machine in another zone puts a bill on the same weekday. */
function dayOfWeek(date: IsoDate): string {
  return DOW[new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay()] ?? '—'
}

/**
 * The month, one row per day.
 *
 * The day book answers "what happened at the counter"; this answers "how is the
 * month going", which is the question that actually drives a re-order and a
 * staffing decision. It is the SAME documents folded one level up — the day
 * book's rows summed by date — so the two foot to each other exactly, and
 * nothing here is a second source of truth.
 *
 * A day with no documents is not a row. Printing zero-rows for a shop that was
 * shut invents trading days, and it is the average that suffers: a month with
 * four Sundays closed reads 13% worse than it traded.
 */
function salesByDay(src: ReportSource): ReportBuild {
  const { from, to } = src.query

  interface Day {
    bills: number
    returns: number
    voided: number
    items: D.Decimal
    taxable: D.Decimal
    tax: D.Decimal
    net: D.Decimal
    collected: D.Decimal
    credit: D.Decimal
  }
  const empty = (): Day => ({
    bills: 0, returns: 0, voided: 0,
    items: D.ZERO, taxable: D.ZERO, tax: D.ZERO, net: D.ZERO, collected: D.ZERO, credit: D.ZERO,
  })
  const byDate = new Map<IsoDate, Day>()
  const at = (date: IsoDate): Day => {
    const day = byDate.get(date) ?? empty()
    byDate.set(date, day)
    return day
  }

  for (const invoice of src.invoices) {
    if (!inRange(invoice.invoiceDate, from, to)) continue
    const day = at(invoice.invoiceDate)
    if (invoice.status !== 'POSTED') {
      // A cancelled bill is counted so the row explains a gap in the series, and
      // contributes nothing to any money column.
      day.voided += 1
      continue
    }
    day.bills += 1
    day.net = D.add(day.net, dec(invoice.quote.netAmount))
    day.taxable = D.add(day.taxable, D.sum(invoice.quote.lines.map((l) => dec(l.taxableValue))))
    day.tax = D.add(day.tax, D.sum(invoice.quote.lines.map((l) => taxOf(l.cgst, l.sgst, l.igst))))
    day.items = D.add(
      day.items,
      D.sum(invoice.quote.lines.flatMap((l) => l.allocations.map((a) => dec(a.qty)))),
    )
    day.collected = D.add(
      day.collected,
      D.sub(
        D.sum(invoice.payments.filter((p) => p.mode !== 'CREDIT').map((p) => dec(p.amount))),
        dec(invoice.changeDue),
      ),
    )
    day.credit = D.add(
      day.credit,
      D.sum(invoice.payments.filter((p) => p.mode === 'CREDIT').map((p) => dec(p.amount))),
    )
  }

  for (const note of src.creditNotes) {
    if (!inRange(note.issuedOn, from, to)) continue
    const day = at(note.issuedOn)
    day.returns += 1
    const refund = dec(note.netAmount)
    day.net = D.sub(day.net, refund)
    day.taxable = D.sub(day.taxable, D.sum(note.lines.map((l) => dec(l.taxableValue))))
    day.tax = D.sub(day.tax, D.sum(note.lines.map((l) => taxOf(l.cgst, l.sgst, l.igst))))
    day.items = D.sub(day.items, D.sum(note.lines.map((l) => dec(l.qty))))
    if (note.refundMode === 'CREDIT') day.credit = D.sub(day.credit, refund)
    else day.collected = D.sub(day.collected, refund)
  }

  const candidates: Candidate[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      facet: dayOfWeek(date),
      haystack: `${date} ${dayOfWeek(date)}`.toLowerCase(),
      row: {
        key: `day-${date}`,
        cells: {
          date,
          dow: dayOfWeek(date),
          bills: count(d.bills),
          returns: count(d.returns),
          voided: count(d.voided),
          items: qty(d.items),
          taxable: money(d.taxable),
          tax: money(d.tax),
          net: money(d.net),
          collected: money(d.collected),
          credit: money(d.credit),
          // An average over zero bills is undefined, not zero: a day with only
          // a credit note on it has takings and no bill to divide by.
          avgBill: d.bills === 0 ? null : money(D.div(d.net, D.dec(d.bills))),
        },
      } satisfies ReportRow,
    }))

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', kind: 'date' },
    /* The weekday as its own column, so it can be grouped on. "Which days are
       worth opening late" is a staffing question a date column cannot answer,
       and banding on this one answers it without a second report. */
    { key: 'dow', label: 'Day', kind: 'status', hint: 'Group on this to compare weekdays across the period' },
    { key: 'bills', label: 'Bills', kind: 'count', total: true },
    { key: 'returns', label: 'Returns', kind: 'count', total: true, hint: 'Credit notes issued that day' },
    { key: 'voided', label: 'Cancelled', kind: 'count', total: true, hint: 'Numbered, kept in the series, excluded from every money column' },
    { key: 'items', label: 'Units', kind: 'qty', total: true, hint: 'Base units billed, net of returns' },
    { key: 'net', label: 'Net sales ₹', kind: 'money', total: true, hint: 'Bill value less credit notes, inclusive of GST' },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true },
    { key: 'tax', label: 'Tax ₹', kind: 'money', total: true },
    { key: 'collected', label: 'Collected ₹', kind: 'money', total: true, hint: 'Cash, UPI and card, less refunds paid out' },
    { key: 'credit', label: 'On credit ₹', kind: 'money', total: true },
    { key: 'avgBill', label: 'Avg bill ₹', kind: 'money', hint: 'Net sales ÷ bills. Not totalled — an average of averages is not an average.' },
  ]

  return {
    title: 'Day-wise sales',
    question: 'How the period traded, day by day — and which days are worth staffing.',
    basis: [
      'The day book folded up one level: the same posted bills on their invoice date and the same credit notes on their issue date, summed by date.',
      'A day with no document at all is not listed. Printing an empty row for a day the shop was shut would drag every average down.',
      'Units are base units billed, net of returned units. Free scheme units are not counted as sold.',
    ],
    notes: [
      `Trading days only — ${src.productName} does not hold shop opening hours or a holiday calendar, so a closed day and a day with no sale look identical here.`,
      'Cancelled bills are counted in their own column so a gap in the bill series has an explanation on the same row, and contribute to no money column.',
    ],
    columns,
    candidates,
    facetLabel: 'Weekday',
    facetOrder: [...DOW],
    facetName: (v) => v,
    headline: (rows) => {
      const net = columnTotal(rows, 'net')
      const bills = columnTotal(rows, 'bills')
      const best = rows.reduce<ReportRow | null>(
        (top, r) => (top === null || D.gt(dec(r.cells['net'] ?? '0'), dec(top.cells['net'] ?? '0')) ? r : top),
        null,
      )
      return [
        headline('Net sales', money(net), 'money', 'Bill value less credit notes'),
        headline('Trading days', count(rows.length), 'count', 'Days with at least one document'),
        headline('Bills', D.toStr(bills, 0), 'count'),
        headline('Per day', rows.length === 0 ? '—' : money(D.div(net, D.dec(rows.length))), 'money', 'Net sales ÷ trading days'),
        headline('Best day', best?.cells['date'] ?? '—', 'text', best ? `₹${best.cells['net'] ?? ''} on ${best.cells['dow'] ?? ''}` : 'No documents in this period'),
        headline('Collected', money(columnTotal(rows, 'collected')), 'money'),
      ]
    },
  }
}

// ------------------------------------------------------------- item sales ---

function itemSales(src: ReportSource): ReportBuild {
  const facts = saleFacts(src)
  const shelf = sellableByMedicine(src.batches, src.today)

  interface Agg {
    brandName: string
    packLabel: string
    hsnCode: string
    manufacturer: string
    qty: D.Decimal
    free: D.Decimal
    taxable: D.Decimal
    net: D.Decimal
    cost: D.Decimal
    bills: Set<number>
  }
  const byMedicine = new Map<number, Agg>()

  for (const f of facts) {
    const medicine = src.medicineFor(f.medicineId)
    const agg = byMedicine.get(f.medicineId) ?? {
      brandName: f.brandName,
      packLabel: f.packLabel,
      hsnCode: f.hsnCode,
      manufacturer: medicine?.manufacturer ?? '—',
      qty: D.ZERO, free: D.ZERO, taxable: D.ZERO, net: D.ZERO, cost: D.ZERO,
      bills: new Set<number>(),
    }
    agg.qty = D.add(agg.qty, f.qty)
    agg.free = D.add(agg.free, f.freeQty)
    agg.taxable = D.add(agg.taxable, f.taxable)
    agg.net = D.add(agg.net, f.lineTotal)
    agg.cost = D.add(agg.cost, f.cost)
    agg.bills.add(f.docId)
    byMedicine.set(f.medicineId, agg)
  }

  const candidates: Candidate[] = [...byMedicine.entries()]
    .map(([medicineId, a]) => {
      const gp = D.sub(a.taxable, a.cost)
      return {
        medicineId,
        a,
        gp,
        row: {
          key: `med-${medicineId}`,
          ...(D.isNeg(gp) ? { tone: 'danger' as const } : {}),
          cells: {
            medicine: a.brandName,
            company: a.manufacturer,
            pack: a.packLabel,
            hsn: a.hsnCode,
            qty: qty(a.qty),
            free: qty(a.free),
            bills: count(a.bills.size),
            net: money(a.net),
            taxable: money(a.taxable),
            cost: money(a.cost),
            gp: money(gp),
            gpPct: ratioPct(gp, a.taxable),
            onHand: qty(shelf.get(medicineId) ?? D.ZERO),
          },
        } satisfies ReportRow,
      }
    })
    .sort((x, y) => D.cmp(y.a.net, x.a.net) || x.medicineId - y.medicineId)
    .map(({ a, row }) => ({
      row,
      facet: a.manufacturer,
      haystack: `${a.brandName} ${a.packLabel} ${a.hsnCode} ${a.manufacturer}`.toLowerCase(),
    }))

  const manufacturers = [...new Set(candidates.map((c) => c.facet))].sort((a, b) => a.localeCompare(b))

  const columns: ReportColumn[] = [
    { key: 'medicine', label: 'Medicine', kind: 'text' },
    /* A column, not only the facet it already was.
       Filtering to one company answers "how did Cipla do"; grouping ON the
       column answers "how did every company do", which is the report an owner
       actually asks for and the one no incumbent gives without a second screen.
       It costs one column here and nothing else — the grouping is derived. */
    { key: 'company', label: 'Company', kind: 'text', hint: 'Manufacturer. Group on this for company-wise sales.' },
    { key: 'pack', label: 'Pack', kind: 'text' },
    { key: 'hsn', label: 'HSN', kind: 'code' },
    { key: 'qty', label: 'Qty sold', kind: 'qty', total: true, hint: 'Base units — tablets, ml, grams' },
    { key: 'free', label: 'Free', kind: 'qty', total: true, hint: 'Scheme units dispensed and not charged' },
    { key: 'bills', label: 'Bills', kind: 'count', hint: 'Distinct bills. Not totalled — one bill can carry many items.' },
    { key: 'net', label: 'Sale value ₹', kind: 'money', total: true, hint: 'Inclusive of GST' },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true, hint: 'Ex-GST' },
    { key: 'cost', label: 'Cost ₹', kind: 'money', total: true, hint: 'Snapshotted on the sale line at post time' },
    { key: 'gp', label: 'GP ₹', kind: 'money', total: true },
    { key: 'gpPct', label: 'GP %', kind: 'pct', hint: 'On ex-GST taxable value' },
    { key: 'onHand', label: 'On hand', kind: 'qty', hint: 'Sellable stock now — "sold 40, have 3" in one glance' },
  ]

  return {
    title: 'Item-wise sales',
    question: 'Which medicines sold, in what quantity, and what each one actually earned.',
    basis: [COST_BASIS, GP_BASIS, 'Quantities are in base units, and free scheme units are shown separately rather than folded into the quantity sold.'],
    notes: [RETURNS_NOTE],
    columns,
    candidates,
    facetLabel: 'Manufacturer',
    facetOrder: manufacturers,
    facetName: (v) => v,
    headline: (rows) => {
      const taxable = columnTotal(rows, 'taxable')
      const gp = columnTotal(rows, 'gp')
      return [
        headline('Items', count(rows.length), 'count'),
        headline('Sale value', money(columnTotal(rows, 'net')), 'money', 'Inclusive of GST'),
        headline('Taxable', money(taxable), 'money'),
        headline('Gross profit', money(gp), 'money'),
        headline('GP %', ratioPct(gp, taxable) ?? '—', 'pct', 'On ex-GST value'),
      ]
    },
  }
}

// ---------------------------------------------------------- batch margin ---

const MARGIN_BANDS = ['neg', 'b0', 'b10', 'b20'] as const
const MARGIN_BAND_LABEL: Record<string, string> = {
  neg: 'Sold at a loss',
  b0: 'Under 10%',
  b10: '10–20%',
  b20: '20% and above',
}

function marginBand(gp: D.Decimal, taxable: D.Decimal): string {
  if (D.isNeg(gp)) return 'neg'
  const pct = ratioPct(gp, taxable)
  if (pct === null) return 'b0'
  const p = D.dec(pct)
  if (D.lt(p, D.dec(10))) return 'b0'
  return D.lt(p, D.dec(20)) ? 'b10' : 'b20'
}

function batchMargin(src: ReportSource): ReportBuild {
  const facts = saleFacts(src)
  const onHandByBatch = new Map<string, D.Decimal>()
  for (const b of src.batches) {
    const key = `${b.medicineId}|${b.batchNo}`
    onHandByBatch.set(key, D.add(onHandByBatch.get(key) ?? D.ZERO, dec(b.qtyOnHand)))
  }

  interface Agg {
    brandName: string
    batchNo: string
    expiryDate: IsoDate
    medicineId: number
    qty: D.Decimal
    free: D.Decimal
    taxable: D.Decimal
    net: D.Decimal
    cost: D.Decimal
  }
  const byBatch = new Map<string, Agg>()

  for (const f of facts) {
    const key = `${f.medicineId}|${f.batchNo}|${f.expiryDate}`
    const agg = byBatch.get(key) ?? {
      brandName: f.brandName, batchNo: f.batchNo, expiryDate: f.expiryDate, medicineId: f.medicineId,
      qty: D.ZERO, free: D.ZERO, taxable: D.ZERO, net: D.ZERO, cost: D.ZERO,
    }
    agg.qty = D.add(agg.qty, f.qty)
    agg.free = D.add(agg.free, f.freeQty)
    agg.taxable = D.add(agg.taxable, f.taxable)
    agg.net = D.add(agg.net, f.lineTotal)
    agg.cost = D.add(agg.cost, f.cost)
    byBatch.set(key, agg)
  }

  const candidates: Candidate[] = [...byBatch.entries()]
    .map(([key, a]) => {
      const gp = D.sub(a.taxable, a.cost)
      const daysLeft = daysBetween(src.today, a.expiryDate)
      return {
        key, a, gp, daysLeft,
        row: {
          key: `batch-${key}`,
          ...(D.isNeg(gp) ? { tone: 'danger' as const } : daysLeft <= 90 ? { tone: 'warning' as const } : {}),
          cells: {
            medicine: a.brandName,
            batch: a.batchNo,
            expiry: a.expiryDate,
            qty: qty(a.qty),
            free: qty(a.free),
            net: money(a.net),
            taxable: money(a.taxable),
            cost: money(a.cost),
            gp: money(gp),
            gpPct: ratioPct(gp, a.taxable),
            onHand: qty(onHandByBatch.get(`${a.medicineId}|${a.batchNo}`) ?? D.ZERO),
          },
        } satisfies ReportRow,
      }
    })
    .sort((x, y) => D.cmp(y.gp, x.gp) || x.key.localeCompare(y.key))
    .map(({ a, gp, row }) => ({
      row,
      facet: marginBand(gp, a.taxable),
      haystack: `${a.brandName} ${a.batchNo}`.toLowerCase(),
    }))

  const columns: ReportColumn[] = [
    { key: 'medicine', label: 'Medicine', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'expiry', label: 'Expiry', kind: 'expiry' },
    { key: 'qty', label: 'Qty sold', kind: 'qty', total: true },
    { key: 'free', label: 'Free', kind: 'qty', total: true },
    { key: 'net', label: 'Sale value ₹', kind: 'money', total: true, hint: 'Inclusive of GST' },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true },
    { key: 'cost', label: 'Cost ₹', kind: 'money', total: true, hint: 'Snapshotted on the sale line at post time' },
    { key: 'gp', label: 'GP ₹', kind: 'money', total: true },
    { key: 'gpPct', label: 'GP %', kind: 'pct', hint: 'On ex-GST taxable value' },
    { key: 'onHand', label: 'On hand', kind: 'qty', hint: 'What is left of this batch now' },
  ]

  return {
    title: 'Batch-wise margin',
    question: 'What each batch actually earned — the only honest grain for pharmacy margin.',
    basis: [
      COST_BASIS,
      GP_BASIS,
      'The grain is the batch, because the same medicine bought in March and in August carries a different landed cost and, across a slab change, possibly a different tax rate.',
      'Free scheme units carry cost but no taxable value, which is why a 10+1 line shows a lower margin here than a rate card suggests.',
    ],
    notes: [
      RETURNS_NOTE,
      'Quarterly turnover discounts, cash discounts and breakage credit notes arrive weeks after the sale, so a same-period margin is structurally optimistic.',
    ],
    columns,
    candidates,
    facetLabel: 'Margin band',
    facetOrder: [...MARGIN_BANDS],
    facetName: (v) => MARGIN_BAND_LABEL[v] ?? v,
    headline: (rows) => {
      const taxable = columnTotal(rows, 'taxable')
      const gp = columnTotal(rows, 'gp')
      return [
        headline('Batches sold', count(rows.length), 'count'),
        headline('Taxable', money(taxable), 'money'),
        headline('Cost', money(columnTotal(rows, 'cost')), 'money'),
        headline('Gross profit', money(gp), 'money'),
        headline('GP %', ratioPct(gp, taxable) ?? '—', 'pct'),
      ]
    },
  }
}

// ------------------------------------------------------------------- GST ---

const supplyLabel = (b2b: boolean): string => (b2b ? 'B2B' : 'B2C')

const DOC_LABEL: Record<DocType, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note' }

/**
 * Rate-wise output tax, and the proof that it foots.
 *
 * The reconciliation is the single most valuable thing on this page. The
 * rate-wise taxable values are grouped from the ALLOCATIONS; the line-wise total
 * is folded from `QuoteLine.taxableValue`, which the quote engine computed by a
 * different path. If those two disagree by a paisa, a bill was stored whose
 * lines do not add up to its own allocations, and the return built on it is
 * wrong. `domain/gst` takes every split as a residual so this cannot drift by
 * construction — which is exactly why a difference means data damage.
 */
function gstRateSummary(src: ReportSource): ReportBuild {
  const facts = taxFacts(src)

  interface Agg {
    rate: string
    b2b: boolean
    docType: DocType
    taxable: D.Decimal
    cgst: D.Decimal
    sgst: D.Decimal
    igst: D.Decimal
    total: D.Decimal
    lines: number
    docs: Set<string>
  }
  const byKey = new Map<string, Agg>()
  for (const f of facts) {
    const key = `${f.gstRatePct}|${f.b2b ? 'B' : 'C'}|${f.docType}`
    const agg = byKey.get(key) ?? {
      rate: f.gstRatePct, b2b: f.b2b, docType: f.docType,
      taxable: D.ZERO, cgst: D.ZERO, sgst: D.ZERO, igst: D.ZERO, total: D.ZERO,
      lines: 0, docs: new Set<string>(),
    }
    agg.taxable = D.add(agg.taxable, f.taxable)
    agg.cgst = D.add(agg.cgst, f.cgst)
    agg.sgst = D.add(agg.sgst, f.sgst)
    agg.igst = D.add(agg.igst, f.igst)
    agg.total = D.add(agg.total, f.lineTotal)
    agg.lines += 1
    agg.docs.add(f.docNo)
    byKey.set(key, agg)
  }

  const candidates: Candidate[] = [...byKey.values()]
    // B2B first at each rate, the order GSTR-1 itself is laid out in.
    .sort((a, b) =>
      Number(a.rate) - Number(b.rate)
      || Number(b.b2b) - Number(a.b2b)
      || a.docType.localeCompare(b.docType))
    .map((a) => ({
      facet: supplyLabel(a.b2b),
      haystack: `${a.rate} ${supplyLabel(a.b2b)} ${DOC_LABEL[a.docType]}`.toLowerCase(),
      row: {
        key: `rate-${a.rate}-${supplyLabel(a.b2b)}-${a.docType}`,
        ...(a.docType === 'CREDIT_NOTE' ? { tone: 'warning' as const } : {}),
        cells: {
          rate: a.rate,
          supply: supplyLabel(a.b2b),
          doc: DOC_LABEL[a.docType],
          docs: count(a.docs.size),
          lines: count(a.lines),
          taxable: money(a.taxable),
          cgst: money(a.cgst),
          sgst: money(a.sgst),
          igst: money(a.igst),
          tax: money(D.sum([a.cgst, a.sgst, a.igst])),
          total: money(a.total),
        },
      },
    }))

  const columns: ReportColumn[] = [
    { key: 'rate', label: 'Rate %', kind: 'pct' },
    { key: 'supply', label: 'Supply', kind: 'status', hint: 'B2B is a buyer holding a GSTIN; everything else is B2C' },
    { key: 'doc', label: 'Document', kind: 'status', hint: 'Credit notes carry negative values and reverse the tax that was charged' },
    { key: 'docs', label: 'Documents', kind: 'count', hint: 'Distinct bills or notes. Not totalled — one bill can carry several rates.' },
    { key: 'lines', label: 'Lines', kind: 'count', total: true },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true },
    { key: 'cgst', label: 'CGST ₹', kind: 'money', total: true },
    { key: 'sgst', label: 'SGST ₹', kind: 'money', total: true },
    { key: 'igst', label: 'IGST ₹', kind: 'money', total: true },
    { key: 'tax', label: 'Tax ₹', kind: 'money', total: true },
    { key: 'total', label: 'Invoice value ₹', kind: 'money', total: true, hint: 'Taxable plus tax, before bill round-off' },
  ]

  return {
    title: 'GST rate-wise summary',
    question: 'What output tax was charged at each rate, and does it reconcile to the documents it came from.',
    basis: [
      'Posted bills on the invoice date and credit notes on their issue date. Cancelled bills contribute nothing.',
      'The rate is the one resolved on the INVOICE DATE, never the rate the batch was purchased at. Slabs move — the September 2025 Council revision moved much of a pharmacy catalogue down a band — and a bill reprinted from before a change must still show the rate that was actually charged.',
      'Taxable value is back-calculated out of the GST-inclusive MRP and each tax is taken as a residual, so taxable + CGST + SGST always equals what the customer actually paid.',
    ],
    notes: [
      `This is the working, not the return. ${src.productName} does not generate the GSTR-1 JSON or the GSTN workbook, and does not split B2CL from B2CS — that threshold is recorded in docs/UNVERIFIED.md and is not asserted anywhere in this screen.`,
      'Round-off sits on the bill, not on a rate, so the invoice-value column can differ from the sum of the bills by the rounding on each one.',
    ],
    columns,
    candidates,
    facetLabel: 'Supply',
    facetOrder: ['B2B', 'B2C'],
    facetName: (v) => (v === 'B2B' ? 'B2B — registered buyer' : 'B2C — counter'),
    headline: (rows) => [
      headline('Taxable', money(columnTotal(rows, 'taxable')), 'money'),
      headline('CGST', money(columnTotal(rows, 'cgst')), 'money'),
      headline('SGST', money(columnTotal(rows, 'sgst')), 'money'),
      headline('IGST', money(columnTotal(rows, 'igst')), 'money'),
      headline('Invoice value', money(columnTotal(rows, 'total')), 'money'),
    ],
    checks: (rows) => {
      // Restricted to the rows on screen, so the proof stays true under a filter.
      // A proof that only holds on the unfiltered view is not a proof.
      const shown = new Set(
        rows.map((r) => `${r.cells['rate'] ?? ''}|${r.cells['supply'] ?? ''}|${r.cells['doc'] ?? ''}`),
      )
      const b2bByInvoice = new Map(
        facts.filter((f) => f.docType === 'INVOICE').map((f) => [f.docId, f.b2b]),
      )
      const b2bByNote = new Map(
        facts.filter((f) => f.docType === 'CREDIT_NOTE').map((f) => [f.docId, f.b2b]),
      )

      let lineTaxable = D.ZERO
      let lineTax = D.ZERO
      let lines = 0

      for (const invoice of src.invoices) {
        if (invoice.status !== 'POSTED') continue
        if (!inRange(invoice.invoiceDate, src.query.from, src.query.to)) continue
        const supply = supplyLabel(b2bByInvoice.get(invoice.id) ?? false)
        for (const line of invoice.quote.lines) {
          // Every allocation on a line shares the line's HSN and the bill's
          // date, so the first one carries the whole line's rate.
          const first = line.allocations[0]
          if (first === undefined) continue
          if (!shown.has(`${first.gstRatePct}|${supply}|${DOC_LABEL.INVOICE}`)) continue
          lineTaxable = D.add(lineTaxable, dec(line.taxableValue))
          lineTax = D.add(lineTax, taxOf(line.cgst, line.sgst, line.igst))
          lines += 1
        }
      }

      for (const note of src.creditNotes) {
        if (!inRange(note.issuedOn, src.query.from, src.query.to)) continue
        const supply = supplyLabel(b2bByNote.get(note.id) ?? false)
        for (const line of note.lines) {
          if (!shown.has(`${line.gstRatePct}|${supply}|${DOC_LABEL.CREDIT_NOTE}`)) continue
          lineTaxable = D.sub(lineTaxable, dec(line.taxableValue))
          lineTax = D.sub(lineTax, taxOf(line.cgst, line.sgst, line.igst))
          lines += 1
        }
      }

      const rateTaxable = columnTotal(rows, 'taxable')
      const rateTax = columnTotal(rows, 'tax')
      return [
        {
          label: 'Taxable value',
          leftLabel: `Sum of the ${rows.length} rate row${rows.length === 1 ? '' : 's'} above`,
          left: money(rateTaxable),
          rightLabel: `Sum of the ${lines} document line${lines === 1 ? '' : 's'} behind them`,
          right: money(lineTaxable),
          difference: money(D.sub(rateTaxable, lineTaxable)),
          balanced: D.eq(rateTaxable, lineTaxable),
          explain: 'The rate rows are grouped from batch allocations; the document lines were totalled by the quote engine on the way in. Both describe the same supplies, so they must agree to the paisa.',
        },
        {
          label: 'Tax',
          leftLabel: 'CGST + SGST + IGST across the rate rows',
          left: money(rateTax),
          rightLabel: 'Tax on the document lines behind them',
          right: money(lineTax),
          difference: money(D.sub(rateTax, lineTax)),
          balanced: D.eq(rateTax, lineTax),
          explain: 'Tax is taken as a residual of the inclusive amount and never recomputed from the taxable value, so a gap here is damaged data rather than rounding.',
        },
      ]
    },
  }
}

/**
 * UQC, mapped from the base unit.
 *
 * NOT VERIFIED against the GSTN unit-quantity-code list — the codes below are
 * the conventional ones and the report says so on screen. See docs/UNVERIFIED.md.
 */
const UQC: Record<string, string> = {
  TAB: 'NOS', CAP: 'NOS', ML: 'MLT', GM: 'GMS',
  BOTTLE: 'BTL', VIAL: 'VLS', TUBE: 'TUB', UNIT: 'NOS',
}

function hsnSummary(src: ReportSource): ReportBuild {
  const facts = taxFacts(src)
  const uqcOf = (f: TaxFact): string => UQC[src.medicineFor(f.medicineId)?.baseUom ?? ''] ?? 'NOS'
  /** The row a fact lands in. Shared with the reconciliation so the proof can
   *  restrict itself to exactly the rows the reader can see. */
  const rowKey = (f: TaxFact): string =>
    `${f.hsnCode}|${f.gstRatePct}|${supplyLabel(f.b2b)}|${uqcOf(f)}`

  interface Agg {
    hsn: string
    rate: string
    b2b: boolean
    uqc: string
    qty: D.Decimal
    taxable: D.Decimal
    cgst: D.Decimal
    sgst: D.Decimal
    igst: D.Decimal
    total: D.Decimal
  }
  const byKey = new Map<string, Agg>()
  for (const f of facts) {
    const key = rowKey(f)
    const agg = byKey.get(key) ?? {
      hsn: f.hsnCode, rate: f.gstRatePct, b2b: f.b2b, uqc: uqcOf(f),
      qty: D.ZERO, taxable: D.ZERO, cgst: D.ZERO, sgst: D.ZERO, igst: D.ZERO, total: D.ZERO,
    }
    // Free scheme units are supplied and must be declared in the quantity even
    // though they carry no taxable value.
    agg.qty = D.add(agg.qty, D.add(f.qty, f.freeQty))
    agg.taxable = D.add(agg.taxable, f.taxable)
    agg.cgst = D.add(agg.cgst, f.cgst)
    agg.sgst = D.add(agg.sgst, f.sgst)
    agg.igst = D.add(agg.igst, f.igst)
    agg.total = D.add(agg.total, f.lineTotal)
    byKey.set(key, agg)
  }

  const candidates: Candidate[] = [...byKey.values()]
    .sort((a, b) =>
      a.hsn.localeCompare(b.hsn)
      || Number(a.rate) - Number(b.rate)
      || Number(b.b2b) - Number(a.b2b))
    .map((a) => ({
      facet: supplyLabel(a.b2b),
      haystack: `${a.hsn} ${a.rate} ${a.uqc}`.toLowerCase(),
      row: {
        key: `hsn-${a.hsn}-${a.rate}-${supplyLabel(a.b2b)}-${a.uqc}`,
        cells: {
          hsn: a.hsn,
          supply: supplyLabel(a.b2b),
          uqc: a.uqc,
          qty: qty(a.qty),
          rate: a.rate,
          taxable: money(a.taxable),
          cgst: money(a.cgst),
          sgst: money(a.sgst),
          igst: money(a.igst),
          total: money(a.total),
        },
      },
    }))

  const columns: ReportColumn[] = [
    { key: 'hsn', label: 'HSN', kind: 'code' },
    { key: 'supply', label: 'Supply', kind: 'status', hint: 'Table 12 has been split into B2B and B2C tabs since the May 2025 return period' },
    { key: 'uqc', label: 'UQC', kind: 'code', hint: 'Mapped from the base unit and NOT verified against the GSTN code list' },
    { key: 'qty', label: 'Qty', kind: 'qty', total: true, hint: 'Base units, free scheme units included' },
    { key: 'rate', label: 'Rate %', kind: 'pct' },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true },
    { key: 'cgst', label: 'CGST ₹', kind: 'money', total: true },
    { key: 'sgst', label: 'SGST ₹', kind: 'money', total: true },
    { key: 'igst', label: 'IGST ₹', kind: 'money', total: true },
    { key: 'total', label: 'Total ₹', kind: 'money', total: true },
  ]

  return {
    title: 'HSN summary',
    question: 'The HSN-wise working behind GSTR-1 Table 12, split the way the portal now wants it.',
    basis: [
      'One row per HSN × rate × supply type. Quantity includes free scheme units, which are supplied even though they carry no value.',
      'Credit notes are netted into the row they reverse, so a returned pack reduces both the quantity and the value here. The GSTN offline tool takes negative figures in the HSN sheet for exactly this reason.',
      'The HSN is the one stored on the medicine master, as it was billed.',
    ],
    notes: [
      'No description column, deliberately. Table 12 auto-populates "Description as per HSN Code" from the portal\'s own HSN master and manual entry is disabled — a description invented here would be a second, wrong source of truth.',
      `The required HSN digit length depends on the store\'s annual turnover, which ${src.productName} does not hold. Nothing here is padded or truncated to a digit count — check the requirement before filing (docs/UNVERIFIED.md).`,
    ],
    columns,
    candidates,
    facetLabel: 'Supply',
    facetOrder: ['B2B', 'B2C'],
    facetName: (v) => (v === 'B2B' ? 'B2B tab' : 'B2C tab'),
    headline: (rows) => [
      headline('HSN rows', count(rows.length), 'count'),
      headline('Quantity', qty(columnTotal(rows, 'qty')), 'qty'),
      headline('Taxable', money(columnTotal(rows, 'taxable')), 'money'),
      headline('Tax', money(D.sum([columnTotal(rows, 'cgst'), columnTotal(rows, 'sgst'), columnTotal(rows, 'igst')])), 'money'),
      headline('Total', money(columnTotal(rows, 'total')), 'money'),
    ],
    checks: (rows) => {
      // Restricted to the rows on screen by their FULL identity, not by supply
      // type. Matching on the supply alone compared the HSN rows left after a
      // search against every supply of that type, so filtering to one HSN
      // reported the rest of the period as an out-of-balance difference —
      // "damaged data" in red, on data that was never damaged.
      const shown = new Set(rows.map((r) => [
        r.cells['hsn'] ?? '', r.cells['rate'] ?? '', r.cells['supply'] ?? '', r.cells['uqc'] ?? '',
      ].join('|')))
      const rateWise = D.sum(
        facts.filter((f) => shown.has(rowKey(f))).map((f) => f.taxable),
      )
      const hsnWise = columnTotal(rows, 'taxable')
      return [{
        label: 'Taxable value',
        leftLabel: 'Sum of the HSN rows above',
        left: money(hsnWise),
        rightLabel: 'Rate-wise taxable for the same supplies',
        right: money(rateWise),
        difference: money(D.sub(hsnWise, rateWise)),
        balanced: D.eq(hsnWise, rateWise),
        explain: 'The portal cross-validates Table 12 against the rate-wise tables. Grouping the same supplies by HSN instead of by rate must not change their total.',
      }]
    },
  }
}

// ------------------------------------------------------- purchase register ---

const PURCHASE_FACETS = ['unpaid', 'part', 'paid', 'cancelled'] as const
const PURCHASE_FACET_LABEL: Record<string, string> = {
  unpaid: 'Nothing paid yet',
  part: 'Part paid',
  paid: 'Settled',
  cancelled: 'Cancelled',
}

/**
 * Inward supplies, bill by bill — the working behind input tax credit.
 *
 * The counterpart of the GST rate-wise summary, and the report an accountant
 * asks for in the same breath: what came in, what tax came in with it, and what
 * is still owed on it. It is deliberately NOT called an ITC report. What is
 * claimable depends on the supplier having filed, on the goods having been
 * received, and on the credit appearing in GSTR-2B — none of which this shop's
 * own records can know. So this prints the tax that was RECORDED and says
 * exactly that, rather than asserting a claim.
 */
function purchaseRegister(src: ReportSource): ReportBuild {
  const { from, to } = src.query
  const termsBySupplier = new Map(src.suppliers.map((s) => [s.id, s.paymentTermsDays]))

  const candidates: Candidate[] = src.purchases
    .filter((p) => inRange(p.invoiceDate, from, to))
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.purchaseNo.localeCompare(b.purchaseNo))
    .map((p) => {
      const cancelled = p.status !== 'POSTED'
      const net = dec(p.netAmount)
      const paid = dec(p.amountPaid)
      const balance = D.sub(net, paid)
      const tax = taxOf(p.cgst, p.sgst, p.igst)
      const facet = cancelled
        ? 'cancelled'
        : !D.gt(paid, D.ZERO) ? 'unpaid' : D.gt(balance, D.ZERO) ? 'part' : 'paid'
      const due = addDays(p.invoiceDate, termsBySupplier.get(p.supplierId) ?? 0)
      const overdue = D.gt(balance, D.ZERO) && due < src.today

      return {
        facet,
        haystack: `${p.purchaseNo} ${p.supplierInvoiceNo} ${p.supplierName}`.toLowerCase(),
        row: {
          key: `pur-${p.id}`,
          ...(cancelled ? { tone: 'muted' as const } : overdue ? { tone: 'warning' as const } : {}),
          cells: {
            date: p.invoiceDate,
            grn: p.purchaseNo,
            billNo: p.supplierInvoiceNo,
            supplier: p.supplierName,
            lines: count(p.lines.length),
            // A cancelled receipt keeps its row and contributes nothing, for the
            // same reason a voided bill does: the series has to stay explicable.
            taxable: cancelled ? null : p.taxableValue,
            cgst: cancelled ? null : p.cgst,
            sgst: cancelled ? null : p.sgst,
            igst: cancelled ? null : p.igst,
            tax: cancelled ? null : money(tax),
            freight: cancelled ? null : p.freight,
            net: cancelled ? null : p.netAmount,
            paid: cancelled ? null : p.amountPaid,
            balance: cancelled ? null : money(balance),
            due: cancelled ? null : due,
            status: cancelled
              ? 'Cancelled'
              : !D.gt(balance, D.ZERO) ? 'Settled' : overdue ? 'Overdue' : D.gt(paid, D.ZERO) ? 'Part paid' : 'Unpaid',
          },
        } satisfies ReportRow,
      }
    })

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Bill date', kind: 'date' },
    { key: 'billNo', label: 'Supplier bill', kind: 'code', hint: 'The number printed on the supplier’s own invoice — what GSTR-2B is matched on' },
    { key: 'supplier', label: 'Supplier', kind: 'text', hint: 'Group on this for supplier-wise purchases' },
    { key: 'grn', label: 'Receipt no', kind: 'code', hint: 'This shop’s goods-receipt number' },
    { key: 'lines', label: 'Lines', kind: 'count', total: true },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true, hint: 'Ex-GST value of the goods as recorded' },
    { key: 'cgst', label: 'CGST ₹', kind: 'money', total: true },
    { key: 'sgst', label: 'SGST ₹', kind: 'money', total: true },
    { key: 'igst', label: 'IGST ₹', kind: 'money', total: true },
    { key: 'tax', label: 'Tax ₹', kind: 'money', total: true, hint: 'Recorded input tax. NOT a claim — see the caveats.' },
    { key: 'freight', label: 'Freight ₹', kind: 'money', total: true, hint: 'Apportioned across the lines by value, so landed cost carries it' },
    { key: 'net', label: 'Bill value ₹', kind: 'money', total: true },
    { key: 'paid', label: 'Paid ₹', kind: 'money', total: true },
    { key: 'balance', label: 'Balance ₹', kind: 'money', total: true },
    { key: 'due', label: 'Due on', kind: 'date', hint: 'Bill date plus the payment terms on the supplier master' },
    { key: 'status', label: 'Status', kind: 'status' },
  ]

  return {
    title: 'Purchase register',
    question: 'What came in this period, what tax came in with it, and what is still owed on it.',
    basis: [
      'One row per goods receipt on the SUPPLIER’S bill date, which is the date the return is matched on — not the date the stock was keyed in.',
      'Every figure is as recorded on the receipt. Freight is shown separately even though it is apportioned into landed cost, because it carries no input tax of its own here.',
      'Cancelled receipts are listed and excluded from every total.',
    ],
    notes: [
      `This is the inward register, NOT an input-tax-credit claim. Whether a credit is available depends on the supplier having filed and on the entry appearing in GSTR-2B, and ${src.productName} reads neither — it can only report the tax the bill recorded.`,
      `${src.productName} posts no supplier payment document yet, so "paid" is whatever was recorded against the receipt itself.`,
      'Purchase returns and expiry claims are not netted here. A debit note reduces what is owed and an expiry claim does not, so folding either into this register would misstate one of them; both are on the Purchases screen.',
    ],
    columns,
    candidates,
    facetLabel: 'Settlement',
    facetOrder: [...PURCHASE_FACETS],
    facetName: (v) => PURCHASE_FACET_LABEL[v] ?? v,
    headline: (rows) => [
      headline('Bills', count(rows.filter((r) => r.cells['status'] !== 'Cancelled').length), 'count'),
      headline('Taxable', money(columnTotal(rows, 'taxable')), 'money', 'Ex-GST, as recorded'),
      headline('Input tax', money(columnTotal(rows, 'tax')), 'money', 'Recorded on the bills — not a claim'),
      headline('Bill value', money(columnTotal(rows, 'net')), 'money'),
      headline('Still owed', money(columnTotal(rows, 'balance')), 'money', 'Across the receipts in this period only'),
    ],
    checks: (rows) => {
      // The register foots to the documents behind it the same way the GST
      // summary does: taxable + tax + freight + round-off must be the bill.
      const shown = new Set(rows.map((r) => r.cells['grn'] ?? ''))
      const posted = src.purchases.filter(
        (p) => p.status === 'POSTED' && inRange(p.invoiceDate, from, to) && shown.has(p.purchaseNo),
      )
      const parts = D.sum(posted.map((p) => D.sum([
        dec(p.taxableValue), taxOf(p.cgst, p.sgst, p.igst), dec(p.freight), dec(p.roundOff),
      ])))
      const nets = D.sum(posted.map((p) => dec(p.netAmount)))
      return [{
        label: 'Bill value',
        leftLabel: 'Taxable + tax + freight + round-off',
        left: money(parts),
        rightLabel: `Net amount on the ${posted.length} receipt${posted.length === 1 ? '' : 's'}`,
        right: money(nets),
        difference: money(D.sub(parts, nets)),
        balanced: D.eq(parts, nets),
        explain: 'A goods receipt stores its own net amount as well as the parts it was built from. If those two disagree, the receipt was written by something that did not use the purchase engine.',
      }]
    },
  }
}

// ------------------------------------------------------- Schedule H1 register ---

function h1Register(src: ReportSource): ReportBuild {
  const { from, to } = src.query
  interface Entry {
    date: IsoDate
    invoiceNo: string
    prescriber: string | null
    prescriberAddress: string | null
    regNo: string | null
    patient: string | null
    patientAddress: string | null
    drug: string
    batchNo: string
    expiry: IsoDate
    qty: D.Decimal
  }
  const entries: Entry[] = []

  for (const invoice of src.invoices) {
    if (invoice.status !== 'POSTED') continue
    if (!inRange(invoice.invoiceDate, from, to)) continue
    for (const line of invoice.quote.lines) {
      if (line.drugSchedule !== 'H1') continue
      for (const a of line.allocations) {
        const rx = invoice.prescription
        entries.push({
          date: invoice.invoiceDate,
          invoiceNo: invoice.invoiceNo,
          // Null, never a dash character: a blank in a statutory register is a
          // field nobody captured, and it has to export as blank rather than as
          // a punctuation mark an inspector reads as an entry.
          prescriber: rx?.prescriberName ?? null,
          prescriberAddress: rx?.prescriberAddress ?? null,
          regNo: rx?.prescriberRegNo ?? null,
          patient: rx?.patientName ?? null,
          patientAddress: rx?.patientAddress ?? null,
          drug: `${line.brandName} ${line.packLabel}`.trim(),
          batchNo: a.batchNo,
          expiry: a.expiryDate,
          qty: dec(a.qty),
        })
      }
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.invoiceNo.localeCompare(b.invoiceNo))

  const candidates: Candidate[] = entries.map((e, i) => ({
    // An entry with no prescriber on it opts out of the facet rather than
    // becoming a prescriber called '—'.
    facet: e.prescriber ?? '',
    haystack: `${e.prescriber ?? ''} ${e.patient ?? ''} ${e.drug} ${e.batchNo} ${e.invoiceNo}`.toLowerCase(),
    row: {
      key: `h1-${e.invoiceNo}-${e.batchNo}-${i}`,
      cells: {
        sl: count(i + 1),
        date: e.date,
        prescriber: e.prescriber,
        prescriberAddress: e.prescriberAddress,
        regNo: e.regNo,
        patient: e.patient,
        patientAddress: e.patientAddress,
        drug: e.drug,
        batch: e.batchNo,
        expiry: e.expiry,
        qty: qty(e.qty),
        billNo: e.invoiceNo,
      },
    },
  }))

  const prescribers = [...new Set(candidates.map((c) => c.facet))]
    .filter((v) => v !== '')
    .sort((a, b) => a.localeCompare(b))

  // Annexure IV column ORDER, kept exactly: an inspector reads down the page
  // they know, and a register in a different order reads as a different register.
  // Its third and fourth columns are the prescriber and the patient WITH their
  // addresses — the rule names the prescriber's address in its own text — so both
  // are carried here. Dropping them would print a register that looks complete
  // and is two statutory fields short.
  const columns: ReportColumn[] = [
    { key: 'sl', label: 'Sl. no', kind: 'count' },
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'prescriber', label: 'Prescriber', kind: 'text' },
    { key: 'prescriberAddress', label: 'Prescriber address', kind: 'text', hint: 'Rule 65(3)(1)(h) names the prescriber\u2019s address; blank where the counter did not capture one' },
    { key: 'regNo', label: 'Reg. no', kind: 'code' },
    { key: 'patient', label: 'Patient', kind: 'text' },
    { key: 'patientAddress', label: 'Patient address', kind: 'text', hint: 'Annexure IV asks for the patient\u2019s address alongside the name' },
    { key: 'drug', label: 'Drug', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'expiry', label: 'Expiry', kind: 'expiry' },
    { key: 'qty', label: 'Qty', kind: 'qty', total: true },
    { key: 'billNo', label: 'Bill no', kind: 'code' },
  ]

  return {
    title: 'Schedule H1 register',
    question: 'Every Schedule H1 supply, in the column order an inspector expects.',
    basis: [
      'Rule 65(3)(1)(h) requires a separate register of Schedule H1 supplies carrying the prescriber, the patient, the drug and the quantity.',
      'This is a projection of what was captured at the counter, not a second set of books — the bill number ties every line back to its document.',
    ],
    notes: [
      `The serial number restarts at 1 for the range shown. ${src.productName} does not yet keep a permanent register serial, so this column is a reading aid, not the statutory serial.`,
      'An address column is blank wherever the counter did not capture one. The register cannot invent it, and a blank is what tells you which bill to go back to.',
      'The retention period for this register is recorded as unverified in docs/UNVERIFIED.md — confirm it against the gazette before relying on any range shown here.',
    ],
    columns,
    candidates,
    facetLabel: 'Prescriber',
    facetOrder: prescribers,
    facetName: (v) => v,
    headline: (rows) => [
      headline('Entries', count(rows.length), 'count'),
      headline('Units supplied', qty(columnTotal(rows, 'qty')), 'qty'),
      headline('Prescribers', count(new Set(rows.map((r) => r.cells['prescriber'] ?? '')).size), 'count'),
      headline('Bills', count(new Set(rows.map((r) => r.cells['billNo'] ?? '')).size), 'count'),
    ],
  }
}

// ------------------------------------------------------------- outstanding ---

/** One unsettled document, oldest first, as the balance is walked back. */
export interface OpenItem {
  date: IsoDate
  /** Bill date plus agreed terms, or the bill date when no term is on file. */
  dueDate: IsoDate
  ref: string
  amount: D.Decimal
}

interface Aged {
  notDue: D.Decimal
  d30: D.Decimal
  d60: D.Decimal
  d90: D.Decimal
  older: D.Decimal
  unmatched: D.Decimal
  oldest: OpenItem | null
  maxOverdue: number
}

/**
 * Age a party balance against the documents behind it.
 *
 * RxBill has no receipt-to-invoice matching, so the balance is applied against
 * the NEWEST documents first — the standard assumption that the oldest bills
 * were settled first. Whatever the documents cannot account for is reported as
 * `unmatched` rather than quietly dropped into the oldest bucket: an ageing
 * report that invents an age is exactly the report people stop trusting.
 *
 * Buckets are days past the DUE date wherever a payment term is on file, which
 * is the classic complaint about ageing reports that bucket on the bill date.
 */
export function ageBalance(balance: D.Decimal, items: readonly OpenItem[], asOn: IsoDate): Aged {
  const aged: Aged = {
    notDue: D.ZERO, d30: D.ZERO, d60: D.ZERO, d90: D.ZERO, older: D.ZERO,
    unmatched: D.ZERO, oldest: null, maxOverdue: 0,
  }
  if (!D.gt(balance, D.ZERO)) return aged

  let left = balance
  const newestFirst = [...items].sort((a, b) => b.date.localeCompare(a.date))
  for (const item of newestFirst) {
    if (!D.gt(left, D.ZERO)) break
    const applied = D.min(left, item.amount)
    if (!D.gt(applied, D.ZERO)) continue
    left = D.sub(left, applied)

    const overdue = daysBetween(item.dueDate, asOn)
    if (overdue <= 0) aged.notDue = D.add(aged.notDue, applied)
    else if (overdue <= 30) aged.d30 = D.add(aged.d30, applied)
    else if (overdue <= 60) aged.d60 = D.add(aged.d60, applied)
    else if (overdue <= 90) aged.d90 = D.add(aged.d90, applied)
    else aged.older = D.add(aged.older, applied)

    aged.oldest = item
    if (overdue > aged.maxOverdue) aged.maxOverdue = overdue
  }
  aged.unmatched = left
  return aged
}

const AGE_COLUMNS: ReportColumn[] = [
  { key: 'notDue', label: 'Not due ₹', kind: 'money', total: true },
  { key: 'd30', label: '1–30 ₹', kind: 'money', total: true },
  { key: 'd60', label: '31–60 ₹', kind: 'money', total: true },
  { key: 'd90', label: '61–90 ₹', kind: 'money', total: true },
  { key: 'older', label: '90+ ₹', kind: 'money', total: true },
  { key: 'unmatched', label: 'Unmatched ₹', kind: 'money', total: true, hint: 'Balance older than any document on file — carried forward, not aged' },
]

const ageCells = (a: Aged): Record<string, string> => ({
  notDue: money(a.notDue),
  d30: money(a.d30),
  d60: money(a.d60),
  d90: money(a.d90),
  older: money(a.older),
  unmatched: money(a.unmatched),
})

const OVERDUE_FACETS = ['due', 'over60', 'limit'] as const
const OVERDUE_LABEL: Record<string, string> = {
  due: 'Anything overdue',
  over60: 'Overdue past 60 days',
  limit: 'Over the credit limit',
}

function customerOutstanding(src: ReportSource): ReportBuild {
  const asOn = src.query.to
  const byCustomer = new Map<number, OpenItem[]>()

  for (const invoice of src.invoices) {
    if (invoice.status !== 'POSTED') continue
    if (invoice.customerId === null) continue
    if (invoice.invoiceDate > asOn) continue
    const credit = D.sum(
      invoice.payments.filter((p) => p.mode === 'CREDIT').map((p) => dec(p.amount)),
    )
    if (!D.gt(credit, D.ZERO)) continue
    const items = byCustomer.get(invoice.customerId) ?? []
    // No credit-days term on the customer master, so the bill date IS the due
    // date here. The basis line says so rather than implying a term exists.
    items.push({ date: invoice.invoiceDate, dueDate: invoice.invoiceDate, ref: invoice.invoiceNo, amount: credit })
    byCustomer.set(invoice.customerId, items)
  }

  const candidates: Candidate[] = src.customers
    .map((c) => {
      const items = byCustomer.get(c.id) ?? []
      const balance = dec(c.outstanding)
      const aged = ageBalance(balance, items, asOn)
      const limit = dec(c.creditLimit)
      const overLimit = D.gt(limit, D.ZERO) && D.gt(balance, limit)
      const overdue = D.sum([aged.d30, aged.d60, aged.d90, aged.older])
      return { c, items, balance, aged, overLimit, overdue }
    })
    // A settled account is not outstanding. Listing every customer who has ever
    // taken credit turns the report into a customer master with zeroes in it.
    .filter((r) => D.gt(r.balance, D.ZERO))
    .sort((a, b) => D.cmp(b.balance, a.balance) || a.c.id - b.c.id)
    .map(({ c, items, balance, aged, overLimit, overdue }) => ({
      facet: overLimit ? 'limit' : aged.maxOverdue > 60 ? 'over60' : D.gt(overdue, D.ZERO) ? 'due' : '',
      haystack: `${c.name} ${c.phone} ${c.gstin ?? ''}`.toLowerCase(),
      row: {
        key: `cust-${c.id}`,
        ...(overLimit || aged.maxOverdue > 90 ? { tone: 'danger' as const } : aged.maxOverdue > 60 ? { tone: 'warning' as const } : {}),
        cells: {
          party: c.name,
          phone: c.phone,
          limit: c.creditLimit,
          balance: money(balance),
          ...ageCells(aged),
          oldest: aged.oldest?.date ?? null,
          bills: count(items.length),
          status: overLimit ? 'Over limit' : aged.maxOverdue > 60 ? `${aged.maxOverdue}d overdue` : 'Within terms',
        },
      },
    }))

  const columns: ReportColumn[] = [
    { key: 'party', label: 'Customer', kind: 'text' },
    { key: 'phone', label: 'Phone', kind: 'code' },
    { key: 'limit', label: 'Credit limit ₹', kind: 'money' },
    { key: 'balance', label: 'Balance ₹', kind: 'money', total: true, hint: 'The account balance carried on the customer master' },
    ...AGE_COLUMNS,
    { key: 'oldest', label: 'Oldest credit bill', kind: 'date' },
    { key: 'bills', label: 'Credit bills', kind: 'count' },
    { key: 'status', label: 'Status', kind: 'status' },
  ]

  return {
    title: 'Customer outstanding',
    question: 'Who owes the shop money, how old it is, and who is past their limit.',
    basis: [
      `Aged as on ${asOn}.`,
      'The customer master carries a credit limit but no credit-days term, so buckets count days since the BILL date. A term would move every boundary, which is why this is stated rather than assumed.',
      'The balance is applied against the newest credit bills first, on the standard assumption that older bills were settled first. Anything the bills cannot account for is shown as unmatched, never aged into the oldest bucket.',
    ],
    notes: [
      `${src.productName} posts no receipt document yet, so nothing here is a receipt-to-invoice match. When receipts land, this report should age open documents directly and this basis line goes away.`,
    ],
    columns,
    candidates,
    facetLabel: 'Attention',
    facetOrder: [...OVERDUE_FACETS],
    facetName: (v) => OVERDUE_LABEL[v] ?? v,
    headline: (rows) => [
      headline('Accounts', count(rows.length), 'count'),
      headline('Outstanding', money(columnTotal(rows, 'balance')), 'money'),
      headline('Past 60 days', money(D.add(columnTotal(rows, 'd90'), columnTotal(rows, 'older'))), 'money'),
      headline('Over limit', count(rows.filter((r) => r.cells['status'] === 'Over limit').length), 'count'),
    ],
  }
}

function supplierOutstanding(src: ReportSource): ReportBuild {
  const asOn = src.query.to
  const bySupplier = new Map<number, OpenItem[]>()

  for (const p of src.purchases) {
    if (p.status !== 'POSTED') continue
    if (p.invoiceDate > asOn) continue
    const unpaid = D.sub(dec(p.netAmount), dec(p.amountPaid))
    if (!D.gt(unpaid, D.ZERO)) continue
    const supplier = src.suppliers.find((s) => s.id === p.supplierId)
    const items = bySupplier.get(p.supplierId) ?? []
    items.push({
      date: p.invoiceDate,
      dueDate: addDays(p.invoiceDate, supplier?.paymentTermsDays ?? 0),
      ref: p.purchaseNo,
      amount: unpaid,
    })
    bySupplier.set(p.supplierId, items)
  }

  const candidates: Candidate[] = src.suppliers
    .map((s) => {
      const items = bySupplier.get(s.id) ?? []
      const balance = dec(s.outstanding)
      const aged = ageBalance(balance, items, asOn)
      const limit = dec(s.creditLimit)
      const overLimit = D.gt(limit, D.ZERO) && D.gt(balance, limit)
      return { s, items, balance, aged, overLimit }
    })
    // Unlike customers, an open bill with no balance behind it is kept: the
    // documents and the master disagreeing is exactly what wants looking at.
    .filter((r) => D.gt(r.balance, D.ZERO) || r.items.length > 0)
    .sort((a, b) => D.cmp(b.balance, a.balance) || a.s.id - b.s.id)
    .map(({ s, items, balance, aged, overLimit }) => ({
      facet: overLimit ? 'limit' : aged.maxOverdue > 60 ? 'over60' : aged.maxOverdue > 0 ? 'due' : '',
      haystack: `${s.name} ${s.phone} ${s.gstin ?? ''} ${s.dlNo ?? ''}`.toLowerCase(),
      row: {
        key: `sup-${s.id}`,
        ...(aged.maxOverdue > 90 ? { tone: 'danger' as const } : aged.maxOverdue > 30 ? { tone: 'warning' as const } : {}),
        cells: {
          party: s.name,
          phone: s.phone,
          terms: count(s.paymentTermsDays),
          balance: money(balance),
          ...ageCells(aged),
          oldest: aged.oldest?.date ?? null,
          bills: count(items.length),
          status: aged.maxOverdue > 0 ? `${aged.maxOverdue}d past due` : 'Within terms',
        },
      },
    }))

  const columns: ReportColumn[] = [
    { key: 'party', label: 'Supplier', kind: 'text' },
    { key: 'phone', label: 'Phone', kind: 'code' },
    { key: 'terms', label: 'Terms (days)', kind: 'count' },
    { key: 'balance', label: 'Balance ₹', kind: 'money', total: true, hint: 'The account balance carried on the supplier master' },
    ...AGE_COLUMNS,
    { key: 'oldest', label: 'Oldest open bill', kind: 'date' },
    { key: 'bills', label: 'Open bills', kind: 'count' },
    { key: 'status', label: 'Status', kind: 'status' },
  ]

  return {
    title: 'Supplier outstanding',
    question: 'Who has to be paid this week, and which bills are already past their agreed terms.',
    basis: [
      `Aged as on ${asOn}, on the DUE date — the bill date plus the payment terms on the supplier master.`,
      'An open bill is a posted goods receipt whose net amount exceeds what has been paid against it.',
      'The balance is applied against the newest open bills first; anything they cannot account for is shown as unmatched.',
    ],
    notes: [
      `${src.productName} posts no supplier payment document yet, so "paid" is whatever the goods receipt recorded.`,
      'A DEBIT NOTE has already reduced this balance — it reduces what the supplier is owed the moment it is posted. An EXPIRY CLAIM has not, and must not: a claim is a fresh outward supply to the manufacturer whose credit arrives separately, so netting it here would understate the payable from the day it is raised. Claims and their shortfalls are tracked on the Purchases screen.',
    ],
    columns,
    candidates,
    facetLabel: 'Attention',
    facetOrder: [...OVERDUE_FACETS],
    facetName: (v) => (v === 'limit' ? 'Over the credit limit' : OVERDUE_LABEL[v] ?? v),
    headline: (rows) => [
      headline('Suppliers', count(rows.length), 'count'),
      headline('Payable', money(columnTotal(rows, 'balance')), 'money'),
      headline('Past due', money(D.sum([columnTotal(rows, 'd30'), columnTotal(rows, 'd60'), columnTotal(rows, 'd90'), columnTotal(rows, 'older')])), 'money'),
      headline('Past 90 days', money(columnTotal(rows, 'older')), 'money'),
    ],
  }
}

// -------------------------------------------------------------- stock ---

const STOCK_FACETS = ['expired', 'near', 'quarantined', 'live'] as const
const STOCK_FACET_LABEL: Record<string, string> = {
  expired: 'Expired',
  near: 'Expiring within 90 days',
  quarantined: 'Quarantined',
  live: 'Sellable and in date',
}

function stockValuation(src: ReportSource): ReportBuild {
  const candidates: Candidate[] = src.batches
    .flatMap((batch) => {
      const medicine = src.medicineFor(batch.medicineId)
      if (medicine === undefined) return []
      const onHand = dec(batch.qtyOnHand)
      if (!D.gt(onHand, D.ZERO)) return []
      const row = buildBatchRow(batch, medicine, src.today)
      const atCost = dec(row.valueAtCost)
      const atMrp = dec(row.valueAtMrp)
      const facet = row.bucket === 'expired'
        ? 'expired'
        : batch.isQuarantined
          ? 'quarantined'
          : row.daysToExpiry <= 90 ? 'near' : 'live'
      return [{
        facet,
        haystack: `${medicine.brandName} ${medicine.manufacturer} ${batch.batchNo} ${medicine.hsnCode} ${medicine.rackLocation ?? ''}`.toLowerCase(),
        sort: atCost,
        row: {
          key: `bal-${batch.id}`,
          ...(facet === 'expired' || facet === 'quarantined' ? { tone: 'danger' as const } : facet === 'near' ? { tone: 'warning' as const } : {}),
          cells: {
            medicine: medicine.brandName,
            pack: medicine.packLabel,
            batch: batch.batchNo,
            expiry: batch.expiryDate,
            hsn: medicine.hsnCode,
            rack: medicine.rackLocation,
            qty: batch.qtyOnHand,
            costPerUnit: batch.landedCostPerUnit,
            atCost: row.valueAtCost,
            mrpPerUnit: batch.mrpPerUnit,
            atMrp: row.valueAtMrp,
            marginPct: ratioPct(D.sub(atMrp, atCost), atMrp),
          },
        } satisfies ReportRow,
      }]
    })
    .sort((a, b) => D.cmp(b.sort, a.sort) || a.row.key.localeCompare(b.row.key))
    .map(({ facet, haystack, row }) => ({ facet, haystack, row }))

  const columns: ReportColumn[] = [
    { key: 'medicine', label: 'Medicine', kind: 'text' },
    { key: 'pack', label: 'Pack', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'expiry', label: 'Expiry', kind: 'expiry' },
    { key: 'hsn', label: 'HSN', kind: 'code' },
    { key: 'rack', label: 'Rack', kind: 'text' },
    { key: 'qty', label: 'On hand', kind: 'qty', total: true },
    { key: 'costPerUnit', label: 'Cost/unit ₹', kind: 'money', hint: 'Landed cost frozen when the batch was received' },
    { key: 'atCost', label: 'At cost ₹', kind: 'money', total: true },
    { key: 'mrpPerUnit', label: 'MRP/unit ₹', kind: 'money' },
    { key: 'atMrp', label: 'At MRP ₹', kind: 'money', total: true },
    { key: 'marginPct', label: 'Margin %', kind: 'pct', hint: 'On MRP, which is the number a distributor quotes' },
  ]

  return {
    title: 'Stock valuation',
    question: 'What is on the shelves right now, and what it is worth at cost and at MRP.',
    basis: [
      'ONE valuation basis: landed cost per unit, frozen when the batch was received, over paid plus free units.',
      'The grain is the batch. There is no master-average mode, because two reports over the same stock at different grains is how a valuation stops being believed.',
      'Value at MRP is GST-inclusive and value at cost is not, so the margin shown here is not a gross-profit percentage.',
    ],
    notes: [
      `This values stock AS IT STANDS NOW, not as on the end of the selected range. ${src.productName} has no stock-as-on-date engine, and reading a date it does not honour would be worse than saying so.`,
      'Emptied batches are excluded; expired and quarantined stock is included and flagged, because it is still money on a shelf that somebody has to write off.',
    ],
    columns,
    candidates,
    facetLabel: 'Stock',
    facetOrder: [...STOCK_FACETS],
    facetName: (v) => STOCK_FACET_LABEL[v] ?? v,
    headline: (rows) => {
      const atCost = columnTotal(rows, 'atCost')
      const atMrp = columnTotal(rows, 'atMrp')
      return [
        headline('Batches', count(rows.length), 'count'),
        headline('At cost', money(atCost), 'money'),
        headline('At MRP', money(atMrp), 'money'),
        headline('Margin', ratioPct(D.sub(atMrp, atCost), atMrp) ?? '—', 'pct', 'On MRP, GST-inclusive'),
      ]
    },
  }
}

const EXPIRY_WINDOWS = ['expired', 'd30', 'd60', 'd90', 'd180'] as const
const EXPIRY_WINDOW_LABEL: Record<string, string> = {
  expired: 'Already expired',
  d30: 'Within 30 days',
  d60: 'Within 60 days',
  d90: 'Within 90 days',
  d180: 'Within 180 days',
}

function nearExpiry(src: ReportSource): ReportBuild {
  const candidates: Candidate[] = src.batches
    .flatMap((batch) => {
      const medicine = src.medicineFor(batch.medicineId)
      if (medicine === undefined) return []
      const onHand = dec(batch.qtyOnHand)
      if (!D.gt(onHand, D.ZERO)) return []
      const row = buildBatchRow(batch, medicine, src.today)
      if (row.bucket === 'ok') return []
      return [{
        // The buckets are DISJOINT bands here and the facet is a WINDOW, so the
        // filter has to widen: `d90` must show the batch twenty days out.
        facet: row.bucket,
        haystack: `${medicine.brandName} ${medicine.manufacturer} ${batch.batchNo} ${medicine.rackLocation ?? ''}`.toLowerCase(),
        sort: batch.expiryDate,
        row: {
          key: `exp-${batch.id}`,
          ...(row.bucket === 'expired' || row.bucket === 'd30' ? { tone: 'danger' as const } : { tone: 'warning' as const }),
          cells: {
            medicine: medicine.brandName,
            pack: medicine.packLabel,
            batch: batch.batchNo,
            expiry: batch.expiryDate,
            expMonth: expiryMonth(batch.expiryDate),
            daysLeft: count(row.daysToExpiry),
            rack: medicine.rackLocation,
            qty: batch.qtyOnHand,
            atCost: row.valueAtCost,
            atMrp: row.valueAtMrp,
            status: batch.isQuarantined ? 'Quarantined' : row.bucket === 'expired' ? 'Write off' : 'Return or discount',
          },
        } satisfies ReportRow,
      }]
    })
    .sort((a, b) => a.sort.localeCompare(b.sort) || a.row.key.localeCompare(b.row.key))
    .map(({ facet, haystack, row }) => ({ facet, haystack, row }))

  const columns: ReportColumn[] = [
    { key: 'medicine', label: 'Medicine', kind: 'text' },
    { key: 'pack', label: 'Pack', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'expiry', label: 'Expiry', kind: 'expiry' },
    /* The same date again, as a MONTH, purely so it can be grouped on.
       A pharmacist does not think in days: the strip is printed MM/YY, the
       supplier states a return window in months, and the question at the counter
       is "what goes off in December". Days-left stays because it is what makes
       the list actionable in order; the month is what makes it addable. Grouping
       on this column bands the report by expiry month with the liability of each
       month subtotalled in its own header — which is the near-expiry question an
       owner asks and the one a day-window filter cannot answer in one view. */
    { key: 'expMonth', label: 'Expires', kind: 'text', hint: 'The printed expiry month. Group on this for month-by-month liability.' },
    { key: 'daysLeft', label: 'Days left', kind: 'count', hint: 'Negative once the printed month has passed' },
    { key: 'rack', label: 'Rack', kind: 'text', hint: 'Where to go and pull it from' },
    { key: 'qty', label: 'On hand', kind: 'qty', total: true },
    { key: 'atCost', label: 'At cost ₹', kind: 'money', total: true, hint: 'What the shop stands to lose' },
    { key: 'atMrp', label: 'At MRP ₹', kind: 'money', total: true },
    { key: 'status', label: 'Action', kind: 'status' },
  ]

  return {
    title: 'Near-expiry liability',
    question: 'How much money is sitting on stock that is about to expire, and where it is on the shelf.',
    basis: [
      'Batches carrying stock whose printed expiry falls inside the store\'s near-expiry windows, soonest first.',
      'Expired stock is listed separately from near-expiry: one is a write-off, the other is a deadline that can still be met, and mixing them makes the deadline unactionable.',
      'Liability is at landed cost, because that is the money the shop actually loses.',
    ],
    notes: [
      `The supplier return window is a per-supplier commercial term, not a statute. ${src.productName} does not hold one yet, so no batch here is labelled "returnable" on ${src.productName}\'s authority.`,
      'Valued as it stands now; the date range does not apply to stock on hand.',
    ],
    columns,
    candidates,
    facetLabel: 'Window',
    facetOrder: [...EXPIRY_WINDOWS],
    facetName: (v) => EXPIRY_WINDOW_LABEL[v] ?? v,
    headline: (rows) => [
      headline('Batches', count(rows.length), 'count'),
      headline('Units', qty(columnTotal(rows, 'qty')), 'qty'),
      headline('At cost', money(columnTotal(rows, 'atCost')), 'money', 'The loss if none of it sells'),
      headline('At MRP', money(columnTotal(rows, 'atMrp')), 'money'),
    ],
  }
}

// -------------------------------------------------------- non-moving stock ---

const IDLE_FACETS = ['expired', 'near', 'live'] as const
const IDLE_FACET_LABEL: Record<string, string> = {
  expired: 'Already expired',
  near: 'Expiring within 90 days',
  live: 'In date',
}

/**
 * Money on the shelf that did not move.
 *
 * Near-expiry finds stock with a deadline; this finds stock with no demand,
 * which is the larger number in most pharmacies and the one nobody looks at
 * until the shelf is full. The two together are the whole of dead capital.
 *
 * The grain is the batch and the test is the MEDICINE: a batch that did not
 * move while another batch of the same medicine sold is a first-expiry-first-out
 * failure, not dead stock, and calling it dead would send someone to return
 * goods that are selling.
 */
function nonMoving(src: ReportSource): ReportBuild {
  const sold = new Set(saleFacts(src).map((f) => f.medicineId))

  const candidates: Candidate[] = src.batches
    .flatMap((batch) => {
      if (sold.has(batch.medicineId)) return []
      const medicine = src.medicineFor(batch.medicineId)
      if (medicine === undefined) return []
      if (!D.gt(dec(batch.qtyOnHand), D.ZERO)) return []
      const row = buildBatchRow(batch, medicine, src.today)
      const facet = row.bucket === 'expired' ? 'expired' : row.daysToExpiry <= 90 ? 'near' : 'live'
      return [{
        facet,
        haystack: `${medicine.brandName} ${medicine.manufacturer} ${batch.batchNo} ${medicine.rackLocation ?? ''}`.toLowerCase(),
        sort: dec(row.valueAtCost),
        row: {
          key: `idle-${batch.id}`,
          ...(facet === 'expired' ? { tone: 'danger' as const } : facet === 'near' ? { tone: 'warning' as const } : {}),
          cells: {
            medicine: medicine.brandName,
            company: medicine.manufacturer,
            pack: medicine.packLabel,
            batch: batch.batchNo,
            expiry: batch.expiryDate,
            daysLeft: count(row.daysToExpiry),
            rack: medicine.rackLocation,
            qty: batch.qtyOnHand,
            costPerUnit: batch.landedCostPerUnit,
            atCost: row.valueAtCost,
            atMrp: row.valueAtMrp,
            status: batch.isQuarantined
              ? 'Quarantined'
              : facet === 'expired' ? 'Write off' : facet === 'near' ? 'Move it now' : 'No demand',
          },
        } satisfies ReportRow,
      }]
    })
    .sort((a, b) => D.cmp(b.sort, a.sort) || a.row.key.localeCompare(b.row.key))
    .map(({ facet, haystack, row }) => ({ facet, haystack, row }))

  const columns: ReportColumn[] = [
    { key: 'medicine', label: 'Medicine', kind: 'text' },
    { key: 'company', label: 'Company', kind: 'text', hint: 'Manufacturer. Group on this before you ring a distributor.' },
    { key: 'pack', label: 'Pack', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'expiry', label: 'Expiry', kind: 'expiry' },
    { key: 'daysLeft', label: 'Days left', kind: 'count', hint: 'Negative once the printed month has passed' },
    { key: 'rack', label: 'Rack', kind: 'text', hint: 'Where to go and pull it from' },
    { key: 'qty', label: 'On hand', kind: 'qty', total: true },
    { key: 'costPerUnit', label: 'Cost/unit ₹', kind: 'money' },
    { key: 'atCost', label: 'At cost ₹', kind: 'money', total: true, hint: 'The money standing still' },
    { key: 'atMrp', label: 'At MRP ₹', kind: 'money', total: true },
    { key: 'status', label: 'Action', kind: 'status' },
  ]

  return {
    title: 'Non-moving stock',
    question: 'Which stock did not sell once in this period, and how much money is standing still in it.',
    basis: [
      'A batch is listed when NO batch of the same medicine appears on any bill in the selected period. A batch that sat while another batch of the same medicine sold is an FEFO problem, not dead stock, and is deliberately not listed here.',
      'Free scheme units count as movement: they left the shelf.',
      'Valued at landed cost, on the stock as it stands NOW — the window applies to the sales side of the test, never to the shelf.',
    ],
    notes: [
      'The window is the whole test. Stock received last week looks non-moving over a 90-day window, so read this with the period in mind before you return anything.',
      `${src.productName} holds no per-supplier return window, so nothing here is labelled returnable on its authority — ring the distributor with the batch and the expiry.`,
    ],
    columns,
    candidates,
    facetLabel: 'Expiry',
    facetOrder: [...IDLE_FACETS],
    facetName: (v) => IDLE_FACET_LABEL[v] ?? v,
    headline: (rows) => [
      headline('At cost', money(columnTotal(rows, 'atCost')), 'money', 'Money standing still'),
      headline('Batches', count(rows.length), 'count'),
      headline('Medicines', count(new Set(rows.map((r) => r.cells['medicine'] ?? '')).size), 'count'),
      headline('Units', qty(columnTotal(rows, 'qty')), 'qty'),
      headline('At MRP', money(columnTotal(rows, 'atMrp')), 'money'),
    ],
  }
}

// ----------------------------------------------------------------- runner ---


/**
 * The controlled-drug running-balance register.
 *
 * A stock statement gives a figure; this gives the arithmetic that produced it.
 * One block per Schedule X or H1 drug: opening balance, every receipt and every
 * issue in order with the balance after each, closing balance — and then the
 * check that matters, which is whether that closing balance is the shelf.
 *
 * WHAT IT DOES NOT CLAIM. It is not a rendering of a statutory form. The form
 * number, its exact columns and the retention period sit unverified in
 * `docs/UNVERIFIED.md`, so the report prints the shop's own movement record and
 * says so. Printing a form number this code cannot cite would tell a pharmacist
 * they are compliant on the strength of a guess, which is worse than printing
 * nothing.
 *
 * The per-drug running balance is a SECOND balance — the ledger's own
 * `balanceAfter` is per batch and cannot be reused — so it is reconciled rather
 * than trusted. That reconciliation is the report's `checks`.
 */
function controlledBalance(src: ReportSource): ReportBuild {
  const { from, to } = src.query

  /* QUARANTINED stock counts. A register reconciles against what is physically
     in the shop, not against what is sellable — a controlled drug held back for
     a supplier return is still on the premises and still has to be accounted
     for. Excluding it would make every quarantined batch look like a shortfall. */
  const onHandByMedicine = new Map<number, D.Decimal>()
  for (const b of src.batches) {
    onHandByMedicine.set(b.medicineId, D.add(onHandByMedicine.get(b.medicineId) ?? D.ZERO, dec(b.qtyOnHand)))
  }

  const byMedicine = new Map<number, StockMovement[]>()
  for (const m of src.movements) {
    const med = src.medicineFor(m.medicineId)
    if (!med || !REGISTERED_SCHEDULES.includes(med.drugSchedule)) continue
    const list = byMedicine.get(m.medicineId)
    if (list) list.push(m)
    else byMedicine.set(m.medicineId, [m])
  }

  /* Drugs with stock but no movement in the ledger still get a register, and it
     is the empty one that matters: a controlled drug on the shelf with no
     recorded receipt is precisely what an inspection is looking for. */
  for (const b of src.batches) {
    const med = src.medicineFor(b.medicineId)
    if (!med || !REGISTERED_SCHEDULES.includes(med.drugSchedule)) continue
    if (!byMedicine.has(b.medicineId)) byMedicine.set(b.medicineId, [])
  }

  const registers = sortRegisters([...byMedicine.entries()].map(([medicineId, movements]) => {
    const med = src.medicineFor(medicineId)
    return buildRegister({
      medicineId,
      brandName: med ? `${med.brandName} ${med.packLabel}`.trim() : `#${medicineId}`,
      schedule: med?.drugSchedule ?? 'X',
      movements,
      from,
      to,
      onHand: qty(onHandByMedicine.get(medicineId) ?? D.ZERO),
      today: src.today,
    })
  }))

  const candidates: Candidate[] = []
  for (const reg of registers) {
    // The opening balance is a ROW, not a header: a register read in the middle
    // of a page has to say what it started from without scrolling back.
    candidates.push({
      facet: reg.brandName,
      haystack: `${reg.brandName} opening`.toLowerCase(),
      row: {
        key: `cb-${reg.medicineId}-opening`,
        cells: {
          drug: reg.brandName,
          schedule: reg.schedule,
          date: from,
          movement: 'Balance brought forward',
          batch: null,
          ref: null,
          received: null,
          issued: null,
          balance: reg.opening,
        },
      },
    })

    for (const e of reg.entries) {
      candidates.push({
        facet: reg.brandName,
        haystack: `${reg.brandName} ${MOVEMENT_LABEL[e.reason]} ${e.batchNo} ${e.refId}`.toLowerCase(),
        row: {
          key: `cb-${reg.medicineId}-${e.id}`,
          cells: {
            drug: reg.brandName,
            schedule: reg.schedule,
            date: e.at.slice(0, 10),
            movement: MOVEMENT_LABEL[e.reason],
            batch: e.batchNo,
            ref: e.refId,
            received: e.direction === 'IN' ? e.qty : null,
            issued: e.direction === 'OUT' ? e.qty : null,
            balance: e.balanceAfter,
          },
        },
      })
    }

    candidates.push({
      facet: reg.brandName,
      haystack: `${reg.brandName} closing`.toLowerCase(),
      row: {
        key: `cb-${reg.medicineId}-closing`,
        cells: {
          drug: reg.brandName,
          schedule: reg.schedule,
          date: to,
          movement: reg.balanced === false
            ? `Closing balance — does NOT match the shelf (${reg.onHand} counted)`
            : reg.balanced === true
              ? 'Closing balance — matches the shelf'
              : 'Closing balance',
          batch: null,
          ref: null,
          received: reg.received,
          issued: reg.issued,
          balance: reg.closing,
        },
      },
    })
  }

  const columns: ReportColumn[] = [
    { key: 'drug', label: 'Drug', kind: 'text' },
    { key: 'schedule', label: 'Schedule', kind: 'status' },
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'movement', label: 'Movement', kind: 'text' },
    { key: 'batch', label: 'Batch', kind: 'code' },
    { key: 'ref', label: 'Document', kind: 'code' },
    { key: 'received', label: 'Received', kind: 'qty' },
    { key: 'issued', label: 'Issued', kind: 'qty' },
    {
      key: 'balance',
      label: 'Balance',
      kind: 'qty',
      hint: 'Running balance for the DRUG across all its batches — not the batch balance the ledger carries',
    },
  ]

  const unbalanced = registers.filter((r) => r.balanced === false)

  return {
    title: 'Controlled-drug register',
    question: 'For each Schedule X and H1 drug, what came in, what went out, and does the balance end where the shelf is?',
    basis: [
      `Schedules covered: ${REGISTERED_SCHEDULES.join(', ')}.`,
      'The opening balance is folded from every movement before the window, not read from a stored figure.',
      'Rows are ordered by time and then by ledger id, so the same day reads the same way twice.',
    ],
    notes: [
      `This is ${src.productName}'s own movement record laid out as a running balance. It is deliberately `
      + 'not a rendering of a statutory form: the form number, its exact columns and the retention period '
      + 'are not asserted anywhere in this app until they have been read in the gazette.',
      ...(registers.some((r) => r.balanced === null)
        ? ['The closing balance is compared with the shelf only when the window runs up to today. '
           + 'A past period cannot be reconciled against stock that has since moved.']
        : []),
      ...(unbalanced.length > 0
        ? [`${unbalanced.length} drug(s) do not tally with the shelf. Each is listed first, and the `
           + 'closing row names the counted figure beside the ledger one.']
        : []),
    ],
    columns,
    candidates,
    facetLabel: 'Drug',
    facetOrder: registers.map((r) => r.brandName),
    facetName: (v) => v,
    headline: () => [
      { label: 'Drugs on the register', value: count(registers.length), kind: 'count' },
      { label: 'Not tallying', value: count(unbalanced.length), kind: 'count' },
    ],
    /* The reconciliation IS the report. A register that cannot say whether it
       agrees with the shelf has only restated the ledger. */
    checks: () => registers
      .filter((r) => r.balanced !== null)
      .map((r) => ({
        label: r.brandName,
        leftLabel: 'Register closing',
        left: r.closing,
        rightLabel: 'Counted on the shelf',
        right: r.onHand ?? '0',
        difference: r.discrepancy ?? '0',
        balanced: r.balanced === true,
        explain: 'Every movement of this drug is on the ledger, so the balance the register arrives at '
          + 'must be the quantity its batches actually hold.',
      })),
  }
}

const BUILDERS: Record<ReportId, (src: ReportSource) => ReportBuild> = {
  DAY_BOOK: dayBook,
  SALES_BY_DAY: salesByDay,
  PURCHASE_REGISTER: purchaseRegister,
  NON_MOVING: nonMoving,
  ITEM_SALES: itemSales,
  BATCH_MARGIN: batchMargin,
  GST_RATE_SUMMARY: gstRateSummary,
  HSN_SUMMARY: hsnSummary,
  H1_REGISTER: h1Register,
  CONTROLLED_BALANCE: controlledBalance,
  CUSTOMER_OUTSTANDING: customerOutstanding,
  SUPPLIER_OUTSTANDING: supplierOutstanding,
  STOCK_VALUATION: stockValuation,
  NEAR_EXPIRY: nearExpiry,
}

/** The near-expiry facet is a WINDOW: asking for ≤90 days must include a batch
 *  twenty days out. Every other report's facet is an exact match. */
const WINDOW_RANK: Record<string, number> = { expired: 0, d30: 1, d60: 2, d90: 3, d180: 4 }

function facetMatches(reportId: ReportId, rowFacet: string, wanted: string): boolean {
  if (reportId !== 'NEAR_EXPIRY') return rowFacet === wanted
  if (wanted === 'expired') return rowFacet === 'expired'
  const want = WINDOW_RANK[wanted]
  const have = WINDOW_RANK[rowFacet]
  if (want === undefined || have === undefined) return rowFacet === wanted
  return rowFacet !== 'expired' && have <= want
}

/**
 * Filter, foot and finish.
 *
 * Totals run over the filtered set and never over a page, the headline is
 * computed from the same rows the reader can see, and the reconciliation is
 * recomputed against whatever is left — a proof that only holds on the unfiltered
 * view is not a proof.
 */
/** Month names for expiry bands. Short, unambiguous, and NOT locale-derived —
 *  a report grouped on the counter machine and on the owner's laptop has to
 *  produce the same band label, or the two disagree over the same stock. */
const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/**
 * `2026-11-30` → `Nov 2026`.
 *
 * Sorts correctly WITHOUT extra work only because the rows are already ordered
 * by expiry date and grouping preserves first-appearance order — so the bands
 * come out chronologically even though the label itself does not sort.
 */
function expiryMonth(date: IsoDate): string {
  const month = Number.parseInt(date.slice(5, 7), 10)
  const name = MONTH_ABBR[month - 1]
  return name === undefined ? date.slice(0, 7) : `${name} ${date.slice(0, 4)}`
}

// -------------------------------------------------------------- grouping ---

/** Kinds that can name a band. A money or qty cell is a measure, not a label. */
const GROUPABLE_KINDS: ReadonlySet<ReportColumn['kind']> = new Set(['text', 'code', 'status'])

/**
 * A ceiling, not the real test.
 *
 * The real test is the ratio below: grouping has to at least HALVE the line
 * count to be worth offering. An absolute cap alone gets this wrong in both
 * directions — 60 rejected company-wise sales, which is the single report an
 * owner asks for most and the whole reason this feature exists, while still
 * happily offering a 55-band index over 60 rows. This number is only here to
 * stop a pathological dimension from being enumerated at all.
 */
const MAX_GROUPS = 250

const EMPTY_BAND = '(not set)'

/**
 * Which columns are worth collapsing on, decided from the ROWS rather than
 * declared per report.
 *
 * Declaring them per builder would have been thirteen lists to keep in step with
 * thirteen column sets, and the first one to drift would offer a group-by for a
 * column that no longer exists. Derived here, a report that gains a column gains
 * its grouping for free and cannot be wrong about it.
 *
 * The test for "worth it" is that grouping HALVES the report: a dimension with
 * one distinct value per row prints a header above every row, which is strictly
 * worse than the flat table it replaced, and 900 suppliers over 1,000 rows is
 * the same failure wearing a ratio that technically merges. One band is refused
 * for the same reason from the other end — a single header over everything says
 * nothing. Halving is the line because at 2:1 a folded report is genuinely
 * shorter than the table it replaced, and below that it is not.
 */
function groupableColumns(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
): Array<{ key: string; label: string }> {
  if (rows.length < 2) return []
  const out: Array<{ key: string; label: string }> = []
  for (const col of columns) {
    if (!GROUPABLE_KINDS.has(col.kind)) continue
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(bandKey(row, col.key))
      if (seen.size > MAX_GROUPS) break
    }
    if (seen.size < 2 || seen.size > MAX_GROUPS || seen.size * 2 > rows.length) continue
    out.push({ key: col.key, label: col.label })
  }
  return out
}

const bandKey = (row: ReportRow, key: string): string => (row.cells[key] ?? '').trim()

/**
 * Partition the FILTERED rows, in the order they already had.
 *
 * First appearance decides band order, so a report sorted by value stays sorted
 * by value at the band level and the reader's mental order survives the switch.
 * Sorting bands alphabetically instead re-sorts a report the user deliberately
 * ordered, and the biggest number stops being at the top.
 *
 * Subtotals use `columnTotal` and the column's own `total` flag — the same rule
 * and the same code as the footer. That is what makes the bands foot to it.
 */
function groupRows(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
  key: string,
): ReportGroup[] {
  const bands = new Map<string, ReportRow[]>()
  for (const row of rows) {
    const band = bandKey(row, key)
    const bucket = bands.get(band)
    if (bucket) bucket.push(row)
    else bands.set(band, [row])
  }

  const groups: ReportGroup[] = []
  for (const [band, members] of bands) {
    const totals: Record<string, Money | null> = {}
    for (const col of columns) {
      if (col.total !== true) continue
      const dp = col.kind === 'qty' ? 3 : col.kind === 'count' ? 0 : 2
      totals[col.key] = D.toStr(columnTotal(members, col.key), dp)
    }
    groups.push({
      key: band,
      // A blank cell is a fact about the data, not an absence of a band. Left
      // empty, the band reads as a rendering fault and its subtotal as orphaned.
      label: band === '' ? EMPTY_BAND : band,
      count: members.length,
      rowKeys: members.map((r) => r.key),
      totals,
    })
  }
  return groups
}

export function buildReport(src: ReportSource): ReportResult {
  const build = BUILDERS[src.query.reportId](src)
  const term = (src.query.term ?? '').trim().toLowerCase()

  const matchedTerm = term === ''
    ? build.candidates
    : build.candidates.filter((c) => c.haystack.includes(term))

  // The count beside a facet is a promise about what selecting it shows, so it
  // is counted through the SAME predicate the filter applies. Counting exact
  // facet values instead made every near-expiry window under-report: "Within 90
  // days (1)" then returned the three batches inside that window.
  const counts = new Map<string, number>()
  for (const value of build.facetOrder) {
    const n = matchedTerm.filter(
      (c) => c.facet !== '' && facetMatches(src.query.reportId, c.facet, value),
    ).length
    if (n > 0) counts.set(value, n)
  }

  const wanted = src.query.facet ?? ''
  const matched = wanted === ''
    ? matchedTerm
    : matchedTerm.filter((c) => facetMatches(src.query.reportId, c.facet, wanted))

  const rows = matched.map((c) => c.row)

  const totals: Record<string, Money | null> = {}
  for (const col of build.columns) {
    if (col.total !== true) continue
    const dp = col.kind === 'qty' ? 3 : col.kind === 'count' ? 0 : 2
    totals[col.key] = D.toStr(columnTotal(rows, col.key), dp)
  }

  const facets = build.facetOrder
    .filter((value) => (counts.get(value) ?? 0) > 0)
    .map((value) => ({ value, label: build.facetName(value), count: counts.get(value) ?? 0 }))

  const groupable = groupableColumns(build.columns, rows)
  /* A grouping the current filter has made pointless is still HONOURED. The
     alternative — dropping it because it left `groupable` — silently re-shapes
     the table while the operator is typing in the search box, and the control
     that caused it is showing the grouping still applied. It has to be a column
     that exists, and nothing more. */
  const askedGroup = (src.query.groupBy ?? '').trim()
  const groupBy = build.columns.some((c) => c.key === askedGroup) ? askedGroup : ''
  const groups = groupBy === '' ? null : groupRows(build.columns, rows, groupBy)

  return {
    reportId: src.query.reportId,
    productName: src.productName,
    title: build.title,
    question: build.question,
    from: src.query.from,
    to: src.query.to,
    basis: build.basis,
    notes: build.notes,
    generatedAt: src.generatedAt,
    columns: build.columns,
    rows,
    totals,
    headline: build.headline(rows),
    facetLabel: build.facetLabel,
    facets,
    checks: build.checks?.(rows) ?? [],
    groupable,
    groupBy: groupBy === '' ? null : groupBy,
    groups,
  }
}
