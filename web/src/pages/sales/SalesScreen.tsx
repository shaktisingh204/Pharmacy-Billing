import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from 'radix-ui'
import { toast } from 'sonner'
import {
  Ban, CalendarCheck, Download, Lock, Receipt, Search, TriangleAlert, Undo2, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ApiAdapter, CreditNote, DayClose, DayCloseInput, IsoDate, PaymentMode, SaleInvoice,
  SaleRegisterRow, SaleReturnInput, SalesFilters, SalesPage, SalesSummary,
} from '@contract'
import { ApiError, PAYMENT_MODES } from '@contract'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import {
  RANGE_LABEL, RANGE_PRESETS, daysInRange, filterCreditNotes, isVoidable, previousRange,
  REASON_MIN, resolveRange, summariseReturns, summariseSales,
} from '@/api/sales'
import type { RangePreset } from '@/api/sales'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { useBrand } from '@/brand/useBrand'
import { reprintInvoice } from '@/print/printJob'
import { isConnected } from '@/print/serial'
import { downloadCsv } from '@/pages/reports/exportCsv'
import { InvoiceTable } from './InvoiceTable'
import type { TableStatus } from './InvoiceTable'
import { InvoiceDetail } from './InvoiceDetail'
import { SaleReturnDialog } from './SaleReturnDialog'
import { CreditNoteTable } from './CreditNoteTable'
import { ReturnsSummaryStrip, SalesAnalytics } from './SalesAnalytics'
import { creditNoteRegisterCsv, invoiceRegisterCsv } from './registerCsv'

/**
 * The sale register.
 *
 * Six months of trading is roughly eight and a half thousand documents, and no
 * pharmacist has ever scrolled through them. Four questions bring somebody
 * here — find THIS bill, what did the period take, what came back, and who was
 * on the counter — so the screen is a date range, an analytics header, and two
 * registers underneath it: the bills, and the credit notes that reverse them.
 * The whole view lives in the URL: "the credit sales from Tuesday" is a paste,
 * Back walks the filters the operator actually applied, and a reload lands on
 * the same open bill.
 *
 * The screen owns the URL, every query and every write; its children own no
 * state that outlives a keystroke. That is what lets the two grids, the sheet
 * and the three dialogs share one invalidation.
 *
 * WHAT THIS SCREEN WILL NOT DO, and each is a rule rather than an omission:
 *  - It never edits a posted document (I20). Not a quantity, not a rate, not a
 *    customer. The corrections are a credit note and a same-day cancellation,
 *    and both are documents of their own.
 *  - It never hides a cancelled bill. A voided invoice stays in the register,
 *    in place, marked, carrying its reason.
 *  - It never shows the expected cash before the drawer has been counted.
 */

const PAGE_SIZE = 150

/**
 * Which till this is.
 *
 * Hard-coded because terminal identity arrives with the session, not with this
 * screen — the seed bills terminal 1 and `postSale` numbers per terminal. It is
 * a constant rather than a literal sprinkled through the file so that the day
 * the session carries it, there is exactly one line to change.
 */
const TERMINAL_ID = 1

const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

const ThermalReceipt = lazy(() =>
  import('@/print').then((m) => ({ default: m.ThermalReceipt })),
)

type StatusFilter = NonNullable<SalesFilters['status']>
type SortKey = NonNullable<SalesFilters['sort']>
type RegisterTab = 'invoices' | 'returns'

const TABS: RegisterTab[] = ['invoices', 'returns']
const STATUS_VALUES: StatusFilter[] = ['all', 'posted', 'returned', 'voided']
const SORT_VALUES: SortKey[] = ['time', 'amount', 'invoiceNo']

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All bills',
  posted: 'Clean bills',
  returned: 'With a return',
  voided: 'Cancelled',
}

const SORT_LABEL: Record<SortKey, string> = {
  time: 'Newest first',
  amount: 'Largest first',
  invoiceNo: 'Invoice number',
}

/** The same three orders, named for the documents the returns tab is showing. */
const RETURN_SORT_LABEL: Record<SortKey, string> = {
  time: 'Newest first',
  amount: 'Largest refund',
  invoiceNo: 'Note number',
}

const MODE_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  CREDIT: 'Credit',
}

/** The shop's LOCAL calendar date. `toISOString().slice(0,10)` is the UTC one,
 *  which files a 9 a.m. sale under yesterday everywhere east of Greenwich. */
function localIsoDate(d: Date): IsoDate {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const LONG_DATE = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
const SHORT_DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })

/** '2026-09-09' -> 'Wed, 09 Sep 2026'. A heading is read, not parsed. */
function longDate(iso: IsoDate): string {
  const t = Date.parse(`${iso}T00:00:00`)
  return Number.isNaN(t) ? iso : LONG_DATE.format(t)
}

function shortDate(iso: IsoDate): string {
  const t = Date.parse(`${iso}T00:00:00`)
  return Number.isNaN(t) ? iso : SHORT_DATE.format(t)
}

/**
 * What the analytics header is comparing against, in words.
 *
 * Named rather than dated wherever there is a name for it — "yesterday" is
 * instantly checkable and "08 Sep – 08 Sep" is not — and dated the moment the
 * range stops having one.
 */
function previousLabelFor(view: ViewState, prev: { from: IsoDate; to: IsoDate }): string {
  const days = daysInRange(view.from, view.to)
  if (days === 1) return view.preset === 'today' ? 'yesterday' : `the day before (${shortDate(prev.from)})`
  if (view.preset === 'week') return 'the same days last week'
  return `the ${days} days before (${shortDate(prev.from)} – ${shortDate(prev.to)})`
}

/** The empty state's headline. Only the screen knows what range it is showing,
 *  so it composes the whole sentence rather than handing the grid a fragment to
 *  lowercase — "nothing was billed 2019-01-01 → 2019-01-02" is not English. */
function emptyTitleFor(view: ViewState): string {
  const what = view.tab === 'returns' ? 'came back' : 'was billed'
  const has = view.tab === 'returns' ? 'has come back' : 'has been billed'
  switch (view.preset) {
    case 'yesterday': return `Nothing ${what} yesterday`
    case 'week': return `Nothing ${has} this week`
    case 'month': return `Nothing ${has} this month`
    case 'custom':
      return view.from === view.to
        ? `Nothing ${what} on ${longDate(view.from)}`
        : `Nothing ${what} between ${longDate(view.from)} and ${longDate(view.to)}`
    case 'today':
    default: return `Nothing ${has} today`
  }
}

interface ViewState {
  tab: RegisterTab
  preset: RangePreset
  from: IsoDate
  to: IsoDate
  term: string
  /** '' is "any tender" — the contract's field is simply absent. On the returns
   *  tab the same axis means "refunded by", because it is the same question
   *  asked of the other document. */
  mode: PaymentMode | ''
  status: StatusFilter
  sort: SortKey
  /** The analytics band. Null means "whatever fits on this screen". */
  analytics: boolean | null
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback
}

function readView(p: URLSearchParams, today: IsoDate): ViewState {
  const preset = oneOf(p.get('r'), RANGE_PRESETS, 'today')
  const range = resolveRange(preset, today, { from: p.get('from') ?? '', to: p.get('to') ?? '' })
  const an = p.get('an')
  return {
    tab: oneOf(p.get('tab'), TABS, 'invoices'),
    preset,
    ...range,
    term: p.get('q') ?? '',
    mode: PAYMENT_MODES.find((m) => m === p.get('mode')) ?? '',
    status: oneOf(p.get('st'), STATUS_VALUES, 'all'),
    sort: oneOf(p.get('sort'), SORT_VALUES, 'time'),
    analytics: an === null ? null : an !== '0',
  }
}

/** Only non-default axes are written, so a clean view has a clean URL. */
function toParams(v: ViewState, selectedId: number | null): URLSearchParams {
  const p = new URLSearchParams()
  if (v.tab !== 'invoices') p.set('tab', v.tab)
  if (v.preset !== 'today') p.set('r', v.preset)
  // The dates ride in the URL ONLY for a custom range; for a preset they are
  // derived from today, so writing them would freeze "this week" to the week it
  // was shared in the moment somebody pasted the link.
  if (v.preset === 'custom') {
    p.set('from', v.from)
    p.set('to', v.to)
  }
  if (v.term.trim()) p.set('q', v.term.trim())
  if (v.mode) p.set('mode', v.mode)
  if (v.status !== 'all') p.set('st', v.status)
  if (v.sort !== 'time') p.set('sort', v.sort)
  if (v.analytics !== null) p.set('an', v.analytics ? '1' : '0')
  if (selectedId !== null) p.set('id', String(selectedId))
  return p
}

function toApiFilters(v: ViewState): SalesFilters {
  return {
    from: v.from,
    to: v.to,
    ...(v.term.trim() ? { term: v.term.trim() } : {}),
    ...(v.mode ? { mode: v.mode } : {}),
    status: v.status,
    sort: v.sort,
  }
}

/** The status axis belongs to bills alone: a credit note has no lifecycle. */
const isFiltered = (v: ViewState): boolean =>
  v.term.trim() !== '' || v.mode !== '' || (v.tab === 'invoices' && v.status !== 'all')

/**
 * Does the range on screen INCLUDE today?
 *
 * Not "is the preset today" — a month-to-date or a custom range ending in the
 * future carries today's cash just as plainly, and it is the figure that has to
 * stay hidden, not the preset. Anything that contains today withholds it.
 */
const showsToday = (v: ViewState, today: IsoDate): boolean => v.from <= today && v.to >= today

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * Is there room for the analytics header?
 *
 * The design floor is a 1366x640 counter panel, and on one the four analytics
 * cards cost half the register. The band is not removed there — it collapses to
 * its one-line summary, and the operator can open it — but it must not be the
 * default on a screen that cannot spare the rows.
 */
const TALL_QUERY = '(min-height: 760px)'

function subscribeTall(onChange: () => void): () => void {
  const mql = window.matchMedia(TALL_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

const EMPTY_ROWS: SaleRegisterRow[] = []
const EMPTY_NOTES: CreditNote[] = []

/* Built by the same function that builds every other summary, so an empty range
   and a real one cannot disagree about the shape of one. */
const ZERO_SUMMARY: SalesSummary = summariseSales([], [], '', '')

/**
 * The register as a file, in whole pages.
 *
 * The grid pages lazily as the operator scrolls, so what is loaded is whatever
 * they happened to reach — and an export of "the first 300 of 4,000 bills" that
 * does not say so is the worst artefact this app could hand an accountant. This
 * walks the cursor to the end and reports honestly when it stops early.
 */
const EXPORT_PAGE = 500
const EXPORT_MAX = 20_000

async function collectRegister(
  api: ApiAdapter,
  filters: SalesFilters,
): Promise<{ rows: SaleRegisterRow[]; truncated: boolean }> {
  const rows: SaleRegisterRow[] = []
  let cursor: number | null = null
  for (;;) {
    const page: SalesPage = await api.listSales({
      ...filters,
      limit: EXPORT_PAGE,
      ...(cursor === null ? {} : { cursor }),
    })
    rows.push(...page.rows)
    if (page.nextCursor === null) return { rows, truncated: false }
    if (rows.length >= EXPORT_MAX) return { rows, truncated: true }
    cursor = page.nextCursor
  }
}

export function SalesScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /* One "today" per mount. Re-reading the clock during render would make the
     default range change under a screen that has been open since before
     midnight, which is precisely the shift a night pharmacy works through. */
  const today = useMemo(() => localIsoDate(new Date()), [])

  const view = useMemo(() => readView(params, today), [params, today])
  const idParam = params.get('id')
  const selectedId = idParam !== null && /^\d+$/.test(idParam) ? Number(idParam) : null

  const [activeIndex, setActiveIndex] = useState(0)
  const [returnOpen, setReturnOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)

  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const roomy = useSyncExternalStore(
    subscribeTall,
    () => window.matchMedia(TALL_QUERY).matches,
    () => true,
  )
  const analyticsOpen = view.analytics ?? roomy
  const overlayOpen = returnOpen || voidOpen || closeOpen

  // -------------------------------------------------------------- queries ---

  const apiFilters = useMemo(() => toApiFilters(view), [view])

  const list = useInfiniteQuery({
    queryKey: ['sales', 'list', apiFilters],
    queryFn: ({ pageParam }) =>
      api.listSales({ ...apiFilters, limit: PAGE_SIZE, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: SalesPage) => last.nextCursor,
    /* The previous view's rows stay on screen while the next resolves. Dropping
       to a skeleton on every keystroke is what makes a fast grid feel slow. */
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? EMPTY_ROWS, [list.data])
  const first = list.data?.pages.at(0)
  const total = first?.total ?? 0
  const summary = first?.summary ?? ZERO_SUMMARY

  /**
   * The same period, immediately before this one.
   *
   * Fetched with `limit: 1` on purpose: the summary is computed over the whole
   * range whatever the page size, so one row costs one range scan and carries
   * every figure the header compares against.
   */
  const prev = useMemo(() => previousRange(view.from, view.to), [view.from, view.to])
  const previous = useQuery({
    queryKey: ['sales', 'summary', prev.from, prev.to],
    queryFn: () => api.listSales({ from: prev.from, to: prev.to, status: 'all', sort: 'time', limit: 1 }),
    select: (page: SalesPage) => page.summary,
    placeholderData: keepPreviousData,
  })

  /* Every credit note ISSUED in the range — the returns register, and the
     figures the returns strip carries. Whole-range rather than paged: a shop
     issuing enough credit notes to need pagination has a problem no page size
     will fix, and the header is summing all of them anyway. */
  const rangeNotes = useQuery({
    queryKey: ['sales', 'creditNotes', 'range', view.from, view.to],
    queryFn: () => api.listCreditNotes({ from: view.from, to: view.to }),
    placeholderData: keepPreviousData,
  })

  const allNotes = rangeNotes.data ?? EMPTY_NOTES
  const notes = useMemo(
    () =>
      filterCreditNotes(allNotes, {
        ...(view.term.trim() ? { term: view.term.trim() } : {}),
        ...(view.mode ? { refundMode: view.mode } : {}),
        // The register's third order is the document number, whichever document
        // the tab is showing.
        sort: view.sort === 'invoiceNo' ? 'noteNo' : view.sort,
      }),
    [allNotes, view.term, view.mode, view.sort],
  )
  const returnTotals = useMemo(() => summariseReturns(allNotes), [allNotes])

  const invoice = useQuery({
    queryKey: ['sales', 'invoice', selectedId],
    queryFn: () => api.getInvoice(selectedId ?? 0),
    enabled: selectedId !== null,
  })

  const invoiceNotes = useQuery({
    queryKey: ['sales', 'creditNotes', selectedId],
    queryFn: () => api.listCreditNotes({ invoiceId: selectedId ?? 0 }),
    enabled: selectedId !== null,
  })

  const store = useQuery({ queryKey: qk.store, queryFn: () => api.getStore() })
  /* For the receipt's reseller credit line. Read from context, so the shell,
     the settings preview and the paper can never disagree about the brand. */
  const brand = useBrand()

  /**
   * WHICH day the close button closes.
   *
   * It used to be hard-wired to today while `closeDay` happily accepted any
   * date, so a shop that forgot to close last night could never close it: the
   * range said Yesterday, the dialog said today, and closing it wrote today's
   * record again. A single-day range is an unambiguous statement about which
   * day the operator is looking at, so that is the day; anything wider has no
   * single answer and stays on today. Never a future date — there is no drawer
   * to count for a day that has not happened.
   */
  const closeDate = view.from === view.to && view.from <= today ? view.from : today

  const dayClose = useQuery({
    queryKey: ['sales', 'dayClose', closeDate, TERMINAL_ID],
    queryFn: () => api.getDayClose(closeDate, TERMINAL_ID),
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list
  const onNeedMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  // --------------------------------------------------- URL as the view ---

  const patch = useCallback(
    (next: Partial<ViewState>) => {
      /* A term-only change REPLACES: one word must not leave twenty stops in the
         history. Every other axis is a deliberate act and pushes, so Back walks
         the filters the operator actually applied. */
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams(
        (prevParams) => {
          const merged = { ...readView(prevParams, today), ...next }
          const keep = prevParams.get('id')
          return toParams(merged, keep !== null && /^\d+$/.test(keep) ? Number(keep) : null)
        },
        { replace: termOnly },
      )
    },
    [setParams, today],
  )

  /* Opening a bill REPLACES rather than pushes. The id is in the URL so the
     document is shareable and survives a reload, but arrowing down a day's
     trading must not leave two hundred stops in the history — Esc closes the
     sheet, Back walks the filters. */
  const select = useCallback(
    (id: number | null) => {
      setParams((prevParams) => toParams(readView(prevParams, today), id), { replace: true })
    },
    [setParams, today],
  )

  /* Filters changed → the highlight goes back to the top, adjusted during render
     so the grid never paints one frame pointing at the wrong row. The tab is in
     the key: the two registers hold different documents and index 40 of one is
     not index 40 of the other. */
  const viewKey = `${view.tab}:${JSON.stringify(apiFilters)}`
  const [lastViewKey, setLastViewKey] = useState(viewKey)
  if (viewKey !== lastViewKey) {
    setLastViewKey(viewKey)
    setActiveIndex(0)
  }

  /* Following the URL rather than the click: a deep link and a Back both have to
     land the highlight on the opened row. */
  const loadedIndex = view.tab === 'invoices'
    ? rows.findIndex((r) => r.id === selectedId)
    : notes.findIndex((n) => n.invoiceId === selectedId)
  const [lastSelected, setLastSelected] = useState(selectedId)
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId)
    if (loadedIndex >= 0) setActiveIndex(loadedIndex)
  }

  // --------------------------------------------------------------- writes ---

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['sales'] })
    /* A return moves stock and a void puts a whole bill's worth back. Anything
       reading batches — the POS search, Inventory, the dashboard — is stale the
       instant either lands. */
    void qc.invalidateQueries({ queryKey: ['stock'] })
    void qc.invalidateQueries({ queryKey: ['search'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }, [qc])

  const postReturn = useMutation({
    mutationFn: (input: SaleReturnInput) => api.postSaleReturn(input),
    onSuccess: (note) => {
      invalidate()
      setReturnOpen(false)
      const held = note.lines.filter((l) => l.disposition === 'QUARANTINE').length
      toast.success(`Credit note ${note.creditNoteNo}`, {
        description: `${formatMoney(note.netAmount)} back by ${note.refundMode.toLowerCase()}${held > 0 ? ` · ${held} batch${held === 1 ? '' : 'es'} held` : ''}`,
      })
    },
    onError: (err) => {
      toast.error('The return was not posted', { description: (err as Error).message })
    },
  })

  const voidSale = useMutation({
    mutationFn: (v: { id: number; reason: string }) => api.voidSale(v.id, v.reason),
    onSuccess: (inv) => {
      invalidate()
      setVoidOpen(false)
      toast.success(`${inv.invoiceNo} cancelled`, {
        description: 'The goods went back to their batches. The bill stays in the register, marked.',
      })
    },
    onError: (err) => toast.error('The bill was not cancelled', { description: (err as Error).message }),
  })

  const closeDay = useMutation({
    mutationFn: (input: DayCloseInput) => api.closeDay(input),
    onSuccess: (close) => {
      void qc.invalidateQueries({ queryKey: ['sales', 'dayClose'] })
      toast.success(`${close.date} closed`, {
        description: D.isZero(D.dec(close.variance))
          ? 'The drawer counted exactly.'
          : `Variance ${formatMoney(close.variance)} against expected ${formatMoney(close.expectedCash)}.`,
      })
    },
    onError: (err) => toast.error('The day was not closed', { description: (err as Error).message }),
  })

  /** What was on screen when Export was pressed, worded for the manifest. */
  const appliedFilters = useMemo(() => {
    const applied: string[] = []
    if (view.term.trim()) applied.push(`searched for “${view.term.trim()}”`)
    if (view.mode) {
      applied.push(view.tab === 'returns'
        ? `refunded by ${MODE_LABEL[view.mode].toLowerCase()} only`
        : `${MODE_LABEL[view.mode].toLowerCase()} bills only`)
    }
    if (view.tab === 'invoices' && view.status !== 'all') {
      applied.push(`${STATUS_LABEL[view.status].toLowerCase()} only`)
    }
    return applied
  }, [view.term, view.mode, view.status, view.tab])

  const exportCsv = useMutation({
    mutationFn: async () => {
      const ctx = {
        productName: brand.productName,
        from: view.from,
        to: view.to,
        generatedAt: new Date().toISOString(),
        appliedFilters,
        truncated: false,
      }
      if (view.tab === 'returns') {
        const result = creditNoteRegisterCsv(notes, ctx)
        downloadCsv(result)
        return { rows: result.rows.length, truncated: false }
      }
      /* The whole filtered set, not the pages the operator happened to scroll
         past. See `collectRegister`. */
      const { rows: all, truncated } = await collectRegister(api, apiFilters)
      const result = invoiceRegisterCsv(all, summary, { ...ctx, truncated })
      downloadCsv(result)
      return { rows: all.length, truncated }
    },
    onSuccess: ({ rows: n, truncated }) => {
      if (truncated) {
        toast.warning(`${n.toLocaleString('en-IN')} rows exported — the range was cut short`, {
          description: 'The file says so in its own manifest. Narrow the dates and export again for the whole period.',
        })
        return
      }
      toast.success(
        n === 0 ? 'Nothing to export in this view' : `${n.toLocaleString('en-IN')} rows exported`,
        { description: 'The file opens with the period, the filters and the control totals it was built from.' },
      )
    },
    onError: (err) => toast.error('The export failed', { description: (err as Error).message }),
  })

  // ------------------------------------------------------------- keyboard ---

  const openInvoice = invoice.data ?? null
  const openNotes = invoiceNotes.data ?? EMPTY_NOTES

  /* An id in the URL that resolves to nothing used to fail in total silence:
     `getInvoice` throws NOT_FOUND, the sheet simply never opened, and the
     register carried on looking correct. A pasted link to a bill that has been
     removed, or a typed id, then reads as the app ignoring the click. Say it
     once, and drop the id so the URL stops claiming a bill is open. */
  const openError = invoice.error
  useEffect(() => {
    if (!openError || selectedId === null) return
    toast.error(
      openError instanceof ApiError && openError.code === 'NOT_FOUND'
        ? `There is no bill ${selectedId} in this store`
        : 'That bill could not be opened',
      { description: openError instanceof Error ? openError.message : undefined },
    )
    select(null)
  }, [openError, selectedId, select])

  const reprint = useCallback(() => {
    if (!openInvoice || !store.data) {
      toast.info('Open a bill to reprint it')
      return
    }
    /* Through the shared job, so the roll width, the rupee setting and the
       fallback are identical to the counter's. Two print paths is how a shop
       discovers the register prints at the wrong width. */
    void reprintInvoice(openInvoice, store.data, brand).then(({ route }) => {
      if (route === 'browser' && isConnected()) {
        toast.warning('The printer did not take it', {
          description: 'Sent to the browser print dialog instead — check the paper and the power.',
        })
      }
    })
    /* `store.data` and `brand` are read inside, so they are listed. Left off,
       Ctrl+P kept whichever brand was loaded when the callback was first made —
       so a reseller who renamed the product mid-shift went on printing the old
       name until the page was reloaded. */
  }, [openInvoice, store.data, brand])

  useHotkeys('global', {
    print: reprint,
    'bill.return': () => {
      if (openInvoice && openInvoice.status === 'POSTED') setReturnOpen(true)
      else toast.info('Open a posted bill to return against it')
    },
  })

  /* '/' is screen-local: SHORTCUTS scopes it to billing, and a register that
     only exists on one route has no business claiming a global key.
     `isTypingTarget` is the same suppression rule the shortcut layer applies. */
  useEffect(() => {
    if (overlayOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overlayOpen])

  // ---------------------------------------------------------------- state ---

  const error = view.tab === 'returns' ? rangeNotes.error : list.error
  const pending = view.tab === 'returns' ? rangeNotes.isPending : list.isPending
  const settled = view.tab === 'returns' ? rangeNotes.data !== undefined : list.data !== undefined
  const denied = error instanceof ApiError && DENIED_CODES.has(error.code)
  const status: TableStatus = denied
    ? 'denied'
    : !online && !settled
      ? 'offline'
      : error
        ? 'error'
        : pending
          ? 'loading'
          : 'ready'

  const rangeLabel = view.preset === 'custom'
    ? (view.from === view.to ? shortDate(view.from) : `${shortDate(view.from)} – ${shortDate(view.to)}`)
    : RANGE_LABEL[view.preset]

  /* The screen has to agree with the adapter, or the Void button is there only
     to be refused. `dayClose` is queried for `closeDate`, which is today's
     record whenever a bill raised today is open — the only bill that can be
     voided at all. */
  const canVoid = openInvoice
    ? isVoidable(openInvoice, openNotes, today, closeDate === today && Boolean(dayClose.data))
    : false

  const closed = dayClose.data ?? null

  return (
    <div className="flex h-full flex-col">
      <header className="page-header shrink-0 px-[var(--page-px)] py-4">
        <div className="flex items-center justify-between gap-5">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-display text-fg">Sales</h1>
            {/* Truncates on a 1366 panel, so the whole sentence is on the title:
                the immutability clause is the part that gets cut, and it is the
                part somebody reading this screen for the first time needs. */}
            <p
              className="mt-0.5 truncate text-sm text-fg-muted"
              title={`Every bill and credit note raised at this counter for ${rangeLabel.toLowerCase()}. A posted document is never edited — it is corrected by a credit note, or cancelled with a reason on the day it was raised.`}
            >
              {status === 'ready'
                ? <>
                    <span className="num">{total.toLocaleString('en-IN')}</span> bill{total === 1 ? '' : 's'} and{' '}
                    <span className="num">{returnTotals.notes}</span> credit note{returnTotals.notes === 1 ? '' : 's'}
                    {' '}for {rangeLabel.toLowerCase()} · posted documents, never edited
                  </>
                : 'The invoice register, the returns and the day close'}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <RangePicker view={view} today={today} onPatch={patch} />
            <span aria-hidden className="mx-1 h-6 w-px bg-border" />
            {closed ? (
              <Chip
                icon={CalendarCheck}
                tone={D.isZero(D.dec(closed.variance)) ? 'var(--success-11)' : 'var(--warning-11)'}
              >
                Closed · {formatMoney(closed.variance)}
              </Chip>
            ) : null}
            <Button
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending || status !== 'ready'}
              title="The rows on screen, with the period, the filters and the control totals they were built from"
            >
              <Download />
              {exportCsv.isPending ? 'Exporting…' : 'Export CSV'}
            </Button>
            {/* Which day, whenever it is not today. Without it the button reads
                "Close the day" while the operator is looking at last Tuesday, and
                they have no way to tell which one they are about to close. */}
            <Button variant="primary" onClick={() => setCloseOpen(true)}>
              <Wallet />
              {closed
                ? 'Day close'
                : closeDate === today
                  ? 'Close the day'
                  : `Close ${shortDate(closeDate)}`}
            </Button>
          </div>
        </div>

        {view.preset === 'custom' ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="micro-label">Between</span>
            <input
              type="date"
              value={view.from}
              max={view.to}
              onChange={(e) => patch({ from: e.target.value || today })}
              aria-label="From date"
              className="num h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm"
            />
            <span className="text-xs text-fg-subtle" aria-hidden>→</span>
            <input
              type="date"
              value={view.to}
              min={view.from}
              onChange={(e) => patch({ to: e.target.value || today })}
              aria-label="To date"
              className="num h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm"
            />
          </div>
        ) : null}
      </header>

      <SalesAnalytics
        summary={summary}
        previous={previous.data ?? null}
        rangeLabel={rangeLabel}
        previousLabel={previousLabelFor(view, prev)}
        hideCash={showsToday(view, today) && closeDate === today && !closed}
        open={analyticsOpen}
        onToggle={() => patch({ analytics: !analyticsOpen })}
      />

      <RegisterToolbar
        view={view}
        bills={total}
        credits={notes.length}
        searchRef={searchRef}
        onPatch={patch}
      />

      {/* The two registers run COMPACT and nothing else on the page does. A
          register is scanned, not read: the operator is looking for one row out
          of a day's trading, and every pixel of row height is a bill they have
          to scroll to find. */}
      <div
        data-density="compact"
        className="flex min-h-0 flex-1 gap-[var(--card-gap)] px-[var(--page-px)] pt-2 pb-[var(--card-gap)]"
      >
        <div
          role="tabpanel"
          id={`register-panel-${view.tab}`}
          aria-labelledby={`register-tab-${view.tab}`}
          className="flex min-w-0 flex-1 flex-col gap-2"
        >
          {view.tab === 'returns' ? (
            <>
            <ReturnsSummaryStrip
              totals={returnTotals}
              previousReturns={previous.data?.returns ?? null}
            />
            <CreditNoteTable
              notes={notes}
              total={allNotes.length}
              status={status}
              {...(error ? { errorMessage: (error as Error).message } : {})}
              errorCode={error instanceof ApiError ? error.code : 'RETURNS_FAILED'}
              narrow={openInvoice !== null}
              activeIndex={activeIndex}
              selectedInvoiceId={selectedId}
              filtered={isFiltered(view)}
              emptyTitle={emptyTitleFor(view)}
              onActiveIndexChange={setActiveIndex}
              onOpen={(note) => select(note.invoiceId)}
              onEscape={() => {
                if (selectedId !== null) select(null)
                else if (isFiltered(view)) patch({ term: '', mode: '' })
              }}
              onRetry={() => void rangeNotes.refetch()}
              onClearFilters={() => patch({ term: '', mode: '' })}
              bodyRef={bodyRef}
            />
            </>
          ) : (
            <InvoiceTable
              rows={rows}
              total={total}
              status={status}
              {...(error ? { errorMessage: (error as Error).message } : {})}
              errorCode={error instanceof ApiError ? error.code : 'SALES_FAILED'}
              narrow={openInvoice !== null}
              activeIndex={activeIndex}
              selectedId={selectedId}
              filtered={isFiltered(view)}
              emptyTitle={emptyTitleFor(view)}
              fetchingMore={isFetchingNextPage}
              onActiveIndexChange={setActiveIndex}
              onOpen={(row) => select(row.id)}
              onEscape={() => {
                if (selectedId !== null) select(null)
                else if (isFiltered(view)) patch({ term: '', mode: '', status: 'all' })
              }}
              onNeedMore={onNeedMore}
              onRetry={() => void list.refetch()}
              onClearFilters={() => patch({ term: '', mode: '', status: 'all' })}
              onNewBill={() => navigate('/billing')}
              bodyRef={bodyRef}
            />
          )}
        </div>

        {openInvoice ? (
          <InvoiceDetail
            key={openInvoice.id}
            invoice={openInvoice}
            creditNotes={openNotes}
            canVoid={canVoid}
            dayIsClosed={
              openInvoice.invoiceDate === today && closeDate === today && Boolean(closed)
            }
            busy={postReturn.isPending || voidSale.isPending}
            onClose={() => {
              select(null)
              bodyRef.current?.focus()
            }}
            onPrint={reprint}
            onReturn={() => setReturnOpen(true)}
            onVoid={() => setVoidOpen(true)}
          />
        ) : null}
      </div>

      <SaleReturnDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        invoice={openInvoice}
        creditNotes={openNotes}
        storeId={store.data?.id ?? 1}
        terminalId={TERMINAL_ID}
        today={today}
        drawerCounted={closeDate === today && Boolean(closed)}
        busy={postReturn.isPending}
        onCommit={(input) => postReturn.mutate(input)}
      />

      <VoidDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        invoice={openInvoice}
        busy={voidSale.isPending}
        onCommit={(reason) => {
          if (openInvoice) voidSale.mutate({ id: openInvoice.id, reason })
        }}
      />

      <DayCloseDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        date={closeDate}
        existing={closed}
        busy={closeDay.isPending}
        onCommit={(input) => closeDay.mutate(input)}
      />

      {/* The sheet mounts as a direct child of <body>: print.css hides every
          other body child on paper, which is the only way the app shell is
          guaranteed gone whatever the register happens to be showing. */}
      {openInvoice && store.data
        ? createPortal(
            <Suspense fallback={null}>
              <ThermalReceipt invoice={openInvoice} store={store.data} brand={brand} />
            </Suspense>,
            document.body,
          )
        : null}
    </div>
  )
}

// ------------------------------------------------------------- the toolbar ---

function RangePicker({
  view, today, onPatch,
}: {
  view: ViewState
  today: IsoDate
  onPatch: (next: Partial<ViewState>) => void
}) {
  return (
    <div
      role="group"
      aria-label="Date range"
      className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-0.5"
    >
      {RANGE_PRESETS.map((preset) => {
        const on = view.preset === preset
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onPatch(
                preset === 'custom'
                  // A custom range opens on the range already on screen, so the
                  // click never throws away where the operator was. Taken off
                  // `view` rather than re-resolved: re-resolving 'custom' with
                  // no dates answers "today", which reset the range the moment
                  // somebody clicked Custom a second time.
                  ? { preset, from: view.from, to: view.to }
                  : { preset, ...resolveRange(preset, today) },
              )
            }
            className={cn(
              'h-[calc(var(--control-h)-8px)] rounded-[var(--radius-sm)] px-3 text-sm whitespace-nowrap',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
              on ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            {RANGE_LABEL[preset]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The tabs and the filters.
 *
 * The two registers share one search box and one date range, because they are
 * two views of the same period and switching tabs to hunt for the same customer
 * would be a bad joke. What they do not share is the status axis: a bill has a
 * lifecycle and a credit note does not.
 */
function RegisterToolbar({
  view, bills, credits, searchRef, onPatch,
}: {
  view: ViewState
  bills: number
  credits: number
  searchRef: React.RefObject<HTMLInputElement | null>
  onPatch: (next: Partial<ViewState>) => void
}) {
  const returns = view.tab === 'returns'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-[var(--page-px)] pt-[var(--card-gap)]">
      <div
        role="tablist"
        aria-label="Register"
        className="flex items-center gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-0.5"
      >
        <TabButton
          tab="invoices"
          current={view.tab}
          icon={Receipt}
          label="Bills"
          count={bills}
          onSelect={onPatch}
        />
        <TabButton
          tab="returns"
          current={view.tab}
          icon={Undo2}
          label="Returns"
          count={credits}
          onSelect={onPatch}
        />
      </div>

      <label className="relative min-w-[240px] flex-1">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={searchRef}
          value={view.term}
          onChange={(e) => onPatch({ term: e.target.value })}
          placeholder={returns
            ? 'Credit note number, the bill it reverses, or the customer'
            : 'Invoice number, customer name or phone'}
          aria-label={returns ? 'Find a credit note' : 'Find a bill'}
          autoComplete="off"
          spellCheck={false}
          className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-16 text-base"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
          <Kbd>/</Kbd>
        </span>
      </label>

      <select
        value={view.mode}
        onChange={(e) => onPatch({ mode: e.target.value as PaymentMode | '' })}
        aria-label={returns ? 'Refunded by' : 'Tender'}
        className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm"
      >
        <option value="">{returns ? 'Any refund' : 'Any tender'}</option>
        {PAYMENT_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>

      {returns ? null : (
        <select
          value={view.status}
          onChange={(e) => onPatch({ status: e.target.value as StatusFilter })}
          aria-label="Bill status"
          className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm"
        >
          {STATUS_VALUES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      )}

      <select
        value={view.sort}
        onChange={(e) => onPatch({ sort: e.target.value as SortKey })}
        aria-label="Order"
        className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-sm"
      >
        {SORT_VALUES.map((s) => (
          <option key={s} value={s}>{(returns ? RETURN_SORT_LABEL : SORT_LABEL)[s]}</option>
        ))}
      </select>
    </div>
  )
}

function TabButton({
  tab, current, icon: Icon, label, count, onSelect,
}: {
  tab: RegisterTab
  current: RegisterTab
  icon: LucideIcon
  label: string
  count: number
  onSelect: (next: Partial<ViewState>) => void
}) {
  const on = tab === current
  return (
    <button
      type="button"
      role="tab"
      id={`register-tab-${tab}`}
      aria-selected={on}
      aria-controls={`register-panel-${tab}`}
      onClick={() => onSelect({ tab })}
      className={cn(
        'flex h-[calc(var(--control-h)-8px)] items-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm whitespace-nowrap',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        on ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      <Icon size={14} aria-hidden />
      {label}
      <span className={cn('num text-2xs', on ? 'text-accent-11' : 'text-fg-subtle')}>
        {count.toLocaleString('en-IN')}
      </span>
    </button>
  )
}

// ------------------------------------------------------------ the dialogs ---

function DialogShell({
  open, onOpenChange, title, subtitle, width = 520, children,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  width?: number
  children: React.ReactNode
}) {
  /* Claims the narrowest scope while open, so a key this dialog does not
     implement cannot reach the register underneath and move the selection out
     from under the bill being acted on. */
  useHotkeys('modal', {}, { enabled: open })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-5 py-3.5">
            <Dialog.Title className="text-xl font-semibold tracking-tight">{title}</Dialog.Title>
            {subtitle ? (
              <Dialog.Description className="mt-1 text-sm text-fg-muted">{subtitle}</Dialog.Description>
            ) : null}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Cancelling a bill.
 *
 * The reason is mandatory and it is not a dropdown. A picklist of four canned
 * reasons is a picklist whose first item gets chosen every time, and the thing
 * an auditor needs six months later is a sentence somebody wrote.
 */
function VoidDialog({
  open, onOpenChange, invoice, busy, onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  invoice: SaleInvoice | null
  busy: boolean
  onCommit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')

  const identity = `${open ? 'o' : 'c'}:${invoice?.id ?? 0}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setReason('')
  }

  const ready = reason.trim().length >= REASON_MIN && !busy

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={<>Cancel <span className="mono">{invoice?.invoiceNo ?? '—'}</span></>}
      subtitle="The bill stays in the register marked VOIDED, keeps its number, and the goods go back to their batches."
    >
      <div className="px-5 py-4">
        <div className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-danger-9/25 bg-danger-3 px-3.5 py-2.5">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger-11" aria-hidden />
          <p className="text-xs text-danger-11">
            A cancellation cannot be undone and the bill cannot be reissued under the same number. If the
            customer is keeping part of the goods, post a <strong>return</strong> instead.
          </p>
        </div>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="micro-label">Why is it being cancelled</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Billed to the wrong customer; re-raised as a fresh bill"
            autoComplete="off"
            className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base"
          />
          <span className="text-2xs text-fg-subtle">
            Printed on nothing, kept forever. This is the only explanation an audit will ever have.
          </span>
        </label>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3.5">
        <Dialog.Close asChild><Button variant="ghost">Keep the bill</Button></Dialog.Close>
        <Button variant="danger" disabled={!ready} onClick={() => onCommit(reason.trim())}>
          <Ban /> Cancel this bill
        </Button>
      </div>
    </DialogShell>
  )
}

/** The notes an Indian till actually holds. Coins and the ₹5 note are counted
 *  as one amount — nobody sorts a bowl of change into columns. */
const DENOMINATIONS = [500, 200, 100, 50, 20, 10] as const

/**
 * The blind cash count.
 *
 * The operator counts the drawer and enters it BEFORE this dialog has any idea
 * what to expect — `closeDay` is the only call that returns the expected
 * figure, and it will not return it without a count. Showing expected first
 * destroys the control outright: the number in the box becomes the number in
 * the drawer, every evening, and the night a till is genuinely short is the one
 * nobody hears about.
 *
 * The count is entered as NOTES, not as a total. Typing a total invites the
 * operator to work one out; counting 12 five-hundreds is a thing that either
 * happened or did not.
 */
function DayCloseDialog({
  open, onOpenChange, date, existing, busy, onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  date: IsoDate
  existing: DayClose | null
  busy: boolean
  onCommit: (input: DayCloseInput) => void
}) {
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [coins, setCoins] = useState('')
  const [float, setFloat] = useState('0')
  const [note, setNote] = useState('')

  const identity = `${open ? 'o' : 'c'}:${date}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setCounts({})
    setCoins('')
    setFloat('0')
    setNote('')
  }

  const counted = D.add(
    D.sum(
      DENOMINATIONS.map((d) => {
        const raw = (counts[d] ?? '').trim()
        return /^\d+$/.test(raw) ? D.mul(D.dec(d), D.dec(raw)) : D.ZERO
      }),
    ),
    /^\d+(\.\d{1,2})?$/.test(coins.trim()) ? D.dec(coins.trim()) : D.ZERO,
  )
  const floatOk = /^\d+(\.\d{1,2})?$/.test(float.trim())
  const anythingCounted = DENOMINATIONS.some((d) => (counts[d] ?? '').trim() !== '') || coins.trim() !== ''

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      width={existing ? 520 : 560}
      title={existing ? `${longDate(date)} is closed` : `Close ${longDate(date)}`}
      subtitle={
        existing
          ? `Counted by ${existing.operatorName}. A closed day cannot be recounted — that is what makes the variance mean something.`
          : 'Count the drawer first. The expected figure appears once the count is recorded, and not before.'
      }
    >
      {existing ? (
        <div className="scroll-region min-h-0 flex-1 px-5 py-4">
          <Variance close={existing} />
          <dl className="mt-4 grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <Fact label="Opening float" value={formatMoney(existing.openingFloat)} />
            <Fact label="Counted" value={formatMoney(existing.countedCash)} />
            <Fact label="Expected" value={formatMoney(existing.expectedCash)} />
            <Fact label="Bills" value={String(existing.bills)} />
            <Fact label="Net sales" value={formatMoney(existing.netSales)} />
            <Fact label="Returned" value={formatMoney(existing.returns)} />
            {existing.byMode.map((m) => (
              <Fact key={m.mode} label={MODE_LABEL[m.mode]} value={formatMoney(m.amount)} />
            ))}
            {existing.note ? <Fact label="Note" value={existing.note} /> : null}
          </dl>
          <p className="mt-4 flex items-start gap-1.5 text-2xs text-fg-subtle">
            <Lock size={12} className="mt-px shrink-0" aria-hidden />
            <span>
              Only cash moves this figure. A UPI or card refund goes back the way it came and never
              touched the drawer.
            </span>
          </p>
        </div>
      ) : (
        <div className="scroll-region min-h-0 flex-1 px-5 py-4">
          <div className="grid grid-cols-3 gap-2.5">
            {DENOMINATIONS.map((d) => (
              <label key={d} className="flex items-center gap-2">
                <span className="num w-9 shrink-0 text-right text-sm text-fg-muted">₹{d}</span>
                <span className="text-xs text-fg-subtle" aria-hidden>×</span>
                <input
                  value={counts[d] ?? ''}
                  onChange={(e) => setCounts((prev) => ({ ...prev, [d]: e.target.value }))}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  aria-label={`Number of ${d} rupee notes`}
                  className="num h-[var(--control-h)] w-full min-w-0 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-right text-base"
                />
              </label>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="micro-label">Coins &amp; small notes ₹</span>
              <input
                value={coins}
                onChange={(e) => setCoins(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className="num h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-right text-base"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="micro-label">Opening float ₹</span>
              <input
                value={float}
                onChange={(e) => setFloat(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={floatOk ? undefined : true}
                aria-describedby={floatOk ? undefined : 'float-problem'}
                className={cn(
                  'num h-[var(--control-h)] rounded-[var(--radius-md)] border bg-surface px-2.5 text-right text-base',
                  floatOk ? 'border-border' : 'border-danger-9',
                )}
              />
              {/* The red border was the ONLY thing saying this field was wrong,
                  and Record the count is disabled off the same test — so an
                  operator on a matte panel got a dead button and no reason for
                  it. The rule is stated in words, next to the field it governs. */}
              {floatOk ? null : (
                <span id="float-problem" role="alert" className="flex items-start gap-1.5 text-2xs text-danger-11">
                  <TriangleAlert size={12} className="mt-px shrink-0" aria-hidden />
                  <span>Rupees and paise only — 2000 or 2000.50. The count cannot be recorded until this reads as an amount.</span>
                </span>
              )}
            </label>
          </div>

          <div className="mt-4 flex items-baseline justify-between gap-2 rounded-[var(--radius-lg)] bg-subtle px-4 py-3">
            <span className="text-sm text-fg-muted">Counted in the drawer</span>
            <span className="display-num text-2xl text-fg">₹{formatAmount(D.toStr(counted, 2))}</span>
          </div>

          <label className="mt-4 flex flex-col gap-1.5">
            <span className="micro-label">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="₹500 paid out for the courier"
              autoComplete="off"
              className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base"
            />
          </label>

          <p className="mt-4 flex items-start gap-1.5 text-2xs text-fg-subtle">
            <Lock size={12} className="mt-px shrink-0" aria-hidden />
            <span>
              The count is recorded before the expected figure is worked out, so a variance cannot be
              typed away after the fact. Once the day is closed it cannot be recounted.
            </span>
          </p>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3.5">
        <Dialog.Close asChild>
          <Button variant={existing ? 'primary' : 'ghost'}>{existing ? 'Done' : 'Not yet'}</Button>
        </Dialog.Close>
        {existing ? null : (
          <Button
            variant="primary"
            disabled={!anythingCounted || !floatOk || busy}
            onClick={() =>
              onCommit({
                date,
                terminalId: TERMINAL_ID,
                openingFloat: D.toStr(D.dec(float.trim()), 2),
                countedCash: D.toStr(counted, 2),
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            <Wallet /> Record the count
          </Button>
        )}
      </div>
    </DialogShell>
  )
}

function Variance({ close }: { close: DayClose }) {
  const v = D.dec(close.variance)
  const exact = D.isZero(v)
  const short = D.isNeg(v)
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3.5',
        exact ? 'bg-success-3' : short ? 'bg-danger-3' : 'bg-warning-3',
      )}
    >
      {exact ? (
        <CalendarCheck size={24} className="shrink-0 text-success-11" aria-hidden />
      ) : (
        <TriangleAlert size={24} className={cn('shrink-0', short ? 'text-danger-11' : 'text-warning-11')} aria-hidden />
      )}
      <div className="min-w-0">
        <div className={cn('micro-label', exact ? 'text-success-11' : short ? 'text-danger-11' : 'text-warning-11')}>
          {exact ? 'Counted exactly' : short ? 'Drawer is short' : 'Drawer is over'}
        </div>
        <div className={cn('display-num text-2xl', exact ? 'text-success-11' : short ? 'text-danger-11' : 'text-warning-11')}>
          {formatMoney(close.variance)}
        </div>
      </div>
      <div className="ml-auto text-right text-2xs text-fg-muted">
        <div>expected <span className="num text-fg">{formatMoney(close.expectedCash)}</span></div>
        <div>counted <span className="num text-fg">{formatMoney(close.countedCash)}</span></div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="num min-w-0 truncate text-sm text-fg" title={value}>{value}</dd>
    </div>
  )
}
