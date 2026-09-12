import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { PackageCheck, Search, ShieldAlert, Trash2, Undo2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreditNote, ReturnDisposition } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatQty } from '@/lib/format'
import { isTypingTarget } from '@/lib/keys'
import { Chip } from '@/components/ui/Badge'
import { Kbd } from '@/components/ui/Kbd'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'
import { ModeChip } from './InvoiceTable'
import type { TableStatus } from './InvoiceTable'

/**
 * The returns register.
 *
 * A credit note is a document in its own right, not a footnote on a bill, and
 * this is the register it belongs in. Three things bring somebody here: what
 * came back today, has anything come back against THIS bill, and where did the
 * goods go — so the grid is issue-date order, the search box reaches the
 * original invoice number, and every row says plainly whether the strip went
 * back on the shelf, into quarantine or into the bin.
 *
 * Opening a row opens the BILL it reverses. That is deliberate: a credit note
 * only means something beside the sale it corrects, and the invoice sheet
 * already lists every note against it.
 */

/** Matches --row-h at compact density. The virtualiser and the DOM must agree. */
const ROW_H = 36

const STAMP = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })

function shortDate(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00`)
  return Number.isNaN(t) ? iso : STAMP.format(t)
}

/**
 * Where the goods went — icon AND word, never a colour on its own.
 *
 * Quarantine and destruction are not decoration: they are the difference
 * between stock that is sellable and stock that is off the shelf but still
 * sitting in the shop, and a drugs inspector asks about the second kind.
 */
const DISPOSITION_META: Record<ReturnDisposition, { icon: LucideIcon; label: string; tone: string }> = {
  RESTOCK: { icon: PackageCheck, label: 'Restocked', tone: 'var(--success-11)' },
  QUARANTINE: { icon: ShieldAlert, label: 'Held', tone: 'var(--status-quarantine)' },
  DESTROY: { icon: Trash2, label: 'Destroyed', tone: 'var(--status-expired)' },
}

const DISPOSITION_ORDER: ReturnDisposition[] = ['RESTOCK', 'QUARANTINE', 'DESTROY']

export function DispositionChips({ note }: { note: CreditNote }) {
  const seen = new Set(note.lines.map((l) => l.disposition))
  const shown = DISPOSITION_ORDER.filter((d) => seen.has(d))
  if (shown.length === 0) return <span className="text-2xs text-fg-subtle">—</span>
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown.map((d) => {
        const meta = DISPOSITION_META[d]
        return <Chip key={d} icon={meta.icon} tone={meta.tone}>{meta.label}</Chip>
      })}
    </span>
  )
}

const WIDE = 'minmax(116px,0.9fr) 52px minmax(110px,0.85fr) minmax(100px,1.1fr) 56px 92px 84px 124px'
const NARROW = 'minmax(112px,0.95fr) 52px minmax(104px,0.9fr) 88px 116px'

export function CreditNoteTable({
  notes,
  total,
  status,
  errorMessage,
  errorCode,
  narrow,
  activeIndex,
  selectedInvoiceId,
  filtered,
  emptyTitle,
  onActiveIndexChange,
  onOpen,
  onEscape,
  onRetry,
  onClearFilters,
  bodyRef,
}: {
  notes: CreditNote[]
  /** Everything in the range, before the search box narrowed it. */
  total: number
  status: TableStatus
  errorMessage?: string
  errorCode?: string
  narrow: boolean
  activeIndex: number
  /** The bill currently open in the sheet, so its notes read as selected. */
  selectedInvoiceId: number | null
  filtered: boolean
  emptyTitle: string
  onActiveIndexChange: (i: number) => void
  onOpen: (note: CreditNote) => void
  onEscape: () => void
  onRetry: () => void
  onClearFilters: () => void
  bodyRef: React.RefObject<HTMLDivElement | null>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const template = narrow ? NARROW : WIDE

  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => notes[index]?.id ?? index,
    overscan: 12,
  })

  useEffect(() => {
    if (activeIndex >= 0 && activeIndex < notes.length) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, notes.length, virtualizer])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTypingTarget(e.target)) return
    const last = notes.length - 1
    if (e.key === 'ArrowDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 1, last)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 1, 0)) }
    else if (e.key === 'PageDown') { e.preventDefault(); onActiveIndexChange(Math.min(activeIndex + 12, last)) }
    else if (e.key === 'PageUp') { e.preventDefault(); onActiveIndexChange(Math.max(activeIndex - 12, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); onActiveIndexChange(0) }
    else if (e.key === 'End') { e.preventDefault(); onActiveIndexChange(Math.max(last, 0)) }
    else if (e.key === 'Enter') {
      const note = notes[activeIndex]
      if (note) { e.preventDefault(); onOpen(note) }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
    }
  }

  const activeNote = notes[activeIndex]

  /* The header is a ROW OF THE GRID, so it is rendered INSIDE the grid element
     rather than as a sibling above it. A row element outside the grid element
     is not a row at all: axe calls it critical, and what it means in practice is
     that a screen-reader user tabbing into this table hears a wall of numbers
     with no column names attached to any of them. */
  const headerRow = (
      <div
        role="row"
        className="sticky top-0 z-10 grid shrink-0 items-center gap-2 border-b border-border-subtle bg-subtle px-[var(--cell-px)]"
        style={{ gridTemplateColumns: template, height: 28 }}
      >
        <span role="columnheader" className="micro-label truncate">Credit note</span>
        <span role="columnheader" className="micro-label truncate">Issued</span>
        <span role="columnheader" className="micro-label truncate">Against bill</span>
        {!narrow ? <span role="columnheader" className="micro-label truncate">Customer</span> : null}
        {!narrow ? <span role="columnheader" className="micro-label truncate text-right">Units</span> : null}
        <span role="columnheader" className="micro-label truncate text-right">Refund ₹</span>
        {!narrow ? <span role="columnheader" className="micro-label truncate">Back by</span> : null}
        <span role="columnheader" className="micro-label truncate">The goods</span>
      </div>
  )

  return (
    <div className="card flex min-w-0 flex-1 flex-col overflow-hidden">

      {status === 'loading' ? (
        <SkeletonRows rows={14} cols={narrow ? 5 : 8} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="reports.sales" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState code={errorCode} message={errorMessage} onRetry={onRetry} />
        </div>
      ) : notes.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered ? (
            <EmptyState
              icon={Search}
              title="No credit note matches this view"
              body="Nothing in this range satisfies every filter above. Widen the dates, or drop a filter — a credit note is never deleted, so if it was raised it is still here."
              actionLabel="Clear the filters"
              onAction={onClearFilters}
            />
          ) : (
            <EmptyState
              icon={Undo2}
              title={emptyTitle}
              body="A return posts a credit note against the original bill, reverses the tax at the rate that bill charged, and decides whether the strip goes back on the shelf. Open a posted bill and press Return to raise one."
            />
          )}
        </div>
      ) : (
        <div
          ref={(el) => {
            scrollRef.current = el
            bodyRef.current = el
          }}
          role="grid"
          tabIndex={0}
          aria-label="Credit note register"
          aria-rowcount={notes.length + 1}
          aria-activedescendant={activeNote ? `credit-note-row-${activeNote.id}` : undefined}
          onKeyDown={onKeyDown}
          data-focus-inset
          className="scroll-region min-h-0 flex-1"
        >
          {headerRow}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const note = notes[item.index]
              if (!note) return null
              const active = item.index === activeIndex
              const selected = note.invoiceId === selectedInvoiceId
              const units = D.sum(note.lines.map((l) => D.dec(l.qty)))
              return (
                <div
                  key={note.id}
                  id={`credit-note-row-${note.id}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={selected}
                  onClick={() => { onActiveIndexChange(item.index); onOpen(note) }}
                  className={cn(
                    'absolute inset-x-0 top-0 grid cursor-default items-center gap-2 border-b border-border-subtle px-[var(--cell-px)]',
                    'transition-colors duration-[var(--dur-fast)]',
                    selected ? 'bg-accent-3' : active ? 'bg-accent-3/45' : 'hover:bg-hover',
                  )}
                  style={{
                    height: ROW_H,
                    transform: `translateY(${item.start}px)`,
                    gridTemplateColumns: template,
                  }}
                >
                  {/* Active row is a bar AND a tint — never a tint alone. */}
                  {(active || selected) && (
                    <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />
                  )}

                  <span className="mono truncate text-sm text-fg" title={note.creditNoteNo}>
                    {note.creditNoteNo}
                  </span>
                  <span className="num text-sm text-fg-muted">{shortDate(note.issuedOn)}</span>
                  <span className="mono truncate text-sm text-fg-muted" title={`Reverses ${note.invoiceNo} of ${note.originalInvoiceDate}`}>
                    {note.invoiceNo}
                  </span>
                  {!narrow ? (
                    <span className="min-w-0 truncate text-base text-fg" title={note.reason}>
                      {note.customerName ?? <span className="text-fg-subtle">Walk-in</span>}
                    </span>
                  ) : null}
                  {!narrow ? (
                    <span className="num text-sm text-fg-muted">{formatQty(D.toStr(units, 3))}</span>
                  ) : null}
                  {/* A refund is money going OUT. The minus is not decoration:
                      this column and the register's Net column sit in the same
                      eye-line and must never read as the same direction. */}
                  <span className="num text-base font-medium text-fg">−{formatAmount(note.netAmount)}</span>
                  {!narrow ? <ModeChip mode={note.refundMode} /> : null}
                  <DispositionChips note={note} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-subtle px-3 text-2xs text-fg-muted">
        <span>
          {status === 'ready' ? (
            <>
              <span className="num font-medium text-fg">{notes.length}</span>
              {notes.length < total ? <> of <span className="num">{total}</span></> : null}
              {' '}credit note{total === 1 ? '' : 's'}
            </>
          ) : (
            'Credit note register'
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> row</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open the bill</span>
          <span className="flex items-center gap-1"><Kbd>/</Kbd> find</span>
        </span>
      </div>
    </div>
  )
}
