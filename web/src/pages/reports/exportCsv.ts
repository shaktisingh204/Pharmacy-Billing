import type { ReportColumn, ReportResult } from '@contract'

/**
 * CSV export, written for the one program that will actually open it.
 *
 * Accountants want XLSX and RxBill will owe them one. Until then this is CSV,
 * and CSV handed to Excel is a minefield that eats data silently:
 *
 *  - THE BOM IS NOT OPTIONAL. Without U+FEFF, Excel decodes the file in the
 *    system code page and every ₹ in a column header becomes mojibake. One
 *    three-byte prefix is the whole fix.
 *  - LONG DIGIT STRINGS BECOME SCIENTIFIC NOTATION. A 13-digit EAN lands as
 *    8.90123E+12 and the barcode is gone. Leading zeros are eaten the same way:
 *    batch 0123 becomes 123, which is a different batch.
 *  - BATCH NUMBERS BECOME DATES. `3-25` and `10/24` are read as dates by a
 *    locale that thinks it is being helpful, and `MAR25` sometimes joins them.
 *
 * There is no CSV construct that prevents all of that and stays clean for every
 * parser. `="…"` is what Excel honours, and a strict RFC-4180 reader sees the
 * literal formula text — so it is applied ONLY to the cells that would otherwise
 * be corrupted, and only in code columns. Every other cell is plain.
 *
 * The file opens with a MANIFEST: report, question, period, filters, basis,
 * every caveat, the reconciliation, when it was generated, the row count and the
 * control totals. When the accountant rings about a number that does not match,
 * the manifest ends the call — and a report whose basis is not attached to it is
 * a number nobody can defend six weeks later.
 */

const BOM = '﻿'
const CRLF = '\r\n'

/** RFC 4180: quote when the field carries a delimiter, a quote, a newline, or
 *  edge whitespace a parser would otherwise trim. */
const MUST_QUOTE = /[",\r\n]/

/** Digits Excel would rewrite: 12+ of them go scientific, a leading zero is
 *  dropped, and `3-25` or `10/24` are read as a date. */
const LONG_DIGITS = /^\d{12,}$/
const LEADING_ZERO = /^0\d+$/
const DATE_SHAPED = /^\d{1,2}[-/]\d{1,4}$/
const EXPONENT = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/

function needsTextGuard(value: string): boolean {
  return LONG_DIGITS.test(value)
    || LEADING_ZERO.test(value)
    || DATE_SHAPED.test(value)
    || EXPONENT.test(value)
}

/**
 * Excel evaluates a cell that OPENS with one of these. A customer saved as
 * `=1+1`, or as `@SUM(A1:A9)`, becomes a live formula in the recipient's sheet —
 * and every name in these reports is typed by shop staff into their own master
 * data, which is precisely the untrusted-input path.
 *
 * `-` is deliberately absent, and that is the whole reason this is a separate
 * predicate from `needsTextGuard`. Every negative figure in the report opens
 * with a minus, and guarding them would turn `-1,240.00` into a text cell that
 * no longer sums — trading a rare injection for a wrong total on every credit
 * balance. Money and quantity cells are their own kinds and never reach here;
 * only `text` and `code` do, where a leading minus is a hyphenated name and not
 * arithmetic.
 */
const FORMULA_LEAD = /^[=+@\t\r]/

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * One field.
 *
 * Money and quantities go out as bare decimal strings with no grouping and no
 * symbol: `12,34,567.00` is a number in Mumbai and three columns in London, so
 * the raw value travels and the formatting stays on the screen it came from.
 */
export function csvCell(value: string | null, kind?: ReportColumn['kind']): string {
  if (value === null || value === '') return ''
  if (kind === 'code' && needsTextGuard(value)) return `="${value.replace(/"/g, '""')}"`
  if ((kind === 'text' || kind === 'code') && FORMULA_LEAD.test(value)) {
    return `="${value.replace(/"/g, '""')}"`
  }
  if (MUST_QUOTE.test(value) || value !== value.trim()) return quote(value)
  return value
}

const row = (fields: readonly string[]): string => fields.join(',')

const pair = (key: string, value: string): string => row([quote(key), csvCell(value)])

/** The report as a file. Pure: the caller decides what to do with the string. */
export function toCsv(result: ReportResult): string {
  const lines: string[] = []

  // The reseller's name heads their customer's file, never ours.
  lines.push(pair(`${result.productName} report`, result.title))
  lines.push(pair('Question', result.question))
  lines.push(pair('Period', `${result.from} to ${result.to}`))
  for (const line of result.basis) lines.push(pair('Basis', line))
  for (const note of result.notes) lines.push(pair('Note', note))
  for (const check of result.checks) {
    lines.push(pair(
      `Reconciliation — ${check.label}`,
      `${check.leftLabel}: ${check.left} · ${check.rightLabel}: ${check.right} · difference ${check.difference} · ${check.balanced ? 'balanced' : 'DOES NOT BALANCE'}`,
    ))
  }
  if (result.groupBy !== null) {
    /* The grid below stays FLAT even when the screen is banded, and the manifest
       is where the grouping is recorded instead.
       Interleaving subtotal rows would put them in the same columns as the data,
       and the first thing an accountant does with this file is pivot it — which
       then double-counts every band. Nothing is lost: the column grouped on is
       still one of the columns, so the same pivot reproduces the same bands, and
       these two lines say which one to use. */
    const grouped = result.columns.find((c) => c.key === result.groupBy)
    lines.push(pair('Grouped on', grouped?.label ?? result.groupBy))
    lines.push(pair(
      'Groups',
      `${result.groups?.length ?? 0} — subtotals are not written as rows; pivot on the column above`,
    ))
  }
  lines.push(pair('Generated at', result.generatedAt))
  lines.push(pair('Rows', String(result.rows.length)))
  for (const column of result.columns) {
    const total = result.totals[column.key]
    if (total === undefined || total === null) continue
    lines.push(pair(`Control total — ${column.label}`, total))
  }

  // A blank record separates the manifest from the table, so a reader that
  // splits on the header row finds one grid rather than a ragged file.
  lines.push('')
  lines.push(row(result.columns.map((c) => csvCell(c.label))))

  for (const r of result.rows) {
    lines.push(row(result.columns.map((c) => csvCell(r.cells[c.key] ?? null, c.kind))))
  }

  const hasTotals = result.columns.some((c) => result.totals[c.key] !== undefined)
  if (hasTotals) {
    lines.push(row(result.columns.map((c, i) => {
      const total = result.totals[c.key]
      if (total !== undefined && total !== null) return csvCell(total)
      return i === 0 ? csvCell('TOTAL') : ''
    })))
  }

  return BOM + lines.join(CRLF) + CRLF
}

/**
 * `rxbill-gst-rate-wise-summary-2026-09-01_2026-09-30.csv`
 *
 * The product name leads, slugged the same way the title is — a file landing in
 * an accountant's downloads folder is the most-forwarded artefact this app
 * produces, and it named the vendor rather than the reseller. Falls back to
 * `report` if a brand slugs to nothing (a name made entirely of punctuation, or
 * of a script this transliteration drops), because a filename beginning with a
 * bare hyphen is worse than a generic one.
 */
export function csvFilename(result: ReportResult): string {
  const slug = (v: string): string =>
    v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const brand = slug(result.productName) || 'report'
  return `${brand}-${slug(result.title)}-${result.from}_${result.to}.csv`
}

/**
 * Hand the file to the browser.
 *
 * Kept apart from `toCsv` so the serialiser stays a pure function of the report
 * and can be tested without a DOM — the part that goes wrong is the escaping,
 * not the anchor.
 */
export function downloadCsv(result: ReportResult): void {
  const blob = new Blob([toCsv(result)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = csvFilename(result)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
