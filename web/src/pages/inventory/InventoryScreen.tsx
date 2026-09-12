import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ChevronDown, ChevronRight, Hourglass, LayoutGrid, MapPin, PackageX, ScanSearch, Search,
  ShieldCheck, ShieldOff, Tag, TriangleAlert, Truck, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  BatchRow, InventoryFilters, InventorySummary,
  MedicinePage, StockAdjustmentInput, StockMovement,
} from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { compactINR } from '@/components/charts'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip, ExpiryChip } from '@/components/ui/Badge'
import { BatchTable } from './BatchTable'
import type { SortKey, TableStatus } from './BatchTable'
import { ExpiryBoard } from './ExpiryBoard'
import type { ExpiryBucketKey } from './ExpiryBoard'
import { MovementHistory } from './MovementHistory'
import type { MovementScope } from './MovementHistory'
import { AdjustDialog, QuarantineDialog } from './AdjustDialog'
import { TransferDialog } from './TransferDialog'
import { TransferList } from './TransferList'
import { LabelDialog } from './LabelDialog'
import { ValuationBand } from './ValuationBand'
import { AgeingView } from './AgeingView'
import { DeadStockView } from './DeadStockView'
import { RackView } from './RackView'
import { BulkBar, BulkHoldDialog } from './BulkActions'
import type { Basis, BatchAge } from './analysis'
import { BASIS_VALUES, holdsStock, marginPct, parse, readBatchAge } from './analysis'

/**
 * Stock control, batch by batch.
 *
 * Marg ships seventeen stock reports — Current, Filtered, Batch, Dump, Expiry,
 * Near Expiry, Minimum Level, Stock Ageing, Fast/Slow Moving — each behind its
 * own parameter dialog. Every one of them is a predicate, a grouping or a sort
 * over the same batch table. So there is one grid here, the near-expiry buckets
 * are cards above it, the four ways of reading the same shelf are tabs, and the
 * whole view lives in the URL: a view is a link, Back walks the filters the
 * operator actually applied, and a reload lands on the same row.
 *
 * The screen owns the URL, every query and every write. Its children own no
 * state that outlives a keystroke, which is what lets the board, the grid, the
 * analytical views and the ledger sheet share one invalidation.
 *
 * Three things this screen refuses to do, all deliberate:
 *  - It never edits `qtyOnHand`. An adjustment posts a movement and the balance
 *    follows; the closing stock is derived, never assigned.
 *  - It never hides a reconciliation gap. If the ledger and the batch table
 *    disagree, that is the first thing on the page.
 *  - It never shows a stock value without saying what basis it is on. Landed
 *    cost and printed MRP differ by the whole margin.
 */

const PAGE_SIZE = 200

type BucketFilter = NonNullable<InventoryFilters['bucket']>
type StockFilter = NonNullable<InventoryFilters['stock']>

/** The four ways of reading the same shelf. */
type ViewKey = 'batches' | 'ageing' | 'rack' | 'dead'

const BUCKET_VALUES: BucketFilter[] = ['all', 'expired', 'd30', 'd60', 'd90', 'd180']
const STOCK_VALUES: StockFilter[] = ['all', 'low', 'out', 'quarantined']
const SORT_VALUES: SortKey[] = ['expiry', 'value', 'name', 'qty']
const SCOPE_VALUES: MovementScope[] = ['batch', 'item']
const VIEW_VALUES: ViewKey[] = ['batches', 'ageing', 'rack', 'dead']

const VIEW_TABS: Array<{ key: ViewKey; label: string; icon: LucideIcon; hint: string }> = [
  { key: 'batches', label: 'Batches', icon: LayoutGrid, hint: 'Every batch, filterable and sortable' },
  { key: 'ageing', label: 'Ageing', icon: Hourglass, hint: 'How long each batch has sat, from the ledger' },
  { key: 'rack', label: 'Rack walk', icon: MapPin, hint: 'The shelf in the order the shop is laid out' },
  { key: 'dead', label: 'Dead stock', icon: PackageX, hint: 'Money that has stopped moving' },
]

const STOCK_LABEL: Record<StockFilter, string> = {
  all: 'Any stock',
  low: 'At or below reorder',
  out: 'Out of stock',
  quarantined: 'Quarantined',
}

/* Windows, not bands. `matchesBucket` in api/inventory treats d90 as "expires
   within 90 days" — a batch twenty days out is in it — and a label that reads
   "61–90 days" would promise a band the query does not deliver. */
const BUCKET_LABEL: Record<BucketFilter, string> = {
  all: 'Any expiry',
  expired: 'Expired',
  d30: 'Within 30 days',
  d60: 'Within 60 days',
  d90: 'Within 90 days',
  d180: 'Within 180 days',
}

const SORT_LABEL: Record<SortKey, string> = {
  expiry: 'Expiry (soonest first)',
  value: 'Value at cost',
  name: 'Medicine (A–Z)',
  qty: 'Quantity on hand',
}

/**
 * `buildBatchPage` caps a page at 200, so this is one round trip and never more.
 * Expired batches are counted in the hundreds at worst; a shop with more than
 * this many has a problem the board is not going to solve.
 */
const EXPIRED_SCAN = 200

/** The number of ledger rows a discrepancy walk needs. Reading backwards from
 *  today to the last known-good point is never a hundred rows in a pharmacy. */
const LEDGER_LIMIT = 100

/**
 * The analytical views read ONE page of batches, ordered by value.
 *
 * They are whole-shelf questions asked of a paging endpoint, so something has to
 * give. Taking the most valuable page is the version that is useful and honest:
 * it answers for the money first, it is deterministic, and every panel says on
 * screen how much of the shelf it looked at.
 */
const ANALYSIS_LIMIT = 200

/**
 * Ageing costs ONE ledger read per batch — there is no bulk "last movement per
 * batch" in the contract, and the unfiltered ledger is a few days deep in a shop
 * doing three hundred movements a day, which cannot answer a ninety-day
 * question. So the probe is bounded, and the panels say how many batches it
 * reached.
 */
const PROBE_CAP = 120

/** Deep enough to reach the opening movement of any real batch. */
const PROBE_DEPTH = 500

const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

const EMPTY_ROWS: BatchRow[] = []
const EMPTY_MOVEMENTS: StockMovement[] = []
const EMPTY_MANUFACTURERS: string[] = []
const NO_SELECTION: ReadonlySet<number> = new Set<number>()

interface FilterState {
  term: string
  bucket: BucketFilter
  stock: StockFilter
  manufacturer: string
  sort: SortKey
}

/** Everything the address bar carries: the filters, which reading of the shelf
 *  is on screen, what money is being counted in, and which batch is open. */
interface ViewState {
  filters: FilterState
  view: ViewKey
  basis: Basis
  deadDays: number
  overview: boolean
  batchId: number | null
  scope: MovementScope
}

/* Expiry-first by default. Every other order is a report; this one is the work
   queue — the batch nearest its date is the batch that needs a decision today. */
const DEFAULT_FILTERS: FilterState = {
  term: '',
  bucket: 'all',
  stock: 'all',
  manufacturer: '',
  sort: 'expiry',
}

const DEFAULT_DEAD_DAYS = 90

/**
 * Whether the totals band starts open.
 *
 * A 1366x768 counter panel leaves about 640px of usable viewport, and the band
 * costs it four grid rows — which on a till is the difference between working a
 * shelf and scrolling. So the DEFAULT follows the screen: open on a manager's
 * monitor, folded on the counter. It is only a default; `ov` in the URL wins
 * either way, so a link still opens the same view it was copied from.
 */
const OVERVIEW_DEFAULT = typeof window === 'undefined' || window.innerHeight >= 760

function oneOf<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback
}

function readId(p: URLSearchParams, key: string): number | null {
  const raw = p.get(key)
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
}

function readView(p: URLSearchParams): ViewState {
  return {
    filters: {
      term: p.get('q') ?? '',
      bucket: oneOf(p.get('bucket'), BUCKET_VALUES, 'all'),
      stock: oneOf(p.get('stock'), STOCK_VALUES, 'all'),
      manufacturer: p.get('mfr') ?? '',
      sort: oneOf(p.get('sort'), SORT_VALUES, 'expiry'),
    },
    view: oneOf(p.get('view'), VIEW_VALUES, 'batches'),
    basis: oneOf(p.get('basis'), [...BASIS_VALUES], 'cost'),
    deadDays: readId(p, 'dd') ?? DEFAULT_DEAD_DAYS,
    overview: p.get('ov') === null ? OVERVIEW_DEFAULT : p.get('ov') !== '0',
    batchId: readId(p, 'b'),
    scope: oneOf(p.get('ls'), SCOPE_VALUES, 'batch'),
  }
}

/** Only non-default axes are written, so a clean view has a clean URL. */
function toParams(v: ViewState): URLSearchParams {
  const p = new URLSearchParams()
  const f = v.filters
  if (f.term.trim()) p.set('q', f.term.trim())
  if (f.bucket !== 'all') p.set('bucket', f.bucket)
  if (f.stock !== 'all') p.set('stock', f.stock)
  if (f.manufacturer) p.set('mfr', f.manufacturer)
  if (f.sort !== 'expiry') p.set('sort', f.sort)
  if (v.view !== 'batches') p.set('view', v.view)
  if (v.basis !== 'cost') p.set('basis', v.basis)
  if (v.deadDays !== DEFAULT_DEAD_DAYS) p.set('dd', String(v.deadDays))
  if (v.overview !== OVERVIEW_DEFAULT) p.set('ov', v.overview ? '1' : '0')
  if (v.batchId !== null) p.set('b', String(v.batchId))
  if (v.batchId !== null && v.scope !== 'batch') p.set('ls', v.scope)
  return p
}

function toApiFilters(f: FilterState): InventoryFilters {
  return {
    ...(f.term.trim() ? { term: f.term.trim() } : {}),
    ...(f.manufacturer ? { manufacturer: f.manufacturer } : {}),
    bucket: f.bucket,
    stock: f.stock,
    sort: f.sort,
  }
}

function isFiltered(f: FilterState): boolean {
  return f.term.trim() !== '' || f.bucket !== 'all' || f.stock !== 'all' || f.manufacturer !== ''
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function InventoryScreen() {
  /* Straight off the context, with no assertion widening it: `ApiAdapter` carries
     `InventoryPurchasesApi`, so a method that drifts from the contract has to
     fail the build here rather than be cast into existence. */
  const api = useApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  /* Injected once per mount, exactly as `domain/fefo` takes it: expiry is a
     boundary condition, and a component that reads the clock per render can
     disagree with itself across midnight. */
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const state = useMemo(() => readView(params), [params])
  const { filters, view, basis, deadDays, overview } = state
  const selectedBatchId = state.batchId
  const ledgerScope = state.scope

  const [activeIndex, setActiveIndex] = useState(0)
  const [adjustRow, setAdjustRow] = useState<BatchRow | null>(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const [labelTarget, setLabelTarget] = useState<BatchRow[] | null>(null)
  const [holdRow, setHoldRow] = useState<BatchRow | null>(null)
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<number>>(NO_SELECTION)
  /* Where the last tick landed, so Shift means "extend from there" rather than
     "from wherever the highlight happens to be". State rather than a ref: it is
     reset during render alongside the selection it belongs to. */
  const [anchor, setAnchor] = useState<number | null>(null)

  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api.listStores() })
  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })

  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const overlayOpen = adjustRow !== null || holdRow !== null || bulkHoldOpen || labelTarget !== null

  // ------------------------------------------------------------- the data ---

  const summary = useQuery({
    queryKey: ['inventory', 'summary'],
    queryFn: () => api.inventorySummary(),
  })

  const list = useInfiniteQuery({
    queryKey: ['inventory', 'batches', filters],
    queryFn: ({ pageParam }) =>
      api.listBatches({
        ...toApiFilters(filters),
        limit: PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    /* The previous view's rows stay on screen while the next resolves. Dropping
       to a skeleton on every keystroke is what makes a fast grid feel slow. */
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? EMPTY_ROWS, [list.data])
  const total = list.data?.pages.at(0)?.total ?? 0

  /* The facet, not the page: `listBatches` returns batches, and a manufacturer
     list assembled from whatever happens to be loaded would grow as you scroll.
     The catalogue endpoint carries the distinct set across the whole master. */
  const facets = useQuery({
    queryKey: ['medicines', 'facets'],
    queryFn: () => api.listMedicines({ limit: 1 }),
    select: (p: MedicinePage) => p.manufacturers,
    staleTime: 5 * 60_000,
  })

  /**
   * Expired stock, which `InventorySummary.atRisk` deliberately omits: expired
   * goods are not at risk, they are already lost, and the helper excludes them so
   * a still-meetable deadline is not diluted by a write-off. The board needs both
   * numbers anyway, so both are counted off the page. Sorted by value, so a shop
   * that somehow exceeds one page still sees where the money is.
   */
  const expired = useQuery({
    queryKey: ['inventory', 'expired'],
    queryFn: () => api.listBatches({ bucket: 'expired', sort: 'value', limit: EXPIRED_SCAN }),
    /* Only batches that still HOLD something, which is why the count comes off
       the rows rather than off `page.total`. A batch written off to zero keeps
       its expired bucket for ever, so `total` gives this card a number the work
       it asks for can never reduce — write off every last strip and it does not
       move — and it would read against the at-risk cards beside it, which count
       stock (`atRiskBuckets` skips empties for the same reason). Sorted by value,
       so anything emptied sorts last and the count is short only when the scan
       itself was, which `exact` already says. */
    select: (page) => {
      const held = page.rows.filter((r) => holdsStock(r.batch.qtyOnHand))
      return {
        batches: held.length,
        valueAtCost: D.toStr(
          D.sum(held.flatMap((r) => {
            const v = parse(r.valueAtCost)
            return v === null ? [] : [v]
          })),
          2,
        ),
        exact: page.nextCursor === null,
      }
    },
  })

  const selectedRow = rows.find((r) => r.batch.id === selectedBatchId) ?? null

  const movements = useQuery({
    queryKey: ['inventory', 'movements', ledgerScope, selectedBatchId, selectedRow?.medicine.id ?? null],
    queryFn: () =>
      api.listMovements(
        ledgerScope === 'item' && selectedRow
          ? { medicineId: selectedRow.medicine.id, limit: LEDGER_LIMIT }
          : { batchId: selectedBatchId ?? 0, limit: LEDGER_LIMIT },
      ),
    /* Gated on the ROW, not just the id. `listBatches` has no by-id lookup in the
       contract, so a deep link naming a batch the current filters exclude cannot
       open the sheet — and fetching a ledger nothing can render is pure cost. */
    enabled: selectedBatchId !== null && selectedRow !== null,
  })

  // ------------------------------------------------- the analytical slice ---

  const analysing = view !== 'batches'
  const ledgerNeeded = view === 'ageing' || view === 'dead'

  const analysis = useQuery({
    queryKey: ['inventory', 'analysis', toApiFilters(filters)],
    queryFn: () => api.listBatches({ ...toApiFilters(filters), sort: 'value', limit: ANALYSIS_LIMIT }),
    enabled: analysing,
    staleTime: 30_000,
  })

  const analysisRows = analysis.data?.rows ?? EMPTY_ROWS
  const analysisTotal = analysis.data?.total ?? 0

  /* The exact slice the ledger will be read for, and the exact slice the two
     ledger-backed views are given. Handing them the whole analysis page would
     report every unprobed batch as "no movement on file", which is a
     reconciliation alarm rather than a paging artefact. */
  const probeRows = useMemo(
    () => analysisRows.filter((r) => holdsStock(r.batch.qtyOnHand)).slice(0, PROBE_CAP),
    [analysisRows],
  )
  const probeIds = useMemo(() => probeRows.map((r) => r.batch.id), [probeRows])

  /**
   * One movement history per batch, read in parallel and reduced to three dates.
   * The whole history is fetched rather than the last row alone because "last
   * movement OUT" and "when it arrived" are at opposite ends of it.
   */
  const ledger = useQuery({
    queryKey: ['inventory', 'ledgerAges', probeIds],
    queryFn: async () => {
      const entries = await Promise.all(probeIds.map(async (id) => {
        const moves = await api.listMovements({ batchId: id, limit: PROBE_DEPTH })
        return [id, readBatchAge(id, moves)] as const
      }))
      return new Map<number, BatchAge>(entries)
    },
    enabled: ledgerNeeded && probeIds.length > 0,
    staleTime: 60_000,
  })

  const analysisStatus: 'loading' | 'error' | 'ready' =
    analysis.isPending ? 'loading'
      : analysis.error ? 'error'
        : ledgerNeeded && probeIds.length > 0 && ledger.isPending ? 'loading'
          : ledgerNeeded && ledger.error ? 'error'
            : 'ready'

  const analysisError = analysis.error ?? ledger.error

  const onNeedMore = useCallback(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
  }, [list])

  // -------------------------------------------------------- URL as the view ---

  const patch = useCallback(
    (next: Partial<Omit<ViewState, 'filters'>> & { filters?: Partial<FilterState> }) => {
      /* A term-only change REPLACES: one typed word must not leave twenty stops
         in the history. Every other axis is a deliberate act and pushes. */
      const termOnly = Object.keys(next).length === 1
        && next.filters !== undefined
        && Object.keys(next.filters).length === 1
        && 'term' in next.filters
      setParams(
        (prev) => {
          const base = readView(prev)
          return toParams({
            ...base,
            ...next,
            filters: { ...base.filters, ...(next.filters ?? {}) },
          })
        },
        { replace: termOnly },
      )
    },
    [setParams],
  )

  /* Opening a batch REPLACES rather than pushes. The id is in the URL so the row
     survives a reload and can be pasted into a message, but arrowing down a
     shelf must not leave forty stops in the history. */
  const select = useCallback(
    (batchId: number | null) => {
      setParams((prev) => toParams({ ...readView(prev), batchId, scope: 'batch' }), { replace: true })
    },
    [setParams],
  )

  const setScope = useCallback(
    (scope: MovementScope) => {
      setParams((prev) => toParams({ ...readView(prev), scope }), { replace: true })
    },
    [setParams],
  )

  /**
   * Jump from an analytical row to that batch's ledger.
   *
   * The grid pages, so the batch a rack list names is very often not in the
   * loaded page — and the sheet can only open a row the grid holds. Searching
   * for the batch number is what guarantees it is: the batch number is in the
   * search haystack precisely because a recall names one and nothing else.
   */
  const openBatch = useCallback(
    (row: BatchRow) => {
      setParams((prev) => {
        const base = readView(prev)
        return toParams({
          ...base,
          view: 'batches',
          filters: { ...base.filters, term: row.batch.batchNo, bucket: 'all', stock: 'all' },
          batchId: row.batch.id,
          scope: 'batch',
        })
      })
    },
    [setParams],
  )

  const clearFilters = useCallback(
    () => patch({ filters: { ...DEFAULT_FILTERS, sort: filters.sort } }),
    [patch, filters.sort],
  )

  /* Filters changed → the highlight goes back to the top and the selection is
     dropped, both adjusted during render so the grid never paints one frame
     pointing at the wrong row. A tick that survived a filter change would arm a
     bulk action against batches nobody can see. */
  const filterKey = JSON.stringify(filters)
  const [lastFilterKey, setLastFilterKey] = useState(filterKey)
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey)
    setActiveIndex(0)
    setSelection(NO_SELECTION)
    setAnchor(null)
  }

  /* Following the URL, not the click: a deep link and a Back both have to land
     the highlight on the row the address bar names. */
  const loadedIndex = rows.findIndex((r) => r.batch.id === selectedBatchId)
  const [lastSelected, setLastSelected] = useState(selectedBatchId)
  if (selectedBatchId !== lastSelected) {
    setLastSelected(selectedBatchId)
    if (loadedIndex >= 0) setActiveIndex(loadedIndex)
  }

  // ------------------------------------------------------------ selection ---

  /* Every row the page is currently holding, from either the grid or the
     analytical page, so a bulk action can describe what it is about to do even
     when the tick was made in a different view. */
  const rowsById = useMemo(() => {
    const m = new Map<number, BatchRow>()
    for (const r of analysisRows) m.set(r.batch.id, r)
    for (const r of rows) m.set(r.batch.id, r)
    return m
  }, [rows, analysisRows])

  const selectedRows = useMemo(
    () => [...selection].flatMap((id) => {
      const r = rowsById.get(id)
      return r ? [r] : []
    }),
    [selection, rowsById],
  )

  const clearSelection = useCallback(() => {
    setSelection(NO_SELECTION)
    setAnchor(null)
  }, [])

  const toggleOne = useCallback((id: number) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleInGrid = useCallback(
    (row: BatchRow, index: number, range: boolean) => {
      if (range && anchor !== null && anchor !== index) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
        const span = rows.slice(from, to + 1).map((r) => r.batch.id)
        setSelection((prev) => {
          const next = new Set(prev)
          for (const id of span) next.add(id)
          return next
        })
      } else {
        toggleOne(row.batch.id)
      }
      setAnchor(index)
    },
    [rows, toggleOne, anchor],
  )

  const selectMany = useCallback((ids: number[]) => {
    setSelection((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [])

  const selectLoaded = useCallback((loaded: BatchRow[], on: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev)
      for (const r of loaded) {
        if (on) next.add(r.batch.id)
        else next.delete(r.batch.id)
      }
      return next
    })
  }, [])

  // --------------------------------------------------------------- writes ---

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['inventory'] })
    /* The POS reads the same batches through a different key, and so does the
       catalogue's stock column. A write that only lands here is a bug somebody
       finds at the counter. */
    void qc.invalidateQueries({ queryKey: qk.stock })
    void qc.invalidateQueries({ queryKey: ['medicines'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }, [qc])

  const adjust = useMutation({
    mutationFn: (input: StockAdjustmentInput) => api.adjustStock(input),
    onSuccess: (updated) => {
      invalidate()
      setAdjustRow(null)
      /* No Undo action, unlike a rack edit. There is nothing to undo — the row is
         already in an append-only ledger, and the message says how to correct it
         rather than offering a button that would quietly post a second lie. */
      toast.success(`${updated.medicine.brandName} ${updated.batch.batchNo} → ${formatQty(updated.batch.qtyOnHand)}`, {
        description: 'Recorded as a movement. Correct it with another adjustment; nothing is ever edited.',
      })
    },
    onError: (err) => toast.error('The adjustment was not posted', { description: (err as Error).message }),
  })

  const quarantine = useMutation({
    mutationFn: (v: { batchId: number; quarantined: boolean; note: string }) =>
      api.setBatchQuarantined(v.batchId, v.quarantined, v.note),
    onSuccess: (updated) => {
      invalidate()
      setHoldRow(null)
      toast.success(
        updated.batch.isQuarantined
          ? `${updated.batch.batchNo} quarantined`
          : `${updated.batch.batchNo} released`,
        {
          description: updated.batch.isQuarantined
            ? 'FEFO will skip it and a manual batch pick cannot reach it. The quantity is unchanged.'
            : 'It is sellable again from the next bill.',
        },
      )
    },
    onError: (err) => toast.error('The batch was not changed', { description: (err as Error).message }),
  })

  /**
   * The bulk hold, posted ONE BATCH AT A TIME.
   *
   * Each batch gets its own ledger row, so a run that fails halfway leaves a
   * true record of exactly what moved rather than an all-or-nothing lie. The
   * result reports both halves, because "38 of 40" is the only honest way to
   * finish a partial run.
   */
  const bulkHold = useMutation({
    mutationFn: async (v: { quarantined: boolean; note: string; targets: BatchRow[] }) => {
      const failed: string[] = []
      let done = 0
      setBulkProgress({ done: 0, total: v.targets.length })
      for (const row of v.targets) {
        try {
          await api.setBatchQuarantined(row.batch.id, v.quarantined, v.note)
          done += 1
        } catch {
          failed.push(row.batch.batchNo)
        }
        setBulkProgress({ done: done + failed.length, total: v.targets.length })
      }
      return { done, failed, quarantined: v.quarantined }
    },
    onSuccess: (result) => {
      invalidate()
      setBulkProgress(null)
      setBulkHoldOpen(false)
      clearSelection()
      const verb = result.quarantined ? 'quarantined' : 'released'
      if (result.failed.length === 0) {
        toast.success(`${result.done} ${result.done === 1 ? 'batch' : 'batches'} ${verb}`, {
          description: result.quarantined
            ? 'Quantities are unchanged. FEFO will skip them and a manual batch pick cannot reach them.'
            : 'They are sellable again from the next bill.',
        })
      } else {
        toast.warning(`${result.done} ${verb}, ${result.failed.length} refused`, {
          description: `Not changed: ${result.failed.slice(0, 6).join(', ')}. The rest did move — nothing needs undoing.`,
        })
      }
    },
    onError: (err) => {
      setBulkProgress(null)
      toast.error('The run stopped', { description: (err as Error).message })
    },
  })

  // ------------------------------------------------------------- keyboard ---

  /* '/' is screen-local, so it is bound here rather than added to lib/keys:
     SHORTCUTS is the app-wide contract and a grid that exists on one route has no
     business claiming a global key. `isTypingTarget` is the same suppression rule
     the shortcut layer applies. */
  useEffect(() => {
    if (overlayOpen) return
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
  }, [overlayOpen])

  // ---------------------------------------------------------------- state ---

  const error = list.error
  const denied = error instanceof ApiError && DENIED_CODES.has(error.code)
  const status: TableStatus = denied
    ? 'denied'
    : !online && !list.data
      ? 'offline'
      : error
        ? 'error'
        : list.isPending
          ? 'loading'
          : 'ready'

  const s = summary.data ?? null
  const selectedBucket: ExpiryBucketKey | null = filters.bucket === 'all' ? null : filters.bucket
  const broken = s !== null && s.reconciliationDiscrepancies > 0
  const sortByValue = filters.sort === 'value'
    ? undefined
    : () => patch({ filters: { sort: 'value' } })

  return (
    <div className="flex h-full flex-col bg-app">
      <header className="page-header flex shrink-0 items-center justify-between gap-6 px-[var(--page-px)] py-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">Inventory</h1>
          <p className="mt-0.5 truncate text-base text-fg-muted">
            {/* A batch, not a product. The same strip arrives at two MRPs and two
                expiries and those are two rows, because a customer pays what is
                printed on the pack in their hand. */}
            What the shelf is worth, how long it has sat, where it is, and when it dies
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <LedgerHealth summary={s} pending={summary.isPending} />
          {/* Only when there is somewhere to send it. A chain of one has no
              transfers, and a button that opens a dialog with an empty branch
              list is a control that does nothing. */}
          {(stores.data?.length ?? 0) > 1 && store.data ? (
            <Button onClick={() => setTransferOpen(true)}>
              <Truck /> Send to branch
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => navigate('/purchases')}>
            <ScanSearch /> Goods receipt
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--card-gap)] px-[var(--page-px)] py-[var(--card-gap)]">
        {overview ? (
          <div className="grid shrink-0 gap-[var(--card-gap)] xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-5">
              <ValuationBand
                summary={s}
                pending={summary.isPending}
                failed={summary.error !== null}
                basis={basis}
                onBasis={(b) => patch({ basis: b })}
                stock={filters.stock}
                onStock={(stock) => patch({ filters: { stock } })}
                onRetry={() => void summary.refetch()}
              />
            </div>
            <div className="min-w-0 xl:col-span-7">
              <ExpiryBoard
                summary={s}
                expired={expired.data ?? null}
                pending={summary.isPending || expired.isPending}
                selected={selectedBucket}
                basis={basis}
                onSelect={(bucket) => patch({ filters: { bucket: bucket ?? 'all' } })}
              />
            </div>
          </div>
        ) : (
          <FoldedTotals
            summary={s}
            expired={expired.data ?? null}
            basis={basis}
            selected={selectedBucket}
            onBasis={(b) => patch({ basis: b })}
            onSelect={(bucket) => patch({ filters: { bucket: bucket ?? 'all' } })}
          />
        )}

        {broken && s ? <ReconciliationAlarm count={s.reconciliationDiscrepancies} /> : null}

        <Toolbar
          value={filters}
          view={view}
          overview={overview}
          manufacturers={facets.data ?? EMPTY_MANUFACTURERS}
          onView={(v) => patch({ view: v })}
          onOverview={(v) => patch({ overview: v })}
          onPatch={(f) => patch({ filters: f })}
          onClearAll={clearFilters}
          searchRef={searchRef}
        />

        <div className="flex min-h-0 flex-1 gap-[var(--card-gap)]">
          {view === 'batches' ? (
            <div data-density="compact" className="card flex min-w-0 flex-1 flex-col overflow-hidden">
              <BatchTable
                rows={rows}
                total={total}
                status={status}
                errorMessage={error ? (error as Error).message : undefined}
                errorCode={error instanceof ApiError ? error.code : 'INVENTORY_FAILED'}
                narrow={selectedRow !== null}
                todayIso={todayIso}
                activeIndex={activeIndex}
                selectedBatchId={selectedBatchId}
                sort={filters.sort}
                filtered={isFiltered(filters)}
                fetchingMore={list.isFetchingNextPage}
                selected={selection}
                onToggleSelect={toggleInGrid}
                onSelectLoaded={selectLoaded}
                onActiveIndexChange={setActiveIndex}
                onOpen={(row) => select(row.batch.id)}
                onEscape={() => {
                  /* Widest thing first. Escape unwinds one layer at a time, and a
                     tick is a wider claim than an open sheet. */
                  if (selection.size > 0) clearSelection()
                  else if (selectedBatchId !== null) select(null)
                  else if (isFiltered(filters)) clearFilters()
                }}
                onSortChange={(sort) => patch({ filters: { sort } })}
                onAdjust={setAdjustRow}
                onQuarantine={setHoldRow}
                onNeedMore={onNeedMore}
                onRetry={() => void list.refetch()}
                onClearFilters={clearFilters}
                onGoToPurchases={() => navigate('/purchases')}
                bodyRef={bodyRef}
                footer={
                  <BulkBar
                    rows={selectedRows}
                    basis={basis}
                    onLabels={() => setLabelTarget(selectedRows)}
                    onHold={() => setBulkHoldOpen(true)}
                    onClear={clearSelection}
                  />
                }
              />
            </div>
          ) : view === 'ageing' ? (
            <AgeingView
              rows={probeRows}
              ages={ledger.data ?? null}
              status={analysisStatus}
              errorMessage={analysisError ? (analysisError as Error).message : undefined}
              basis={basis}
              todayIso={todayIso}
              total={analysisTotal}
              filtered={isFiltered(filters)}
              onRetry={() => { void analysis.refetch(); void ledger.refetch() }}
              onOpen={openBatch}
              {...(sortByValue ? { onSortByValue: sortByValue } : {})}
            />
          ) : view === 'dead' ? (
            <DeadStockView
              rows={probeRows}
              ages={ledger.data ?? null}
              status={analysisStatus}
              errorMessage={analysisError ? (analysisError as Error).message : undefined}
              basis={basis}
              todayIso={todayIso}
              days={deadDays}
              onDays={(d) => patch({ deadDays: d })}
              total={analysisTotal}
              filtered={isFiltered(filters)}
              selected={selection}
              onToggle={toggleOne}
              onSelectAll={selectMany}
              onClearSelection={clearSelection}
              onLabels={() => setLabelTarget(selectedRows)}
              onHold={() => setBulkHoldOpen(true)}
              onRetry={() => { void analysis.refetch(); void ledger.refetch() }}
              onOpen={openBatch}
              {...(sortByValue ? { onSortByValue: sortByValue } : {})}
            />
          ) : (
            <RackView
              rows={analysisRows}
              status={analysisStatus}
              errorMessage={analysisError ? (analysisError as Error).message : undefined}
              basis={basis}
              total={analysisTotal}
              filtered={isFiltered(filters)}
              selected={selection}
              onSelectAll={selectMany}
              onToggle={toggleOne}
              onLabels={() => setLabelTarget(selectedRows)}
              onRetry={() => void analysis.refetch()}
              onOpen={openBatch}
              onGoToMedicines={() => navigate('/medicines')}
              {...(sortByValue ? { onSortByValue: sortByValue } : {})}
            />
          )}

          {/* The branch-transfer register, when there is more than one branch and
              neither a batch sheet nor an analytical view is claiming the space.
              A receiving shop otherwise has no way to explain where its stock
              came from except by opening one batch's movement history at a time,
              which nobody does. */}
          {view === 'batches' && !selectedRow && (stores.data?.length ?? 0) > 1 && store.data ? (
            <aside
              data-density="compact"
              className="card hidden w-[300px] shrink-0 flex-col overflow-hidden xl:flex"
            >
              <div className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-2.5">
                <h2 className="flex items-center gap-1.5 text-base font-semibold text-fg">
                  <Truck size={16} aria-hidden /> Branch transfers
                </h2>
                <p className="mt-0.5 text-2xs text-fg-subtle">
                  Sent and received, both directions.
                </p>
              </div>
              <div className="scroll-region min-h-0 flex-1 overflow-auto">
                <TransferList currentStore={store.data} />
              </div>
            </aside>
          ) : null}

          {view === 'batches' && selectedRow ? (
            <div data-density="compact" className="flex shrink-0">
              <BatchSheet
                key={selectedRow.batch.id}
                row={selectedRow}
                movements={movements.data ?? EMPTY_MOVEMENTS}
                movementStatus={movements.isPending ? 'loading' : movements.error ? 'error' : 'ready'}
                movementError={movements.error ? (movements.error as Error).message : undefined}
                scope={ledgerScope}
                onScopeChange={setScope}
                onRetryMovements={() => void movements.refetch()}
                onClose={() => {
                  select(null)
                  bodyRef.current?.focus()
                }}
                onAdjust={() => setAdjustRow(selectedRow)}
                onQuarantine={() => setHoldRow(selectedRow)}
                onLabel={() => setLabelTarget([selectedRow])}
              />
            </div>
          ) : null}
        </div>
      </div>

      {store.data ? (
        <TransferDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          currentStore={store.data}
        />
      ) : null}

      <LabelDialog
        open={labelTarget !== null}
        onOpenChange={(v) => { if (!v) setLabelTarget(null) }}
        rows={labelTarget ?? EMPTY_ROWS}
      />

      <BulkHoldDialog
        open={bulkHoldOpen}
        onOpenChange={(v) => { if (!v && !bulkHold.isPending) setBulkHoldOpen(false) }}
        rows={selectedRows}
        basis={basis}
        busy={bulkHold.isPending}
        progress={bulkProgress}
        onCommit={(quarantined, note, targets) => bulkHold.mutate({ quarantined, note, targets })}
      />

      <AdjustDialog
        open={adjustRow !== null}
        onOpenChange={(v) => { if (!v) setAdjustRow(null) }}
        row={adjustRow}
        busy={adjust.isPending}
        onCommit={(input) => adjust.mutate(input)}
      />

      <QuarantineDialog
        open={holdRow !== null}
        onOpenChange={(v) => { if (!v) setHoldRow(null) }}
        row={holdRow}
        busy={quarantine.isPending}
        onCommit={(quarantined, note) => {
          if (holdRow) quarantine.mutate({ batchId: holdRow.batch.id, quarantined, note })
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ header ---

/**
 * Invariant I17, rendered.
 *
 * The nightly job compares every batch's `qtyOnHand` against the sum of its
 * ledger. Zero rows is the only acceptable answer, so the clean state is a quiet
 * success chip and the broken state is an alarm — icon, word and danger tone,
 * never colour alone. A screen that shows stock figures without saying whether
 * they reconcile is asking to be trusted on nothing.
 */
function LedgerHealth({ summary, pending }: { summary: InventorySummary | null; pending: boolean }) {
  if (summary === null) {
    return pending ? <Chip>Checking the ledger…</Chip> : null
  }
  const bad = summary.reconciliationDiscrepancies > 0
  if (!bad) {
    return (
      <Chip icon={ShieldCheck} tone="var(--success-11)" className="h-8 px-2.5 text-xs">
        Ledger balanced · {summary.totalBatches.toLocaleString('en-IN')} batches · 0 discrepancies
      </Chip>
    )
  }
  return (
    <span role="status">
      <Chip icon={TriangleAlert} tone="var(--danger-11)" className="h-8 px-2.5 text-xs">
        Ledger does NOT reconcile · {summary.reconciliationDiscrepancies.toLocaleString('en-IN')}{' '}
        {summary.reconciliationDiscrepancies === 1 ? 'batch disagrees' : 'batches disagree'}
      </Chip>
    </span>
  )
}

/**
 * The totals, folded to one strip.
 *
 * Folding must not mean HIDING. A 640px till panel cannot spare 250px for a
 * band, but the two valuation bases and the expiry windows are the numbers this
 * screen exists to put in front of somebody — so the fold trades the layout for
 * a line, not the figures for nothing. Both bases still switch, every window
 * still filters, and the nesting caveat still travels with the numbers.
 */
function FoldedTotals({
  summary, expired, basis, selected, onBasis, onSelect,
}: {
  summary: InventorySummary | null
  expired: { batches: number; valueAtCost: string; exact: boolean } | null
  basis: Basis
  selected: ExpiryBucketKey | null
  onBasis: (b: Basis) => void
  onSelect: (bucket: ExpiryBucketKey | null) => void
}) {
  const windows = [...(summary?.atRisk ?? [])].sort((a, b) => b.days - a.days)
  const money = (v: string | null | undefined): string => {
    const d = parse(v)
    return d === null ? '—' : `₹${compactINR(D.toNumber(d))}`
  }

  return (
    <section
      aria-label="Stock valuation and expiry windows"
      className="card flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-[var(--card-px)] py-2"
    >
      <button
        type="button"
        aria-pressed={basis === 'cost'}
        onClick={() => onBasis('cost')}
        title={summary ? `${formatMoney(summary.stockValueAtCost)} at landed cost` : undefined}
        className={cn('rounded-[var(--radius-sm)] text-sm', basis === 'cost' ? 'text-fg' : 'text-fg-muted hover:text-fg')}
      >
        <span className={cn('micro-label mr-1.5', basis === 'cost' && 'text-accent-11')}>Stock at cost</span>
        <span className={cn('num', basis === 'cost' && 'font-semibold')}>{money(summary?.stockValueAtCost)}</span>
      </button>
      <button
        type="button"
        aria-pressed={basis === 'mrp'}
        onClick={() => onBasis('mrp')}
        title={summary ? `${formatMoney(summary.stockValueAtMrp)} at printed MRP` : undefined}
        className={cn('rounded-[var(--radius-sm)] text-sm', basis === 'mrp' ? 'text-fg' : 'text-fg-muted hover:text-fg')}
      >
        <span className={cn('micro-label mr-1.5', basis === 'mrp' && 'text-accent-11')}>Stock at MRP</span>
        <span className={cn('num', basis === 'mrp' && 'font-semibold')}>{money(summary?.stockValueAtMrp)}</span>
      </button>

      <span aria-hidden className="h-5 w-px bg-border" />

      {windows.map((w) => {
        const key = w.bucket as ExpiryBucketKey
        const on = selected === key
        return (
          <button
            key={w.bucket}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(on ? null : key)}
            className={cn(
              'rounded-[var(--radius-sm)] px-1 text-sm',
              on ? 'text-accent-11' : 'text-fg-muted hover:text-fg',
            )}
          >
            <span className="mr-1.5 text-2xs" style={{ color: on ? undefined : 'var(--fg-subtle)' }}>
              Within {w.days} days
            </span>
            <span className="num">₹{compactINR(D.toNumber(parse(w.valueAtCost) ?? D.ZERO))}</span>
          </button>
        )
      })}
      <button
        type="button"
        aria-pressed={selected === 'expired'}
        onClick={() => onSelect(selected === 'expired' ? null : 'expired')}
        className={cn(
          'rounded-[var(--radius-sm)] px-1 text-sm',
          selected === 'expired' ? 'text-danger-11' : 'text-fg-muted hover:text-fg',
        )}
      >
        <span className="mr-1.5 text-2xs text-expired">Expired</span>
        <span className="num">{money(expired?.valueAtCost)}</span>
      </button>

      <span className="ml-auto truncate text-2xs text-fg-subtle">
        Windows nest and are always at cost — read one card, never the total
      </span>
    </section>
  )
}

function ReconciliationAlarm({ count }: { count: number }) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2.5 rounded-[var(--radius-lg)] border border-danger-9/30 bg-danger-3 px-[var(--card-px)] py-2.5"
    >
      <TriangleAlert size={18} className="mt-px shrink-0 text-danger-9" aria-hidden />
      <div className="min-w-0 text-sm text-danger-11">
        <span className="font-semibold">
          {count.toLocaleString('en-IN')} {count === 1 ? 'batch does' : 'batches do'} not reconcile
          against the stock ledger.
        </span>{' '}
        Stock moved without a movement row, or a movement was written without the stock moving —
        either way the figures above cannot all be true, and the value at cost is the one to stop
        trusting first.
        <span className="mt-1 block font-medium">
          Do not adjust the difference away. An adjustment posted over a reconciliation gap hides
          the cause and keeps the gap.
        </span>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- toolbar ---

interface ActiveChip {
  key: string
  label: string
  value: string
  clear: Partial<FilterState>
}

/** Every applied predicate, spelled out and individually removable. A grid that
 *  is quietly filtered is a grid whose row count nobody trusts. */
function activeChips(f: FilterState): ActiveChip[] {
  const chips: ActiveChip[] = []
  if (f.term.trim()) chips.push({ key: 'term', label: 'Matches', value: `“${f.term.trim()}”`, clear: { term: '' } })
  if (f.bucket !== 'all') chips.push({ key: 'bucket', label: 'Expiry', value: BUCKET_LABEL[f.bucket], clear: { bucket: 'all' } })
  if (f.stock !== 'all') chips.push({ key: 'stock', label: 'Stock', value: STOCK_LABEL[f.stock], clear: { stock: 'all' } })
  if (f.manufacturer) chips.push({ key: 'mfr', label: 'Made by', value: f.manufacturer, clear: { manufacturer: '' } })
  return chips
}

function Toolbar({
  value, view, overview, manufacturers, onView, onOverview, onPatch, onClearAll, searchRef,
}: {
  value: FilterState
  view: ViewKey
  overview: boolean
  manufacturers: string[]
  onView: (v: ViewKey) => void
  onOverview: (v: boolean) => void
  onPatch: (patch: Partial<FilterState>) => void
  onClearAll: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
}) {
  /* The box is local and the URL is debounced behind it: writing a search param
     per keystroke gives Back twenty stops inside one word. The term is written
     with `replace`, so a shared URL is still exact. */
  const [draft, setDraft] = useState(value.term)
  const [lastTerm, setLastTerm] = useState(value.term)
  if (value.term !== lastTerm) {
    setLastTerm(value.term)
    setDraft(value.term)
  }

  useEffect(() => {
    if (draft === value.term) return
    const id = window.setTimeout(() => onPatch({ term: draft }), 120)
    return () => window.clearTimeout(id)
  }, [draft, value.term, onPatch])

  const chips = activeChips(value)

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* The filters govern all four views, which is why the tabs sit in the
            same bar rather than above it: switching reading does not change the
            slice of shelf being read. */}
        <div role="group" aria-label="How to read the shelf" className="flex items-center gap-0.5 rounded-[var(--radius-md)] border border-border bg-subtle p-0.5">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={view === t.key}
              onClick={() => onView(t.key)}
              title={`${t.label} — ${t.hint}`}
              aria-label={t.label}
              className={cn(
                'inline-flex h-[calc(var(--control-h)-8px)] items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-sm',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                view === t.key
                  ? 'bg-surface font-semibold text-fg shadow-xs'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              <t.icon size={15} aria-hidden />
              {/* Below 1536px the filter row and the tabs cannot both have their
                  words. The label goes rather than the filters, because the tabs
                  keep their icon, their tooltip and their accessible name while a
                  truncated manufacturer list keeps none of those. */}
              <span className="hidden 2xl:inline">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="relative min-w-[170px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            ref={searchRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && draft !== '') { e.stopPropagation(); setDraft('') } }}
            type="search"
            aria-label="Search batches by medicine, batch number or manufacturer"
            placeholder="Medicine, batch number or manufacturer…"
            autoComplete="off"
            spellCheck={false}
            className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-10 text-base placeholder:text-fg-subtle hover:border-border-strong"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>
        </div>

        <Select label="Stock" value={value.stock} onChange={(v) => onPatch({ stock: v as StockFilter })}>
          {STOCK_VALUES.map((k) => <option key={k} value={k}>{STOCK_LABEL[k]}</option>)}
        </Select>

        <Select label="Manufacturer" value={value.manufacturer} onChange={(v) => onPatch({ manufacturer: v })}>
          <option value="">Any manufacturer</option>
          {manufacturers.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>

        <Select label="Sort" value={value.sort} onChange={(v) => onPatch({ sort: v as SortKey })}>
          {SORT_VALUES.map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </Select>

        {/* A 1366x768 counter panel has about 640px of usable height. The totals
            are worth their space on a manager's screen and are worth four grid
            rows on the till, so they fold — into the URL, like every other axis
            of this view. */}
        <button
          type="button"
          onClick={() => onOverview(!overview)}
          aria-expanded={overview}
          className="inline-flex h-[var(--control-h)] shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg"
        >
          {overview ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
          {overview ? 'Hide totals' : 'Show totals'}
        </button>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="micro-label">Filtered by</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onPatch(chip.clear)}
              className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-full)] border border-border-subtle bg-surface px-2.5 text-xs text-fg hover:border-border-strong"
            >
              <span className="text-fg-subtle">{chip.label}</span>
              <span className="font-medium">{chip.value}</span>
              <X size={12} aria-hidden className="text-fg-subtle" />
              <span className="sr-only">Remove this filter</span>
            </button>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-[var(--radius-sm)] px-1.5 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Select({
  label, value, onChange, children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-[var(--control-h)] max-w-[150px] appearance-none rounded-[var(--radius-md)] border border-border bg-surface',
          'pl-2.5 pr-7 text-base text-fg hover:border-border-strong',
          value === '' || value === 'all' ? 'text-fg-muted' : 'font-medium',
        )}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-fg-subtle"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  )
}

// ------------------------------------------------------------- batch sheet ---

/**
 * One batch, and its ledger, as a SIDE SHEET rather than a modal.
 *
 * The grid keeps its keyboard focus while this is open, so ↑/↓ still walk the
 * shelf and ↵ swaps what is shown here. Working through twenty near-expiry
 * batches is one pass down the grid, not twenty modal round trips.
 */
function BatchSheet({
  row, movements, movementStatus, movementError, scope, onScopeChange,
  onRetryMovements, onClose, onAdjust, onQuarantine, onLabel,
}: {
  row: BatchRow
  movements: StockMovement[]
  movementStatus: 'ready' | 'loading' | 'error'
  movementError?: string
  scope: MovementScope
  onScopeChange: (s: MovementScope) => void
  onRetryMovements: () => void
  onClose: () => void
  onAdjust: () => void
  onQuarantine: () => void
  onLabel: () => void
}) {
  const b = row.batch
  const m = row.medicine
  const margin = marginPct(row.valueAtMrp, row.valueAtCost)

  return (
    <aside
      role="complementary"
      aria-label={`${m.brandName} batch ${b.batchNo}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="card flex w-[400px] shrink-0 flex-col overflow-hidden xl:w-[460px]"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle px-[var(--card-px)] py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-fg">{m.brandName}</h2>
            <span className="shrink-0 text-sm text-fg-muted">{m.strengthText}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <span className="mono text-fg">{b.batchNo}</span>
            <ExpiryChip bucket={row.bucket} label={formatExpiry(b.expiryDate)} />
            <span>{m.packLabel}</span>
            {b.isQuarantined ? <Chip icon={ShieldOff} tone="var(--status-quarantine)">Quarantined</Chip> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close batch"
          className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      {/* Two dense columns rather than eight stacked rows: at the design floor the
          sheet has ~300px, and every line spent on a fact is a line the ledger —
          the reason this sheet exists — does not get. */}
      <dl className="grid shrink-0 grid-cols-2 gap-x-4 border-b border-border-subtle px-[var(--card-px)] py-2">
        <Fact label="On hand" value={`${formatQty(b.qtyOnHand)} ${m.baseUom}`} strong />
        <Fact
          label="To expiry"
          value={row.daysToExpiry < 0 ? `${-row.daysToExpiry} days ago` : `${row.daysToExpiry} days`}
        />
        <Fact label="Value at cost" value={formatMoney(row.valueAtCost)} strong />
        <Fact
          label="At MRP"
          value={margin === null ? formatMoney(row.valueAtMrp) : `${formatMoney(row.valueAtMrp)} · ${margin}%`}
        />
        <Fact label="MRP / pack" value={formatMoney(b.mrpPerPack)} />
        {/* The one number a cashier must not be able to read off the till, and the
            one a manager cannot decide a return without. */}
        <Fact label="Cost / unit" value={formatMoney(b.landedCostPerUnit)} />
        <Fact
          label="Purchase GST"
          value={`${b.purchaseGstPct}%`}
          title={`${b.purchaseGstPct}% — frozen at receipt, for input tax credit. Not the rate this batch sells at.`}
        />
        <Fact label="Rack" value={m.rackLocation ?? 'Unset'} mono />
      </dl>

      <MovementHistory
        movements={movements}
        status={movementStatus}
        errorMessage={movementError}
        scope={scope}
        onScopeChange={onScopeChange}
        brandName={m.brandName}
        batchNo={b.batchNo}
        expectedBalance={scope === 'batch' ? b.qtyOnHand : null}
        limit={LEDGER_LIMIT}
        onRetry={onRetryMovements}
      />

      <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
        {/* Labels are printed FOR A BATCH, which is why the action lives on the
            batch sheet rather than on a product. The price on a label belongs to
            the batch: a shelf holding two batches at two printed MRPs cannot be
            described by one product-level number. */}
        <Button size="sm" onClick={onLabel}>
          <Tag /> Labels
        </Button>
        <Button size="sm" variant="primary" onClick={onAdjust}>
          Adjust stock <Kbd className="border-transparent bg-white text-accent-11">A</Kbd>
        </Button>
        <Button size="sm" variant={b.isQuarantined ? 'primary' : 'secondary'} onClick={onQuarantine}>
          <ShieldOff /> {b.isQuarantined ? 'Release' : 'Quarantine'}
          <Kbd>Q</Kbd>
        </Button>
        <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </aside>
  )
}

function Fact({
  label, value, mono, strong, title,
}: {
  label: string
  value: string
  mono?: boolean
  strong?: boolean
  title?: string
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 py-[3px]" title={title ?? value}>
      <dt className="shrink-0 text-2xs text-fg-muted">{label}</dt>
      <dd className={cn('min-w-0 truncate text-xs', strong ? 'font-medium text-fg' : 'text-fg-muted', mono && 'mono')}>
        {value}
      </dd>
    </div>
  )
}
