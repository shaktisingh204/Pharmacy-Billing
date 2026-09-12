import type {
  CreditNote, IsoDate, ReportCheck, ReportColumn, ReportResult, ReportRow, SaleRegisterRow,
  SalesSummary,
} from '@contract'
import * as D from '@/domain/decimal'

/**
 * The register, as a file an accountant can open.
 *
 * This builds a `ReportResult` and hands it to the Reports screen's own
 * serialiser rather than writing a second CSV writer. That is not tidiness: the
 * escaping in `exportCsv` is where the bugs are — the BOM, the long-digit guard
 * that stops a 13-digit phone becoming 9.1234E+12, the formula guard on names
 * typed by shop staff — and a second implementation is a second set of those
 * bugs, discovered by the accountant rather than by us.
 *
 * `reportId` is DAY_BOOK because that is what this grain is: one row per counter
 * voucher over a date range. The id never reaches the file (the manifest is
 * built from the title, the question and the basis), so it is a classification,
 * not a claim that the Reports screen produced it.
 */

const TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function clockTime(stamp: string): string {
  const t = Date.parse(stamp)
  return Number.isNaN(t) ? '' : TIME.format(t)
}

const money = (d: D.Decimal): string => D.toStr(d, 2)

const sumOf = <T>(items: readonly T[], pick: (t: T) => string): string =>
  money(D.sum(items.map((i) => D.dec(pick(i)))))

export interface RegisterExportContext {
  /** The RESELLER's product name. It heads the file, never ours. */
  productName: string
  from: IsoDate
  to: IsoDate
  generatedAt: string
  /** The filters that were on screen, already worded. Empty when none applied. */
  appliedFilters: string[]
  /** True when the export hit its own row cap and is not the whole range. */
  truncated: boolean
}

const STATUS_LABEL: Record<SaleRegisterRow['status'], string> = {
  POSTED: 'Posted',
  PART_RETURNED: 'Part returned',
  RETURNED: 'Returned',
  VOIDED: 'Cancelled',
}

const MODE_LABEL: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'Credit',
}

const DISPOSITION_LABEL: Record<string, string> = {
  RESTOCK: 'Back on the shelf',
  QUARANTINE: 'Held',
  DESTROY: 'Destroyed',
}

const TRUNCATED_NOTE =
  'This file hit the export cap and is NOT the whole range. Narrow the dates and export again — a partial register that does not say so is the worst possible artefact to hand an accountant.'

function withCap(notes: string[], truncated: boolean): string[] {
  return truncated ? [TRUNCATED_NOTE, ...notes] : notes
}

/** Common scaffolding, so the two registers cannot drift apart. */
function result(
  ctx: RegisterExportContext,
  parts: Pick<ReportResult, 'title' | 'question' | 'basis' | 'notes' | 'columns' | 'rows' | 'totals' | 'headline' | 'checks'>,
): ReportResult {
  return {
    reportId: 'DAY_BOOK',
    productName: ctx.productName,
    from: ctx.from,
    to: ctx.to,
    generatedAt: ctx.generatedAt,
    facetLabel: null,
    facets: [],
    groupable: [],
    groupBy: null,
    groups: null,
    ...parts,
    notes: withCap(parts.notes, ctx.truncated),
    basis: ctx.appliedFilters.length === 0
      ? [...parts.basis, 'No filter was applied: this is every document in the range.']
      : [...parts.basis, `Filtered on screen — ${ctx.appliedFilters.join('; ')}. The rows below are what was on screen, nothing more.`],
  }
}

/**
 * The invoice register.
 *
 * A cancelled bill is EXPORTED and carries no net value, exactly as it appears
 * on screen and in the day book: GSTR-1 Table 13 wants a gapless series with an
 * explicit cancelled count, and a file that drops the row makes that
 * unreconstructable from the shop's own records.
 */
export function invoiceRegisterCsv(
  rows: readonly SaleRegisterRow[],
  summary: SalesSummary,
  ctx: RegisterExportContext,
): ReportResult {
  const live = rows.filter((r) => r.status !== 'VOIDED')

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', kind: 'date' },
    { key: 'time', label: 'Time', kind: 'text', hint: 'The shop’s own clock, 24 hour' },
    { key: 'invoiceNo', label: 'Invoice no', kind: 'code' },
    { key: 'customer', label: 'Customer', kind: 'text' },
    { key: 'phone', label: 'Phone', kind: 'code' },
    { key: 'lines', label: 'Lines', kind: 'count' },
    { key: 'units', label: 'Units', kind: 'qty', hint: 'Charged units; scheme units are dispensed free and not counted' },
    { key: 'modes', label: 'Paid by', kind: 'status', hint: 'A split bill lists every tender it was settled with' },
    { key: 'net', label: 'Net ₹', kind: 'money', total: true, hint: 'Inclusive of GST and round-off. A cancelled bill carries none.' },
    { key: 'returned', label: 'Credited back ₹', kind: 'money', total: true, hint: 'Value of credit notes raised against this bill, whenever they were issued' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'operator', label: 'Billed by', kind: 'text' },
    { key: 'terminal', label: 'Till', kind: 'count' },
  ]

  const reportRows: ReportRow[] = rows.map((r) => ({
    key: `sale-${r.id}`,
    ...(r.status === 'VOIDED' ? { tone: 'muted' as const } : {}),
    cells: {
      date: r.invoiceDate,
      time: clockTime(r.createdAt),
      invoiceNo: r.invoiceNo,
      customer: r.customerName ?? 'Walk-in',
      phone: r.customerPhone,
      lines: String(r.lineCount),
      units: r.itemQty,
      modes: r.modes.map((m) => MODE_LABEL[m] ?? m).join(' + ') || 'Unpaid',
      // Null, not '0.00': a cancelled bill did not take zero rupees, it did not
      // happen. An em dash on screen and an empty cell in the sheet both say so;
      // a zero would be summed by whoever pivots this.
      net: r.status === 'VOIDED' ? null : r.netAmount,
      returned: D.isZero(D.dec(r.returnedAmount)) ? null : r.returnedAmount,
      status: STATUS_LABEL[r.status],
      operator: r.operatorName,
      terminal: String(r.terminalId),
    },
  }))

  const billed = sumOf(live, (r) => r.netAmount)
  const credited = sumOf(rows, (r) => r.returnedAmount)

  /* The control that catches a wrong export. It is offered ONLY on an unfiltered
     export of a complete range, because a filtered register is a subset by
     design and a check that never balances teaches the reader to ignore it. */
  const checks: ReportCheck[] =
    ctx.appliedFilters.length === 0 && !ctx.truncated
      ? [{
          label: 'Register against the range summary',
          leftLabel: 'Sum of the rows below',
          left: billed,
          rightLabel: 'Net sales for the range',
          right: summary.netSales,
          difference: money(D.sub(D.dec(billed), D.dec(summary.netSales))),
          balanced: D.eq(D.dec(billed), D.dec(summary.netSales)),
          explain: 'The register and the header are two paths over the same posted bills. A difference means the export is not the range it claims to be.',
        }]
      : []

  return result(ctx, {
    title: 'Sale register',
    question: 'Every bill raised at the counter in this period, with what was collected against it and what has since come back.',
    basis: [
      'One row per invoice, on the date the bill was raised.',
      'Cancelled bills are listed, keep their number and carry no value — they are never deleted, because the document series has to stay gapless.',
      'Credited back is the value of credit notes against that bill whatever period they were issued in, so it will not sum to the returns figure for this range.',
    ],
    notes: [
      'Amounts are inclusive of GST. The rate-wise split is the GST rate-wise summary on Reports, not this file.',
      'A phone number is exported as text so a leading zero and a 12-digit number survive the trip into a spreadsheet.',
    ],
    columns,
    rows: reportRows,
    totals: { net: billed, returned: credited },
    headline: [
      { label: 'Documents', value: String(rows.length), kind: 'count' },
      { label: 'Billed', value: billed, kind: 'money', hint: 'Cancelled bills excluded' },
      { label: 'Credited back', value: credited, kind: 'money' },
      { label: 'Cancelled', value: String(rows.length - live.length), kind: 'count', hint: 'Listed, numbered, excluded from the total' },
    ],
    checks,
  })
}

/** The dispositions on one note, in a fixed order so two notes read alike. */
function dispositionsOf(note: CreditNote): string {
  const seen = new Set(note.lines.map((l) => l.disposition))
  return (['RESTOCK', 'QUARANTINE', 'DESTROY'] as const)
    .filter((d) => seen.has(d))
    .map((d) => DISPOSITION_LABEL[d] ?? d)
    .join(', ')
}

/**
 * The credit-note register.
 *
 * Filed on the ISSUE date and carrying the original bill's date beside it,
 * because the tax being reversed is the tax that was charged — a slab can move
 * between the two, and GSTR-1 reports the note against the original document
 * (invariant I21).
 */
export function creditNoteRegisterCsv(
  notes: readonly CreditNote[],
  ctx: RegisterExportContext,
): ReportResult {
  const columns: ReportColumn[] = [
    { key: 'issuedOn', label: 'Issued', kind: 'date' },
    { key: 'noteNo', label: 'Credit note no', kind: 'code' },
    { key: 'invoiceNo', label: 'Against bill', kind: 'code' },
    { key: 'billDate', label: 'Bill dated', kind: 'date', hint: 'The date the tax being reversed was charged on' },
    { key: 'customer', label: 'Customer', kind: 'text' },
    { key: 'lines', label: 'Lines', kind: 'count' },
    { key: 'units', label: 'Units back', kind: 'qty', total: true },
    { key: 'taxable', label: 'Taxable ₹', kind: 'money', total: true },
    { key: 'cgst', label: 'CGST ₹', kind: 'money', total: true },
    { key: 'sgst', label: 'SGST ₹', kind: 'money', total: true },
    { key: 'igst', label: 'IGST ₹', kind: 'money', total: true },
    { key: 'net', label: 'Refunded ₹', kind: 'money', total: true, hint: 'Inclusive of GST and, on a full reversal, the bill’s round-off' },
    { key: 'refundMode', label: 'Refunded by', kind: 'status', hint: 'Only a cash refund moves the drawer' },
    { key: 'disposition', label: 'The goods', kind: 'status' },
    { key: 'reason', label: 'Why it came back', kind: 'text' },
    { key: 'operator', label: 'Issued by', kind: 'text' },
  ]

  const rows: ReportRow[] = notes.map((n) => ({
    key: `cn-${n.id}`,
    cells: {
      issuedOn: n.issuedOn,
      noteNo: n.creditNoteNo,
      invoiceNo: n.invoiceNo,
      billDate: n.originalInvoiceDate,
      customer: n.customerName ?? 'Walk-in',
      lines: String(n.lines.length),
      units: D.toStr(D.sum(n.lines.map((l) => D.dec(l.qty))), 3),
      taxable: n.taxableValue,
      cgst: n.cgst,
      sgst: n.sgst,
      igst: n.igst,
      net: n.netAmount,
      refundMode: MODE_LABEL[n.refundMode] ?? n.refundMode,
      disposition: dispositionsOf(n),
      reason: n.reason,
      operator: n.operatorName,
    },
  }))

  const lines = notes.flatMap((n) => n.lines)
  const net = sumOf(notes, (n) => n.netAmount)
  const taxable = sumOf(notes, (n) => n.taxableValue)
  const cgst = sumOf(notes, (n) => n.cgst)
  const sgst = sumOf(notes, (n) => n.sgst)
  const igst = sumOf(notes, (n) => n.igst)
  const roundOff = sumOf(notes, (n) => n.roundOff)
  const tax = D.add(D.add(D.dec(cgst), D.dec(sgst)), D.dec(igst))
  const footing = money(D.add(D.add(D.dec(taxable), tax), D.dec(roundOff)))

  return result(ctx, {
    title: 'Credit note register',
    question: 'What came back over the counter in this period, what it cost the shop, and where the goods went.',
    basis: [
      'One row per credit note, on the date it was ISSUED — not the date of the bill it reverses. A return of last month’s bill reduces this month’s takings, which is how the drawer behaves and how GSTR-1 reports it.',
      'The tax is reversed at the rate recorded on the ORIGINAL bill, never re-rated at today’s slab.',
      'Only a cash refund leaves the drawer. A UPI or card refund goes back the way it came and never touches the day close.',
    ],
    notes: [
      'Held and destroyed goods are off the shelf but were still credited to the customer. The stock movement is in the Inventory ledger, not here.',
      'A posted bill is never edited, so a correction is always one of these documents. There is no row here without an invoice behind it.',
    ],
    columns,
    rows,
    totals: {
      units: D.toStr(D.sum(lines.map((l) => D.dec(l.qty))), 3),
      taxable, cgst, sgst, igst, net,
    },
    headline: [
      { label: 'Credit notes', value: String(notes.length), kind: 'count' },
      { label: 'Refunded', value: net, kind: 'money' },
      { label: 'Tax reversed', value: money(tax), kind: 'money' },
      { label: 'Not resaleable', value: String(lines.filter((l) => l.disposition !== 'RESTOCK').length), kind: 'count', hint: 'Lines held or destroyed rather than put back on the shelf' },
    ],
    checks: [{
      label: 'The notes foot',
      leftLabel: 'Taxable + tax + round-off',
      left: footing,
      rightLabel: 'Refunded',
      right: net,
      difference: money(D.sub(D.dec(footing), D.dec(net))),
      balanced: D.eq(D.dec(footing), D.dec(net)),
      explain: 'Every credit note is built inclusive-first and its tax backed out as a residual, so the parts sum to the refund by construction. A difference is a fault in the data, never rounding.',
    }],
  })
}
