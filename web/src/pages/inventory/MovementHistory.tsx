import { History, Lock, ScrollText, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { LedgerReason, Qty, StockMovement } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatQty } from '@/lib/format'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'

/**
 * The stock ledger for one batch, or for every batch of one medicine.
 *
 * APPEND-ONLY. A correction is another row, never an edit — the screen says so
 * in the footer because the operator has to believe it before they will trust
 * anything else here. Marg ships "Resave All Purchase Bills" and "Data Re-save &
 * Posting" utilities, which exist because its ledger is a materialised posting
 * that drifts; a ledger you can rebuild is a ledger that proves nothing.
 *
 * Three deliberate choices:
 *
 *  - `balanceAfter` is READ, never recomputed. Summing the deltas in the view
 *    would produce a column that always foots, which is precisely the failure the
 *    balance exists to expose. When it disagrees with `batches.qtyOnHand` this
 *    component says so, loudly (invariant I17).
 *  - In and Out are separate columns. A single signed number makes the reader do
 *    sign arithmetic on every row while they are already doing subtraction.
 *  - Only ADJUSTMENT and EXPIRY_WRITEOFF carry colour. Every row here is a real
 *    movement, but those two are the ones a human typed a reason for, and they
 *    are what an audit walk is looking for.
 */

export type MovementScope = 'batch' | 'item'
export type LedgerStatus = 'ready' | 'loading' | 'error'

const REASON_LABEL: Record<LedgerReason, string> = {
  OPENING: 'Opening',
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  SALE_RETURN: 'Sale return',
  PURCHASE_RETURN: 'Purchase return',
  ADJUSTMENT: 'Adjustment',
  EXPIRY_WRITEOFF: 'Expiry write-off',
  TRANSFER: 'Transfer',
}

/**
 * The reason chip says WHY stock moved; this says WHICH document did it. A raw
 * idempotency key or an ISO timestamp is still the traceable handle, but it is
 * thirty characters of noise in a 200px column — anything long lives in the
 * tooltip and only the document kind stays on screen.
 */
const REF_LABEL: Record<string, string> = {
  SALE_INVOICE: 'Invoice',
  PURCHASE_INVOICE: 'GRN',
  STOCK_ADJUSTMENT: 'Adjustment',
  QUARANTINE: 'Hold',
  QUARANTINE_RELEASE: 'Release',
  SEED: 'Seed',
  CREDIT_NOTE: 'Credit note',
  SALE_VOID: 'Cancelled bill',
  /* Named after the DOCUMENT, not the movement. The reason chip beside this
     already says stock left the shelf; what this column adds is which piece of
     paper did it — and for these two that is the entire distinction between a
     debit note reducing a supplier's bill and a claim the shop has yet to be
     paid for. */
  PURCHASE_RETURN: 'Debit note',
  EXPIRY_CLAIM: 'Expiry claim',
  /* Named after the paper, on BOTH sides of the move: the branch that sent it
     and the branch that received it each see the same document number, which is
     the only way a receiving shop can explain where its stock came from. */
  STOCK_TRANSFER: 'Branch transfer',
}

function refText(reason: LedgerReason, refType: string, refId: string): string {
  const kind = REF_LABEL[refType] ?? refType.toLowerCase().replace(/_/g, ' ')
  const id = refId.trim()
  if (id !== '' && id.length <= 16) return `${kind} ${id}`
  /* With no id left to show, a kind that merely repeats the reason chip
     ("Adjustment · Adjustment") spends a column on nothing. A quarantine, which
     the contract records as an ADJUSTMENT of zero, keeps its "Hold" — there the
     document type is the only thing that says what actually happened. */
  return kind.toLowerCase() === REASON_LABEL[reason].toLowerCase() ? '' : kind
}

const REASON_TONE: Partial<Record<LedgerReason, string>> = {
  ADJUSTMENT: 'var(--warning-11)',
  EXPIRY_WRITEOFF: 'var(--status-expired)',
}

// Built once at module scope: a formatter per row is measurable in a long ledger.
const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
const FULL = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })

const DECIMALISH = /^-?\d+(\.\d+)?$/

function qty(raw: string): D.Decimal | null {
  const s = raw.trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

/** One template for both scopes: the batch number rides in the second column
 *  rather than claiming one of its own, so the balance never loses width. */
const COLS = '68px minmax(0,1fr) 52px 52px 66px'

export function MovementHistory({
  movements,
  status,
  errorMessage,
  scope,
  onScopeChange,
  brandName,
  batchNo,
  expectedBalance,
  limit,
  onRetry,
}: {
  movements: StockMovement[]
  status: LedgerStatus
  errorMessage?: string
  scope: MovementScope
  onScopeChange: (s: MovementScope) => void
  brandName: string
  batchNo: string
  /**
   * `batches.qtyOnHand` for the selected batch. The newest movement's
   * `balanceAfter` must equal it; anything else is a real alarm.
   */
  expectedBalance: Qty | null
  /** How many rows were asked for. A full page means older movements exist. */
  limit: number
  onRetry: () => void
}) {
  /* Newest first, tie-broken on id: two movements can share a timestamp to the
     millisecond, and a list that reorders itself between renders is unreadable. */
  const rows = [...movements].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  const newest = rows.at(0)
  /* A full page is the only evidence available that there is more behind it —
     `listMovements` returns rows, not a cursor. Erring toward saying so is right:
     claiming the ledger is complete when it is not is the costlier mistake. */
  const truncated = rows.length >= limit

  const expected = expectedBalance === null ? null : qty(expectedBalance)
  const recorded = newest ? qty(newest.balanceAfter) : null
  const drift =
    scope === 'batch' && expected !== null && recorded !== null ? D.sub(expected, recorded) : null
  const reconciled = drift !== null && D.isZero(drift)

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Stock ledger">
      <header className="flex h-8 shrink-0 items-center gap-2 border-y border-border-subtle bg-subtle px-[var(--card-px)]">
        <ScrollText size={13} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="text-sm font-medium text-fg">Ledger</span>
        {/* The positive result of invariant I17, stated where it is cheap. The
            negative result gets the banner below, because an alarm has to cost
            more attention than an all-clear. */}
        {reconciled ? (
          <span className="flex items-center gap-1 text-2xs text-success-11">
            <ShieldCheck size={11} aria-hidden /> reconciled
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5 rounded-[var(--radius-full)] border border-border-subtle bg-surface p-0.5">
          <ScopeButton on={scope === 'batch'} onClick={() => onScopeChange('batch')} title={`Movements for batch ${batchNo} only`}>
            This batch
          </ScopeButton>
          {/* A discrepancy is FOUND at item level and RESOLVED at batch level, so
              both have to be one click apart. */}
          <ScopeButton on={scope === 'item'} onClick={() => onScopeChange('item')} title={`Every batch of ${brandName}`}>
            All batches
          </ScopeButton>
        </div>
      </header>

      {drift !== null && !reconciled ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-danger-9/25 bg-danger-3 px-[var(--card-px)] py-2"
        >
          <TriangleAlert size={14} className="mt-px shrink-0 text-danger-9" aria-hidden />
          <p className="text-2xs text-danger-11">
            <span className="font-semibold">The ledger does not reconcile.</span>{' '}
            Stock on hand says <span className="num font-medium">{formatQty(expectedBalance ?? '')}</span>,
            the last movement closed at <span className="num font-medium">{formatQty(newest?.balanceAfter ?? '')}</span> —
            a gap of <span className="num font-medium">{D.toStr(drift, 3)}</span>. Something wrote stock
            without writing a movement. Do not adjust it away; report it.
          </p>
        </div>
      ) : null}

      <div
        role="row"
        className="grid shrink-0 items-center gap-1.5 border-b border-border-subtle px-[var(--card-px)] py-0.5"
        style={{ gridTemplateColumns: COLS }}
      >
        <span className="micro-label">When</span>
        <span className="micro-label">Reason &amp; document</span>
        <span className="micro-label text-right">In</span>
        <span className="micro-label text-right">Out</span>
        <span className="micro-label text-right" title="Balance of THIS batch after the movement">
          {scope === 'batch' ? 'Balance' : 'Batch bal.'}
        </span>
      </div>

      <div className="scroll-region min-h-0 flex-1">
        {status === 'loading' ? (
          <SkeletonRows rows={6} cols={4} />
        ) : status === 'error' ? (
          <ErrorState code="MOVEMENTS_FAILED" message={errorMessage} onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={History}
            title="No movement recorded"
            body={
              expected !== null && D.gt(expected, D.ZERO)
                ? 'This batch holds stock but has no ledger row behind it. Stock that arrived without a document is exactly what a stock audit cannot explain.'
                : scope === 'item'
                  ? `Nothing has moved in or out of any batch of ${brandName}.`
                  : 'Nothing has moved in or out of this batch yet.'
            }
          />
        ) : (
          rows.map((m) => <Row key={m.id} movement={m} scope={scope} />)
        )}
      </div>

      <footer className="shrink-0 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
        <p className="flex items-start gap-1.5 text-2xs text-fg-muted">
          <Lock size={11} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
          <span>
            Append-only. <span className="font-medium text-fg">A correction is another row, never an edit</span> —
            nothing here can be changed or deleted, by anyone.
          </span>
        </p>
        {/* Said out loud, because this panel is read to settle a discrepancy. A
            ledger that quietly stops at the newest hundred rows lets an operator
            conclude "nothing else touched this batch" from a window, and that is
            the one wrong answer an audit walk must never be handed. */}
        {truncated ? (
          <p className="mt-1 flex items-start gap-1.5 text-2xs text-fg-subtle">
            <History size={11} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Newest {limit.toLocaleString('en-IN')} movements only — older rows exist and are not
              loaded. Each row carries the balance it closed at, so the balance column reads true
              even where the movement before it is off screen.
            </span>
          </p>
        ) : null}
      </footer>
    </section>
  )
}

function ScopeButton({
  on, onClick, title, children,
}: {
  on: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={cn(
        'h-5 rounded-[var(--radius-full)] px-2 text-2xs transition-colors duration-[var(--dur-fast)]',
        on ? 'bg-accent-3 font-medium text-accent-11' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function Row({ movement, scope }: { movement: StockMovement; scope: MovementScope }) {
  const delta = qty(movement.qtyDelta)
  const inbound = delta !== null && D.gt(delta, D.ZERO)
  const outbound = delta !== null && D.isNeg(delta)
  const tone = REASON_TONE[movement.reason]

  const parsed = Date.parse(movement.at)
  const stamped = Number.isFinite(parsed) ? new Date(parsed) : null
  const doc = refText(movement.reason, movement.refType, movement.refId)

  return (
    <div
      role="row"
      className={cn(
        'grid items-start gap-1.5 border-b border-border-subtle px-[var(--card-px)] py-1 last:border-0',
        tone && 'bg-subtle/60',
      )}
      style={{ gridTemplateColumns: COLS }}
    >
      <span
        className="mono text-2xs text-fg-muted"
        title={stamped ? FULL.format(stamped) : movement.at}
      >
        {stamped ? DAY.format(stamped) : '—'}
      </span>

      {/* One line per movement unless there is a note. A ledger read to find a
          discrepancy is scanned down the balance column, and a three-line row
          turns twenty movements into a scroll. */}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Chip tone={tone}>{REASON_LABEL[movement.reason]}</Chip>
          {scope === 'item' ? (
            <span className="mono shrink-0 text-2xs text-fg-muted" title={`Batch ${movement.batchNo}`}>
              {movement.batchNo}
            </span>
          ) : null}
          <span className="truncate text-2xs text-fg-subtle" title={`${movement.refType} ${movement.refId}`}>
            {stamped ? TIME.format(stamped) : ''}
            {doc ? ` · ${doc}` : ''}
          </span>
        </span>
        {movement.note ? (
          /* The note is the whole point of an adjustment row. It is the only thing
             standing between "we recounted shelf 4B" and unexplained shrinkage. */
          <span
            className={cn(
              'border-l-2 pl-1.5 text-2xs text-fg-muted',
              tone ? 'border-warning-9/50' : 'border-border',
            )}
          >
            {movement.note}
          </span>
        ) : null}
      </span>

      <span className="num text-xs text-success-11">{inbound ? formatQty(movement.qtyDelta) : ''}</span>
      <span className="num text-xs text-danger-11">
        {outbound && delta !== null ? formatQty(D.toStr(D.abs(delta), 3)) : ''}
      </span>
      <span className="num text-xs font-medium text-fg">{formatQty(movement.balanceAfter)}</span>
    </div>
  )
}
