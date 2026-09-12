import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlarmClock, BellRing, CalendarDays, Coins, CreditCard, ListFilter, Moon, PhoneOff, Repeat,
  Search, ShieldAlert, TriangleAlert, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Customer, CustomerReceipt, CustomerReceiptInput, SaleInvoice } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import {
  BILL_BACKED_VIEWS, DEFAULT_FILTERS, SORT_VALUES, VIEW_VALUES, buildRows, collectBills,
  filterRows, isFiltered, summarise, unallocatedNote,
} from '@/api/customers'
import type { BookSummary, FilterState, Receivable, SortKey, ViewKey } from '@/api/customers'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { AgeingBar, CustomerTable } from './CustomerTable'
import type { BillStatus, TableStatus } from './CustomerTable'
import { CustomerDetail } from './CustomerDetail'
import { ReceiptDialog } from './ReceiptDialog'
import { RemindersDialog } from './RemindersDialog'
import type { Horizon } from './RemindersDialog'
import { SEGMENT_MEANING, buildProfiles, refillsDue, toIsoDate } from './profile'
import type { PurchaseProfile, Segment } from './profile'
import { birthdaysDue, careOf, clearCare, useCareBook, writeCare } from './careFile'
import type { CareFile } from './careFile'

/**
 * The customer book, read as a RECEIVABLE and as a set of PEOPLE.
 *
 * A customer master shipped as a contact list answers a question nobody has.
 * What a shopkeeper opens this to settle is one of four: who owes me and how old
 * is it, who has quietly gone past the credit I agreed, who is due to walk in
 * for their monthly refill — and, before any of that, what must this person
 * never be dispensed. So the list carries ageing rather than a balance, the
 * header counts the accounts over their limit and the refills falling due, and
 * allergies are a column and not a detail buried in a sheet.
 *
 * Three structural choices, and the shapes in the contract are why:
 *
 *  - THE WHOLE BOOK IS LOADED. `listCustomers` takes no cursor. Search and the
 *    presets therefore refine in the browser, which is EXACT here because the
 *    set is complete — the same filtering over a paged grid would answer "none"
 *    when the truth is "not on this page". It is also what lets the box match on
 *    GSTIN and on an allergen, which is how a customer is actually found again.
 *  - AGEING AND BUYING BOTH COME FROM ONE BILL WINDOW, DERIVED ONCE. There is no
 *    per-customer receivable or history call worth making when the numbers are
 *    already in memory, and asking for one per selection would make arrowing down
 *    the list N+1 round trips.
 *  - THE SEGMENT IS ITS OWN AXIS, not another chip in the preset row. "Which of
 *    my chronic patients owe me money" is a real question and an exclusive chip
 *    row cannot ask it.
 *
 * The view is in the URL — search, preset, segment, sort and the open account —
 * so a view is a link, and "who has owed us money since June" is a paste.
 */

/**
 * How many customer bills the ageing is derived from.
 *
 * Walk-ins are already excluded at the adapter, so this is a window over
 * ACCOUNTS rather than over the day's traffic — a shop with forty credit
 * customers takes months to fill it. Anything outside it still shows up:
 * `Customer.outstanding` is authoritative and the difference is surfaced as
 * "older than the loaded bills" rather than silently dropped.
 */
const BILL_WINDOW = 800

interface Preset {
  id: ViewKey
  label: string
  icon: LucideIcon
  tone?: string
}

const PRESETS: Preset[] = [
  { id: 'all', label: 'Everyone', icon: ListFilter },
  { id: 'owes', label: 'Owes money', icon: Coins, tone: 'var(--warning-11)' },
  { id: 'overlimit', label: 'Over limit', icon: CreditCard, tone: 'var(--danger-11)' },
  { id: 'aged', label: 'Past 90 days', icon: TriangleAlert, tone: 'var(--danger-11)' },
  /* A dispensing control, not a tidiness one: these are the records where the
     counter has something to check before it hands anything over. */
  { id: 'allergies', label: 'Allergies', icon: ShieldAlert, tone: 'var(--danger-11)' },
  /* The phone IS the identity. A row without one cannot be found again, cannot
     be sent a reminder, and will be re-entered as a duplicate on the next visit. */
  { id: 'nophone', label: 'No phone', icon: PhoneOff, tone: 'var(--warning-11)' },
]

/** The behaviour axis. 'none' is not offered: "we have loaded no bill for them"
 *  is a fact about the window, not a kind of customer to filter on. */
export type SegmentFilter = 'any' | Exclude<Segment, 'none'>

const SEGMENT_VALUES: SegmentFilter[] = ['any', 'chronic', 'occasional', 'dormant']

const SEGMENT_CHIPS: Array<{ id: SegmentFilter; label: string; icon: LucideIcon; tone?: string }> = [
  { id: 'any', label: 'Any', icon: ListFilter },
  { id: 'chronic', label: 'Chronic', icon: Repeat, tone: 'var(--info-11)' },
  { id: 'occasional', label: 'Occasional', icon: CalendarDays },
  { id: 'dormant', label: 'Dormant', icon: Moon, tone: 'var(--warning-11)' },
]

const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name (A–Z)',
  outstanding: 'Owed (most first)',
  oldest: 'Oldest debt first',
  recent: 'Last billed',
}

function oneOf<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback
}

function readFilters(p: URLSearchParams): FilterState {
  return {
    term: p.get('q') ?? '',
    view: oneOf(p.get('view'), VIEW_VALUES, 'all'),
    sort: oneOf(p.get('sort'), SORT_VALUES, 'name'),
  }
}

const readSegment = (p: URLSearchParams): SegmentFilter =>
  oneOf(p.get('seg'), SEGMENT_VALUES, 'any')

/** Only non-default axes are written, so a clean view has a clean URL. */
function toParams(f: FilterState, segment: SegmentFilter, selectedId: number | null): URLSearchParams {
  const p = new URLSearchParams()
  if (f.term.trim()) p.set('q', f.term.trim())
  if (f.view !== 'all') p.set('view', f.view)
  if (f.sort !== 'name') p.set('sort', f.sort)
  if (segment !== 'any') p.set('seg', segment)
  if (selectedId !== null) p.set('id', String(selectedId))
  return p
}

/** Phase 5 gates the customer master behind a real permission; the code is the
 *  contract, and the message it drives is not. */
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const EMPTY_CUSTOMERS: Customer[] = []
const EMPTY_BILLS: SaleInvoice[] = []
const EMPTY_RECEIPTS: CustomerReceipt[] = []

export function CustomersScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const today = useMemo(() => new Date(), [])
  const todayIso = useMemo(() => toIsoDate(today), [today])

  const filters = useMemo(() => readFilters(params), [params])
  const segment = readSegment(params)
  const idParam = params.get('id')
  const selectedId = idParam !== null && /^\d+$/.test(idParam) ? Number(idParam) : null

  const [activeIndex, setActiveIndex] = useState(0)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [horizon, setHorizon] = useState<Horizon>(14)

  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const care = useCareBook()

  // ------------------------------------------------------------- the data ---

  const customers = useQuery({
    queryKey: ['customers', 'book'],
    queryFn: () => api.listCustomers(),
  })

  const bills = useQuery({
    queryKey: ['customers', 'bills', BILL_WINDOW],
    queryFn: () => collectBills((q) => api.listCustomerBills(q), BILL_WINDOW),
    /* The window survives a receipt so the ageing column does not blink back to
       a skeleton when a balance changes. */
    placeholderData: keepPreviousData,
  })

  const receipts = useQuery({
    queryKey: ['customers', 'receipts'],
    queryFn: () => api.listCustomerReceipts(),
    placeholderData: keepPreviousData,
  })

  /* Only the statement needs it, and only to head the exported file with the
     shop that issued it. A statement carrying no letterhead is a screenshot. */
  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })

  const allRows = useMemo(
    () => buildRows(
      customers.data ?? EMPTY_CUSTOMERS,
      bills.data ?? EMPTY_BILLS,
      receipts.data ?? EMPTY_RECEIPTS,
      today,
    ),
    [customers.data, bills.data, receipts.data, today],
  )

  /* One pass over the same window the ageing came from. Deriving this per
     selection would re-scan every bill each time the highlight moved. */
  const profiles = useMemo(() => buildProfiles(allRows, today), [allRows, today])

  /* The book is the WHOLE book, never the filtered view. A total that moves when
     a chip is pressed is not a total, and "what are we owed" is the one number
     on this screen that must not depend on what is being looked at. */
  const book = useMemo(() => summarise(allRows), [allRows])

  const refills = useMemo(
    () => refillsDue(allRows, profiles, horizon),
    [allRows, profiles, horizon],
  )
  const birthdays = useMemo(
    () => birthdaysDue(allRows.map((r) => r.customer), care, today, horizon),
    [allRows, care, today, horizon],
  )
  const lateRefills = refills.filter((r) => r.dueInDays < 0).length

  const rows = useMemo(() => {
    const base = filterRows(allRows, filters)
    /* Applied after the preset rather than folded into `matchesView`: the two
       are independent axes, and the pure filter in `api/customers` has no
       business knowing what a bill window says about somebody's habits. */
    return segment === 'any'
      ? base
      : base.filter((r) => profiles.get(r.customer.id)?.segment === segment)
  }, [allRows, filters, segment, profiles])

  const selected = useMemo(
    /* Looked up in the UNFILTERED set on purpose: a deep link, or narrowing the
       search after opening a sheet, must not close the account being read. */
    () => (selectedId === null ? null : allRows.find((r) => r.customer.id === selectedId) ?? null),
    [allRows, selectedId],
  )

  // -------------------------------------------------------- the highlight ---
  //
  // All three of these adjust state DURING RENDER rather than in an effect. An
  // effect commits the DOM once with the highlight on the wrong row and then
  // re-renders to correct it, which on a list somebody is arrowing through shows
  // as the selection flicking.

  /* Filters changed → back to the top. Keeping the index would land it on
     whichever unrelated account now happens to sit at that position. */
  const filterKey = `${filters.term}|${filters.view}|${filters.sort}|${segment}`
  const [lastFilterKey, setLastFilterKey] = useState(filterKey)
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey)
    setActiveIndex(0)
  }

  const openIndex = rows.findIndex((r) => r.customer.id === selectedId)

  /* Following the URL, not the click: a deep link and a Back both have to land
     the highlight on the account that is open, not only a mouse press. */
  const [lastSelected, setLastSelected] = useState(selectedId)
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId)
    if (openIndex >= 0) setActiveIndex(openIndex)
  }

  /* A receipt can settle the account the highlight was on and drop it out of the
     current view. The guard is false again after the correction, so this
     settles in one extra render rather than looping. */
  const maxIndex = Math.max(0, rows.length - 1)
  if (activeIndex > maxIndex) setActiveIndex(maxIndex)

  // ---------------------------------------------------------- URL as view ---

  const patch = useCallback(
    (next: Partial<FilterState> & { segment?: SegmentFilter }) => {
      /* A term-only change REPLACES: one typed word must not leave twenty stops
         in the history. Every other axis is a deliberate act and pushes, so Back
         walks the views the operator actually applied. */
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams(
        (prev) => {
          const merged = { ...readFilters(prev), ...next }
          const seg = next.segment ?? readSegment(prev)
          const keep = prev.get('id')
          return toParams(merged, seg, keep !== null && /^\d+$/.test(keep) ? Number(keep) : null)
        },
        { replace: termOnly },
      )
    },
    [setParams],
  )

  /* Opening an account REPLACES rather than pushes: the id is in the URL so the
     row survives a reload and can be shared, but arrowing down the list must not
     leave forty stops in the history. Esc closes; Back walks the filters. */
  const select = useCallback(
    (id: number | null) => {
      setParams((prev) => toParams(readFilters(prev), readSegment(prev), id), { replace: true })
    },
    [setParams],
  )

  const resetFilters = useCallback(
    () => patch({ ...DEFAULT_FILTERS, segment: 'any' }),
    [patch],
  )

  // ------------------------------------------------------------- keyboard ---

  /* '/' is screen-local, so it is bound here rather than added to lib/keys:
     SHORTCUTS is the app-wide contract and a list that exists on one route has
     no business claiming a global key. */
  useEffect(() => {
    if (receiptOpen || remindersOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (e.key !== '/') return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [receiptOpen, remindersOpen])

  // -------------------------------------------------------------- receipt ---

  const receipt = useMutation({
    mutationFn: (input: CustomerReceiptInput) => api.recordCustomerReceipt(input),
    onSuccess: (r) => {
      setReceiptOpen(false)
      /* Every customer key hangs off one prefix, so the book, the bill window
         and the receipt register refresh together. A balance that moved while
         the ageing beside it did not is the disagreement this screen exists to
         prevent. */
      void qc.invalidateQueries({ queryKey: ['customers'] })
      toast.success(`${formatMoney(r.amount)} received`, {
        description: D.isZero(D.dec(r.balanceAfter))
          ? `${r.receiptNo} · account settled`
          : `${r.receiptNo} · ${formatMoney(r.balanceAfter)} still outstanding`,
      })
    },
    onError: (err) => {
      toast.error('The receipt was not recorded', {
        description: err instanceof Error ? err.message : undefined,
      })
    },
  })

  // ---------------------------------------------------------------- state ---

  const error = customers.error
  const denied = error instanceof ApiError && DENIED_CODES.has(error.code)

  /* The ageing has its OWN status, and it covers BOTH halves of the fold.
     Customers can load while the window fails, and an ageing column that renders
     four zeros in that case would tell a shop it is owed nothing by a customer
     who owes it thousands. The receipt register is the same call in reverse: an
     ageing built without it shows every settled bill as still open and names the
     difference "paid on account" — a claim about money, made because a query
     failed. Neither half alone is an ageing. */
  const ageingError = bills.error ?? receipts.error
  /* Retries BOTH halves. Either one can be the failure, and a button that only
     refetches the window leaves a broken receipt register unrecoverable. */
  const retryAgeing = () => { void bills.refetch(); void receipts.refetch() }
  const billStatus: BillStatus = ageingError
    ? 'error'
    : bills.isPending || receipts.isPending ? 'loading' : 'ready'
  const billError = ageingError ? (ageingError as Error).message : undefined

  const base: TableStatus = denied
    ? 'denied'
    : !online && !customers.data
      ? 'offline'
      : error
        ? 'error'
        : customers.isPending
          ? 'loading'
          : 'ready'

  /* A view that can only be answered by the bill window is reachable from a
     pasted URL even though the chip for it is disabled — a link is the whole
     point of putting the view in the query string. It must not hand back an
     empty list, because empty here reads as "nobody", not as "not yet". The
     segments are bill-backed for exactly the same reason: without a window every
     account reads as "no bills loaded", and "no chronic customers" is a claim
     this screen would be making on a failed query's behalf. */
  const blocked = base === 'ready'
    && (BILL_BACKED_VIEWS.has(filters.view) || segment !== 'any')
    && billStatus !== 'ready'
  const status: TableStatus = blocked
    ? (billStatus === 'loading' ? 'loading' : 'error')
    : base

  const filtered = isFiltered(filters) || segment !== 'any'

  const onCareChange = useCallback(
    (patchFile: Partial<CareFile>) => { if (selectedId !== null) writeCare(selectedId, patchFile) },
    [selectedId],
  )
  const onCareClear = useCallback(
    () => { if (selectedId !== null) clearCare(selectedId) },
    [selectedId],
  )

  /* Unreachable in practice — `profiles` is built from the same rows `selected`
     is found in — but the sheet must not be handed `undefined` if that ever
     stops being true, because a crashed sheet takes the whole screen with it. */
  const emptyProfile: PurchaseProfile = {
    bills: 0, voided: 0, items: [], refills: [], units: '0', spend: '0.00', average: null,
    first: null, last: null, daysSince: null, visitCycle: null, prescribers: [], segment: 'none',
  }

  return (
    <div className="flex h-full flex-col bg-app">
      <header className="page-header flex shrink-0 items-start justify-between gap-4 px-[var(--page-px)] py-4 [@media(max-height:800px)]:py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-semibold tracking-tight text-fg [@media(max-height:800px)]:text-xl">
            Customers
          </h1>
          <p className="mt-0.5 text-base text-fg-muted [@media(max-height:800px)]:hidden">
            {base === 'ready'
              ? <>{book.customers.toLocaleString('en-IN')} on the book — what is owed, what each takes every month, and what must never be dispensed.</>
              : 'Accounts, credit standing, refill cycles and outstanding balances.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 text-2xs text-fg-subtle lg:flex">
            <Kbd>/</Kbd> search
          </span>
          <Button
            variant={lateRefills > 0 ? 'primary' : 'secondary'}
            onClick={() => setRemindersOpen(true)}
            disabled={base !== 'ready'}
          >
            <BellRing /> Reminders
            {refills.length + birthdays.length > 0 ? (
              <span
                className={cn(
                  'num ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-full)] px-1 text-2xs font-semibold',
                  /* An opaque plate, not a 20% white wash: the wash let the
                     accent beneath it show through and took the count to
                     3.5:1 against its own label. */
                  lateRefills > 0 ? 'bg-white text-accent-11' : 'bg-inset text-fg-muted',
                )}
              >
                {refills.length + birthdays.length}
              </span>
            ) : null}
          </Button>
        </div>
      </header>

      {base === 'ready' ? (
        <ReceivablesStrip
          book={book}
          billStatus={billStatus}
          refills={refills.length}
          lateRefills={lateRefills}
          horizon={horizon}
          onShowAged={() => patch({ view: 'aged' })}
          onShowOverLimit={() => patch({ view: 'overlimit' })}
          onShowOwing={() => patch({ view: 'owes' })}
          onShowReminders={() => setRemindersOpen(true)}
        />
      ) : null}

      <Filters
        value={filters}
        segment={segment}
        onPatch={patch}
        searchRef={searchRef}
        billStatus={billStatus}
      />

      <div className="flex min-h-0 flex-1 gap-[var(--card-gap)] px-[var(--page-px)] pb-[var(--card-gap)]">
        {/* The grid keeps its own density. This is the one place on the screen
            where rows-above-the-fold beats air, and the page chrome around it
            runs spacious precisely so that the grid does not have to. */}
        <div data-density="compact" className="card flex min-w-0 flex-1 flex-col overflow-hidden">
          <CustomerTable
            rows={rows}
            total={book.customers}
            care={care}
            profiles={profiles}
            status={status}
            errorCode={blocked
              ? 'CUSTOMER_BILLS_FAILED'
              : error instanceof ApiError ? error.code : 'CUSTOMERS_FAILED'}
            errorMessage={blocked
              ? billError ?? 'Bills could not be read, so no balance can be aged against them and nothing can be said about what anybody buys.'
              : error ? (error as Error).message : undefined}
            billStatus={billStatus}
            narrow={selected !== null}
            activeIndex={activeIndex}
            selectedId={selectedId}
            filtered={filtered}
            onActiveIndexChange={setActiveIndex}
            onOpen={(row) => select(row.customer.id)}
            onEscape={() => {
              if (selectedId !== null) select(null)
              else if (filtered) resetFilters()
            }}
            onRetry={() => { if (blocked) retryAgeing(); else void customers.refetch() }}
            onClearFilters={resetFilters}
            onGoToBilling={() => navigate('/billing')}
            bodyRef={bodyRef}
          />
        </div>

        {selected ? (
          <CustomerDetail
            key={selected.customer.id}
            row={selected}
            profile={profiles.get(selected.customer.id) ?? emptyProfile}
            care={careOf(care, selected.customer.id)}
            store={store.data ?? null}
            today={today}
            billStatus={billStatus}
            billError={billError}
            busy={receipt.isPending}
            onClose={() => {
              /* Focus goes back to the row it was opened from, not to the top of
                 the list. A keyboard operator who closes one account is next
                 going to arrow to the one below it, not start again. */
              const id = selected.customer.id
              select(null)
              bodyRef.current
                ?.querySelector<HTMLButtonElement>(`[data-customer-id="${id}"]`)
                ?.focus()
            }}
            onRetryBills={retryAgeing}
            onRecordReceipt={() => setReceiptOpen(true)}
            onGoToBilling={() => navigate('/billing')}
            onCareChange={onCareChange}
            onCareClear={onCareClear}
          />
        ) : null}
      </div>

      <ReceiptDialog
        open={receiptOpen}
        onOpenChange={setReceiptOpen}
        row={selected}
        busy={receipt.isPending}
        onCommit={(input) => receipt.mutate(input)}
      />

      <RemindersDialog
        open={remindersOpen}
        onOpenChange={setRemindersOpen}
        refills={refills}
        birthdays={birthdays}
        horizon={horizon}
        onHorizonChange={setHorizon}
        today={todayIso}
        onOpenCustomer={(id) => { setRemindersOpen(false); select(id) }}
        onGoToBilling={() => navigate('/billing')}
      />
    </div>
  )
}

// -------------------------------------------------------------- the book ----

/**
 * The four figures the screen exists to show, as lit cards.
 *
 * The receivable takes the display size because it is the one number an owner
 * opens this page for; the other three are counts, and a count set at the same
 * size as the money would make four headlines and therefore none. Three of the
 * four are BUTTONS — a number is only useful if pressing it shows you which
 * accounts it is — and only those three lift on hover, because a panel that
 * moves under the cursor without opening anything is noise.
 */
function ReceivablesStrip({
  book,
  billStatus,
  refills,
  lateRefills,
  horizon,
  onShowAged,
  onShowOverLimit,
  onShowOwing,
  onShowReminders,
}: {
  book: BookSummary
  billStatus: BillStatus
  refills: number
  lateRefills: number
  horizon: Horizon
  onShowAged: () => void
  onShowOverLimit: () => void
  onShowOwing: () => void
  onShowReminders: () => void
}) {
  const r: Receivable = book.receivable
  const hasAged = D.gt(D.dec(r.over90), D.ZERO)
  const agedBills = r.buckets.find((b) => b.key === 'b90p')?.count ?? 0
  const unaged = unallocatedNote(r)

  return (
    <div className="grid shrink-0 grid-cols-2 gap-[var(--card-gap)] px-[var(--page-px)] pb-[var(--card-gap)] xl:grid-cols-[minmax(0,1.9fr)_repeat(3,minmax(0,1fr))]">
      <div className="card col-span-2 flex flex-col justify-between px-[var(--card-px)] py-3 [@media(max-height:800px)]:py-2 xl:col-span-1">
        <div>
          <span className="micro-label block">Total receivable</span>
          <span className="display-num mt-0.5 block text-4xl text-fg [@media(max-height:800px)]:text-2xl">
            {formatMoney(r.outstanding)}
          </span>
          <button
            type="button"
            onClick={onShowOwing}
            disabled={book.onCredit === 0}
            className="mt-0.5 rounded-[var(--radius-sm)] text-sm text-fg-muted enabled:hover:text-accent-11 enabled:hover:underline disabled:cursor-default"
          >
            {book.onCredit} of {book.customers} account{book.customers === 1 ? '' : 's'} on credit
          </button>
        </div>

        {billStatus === 'ready' ? (
          <div className="mt-3 [@media(max-height:800px)]:mt-2">
            <AgeingBar receivable={r} className="h-2" />
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 [@media(max-height:800px)]:mt-1">
              {r.buckets.map((b) => (
                <span key={b.key} className="flex items-center gap-1 text-2xs text-fg-muted">
                  <span aria-hidden className="size-2 rounded-[2px]" style={{ backgroundColor: b.tone }} />
                  {b.short}
                  <span className="num text-fg">{formatAmount(b.amount)}</span>
                </span>
              ))}
              {/* The four buckets sit beside a total they do not add up to
                  whenever a balance predates the loaded bills or money was paid
                  on account. The remainder is named — a bar that quietly fails
                  to reconcile with the figure printed next to it is worse than
                  no bar, and "nothing due" beside a live balance is worse again. */}
              {unaged ? (
                <span className="flex items-center gap-1 text-2xs text-fg-muted">
                  <span aria-hidden className="size-2 rounded-[2px] bg-inset" />
                  {unaged.credit ? 'On account' : 'Not aged'}
                  {/* Unsigned: the two words in front of it carry the direction,
                      and a minus here made "On account" read as a debt. */}
                  <span className={cn('num', unaged.credit ? 'text-fg' : 'text-warning-11')}>
                    {formatAmount(unaged.amount)}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-fg-muted">
            {billStatus === 'loading'
              ? 'Ageing the receivable against the bills…'
              : 'Bills could not be read, so this balance cannot be aged. The total above still stands.'}
          </p>
        )}
      </div>

      <StatCard
        label="Past 90 days"
        icon={TriangleAlert}
        value={billStatus === 'ready' ? formatMoney(r.over90) : '—'}
        note={billStatus !== 'ready'
          ? 'Waiting on the bills'
          : hasAged
            ? `across ${agedBills} bill${agedBills === 1 ? '' : 's'} — chase these`
            : 'nothing this old'}
        tone={billStatus === 'ready' && hasAged ? 'danger' : undefined}
        action="Show them"
        onClick={onShowAged}
        disabled={billStatus !== 'ready' || !hasAged}
      />

      <StatCard
        label="Over limit"
        icon={CreditCard}
        value={`${book.overLimit}`}
        note={book.overLimit === 0
          ? 'everybody inside the credit agreed'
          : `account${book.overLimit === 1 ? '' : 's'} past the credit agreed`}
        tone={book.overLimit > 0 ? 'danger' : undefined}
        action="Show them"
        onClick={onShowOverLimit}
        disabled={book.overLimit === 0}
      />

      <StatCard
        label={`Refills due · ${horizon} days`}
        icon={AlarmClock}
        value={`${refills}`}
        note={billStatus !== 'ready'
          ? 'Waiting on the bills'
          : lateRefills > 0
            ? `${lateRefills} already late — ring them`
            : refills === 0 ? 'nobody is due yet' : 'monthly refills coming up'}
        tone={lateRefills > 0 ? 'warning' : undefined}
        action="Open reminders"
        onClick={onShowReminders}
        disabled={billStatus !== 'ready'}
      />
    </div>
  )
}

/** A figure that OPENS something. Only these take `.card-link`. */
function StatCard({
  label, icon: Icon, value, note, tone, action, onClick, disabled,
}: {
  label: string
  icon: LucideIcon
  value: string
  note: string
  tone?: 'danger' | 'warning'
  action: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'card flex flex-col justify-between px-[var(--card-px)] py-3 text-left [@media(max-height:800px)]:py-2',
        // `.card-link` is a plain class, not a Tailwind utility, so it cannot be
        // hung off `enabled:` — a card with nothing to open must simply not get it.
        disabled ? 'cursor-default' : 'card-link',
      )}
    >
      <span className="flex items-center gap-1.5">
        {/* Colour never rides alone: the icon and the label carry it too. */}
        <Icon
          size={13}
          aria-hidden
          className={cn(
            'shrink-0',
            tone === 'danger' ? 'text-danger-9' : tone === 'warning' ? 'text-warning-9' : 'text-fg-subtle',
          )}
        />
        <span className="micro-label truncate">{label}</span>
      </span>
      <span
        className={cn(
          'display-num mt-1 block truncate text-3xl [@media(max-height:800px)]:text-2xl',
          tone === 'danger' ? 'text-danger-11' : tone === 'warning' ? 'text-warning-11' : 'text-fg',
        )}
        title={value}
      >
        {value}
      </span>
      <span className="mt-0.5 block truncate text-2xs text-fg-muted" title={note}>{note}</span>
      <span
        className={cn(
          'mt-2 text-2xs font-medium [@media(max-height:800px)]:mt-1',
          disabled ? 'text-fg-disabled' : 'text-accent-11',
        )}
      >
        {action} →
      </span>
    </button>
  )
}

// ---------------------------------------------------------------- filters ---

function Filters({
  value,
  segment,
  onPatch,
  searchRef,
  billStatus,
}: {
  value: FilterState
  segment: SegmentFilter
  onPatch: (patch: Partial<FilterState> & { segment?: SegmentFilter }) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  billStatus: BillStatus
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
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-[var(--page-px)] pb-[var(--card-gap)] [@media(max-height:800px)]:pb-2">
      <div className="relative w-[300px]">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={searchRef}
          value={box}
          onChange={(e) => setBox(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && box) { e.stopPropagation(); setBox('') } }}
          aria-label="Find a customer"
          placeholder="Name, phone, GSTIN or allergen…"
          autoComplete="off"
          spellCheck={false}
          className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-9 text-base placeholder:text-fg-subtle hover:border-border-strong"
        />
        {box ? (
          <button
            type="button"
            onClick={() => setBox('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X size={14} aria-hidden />
          </button>
        ) : (
          <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2">/</Kbd>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const on = value.view === p.id
          /* Offered only once it can be answered. A chip that filters on an
             ageing the bill window has not produced yet would hand back an empty
             list, and empty here reads as "nobody", not as "not yet". */
          const disabled = billStatus !== 'ready' && BILL_BACKED_VIEWS.has(p.id)
          return (
            <Chip
              key={p.id}
              on={on}
              disabled={disabled}
              icon={p.icon}
              tone={p.tone}
              label={p.label}
              title={disabled
                ? billStatus === 'loading' ? 'Reading the bills…' : 'Bills could not be read, so nothing can be aged.'
                : undefined}
              onClick={() => onPatch({ view: p.id })}
            />
          )
        })}
      </div>

      {/* A SECOND axis, not more presets. "Which of my chronic patients owe me
          money" is a real question and an exclusive chip row cannot ask it. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="micro-label">Pattern</span>
        {SEGMENT_CHIPS.map((s) => (
          <Chip
            key={s.id}
            on={segment === s.id}
            disabled={billStatus !== 'ready' && s.id !== 'any'}
            icon={s.icon}
            tone={s.tone}
            label={s.label}
            /* Every one of these is a DERIVED judgement, so the rule behind it
               is one hover away. A filter whose definition is a secret gets
               used once and then distrusted. */
            title={billStatus !== 'ready' && s.id !== 'any'
              ? 'Buying patterns are read off the bills, which have not arrived.'
              : s.id === 'any' ? 'Every customer, whatever they buy' : SEGMENT_MEANING[s.id]}
            onClick={() => onPatch({ segment: s.id })}
          />
        ))}
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

function Chip({
  on, disabled, icon: Icon, tone, label, title, onClick,
}: {
  on: boolean
  disabled?: boolean
  icon: LucideIcon
  tone?: string
  label: string
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border px-2.5 text-xs',
        'disabled:cursor-default disabled:opacity-50',
        on
          ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
          : 'border-border-subtle bg-surface text-fg-muted enabled:hover:border-border-strong enabled:hover:text-fg',
      )}
    >
      <Icon size={13} aria-hidden style={on ? undefined : { color: tone }} />
      {label}
    </button>
  )
}
