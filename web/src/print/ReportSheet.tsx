import type { ReportCellKind, ReportColumn, ReportResult, ReportRow, StoreProfile } from '@contract'
import { formatAmount, formatExpiry, formatPercent, formatQty } from '@/lib/format'
import './print.css'

/**
 * A report, on paper.
 *
 * The CSV is what an accountant pivots; this is what gets signed, filed in a
 * folder, or handed across the counter to an inspector. They are different
 * artefacts and this one has different rules:
 *
 *  - THE MANIFEST IS ON THE PAGE, not in a header row. Period, filters, index,
 *    basis, caveats and the reconciliation all print, because a printed figure
 *    outlives every screen that could have explained it.
 *  - BANDS PRINT AS BANDS. The CSV deliberately stays flat so a pivot cannot
 *    double-count; paper has no pivot, and a subtotal under each band is the
 *    whole reason somebody grouped the report before printing it.
 *  - IT SAYS WHAT IT LEFT OUT. A very long report is truncated with the number
 *    of rows that did not fit printed on it, rather than quietly ending.
 *
 * Pure: no hooks, no fetching. A sheet that had to fetch could not be printed
 * from a machine that has gone offline since the report ran.
 */

/** Rows past this are not a document any more, and a browser asked to lay out
 *  20,000 table rows for print will hang the till. The count that did not fit
 *  is printed, so the reader knows to narrow the range or use the CSV. */
export const MAX_PRINT_ROWS = 800

const RIGHT: ReadonlySet<ReportCellKind> = new Set<ReportCellKind>(['money', 'qty', 'pct', 'count', 'date'])

function cellText(value: string | null | undefined, kind: ReportCellKind): string {
  if (value === null || value === undefined || value.trim() === '') return ''
  switch (kind) {
    case 'money': return formatAmount(value)
    case 'qty': return formatQty(value)
    case 'pct': return formatPercent(value)
    case 'expiry': return formatExpiry(value)
    default: return value
  }
}

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function ReportSheet({
  result,
  store,
  preview = false,
}: {
  result: ReportResult
  store: StoreProfile | null
  /** Show the same sheet on screen. A preview that differs from the paper is
   *  worse than no preview, so it is the same markup and the same metrics. */
  preview?: boolean
}) {
  const rows = result.rows.slice(0, MAX_PRINT_ROWS)
  const dropped = result.rows.length - rows.length
  const printed = new Set(rows.map((r) => r.key))
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const groups = result.groups

  return (
    <div className="rx-print rx-print--report" data-preview={preview ? 'true' : undefined}>
      <header className="rx-rep__head">
        <div className="rx-rep__shop">
          <span className="rx-rep__name">{store?.name ?? result.productName}</span>
          {store ? (
            <span className="rx-rep__addr">
              {[store.addressLine, store.city].filter(Boolean).join(', ')}
              {store.gstin ? ` · GSTIN ${store.gstin}` : ''}
            </span>
          ) : null}
        </div>
        <h1 className="rx-rep__title">{result.title}</h1>
        <p className="rx-rep__question">{result.question}</p>
      </header>

      <dl className="rx-rep__facts">
        <Fact label="Period" value={`${result.from} to ${result.to}`} />
        <Fact label="Rows" value={`${result.rows.length}`} />
        {result.groupBy !== null ? (
          <Fact
            label="Indexed on"
            value={result.columns.find((c) => c.key === result.groupBy)?.label ?? result.groupBy}
          />
        ) : null}
        <Fact label="Generated" value={safeDate(result.generatedAt)} />
      </dl>

      <table className="rx-rep__table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.key} scope="col" className={RIGHT.has(c.kind) ? 'rx-rep__num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Bands are sibling ROWS, never a nested table: a table inside a
              spanning cell computes its own column widths, and the subtotals
              would then stop lining up with the figures they sum. */}
          {groups === null
            ? rows.map((row) => <PrintRow key={row.key} row={row} columns={result.columns} />)
            : groups.flatMap((group) => {
              const members = group.rowKeys.filter((k) => printed.has(k))
              if (members.length === 0) return []
              return [
                <tr key={`band:${group.key}`} className="rx-rep__bandhead">
                  {result.columns.map((c, i) => (
                    <td key={c.key} className={RIGHT.has(c.kind) ? 'rx-rep__num' : undefined}>
                      {i === 0
                        ? `${group.label} (${group.count})`
                        : cellText(group.totals[c.key], c.kind)}
                    </td>
                  ))}
                </tr>,
                ...members.flatMap((key) => {
                  const row = byKey.get(key)
                  return row ? [<PrintRow key={key} row={row} columns={result.columns} />] : []
                }),
              ]
            })}
        </tbody>
        <tfoot>
          <tr>
            {result.columns.map((c, i) => {
              const total = result.totals[c.key]
              return (
                <td key={c.key} className={RIGHT.has(c.kind) ? 'rx-rep__num' : undefined}>
                  {total === undefined || total === null
                    ? (i === 0 ? 'Total' : '')
                    : cellText(total, c.kind)}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>

      {dropped > 0 ? (
        <p className="rx-rep__cut">
          {dropped} further row{dropped === 1 ? '' : 's'} are not printed. The totals above are for
          all {result.rows.length} rows; narrow the period, or export the CSV, to see the rest.
        </p>
      ) : null}

      {result.checks.length > 0 ? (
        <section className="rx-rep__block">
          <h2>Reconciliation</h2>
          {result.checks.map((check) => (
            <p key={check.label}>
              <strong>{check.label}:</strong> {check.leftLabel} {formatAmount(check.left)} ·{' '}
              {check.rightLabel} {formatAmount(check.right)} · difference{' '}
              {formatAmount(check.difference)}
              {check.balanced ? ' (balanced)' : ' — DOES NOT BALANCE'}
            </p>
          ))}
        </section>
      ) : null}

      <section className="rx-rep__block">
        <h2>Basis</h2>
        {result.basis.map((line) => <p key={line}>{line}</p>)}
        {result.notes.map((note) => <p key={note}>Note: {note}</p>)}
      </section>

      <p className="rx-rep__credit">
        {result.title} · {result.from} to {result.to} · produced by {result.productName}
      </p>
    </div>
  )
}

function PrintRow({ row, columns }: { row: ReportRow; columns: readonly ReportColumn[] }) {
  return (
    <tr>
      {columns.map((c) => (
        <td key={c.key} className={RIGHT.has(c.kind) ? 'rx-rep__num' : undefined}>
          {cellText(row.cells[c.key], c.kind)}
        </td>
      ))}
    </tr>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** The timestamp is an ISO string from the adapter; a malformed one prints as
 *  itself rather than as "Invalid Date". */
function safeDate(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? DATE.format(new Date(ms)) : iso
}
