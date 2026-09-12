import { useEffect, useState } from 'react'
import {
  Ban, CalendarClock, CircleSlash, ListFilter, MoonStar, PackageMinus, PowerOff,
  ScanBarcode, Search, ShieldAlert, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { DrugSchedule, MedicineGap } from '@contract'
import { DRUG_SCHEDULES, MEDICINE_GAPS } from '@contract'
import { cn } from '@/lib/cn'
import { Kbd } from '@/components/ui/Kbd'

/**
 * The filter bar, and the reason this screen is ONE grid rather than ten reports.
 *
 * Marg ships Current Stock, Filtered Stock, Batch Stock, Dump Stock, Minimum
 * Level, Maximum Level, Expiry Stock, Near Expiry, Stock Ageing and Fast/Slow
 * Moving as ten separate screens — ten menu traversals to ask ten questions of
 * one table. Every one of those questions is a predicate over this grid, so they
 * are chips here instead, and the answer arrives without a navigation.
 *
 * Every preset maps EXACTLY onto a field of the contract's `MedicineFilters`.
 * Nothing here filters client-side over a loaded page: a chip that silently
 * refines only the rows that happen to be in memory tells the operator "none"
 * when the answer is "not yet".
 */

export type StockFilter = 'all' | 'in' | 'low' | 'out'
export type ExpiryFilter = 'all' | 'expired' | 'd30' | 'd90' | 'd180'
export type SortKey = 'name' | 'stock' | 'saleRank' | 'value'

export interface FilterState {
  term: string
  /** '' is "any schedule" — the contract's field is simply absent. */
  schedule: DrugSchedule | ''
  manufacturer: string
  stock: StockFilter
  expiry: ExpiryFilter
  /** '' is "no data-quality predicate". */
  gap: MedicineGap | ''
  onlyInactive: boolean
  sort: SortKey
}

export const DEFAULT_FILTERS: FilterState = {
  term: '',
  schedule: '',
  manufacturer: '',
  stock: 'all',
  expiry: 'all',
  gap: '',
  onlyInactive: false,
  sort: 'name',
}

/** The axes a saved view owns. Term, manufacturer and sort survive a view switch
 *  because they are refinements OF a view, not part of its identity. */
type ViewAxes = Pick<FilterState, 'schedule' | 'stock' | 'expiry' | 'gap' | 'onlyInactive'>

interface Preset {
  id: string
  label: string
  icon: LucideIcon
  tone?: string
  axes: ViewAxes
}

const ALL_AXES: ViewAxes = { schedule: '', stock: 'all', expiry: 'all', gap: '', onlyInactive: false }

const PRESETS: Preset[] = [
  { id: 'all', label: 'All items', icon: ListFilter, axes: ALL_AXES },
  { id: 'low', label: 'Low stock', icon: PackageMinus, tone: 'var(--status-low-stock)', axes: { ...ALL_AXES, stock: 'low' } },
  { id: 'out', label: 'Out of stock', icon: CircleSlash, tone: 'var(--status-out-of-stock)', axes: { ...ALL_AXES, stock: 'out' } },
  /* 90 days, not 30: a distributor's saleable-return window closes months before
     the printed date, so 30 days is already too late to send it back. */
  { id: 'exp90', label: 'Expiring ≤90d', icon: CalendarClock, tone: 'var(--status-expiry-90)', axes: { ...ALL_AXES, expiry: 'd90' } },
  { id: 'expired', label: 'Expired', icon: Ban, tone: 'var(--status-expired)', axes: { ...ALL_AXES, expiry: 'expired' } },
  { id: 'h1', label: 'Schedule H1', icon: ShieldAlert, tone: 'var(--schedule-h1)', axes: { ...ALL_AXES, schedule: 'H1' } },
  /* Not a data-quality gap but the same shape of question, and the one view an
     owner asks for by name: stock that has never once left the shelf. */
  { id: 'never', label: 'Never sold', icon: MoonStar, tone: 'var(--status-expiry-180)', axes: { ...ALL_AXES, gap: 'neverSold' } },
  { id: 'inactive', label: 'Delisted', icon: PowerOff, axes: { ...ALL_AXES, onlyInactive: true } },
]

const STOCK_LABEL: Record<StockFilter, string> = {
  all: 'Any stock', in: 'In stock', low: 'At or below reorder', out: 'Out of stock',
}

const EXPIRY_LABEL: Record<ExpiryFilter, string> = {
  all: 'Any expiry', expired: 'Expired', d30: 'Expiring ≤30d', d90: 'Expiring ≤90d', d180: 'Expiring ≤180d',
}

const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name (A–Z)', stock: 'Stock (low first)', saleRank: 'Fastest moving', value: 'Stock value',
}

const GAP_LABEL: Record<MedicineGap, string> = {
  hsn: 'No HSN',
  barcode: 'No barcode',
  reorder: 'No reorder level',
  rack: 'No rack',
  neverSold: 'Never sold',
}

/** A GTIN is 8, 12, 13 or 14 digits. Anything else typed as digits is a search. */
const GTIN_RE = /^\d{8}$|^\d{12,14}$/

export function isMedicineGap(raw: string | null): raw is MedicineGap {
  return MEDICINE_GAPS.some((g) => g === raw)
}

function matchesPreset(f: FilterState, p: Preset): boolean {
  return f.schedule === p.axes.schedule
    && f.stock === p.axes.stock
    && f.expiry === p.axes.expiry
    && f.gap === p.axes.gap
    && f.onlyInactive === p.axes.onlyInactive
}

export function MedicineFilters({
  value,
  manufacturers,
  onPatch,
  onResolveBarcode,
  searchRef,
}: {
  value: FilterState
  manufacturers: string[]
  onPatch: (patch: Partial<FilterState>) => void
  /** Enter on a GTIN-shaped term resolves it instead of searching for it. */
  onResolveBarcode: (code: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
}) {
  /* The box is local and the URL is debounced behind it. Writing a search param
     per keystroke would give the back button twenty stops inside one word — and
     the term is written with `replace`, so the shared URL is still exact. */
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

  const trimmed = draft.trim()
  const isBarcode = GTIN_RE.test(trimmed)
  const active = activeChips(value)

  return (
    <div className="flex flex-col gap-2 px-[var(--page-px)] pb-2.5 pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[280px] flex-1">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            ref={searchRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isBarcode) {
                e.preventDefault()
                onResolveBarcode(trimmed)
              } else if (e.key === 'Escape' && draft !== '') {
                e.stopPropagation()
                setDraft('')
              }
            }}
            type="search"
            aria-label="Search medicines by brand, salt, manufacturer or barcode"
            placeholder="Brand, salt, manufacturer or a scanned barcode…"
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'h-[var(--control-h)] w-full rounded-[var(--radius-lg)] border border-border bg-surface',
              'pl-11 pr-28 text-base shadow-xs placeholder:text-fg-subtle',
              'transition-colors duration-[var(--dur-fast)] hover:border-border-strong',
            )}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {isBarcode ? (
              <span className="flex items-center gap-1 rounded-[var(--radius-sm)] bg-accent-3 px-1.5 py-0.5 text-2xs font-medium text-accent-11">
                <ScanBarcode size={12} aria-hidden /> Barcode <Kbd className="border-accent-6/50 bg-white/60">↵</Kbd>
              </span>
            ) : (
              <Kbd>/</Kbd>
            )}
          </span>
        </div>

        <Select label="Schedule" value={value.schedule} onChange={(v) => onPatch({ schedule: v as DrugSchedule | '' })}>
          <option value="">Any schedule</option>
          {DRUG_SCHEDULES.map((s) => <option key={s} value={s}>{s === 'OTC' ? 'OTC · not scheduled' : `Schedule ${s}`}</option>)}
        </Select>

        <Select label="Manufacturer" value={value.manufacturer} onChange={(v) => onPatch({ manufacturer: v })}>
          <option value="">Any manufacturer</option>
          {manufacturers.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>

        <Select label="Stock" value={value.stock} onChange={(v) => onPatch({ stock: v as StockFilter })}>
          {(Object.keys(STOCK_LABEL) as StockFilter[]).map((k) => <option key={k} value={k}>{STOCK_LABEL[k]}</option>)}
        </Select>

        <Select label="Expiry" value={value.expiry} onChange={(v) => onPatch({ expiry: v as ExpiryFilter })}>
          {(Object.keys(EXPIRY_LABEL) as ExpiryFilter[]).map((k) => <option key={k} value={k}>{EXPIRY_LABEL[k]}</option>)}
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="micro-label mr-0.5">Views</span>
        {PRESETS.map((p) => {
          const on = matchesPreset(value, p)
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPatch(p.axes)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-full)] border px-2.5 text-xs',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                on
                  ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                  : 'border-border bg-surface text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <p.icon size={14} aria-hidden style={on ? undefined : { color: p.tone ?? 'var(--fg-subtle)' }} />
              {p.label}
            </button>
          )
        })}

        {active.length > 0 && (
          <>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            {active.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => onPatch(chip.clear)}
                className={cn(
                  'inline-flex h-8 items-center gap-1 rounded-[var(--radius-full)] border border-border-subtle',
                  'bg-subtle px-2.5 text-xs text-fg hover:border-border-strong',
                )}
              >
                <span className="text-fg-subtle">{chip.label}</span>
                <span className="font-medium">{chip.value}</span>
                <X size={13} aria-hidden className="text-fg-subtle" />
                <span className="sr-only">Remove this filter</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => onPatch({ ...DEFAULT_FILTERS, sort: value.sort })}
              className="ml-0.5 rounded-[var(--radius-sm)] px-1.5 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Clear all
            </button>
          </>
        )}

        {/* Sort orders the view; it does not narrow it. It sits with the views
            rather than with the predicates for that reason. */}
        <Select label="Sort" value={value.sort} onChange={(v) => onPatch({ sort: v as SortKey })} trailing>
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </Select>
      </div>
    </div>
  )
}

interface Chip {
  key: string
  label: string
  value: string
  clear: Partial<FilterState>
}

/** Every applied predicate, spelled out and individually removable. A grid that
 *  is quietly filtered is a grid whose row count nobody trusts. */
function activeChips(f: FilterState): Chip[] {
  const chips: Chip[] = []
  if (f.term.trim()) chips.push({ key: 'term', label: 'Matches', value: `“${f.term.trim()}”`, clear: { term: '' } })
  if (f.schedule) chips.push({ key: 'schedule', label: 'Schedule', value: f.schedule, clear: { schedule: '' } })
  if (f.manufacturer) chips.push({ key: 'mfr', label: 'Made by', value: f.manufacturer, clear: { manufacturer: '' } })
  if (f.stock !== 'all') chips.push({ key: 'stock', label: 'Stock', value: STOCK_LABEL[f.stock], clear: { stock: 'all' } })
  if (f.expiry !== 'all') chips.push({ key: 'expiry', label: 'Expiry', value: EXPIRY_LABEL[f.expiry], clear: { expiry: 'all' } })
  if (f.gap) chips.push({ key: 'gap', label: 'Missing', value: GAP_LABEL[f.gap], clear: { gap: '' } })
  if (f.onlyInactive) chips.push({ key: 'inactive', label: 'Showing', value: 'Delisted only', clear: { onlyInactive: false } })
  return chips
}

function Select({
  label, value, onChange, trailing, children,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  /** Pinned to the end of its row, at the size of the chips beside it. */
  trailing?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={cn('relative shrink-0', trailing && 'ml-auto')}>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-[var(--control-h)] max-w-[176px] appearance-none rounded-[var(--radius-lg)] border border-border bg-surface',
          'pl-3 pr-8 text-base text-fg shadow-xs transition-colors duration-[var(--dur-fast)] hover:border-border-strong',
          value === '' || value === 'all' ? 'text-fg-muted' : 'font-medium',
          trailing && 'h-8 rounded-[var(--radius-full)] pl-3 pr-7 text-xs',
        )}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className={cn(
          'pointer-events-none absolute top-1/2 size-3 -translate-y-1/2 text-fg-subtle',
          trailing ? 'right-2.5' : 'right-3',
        )}
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  )
}
