import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDownRight, ArrowUpRight, BookOpenCheck, Boxes, CalendarDays, ClipboardList, Download,
  GitCompareArrows, Info, Landmark, Layers, Link2, Minus, PanelRightClose, PanelRightOpen,
  Pencil, Printer, Receipt, Scale, Search, ShieldCheck, Star, Trash2, TrendingUp, Truck,
  Wallet, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Permission, ReportHeadline, ReportId, ReportQuery, ReportResult } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import { cn } from '@/lib/cn'
import { formatAmount, formatPercent, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { StatValue } from '@/components/ui/Money'
import { ReportSheet } from '@/print'
import { GstSummary } from './GstSummary'
import { FilingCheckPanel } from './FilingCheck'
import { ReportChart } from './ReportChart'
import { ReportRunner } from './ReportRunner'
import type { RunnerStatus } from './ReportRunner'
import { compareHeadlines, isComparable, whyNotComparable } from './compare'
import type { HeadlineDelta } from './compare'
import { downloadCsv } from './exportCsv'
import {
  PRESETS, dayCount, defaultRange, describeRange, isIsoDate, presetKeyFor, previousRange,
} from './periods'
import type { Range } from './periods'
import type { SavedView } from './savedViews'
import {
  loadSavedViews, newViewId, removeView, renameView, resolveRange, storeSavedViews, upsertView,
} from './savedViews'

/** Stable empty identity, so the filter bar does not re-render on every poll. */
const NO_GROUPS: Array<{ key: string; label: string }> = []

/** The reports a filing-readiness check belongs under. */
const FILING_REPORTS: ReadonlySet<string> = new Set(['GST_RATE_SUMMARY', 'HSN_SUMMARY'])

/**
 * Reports.
 *
 * Marg ships around 120 report entries across six menus; its own knowledge base
 * is then full of "where is X" and "why does X not match Y". That menu is a
 * sales artefact and simultaneously the product's biggest usability liability,
 * so this screen deliberately ships THIRTEEN reports and no menu tree — the ones
 * a pharmacist opens daily, the ones their accountant needs monthly, and the one
 * an inspector can ask for without notice.
 *
 * Five rules the incumbents break and this screen does not:
 *
 *  1. EVERY REPORT SAYS WHAT IT ANSWERS. The question sits under the title, in
 *     a sentence, before any grid. If the reader has to read a table to work out
 *     what the table is, the report failed.
 *  2. THE BASIS IS ON THE PAGE. Valuation basis, cost basis, as-on date, what is
 *     in and what is out. Marg's gross profit silently switches between taxable
 *     value and bill value from a setting three menus deep; every basis here is
 *     printed and travels into the CSV.
 *  3. THE VIEW IS THE URL. A report is a link an accountant can be sent, and
 *     Back walks the filters that were actually applied. A view worth repeating
 *     is saved by NAME and re-runs — never a cached number.
 *  4. RECONCILIATION IS A FIRST-CLASS OUTPUT. Where two figures must agree, the
 *     screen proves they do rather than asking to be trusted.
 *  5. EVERY DERIVED PICTURE READS THE ROWS ON SCREEN. The headline, the chart
 *     and the comparison are all computed from the same filtered set the footer
 *     totals, so none of them can disagree with the table underneath.
 */

interface ReportMeta {
  id: ReportId
  label: string
  group: string
  icon: LucideIcon
  /** Shown under the label in the rail — why this one exists, in a few words. */
  blurb: string
  /** The gate the API answers FORBIDDEN on. Typed as `Permission`, so the denied
   *  state can only ever name a permission a manager can actually grant.
   *  Anything printing landed cost sits behind the cost gate, not the sales one. */
  permission: Permission
}

/*
 * Grouped by who asks for it and how often, which is the only ordering that
 * matches how these get opened: the day book every morning, expiry and
 * outstanding weekly, GST once a month, the H1 register when an inspector walks
 * in. Anything that would only ever fill a feature matrix — ratio analysis,
 * cash-flow, ABC, cost centres, a report designer — is deliberately absent.
 */
const REPORTS: ReportMeta[] = [
  { id: 'DAY_BOOK', label: 'Day book', group: 'Counter', icon: BookOpenCheck, blurb: 'What was billed and collected', permission: 'reports.sales' },
  { id: 'SALES_BY_DAY', label: 'Day-wise sales', group: 'Counter', icon: CalendarDays, blurb: 'How the month is trading', permission: 'reports.sales' },
  { id: 'ITEM_SALES', label: 'Item-wise sales', group: 'Sales & margin', icon: Receipt, blurb: 'What sold, and what it earned', permission: 'reports.sales' },
  { id: 'BATCH_MARGIN', label: 'Batch-wise margin', group: 'Sales & margin', icon: TrendingUp, blurb: 'Margin on the cost actually paid', permission: 'reports.margin' },
  { id: 'GST_RATE_SUMMARY', label: 'GST rate-wise', group: 'Tax', icon: Landmark, blurb: 'Output tax, with the proof it foots', permission: 'reports.gst' },
  { id: 'HSN_SUMMARY', label: 'HSN summary', group: 'Tax', icon: ClipboardList, blurb: 'The Table 12 working', permission: 'reports.gst' },
  { id: 'PURCHASE_REGISTER', label: 'Purchase register', group: 'Tax', icon: Truck, blurb: 'What came in, and the tax with it', permission: 'reports.margin' },
  { id: 'H1_REGISTER', label: 'Schedule H1 register', group: 'Statutory', icon: ShieldCheck, blurb: 'Rule 65 register, on demand', permission: 'reports.audit' },
  { id: 'CONTROLLED_BALANCE', label: 'Controlled-drug register', group: 'Statutory', icon: Scale, blurb: 'Running balance per drug, reconciled to the shelf', permission: 'reports.audit' },
  { id: 'CUSTOMER_OUTSTANDING', label: 'Customer outstanding', group: 'Money', icon: Wallet, blurb: 'Who owes, and for how long', permission: 'reports.sales' },
  { id: 'SUPPLIER_OUTSTANDING', label: 'Supplier outstanding', group: 'Money', icon: Wallet, blurb: 'Who to pay this week', permission: 'reports.sales' },
  { id: 'STOCK_VALUATION', label: 'Stock valuation', group: 'Stock', icon: Boxes, blurb: 'One basis, printed on the report', permission: 'reports.margin' },
  { id: 'NEAR_EXPIRY', label: 'Near-expiry liability', group: 'Stock', icon: Boxes, blurb: 'Money with a deadline on it', permission: 'reports.margin' },
  { id: 'NON_MOVING', label: 'Non-moving stock', group: 'Stock', icon: Boxes, blurb: 'Money standing still', permission: 'reports.margin' },
]

const REPORT_IDS_SET = new Set<string>(REPORTS.map((r) => r.id))
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

const INSIGHTS_KEY = 'rxbill.reports.insights'

interface ViewState {
  reportId: ReportId
  from: string
  to: string
  term: string
  facet: string
  /** A column key. Empty is flat, which is what a fresh report always opens as. */
  groupBy: string
  /** Run the previous period alongside this one. */
  compare: boolean
}

function readView(p: URLSearchParams, today: Date): ViewState {
  const raw = p.get('r')
  const reportId = (raw !== null && REPORT_IDS_SET.has(raw) ? raw : 'DAY_BOOK') as ReportId
  // Month-to-date is the default because it is the window both daily questions
  // and the monthly filing land inside; a wrong default costs two clicks, a
  // wrong default that silently truncates a filing costs a return.
  const fallback = defaultRange(today)
  const from = p.get('from')
  const to = p.get('to')
  return {
    reportId,
    from: from !== null && isIsoDate(from) ? from : fallback.from,
    to: to !== null && isIsoDate(to) ? to : fallback.to,
    term: p.get('q') ?? '',
    facet: p.get('f') ?? '',
    groupBy: p.get('g') ?? '',
    // Honoured only where a previous period means anything; see `compare.ts`.
    compare: p.get('c') === '1' && isComparable(reportId),
  }
}

function toParams(v: ViewState, today: Date): URLSearchParams {
  const p = new URLSearchParams()
  const fallback = defaultRange(today)
  if (v.reportId !== 'DAY_BOOK') p.set('r', v.reportId)
  if (v.from !== fallback.from) p.set('from', v.from)
  if (v.to !== fallback.to) p.set('to', v.to)
  if (v.term.trim()) p.set('q', v.term.trim())
  if (v.facet) p.set('f', v.facet)
  /* In the URL, so a grouped report is a link. The question a manager actually
     asks is "sales by manufacturer, last month" — that is a report, a range and
     an index, and all three have to survive being pasted into a message. */
  if (v.groupBy) p.set('g', v.groupBy)
  if (v.compare && isComparable(v.reportId)) p.set('c', '1')
  return p
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function readInsightsOpen(): boolean {
  try {
    return window.localStorage.getItem(INSIGHTS_KEY) !== '0'
  } catch {
    return true
  }
}

export function ReportsScreen() {
  const api = useApi()
  const [params, setParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement>(null)
  const [basisOpen, setBasisOpen] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(readInsightsOpen)
  const [saving, setSaving] = useState(false)
  const [views, setViews] = useState<SavedView[]>(loadSavedViews)
  /** The report being handed to the printer. Mounted only while printing. */
  const [sheet, setSheet] = useState<ReportResult | null>(null)

  /* Injected once per mount, exactly as the inventory screen takes it: a
     component that reads the clock per render disagrees with itself at midnight
     and re-runs every query when it does. */
  const today = useMemo(() => new Date(), [])
  const view = useMemo(() => readView(params, today), [params, today])
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

  const query = useMemo<ReportQuery>(() => ({
    reportId: view.reportId,
    from: view.from,
    to: view.to,
    ...(view.term.trim() ? { term: view.term.trim() } : {}),
    ...(view.facet ? { facet: view.facet } : {}),
    ...(view.groupBy ? { groupBy: view.groupBy } : {}),
  }), [view])

  const report = useQuery({
    queryKey: ['reports', query],
    queryFn: () => api.runReport(query),
    /* The previous report stays on screen while the next resolves. Dropping to a
       skeleton on every keystroke is what makes a fast grid feel slow. */
    placeholderData: keepPreviousData,
  })

  const range: Range = useMemo(() => ({ from: view.from, to: view.to }), [view.from, view.to])
  const before = useMemo(() => previousRange(range), [range])
  const priorQuery = useMemo<ReportQuery>(
    () => ({ ...query, from: before.from, to: before.to }),
    [query, before],
  )
  /* The SAME report over the previous window — never a second aggregation. The
     key is shaped exactly like the main one, so flipping the dates back and
     forth is served from cache instead of re-running the engine. */
  const prior = useQuery({
    queryKey: ['reports', priorQuery],
    queryFn: () => api.runReport(priorQuery),
    enabled: view.compare,
    placeholderData: keepPreviousData,
  })

  const store = useQuery({ queryKey: qk.store, queryFn: () => api.getStore() })

  const patch = useCallback(
    (next: Partial<ViewState>) => {
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams(
        (prev) => {
          const merged = { ...readView(prev, today), ...next }
          // A different report has different facets, so carrying one over would
          // silently filter the new report by an axis it does not have.
          // Same for the index: a column key means nothing to a different
          // report, and one that happens to collide would group by the wrong
          // thing under a control that looks correct.
          const cleaned = next.reportId !== undefined
            ? { ...merged, facet: '', groupBy: '' }
            : merged
          return toParams(cleaned, today)
        },
        { replace: termOnly },
      )
    },
    [setParams, today],
  )

  const result = report.data ?? null
  const priorResult = view.compare ? prior.data ?? null : null

  const deltas = useMemo(
    () => compareHeadlines(result?.headline ?? [], priorResult?.headline ?? null),
    [result, priorResult],
  )

  const onExport = useCallback(() => {
    if (result === null) return
    downloadCsv(result)
    toast.success(`${result.title} exported`, {
      description: 'UTF-8 with a byte-order mark, and the basis, filters and control totals in the header rows.',
    })
  }, [result])

  const onPrint = useCallback(() => {
    if (result === null || result.rows.length === 0) return
    setSheet(result)
  }, [result])

  /* The sheet has to be in the document before the browser is asked to lay it
     out, so printing waits one frame and then takes it straight back down —
     print.css hides the app shell, and a sheet left mounted would blank the
     screen for anyone who pressed the browser's own print afterwards. */
  useEffect(() => {
    if (sheet === null) return
    const frame = window.requestAnimationFrame(() => {
      window.print()
      setSheet(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sheet])

  const onCopyLink = useCallback(() => {
    const url = window.location.href
    /* The clipboard API is absent on a plain-HTTP LAN origin, which is exactly
       how these tills are deployed. Showing the link is a worse copy and a much
       better failure than a button that silently does nothing. */
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      toast.info('Copy this link', { description: url })
      return
    }
    void clipboard.writeText(url).then(
      () => toast.success('Link copied', {
        description: 'It carries the report, the period, the filters and the index — whoever opens it sees this exact view.',
      }),
      () => toast.info('Copy this link', { description: url }),
    )
  }, [])

  const saveViews = useCallback((next: SavedView[]) => {
    setViews(next)
    storeSavedViews(next)
  }, [])

  const onSaveView = useCallback((name: string) => {
    const preset = presetKeyFor(range, today)
    const next = upsertView(views, {
      id: newViewId(Date.now()),
      name,
      reportId: view.reportId,
      preset,
      from: view.from,
      to: view.to,
      term: view.term,
      facet: view.facet,
      groupBy: view.groupBy,
      savedAt: new Date().toISOString(),
    })
    saveViews(next)
    setSaving(false)
    toast.success(`Saved as “${name}”`, {
      description: preset === null
        ? `Pinned to ${describeRange(range)}. Saved views live in this browser only.`
        : `Rolling: it will open on ${PRESETS.find((p) => p.key === preset)?.label.toLowerCase() ?? 'this period'} whenever it is opened. Saved views live in this browser only.`,
    })
  }, [range, today, view, views, saveViews])

  const onOpenView = useCallback((saved: SavedView) => {
    const opened = resolveRange(saved, today)
    setParams(toParams({
      reportId: saved.reportId,
      from: opened.from,
      to: opened.to,
      term: saved.term,
      facet: saved.facet,
      groupBy: saved.groupBy,
      compare: false,
    }, today))
  }, [setParams, today])

  /* '/', Ctrl+E and Ctrl+P are screen-local: SHORTCUTS is the app-wide contract,
     and a grid that exists on one route has no business claiming a global key.
     Ctrl+P is taken deliberately — print.css hides every body child that is not
     a sheet, so the browser's own print on this route would produce a blank
     page. Here it produces the report. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (ctrl && key === 'e') {
        e.preventDefault()
        onExport()
        return
      }
      if (ctrl && key === 'p') {
        e.preventDefault()
        onPrint()
        return
      }
      if (ctrl || isTypingTarget(e.target) || e.key !== '/') return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onExport, onPrint])

  const error = report.error
  const denied = error instanceof ApiError && DENIED_CODES.has(error.code)
  const status: RunnerStatus = denied
    ? 'denied'
    : !online && !report.data
      ? 'offline'
      : error
        ? 'error'
        : report.isPending
          ? 'loading'
          : 'ready'

  const filtered = view.term.trim() !== '' || view.facet !== ''
  const activePreset = presetKeyFor(range, today)
  const comparable = isComparable(view.reportId)

  return (
    <div className="flex h-full flex-col bg-app">
      <header className="page-header flex shrink-0 flex-wrap items-end justify-between gap-4 px-[var(--page-px)] py-3">
        <div className="min-w-[240px] flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">Reports</h1>
          {/* The report's QUESTION is its identity on this screen — the title
              never appears here, only in the export and the saved view. Counted
              from the catalogue rather than written out: "Thirteen" was already
              wrong the day a fourteenth report was added. */}
          <p
            data-testid="report-question"
            className="mt-0.5 line-clamp-2 max-w-[78ch] text-sm text-fg-muted [@media(max-height:760px)]:line-clamp-1"
          >
            {result
              ? result.question
              : `${REPORTS.length} reports a pharmacy actually opens — each answering one question, `
                + 'each printing the basis it was computed on.'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant={view.compare ? 'primary' : 'secondary'}
            aria-pressed={view.compare}
            disabled={!comparable}
            title={comparable ? `Run ${describeRange(before)} alongside this period` : whyNotComparable(view.reportId)}
            onClick={() => patch({ compare: !view.compare })}
          >
            <GitCompareArrows /> Compare
          </Button>

          <SaveViewButton
            open={saving}
            onOpenChange={setSaving}
            suggestion={result ? `${result.title} · ${describeRange(range)}` : 'My view'}
            onSave={onSaveView}
          />

          <Button variant="secondary" onClick={onCopyLink} title="Copy a link to exactly this view">
            <Link2 /> Link
          </Button>

          <Button
            variant="secondary"
            onClick={onPrint}
            disabled={result === null || result.rows.length === 0}
            title="Print this report with its basis and totals"
          >
            <Printer /> Print <Kbd>Ctrl P</Kbd>
          </Button>

          <Button variant="primary" onClick={onExport} disabled={result === null || result.rows.length === 0}>
            <Download /> Export CSV <Kbd className="border-transparent bg-white text-accent-11">Ctrl E</Kbd>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-[var(--card-gap)] px-[var(--page-px)] py-[var(--card-gap)]">
        <ReportRail
          selected={view.reportId}
          onSelect={(reportId) => patch({ reportId })}
          views={views}
          onOpenView={onOpenView}
          onRename={(id, name) => saveViews(renameView(views, id, name))}
          onRemove={(id) => saveViews(removeView(views, id))}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--card-gap)]">
          <Controls
            view={view}
            today={today}
            activePreset={activePreset}
            facetLabel={result?.facetLabel ?? null}
            facets={result?.facets ?? []}
            groupable={result?.groupable ?? NO_GROUPS}
            searchRef={searchRef}
            onPatch={patch}
          />

          <Headline
            deltas={deltas}
            pending={status === 'loading'}
            comparing={view.compare}
            comparedTo={describeRange(before)}
            priorPending={view.compare && prior.isPending}
          />

          <div className="flex min-h-0 flex-1 flex-col gap-[var(--card-gap)] xl:flex-row">
            {/* The grid keeps its own density. Everything around it breathes at
                the page's, but a report is read by the row and 34px rows are
                what let a month of them be scanned without scrolling. */}
            <div data-density="compact" className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ReportRunner
                result={result}
                status={status}
                needs={REPORTS.find((r) => r.id === view.reportId)?.permission ?? 'reports.sales'}
                errorCode={error instanceof ApiError ? error.code : 'REPORT_FAILED'}
                errorMessage={error ? (error as Error).message : undefined}
                filtered={filtered}
                onRetry={() => void report.refetch()}
                onClearFilters={() => patch({ term: '', facet: '' })}
              />
            </div>

            <aside
              aria-label="Alongside this report"
              /* A container query, not a viewport one: the panels inside are
                 the same components at 352px and at full width, and they must
                 lay themselves out against the column they are actually in.
                 Collapsing is an xl-only affordance — below that the panel is a
                 strip under the grid, and the toggle that would restore it has
                 nowhere sensible to sit. */
              className={cn(
                '@container scroll-region flex max-h-[46%] shrink-0 flex-col gap-[var(--card-gap)]',
                'overflow-y-auto xl:max-h-none xl:w-[300px] 2xl:w-[352px]',
                !insightsOpen && 'xl:hidden',
              )}
            >
              {view.compare ? (
                <ComparePanel
                  deltas={deltas}
                  range={range}
                  before={before}
                  pending={prior.isPending}
                  failed={prior.error !== null && prior.error !== undefined}
                />
              ) : null}

              {result ? <ReportChart result={result} /> : null}

              {result && result.checks.length > 0 ? <GstSummary checks={result.checks} /> : null}

              {/* On the two GST reports only, because those ARE the filing
                  working and the question "can this month go" is the next
                  thing anybody asks after reading them. Everywhere else it
                  would be a compliance panel above a stock report. */}
              {FILING_REPORTS.has(view.reportId) ? (
                <FilingCheckPanel from={view.from} to={view.to} />
              ) : null}

              <BasisPanel
                open={basisOpen}
                onToggle={() => setBasisOpen((v) => !v)}
                basis={result?.basis ?? []}
                notes={result?.notes ?? []}
                generatedAt={result?.generatedAt ?? null}
              />
            </aside>

            <button
              type="button"
              onClick={() => {
                setInsightsOpen((open) => {
                  try {
                    window.localStorage.setItem(INSIGHTS_KEY, open ? '0' : '1')
                  } catch {
                    /* A preference is not worth an error state. */
                  }
                  return !open
                })
              }}
              aria-pressed={insightsOpen}
              title={insightsOpen ? 'Hide the panel beside the report' : 'Show the chart, the proof and the basis'}
              className={cn(
                'hidden w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
                'text-fg-subtle hover:bg-hover hover:text-fg xl:flex',
              )}
            >
              {insightsOpen ? <PanelRightClose size={16} aria-hidden /> : <PanelRightOpen size={16} aria-hidden />}
              <span className="sr-only">{insightsOpen ? 'Hide the side panel' : 'Show the side panel'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* The sheet mounts as a direct child of <body>: print.css hides every
          other body child on paper, which is the only way the app shell is
          guaranteed gone whatever the screen happens to be showing. */}
      {sheet
        ? createPortal(<ReportSheet result={sheet} store={store.data ?? null} />, document.body)
        : null}
    </div>
  )
}

// ------------------------------------------------------------------- rail ---

function ReportRail({
  selected, onSelect, views, onOpenView, onRename, onRemove,
}: {
  selected: ReportId
  onSelect: (id: ReportId) => void
  views: SavedView[]
  onOpenView: (view: SavedView) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}) {
  const groups = REPORTS.reduce<Array<{ label: string; items: ReportMeta[] }>>((acc, item) => {
    const last = acc.at(-1)
    if (last && last.label === item.group) last.items.push(item)
    else acc.push({ label: item.group, items: [item] })
    return acc
  }, [])

  return (
    <nav
      aria-label="Reports"
      className="card scroll-region hidden w-[212px] shrink-0 flex-col gap-1 overflow-y-auto p-2 lg:flex 2xl:w-[244px]"
    >
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col">
          <span className="micro-label px-2 pb-1 pt-2">{group.label}</span>
          {group.items.map((item) => {
            const active = item.id === selected
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex items-start gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left',
                  'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                  active ? 'bg-accent-3 text-accent-11' : 'text-fg hover:bg-hover',
                )}
              >
                <item.icon size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  <span className={cn('block truncate text-2xs', active ? 'text-accent-11' : 'text-fg-subtle')}>
                    {item.blurb}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ))}

      <SavedViews views={views} onOpen={onOpenView} onRename={onRename} onRemove={onRemove} />
    </nav>
  )
}

/**
 * Saved views, in the rail beside the reports they name.
 *
 * They sit here rather than behind a menu because the whole point is that the
 * repeated setup is as reachable as the report itself. The footnote is not
 * decoration: these live in one browser, and a panel that let a shop believe
 * otherwise would eventually lose somebody's month-end setup silently.
 */
function SavedViews({
  views, onOpen, onRename, onRemove,
}: {
  views: SavedView[]
  onOpen: (view: SavedView) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <div className="mt-2 flex flex-col border-t border-border-subtle pt-1">
      <span className="micro-label flex items-center gap-1.5 px-2 pb-1 pt-2">
        <Star size={12} aria-hidden />
        Saved views
      </span>

      {views.length === 0 ? (
        <p className="px-2 pb-1 text-2xs leading-snug text-fg-subtle">
          Set a report up the way you need it, then use Save view. It keeps the period, the
          filters and the index — and re-runs them, so it can never show a stale number.
        </p>
      ) : (
        views.map((v) => {
          const meta = REPORTS.find((r) => r.id === v.reportId)
          if (editing === v.id) {
            return (
              <form
                key={v.id}
                className="flex items-center gap-1 px-1 py-1"
                onSubmit={(e) => {
                  e.preventDefault()
                  const input = e.currentTarget.elements.namedItem('name')
                  if (input instanceof HTMLInputElement) onRename(v.id, input.value)
                  setEditing(null)
                }}
              >
                <input
                  name="name"
                  defaultValue={v.name}
                  autoFocus
                  aria-label={`Rename ${v.name}`}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) } }}
                  className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 text-xs"
                />
                <Button type="submit" size="sm" variant="primary">Save</Button>
              </form>
            )
          }
          return (
            <div key={v.id} className="group/view flex items-center gap-0.5 rounded-[var(--radius-md)] pr-1 hover:bg-hover">
              <button
                type="button"
                onClick={() => onOpen(v)}
                className="min-w-0 flex-1 rounded-[var(--radius-md)] px-2 py-1.5 text-left"
              >
                <span className="block truncate text-sm text-fg">{v.name}</span>
                <span className="block truncate text-2xs text-fg-subtle">
                  {meta?.label ?? v.reportId}
                  {' · '}
                  {v.preset === null
                    ? describeRange({ from: v.from, to: v.to })
                    : `${PRESETS.find((p) => p.key === v.preset)?.label ?? 'Rolling'}, rolling`}
                </span>
              </button>

              {confirming === v.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="danger" onClick={() => { onRemove(v.id); setConfirming(null) }}>
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>No</Button>
                </span>
              ) : (
                <span className="flex shrink-0 items-center opacity-0 group-focus-within/view:opacity-100 group-hover/view:opacity-100">
                  <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(v.id)} title={`Rename ${v.name}`}>
                    <Pencil size={13} />
                    <span className="sr-only">Rename {v.name}</span>
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7" onClick={() => setConfirming(v.id)} title={`Delete ${v.name}`}>
                    <Trash2 size={13} />
                    <span className="sr-only">Delete {v.name}</span>
                  </Button>
                </span>
              )}
            </div>
          )
        })
      )}

      <p className="px-2 pb-1 pt-2 text-2xs leading-snug text-fg-subtle">
        Kept in this browser only — not backed up, and not shared with the other till.
      </p>
    </div>
  )
}

// -------------------------------------------------------------- save view ---

function SaveViewButton({
  open, onOpenChange, suggestion, onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suggestion: string
  onSave: (name: string) => void
}) {
  return (
    <div className="relative">
      <Button variant="secondary" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <Star /> Save view
      </Button>

      {open ? (
        <>
          {/* A quiet dismiss layer: clicking anywhere else puts it away, which
              is what every reader expects of a small panel like this. */}
          <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} aria-hidden />
          <form
            role="dialog"
            aria-label="Save this view"
            className="card absolute right-0 top-[calc(100%+8px)] z-50 w-[320px] p-[var(--card-px)] shadow-lg"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onOpenChange(false) } }}
            onSubmit={(e) => {
              e.preventDefault()
              const input = e.currentTarget.elements.namedItem('viewName')
              if (input instanceof HTMLInputElement && input.value.trim() !== '') {
                onSave(input.value.trim().slice(0, 48))
              }
            }}
          >
            <label className="micro-label block" htmlFor="viewName">Name this view</label>
            <input
              id="viewName"
              name="viewName"
              defaultValue={suggestion.slice(0, 48)}
              autoFocus
              maxLength={48}
              className="mt-1.5 h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base"
            />
            <p className="mt-2 text-2xs leading-snug text-fg-muted">
              Saves the report, the period, the filters and the index. A period that matches one of
              the buttons above is saved as ROLLING — “this month” opens on the month you open it
              in. Anything else is pinned to its dates.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant="primary">Save view</Button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  )
}

// --------------------------------------------------------------- controls ---

function Controls({
  view, today, activePreset, facetLabel, facets, groupable, searchRef, onPatch,
}: {
  view: ViewState
  today: Date
  activePreset: string | null
  facetLabel: string | null
  facets: Array<{ value: string; label: string; count: number }>
  groupable: Array<{ key: string; label: string }>
  searchRef: React.RefObject<HTMLInputElement | null>
  onPatch: (patch: Partial<ViewState>) => void
}) {
  /* The box is local and the URL is debounced behind it: writing a search param
     per keystroke gives Back twenty stops inside one word. */
  const [draft, setDraft] = useState(view.term)
  const [lastTerm, setLastTerm] = useState(view.term)
  if (view.term !== lastTerm) {
    setLastTerm(view.term)
    setDraft(view.term)
  }

  useEffect(() => {
    if (draft === view.term) return
    const id = window.setTimeout(() => onPatch({ term: draft }), 140)
    return () => window.clearTimeout(id)
  }, [draft, view.term, onPatch])

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={searchRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && draft !== '') { e.stopPropagation(); setDraft('') } }}
          type="search"
          aria-label="Filter the rows of this report"
          placeholder="Filter rows…"
          autoComplete="off"
          spellCheck={false}
          className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-10 pr-11 text-base shadow-xs placeholder:text-fg-subtle hover:border-border-strong"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>
      </div>

      {facetLabel !== null && facets.length > 0 ? (
        <label className="relative shrink-0">
          <span className="sr-only">{facetLabel}</span>
          <select
            value={view.facet}
            onChange={(e) => onPatch({ facet: e.target.value })}
            className={cn(
              'h-[var(--control-h)] max-w-[196px] appearance-none rounded-[var(--radius-md)] border border-border bg-surface shadow-xs',
              'pl-3 pr-8 text-base text-fg hover:border-border-strong',
              view.facet === '' ? 'text-fg-muted' : 'font-medium',
            )}
          >
            <option value="">Any {facetLabel.toLowerCase()}</option>
            {facets.map((f) => (
              <option key={f.value} value={f.value}>{f.label} ({f.count})</option>
            ))}
          </select>
          <Chevron />
        </label>
      ) : null}

      {groupable.length > 0 || view.groupBy !== '' ? (
        <label className="relative shrink-0">
          <span className="sr-only">Group the rows by a column</span>
          <Layers
            size={15}
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2',
              view.groupBy === '' ? 'text-fg-subtle' : 'text-accent-11',
            )}
          />
          <select
            value={view.groupBy}
            onChange={(e) => onPatch({ groupBy: e.target.value })}
            className={cn(
              'h-[var(--control-h)] max-w-[212px] appearance-none rounded-[var(--radius-md)] border bg-surface shadow-xs',
              'pl-9 pr-8 text-base hover:border-border-strong',
              view.groupBy === ''
                ? 'border-border text-fg-muted'
                : 'border-accent-9/40 bg-accent-1 font-medium text-fg',
            )}
          >
            <option value="">No grouping</option>
            {groupable.map((g) => (
              /* The column's label VERBATIM. Lower-casing it to read as a
                 sentence turned "HSN" into "hsn" and "GST %" into "gst %",
                 and a mangled acronym in a control is read as a bug. */
              <option key={g.key} value={g.key}>By {g.label}</option>
            ))}
            {/* A grouping the current filter has made pointless still has to be
                listed, or the control would show blank while the table under it
                is plainly banded — and the only way back to flat would be to
                pick some other column first. */}
            {view.groupBy !== '' && !groupable.some((g) => g.key === view.groupBy) ? (
              <option value={view.groupBy}>By {view.groupBy}</option>
            ) : null}
          </select>
          <Chevron />
        </label>
      ) : null}

      <PeriodPicker view={view} today={today} activePreset={activePreset} onPatch={onPatch} />

      {view.facet || view.term.trim() ? (
        <button
          type="button"
          onClick={() => onPatch({ term: '', facet: '' })}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-full)] border border-border-subtle bg-subtle px-3 text-xs text-fg hover:border-border-strong"
        >
          Clear filters
          <X size={13} aria-hidden className="text-fg-subtle" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * One control for the period, instead of seven.
 *
 * Five preset buttons and two date fields is 630px of a filter row, and on the
 * 1366px counter panel that pushed the search, the facet and the index onto a
 * second line and cost the grid a hundred pixels of height it cannot spare.
 * Collapsed, the control still says what the period IS — a picker that hides the
 * answer behind a click would be a worse trade than the row it replaced.
 */
function PeriodPicker({
  view, today, activePreset, onPatch,
}: {
  view: ViewState
  today: Date
  activePreset: string | null
  onPatch: (patch: Partial<ViewState>) => void
}) {
  const [open, setOpen] = useState(false)
  const range: Range = { from: view.from, to: view.to }
  const days = dayCount(view.from, view.to)

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Period: ${describeRange(range)}. Change it.`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[var(--control-h)] items-center gap-2 rounded-[var(--radius-md)] border bg-surface',
          'px-3 text-base shadow-xs hover:border-border-strong',
          open ? 'border-border-strong' : 'border-border',
        )}
      >
        <CalendarDays size={16} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="font-medium text-fg">{describeRange(range)}</span>
        <span className="text-2xs text-fg-subtle">
          {activePreset === null ? `${days} day${days === 1 ? '' : 's'}` : PRESETS.find((p) => p.key === activePreset)?.label}
        </span>
        <svg aria-hidden viewBox="0 0 12 12" className="size-3 text-fg-subtle">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="Period"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}
            className="card absolute right-0 top-[calc(100%+8px)] z-50 w-[320px] p-[var(--card-px)] shadow-lg"
          >
            <span className="micro-label">Common periods</span>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5" role="group" aria-label="Common periods">
              {PRESETS.map((preset) => {
                const active = activePreset === preset.key
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { onPatch(preset.range(today)); setOpen(false) }}
                    className={cn(
                      'h-9 rounded-[var(--radius-md)] border px-2 text-sm',
                      'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                      active
                        ? 'border-accent-9 bg-accent-3 font-medium text-accent-11'
                        : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                    )}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>

            <span className="micro-label mt-3 block">Or an exact range</span>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="date"
                aria-label="Period starts"
                value={view.from}
                max={view.to}
                onChange={(e) => onPatch({ from: e.target.value })}
                className="h-[var(--control-h)] min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
              />
              <span aria-hidden className="text-fg-subtle">–</span>
              <input
                type="date"
                aria-label="Period ends"
                value={view.to}
                min={view.from}
                onChange={(e) => onPatch({ to: e.target.value })}
                className="h-[var(--control-h)] min-w-0 flex-1 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
              />
            </div>

            <p className="mt-2 text-2xs leading-snug text-fg-subtle">
              {days} day{days === 1 ? '' : 's'}. Compare runs the same report over the
              {' '}{days} days immediately before this period.
            </p>
          </div>
        </>
      ) : null}
    </div>
  )
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2 text-fg-subtle">
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// --------------------------------------------------------------- headline ---

const formatValue = (tile: ReportHeadline): string =>
  tile.kind === 'money' ? formatAmount(tile.value)
    : tile.kind === 'qty' ? formatQty(tile.value)
      : tile.kind === 'pct' ? formatPercent(tile.value)
        : tile.value

/**
 * The answer, before the table.
 *
 * Every report opens with the figures it exists to produce, and ONE of them is
 * given display size: the reader who looks at this screen for two seconds should
 * leave with the number the report is named after. The hero is the first money
 * figure, because that is what these reports are for; a report with no money in
 * its headline leads with whatever it counts instead.
 */
function Headline({
  deltas, pending, comparing, comparedTo, priorPending,
}: {
  deltas: HeadlineDelta[]
  pending: boolean
  comparing: boolean
  comparedTo: string
  priorPending: boolean
}) {
  if (deltas.length === 0 || pending) {
    return (
      <div className="flex shrink-0 gap-[var(--card-gap)]" aria-busy={pending}>
        <div className="card h-[104px] w-[300px] shrink-0 animate-pulse" />
        <div className="card h-[104px] min-w-0 flex-1 animate-pulse" />
      </div>
    )
  }

  const heroIndex = Math.max(deltas.findIndex((d) => d.headline.kind === 'money'), 0)
  const hero = deltas[heroIndex]
  const rest = deltas.filter((_, i) => i !== heroIndex)
  if (hero === undefined) return null

  return (
    <div className="flex shrink-0 flex-wrap items-stretch gap-[var(--card-gap)]">
      <section
        className="card flex min-w-[224px] flex-col justify-center gap-1 px-[var(--card-px)] py-3 [@media(max-height:760px)]:py-2"
        title={hero.headline.hint}
      >
        <span className="micro-label truncate">{hero.headline.label}</span>
        <span className="flex items-baseline gap-1 truncate">
          {hero.headline.kind === 'money' ? (
            <span className="text-xl font-medium text-fg-muted">₹</span>
          ) : null}
          <span className="display-num truncate text-4xl text-fg [@media(max-height:760px)]:text-3xl">
            {formatValue(hero.headline)}
          </span>
        </span>
        {comparing ? <Delta delta={hero} comparedTo={comparedTo} pending={priorPending} /> : null}
      </section>

      {/* auto-fit rather than a fixed column count: reports carry four, five or
          six figures, and a five-column grid leaves the sixth stranded on a row
          of its own while flex-1 stretches two figures across half a screen. */}
      <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(144px,1fr))] gap-[var(--card-gap)]">
        {rest.map((delta) => (
          <div
            key={delta.headline.label}
            className="card flex min-w-0 flex-col justify-center gap-0.5 px-[var(--card-px)] py-3 [@media(max-height:760px)]:py-1.5"
            title={delta.headline.hint}
          >
            <span className="micro-label truncate">{delta.headline.label}</span>
            <span className="truncate">
              <StatValue
                className="text-lg"
                symbol={delta.headline.kind === 'money' ? '₹' : undefined}
                value={formatValue(delta.headline)}
              />
            </span>
            {comparing ? (
              <Delta delta={delta} comparedTo={comparedTo} pending={priorPending} terse />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * A movement, stated in words and an arrow — never in colour alone.
 *
 * And never in green or red: a report screen cannot know whether a rise is good
 * news. More output tax is more sales; more purchase value is either a stock-up
 * or an overstock. The dashboard colours its deltas because its tiles are chosen
 * so that it can.
 */
function Delta({
  delta, comparedTo, pending, terse = false,
}: {
  delta: HeadlineDelta
  comparedTo: string
  pending: boolean
  /** Drop the range from the line. Six tiles naming the same period is noise —
   *  it is on the hero, in the header, and in this element's own tooltip. */
  terse?: boolean
}) {
  if (pending) return <span className="h-4 w-24 animate-pulse rounded-[var(--radius-full)] bg-inset" />
  if (delta.change === null) {
    return <span className="truncate text-2xs text-fg-subtle">Not comparable</span>
  }

  const Icon = delta.direction === 'up' ? ArrowUpRight : delta.direction === 'down' ? ArrowDownRight : Minus
  const sign = delta.direction === 'up' ? '+' : ''
  const text = delta.direction === 'flat'
    ? 'No change'
    : delta.headline.kind === 'pct'
      ? `${sign}${delta.change} pts`
      : delta.changePct !== null
        ? `${sign}${delta.changePct}%`
        : `${sign}${formatValue({ ...delta.headline, value: delta.change })}`

  return (
    <span className="flex items-center gap-1 text-2xs text-fg-muted" title={`${comparedTo}: ${delta.previous ?? '—'}`}>
      <Icon size={13} aria-hidden className="shrink-0 text-fg-subtle" />
      <span className="num font-medium">{text}</span>
      {terse ? null : <span className="truncate text-fg-subtle">vs {comparedTo}</span>}
    </span>
  )
}

// ---------------------------------------------------------------- compare ---

/**
 * The two periods, side by side, with the same figures in the same order.
 *
 * The tiles carry the movement; this carries the arithmetic behind it, because
 * "-18%" is a claim and "₹1,42,300 against ₹1,73,500" is the evidence for it.
 */
function ComparePanel({
  deltas, range, before, pending, failed,
}: {
  deltas: HeadlineDelta[]
  range: Range
  before: Range
  pending: boolean
  failed: boolean
}) {
  return (
    <section aria-label="Period comparison" className="card flex shrink-0 flex-col gap-2 p-[var(--card-px)]">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <GitCompareArrows size={15} className="text-fg-subtle" aria-hidden />
          Against the period before
        </h2>
      </header>

      {failed ? (
        <p className="text-xs text-danger-11">
          The previous period did not run. The figures on the left are still this period’s.
        </p>
      ) : null}

      <table className="w-full text-xs">
        <caption className="sr-only">
          {describeRange(range)} compared against {describeRange(before)}
        </caption>
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className="micro-label py-1 text-left">Figure</th>
            <th scope="col" className="micro-label py-1 text-right">{describeRange(range)}</th>
            <th scope="col" className="micro-label py-1 text-right">{describeRange(before)}</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((d) => (
            <tr key={d.headline.label} className="border-b border-border-subtle last:border-0">
              <td className="py-1 pr-2 text-fg-muted">{d.headline.label}</td>
              <td className="num py-1 font-medium text-fg">{formatValue(d.headline)}</td>
              <td className="num py-1 text-fg-muted">
                {pending ? '…' : d.previous === null ? '—' : formatValue({ ...d.headline, value: d.previous })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-2xs leading-snug text-fg-subtle">
        The same report, run again over the {dayCount(before.from, before.to)} days immediately
        before this period. Equal lengths, so a 30-day month is never compared against a 31-day one.
      </p>
    </section>
  )
}

// ------------------------------------------------------------------ basis ---

/**
 * What this report was computed on, and what it deliberately leaves out.
 *
 * Marg has a knowledge-base article explaining why its closing stock disagrees
 * with its stock-and-sale analysis; the answer is that the two run at different
 * grains and neither report says so. Every basis line here is one that would
 * otherwise have to be discovered.
 */
function BasisPanel({
  open, onToggle, basis, notes, generatedAt,
}: {
  open: boolean
  onToggle: () => void
  basis: readonly string[]
  notes: readonly string[]
  generatedAt: string | null
}) {
  const total = basis.length + notes.length
  if (total === 0) return null

  return (
    <div className="card shrink-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-[var(--card-px)] py-2.5 text-left text-xs text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Info size={14} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">
          {open ? 'How this report is computed' : `Basis & caveats (${total})`}
        </span>
        <span className="shrink-0 text-2xs text-fg-subtle">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-border-subtle px-[var(--card-px)] py-3">
          {basis.map((line) => (
            <p key={line} className="text-xs leading-snug text-fg-muted">{line}</p>
          ))}
          {notes.map((note) => (
            <p key={note} className="flex gap-1.5 text-xs leading-snug text-fg-subtle">
              <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-[var(--radius-full)] bg-warning-9" />
              <span>{note}</span>
            </p>
          ))}
          {generatedAt !== null ? (
            <p className="text-2xs text-fg-subtle">
              Generated {new Date(generatedAt).toLocaleString('en-IN')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
