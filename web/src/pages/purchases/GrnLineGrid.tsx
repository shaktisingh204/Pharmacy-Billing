import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, PackageSearch, Plus, Trash2, TrendingDown, TrendingUp } from 'lucide-react'
import type {
  Batch, Medicine, MedicineSearchHit, PurchaseLine, PurchaseLineInput,
} from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { daysUntil, formatAmount } from '@/lib/format'
import { Kbd } from '@/components/ui/Kbd'

/**
 * The goods-receipt grid — the mirror of the POS cart.
 *
 * Tab order across a row IS the receiving workflow: medicine, batch, expiry,
 * qty, free, MRP, rate, discount, GST — and off the end of the row, which lands
 * on the medicine field of the next line. That is the whole ergonomic contract,
 * and it is honoured by the BROWSER rather than by an interceptor: the read-only
 * cells are spans, the delete button is `tabIndex={-1}`, and the grid always
 * carries one trailing blank line, so native Tab already goes exactly where the
 * operator expects. The only Tab that is intercepted is the one off the very
 * last cell of the last line, which loops back to that line's medicine field
 * instead of escaping into the totals bar.
 *
 * Nothing here computes money. Every amount on screen comes back from
 * `quotePurchase`; the cells hold the operator's KEYSTROKES, which are strings
 * on their way to becoming decimals and are frequently not valid decimals yet
 * ('7.' and '.5' are both real states of typing 7.5).
 */

// --------------------------------------------------------------- the draft ---

export interface DraftLine {
  lineId: string
  /** null until the text resolves to a catalogue row. */
  medicineId: number | null
  /** Free text while unresolved; the medicine's brand once picked. */
  brandName: string
  packLabel: string
  unitsPerPack: number
  batchNo: string
  /** As printed on the pack: "11/27". The adapter normalises it to a date. */
  expiry: string
  qtyPacks: string
  freePacks: string
  mrpPerPack: string
  ratePerPack: string
  discountPct: string
  gstRatePct: string
  /** Seeded from the last batch received, so the grid can say which cells it filled. */
  seededMrp: boolean
  seededGst: boolean
}

export function blankLine(lineId: string): DraftLine {
  return {
    lineId,
    medicineId: null,
    brandName: '',
    packLabel: '',
    unitsPerPack: 1,
    batchNo: '',
    expiry: '',
    qtyPacks: '',
    freePacks: '',
    mrpPerPack: '',
    ratePerPack: '',
    discountPct: '',
    gstRatePct: '',
    seededMrp: false,
    seededGst: false,
  }
}

export function isLineBlank(l: DraftLine): boolean {
  return l.medicineId === null && l.brandName.trim() === '' && l.batchNo.trim() === ''
    && l.qtyPacks.trim() === '' && l.mrpPerPack.trim() === '' && l.ratePerPack.trim() === ''
}

// ------------------------------------------------------------ field shapes ---

/* Deliberately looser than the contract's decimals: these test what the operator
   has typed SO FAR. A field that cannot hold '7.' cannot be used to type '7.5'. */
const MONEY_RE = /^\d+(\.\d{1,4})?$/
const QTY_RE = /^\d+(\.\d{1,3})?$/
const PCT_RE = /^\d+(\.\d{1,2})?$/
const EXPIRY_RE = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/

/**
 * "11/27" → 2027-11-30.
 *
 * A pack is good to the END of its printed month, which is why this is the last
 * day and not the first. Two-digit years are read as 20xx: the tariff is not
 * going to hand a pharmacy a 1927 expiry, and a pack printed 11/27 in a store
 * today means 2027 in every case anybody will ever key.
 */
export function expiryToIso(raw: string): string | null {
  const m = EXPIRY_RE.exec(raw.trim())
  if (!m) return null
  const month = Number(m[1] ?? '0')
  const yearRaw = m[2] ?? ''
  const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)
  /* Day 0 of the FOLLOWING month is the last day of this one, leap years included. */
  const last = new Date(Date.UTC(year, month, 0))
  return last.toISOString().slice(0, 10)
}

/** Digits in, "MM/YY" out, so the slash never has to be typed. */
function maskExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 6)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}/${digits.slice(2)}`
}

export interface LineIssue {
  /** Blocking keeps the line out of the quote; a warning only speaks. */
  blocking: boolean
  text: string
}

/**
 * The FIRST thing wrong with a line, in the order the operator types it.
 *
 * One message, not a list: a half-typed row is missing five things and saying so
 * five times is noise. The order matches the Tab order, so the message always
 * points at the cell the cursor is heading for.
 */
export function lineIssue(l: DraftLine, today: Date): LineIssue | null {
  if (l.medicineId === null) {
    return l.brandName.trim() === ''
      ? { blocking: true, text: 'Pick a medicine' }
      : { blocking: true, text: 'Not in the catalogue yet — pick it from the list or create it' }
  }
  if (l.batchNo.trim() === '') return { blocking: true, text: 'Batch number, exactly as the strip prints it' }

  const iso = expiryToIso(l.expiry)
  if (iso === null) return { blocking: true, text: 'Expiry reads MM/YY — 11/27' }
  const days = daysUntil(iso, today)
  if (days < 0) return { blocking: true, text: 'This batch is already expired — do not receive it' }

  if (!QTY_RE.test(l.qtyPacks.trim()) || Number(l.qtyPacks) <= 0) {
    return { blocking: true, text: 'Quantity, in packs' }
  }
  if (l.freePacks.trim() !== '' && !QTY_RE.test(l.freePacks.trim())) {
    return { blocking: true, text: 'Free quantity, in packs' }
  }
  if (!MONEY_RE.test(l.mrpPerPack.trim())) return { blocking: true, text: 'MRP printed on the pack' }
  if (!MONEY_RE.test(l.ratePerPack.trim())) return { blocking: true, text: 'Rate charged, per pack' }
  if (l.discountPct.trim() !== '' && !PCT_RE.test(l.discountPct.trim())) {
    return { blocking: true, text: 'Discount as a percentage' }
  }
  if (!PCT_RE.test(l.gstRatePct.trim())) {
    return { blocking: true, text: 'GST rate off the supplier bill — it is frozen here for input credit' }
  }

  /* Everything below is advisory: the receipt is valid, and the operator is the
     one who can see the paper. */
  if (D.gt(D.dec(l.ratePerPack.trim()), D.dec(l.mrpPerPack.trim()))) {
    return { blocking: false, text: 'The rate is above the printed MRP — check the pack' }
  }
  if (days <= 90) {
    return { blocking: false, text: `Expires in ${days} day${days === 1 ? '' : 's'} — near-expiry stock` }
  }
  return null
}

export function lineReady(l: DraftLine, today: Date): boolean {
  const issue = lineIssue(l, today)
  return issue === null || !issue.blocking
}

/** Only ever called on a line `lineReady` has already accepted. */
export function toLineInput(l: DraftLine): PurchaseLineInput {
  return {
    lineId: l.lineId,
    medicineId: l.medicineId ?? 0,
    batchNo: l.batchNo.trim(),
    expiry: l.expiry.trim(),
    qtyPacks: l.qtyPacks.trim(),
    freePacks: l.freePacks.trim() === '' ? '0' : l.freePacks.trim(),
    mrpPerPack: l.mrpPerPack.trim(),
    ratePerPack: l.ratePerPack.trim(),
    discountPct: l.discountPct.trim() === '' ? '0' : l.discountPct.trim(),
    gstRatePct: l.gstRatePct.trim(),
  }
}

// ------------------------------------------------------ defaults from stock ---

export interface BatchDefaults {
  mrpPerPack: string
  gstRatePct: string
}

/**
 * What the last receipt of this medicine already answered.
 *
 * MRP and the purchase GST rate are carried forward; the RATE deliberately is
 * not. Marg's own manual names the carried rate as the reason its purchase entry
 * is fast, and it is — but the rate is also the single number the total-match
 * check exists to catch, and `rateChangedFrom` can only flag a change against
 * the last purchase if the operator actually typed today's number.
 *
 * "Last" is the highest batch id: batches are keyed in insertion order, so the
 * newest row is the most recently received one. Expiry order would answer a
 * different question — which pack dies first — and that is FEFO's job, not this.
 */
export function latestBatchDefaults(batches: readonly Batch[]): BatchDefaults | null {
  let latest: Batch | null = null
  for (const b of batches) if (latest === null || b.id > latest.id) latest = b
  if (latest === null) return null
  return { mrpPerPack: latest.mrpPerPack, gstRatePct: latest.purchaseGstPct }
}

// ------------------------------------------------------------------ layout ---

/**
 * Twelve columns and a delete button at the 1366 floor, with the short book open
 * beside them — which is the tightest this grid is ever asked to be.
 *
 * Landed cost gets a column of its own rather than a hover: it is the number
 * that decides whether this deal was worth taking, and a figure the operator has
 * to go looking for is a figure nobody looks at. The name column is the one that
 * flexes, because it is the only one that cannot be read from context.
 *
 * Every fixed width here is set to its own header label, not to a round number:
 * the numeric cells hold at most a handful of digits and any pixel spent past
 * that is a pixel taken off the brand name, which is where it is actually read.
 */
const COLS =
  'grid grid-cols-[20px_minmax(136px,1.5fr)_70px_50px_42px_38px_62px_66px_46px_40px_76px_72px_20px] items-center gap-1'

const HEADS: Array<{ label: string; align?: 'right' }> = [
  { label: '#' },
  { label: 'Medicine' },
  { label: 'Batch' },
  { label: 'Expiry' },
  { label: 'Qty', align: 'right' },
  { label: 'Free', align: 'right' },
  { label: 'MRP/pack', align: 'right' },
  { label: 'Rate/pack', align: 'right' },
  { label: 'Disc %', align: 'right' },
  { label: 'GST %', align: 'right' },
  { label: 'Amount ₹', align: 'right' },
  { label: 'Landed ₹/u', align: 'right' },
  { label: '' },
]

// -------------------------------------------------------------- navigation ---

/**
 * Move one cell forward or back.
 *
 * Enter is remapped onto this rather than left alone because a scanner's Enter
 * suffix landing in a quantity cell must never submit anything.
 */
function focusRelative(from: HTMLElement, delta: 1 | -1): void {
  const root = from.closest('[data-grid-body]')
  if (!root) return
  const cells = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-cell]'))
  const here = cells.indexOf(from as HTMLInputElement)
  if (here < 0) return
  const next = cells[here + delta]
  if (next) {
    next.focus()
    next.select()
    return
  }
  /* Off the end of the last line: back to the medicine field of the line the
     operator is on, which is the resting place between lines. */
  const row = from.closest('[data-line-row]')
  const first = row?.querySelector<HTMLInputElement>('input[data-cell]')
  first?.focus()
  first?.select()
}

/**
 * The last editable cell in the whole grid — the GST rate on the bottom line.
 *
 * Tab is native everywhere else and deliberately so: every non-input in a row is
 * a span or `tabIndex={-1}`, and the grid always carries one trailing blank line,
 * so Tab off the end of a line already lands on the next line's medicine field
 * with nothing to intercept it. The bottom line has no next line. Because a line
 * with anything on it immediately grows a blank one beneath it, the bottom line
 * is always the empty one, and letting Tab escape from it into the totals bar
 * ends the run at exactly the moment the operator is starting the next line. It
 * wraps back to that line's medicine cell instead.
 */
function isLastCell(el: HTMLInputElement): boolean {
  const root = el.closest('[data-grid-body]')
  if (!root) return false
  const cells = root.querySelectorAll<HTMLInputElement>('input[data-cell]')
  return cells.length > 0 && cells[cells.length - 1] === el
}

// ------------------------------------------------------------------- cells ---

function cellCls(state: { invalid?: boolean; seeded?: boolean }): string {
  return cn(
    'h-6 w-full rounded-[var(--radius-sm)] border px-1 text-base',
    'hover:bg-surface focus:bg-surface',
    state.invalid
      ? 'border-danger-9/60 bg-danger-3/40'
      : state.seeded
        ? 'border-accent-6/70 bg-accent-2'
        : 'border-transparent bg-transparent hover:border-border-subtle',
  )
}

const SEEDED_TITLE =
  'Carried from the last receipt of this medicine. Overtype it if the pack has changed.'

function TextCell({
  value, onChange, ariaLabel, mono, seeded, invalid, placeholder, inputRef, numeric,
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  mono?: boolean
  seeded?: boolean
  invalid?: boolean
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  numeric?: boolean
}) {
  return (
    <input
      ref={inputRef}
      data-cell
      value={value}
      aria-label={ariaLabel}
      title={seeded ? SEEDED_TITLE : undefined}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      inputMode={numeric ? 'decimal' : undefined}
      data-focus-inset
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        if (e.key === 'Enter') {
          e.preventDefault()
          focusRelative(e.currentTarget, e.shiftKey ? -1 : 1)
        } else if (e.key === 'Tab' && !e.shiftKey && isLastCell(e.currentTarget)) {
          e.preventDefault()
          focusRelative(e.currentTarget, 1)
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          e.currentTarget.blur()
        }
      }}
      className={cn(cellCls({ invalid, seeded }), numeric ? 'num' : mono ? 'mono text-sm' : 'text-left')}
    />
  )
}

/**
 * The medicine cell: a combobox that can also CREATE.
 *
 * Most new SKUs in a pharmacy are born on a goods receipt — the supplier's
 * invoice already carries the brand, pack, HSN and MRP — so "not in the
 * catalogue" is a normal state of this cell rather than an error, and the way
 * out of it is one keystroke away instead of on another screen.
 *
 * Focus is never stolen while the list is open (the W3C editable-combobox
 * pattern): the highlight moves through aria-activedescendant and DOM focus
 * stays in the input, so a half-typed brand survives every result that lands.
 */
function MedicineCell({
  line, onResolve, onText, onCreate, inputRef, nextRef,
}: {
  line: DraftLine
  onResolve: (m: Medicine, defaults: BatchDefaults | null) => void
  onText: (text: string) => void
  onCreate: (term: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  nextRef: React.RefObject<HTMLInputElement | null>
}) {
  const api = useApi()
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(true)
  const term = line.brandName

  const { data: hits = [], isFetching } = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.searchMedicines({ term, limit: 8, includeOutOfStock: true }),
    enabled: !dismissed && term.trim().length > 0,
    placeholderData: (prev) => prev,
  })

  const open = !dismissed && term.trim().length > 0
  /* The create row is the last option, so ↓↓↵ reaches it without a mouse. */
  const optionCount = hits.length + 1

  async function commit(index: number) {
    /*
     * Enter is not honoured against results that belong to an older term.
     *
     * `placeholderData` keeps the previous term's hits on screen while the next
     * ones load, which is what stops the list flickering — but it also means a
     * fast operator can type past the search and press Enter while the visible
     * rows still answer what they typed a moment ago. Committing then picks the
     * WRONG MEDICINE onto a goods receipt, and a receipt is what creates the
     * batch. Falling through to "create it" is no better: on a shop LAN the
     * operator would be handed a create-medicine dialog for a medicine that is
     * already in the catalogue. Neither is recoverable by looking at the screen,
     * so the keystroke waits instead — the list is visibly settling.
     */
    if (isFetching) return
    const hit = hits[index]
    if (!hit) {
      onCreate(term.trim())
      return
    }
    setDismissed(true)
    /* One extra read, only when a line is picked: what this medicine was
       received at last time. `fefoBatch` on the hit is the wrong batch to ask —
       it is the one that expires first, not the one that arrived last. */
    const batches = await api.getBatches(hit.medicine.id).catch((): Batch[] => [])
    onResolve(hit.medicine, latestBatchDefaults(batches))
    nextRef.current?.focus()
    nextRef.current?.select()
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1">
      <input
        ref={inputRef}
        data-cell
        role="combobox"
        aria-expanded={open}
        aria-controls={`grn-hits-${line.lineId}`}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active < hits.length ? `grn-hit-${line.lineId}-${active}` : undefined
        }
        aria-label="Medicine"
        value={term}
        placeholder="Brand, salt or manufacturer…"
        autoComplete="off"
        spellCheck={false}
        data-focus-inset
        onChange={(e) => {
          onText(e.target.value)
          setActive(0)
          setDismissed(false)
        }}
        onFocus={(e) => {
          e.currentTarget.select()
          if (line.medicineId === null && term.trim() !== '') setDismissed(false)
        }}
        onBlur={() => window.setTimeout(() => setDismissed(true), 120)}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'ArrowDown' && open) {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, optionCount - 1))
          } else if (e.key === 'ArrowUp' && open) {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (open) void commit(active)
            else focusRelative(e.currentTarget, e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            if (open) setDismissed(true)
            else e.currentTarget.blur()
          }
        }}
        className={cn(
          cellCls({ invalid: line.medicineId === null && term.trim() !== '' }),
          'min-w-0 flex-1 text-left',
        )}
      />
      {line.packLabel ? (
        <span className="shrink-0 text-2xs text-fg-subtle" title={line.packLabel}>{line.packLabel}</span>
      ) : null}

      {open ? (
        <div
          id={`grn-hits-${line.lineId}`}
          role="listbox"
          aria-label="Catalogue matches"
          /* Dimmed while the rows still answer an older term, so the Enter that
             `commit` declines to act on has a reason the operator can see. */
          aria-busy={isFetching}
          className={cn(
            'absolute left-0 top-[calc(100%+2px)] z-30 max-h-[280px] w-[380px] overflow-y-auto',
            'rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-lg)]',
            'transition-opacity duration-[var(--dur-fast)]',
            isFetching && 'opacity-60',
          )}
        >
          {hits.map((hit, i) => (
            <Option
              key={hit.medicine.id}
              id={`grn-hit-${line.lineId}-${i}`}
              hit={hit}
              active={i === active}
              onPick={() => void commit(i)}
              onHover={() => setActive(i)}
            />
          ))}
          <div
            id={`grn-hit-${line.lineId}-create`}
            role="option"
            aria-selected={active === hits.length}
            onMouseDown={(e) => { e.preventDefault(); onCreate(term.trim()) }}
            onMouseEnter={() => setActive(hits.length)}
            className={cn(
              'flex h-9 cursor-pointer items-center gap-2 border-t border-border-subtle px-3 text-sm',
              active === hits.length ? 'bg-accent-3 text-accent-11' : 'text-fg-muted hover:bg-hover',
            )}
          >
            <Plus size={13} aria-hidden />
            <span className="truncate">Create “{term.trim()}” as a new medicine</span>
            <Kbd className="ml-auto">↵</Kbd>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Option({
  id, hit, active, onPick, onHover,
}: {
  id: string
  hit: MedicineSearchHit
  active: boolean
  onPick: () => void
  onHover: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }) }, [active])
  const m = hit.medicine

  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => { e.preventDefault(); onPick() }}
      onMouseEnter={onHover}
      className={cn(
        'flex h-[42px] cursor-pointer flex-col justify-center gap-0.5 border-b border-border-subtle px-3 last:border-0',
        active ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      <span className="flex items-baseline gap-1.5">
        <span className={cn('truncate text-base font-medium', active && 'text-accent-11')}>{m.brandName}</span>
        <span className="shrink-0 text-2xs text-fg-muted">{m.strengthText}</span>
        <span className="shrink-0 text-2xs text-fg-subtle">{m.packLabel}</span>
        <span className="mono ml-auto shrink-0 text-2xs text-fg-subtle">{m.hsnCode}</span>
      </span>
      <span className="truncate text-2xs text-fg-subtle">{m.compositionText} · {m.manufacturer}</span>
    </div>
  )
}

// -------------------------------------------------------------------- grid ---

export function GrnLineGrid({
  lines, priced, today, pricingBlockedBy, onPatch, onResolve, onRemove, onCreateMedicine,
}: {
  lines: DraftLine[]
  /** Priced lines from `quotePurchase`, keyed by lineId. */
  priced: Map<string, PurchaseLine>
  today: Date
  /**
   * Why the bill cannot be priced yet, or null when it can.
   *
   * `quotePurchase` REJECTS a receipt whose header is incomplete — no supplier,
   * no distributor invoice number, no invoice date — and the difference between
   * "not keyed yet" and "priced wrong" is one the operator has to be able to
   * see. Said once here, under the grid, rather than as a red error banner that
   * tells them not to post a bill they have not finished starting.
   */
  pricingBlockedBy: string | null
  onPatch: (lineId: string, patch: Partial<DraftLine>) => void
  onResolve: (lineId: string, m: Medicine, defaults: BatchDefaults | null) => void
  onRemove: (lineId: string) => void
  onCreateMedicine: (lineId: string, term: string) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-w-0 overflow-x-auto">
        {/* The tracks in COLS are fixed px except the name, so the grid has a
            hard minimum: 602 of fixed columns + 136 of name + 12 gaps of 4px +
            16 of padding = 802. A rounder 800 leaves the delete column hanging
            2px outside the scroll width it is supposed to be inside. */}
        <div className="min-w-[802px]">
          <div className={cn(COLS, 'sticky top-0 z-10 h-7 border-b border-border-subtle bg-subtle px-2')}>
            {HEADS.map((h, i) => (
              <span
                key={h.label === '' ? `pad-${i}` : h.label}
                className={cn('micro-label truncate', h.align === 'right' && 'text-right')}
              >
                {h.label}
              </span>
            ))}
          </div>

          <div data-grid-body>
            {lines.map((line, i) => (
              <Row
                key={line.lineId}
                index={i + 1}
                line={line}
                priced={priced.get(line.lineId)}
                today={today}
                last={i === lines.length - 1}
                onPatch={onPatch}
                onResolve={onResolve}
                onRemove={onRemove}
                onCreateMedicine={onCreateMedicine}
              />
            ))}
          </div>
        </div>
      </div>

      {pricingBlockedBy !== null ? (
        <div className="flex items-center gap-2 border-t border-border-subtle bg-subtle px-3 py-1.5 text-xs text-fg-muted">
          <PackageSearch size={13} aria-hidden className="shrink-0 text-fg-subtle" />
          {pricingBlockedBy}
        </div>
      ) : null}
    </div>
  )
}

function Row({
  index, line, priced, today, last, onPatch, onResolve, onRemove, onCreateMedicine,
}: {
  index: number
  line: DraftLine
  priced: PurchaseLine | undefined
  today: Date
  last: boolean
  onPatch: (lineId: string, patch: Partial<DraftLine>) => void
  onResolve: (lineId: string, m: Medicine, defaults: BatchDefaults | null) => void
  onRemove: (lineId: string) => void
  onCreateMedicine: (lineId: string, term: string) => void
}) {
  const medicineRef = useRef<HTMLInputElement>(null)
  const batchRef = useRef<HTMLInputElement>(null)
  const id = line.lineId
  const blank = isLineBlank(line)
  const issue = blank ? null : lineIssue(line, today)
  const rateChanged = priced?.rateChangedFrom ?? null
  const rateUp = rateChanged !== null && D.gt(D.dec(priced?.ratePerPack ?? '0'), D.dec(rateChanged))

  const patch = (p: Partial<DraftLine>) => onPatch(id, p)
  const money = (v: string) => v.replace(/[^\d.]/g, '')

  return (
    <div
      data-line-row
      className={cn(
        'border-b border-border-subtle',
        issue?.blocking && 'bg-danger-3/20',
        blank && 'bg-subtle/40',
      )}
    >
      <div className={cn(COLS, 'px-2')} style={{ height: 'var(--row-h)' }}>
        <span className="num text-center text-2xs text-fg-subtle">{blank && last ? '+' : index}</span>

        <MedicineCell
          line={line}
          inputRef={medicineRef}
          nextRef={batchRef}
          onText={(text) => patch({
            brandName: text,
            /* Retyping the name unresolves the row: the pack and the seeded
               defaults belonged to the medicine that was there a moment ago. */
            medicineId: null, packLabel: '', unitsPerPack: 1,
            ...(line.seededMrp ? { mrpPerPack: '', seededMrp: false } : {}),
            ...(line.seededGst ? { gstRatePct: '', seededGst: false } : {}),
          })}
          onResolve={(m, defaults) => onResolve(id, m, defaults)}
          onCreate={(term) => onCreateMedicine(id, term)}
        />

        <TextCell
          value={line.batchNo}
          onChange={(v) => patch({ batchNo: v.toUpperCase() })}
          ariaLabel="Batch number"
          placeholder="BATCH"
          mono
          inputRef={batchRef}
        />
        <TextCell
          value={line.expiry}
          onChange={(v) => patch({ expiry: maskExpiry(v) })}
          ariaLabel="Expiry, month and year"
          placeholder="MM/YY"
          mono
          invalid={line.expiry.trim() !== '' && expiryToIso(line.expiry) === null}
        />
        <TextCell value={line.qtyPacks} onChange={(v) => patch({ qtyPacks: money(v) })} ariaLabel="Quantity in packs" numeric />
        <TextCell value={line.freePacks} onChange={(v) => patch({ freePacks: money(v) })} ariaLabel="Free packs" numeric placeholder="0" />
        <TextCell
          value={line.mrpPerPack}
          onChange={(v) => patch({ mrpPerPack: money(v), seededMrp: false })}
          ariaLabel="MRP per pack"
          seeded={line.seededMrp}
          numeric
        />
        <TextCell value={line.ratePerPack} onChange={(v) => patch({ ratePerPack: money(v) })} ariaLabel="Rate per pack" numeric />
        <TextCell value={line.discountPct} onChange={(v) => patch({ discountPct: money(v) })} ariaLabel="Discount percent" numeric placeholder="0" />
        <TextCell
          value={line.gstRatePct}
          onChange={(v) => patch({ gstRatePct: money(v), seededGst: false })}
          ariaLabel="GST rate percent"
          seeded={line.seededGst}
          numeric
        />

        <span className="num text-base font-medium">
          {priced ? formatAmount(priced.lineTotal) : <span className="text-fg-disabled">—</span>}
        </span>
        {/* Printed as the decimal string the server sent, not through the money
            formatter: landed cost carries four places on a 40-paise tablet and
            rounding it to two here would hide the difference a scheme makes. */}
        <span
          className="num text-base text-fg-muted"
          title={priced ? `Over ${priced.qtyPacks} paid + ${priced.freePacks} free packs, freight included` : undefined}
        >
          {priced ? priced.landedCostPerUnit : <span className="text-fg-disabled">—</span>}
        </span>

        <button
          type="button"
          tabIndex={-1}
          onClick={() => onRemove(id)}
          aria-label={`Remove line ${index}`}
          disabled={blank && last}
          className="flex size-5 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-danger-3 hover:text-danger-9 disabled:pointer-events-none disabled:opacity-0"
        >
          <Trash2 size={13} aria-hidden />
        </button>
      </div>

      {/* One strip, and only when the row has something to say. On a forty-line
          bill a permanent second row per line is a screen and a half of nothing. */}
      {issue || rateChanged !== null ? (
        <div className="flex flex-wrap items-center gap-2 px-2 pb-1 pl-[26px]">
          {issue ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-2xs font-medium',
                issue.blocking ? 'bg-danger-3 text-danger-11' : 'bg-warning-3 text-warning-11',
              )}
            >
              <CircleAlert size={11} aria-hidden /> {issue.text}
            </span>
          ) : null}
          {rateChanged !== null ? (
            <span
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-info-3 px-1.5 text-2xs font-medium text-info-11"
              title="Compared with the last purchase of this medicine"
            >
              {rateUp ? <TrendingUp size={11} aria-hidden /> : <TrendingDown size={11} aria-hidden />}
              Rate {rateUp ? 'up' : 'down'} — last purchased at ₹{formatAmount(rateChanged)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
