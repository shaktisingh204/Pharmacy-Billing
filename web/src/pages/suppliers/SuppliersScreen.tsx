import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Building2, CalendarClock, Coins, ListFilter, Plus, Scale, Search, ScrollText,
  TriangleAlert, Truck, Wallet, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  ApiAdapter, InventoryPurchasesApi, IsoDate, PurchaseInvoice, Supplier, SupplierReturn,
} from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'
import { AgeingBar, LicenceChip, SupplierDetail } from './SupplierDetail'
import type { PurchaseStatus } from './SupplierDetail'
import { PaymentPlanner } from './PaymentPlanner'
import { RateBoard } from './RateBoard'
import {
  EMPTY_INVOICES, ageingOf, buildPaymentPlan, formatDate, licenceNeedsAction, licenceState,
  mergeAgeing, money, rateBoard,
} from './supplierInsights'
import type { Ageing, LicenceState } from './supplierInsights'
import { SupplierForm } from './SupplierForm'

/**
 * The distributors.
 *
 * A supplier master shipped as bare CRUD answers a question nobody has. What a
 * buyer standing in front of a distributor's man needs is one screen holding
 * four facts at once: what is owed and HOW OLD it is, WHEN it falls due, what
 * was paid for these goods last time — and against what the man down the road
 * charges for the same strip — and whether the paperwork on file will survive
 * an inspection.
 *
 * So the screen is three views of one dataset rather than one list:
 *
 *  - THE LEDGER. Who is owed what, aged, with the licence beside it.
 *  - THE PAYMENT PLANNER. The same open bills, dated forward through each
 *    supplier's own credit terms and ordered by when the money has to leave.
 *  - THE RATE BOARD. The same purchase lines, pivoted the other way: one row per
 *    medicine, every distributor who supplies it, priced on landed cost.
 *
 * Two structural choices, and both are the opposite of the medicine grid's on
 * purpose, because the shapes in the contract are different:
 *
 *  - THE WHOLE SET IS LOADED. `listSuppliers` takes no cursor and returns
 *    everything; a shop deals with tens of distributors, not thousands of SKUs.
 *    So search and the presets refine in the browser, which is EXACT here (the
 *    set is complete) where the same thing over a paged grid would answer
 *    "none" when the truth is "not yet" — and it lets the box match on GSTIN
 *    and licence number, which is how a distributor gets found while
 *    reconciling a GST return.
 *  - EVERY DERIVED NUMBER COMES OFF ONE PURCHASE WINDOW. There is no
 *    per-supplier purchase call in the contract, and asking for one per
 *    selection would make arrowing down the list N+1 round trips for numbers
 *    already in memory. Ageing, due dates, rate history and the cross-supplier
 *    board are all folds over the same rows, which is also why the three views
 *    can never disagree with each other.
 *
 * The view is in the URL — tab, search, preset, sort and the open supplier — so
 * a view is a link, and "who have we not paid in three months" is a paste.
 */

/**
 * How many bills back everything derived on this screen is computed from.
 *
 * A busy shop keys twenty to forty purchase bills a week, and an unpaid one
 * older than this window is not a thing that happens quietly — it is a supplier
 * who stopped delivering. Anything outside the window still shows up: the
 * supplier's own `outstanding` is authoritative and the difference is surfaced
 * as "older than loaded bills" rather than silently dropped.
 */
const PURCHASE_WINDOW = 600

/** How far back the cross-supplier comparison looks. A rate from two years ago
 *  is not a quote; it is history, and quoting it at a distributor loses the
 *  argument. */
const COMPARE_WINDOW_DAYS = 365

type TabKey = 'ledger' | 'planner' | 'rates'

const TABS: Array<{ id: TabKey; label: string; icon: LucideIcon }> = [
  { id: 'ledger', label: 'Ledger', icon: ListFilter },
  { id: 'planner', label: 'Payment planner', icon: Wallet },
  { id: 'rates', label: 'Rate board', icon: Scale },
]

/** One line under the title. It says what this view is FOR, not what it holds. */
const DESCRIPTION: Record<TabKey, string> = {
  ledger: 'Every distributor, what is owed, how old it is, and whether the licence on file is still live.',
  planner: 'The same open bills dated forward through each supplier’s credit terms — what leaves the bank, and when.',
  rates: 'One row per medicine, every distributor who supplies it, priced on landed cost rather than on the rate line.',
}

type ViewKey = 'all' | 'owed' | 'overdue' | 'aged' | 'licence' | 'nogstin'
type SortKey = 'name' | 'outstanding' | 'oldest' | 'recent'

interface FilterState {
  term: string
  view: ViewKey
  sort: SortKey
}

const DEFAULT_FILTERS: FilterState = { term: '', view: 'all', sort: 'name' }

const VIEW_VALUES: ViewKey[] = ['all', 'owed', 'overdue', 'aged', 'licence', 'nogstin']

/**
 * The two presets that are answered by the purchase window rather than by the
 * supplier row.
 *
 * Until that window lands every ageing is a zero, so both of these match nobody
 * — and an empty list under "Past terms" reads as "nothing is late", which is
 * the one answer a buyer would act on and the one the data cannot support yet.
 * `owed` is deliberately NOT here: it reads `Supplier.outstanding`, which
 * arrives with the supplier. Neither is `licence`, which is on the row too.
 */
const AGEING_VIEWS = new Set<ViewKey>(['overdue', 'aged'])
const SORT_VALUES: SortKey[] = ['name', 'outstanding', 'oldest', 'recent']

interface Preset {
  id: ViewKey
  label: string
  icon: LucideIcon
  tone?: string
}

const PRESETS: Preset[] = [
  { id: 'all', label: 'All suppliers', icon: ListFilter },
  { id: 'owed', label: 'Money owed', icon: Coins, tone: 'var(--warning-11)' },
  { id: 'overdue', label: 'Past terms', icon: CalendarClock, tone: 'var(--status-expiry-60)' },
  { id: 'aged', label: 'Over 90 days', icon: TriangleAlert, tone: 'var(--danger-11)' },
  /* Compliance, not tidiness: a purchase bill without the supplier's licence is
     a finding, one raised against a LAPSED licence is a worse one, and one
     without his GSTIN is input credit the shop cannot claim. */
  { id: 'licence', label: 'Licence risk', icon: ScrollText, tone: 'var(--danger-11)' },
  { id: 'nogstin', label: 'Unregistered', icon: Building2 },
]

const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name (A–Z)',
  outstanding: 'Owed (most first)',
  oldest: 'Oldest debt first',
  recent: 'Last purchased',
}

function oneOf<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback
}

function readTab(raw: string | null): TabKey {
  return TABS.find((t) => t.id === raw)?.id ?? 'ledger'
}

function readFilters(p: URLSearchParams): FilterState {
  return {
    term: p.get('q') ?? '',
    view: oneOf(p.get('view'), VIEW_VALUES, 'all'),
    sort: oneOf(p.get('sort'), SORT_VALUES, 'name'),
  }
}

/** Only non-default axes are written, so a clean view has a clean URL. */
function toParams(f: FilterState, selectedId: number | null, tab: TabKey): URLSearchParams {
  const p = new URLSearchParams()
  if (tab !== 'ledger') p.set('tab', tab)
  if (f.term.trim()) p.set('q', f.term.trim())
  if (f.view !== 'all') p.set('view', f.view)
  if (f.sort !== 'name') p.set('sort', f.sort)
  if (selectedId !== null) p.set('id', String(selectedId))
  return p
}

function isFiltered(f: FilterState): boolean {
  return f.term.trim() !== '' || f.view !== 'all'
}

/** Phase 5 gates purchases behind a real permission; the code is the contract. */
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const EMPTY_SUPPLIERS: Supplier[] = []
const EMPTY_RETURNS: readonly SupplierReturn[] = []

// ------------------------------------------------------------------- rows ---

interface Row {
  supplier: Supplier
  ageing: Ageing
  /** This supplier's bills out of the window, newest first. */
  invoices: readonly PurchaseInvoice[]
  /** His debit notes and expiry claims, newest first. */
  returns: readonly SupplierReturn[]
  lastPurchase: IsoDate | null
  licence: LicenceState
  /** Parsed ONCE: comparing the strings would put '9,00,000' below '95'. */
  outstanding: D.Decimal
  haystack: string
}

const digitsOf = (s: string): string => s.replace(/\D/g, '')

function matchesTerm(row: Row, term: string): boolean {
  if (row.haystack.includes(term)) return true
  /* A phone read off a card carries spaces and a +91 that the stored number
     does not. Digits against digits, so both spellings find the same man. */
  const digits = digitsOf(term)
  return digits.length >= 4 && digitsOf(row.supplier.phone).includes(digits)
}

function matchesView(row: Row, view: ViewKey): boolean {
  if (view === 'all') return true
  if (view === 'licence') return licenceNeedsAction(row.licence)
  if (view === 'nogstin') return !row.supplier.gstin
  if (view === 'owed') return D.gt(row.outstanding, D.ZERO)
  if (view === 'overdue') return D.gt(D.dec(row.ageing.overdue), D.ZERO)
  const over90 = row.ageing.buckets.find((b) => b.key === 'b90p')
  return over90 !== undefined && D.gt(D.dec(over90.amount), D.ZERO)
}

function compare(sort: SortKey, a: Row, b: Row): number {
  const primary =
    sort === 'outstanding' ? D.cmp(b.outstanding, a.outstanding)
      : sort === 'oldest' ? (b.ageing.oldestDays ?? -1) - (a.ageing.oldestDays ?? -1)
        : sort === 'recent' ? (b.lastPurchase ?? '').localeCompare(a.lastPurchase ?? '')
          : a.supplier.name.localeCompare(b.supplier.name)
  // Ties break on id, without exception: an unstable order makes the highlight
  // land on a different row between two renders that changed nothing.
  return primary || a.supplier.id - b.supplier.id
}

// ----------------------------------------------------------------- screen ---

export function SuppliersScreen() {
  /* Suppliers live in `InventoryPurchasesApi`, which the contract declares but
     has not folded into `ApiAdapter` yet — an interface the local adapter could
     not satisfy would fail the build for everyone. This is a downcast to the
     shape the contract already promises, and it disappears with no other edit
     the day the two interfaces meet. */
  const api = useApi() as ApiAdapter & InventoryPurchasesApi
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const today = useMemo(() => new Date(), [])

  const tab = readTab(params.get('tab'))
  const filters = useMemo(() => readFilters(params), [params])
  const idParam = params.get('id')
  const selectedId = idParam !== null && /^\d+$/.test(idParam) ? Number(idParam) : null

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)

  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

  // ------------------------------------------------------------- the data ---

  const suppliers = useQuery({
    queryKey: ['suppliers', 'list'],
    queryFn: () => api.listSuppliers(),
  })

  const purchases = useQuery({
    queryKey: ['purchases', 'window', PURCHASE_WINDOW],
    /**
     * The window is ASSEMBLED, not asked for in one breath.
     *
     * `listPurchases` is a paged call and an adapter is free to serve fewer
     * rows than the `limit` requested — the local one clamps a page at 200.
     * Trusting one call would make the constant above a wish: the ageing would
     * be derived from a third of the register, and every unpaid bill outside it
     * would drift into "older than loaded bills" for no reason the reader could
     * see. So the cursor is followed until the window is full or the register
     * runs out.
     */
    queryFn: async () => {
      const rows: PurchaseInvoice[] = []
      let cursor: number | undefined
      while (rows.length < PURCHASE_WINDOW) {
        const page = await api.listPurchases({
          limit: PURCHASE_WINDOW - rows.length,
          ...(cursor === undefined ? {} : { cursor }),
        })
        rows.push(...page.rows)
        // Either condition alone ends it; both are here because a cursor that
        // does not advance is the one way this loop could spin forever.
        if (page.nextCursor === null || page.rows.length === 0) break
        if (cursor !== undefined && page.nextCursor <= cursor) break
        cursor = page.nextCursor
      }
      return { rows }
    },
    /* The window survives a supplier edit so the ageing column does not blink
       back to a skeleton when a phone number changes. */
    placeholderData: keepPreviousData,
  })

  /* Every debit note and expiry claim, in ONE call rather than one per opened
     supplier. The set is small — a shop raises tens of these a year, not
     thousands — and holding it here is what lets the sheet open instantly and
     the ledger say, without a second round trip, which distributors are sitting
     on credit they have not given back. */
  const returns = useQuery({
    queryKey: ['supplierReturns', 'all'],
    queryFn: () => api.listSupplierReturns({}),
    placeholderData: keepPreviousData,
  })

  /**
   * One pass over the window, grouped by supplier and newest first.
   *
   * Sorted here rather than at each consumer: the sheet's "recent bills", the
   * rate history's "which purchase was last" and the list's "last purchased"
   * column all depend on the SAME ordering, and three sorts that disagree at a
   * tie would show three different last rates for one medicine.
   */
  const bySupplier = useMemo(() => {
    const grouped = new Map<number, PurchaseInvoice[]>()
    for (const inv of purchases.data?.rows ?? []) {
      const list = grouped.get(inv.supplierId)
      if (list) list.push(inv)
      else grouped.set(inv.supplierId, [inv])
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.id - a.id)
    }
    return grouped
  }, [purchases.data])

  const returnsBySupplier = useMemo(() => {
    const grouped = new Map<number, SupplierReturn[]>()
    for (const doc of returns.data ?? []) {
      const list = grouped.get(doc.supplierId)
      if (list) list.push(doc)
      else grouped.set(doc.supplierId, [doc])
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.id - a.id)
    }
    return grouped
  }, [returns.data])

  const allRows = useMemo((): Row[] => {
    const list = suppliers.data ?? EMPTY_SUPPLIERS
    return list.map((supplier) => {
      const invoices = bySupplier.get(supplier.id) ?? EMPTY_INVOICES
      const posted = invoices.find((inv) => inv.status === 'POSTED')
      return {
        supplier,
        ageing: ageingOf(supplier, invoices, today),
        invoices,
        returns: returnsBySupplier.get(supplier.id) ?? EMPTY_RETURNS,
        lastPurchase: posted?.invoiceDate ?? null,
        licence: licenceState(supplier, today),
        outstanding: money(supplier.outstanding) ?? D.ZERO,
        haystack: [
          supplier.name,
          supplier.phone,
          supplier.gstin ?? '',
          supplier.dlNo ?? '',
          supplier.address ?? '',
        ].join(' ').toLowerCase(),
      }
    })
  }, [suppliers.data, bySupplier, returnsBySupplier, today])

  /* The book is the WHOLE book, never the filtered view. A total that moves
     when a chip is pressed is not a total, and "what do we owe" is the one
     number on this screen that must not depend on what is being looked at. */
  const book = useMemo(() => mergeAgeing(allRows.map((r) => r.ageing)), [allRows])

  const plan = useMemo(
    () => buildPaymentPlan(allRows.map((r) => ({ supplier: r.supplier, invoices: r.invoices })), today),
    [allRows, today],
  )

  const board = useMemo(
    () => rateBoard(purchases.data?.rows ?? [], today, COMPARE_WINDOW_DAYS),
    [purchases.data, today],
  )

  const licenceRisk = useMemo(
    () => allRows.filter((r) => licenceNeedsAction(r.licence)),
    [allRows],
  )

  const rows = useMemo(() => {
    const term = filters.term.trim().toLowerCase()
    return allRows
      .filter((r) => (term === '' || matchesTerm(r, term)) && matchesView(r, filters.view))
      .sort((a, b) => compare(filters.sort, a, b))
  }, [allRows, filters.term, filters.view, filters.sort])

  const selected = useMemo(
    /* Looked up in the UNFILTERED set on purpose: a deep link, or narrowing the
       search after opening a sheet, must not close the record being read. */
    () => (selectedId === null ? null : allRows.find((r) => r.supplier.id === selectedId) ?? null),
    [allRows, selectedId],
  )

  // ---------------------------------------------------------- URL as view ---

  const patch = useCallback(
    (next: Partial<FilterState>) => {
      /* A term-only change REPLACES: one typed word must not leave twenty stops
         in the history. Every other axis is a deliberate act and pushes, so
         Back walks the views the operator actually applied. */
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams(
        (prev) => {
          const merged = { ...readFilters(prev), ...next }
          const keep = prev.get('id')
          return toParams(
            merged,
            keep !== null && /^\d+$/.test(keep) ? Number(keep) : null,
            readTab(prev.get('tab')),
          )
        },
        { replace: termOnly },
      )
    },
    [setParams],
  )

  /* Opening a supplier REPLACES rather than pushes: the id is in the URL so the
     row survives a reload and can be shared, but arrowing down the list must
     not leave forty stops in the history. Esc closes; Back walks the filters. */
  const select = useCallback(
    (id: number | null) => {
      setParams(
        (prev) => toParams(readFilters(prev), id, readTab(prev.get('tab'))),
        { replace: true },
      )
    },
    [setParams],
  )

  /* Switching tabs PUSHES and keeps the open supplier: a buyer moves from the
     rate board back to the ledger mid-argument, and losing the record they were
     reading is the thing that makes a tab bar feel like three separate pages. */
  const goTab = useCallback(
    (next: TabKey) => {
      setParams((prev) => {
        const keep = prev.get('id')
        return toParams(
          readFilters(prev),
          keep !== null && /^\d+$/.test(keep) ? Number(keep) : null,
          next,
        )
      })
    },
    [setParams],
  )

  /** From another view: show me this distributor, on the ledger, unfiltered. */
  const reveal = useCallback(
    (id: number) => { setParams(toParams(DEFAULT_FILTERS, id, 'ledger')) },
    [setParams],
  )

  // ------------------------------------------------------------- keyboard ---

  const openCreate = useCallback(() => {
    setEditing(null)
    setFormOpen(true)
  }, [])

  /* '/' and 'n' are screen-local, so they are bound here rather than added to
     lib/keys: SHORTCUTS is the app-wide contract and a list that exists on one
     route has no business claiming a global key. */
  useEffect(() => {
    if (formOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openCreate()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [formOpen, openCreate])

  // ---------------------------------------------------------------- state ---

  const error = suppliers.error
  const denied = error instanceof ApiError && DENIED_CODES.has(error.code)
  const status: 'ready' | 'loading' | 'error' | 'offline' | 'denied' = denied
    ? 'denied'
    : !online && !suppliers.data
      ? 'offline'
      : error
        ? 'error'
        : suppliers.isPending
          ? 'loading'
          : 'ready'

  /* Ageing has its OWN status. Suppliers can load while the purchase window
     fails, and an ageing column that renders ₹0.00 in that case would say the
     shop owes nothing to a distributor it owes ninety thousand. */
  const purchaseStatus: PurchaseStatus = purchases.error
    ? 'error'
    : purchases.isPending ? 'loading' : 'ready'
  const purchaseError = purchases.error ? (purchases.error as Error).message : undefined

  const returnsStatus: PurchaseStatus = returns.error
    ? 'error'
    : returns.isPending ? 'loading' : 'ready'

  const filtered = isFiltered(filters)

  return (
    <div className="flex h-full flex-col">
      <header className="page-header shrink-0 px-[var(--page-px)] py-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          {/* `flex-1` gives this a zero basis, so the description truncates
              instead of pushing the tab bar onto a second line. At the 1366
              floor that second line is 44px of the vertical budget the grid
              cannot spare. */}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">Suppliers</h1>
            <p className="mt-0.5 truncate text-sm text-fg-muted">{DESCRIPTION[tab]}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div
              role="tablist"
              aria-label="Suppliers view"
              className="flex h-[var(--control-h)] items-center gap-0.5 rounded-[var(--radius-md)] border border-border bg-subtle p-0.5"
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => goTab(t.id)}
                  className={cn(
                    'inline-flex h-full items-center gap-1.5 rounded-[var(--radius-sm)] px-3 text-sm font-medium',
                    'transition-colors duration-[var(--dur-fast)]',
                    tab === t.id
                      ? 'bg-surface text-fg shadow-[var(--shadow-xs)]'
                      : 'text-fg-muted hover:text-fg',
                  )}
                >
                  <t.icon size={15} aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>

            <Button variant="primary" onClick={openCreate}>
              <Plus /> New supplier
              <Kbd className="border-transparent bg-white text-accent-11">N</Kbd>
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--card-gap)] px-[var(--page-px)] py-[var(--card-gap)]">
        {tab === 'ledger' ? (
          <>
            {status === 'ready' ? (
              <PayablesBand
                ageing={book}
                suppliers={allRows.length}
                purchaseStatus={purchaseStatus}
                dueThisWeek={plan.dueThisWeek}
                dueThisWeekCount={plan.dueThisWeekCount}
                licenceRisk={licenceRisk.length}
                activeView={filters.view}
                onShowOverdue={() => patch({ view: 'overdue' })}
                onShowAged={() => patch({ view: 'aged' })}
                onShowLicence={() => patch({ view: 'licence' })}
                onOpenPlanner={() => goTab('planner')}
              />
            ) : null}

            <div className="flex min-h-0 flex-1 gap-[var(--card-gap)]">
              <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">
                {/* Inside the card, not above it. Two 16px gaps and a block of
                    its own cost ~40px of a 640px panel, and the filters belong
                    to this list rather than to the page. */}
                <Filters
                  value={filters}
                  onPatch={patch}
                  searchRef={searchRef}
                  purchaseStatus={purchaseStatus}
                />
                <HeaderRow narrow={selected !== null} />

                <div
                  ref={listRef}
                  className="scroll-region min-h-0 flex-1"
                  onKeyDown={(e) => {
                    if (e.ctrlKey || e.altKey || e.metaKey) return
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      moveFocus(listRef.current, e.key === 'ArrowDown' ? 1 : -1)
                    } else if (e.key === 'Escape') {
                      e.stopPropagation()
                      if (selectedId !== null) select(null)
                      else if (filtered) patch(DEFAULT_FILTERS)
                    }
                  }}
                >
                  {status === 'loading' ? (
                    <SkeletonRows rows={10} cols={5} />
                  ) : status === 'offline' ? (
                    <OfflineState />
                  ) : status === 'denied' ? (
                    <PermissionDenied needs="purchases.view" />
                  ) : status === 'error' ? (
                    <ErrorState
                      code={error instanceof ApiError ? error.code : 'SUPPLIERS_FAILED'}
                      message={error ? (error as Error).message : undefined}
                      onRetry={() => void suppliers.refetch()}
                    />
                  ) : AGEING_VIEWS.has(filters.view) && purchaseStatus !== 'ready' ? (
                    /* Reachable from a pasted URL even though the band hides the
                       buttons that set it — a link is the whole point of putting
                       the view in the query string. */
                    purchaseStatus === 'loading' ? (
                      <SkeletonRows rows={10} cols={5} />
                    ) : (
                      <ErrorState
                        code="PURCHASES_FAILED"
                        message={purchaseError
                          ?? 'The purchase register could not be read, so no balance can be aged against it.'}
                        onRetry={() => void purchases.refetch()}
                      />
                    )
                  ) : rows.length === 0 ? (
                    filtered ? (
                      <EmptyState
                        icon={Search}
                        title="No supplier matches"
                        body={filters.term.trim()
                          ? `Nothing on file for “${filters.term.trim()}” — the box searches name, phone, GSTIN and licence number.`
                          : 'Every distributor is clear of this filter. That is the good answer.'}
                        actionLabel="Clear filters"
                        onAction={() => patch(DEFAULT_FILTERS)}
                      />
                    ) : (
                      <EmptyState
                        icon={Truck}
                        title="No distributors yet"
                        body="A supplier is who a goods receipt is booked against, and who the shop owes. Add the first one, or let the first purchase bill create it."
                        actionLabel="New supplier"
                        onAction={openCreate}
                        shortcut="N"
                      />
                    )
                  ) : (
                    rows.map((row) => (
                      <SupplierRow
                        key={row.supplier.id}
                        row={row}
                        selected={row.supplier.id === selectedId}
                        narrow={selectedId !== null}
                        purchaseStatus={purchaseStatus}
                        onOpen={() => select(row.supplier.id)}
                      />
                    ))
                  )}
                </div>

                {status === 'ready' && rows.length > 0 ? (
                  <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-subtle">
                    <span>
                      {rows.length === allRows.length
                        ? `${rows.length} supplier${rows.length === 1 ? '' : 's'}`
                        : `${rows.length} of ${allRows.length}`}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <Kbd>↑</Kbd><Kbd>↓</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>/</Kbd> search
                    </span>
                  </footer>
                ) : null}
              </div>

              {selected ? (
                <SupplierDetail
                  key={selected.supplier.id}
                  supplier={selected.supplier}
                  invoices={selected.invoices}
                  returns={selected.returns}
                  ageing={purchaseStatus === 'ready' ? selected.ageing : null}
                  today={today}
                  purchaseStatus={purchaseStatus}
                  purchaseError={purchaseError}
                  returnsStatus={returnsStatus}
                  onClose={() => {
                    /* Focus goes back to the row it was opened from, not to the
                       top of the list. Closing the sheet dims that row but does
                       not unmount it, so the element is still there to receive
                       focus — and a keyboard operator who closes one supplier is
                       next going to arrow to the one below it, not start again. */
                    const id = selected.supplier.id
                    select(null)
                    listRef.current
                      ?.querySelector<HTMLButtonElement>(`[data-supplier-id="${id}"]`)
                      ?.focus()
                  }}
                  onEdit={() => {
                    setEditing(selected.supplier)
                    setFormOpen(true)
                  }}
                  onRetryPurchases={() => {
                    void purchases.refetch()
                    void returns.refetch()
                  }}
                  onRecordPurchase={() => navigate('/purchases')}
                  onRaiseReturn={() => navigate('/purchases?tab=returns')}
                  onPlanPayment={() => goTab('planner')}
                />
              ) : null}
            </div>
          </>
        ) : tab === 'planner' ? (
          <PaymentPlanner
            plan={plan}
            status={purchaseStatus}
            error={purchaseError}
            onRetry={() => void purchases.refetch()}
            onOpenSupplier={reveal}
          />
        ) : (
          <RateBoard
            rows={board}
            status={purchaseStatus}
            error={purchaseError}
            windowDays={COMPARE_WINDOW_DAYS}
            onRetry={() => void purchases.refetch()}
            onOpenSupplier={reveal}
          />
        )}
      </div>

      <SupplierForm
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={(s, created) => {
          void qc.invalidateQueries({ queryKey: ['suppliers'] })
          toast.success(created ? `${s.name} added` : `${s.name} saved`, {
            description: s.dlNo
              ? `DL ${s.dlNo}${s.dlValidUpto ? ` · valid to ${formatDate(s.dlValidUpto)}` : ''}`
              : 'No drug licence on file — every purchase bill has to carry one.',
          })
          if (created) reveal(s.id)
          else select(s.id)
        }}
        onOpenExisting={(id) => select(id)}
      />
    </div>
  )
}

// -------------------------------------------------------------- the book ----

/**
 * The five numbers this screen exists to put in front of a buyer.
 *
 * Every one of them is a FILTER as well as a figure. A payables total nobody
 * can press is a poster; the only useful thing to do with "₹1.8 lakh past
 * terms" is to see the four distributors it is, which is why each tile below
 * either narrows the list or moves to the view that acts on it.
 */
function PayablesBand({
  ageing,
  suppliers,
  purchaseStatus,
  dueThisWeek,
  dueThisWeekCount,
  licenceRisk,
  activeView,
  onShowOverdue,
  onShowAged,
  onShowLicence,
  onOpenPlanner,
}: {
  ageing: Ageing
  suppliers: number
  purchaseStatus: PurchaseStatus
  dueThisWeek: string
  dueThisWeekCount: number
  licenceRisk: number
  activeView: ViewKey
  onShowOverdue: () => void
  onShowAged: () => void
  onShowLicence: () => void
  onOpenPlanner: () => void
}) {
  const over90 = ageing.buckets.find((b) => b.key === 'b90p')
  const hasOverdue = D.gt(D.dec(ageing.overdue), D.ZERO)
  const hasAged = over90 !== undefined && D.gt(D.dec(over90.amount), D.ZERO)
  const unaged = ageing.unallocated
  const unagedIsCredit = unaged !== null && D.isNeg(D.dec(unaged))
  const ready = purchaseStatus === 'ready'

  return (
    /* The tiles are their own block rather than four more columns of the outer
       grid, so they can fold without the hero folding with them. Five equal
       cards in one row leaves ~150px of tile at the 1366 floor and a rupee
       figure silently overflowed it — the one failure a number this size must
       not have. Measured, not guessed: the tile figure steps down to 22px
       until the panel is wide enough to set it at 34 whole, and folds 2x2 only
       on a genuinely narrow one. The hero's own figure never steps. */
    <div className="grid shrink-0 gap-[var(--card-gap)] lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.7fr)] 2xl:grid-cols-[minmax(340px,1fr)_minmax(0,2.6fr)]">
      <section className="card px-[var(--card-px)] py-[var(--card-px)]">
        <div className="micro-label">Total payable</div>
        <div className="display-num mt-1.5 text-4xl text-fg">{formatMoney(ageing.outstanding)}</div>
        <div className="mt-1 text-sm text-fg-muted">
          across {suppliers} distributor{suppliers === 1 ? '' : 's'}
        </div>

        {ready ? (
          <div className="mt-3">
            <AgeingBar ageing={ageing} className="h-2.5" />
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              {ageing.buckets.map((b) => (
                <span key={b.key} className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: b.tone }} />
                  {b.short}
                  <span className="num text-fg">{formatAmount(b.amount)}</span>
                </span>
              ))}
              {/* These four numbers sit beside a total they do not add up to
                  whenever a balance predates the loaded window or money was paid
                  on account. Naming the remainder is the only honest option —
                  dropping it makes the legend quietly wrong. */}
              {unaged ? (
                <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <span aria-hidden className="size-2.5 rounded-[3px] bg-inset" />
                  {unagedIsCredit ? 'On account' : 'Not aged'}
                  <span className="num text-fg">{formatAmount(unaged)}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-fg-muted">
            {purchaseStatus === 'loading'
              ? 'Ageing the payable against the purchase register…'
              : 'The purchase register could not be read, so this balance cannot be aged.'}
          </p>
        )}
      </section>

      <div className="grid grid-cols-2 gap-[var(--card-gap)] md:grid-cols-4">
        <StatTile
          label="Due this week"
          value={ready ? formatMoney(dueThisWeek) : '—'}
          note={ready
            ? dueThisWeekCount > 0
              ? `${dueThisWeekCount} bill${dueThisWeekCount === 1 ? '' : 's'} · open the planner`
              : 'nothing falls due'
            : 'needs the register'}
          icon={Wallet}
          tone={ready && D.gt(D.dec(dueThisWeek), D.ZERO) ? 'accent' : 'quiet'}
          disabled={!ready}
          onClick={onOpenPlanner}
        />

        <StatTile
          label="Past terms"
          value={ready ? formatMoney(ageing.overdue) : '—'}
          note={ready
            ? hasOverdue
              ? `${ageing.overdueCount} bill${ageing.overdueCount === 1 ? '' : 's'} late`
              : 'nothing late'
            : 'needs the register'}
          icon={CalendarClock}
          tone={hasOverdue ? 'warning' : 'quiet'}
          active={activeView === 'overdue'}
          disabled={!ready || !hasOverdue}
          onClick={onShowOverdue}
        />

        <StatTile
          label="Over 90 days"
          value={ready ? formatMoney(over90?.amount ?? '0') : '—'}
          note={ready
            ? hasAged
              ? `${over90?.count ?? 0} bill${(over90?.count ?? 0) === 1 ? '' : 's'} · supply at risk`
              : 'nothing this old'
            : 'needs the register'}
          icon={TriangleAlert}
          tone={hasAged ? 'danger' : 'quiet'}
          active={activeView === 'aged'}
          disabled={!ready || !hasAged}
          onClick={onShowAged}
        />

        <StatTile
          label="Licence risk"
          value={String(licenceRisk)}
          note={licenceRisk > 0
            ? 'missing, lapsed or lapsing'
            : 'every licence live'}
          icon={ScrollText}
          tone={licenceRisk > 0 ? 'danger' : 'quiet'}
          active={activeView === 'licence'}
          disabled={licenceRisk === 0}
          onClick={onShowLicence}
        />
      </div>
    </div>
  )
}

type TileTone = 'quiet' | 'accent' | 'warning' | 'danger'

const TILE_VALUE: Record<TileTone, string> = {
  quiet: 'text-fg-subtle',
  accent: 'text-fg',
  warning: 'text-warning-11',
  danger: 'text-danger-11',
}

function StatTile({
  label, value, note, icon: Icon, tone, active, disabled, onClick,
}: {
  label: string
  value: string
  note: string
  icon: LucideIcon
  tone: TileTone
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'card px-[var(--card-px)] py-3.5 text-left',
        disabled ? 'cursor-default' : 'card-link',
        active ? 'border-accent-6 bg-accent-2' : null,
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon
          size={14}
          aria-hidden
          className={tone === 'quiet' ? 'text-fg-subtle' : undefined}
          style={tone === 'quiet' ? undefined : { color: `var(--${tone === 'accent' ? 'accent-9' : tone === 'warning' ? 'warning-9' : 'danger-9'})` }}
        />
        {/* One line, always. A two-line tile label steals a row from the list
            below it on the 640px panel this app has to fit. */}
        <span className="micro-label whitespace-nowrap">{label}</span>
      </span>
      {/* `truncate` and the title are the guard of last resort: the figure is
          sized to fit the narrowest tile this band folds to, but a shop with a
          crore on the book must lose the tail to an ellipsis rather than paint
          it over the neighbouring card. */}
      <span
        title={value}
        className={cn('display-num mt-1.5 block truncate text-xl 2xl:text-3xl', TILE_VALUE[tone])}
      >
        {value}
      </span>
      <span className="mt-1 block text-xs text-fg-subtle">{note}</span>
    </button>
  )
}

// ---------------------------------------------------------------- filters ---

function Filters({
  value,
  onPatch,
  searchRef,
  purchaseStatus,
}: {
  value: FilterState
  onPatch: (patch: Partial<FilterState>) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  purchaseStatus: PurchaseStatus
}) {
  /* The box is local and the URL is debounced behind it. Writing a search param
     per keystroke would give the back button twenty stops inside one word — and
     the term is written with `replace`, so the shared URL is still exact. */
  const [box, setBox] = useState(value.term)
  const [lastTerm, setLastTerm] = useState(value.term)
  if (value.term !== lastTerm) {
    setLastTerm(value.term)
    setBox(value.term)
  }

  useEffect(() => {
    if (box === value.term) return
    const t = setTimeout(() => onPatch({ term: box }), 180)
    return () => clearTimeout(t)
  }, [box, value.term, onPatch])

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
      <div className="relative w-[280px]">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={searchRef}
          value={box}
          onChange={(e) => setBox(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && box) { e.stopPropagation(); setBox('') }
          }}
          aria-label="Find a supplier"
          placeholder="Name, phone, GSTIN or licence…"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-9 text-sm placeholder:text-fg-subtle hover:border-border-strong"
        />
        {box ? (
          <button
            type="button"
            onClick={() => setBox('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X size={15} aria-hidden />
          </button>
        ) : (
          <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2">/</Kbd>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = value.view === p.id
          /* Offered only once it can be answered. A chip that filters on ageing
             the purchase register has not produced yet would hand back an empty
             list, and empty here reads as "none", not "not yet". */
          const blocked = purchaseStatus !== 'ready' && AGEING_VIEWS.has(p.id)
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              disabled={blocked}
              title={blocked
                ? purchaseStatus === 'loading'
                  ? 'Reading the purchase register…'
                  : 'The purchase register could not be read, so nothing can be aged.'
                : undefined}
              onClick={() => onPatch({ view: p.id })}
              /* Compact on purpose. The type scale lifted for CONTENT; a row of
                 six secondary filters set at body size wraps to three lines the
                 moment the detail sheet narrows the card, and those two extra
                 lines come straight off the list. */
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-xs',
                'disabled:cursor-default disabled:opacity-50',
                on
                  ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                  : 'border-border-subtle bg-surface text-fg-muted enabled:hover:border-border-strong enabled:hover:text-fg',
              )}
            >
              <p.icon size={13} aria-hidden style={on ? undefined : { color: p.tone }} />
              {p.label}
            </button>
          )
        })}
      </div>

      <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
        Sort
        <select
          value={value.sort}
          onChange={(e) => onPatch({ sort: e.target.value as SortKey })}
          className="h-8 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-xs hover:border-border-strong"
        >
          {SORT_VALUES.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
        </select>
      </label>
    </div>
  )
}

// ------------------------------------------------------------------- grid ---

/* Six columns, and the licence sits second — ahead of the GSTIN and ahead of
   the money. Marg buries it in an "other details" panel of a ledger master,
   which is exactly why so many shops discover it is blank, or three years out
   of date, during an inspection.

   The GSTIN column STANDS DOWN while a sheet is open, rather than the whole
   grid squeezing. At the 1366 floor the remaining width cannot carry six
   columns beside a 380px sheet, and a grid that keeps them all silently clips
   the outstanding figure — the one column nobody may lose. The GSTIN is the
   right one to drop because the open sheet is already showing it. */
const COLS = 'grid-cols-[minmax(160px,2fr)_minmax(150px,1.3fr)_minmax(110px,1fr)_64px_minmax(120px,1.2fr)_112px]'
const COLS_NARROW = 'grid-cols-[minmax(140px,2fr)_minmax(132px,1.3fr)_60px_minmax(112px,1.2fr)_104px]'

function HeaderRow({ narrow }: { narrow: boolean }) {
  return (
    <div className={cn(
      'grid shrink-0 items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-2',
      narrow ? COLS_NARROW : COLS,
    )}>
      <span className="micro-label">Supplier</span>
      <span className="micro-label">Drug licence</span>
      {narrow ? null : <span className="micro-label">GSTIN</span>}
      <span className="micro-label">Terms</span>
      <span className="micro-label">Payable by age</span>
      <span className="micro-label text-right">Outstanding ₹</span>
    </div>
  )
}

function SupplierRow({
  row,
  selected,
  narrow,
  purchaseStatus,
  onOpen,
}: {
  row: Row
  selected: boolean
  narrow: boolean
  purchaseStatus: PurchaseStatus
  onOpen: () => void
}) {
  const s = row.supplier
  const owes = D.gt(row.outstanding, D.ZERO)
  const overdue = D.gt(D.dec(row.ageing.overdue), D.ZERO)

  return (
    <button
      type="button"
      data-supplier-row
      data-supplier-id={s.id}
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      style={{ height: 'var(--row-h)' }}
      className={cn(
        'relative grid w-full items-center gap-3 border-b border-border-subtle px-[var(--cell-px)] text-left',
        narrow ? COLS_NARROW : COLS,
        selected ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      {selected ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" /> : null}

      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate text-base font-medium', selected ? 'text-accent-11' : 'text-fg')}>
          {s.name}
        </span>
        <span className="mono truncate text-2xs text-fg-subtle">
          {s.phone || 'No phone'}
          {row.lastPurchase ? ` · last bought ${formatDate(row.lastPurchase)}` : ''}
        </span>
      </span>

      {/* The number and the date it dies, one above the other. A licence number
          with no validity beside it is the state every supplier master ships in
          and the reason a lapse is only ever found by an inspector. */}
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        {s.dlNo
          ? <span className="mono w-full truncate text-sm text-fg" title={s.dlNo}>{s.dlNo}</span>
          : null}
        {/* A live licence gets a quiet date, not a badge. Chipping every healthy
            row makes the two that are not healthy disappear into the pattern —
            the exceptions are the only reason this column carries a status. */}
        {row.licence.key === 'valid' && s.dlValidUpto
          ? <span className="text-2xs text-fg-subtle">to {formatDate(s.dlValidUpto)}</span>
          : <LicenceChip state={row.licence} />}
      </span>

      {narrow ? null : (
        <span className="min-w-0">
          {s.gstin
            ? <span className="mono truncate text-xs text-fg-muted" title={s.gstin}>{s.gstin}</span>
            : <span className="text-xs text-fg-subtle">Unregistered</span>}
        </span>
      )}

      <span className="text-xs text-fg-muted">
        {s.paymentTermsDays > 0 ? `${s.paymentTermsDays}d` : 'Cash'}
      </span>

      <span className="min-w-0">
        {purchaseStatus !== 'ready' ? (
          <span className="text-2xs text-fg-subtle">
            {purchaseStatus === 'loading' ? 'Ageing…' : 'Ageing unavailable'}
          </span>
        ) : (
          <>
            <AgeingBar ageing={row.ageing} className="h-1.5" described={false} />
            <span className={cn('mt-1 block text-2xs', overdue ? 'text-warning-11' : 'text-fg-subtle')}>
              {/*
                A balance carried without an invoice behind it cannot be aged, and
                saying "Nothing due" next to a non-zero outstanding reads as a
                contradiction. Name the reason instead: the opening balance has no
                bill to age against until one is received against this supplier.
              */}
              {overdue
                ? `${formatMoney(row.ageing.overdue)} past terms`
                : row.ageing.openCount > 0
                  ? `${row.ageing.openCount} open bill${row.ageing.openCount === 1 ? '' : 's'}, none late`
                  : D.gt(row.outstanding, D.ZERO)
                    ? 'Opening balance — no bill to age against'
                    : 'Nothing due'}
            </span>
          </>
        )}
      </span>

      {/* The badge sits ABOVE the figure, not after it. The amount is the row's
          terminal value — the last thing read down the column and the last text
          in the row — and a chip trailing it turns the money column into a
          mixed one. A claim not yet credited is money coming back the other
          way, which is context for the balance rather than part of it. */}
      <span className="flex flex-col items-end gap-0.5">
        {row.returns.some((r) => r.status === 'POSTED' && r.kind === 'EXPIRY_CLAIM' && r.creditReceived === null) ? (
          <Chip icon={Coins} tone="var(--status-expiry-180)">Claim open</Chip>
        ) : null}
        <span className={cn('num text-base', owes ? 'font-medium text-fg' : 'text-fg-subtle')}>
          {formatAmount(s.outstanding)}
        </span>
      </span>
    </button>
  )
}

/**
 * Roving focus down the rows.
 *
 * The rows are real buttons, so Enter, Space and Tab already work and the focus
 * ring is the browser's. This only adds the arrow keys a pharmacist expects
 * from every other grid in the app, by moving focus rather than by tracking a
 * selected index — one source of truth for "where am I", and it is the DOM's.
 */
function moveFocus(container: HTMLElement | null, delta: number) {
  if (!container) return
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-supplier-row]')]
  if (rows.length === 0) return
  const at = rows.findIndex((r) => r === document.activeElement)
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta))]
  next?.focus()
}
