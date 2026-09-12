import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, ScanBarcode } from 'lucide-react'
import type {
  DrugSchedule, Medicine, MedicineFilters as ApiFilters, MedicinePage, MedicineRow,
} from '@contract'
import { ApiError, DRUG_SCHEDULES } from '@contract'
import { useApi } from '@/api'
import { createScannerListener } from '@/lib/scanner'
import type { ScanEvent } from '@/lib/scanner'
import { isTypingTarget } from '@/lib/keys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { DEFAULT_FILTERS, MedicineFilters, isMedicineGap } from './MedicineFilters'
import type { ExpiryFilter, FilterState, SortKey, StockFilter } from './MedicineFilters'
import { MedicineTable } from './MedicineTable'
import type { TableStatus } from './MedicineTable'
import { DETAIL_TABS, MedicineDrawer } from './MedicineDrawer'
import type { DetailTab } from './MedicineDrawer'
import { MedicineForm } from './MedicineForm'
import { BarcodeLinker } from './BarcodeLinker'
import { MedicineQualityStrip } from './MedicineQualityStrip'
import { MedicineBulkBar } from './MedicineBulkBar'

/**
 * The item master.
 *
 * The whole view is in the URL — filters, sort, the open item and which of its
 * panels is showing — so a view is a link. "Send me the H1 items with no stock"
 * is a paste, "look at how fast this one moves" is a paste, the back button
 * walks the filters the operator actually applied, and a reload lands on the
 * same row.
 *
 * The screen owns four things the pieces below it do not: the URL, the scanner,
 * the ticked rows, and every write. Keeping the writes here is what lets a rack
 * edit in the grid, the same edit in the form and a three-hundred-row bulk edit
 * share one invalidation and one undo.
 */

const PAGE_SIZE = 150

const STOCK_VALUES: StockFilter[] = ['all', 'in', 'low', 'out']
const EXPIRY_VALUES: ExpiryFilter[] = ['all', 'expired', 'd30', 'd90', 'd180']
const SORT_VALUES: SortKey[] = ['name', 'stock', 'saleRank', 'value']

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback
}

function readFilters(p: URLSearchParams): FilterState {
  const schedule = DRUG_SCHEDULES.find((s) => s === p.get('sch'))
  const gap = p.get('gap')
  return {
    term: p.get('q') ?? '',
    schedule: (schedule ?? '') as DrugSchedule | '',
    manufacturer: p.get('mfr') ?? '',
    stock: oneOf(p.get('stock'), STOCK_VALUES, 'all'),
    expiry: oneOf(p.get('exp'), EXPIRY_VALUES, 'all'),
    gap: isMedicineGap(gap) ? gap : '',
    onlyInactive: p.get('inactive') === '1',
    sort: oneOf(p.get('sort'), SORT_VALUES, 'name'),
  }
}

function readId(p: URLSearchParams): number | null {
  const raw = p.get('id')
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
}

const readTab = (p: URLSearchParams): DetailTab => oneOf(p.get('tab'), DETAIL_TABS, 'overview')

/** Only non-default axes are written, so a clean view has a clean URL. */
function toParams(f: FilterState, selectedId: number | null, tab: DetailTab): URLSearchParams {
  const p = new URLSearchParams()
  if (f.term.trim()) p.set('q', f.term.trim())
  if (f.schedule) p.set('sch', f.schedule)
  if (f.manufacturer) p.set('mfr', f.manufacturer)
  if (f.stock !== 'all') p.set('stock', f.stock)
  if (f.expiry !== 'all') p.set('exp', f.expiry)
  if (f.gap) p.set('gap', f.gap)
  if (f.onlyInactive) p.set('inactive', '1')
  if (f.sort !== 'name') p.set('sort', f.sort)
  if (selectedId !== null) p.set('id', String(selectedId))
  // A panel with nothing open behind it is not a view; the key would survive
  // every filter change as a dangling parameter nobody could clear.
  if (selectedId !== null && tab !== 'overview') p.set('tab', tab)
  return p
}

function toApiFilters(f: FilterState): ApiFilters {
  return {
    ...(f.term.trim() ? { term: f.term.trim() } : {}),
    ...(f.schedule ? { schedule: f.schedule } : {}),
    ...(f.manufacturer ? { manufacturer: f.manufacturer } : {}),
    stock: f.stock,
    expiry: f.expiry,
    ...(f.gap ? { gap: f.gap } : {}),
    ...(f.onlyInactive ? { onlyInactive: true } : {}),
    sort: f.sort,
  }
}

function isFiltered(f: FilterState): boolean {
  return f.term.trim() !== '' || f.schedule !== '' || f.manufacturer !== ''
    || f.stock !== 'all' || f.expiry !== 'all' || f.gap !== '' || f.onlyInactive
}

/** Phase 5 gates the master behind a real permission; the code is the contract. */
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const EMPTY_ROWS: MedicineRow[] = []
const EMPTY_MANUFACTURERS: string[] = []
const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>()

// ------------------------------------------------------------ bulk writes ---

/**
 * A bulk edit, carrying the value for EVERY row rather than one value for all
 * of them.
 *
 * That shape is what makes undo real: putting three hundred racks back is the
 * same job with the previous values in it, not a second concept. It also means
 * a partial failure leaves a job that describes exactly what did land.
 */
type BulkKind = 'rack' | 'reorder' | 'active'

interface BulkEntry {
  id: number
  rack?: string
  reorderLevel?: number
  active?: boolean
}

interface BulkJob {
  kind: BulkKind
  entries: BulkEntry[]
  /** What puts it back. Null on an undo, so the toast does not loop forever. */
  undo: BulkJob | null
}

interface BulkOutcome {
  ok: number
  failed: Array<{ id: number; message: string }>
}

export function MedicinesScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const today = useMemo(() => new Date(), [])

  const filters = useMemo(() => readFilters(params), [params])
  const selectedId = readId(params)
  const tab = readTab(params)

  const [activeIndex, setActiveIndex] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Medicine | null>(null)
  const [linkerOpen, setLinkerOpen] = useState(false)
  const [linkerTarget, setLinkerTarget] = useState<Medicine | null>(null)
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<number>>(EMPTY_SELECTION)

  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const overlayOpen = formOpen || linkerOpen

  // ------------------------------------------------------------- the list ---

  const list = useInfiniteQuery({
    queryKey: ['medicines', 'list', filters],
    queryFn: ({ pageParam }) =>
      api.listMedicines({
        ...toApiFilters(filters),
        limit: PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: MedicinePage) => last.nextCursor,
    /* The previous view's rows stay on screen while the next resolves. Dropping
       to a skeleton on every keystroke is what makes a fast grid feel slow. */
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(
    () => list.data?.pages.flatMap((p) => p.rows) ?? EMPTY_ROWS,
    [list.data],
  )
  const first = list.data?.pages.at(0)
  const total = first?.total ?? 0
  const manufacturers = first?.manufacturers ?? EMPTY_MANUFACTURERS
  const quality = first?.quality ?? null
  const catalogueSize = quality === null ? null : quality.active + quality.inactive

  const onNeedMore = useCallback(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage()
  }, [list])

  // -------------------------------------------------------- URL as the view ---

  const patch = useCallback(
    (next: Partial<FilterState>) => {
      /* A term-only change REPLACES: debounced or not, one word must not leave
         twenty stops in the history. Every other axis is a deliberate act and
         pushes, so Back walks the filters the operator actually applied. */
      const termOnly = Object.keys(next).length === 1 && 'term' in next
      setParams(
        (prev) => {
          const merged = { ...readFilters(prev), ...next }
          return toParams(merged, readId(prev), readTab(prev))
        },
        { replace: termOnly },
      )
    },
    [setParams],
  )

  /* Opening an item REPLACES rather than pushes. The id is in the URL so the row
     is still shareable and survives a reload, but arrowing down a shelf must not
     leave forty stops in the history — Esc closes the sheet, Back walks the
     filters. */
  const select = useCallback(
    (id: number | null, nextTab?: DetailTab) => {
      setParams(
        (prev) => toParams(readFilters(prev), id, nextTab ?? readTab(prev)),
        { replace: true },
      )
    },
    [setParams],
  )

  /**
   * Put one item in front of the operator, whatever view they were in.
   *
   * A barcode resolves to an item that is very often filtered OUT of the current
   * view — delisted, out of stock, a different manufacturer. Opening the drawer
   * on a row the grid is not showing is a dead end, so the view is reset to that
   * item's name and the row is selected inside it.
   */
  const reveal = useCallback(
    (m: Medicine) => {
      setParams(toParams({ ...DEFAULT_FILTERS, term: m.brandName, sort: filters.sort }, m.id, 'overview'))
      setActiveIndex(0)
    },
    [setParams, filters.sort],
  )

  /* Filters changed → the highlight goes back to the top and the ticks are
     dropped, adjusted during render so the grid never paints one frame pointing
     at the wrong row. The ticks go because a bulk edit is only ever offered over
     rows somebody has actually looked at, and a new predicate has shown them a
     different set. */
  const filterKey = JSON.stringify(filters)
  const [lastFilterKey, setLastFilterKey] = useState(filterKey)
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey)
    setActiveIndex(0)
    setTicked(EMPTY_SELECTION)
  }

  const loadedIndex = rows.findIndex((r) => r.medicine.id === selectedId)

  /* Following the URL, not the click: a deep link, a Back, and a barcode reveal
     all have to land the highlight on the opened row. */
  const [lastSelected, setLastSelected] = useState(selectedId)
  if (selectedId !== lastSelected) {
    setLastSelected(selectedId)
    if (loadedIndex >= 0) setActiveIndex(loadedIndex)
  }

  /* The one case the page cannot answer from `rows`: an id that is real but not
     in the loaded window yet. Two calls, only on that path. */
  const orphan = useQuery({
    queryKey: ['medicines', 'row', selectedId],
    queryFn: async (): Promise<MedicineRow | null> => {
      const found = await api.getMedicines([selectedId ?? 0])
      const m = found.at(0)
      if (!m) return null
      /* Narrowed by the maker and pointed at the right side of the active/
         delisted split: the two views never mix, so a row delisted from this
         very drawer is invisible to the default query and the sheet would close
         under the operator the moment they pressed the button. */
      const page = await api.listMedicines({
        term: m.brandName,
        manufacturer: m.manufacturer,
        limit: 50,
        ...(m.isActive ? {} : { onlyInactive: true }),
      })
      return page.rows.find((r) => r.medicine.id === m.id) ?? null
    },
    enabled: selectedId !== null && loadedIndex < 0,
  })

  const drawerRow = loadedIndex >= 0 ? rows[loadedIndex] ?? null : orphan.data ?? null

  // --------------------------------------------------------------- writes ---

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['medicines'] })
    /* The POS reads the same catalogue through a different key. A rename or a
       new barcode that only lands here is a bug somebody hits at the counter. */
    void qc.invalidateQueries({ queryKey: ['search'] })
    void qc.invalidateQueries({ queryKey: ['barcode'] })
    void qc.invalidateQueries({ queryKey: ['substitutes'] })
  }, [qc])

  const setRack = useMutation({
    mutationFn: (v: { id: number; rack: string }) =>
      api.updateMedicine(v.id, { rackLocation: v.rack }),
    onSuccess: (m, v) => {
      invalidate()
      const previous = rows.find((r) => r.medicine.id === v.id)?.medicine.rackLocation ?? ''
      toast.success(m.rackLocation ? `${m.brandName} → ${m.rackLocation}` : `${m.brandName} rack cleared`, {
        description: 'Rack is per-store metadata; no document references it.',
        action: {
          label: 'Undo',
          onClick: () => setRack.mutate({ id: v.id, rack: previous }),
        },
      })
    },
    onError: (err) => toast.error('Could not set the rack', { description: (err as Error).message }),
  })

  const toggleActive = useMutation({
    mutationFn: (v: { id: number; next: boolean }) => api.setMedicineActive(v.id, v.next),
    onSuccess: (m) => {
      invalidate()
      toast.success(m.isActive ? `${m.brandName} is back in search` : `${m.brandName} delisted`, {
        description: m.isActive
          ? undefined
          : 'It disappears from billing search. Every bill it already appears on is untouched.',
      })
    },
    onError: (err) => toast.error('Could not change the status', { description: (err as Error).message }),
  })

  /**
   * One row at a time, in order, and never in parallel.
   *
   * Every write re-validates the whole medicine and re-runs the duplicate check
   * against the catalogue, so the writes are not independent of each other:
   * firing three hundred at once would race that check against itself. Sequential
   * is also what lets a failure be reported per row instead of collapsing the
   * whole batch — a bad HSN on one item must not stop the other 299 racks
   * being set.
   */
  const bulk = useMutation({
    mutationFn: async (job: BulkJob): Promise<BulkOutcome> => {
      const failed: BulkOutcome['failed'] = []
      let ok = 0
      for (const e of job.entries) {
        try {
          if (job.kind === 'rack') await api.updateMedicine(e.id, { rackLocation: e.rack ?? '' })
          else if (job.kind === 'reorder') await api.updateMedicine(e.id, { reorderLevel: e.reorderLevel ?? 0 })
          else await api.setMedicineActive(e.id, e.active === true)
          ok++
        } catch (err) {
          failed.push({ id: e.id, message: (err as Error).message })
        }
      }
      return { ok, failed }
    },
    onSuccess: (outcome, job) => {
      invalidate()
      // Delisting takes rows out of the view they were ticked in, so holding the
      // ticks would leave a bar counting rows that are no longer on screen.
      if (job.kind === 'active') setTicked(EMPTY_SELECTION)

      if (outcome.ok > 0) {
        toast.success(bulkTitle(job, outcome.ok), {
          description: BULK_NOTE[job.kind],
          ...(job.undo === null ? {} : {
            action: { label: 'Undo', onClick: () => bulk.mutate({ ...(job.undo as BulkJob) }) },
          }),
        })
      }
      if (outcome.failed.length > 0) {
        const first = outcome.failed[0]
        toast.error(`${outcome.failed.length} item${outcome.failed.length === 1 ? '' : 's'} could not be changed`, {
          description: first ? `${nameOf(rows, first.id)}: ${first.message}` : undefined,
        })
      }
    },
    onError: (err) => toast.error('The bulk edit did not run', { description: (err as Error).message }),
  })

  const unlink = useMutation({
    mutationFn: (code: string) => api.unlinkBarcode(code),
    onSuccess: (_r, code) => {
      invalidate()
      toast.success('Barcode unlinked', { description: code })
    },
    onError: (err) => toast.error('Could not unlink the code', { description: (err as Error).message }),
  })

  const linkAfterCreate = useMutation({
    mutationFn: (v: { id: number; code: string }) => api.linkBarcode(v.id, v.code, 'EAN-13'),
    onSuccess: (_r, v) => {
      invalidate()
      toast.success('Barcode linked', { description: v.code })
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : undefined
      toast.error('The item was created, but the code was not linked', {
        description: code ? `${(err as Error).message} (${code})` : (err as Error).message,
      })
    },
  })

  const tickedRows = useMemo(
    () => rows.filter((r) => ticked.has(r.medicine.id)),
    [rows, ticked],
  )

  const runBulk = useCallback(
    (kind: BulkKind, valueOf: (row: MedicineRow) => BulkEntry, undoOf: (row: MedicineRow) => BulkEntry) => {
      if (tickedRows.length === 0) return
      bulk.mutate({
        kind,
        entries: tickedRows.map(valueOf),
        undo: { kind, entries: tickedRows.map(undoOf), undo: null },
      })
    },
    [bulk, tickedRows],
  )

  // ------------------------------------------------------------- keyboard ---

  const openCreate = useCallback(() => {
    setEditing(null)
    setFormOpen(true)
  }, [])

  const openBarcode = useCallback((target: Medicine | null, code: string | null) => {
    setLinkerTarget(target)
    setPendingCode(code)
    setLinkerOpen(true)
  }, [])

  const resolveBarcode = useCallback(
    async (code: string) => {
      const hit = await api.lookupBarcode(code).catch(() => null)
      if (hit) {
        reveal(hit.medicine)
        return
      }
      // The digits are never lost. This is the moment the pack is in the
      // operator's hand and linking it costs nothing.
      openBarcode(null, code)
    },
    [api, reveal, openBarcode],
  )

  /* Held in a ref so the listener is attached once per mount rather than
     re-attached on every render that changes a handler. */
  const scanRef = useRef<(e: ScanEvent) => void>(() => {})
  useEffect(() => {
    scanRef.current = (e: ScanEvent) => {
      /* A fast typist hitting Enter looks like a scan to a timing heuristic; only
         the AIM prefix and the payload shape are facts. Anything unclassified is
         left to the search box. */
      if (e.kind === 'unknown') return
      void resolveBarcode(e.parsed?.gtin ?? e.raw)
    }
  })

  useEffect(() => {
    // The linker owns the wedge while it is open — it has its own listener.
    if (overlayOpen) return
    const listener = createScannerListener({ onScan: (e) => scanRef.current(e) })
    const handler = (ev: KeyboardEvent) => listener.handleKeyDown(ev)
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [overlayOpen])

  /* '/' and 'n' are screen-local, so they are bound here rather than added to
     lib/keys: SHORTCUTS is the app-wide contract and a grid that only exists on
     one route has no business claiming a global key. `isTypingTarget` is the same
     suppression rule the shortcut layer applies. */
  useEffect(() => {
    if (overlayOpen) return
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
  }, [overlayOpen, openCreate])

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

  const filtered = isFiltered(filters)

  return (
    <div className="flex h-full flex-col">
      {/* One block, not two bands: the title says what this is, the figure the
          screen exists to show sits opposite it with the two things that add to
          it, and the strip beneath says what is wrong with the master. The strip
          takes the full width rather than sharing the title's column — at the
          1366px floor four counted pills do not fit beside a hero. */}
      <header className="page-header shrink-0 px-[var(--page-px)] pb-2.5 pt-3">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">Medicines</h1>
            <p className="mt-0.5 truncate text-sm text-fg-muted">
              The item master — brand, salt, pack, HSN, schedule and the codes the counter scans.
            </p>
          </div>

          <div className="flex shrink-0 items-start gap-6">
            <div className="pt-0.5 text-right">
              <div className="flex items-baseline justify-end gap-1.5">
                <span className="display-num text-4xl text-fg" data-testid="medicine-count">
                  {status === 'ready' ? total.toLocaleString('en-IN') : '—'}
                </span>
                {filtered && catalogueSize !== null ? (
                  <span className="text-sm text-fg-muted">of {catalogueSize.toLocaleString('en-IN')}</span>
                ) : null}
              </div>
              <div className="micro-label">{filtered ? 'items in this view' : 'items in the catalogue'}</div>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={() => openBarcode(null, null)}>
                <ScanBarcode /> Scan a code
              </Button>
              <Button variant="primary" onClick={openCreate}>
                <Plus /> New medicine
                <Kbd className="border-transparent bg-white text-accent-11">N</Kbd>
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-2">
          <MedicineQualityStrip
            quality={quality}
            active={filters.gap}
            onPick={(gap) => patch({ gap })}
          />
        </div>
      </header>

      <MedicineFilters
        value={filters}
        manufacturers={manufacturers}
        onPatch={patch}
        onResolveBarcode={(code) => void resolveBarcode(code)}
        searchRef={searchRef}
      />

      <div className="flex min-h-0 flex-1 gap-[var(--card-gap)] px-[var(--page-px)] pb-[var(--card-px)]">
        {/* The grid keeps its own density. Everything around it breathes; the
            catalogue itself is read by scanning, and rows are what it trades in. */}
        <div data-density="compact" className="card flex min-w-0 flex-1 flex-col overflow-hidden">
          {ticked.size > 0 ? (
            <MedicineBulkBar
              rows={rows}
              selectedIds={ticked}
              busy={bulk.isPending}
              onClear={() => setTicked(EMPTY_SELECTION)}
              onSetRack={(rack) => runBulk(
                'rack',
                (r) => ({ id: r.medicine.id, rack }),
                (r) => ({ id: r.medicine.id, rack: r.medicine.rackLocation ?? '' }),
              )}
              onSetReorder={(level) => runBulk(
                'reorder',
                (r) => ({ id: r.medicine.id, reorderLevel: level }),
                (r) => ({ id: r.medicine.id, reorderLevel: r.medicine.reorderLevel }),
              )}
              onSetActive={(next) => {
                // Only the rows the button is offering to change: "Delist 12" over
                // a selection that already holds four delisted rows must write 12.
                const targets = tickedRows.filter((r) => r.medicine.isActive !== next)
                if (targets.length === 0) return
                bulk.mutate({
                  kind: 'active',
                  entries: targets.map((r) => ({ id: r.medicine.id, active: next })),
                  undo: { kind: 'active', entries: targets.map((r) => ({ id: r.medicine.id, active: !next })), undo: null },
                })
              }}
            />
          ) : null}

          <MedicineTable
            rows={rows}
            total={total}
            status={status}
            errorMessage={error ? (error as Error).message : undefined}
            errorCode={error instanceof ApiError ? error.code : 'MEDICINES_FAILED'}
            narrow={drawerRow !== null}
            today={today}
            activeIndex={activeIndex}
            selectedId={selectedId}
            sort={filters.sort}
            filtered={filtered}
            fetchingMore={list.isFetchingNextPage}
            selectedIds={ticked}
            onSelectionChange={setTicked}
            onActiveIndexChange={setActiveIndex}
            onOpen={(row) => select(row.medicine.id)}
            onEscape={() => {
              if (ticked.size > 0) setTicked(EMPTY_SELECTION)
              else if (selectedId !== null) select(null)
              else if (filtered) patch({ ...DEFAULT_FILTERS, sort: filters.sort })
            }}
            onSortChange={(sort) => patch({ sort })}
            onRackSave={(id, rack) => setRack.mutate({ id, rack })}
            onNeedMore={onNeedMore}
            onRetry={() => void list.refetch()}
            onClearFilters={() => patch({ ...DEFAULT_FILTERS, sort: filters.sort })}
            onCreate={openCreate}
            onGoToPurchases={() => navigate('/purchases')}
            bodyRef={bodyRef}
          />
        </div>

        {drawerRow ? (
          <MedicineDrawer
            key={drawerRow.medicine.id}
            row={drawerRow}
            today={today}
            tab={tab}
            onTabChange={(next) => select(drawerRow.medicine.id, next)}
            onClose={() => {
              select(null, 'overview')
              bodyRef.current?.focus()
            }}
            onEdit={() => {
              setEditing(drawerRow.medicine)
              setFormOpen(true)
            }}
            onLinkBarcode={() => openBarcode(drawerRow.medicine, null)}
            onUnlinkBarcode={(barcode) => unlink.mutate(barcode)}
            onToggleActive={() => toggleActive.mutate({ id: drawerRow.medicine.id, next: !drawerRow.medicine.isActive })}
            /* A substitute opens on its own overview, not on the panel that was
               showing: the question that led here has been answered. */
            onOpenMedicine={(id) => select(id, 'overview')}
            busy={toggleActive.isPending}
          />
        ) : null}
      </div>

      <MedicineForm
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v)
          if (!v) setPendingCode(null)
        }}
        editing={editing}
        initialBarcode={editing === null ? pendingCode : null}
        onSaved={(m, created) => {
          invalidate()
          if (created && pendingCode) linkAfterCreate.mutate({ id: m.id, code: pendingCode })
          setPendingCode(null)
          toast.success(created ? `${m.brandName} created` : `${m.brandName} saved`, {
            description: `${m.packLabel} · ${m.unitsPerPack} ${m.baseUom} per pack · HSN ${m.hsnCode}`,
          })
          if (created) reveal(m)
          else select(m.id)
        }}
        onOpenExisting={(id) => select(id)}
        onSearchFor={(term) => patch({ ...DEFAULT_FILTERS, term, sort: filters.sort })}
      />

      <BarcodeLinker
        open={linkerOpen}
        onOpenChange={(v) => {
          setLinkerOpen(v)
          if (!v) setPendingCode(null)
        }}
        target={linkerTarget}
        initialCode={pendingCode}
        onLinked={(m, code) => {
          invalidate()
          toast.success(`${code} → ${m.brandName}`, { description: 'The counter can scan this pack now.' })
          reveal(m)
        }}
        onOpenMedicine={(id) => select(id)}
        onCreateNew={(code) => {
          /* Closed here rather than by the linker: `onOpenChange` forgets the
             pending code, and batching that behind this handoff would drop the
             digits the linker exists to keep. */
          setLinkerOpen(false)
          setEditing(null)
          setPendingCode(code)
          setFormOpen(true)
        }}
      />
    </div>
  )
}

const BULK_NOTE: Record<BulkKind, string> = {
  rack: 'Rack is per-store metadata; no document references it.',
  reorder: 'The reorder level only drives the purchase suggestion. Nothing already priced changes.',
  active: 'Billing search only. Every bill these already appear on is untouched.',
}

function bulkTitle(job: BulkJob, ok: number): string {
  const noun = `item${ok === 1 ? '' : 's'}`
  if (job.kind === 'rack') {
    const rack = job.entries[0]?.rack ?? ''
    const uniform = job.entries.every((e) => (e.rack ?? '') === rack)
    if (uniform && rack === '') return `Rack cleared on ${ok} ${noun}`
    if (uniform) return `${ok} ${noun} → ${rack}`
    return `Rack restored on ${ok} ${noun}`
  }
  if (job.kind === 'reorder') {
    const level = job.entries[0]?.reorderLevel
    const uniform = job.entries.every((e) => e.reorderLevel === level)
    return uniform
      ? `Reorder level set to ${level} on ${ok} ${noun}`
      : `Reorder level restored on ${ok} ${noun}`
  }
  return job.entries[0]?.active === true ? `${ok} ${noun} relisted` : `${ok} ${noun} delisted`
}

function nameOf(rows: MedicineRow[], id: number): string {
  return rows.find((r) => r.medicine.id === id)?.medicine.brandName ?? `#${id}`
}
