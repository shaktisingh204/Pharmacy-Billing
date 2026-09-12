import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight, CheckCircle2, CircleAlert, FileSpreadsheet, Sparkles, TriangleAlert, Upload, X,
} from 'lucide-react'
import type { ImportRowDto, Supplier } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import {
  FIELD_LABEL, IMPORT_FIELDS, guessColumns, missingRequired, normaliseName, parseSheet,
} from '@/api/importer'
import type { ColumnMap, ImportField, ParsedSheet } from '@/api/importer'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState } from '@/components/states'

/**
 * Importing a distributor's bill.
 *
 * The single strongest reason a pharmacy will switch, and the single strongest
 * reason they switch back — a first week spent re-keying every bill by hand is
 * how a migration fails. So the wizard is built around the two things that make
 * the SECOND import fast, both of which the incumbent throws away every time:
 * the column mapping is remembered per supplier, and every item the operator
 * matches by hand is remembered as an alias.
 *
 * Three stages, and the middle one is the product. Choose a file; agree the
 * columns; resolve the items. Nothing posts until every line is decided,
 * because an importer that posts what it understood and drops the rest loses
 * stock silently and leaves nobody able to say which lines went missing.
 */


/** A matched row plus the one thing only this screen decides. */
type Row = ImportRowDto & { skipped: boolean }

/**
 * The same readiness rule as `api/importer`, over the DTO the adapter returns.
 *
 * Restated here rather than shared because the shared one takes the importer's
 * own row type, which carries the full candidate medicine records. Shipping
 * those for a 900-line bill is megabytes the screen never reads; the rule itself
 * is four lines and is the part that must not drift, so it is written out.
 */
function localReadiness(rows: readonly Row[], map: ColumnMap): {
  ready: number; unresolved: number; skipped: number; problems: number
  warnings: string[]; canPost: boolean
} {
  const live = rows.filter((r) => !r.skipped)
  const unresolved = live.filter((r) => r.medicineId === null).length
  const problems = live.filter((r) => r.problems.length > 0).length
  const warnings: string[] = []
  /* The pre-GST "standard format" hazard: those layouts carry no HSN column at
     all, import cleanly, and surface months later as a return that cannot be
     filed. Warned about here, where a column can still be mapped. */
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

/** What this import teaches the next. A barcode or a name already remembered
 *  taught nothing new; a skipped line taught nothing at all. */
function localLearned(rows: readonly Row[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    if (row.skipped || row.medicineId === null) continue
    if (row.matchKind === 'barcode' || row.matchKind === 'alias') continue
    const key = normaliseName(row.name)
    if (key !== '') out.set(key, row.medicineId)
  }
  return out
}

type Stage = 'file' | 'columns' | 'items'

/** The three steps, in order. The order is also the progress indicator. */
const STEPS: Array<{ id: Stage; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'columns', label: 'Columns' },
  { id: 'items', label: 'Items' },
]

export function ImportWizard({ onPosted }: { onPosted: (purchaseId: number) => void }) {
  const api = useApi()
  const qc = useQueryClient()

  const [stage, setStage] = useState<Stage>('file')
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [map, setMap] = useState<ColumnMap>({})
  const [rows, setRows] = useState<Row[]>([])
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10))

  const suppliers = useQuery({ queryKey: ['suppliers', ''], queryFn: () => api.listSuppliers() })
  const profile = useQuery({
    queryKey: ['importProfile', supplierId],
    queryFn: () => api.getImportProfile(supplierId as number),
    enabled: supplierId !== null,
  })

  const read = useCallback((raw: string) => {
    setText(raw)
    try {
      const parsed = parseSheet(raw)
      setSheet(parsed)
      /* The SAVED mapping wins over the guess. A distributor's layout does not
         change between bills, and re-guessing it every time is exactly the work
         this feature exists to remove. */
      const saved = profile.data?.columns ?? {}
      const guessed = guessColumns(parsed.headers)
      const merged: ColumnMap = Object.keys(saved).length > 0
        ? (saved as ColumnMap)
        : guessed
      setMap(merged)
      setStage('columns')
    } catch (e) {
      toast.error('That file could not be read', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    }
  }, [profile.data])

  /* Matched by the ADAPTER, which holds the whole catalogue and the whole
     barcode map. Doing it here meant matching against a page of two hundred
     medicines, so every product past the letter C came back as unknown. */
  const match = useMutation({
    mutationFn: (s2: ParsedSheet) => api.matchImportRows({
      supplierId: supplierId as number,
      headers: s2.headers,
      rows: s2.rows,
      columns: map as Record<string, number>,
    }),
    onSuccess: (matched) => {
      setRows(matched.map((r) => ({ ...r, skipped: false })))
      setStage('items')
    },
    onError: (e) => {
      toast.error('Those lines could not be matched', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const toItems = useCallback(() => {
    if (sheet) match.mutate(sheet)
  }, [sheet, match])

  const state = useMemo(() => localReadiness(rows, map), [rows, map])

  const post = useMutation({
    mutationFn: async () => {
      if (supplierId === null) throw new ApiError({ code: 'NO_SUPPLIER', message: 'Choose a supplier' })
      const invoice = await api.postPurchase({
        idempotencyKey: `import-${supplierId}-${supplierInvoiceNo}-${invoiceDate}`,
        supplierId,
        supplierInvoiceNo: supplierInvoiceNo.trim(),
        invoiceDate,
        lines: rows
          .filter((r) => !r.skipped && r.medicineId !== null)
          .map((r, i) => ({ lineId: `i${i + 1}`, medicineId: r.medicineId as number, ...r.line })),
      })
      /* Saved AFTER the bill posts, never before. A profile written for a bill
         that then failed teaches the importer from an import that never
         happened — and the operator has no way to see that it did. */
      await api.saveImportProfile({
        supplierId,
        columns: map as Record<string, number>,
        aliases: Object.fromEntries(localLearned(rows)),
      })
      return invoice
    },
    onSuccess: (invoice) => {
      const learned = localLearned(rows).size
      toast.success(`${invoice.purchaseNo} imported`, {
        description: `${invoice.lines.length} lines · ₹${formatAmount(invoice.netAmount)}${
          learned > 0 ? ` · ${learned} product name${learned === 1 ? '' : 's'} remembered` : ''
        }`,
      })
      void qc.invalidateQueries({ queryKey: ['purchases'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['importProfile', supplierId] })
      setStage('file')
      setText('')
      setSheet(null)
      setRows([])
      onPosted(invoice.id)
    },
    onError: (e) => {
      toast.error('The bill was not imported', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const missing = missingRequired(map)

  return (
    <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
              <FileSpreadsheet size={17} className="text-fg-subtle" aria-hidden /> Import a supplier bill
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              Three steps, and the middle one is the point: the column mapping and every product
              name you match are remembered, so the second bill from this distributor imports itself.
            </p>
          </div>
          <ol className="flex shrink-0 items-center gap-1" aria-label="Progress">
            {STEPS.map((s, i) => {
              const at = STEPS.findIndex((x) => x.id === stage)
              const done = i < at
              return (
                <li key={s.id} className="flex items-center gap-1">
                  {i > 0 ? <ArrowRight size={13} className="text-fg-subtle" aria-hidden /> : null}
                  <span
                    aria-current={stage === s.id ? 'step' : undefined}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium',
                      stage === s.id ? 'bg-accent-3 text-accent-11'
                        : done ? 'text-fg-muted' : 'text-fg-subtle',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'num inline-flex size-5 items-center justify-center rounded-full text-2xs',
                        stage === s.id ? 'bg-accent-10 text-fg-on-accent'
                          : done ? 'bg-success-3 text-success-11' : 'bg-inset text-fg-subtle',
                      )}
                    >
                      {done ? <CheckCircle2 size={12} aria-hidden /> : i + 1}
                    </span>
                    {s.label}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 sm:max-w-[340px]">
          <span className="micro-label">Supplier</span>
          <select
            aria-label="Supplier for the import"
            value={supplierId ?? ''}
            onChange={(e) => setSupplierId(e.target.value === '' ? null : Number(e.target.value))}
            className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong"
          >
            <option value="">Choose a supplier…</option>
            {(suppliers.data ?? []).map((s: Supplier) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[160px] flex-col gap-1">
          <span className="micro-label">Their bill number</span>
          <input
            aria-label="Their bill number"
            value={supplierInvoiceNo}
            onChange={(e) => setSupplierInvoiceNo(e.target.value)}
            placeholder="SPD/4471"
            className="mono h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base hover:border-border-strong"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="micro-label">Bill date</span>
          <input
            aria-label="Bill date"
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="num h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong"
          />
        </label>
        {profile.data && Object.keys(profile.data.aliases).length > 0 ? (
          /* Said out loud, because it is the whole promise of the feature and
             the operator has no other way to know it is happening. */
          <span className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-accent-1 px-2.5 py-1.5 text-xs font-medium text-accent-11">
            <Sparkles size={14} aria-hidden />
            {Object.keys(profile.data.aliases).length} names remembered for this supplier
          </span>
        ) : null}
      </div>

      <div className="scroll-region min-h-0 flex-1 overflow-auto p-[var(--card-px)]">
        {stage === 'file' ? (
          <FileStage disabled={supplierId === null} text={text} onRead={read} />
        ) : stage === 'columns' && sheet ? (
          <ColumnStage sheet={sheet} map={map} onChange={setMap} missing={missing} />
        ) : (
          <ItemStage
            rows={rows}
            onResolve={(index, picked) => setRows((prev) =>
              prev.map((r) => (r.index === index
                ? {
                    ...r,
                    medicineId: picked.id,
                    skipped: false,
                    /* The picked medicine joins the row's candidates when it is
                       not already one. A search result is not among the matcher's
                       suggestions, so without this the row resolved and then
                       showed NOTHING about what it had resolved to — the operator
                       had no confirmation they had picked the right pack. */
                    candidates: r.candidates.some((c) => c.id === picked.id)
                      ? r.candidates
                      : [...r.candidates, picked],
                  }
                : r)))}
            onSkip={(index) => setRows((prev) =>
              prev.map((r) => (r.index === index ? { ...r, skipped: !r.skipped } : r)))}
          />
        )}
      </div>

      <footer className="shrink-0 border-t border-border-subtle px-[var(--card-px)] py-3">
        {state.warnings.length > 0 && stage !== 'file' ? (
          <ul className="mb-2.5 flex flex-col gap-1.5">
            {state.warnings.map((w: string) => (
              <li
                key={w}
                className="flex items-start gap-2 rounded-[var(--radius-md)] bg-warning-3 px-2.5 py-1.5 text-xs text-warning-11"
              >
                <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden /> {w}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {stage === 'items' ? (
            <span className="text-sm text-fg-muted">
              <span className="num text-base font-semibold text-fg">{state.ready}</span> ready
              {state.unresolved > 0 ? (
                <>
                  {' · '}
                  <span className="num font-medium text-warning-11">{state.unresolved}</span> to decide
                </>
              ) : null}
              {state.problems > 0 ? (
                <>
                  {' · '}
                  <span className="num font-medium text-danger-11">{state.problems}</span> with a problem
                </>
              ) : null}
              {state.skipped > 0 ? <> · <span className="num">{state.skipped}</span> skipped</> : null}
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {stage !== 'file' ? (
              <Button variant="ghost" onClick={() => setStage(stage === 'items' ? 'columns' : 'file')}>
                Back
              </Button>
            ) : null}
            {stage === 'columns' ? (
              <Button variant="primary" disabled={missing.length > 0} onClick={toItems}>
                Match items <ArrowRight />
              </Button>
            ) : null}
            {stage === 'items' ? (
              <Button
                variant="primary"
                size="lg"
                disabled={!state.canPost || post.isPending || supplierInvoiceNo.trim() === ''}
                onClick={() => post.mutate()}
              >
                <Upload /> Import {state.ready} line{state.ready === 1 ? '' : 's'}
              </Button>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  )
}

function FileStage({
  disabled, text, onRead,
}: {
  disabled: boolean
  text: string
  onRead: (raw: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {disabled ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="Choose the supplier first"
          body="The column mapping and every product name this importer has learned are kept per supplier, so it needs to know whose bill this is before it can use any of them."
        />
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="micro-label">Paste the bill, or drop a CSV below</span>
            <textarea
              aria-label="Paste the supplier bill"
              value={text}
              onChange={(e) => onRead(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={'PARTICULARS,B.NO,EXP DT,QNTY,FREE,M.R.P,RATE,GST%\nDOLO 650 TAB,B1,11/27,10,1,150.00,110.00,12'}
              className="mono w-full rounded-[var(--radius-lg)] border border-border bg-surface p-3 text-xs hover:border-border-strong"
            />
          </label>
          <label
            className={cn(
              'flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-xl)]',
              'border border-dashed border-border bg-subtle px-4 py-8 text-base text-fg-muted',
              'transition-colors duration-[var(--dur-base)] hover:border-border-strong hover:bg-hover',
            )}
          >
            <Upload size={17} aria-hidden />
            Choose a .csv or .txt file
            <input
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                void file.text().then(onRead)
              }}
            />
          </label>
          {/* Excel is what a distributor actually sends, and saying so beats a
              silent failure on a .xlsx the reader cannot open. */}
          <p className="text-xs leading-relaxed text-fg-subtle">
            An <span className="font-medium">.xlsx</span> is not read directly yet — open it and
            save as CSV, or select the rows and paste them above. Tabs, semicolons and pipes are
            all detected.
          </p>
        </>
      )}
    </div>
  )
}

function ColumnStage({
  sheet, map, onChange, missing,
}: {
  sheet: ParsedSheet
  map: ColumnMap
  onChange: (m: ColumnMap) => void
  missing: ImportField[]
}) {
  const sample = sheet.rows[0] ?? []
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">
        Every field with a sample value from the first row beside it. MRP and rate the wrong way
        round produces a bill that posts cleanly and prices every batch at cost — seeing a real
        number under the label is what catches it.
      </p>
      {sheet.ragged > 0 ? (
        <p className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-warning-9/25 bg-warning-3 px-3 py-2 text-xs text-warning-11">
          <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
          <span>
            <span className="num font-semibold">{sheet.ragged}</span> line
            {sheet.ragged === 1 ? '' : 's'} had more columns than the header and were left out
            rather than guessed at. Check the file if that number looks wrong.
          </span>
        </p>
      ) : null}

      {/* Every field with a SAMPLE VALUE beside it. Getting MRP and rate the
          wrong way round produces a bill that posts cleanly and prices every
          batch at cost, and the only thing that catches it before posting is
          seeing a real number under the label. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {IMPORT_FIELDS.map((field) => {
          const at = map[field]
          const value = at === undefined ? null : (sample[at] ?? '')
          const required = missing.includes(field)
          return (
            <label
              key={field}
              className={cn(
                'flex flex-col gap-1.5 rounded-[var(--radius-lg)] border bg-surface p-3',
                required ? 'border-danger-9/45 bg-danger-3/30' : 'border-border-subtle',
              )}
            >
              <span className={cn('micro-label', required && 'text-danger-11')}>
                {FIELD_LABEL[field]}{required ? ' — needed' : ''}
              </span>
              <select
                aria-label={FIELD_LABEL[field]}
                value={at ?? ''}
                onChange={(e) => {
                  const next = { ...map }
                  if (e.target.value === '') delete next[field]
                  else next[field] = Number(e.target.value)
                  onChange(next)
                }}
                className={cn(
                  'h-[var(--control-h)] rounded-[var(--radius-md)] border bg-surface px-2 text-base',
                  required ? 'border-danger-9/45' : 'border-border hover:border-border-strong',
                )}
              >
                <option value="">— not in this file —</option>
                {sheet.headers.map((h, i) => (
                  <option key={`${h}-${i}`} value={i}>{h || `Column ${i + 1}`}</option>
                ))}
              </select>
              <span className="flex items-baseline gap-1.5 truncate text-2xs text-fg-subtle">
                <span className="micro-label shrink-0">Row 1</span>
                <span className="mono truncate text-xs text-fg" title={value ?? undefined}>
                  {value === null ? '—' : value === '' ? '(blank)' : value}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function ItemStage({
  rows, onResolve, onSkip,
}: {
  rows: Row[]
  onResolve: (index: number, picked: { id: number; brandName: string; packLabel: string }) => void
  onSkip: (index: number) => void
}) {
  /* Undecided lines FIRST. The resolved ones are done and scrolling past two
     hundred of them to find the four that need a decision is the whole reason
     the incumbent's mapping window is disliked. */
  const ordered = useMemo(
    () => [...rows].sort((a, b) => {
      const rank = (r: Row): number =>
        r.skipped ? 3 : r.problems.length > 0 ? 0 : r.medicineId === null ? 1 : 2
      return rank(a) - rank(b) || a.index - b.index
    }),
    [rows],
  )

  return (
    <ul className="flex flex-col gap-2">
      {ordered.map((row) => {
        const resolved = row.medicineId !== null
        const chosen = row.candidates.find((c) => c.id === row.medicineId)
        return (
          <li
            key={row.index}
            className={cn(
              'rounded-[var(--radius-lg)] border px-3.5 py-2.5',
              row.skipped ? 'border-border-subtle bg-subtle opacity-60'
                : row.problems.length > 0 ? 'border-danger-9/35 bg-danger-3'
                  : resolved ? 'border-border-subtle bg-surface shadow-[var(--shadow-xs)]'
                    : 'border-warning-9/35 bg-warning-3',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-base font-medium text-fg" title={row.name}>
                {row.name || <span className="font-normal text-fg-subtle">(no name in this row)</span>}
              </span>
              <span className="mono shrink-0 rounded-[var(--radius-sm)] bg-inset px-1.5 py-0.5 text-2xs text-fg-muted">
                {row.line.batchNo} · {row.line.expiry || '??'} · {row.line.qtyPacks}
                {row.line.freePacks !== '0' ? `+${row.line.freePacks}` : ''}
              </span>
              {resolved && !row.skipped ? (
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-success-11">
                  <CheckCircle2 size={13} aria-hidden />
                  {/* The KIND is shown, not just the tick: an operator has to be
                      able to tell a barcode identity from a name the software
                      guessed and they confirmed. */}
                  {row.matchKind === 'barcode' ? 'by barcode'
                    : row.matchKind === 'alias' ? 'remembered'
                      : row.matchKind === 'mrp' ? 'pack by MRP'
                        : row.matchKind === 'exact' ? 'matched' : 'chosen'}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => onSkip(row.index)}
                aria-label={`${row.skipped ? 'Include' : 'Skip'} ${row.name}`}
                className="shrink-0 rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X size={13} aria-hidden />
              </button>
            </div>

            {row.problems.length > 0 ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-danger-11">
                <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                {row.problems.join(' · ')}
              </p>
            ) : null}

            {!row.skipped && (!resolved || row.matchKind === 'ambiguous') ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {row.candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onResolve(row.index, c)}
                    className={cn(
                      'rounded-[var(--radius-md)] border px-2.5 py-1.5 text-xs font-medium',
                      chosen?.id === c.id
                        ? 'border-accent-9 bg-accent-3 text-accent-11'
                        : 'border-border bg-surface text-fg hover:border-border-strong',
                    )}
                  >
                    {c.brandName} <span className="text-fg-subtle">{c.packLabel}</span>
                  </button>
                ))}
                <CatalogueSearch row={row} onResolve={onResolve} />
              </div>
            ) : null}

            {resolved && chosen && row.matchKind !== 'ambiguous' && !row.skipped ? (
              <p className="mt-0.5 truncate text-2xs text-fg-muted">
                → {chosen.brandName} · {chosen.packLabel}
                {normaliseName(chosen.brandName) !== normaliseName(row.name)
                  ? <span className="text-accent-11"> · this name will be remembered</span>
                  : null}
              </p>
            ) : null}
          </li>
        )
      })}
      {ordered.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No lines in that file"
          body="The header was found but nothing followed it. Check that the rows were included in the paste."
        />
      ) : null}
      <li className="pt-1 text-2xs text-fg-subtle">
        <Kbd>Esc</Kbd> leaves the import. Nothing is posted until every line is decided.
      </li>
    </ul>
  )
}

/**
 * Resolving one line against the WHOLE catalogue.
 *
 * A `<select>` cannot do this job: the catalogue is thousands of medicines, a
 * dropdown of the first four hundred is alphabetical noise, and the operator
 * already knows the name they are looking for. This is the same debounced search
 * the counter uses, scoped to one row.
 */
function CatalogueSearch({
  row, onResolve,
}: {
  row: Row
  onResolve: (index: number, picked: { id: number; brandName: string; packLabel: string }) => void
}) {
  const api = useApi()
  /* Pre-filled with the supplier's own name, because it is usually most of the
     answer — "DOLO 650 TAB" finds Dolo 650 on the first keystroke of editing. */
  const [term, setTerm] = useState(row.name)
  const hits = useQuery({
    queryKey: ['importSearch', term],
    queryFn: () => api.searchMedicines({ term, limit: 6, includeOutOfStock: true }),
    enabled: term.trim().length >= 2,
  })

  return (
    <div className="flex min-w-[220px] flex-1 flex-col gap-1">
      <input
        aria-label={`Match ${row.name} to a medicine`}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search the catalogue…"
        autoComplete="off"
        className="h-7 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 text-xs"
      />
      {(hits.data ?? []).length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {(hits.data ?? []).map((h) => (
            <button
              key={h.medicine.id}
              type="button"
              onClick={() => onResolve(row.index, {
                id: h.medicine.id,
                brandName: h.medicine.brandName,
                packLabel: h.medicine.packLabel,
              })}
              className={cn(
                'rounded-[var(--radius-md)] border px-2.5 py-1.5 text-xs font-medium',
                row.medicineId === h.medicine.id
                  ? 'border-accent-9 bg-accent-3 text-accent-11'
                  : 'border-border bg-surface text-fg hover:border-border-strong',
              )}
            >
              {h.medicine.brandName} <span className="text-fg-subtle">{h.medicine.packLabel}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
