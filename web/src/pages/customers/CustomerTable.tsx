import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlarmClock, CalendarDays, Moon, Repeat, ScanBarcode, ShieldAlert, Stethoscope, Users, UserSearch,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CustomerRow, Receivable } from '@/api/customers'
import { receivableNote } from '@/api/customers'
import { cn } from '@/lib/cn'
import * as D from '@/domain/decimal'
import { formatAmount, formatMoney } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Chip } from '@/components/ui/Badge'
import { Kbd } from '@/components/ui/Kbd'
import { EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows } from '@/components/states'
import type { CareBook } from './careFile'
import { careOf } from './careFile'
import type { PurchaseProfile, Segment } from './profile'
import { SEGMENT_LABEL, SEGMENT_MEANING } from './profile'

/**
 * The customer book, as a grid.
 *
 * Every cell here is already on the row the screen assembled, so no cell can
 * need a second call — the same rule the catalogue grid follows, and the reason
 * arrowing down the list costs nothing.
 *
 * The columns that carry judgement are the last ones you would expect to argue
 * about. Credit shows the LIMIT with the usage under it rather than a bare
 * percentage, because "₹5,000, 74% used" is a decision and "74%" is trivia. The
 * ageing cell is never allowed to render an empty bar in silence: a balance the
 * loaded bills cannot explain says so in words, because a row that goes quiet
 * about money owed is how a shop stops chasing it. And CARE leads the money
 * columns rather than trailing them — an allergy is the only thing on this
 * screen that can hurt somebody.
 */

/**
 * Taller than `--row-h` at compact density, deliberately: four of these cells
 * stack a value over a second line, and the credit and ageing meters need a bar
 * under theirs. The variable is re-declared on the grid root so the skeleton
 * rows measure the same and nothing shifts when the data lands.
 */
const ROW_H = 46

export type TableStatus = 'ready' | 'loading' | 'error' | 'offline' | 'denied'

/** Whether the bill window that the ageing is derived from has arrived. */
export type BillStatus = 'ready' | 'loading' | 'error'

export function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

/** Same date, spelled for a document rather than for a column. */
export function formatLongDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * The stacked receivable, shared by the rows, the sheet and the header bar.
 *
 * Widths are geometry, not money: the amounts stay decimal strings and only the
 * ratio is ever taken to a float, because a pixel does not need paise. Nothing
 * outstanding draws a flat rule rather than an empty box — an empty bar reads as
 * missing data, which is a different and more alarming thing.
 */
export function AgeingBar({
  receivable,
  className,
  described = true,
}: {
  receivable: Receivable
  className?: string
  /**
   * False inside a list row. The bar there sits within a button whose accessible
   * name is already the customer, and folding four amounts into it would make
   * every row announce a paragraph; the row's own text line carries the meaning.
   */
  described?: boolean
}) {
  const total = D.dec(receivable.onBills)
  const segments = D.gt(total, D.ZERO)
    ? receivable.buckets
      .map((b) => {
        const amount = D.dec(b.amount)
        const width = D.gt(amount, D.ZERO)
          ? D.toNumber(D.div(D.mul(amount, D.HUNDRED), total))
          : 0
        return { ...b, width }
      })
      .filter((s) => s.width > 0)
    : []

  const label = segments.length === 0
    ? 'Nothing outstanding on the loaded bills'
    : segments.map((s) => `${s.label}: ${formatMoney(s.amount)}`).join(', ')

  return (
    <div
      {...(described
        ? { role: 'img', 'aria-label': `Receivable by age. ${label}` }
        : { 'aria-hidden': true })}
      className={cn('flex w-full overflow-hidden rounded-[var(--radius-full)] bg-inset', className)}
    >
      {segments.map((s) => (
        <span
          key={s.key}
          title={`${s.label} · ${formatMoney(s.amount)}`}
          style={{ width: `${s.width}%`, backgroundColor: s.tone }}
        />
      ))}
    </div>
  )
}

/** The meter the row and the sheet both draw, at whatever height they ask for. */
export function CreditMeter({
  standing,
  className,
  label,
}: {
  standing: CustomerRow['credit']
  className?: string
  label: string
}) {
  const meter = standing.meter
  if (!meter) return null
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      /* Clamped, unlike the label. `valueNow` is the TRUE percentage — 300 on a
         ₹15,000 balance against a ₹5,000 limit — and ARIA requires valuenow to
         sit inside min..max, so an unclamped 300 is announced as out of range or
         silently dropped. The magnitude is not lost: `aria-valuetext` reads the
         words, "Over the limit by 10,000.00", which is the sentence anyway. */
      aria-valuenow={Math.min(100, meter.valueNow)}
      aria-valuetext={standing.word}
      className={cn('w-full overflow-hidden rounded-[var(--radius-full)]', className)}
      style={{ backgroundColor: meter.track }}
    >
      <div
        className="h-full rounded-[var(--radius-full)]"
        style={{ width: `${meter.width}%`, backgroundColor: meter.fill }}
      />
    </div>
  )
}

const TONE_TEXT: Record<CustomerRow['credit']['tone'], string> = {
  ok: 'text-fg-muted',
  near: 'text-warning-11',
  over: 'text-danger-11',
  unset: 'text-fg-subtle',
}

// --------------------------------------------------------------- segments ---

const SEGMENT_ICON: Record<Segment, LucideIcon> = {
  chronic: Repeat,
  occasional: CalendarDays,
  dormant: Moon,
  none: CalendarDays,
}

/* Never colour alone: every one of these ships an icon AND the word. Dormant is
   amber because it is the one an owner is meant to act on — a customer who has
   quietly stopped coming is a loss the shop has not noticed yet. */
const SEGMENT_TONE: Record<Segment, string | undefined> = {
  chronic: 'var(--info-11)',
  occasional: undefined,
  dormant: 'var(--warning-11)',
  none: undefined,
}

export function SegmentChip({ segment }: { segment: Segment }) {
  if (segment === 'none') {
    return <span className="text-2xs text-fg-subtle" title={SEGMENT_MEANING.none}>No bills loaded</span>
  }
  return (
    <Chip icon={SEGMENT_ICON[segment]} tone={SEGMENT_TONE[segment]} className={cn(segment === 'occasional' && 'text-fg-muted')}>
      {SEGMENT_LABEL[segment]}
    </Chip>
  )
}

/** "in 4 days", "today", "6 days late" — always the word, never a bare number. */
export function refillWords(dueInDays: number): string {
  if (dueInDays < 0) return `${Math.abs(dueInDays)} day${dueInDays === -1 ? '' : 's'} late`
  if (dueInDays === 0) return 'due today'
  return `in ${dueInDays} day${dueInDays === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------- columns ---

/* Eight columns wide, five when the sheet takes its 420px. GSTIN, the ageing bar
   and the refill column are what gets shed: all three are on screen in the sheet
   that caused the squeeze. The ageing WORDS stay either way — they move under
   the outstanding figure — because the sentence is the part that must never be
   the thing that gets dropped. */
const WIDE = 'grid-cols-[minmax(160px,2fr)_minmax(100px,1fr)_minmax(108px,1fr)_minmax(116px,1.1fr)_minmax(112px,1.1fr)_minmax(128px,1.4fr)_112px_104px]'
const NARROW = 'grid-cols-[minmax(140px,2fr)_minmax(96px,1fr)_112px_112px_116px]'

function HeaderRow({ narrow }: { narrow: boolean }) {
  return (
    <div
      className={cn(
        'grid shrink-0 items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5',
        narrow ? NARROW : WIDE,
      )}
    >
      <span className="micro-label">Customer</span>
      {narrow ? null : <span className="micro-label">GSTIN</span>}
      <span className="micro-label">Care</span>
      <span className="micro-label">Buying pattern</span>
      <span className="micro-label">Credit limit ₹</span>
      {narrow ? null : <span className="micro-label">Owed by age</span>}
      <span className="micro-label text-right">Outstanding ₹</span>
      {narrow ? null : <span className="micro-label">Next refill</span>}
    </div>
  )
}

function AgeingNote({ row, billStatus }: { row: CustomerRow; billStatus: BillStatus }) {
  if (billStatus !== 'ready') {
    return (
      <span className="text-2xs text-fg-subtle">
        {billStatus === 'loading' ? 'Ageing…' : 'Ageing unavailable'}
      </span>
    )
  }

  const note = receivableNote(row.receivable)
  const text =
    note.kind === 'unreadable'
      ? 'Balance cannot be read'
      : note.kind === 'aged'
        ? `${formatAmount(note.amount ?? '0')} over 90 days`
        : note.kind === 'open'
          ? `${note.count} open bill${note.count === 1 ? '' : 's'}, none past 90 days`
          /* Named, never absorbed. This is the row that would otherwise read
             "Nothing due" beside a live figure. */
          : note.kind === 'carried'
            ? 'Carried balance — no bill to age against'
            : note.kind === 'onAccount'
              ? `${formatAmount(note.amount ?? '0')} paid on account`
              : 'Nothing due'

  /* The remainder, appended rather than replacing. A customer with two bills
     inside thirty days AND eight thousand carried in reads as both — the row
     used to name only the bills and go quiet about the larger, older money. */
  const full = note.carried ? `${text} · ${formatAmount(note.carried)} carried` : text

  return (
    <span
      className={cn(
        'block truncate text-2xs',
        note.kind === 'aged' ? 'text-danger-11'
          : note.kind === 'carried' || note.kind === 'unreadable' || note.carried
            ? 'text-warning-11'
            : 'text-fg-subtle',
      )}
      title={full}
    >
      {full}
    </span>
  )
}

function Row({
  row,
  care,
  profile,
  narrow,
  billStatus,
  active,
  selected,
  onOpen,
  onHover,
}: {
  row: CustomerRow
  care: CareBook
  profile: PurchaseProfile | undefined
  narrow: boolean
  billStatus: BillStatus
  active: boolean
  selected: boolean
  onOpen: () => void
  onHover: () => void
}) {
  const c = row.customer
  const owes = D.gt(row.outstanding, D.ZERO)
  const allergies = c.allergies.length
  const file = careOf(care, c.id)
  const conditions = file.conditions.length
  const next = profile?.refills[0]

  return (
    <button
      type="button"
      data-customer-row
      data-customer-id={c.id}
      id={`customer-row-${c.id}`}
      role="option"
      aria-selected={selected}
      onClick={onOpen}
      onMouseEnter={onHover}
      style={{ height: ROW_H }}
      className={cn(
        'absolute inset-x-0 top-0 grid w-full items-center gap-2 border-b border-border-subtle px-[var(--cell-px)] text-left',
        'transition-colors duration-[var(--dur-fast)]',
        narrow ? NARROW : WIDE,
        selected ? 'bg-accent-3' : active ? 'bg-accent-3/45' : 'hover:bg-hover',
      )}
    >
      {/* A bar AND a tint, never a tint alone. */}
      {active || selected ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" /> : null}

      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate text-sm font-medium', selected ? 'text-accent-11' : 'text-fg')}>
          {c.name}
        </span>
        <span className={cn('mono truncate text-2xs', c.phone ? 'text-fg-subtle' : 'text-warning-11')}>
          {/* The phone IS the identity at the counter: it is how the next visit,
              the balance and the allergy strip are found again. */}
          {c.phone || 'No phone on file'}
        </span>
      </span>

      {narrow ? null : (
        <span className="min-w-0">
          {c.gstin
            ? <span className="mono block truncate text-xs text-fg-muted" title={c.gstin}>{c.gstin}</span>
            : <span className="text-xs text-fg-subtle">—</span>}
        </span>
      )}

      {/* Allergies first and conditions under them, always in that order: one of
          the two can hurt somebody and the other cannot. */}
      <span className="flex min-w-0 flex-col gap-0.5">
        {allergies > 0 ? (
          <Chip icon={ShieldAlert} tone="var(--danger-11)">
            {allergies} allerg{allergies === 1 ? 'y' : 'ies'}
          </Chip>
        ) : (
          /* Truncated, not wrapped. A cell that grows a second line pushes the
             row past its measured height and the whole grid stops lining up. */
          <span className="block truncate text-2xs text-fg-subtle">No allergies</span>
        )}
        {conditions > 0 ? (
          <span className="flex items-center gap-1 truncate text-2xs text-info-11" title={file.conditions.join(', ')}>
            <Stethoscope size={11} aria-hidden className="shrink-0" />
            {file.conditions.join(', ')}
          </span>
        ) : (
          <span className="block truncate text-2xs text-fg-subtle" title="No chronic conditions noted">
            No conditions
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-col gap-0.5">
        {billStatus === 'ready'
          ? <SegmentChip segment={profile?.segment ?? 'none'} />
          : <span className="text-2xs text-fg-subtle">Reading bills…</span>}
        <span className="truncate text-2xs text-fg-subtle">
          {row.lastPurchase ? `Last bill ${formatDay(row.lastPurchase)}` : 'Never billed here'}
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-1">
        <span className="num text-sm text-fg">
          {row.credit.meter ? formatAmount(c.creditLimit) : <span className="text-fg-subtle">No limit</span>}
        </span>
        {row.credit.meter ? (
          <CreditMeter
            standing={row.credit}
            className="h-1"
            label={`Credit used by ${c.name}`}
          />
        ) : (
          <span className={cn('truncate text-2xs', TONE_TEXT[row.credit.tone])} title={row.credit.word}>
            {row.credit.word}
          </span>
        )}
      </span>

      {narrow ? null : (
        <span className="min-w-0">
          {billStatus === 'ready'
            ? <AgeingBar receivable={row.receivable} className="h-1.5" described={false} />
            : null}
          <span className="mt-1 block">
            <AgeingNote row={row} billStatus={billStatus} />
          </span>
        </span>
      )}

      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn('num block text-sm', owes ? 'font-medium text-fg' : 'text-fg-subtle')}>
          {formatAmount(c.outstanding)}
        </span>
        {/* The sentence follows the figure when the bar has been shed, so the one
            thing that must never disappear does not. It needs the column's full
            width to truncate against — shrink-wrapped under `items-end` it grew
            leftwards across three columns instead of clipping. */}
        {narrow ? (
          <span className="block w-full text-right">
            <AgeingNote row={row} billStatus={billStatus} />
          </span>
        ) : null}
      </span>

      {narrow ? null : (
        <span className="flex min-w-0 flex-col gap-0.5">
          {next && next.dueInDays !== null ? (
            <>
              <span
                className={cn(
                  'flex items-center gap-1 truncate text-2xs font-medium',
                  next.dueInDays < 0 ? 'text-warning-11' : 'text-fg',
                )}
              >
                <AlarmClock size={11} aria-hidden className="shrink-0" />
                {refillWords(next.dueInDays)}
              </span>
              <span className="truncate text-2xs text-fg-subtle" title={next.brandName}>{next.brandName}</span>
            </>
          ) : (
            <span className="text-2xs text-fg-subtle">No cycle yet</span>
          )}
        </span>
      )}
    </button>
  )
}

// ------------------------------------------------------------------ table ---

export function CustomerTable({
  rows,
  total,
  care,
  profiles,
  status,
  errorCode,
  errorMessage,
  billStatus,
  narrow,
  activeIndex,
  selectedId,
  filtered,
  onActiveIndexChange,
  onOpen,
  onEscape,
  onRetry,
  onClearFilters,
  onGoToBilling,
  bodyRef,
}: {
  rows: CustomerRow[]
  /** The whole book, so the footer can say "12 of 340". */
  total: number
  care: CareBook
  profiles: ReadonlyMap<number, PurchaseProfile>
  status: TableStatus
  errorCode?: string
  errorMessage?: string
  billStatus: BillStatus
  /** True while the sheet is open: the grid sheds its three secondary columns. */
  narrow: boolean
  activeIndex: number
  selectedId: number | null
  filtered: boolean
  onActiveIndexChange: (i: number) => void
  onOpen: (row: CustomerRow) => void
  onEscape: () => void
  onRetry: () => void
  onClearFilters: () => void
  onGoToBilling: () => void
  bodyRef: React.RefObject<HTMLDivElement | null>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => rows[index]?.customer.id ?? index,
    overscan: 12,
  })

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < rows.length) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, rows.length, virtualizer])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target)) return

    const last = rows.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'PageDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 12, last)) }
    else if (e.key === 'PageUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 12, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); onActiveIndexChange(0) }
    else if (e.key === 'End') { e.preventDefault(); onActiveIndexChange(Math.max(last, 0)) }
    else if (e.key === 'Enter') {
      const row = rows[activeIndex]
      if (row) { e.preventDefault(); onOpen(row) }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
  }

  const items = virtualizer.getVirtualItems()
  const activeRow = rows[activeIndex]
  const cols = narrow ? 5 : 8

  return (
    /* `--row-h` is redeclared here so `SkeletonRows`, which measures itself
       against it, draws rows the same height as the real ones and the grid does
       not jump when the data lands. */
    <div className="flex min-h-0 flex-1 flex-col" style={{ '--row-h': `${ROW_H}px` } as React.CSSProperties}>
      <HeaderRow narrow={narrow} />

      {status === 'loading' ? (
        <SkeletonRows rows={12} cols={cols} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="customers.view" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered ? (
            <EmptyState
              icon={UserSearch}
              title="No customer matches this view"
              body="Nobody satisfies every filter above. The box searches name, phone, GSTIN, address and allergen."
              actionLabel="Clear all filters"
              onAction={onClearFilters}
            />
          ) : (
            /* A customer master is not typed in from a list. One is born at the
               counter, from a phone number being read out mid-bill — which is
               where the duplicate check and the allergy prompt live. Sending the
               operator there is the honest answer to "so what do I do now?". */
            <EmptyState
              icon={Users}
              title="No customers yet"
              body="A customer record is created at the counter, from the phone number on the bill — that is where a duplicate is caught and where allergies get asked about. Bill somebody and attach them."
              actionLabel="Go to Billing"
              onAction={onGoToBilling}
            />
          )}
        </div>
      ) : (
        <div
          ref={(el) => {
            scrollRef.current = el
            bodyRef.current = el
          }}
          /* A LISTBOX, not a grid. The rows are buttons you pick — there are no
             cells to navigate into, and role="grid" promised a screen reader a
             two-dimensional structure that does not exist, which axe reports as
             a grid containing no rows. Listbox is what this actually is: arrow
             keys move the active option, Enter opens it. */
          role="listbox"
          tabIndex={0}
          aria-label="Customer book"
          aria-activedescendant={activeRow ? `customer-row-${activeRow.customer.id}` : undefined}
          onKeyDown={onKeyDown}
          data-focus-inset
          className="scroll-region min-h-0 flex-1"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div
                  key={item.key}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                >
                  <Row
                    row={row}
                    care={care}
                    profile={profiles.get(row.customer.id)}
                    narrow={narrow}
                    billStatus={billStatus}
                    active={item.index === activeIndex}
                    selected={row.customer.id === selectedId}
                    onOpen={() => { onActiveIndexChange(item.index); onOpen(row) }}
                    onHover={() => onActiveIndexChange(item.index)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-[var(--cell-px)] text-2xs text-fg-muted">
        <span>
          {status === 'ready' ? (
            rows.length === total
              ? `${total} customer${total === 1 ? '' : 's'}`
              : <><span className="num font-medium text-fg">{rows.length}</span> of <span className="num">{total}</span></>
          ) : (
            'Customer book'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>/</Kbd> search</span>
          <span className="hidden items-center gap-1 lg:flex"><ScanBarcode size={11} aria-hidden /> billed at the counter</span>
        </span>
      </footer>
    </div>
  )
}
