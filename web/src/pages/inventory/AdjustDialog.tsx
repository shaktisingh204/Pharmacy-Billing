import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { ArrowRight, Check, Diff, ShieldOff, TriangleAlert } from 'lucide-react'
import type { BatchRow, StockAdjustmentInput } from '@contract'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'

/**
 * Stock adjustment, and the quarantine toggle, as DOCUMENTS.
 *
 * Marg's equivalent is `Closing Stock Feeding`: a grid of items where you type
 * over the number. No count sheet, no reason, no note, no record of what the
 * number used to be. That is not a stock-take feature, it is shrinkage cover —
 * an adjustment that leaves no trace of what it replaced cannot be audited, and
 * the person who most needs to make one untraceable is the person taking stock.
 *
 * So: the note is MANDATORY, the resulting balance is previewed before anything
 * is committed, and the result is a ledger row rather than a new value. Nothing
 * here edits `qtyOnHand`; the adjustment posts a movement and the balance
 * follows from it.
 */

const DECIMALISH = /^-?\d+(\.\d+)?$/

/** Accepts a typed unicode minus and a leading '+', because both get typed. */
function parseSigned(raw: string): D.Decimal | null {
  const s = raw.trim().replace(/[−–—]/g, '-').replace(/^\+/, '')
  return DECIMALISH.test(s) ? D.dec(s) : null
}

/** "−4.000" -> "−4". `toStr` at 3dp always emits the point, so the two passes
 *  can never eat a trailing zero out of an integer. */
function trimZeros(s: string): string {
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

function amount(raw: string): D.Decimal | null {
  const s = raw.trim()
  return DECIMALISH.test(s) ? D.dec(s) : null
}

const REASONS: Array<{ value: StockAdjustmentInput['reason']; label: string; help: string }> = [
  {
    value: 'ADJUSTMENT',
    label: 'Count correction',
    help: 'A physical count disagrees with the system. Say what you counted, and where — “counted 138 on rack B4, system said 142”.',
  },
  {
    value: 'EXPIRY_WRITEOFF',
    label: 'Expiry write-off',
    /* s.17(5)(h) blocks input tax credit on goods written off. Writing expired
       stock off here and quietly keeping the ITC is the commonest way a pharmacy
       fails a GST audit on stock it had already lost money on. */
    help: 'Only for expired stock that cannot go back to the supplier. Written-off goods block the input tax credit claimed on them (CGST s.17(5)(h)), so this needs to be evidenced.',
  },
]

/** The minimum a note has to be before it explains anything. "ok" is not a reason. */
const NOTE_MIN = 8

function Shell({
  open, onOpenChange, title, subtitle, children, width = 560,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  width?: number
}) {
  /* Claims the narrowest scope while open, so a key this dialog does not
     implement cannot reach the grid underneath and move the selection out from
     under the batch being adjusted. */
  useHotkeys('modal', {}, { enabled: open })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle px-[var(--card-px)] py-3">
            <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">{title}</Dialog.Title>
            {subtitle ? (
              <Dialog.Description className="mt-0.5 text-sm text-fg-muted">{subtitle}</Dialog.Description>
            ) : null}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Batch identity, repeated at the top of both dialogs. Adjusting the wrong batch
 *  is the single most expensive slip available on this screen. */
function BatchHeadline({ row }: { row: BatchRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
      <span className="text-base font-medium text-fg">{row.medicine.brandName}</span>
      <span className="text-xs text-fg-muted">{row.medicine.strengthText} · {row.medicine.packLabel}</span>
      <span className="ml-auto flex items-center gap-2">
        <span className="mono text-sm text-fg">{row.batch.batchNo}</span>
        <span className="mono text-xs text-fg-muted">exp {formatExpiry(row.batch.expiryDate)}</span>
        {row.batch.isQuarantined ? (
          <Chip icon={ShieldOff} tone="var(--status-quarantine)">Quarantined</Chip>
        ) : null}
      </span>
    </div>
  )
}

// ------------------------------------------------------------- adjustment ---

export function AdjustDialog({
  open, onOpenChange, row, busy, onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  row: BatchRow | null
  busy: boolean
  /** The parent owns the write and closes this on success, so a failure keeps
   *  the typed reason on screen instead of throwing it away. */
  onCommit: (input: StockAdjustmentInput) => void
}) {
  const [deltaText, setDeltaText] = useState('')
  const [reason, setReason] = useState<StockAdjustmentInput['reason']>('ADJUSTMENT')
  const [note, setNote] = useState('')

  /* Reset during render rather than in an effect: an effect would paint one frame
     of the previous batch's numbers against this batch's name. */
  const identity = `${open ? 'o' : 'c'}:${row?.batch.id ?? 0}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setDeltaText('')
    setReason('ADJUSTMENT')
    setNote('')
  }

  const batch = row?.batch ?? null
  const onHand = batch ? amount(batch.qtyOnHand) : null
  const delta = parseSigned(deltaText)
  const result = onHand !== null && delta !== null ? D.add(onHand, delta) : null

  const cost = batch ? amount(batch.landedCostPerUnit) : null
  const valueImpact = cost !== null && delta !== null ? D.mul(cost, D.abs(delta)) : null

  const trimmedNote = note.trim()

  const problem: string | null =
    deltaText.trim() === ''
      ? null
      : delta === null
        ? 'That is not a quantity. Type a signed number, for example −4 or 12.'
        : D.isZero(delta)
          ? 'An adjustment of zero moves nothing. Leave the batch alone instead.'
          : reason === 'EXPIRY_WRITEOFF' && !D.isNeg(delta)
            ? 'A write-off removes stock. Use a negative quantity, or pick “Count correction”.'
            : result !== null && D.isNeg(result)
              ? 'That takes the batch below zero. Stock never goes negative — recount before you post.'
              : null

  /**
   * A caution, deliberately NOT a block.
   *
   * Writing live stock off under the expiry code misstates the tax position: it
   * is the reason code that reverses the input tax credit under CGST s.17(5)(h),
   * and the batch it names still has shelf life and a supplier return window. It
   * is occasionally right anyway — stock destroyed in a fridge failure gets
   * written off before its printed date — so the operator is told what the code
   * means and left to decide, rather than being refused and left guessing.
   */
  const earlyWriteOff =
    row !== null && reason === 'EXPIRY_WRITEOFF' && row.bucket !== 'expired' && row.daysToExpiry >= 0

  const noteShort = trimmedNote !== '' && trimmedNote.length < NOTE_MIN
  const valid =
    batch !== null && delta !== null && !D.isZero(delta) && problem === null && trimmedNote.length >= NOTE_MIN

  const chosen = REASONS.find((r) => r.value === reason) ?? REASONS[0]

  function commit() {
    /* `busy` is guarded HERE and not only on the button, because ↵ in the
       quantity field commits too and key auto-repeat fires it again before the
       first post resolves. A double-click is a nuisance on most forms; here it
       is a second row in an append-only ledger that can only be offset, never
       deleted. */
    if (!valid || busy || batch === null || delta === null) return
    onCommit({
      batchId: batch.id,
      qtyDelta: D.toStr(delta, 3),
      reason,
      note: trimmedNote,
    })
  }

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust stock"
      subtitle="This posts a movement. It does not overwrite the balance — the balance follows from it."
      width={580}
    >
      {row ? <BatchHeadline row={row} /> : null}

      <div className="space-y-3 p-[var(--card-px)]">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
          <label className="block">
            <span className="micro-label mb-1 block">
              Quantity, signed<span className="text-danger-9"> *</span>
            </span>
            <span className="flex items-center gap-1.5">
              <input
                autoFocus
                value={deltaText}
                onChange={(e) => setDeltaText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) { e.preventDefault(); commit() } }}
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="−4"
                aria-label={`Signed quantity in ${row?.medicine.baseUom ?? 'base units'}`}
                aria-invalid={problem !== null}
                className={cn(
                  'num h-9 w-full rounded-[var(--radius-md)] border bg-surface px-2.5 text-base',
                  problem === null ? 'border-border' : 'border-danger-9',
                )}
              />
              <button
                type="button"
                onClick={() => {
                  const d = parseSigned(deltaText)
                  if (d !== null) setDeltaText(trimZeros(D.toStr(D.neg(d), 3)))
                }}
                title="Flip the sign"
                aria-label="Flip the sign"
                className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border text-fg-muted hover:bg-hover hover:text-fg"
              >
                <Diff size={15} aria-hidden />
              </button>
              <span className="shrink-0 text-xs text-fg-muted">{row?.medicine.baseUom ?? ''}</span>
            </span>
            <span className="mt-1 block text-2xs text-fg-subtle">
              Negative writes stock off. Positive corrects an undercount.
            </span>
          </label>

          <label className="block">
            <span className="micro-label mb-1 block">Reason<span className="text-danger-9"> *</span></span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as StockAdjustmentInput['reason'])}
              className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base text-fg"
            >
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <span className="mt-1 block text-2xs text-fg-subtle">{chosen?.help}</span>
          </label>
        </div>

        <label className="block">
          <span className="micro-label mb-1 block">
            What happened<span className="text-danger-9"> *</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Counted 138 on rack B4 against 142 in the system. Two strips found crushed in the carton."
            aria-invalid={noteShort}
            className={cn(
              'w-full resize-y rounded-[var(--radius-md)] border bg-surface px-2.5 py-2 text-base',
              noteShort ? 'border-danger-9' : 'border-border',
            )}
          />
          {/* Not a formality. An unexplained adjustment is indistinguishable from
              shrinkage, and this note is the only thing that separates the two. */}
          <span className={cn('mt-1 block text-2xs', noteShort ? 'text-danger-11' : 'text-fg-subtle')}>
            {noteShort
              ? 'Say what actually happened — this is the audit trail.'
              : 'Required. An unexplained adjustment is indistinguishable from shrinkage.'}
          </span>
        </label>

        {/* The preview. Nothing is committed until the operator has seen the
            number this leaves behind. */}
        <div className="rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-3 py-2.5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
            <span className="text-fg-muted">On hand now</span>
            <span className="num text-fg">
              {batch ? formatQty(batch.qtyOnHand) : '—'} <span className="text-2xs text-fg-subtle">{row?.medicine.baseUom}</span>
            </span>

            <span className="text-fg-muted">This adjustment</span>
            <span className={cn('num', delta === null ? 'text-fg-subtle' : D.isNeg(delta) ? 'text-danger-11' : 'text-success-11')}>
              {delta === null ? '—' : `${D.isNeg(delta) ? '' : '+'}${trimZeros(D.toStr(delta, 3))}`}
            </span>

            <span className="col-span-2 my-0.5 h-px bg-border-subtle" />

            <span className="flex items-center gap-1.5 font-medium text-fg">
              <ArrowRight size={13} aria-hidden className="text-fg-subtle" /> Resulting balance
            </span>
            <span
              className={cn(
                'num font-semibold',
                result === null ? 'text-fg-subtle' : D.isNeg(result) ? 'text-danger-11' : 'text-fg',
              )}
            >
              {result === null ? '—' : formatQty(trimZeros(D.toStr(result, 3)))}{' '}
              <span className="text-2xs font-normal text-fg-subtle">{row?.medicine.baseUom}</span>
            </span>

            <span className="text-fg-muted">Value at cost</span>
            <span className="num text-fg-muted">
              {valueImpact === null || delta === null
                ? '—'
                : `${D.isNeg(delta) ? '−' : '+'}${formatMoney(D.toStr(valueImpact, 2))}`}
            </span>
          </div>
        </div>

        {problem !== null ? (
          <p role="alert" className="flex items-start gap-1.5 text-2xs text-danger-11">
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
            {problem}
          </p>
        ) : earlyWriteOff && row ? (
          <p role="status" className="flex items-start gap-1.5 text-2xs text-warning-11">
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
            <span>
              This batch has <span className="num font-medium">{row.daysToExpiry}</span> days left and
              is not expired. Writing it off under expiry reverses the input tax credit on stock that
              could still be sold or returned to the supplier — use “Count correction” unless the
              goods are genuinely destroyed.
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <span className="text-2xs text-fg-subtle">
          Posts one ledger row. It cannot be edited or deleted afterwards — only offset by another adjustment.
        </span>
        <Button className="ml-auto" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={!valid || busy} onClick={commit}>
          <Check /> {busy ? 'Posting…' : 'Post adjustment'}
        </Button>
      </div>
    </Shell>
  )
}

// -------------------------------------------------------------- quarantine ---

/** Reasons a batch actually gets held, in the order they happen. */
const HOLD_REASONS = [
  'Awaiting return to supplier',
  'Damaged in storage',
  'CDSCO recall — batch withdrawn',
  'Under investigation, do not dispense',
]

export function QuarantineDialog({
  open, onOpenChange, row, busy, onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  row: BatchRow | null
  busy: boolean
  onCommit: (quarantined: boolean, note: string) => void
}) {
  const [note, setNote] = useState('')

  const identity = `${open ? 'o' : 'c'}:${row?.batch.id ?? 0}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setNote('')
  }

  const held = row?.batch.isQuarantined ?? false
  const next = !held
  const trimmed = note.trim()
  const valid = row !== null && trimmed.length >= NOTE_MIN

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={held ? 'Release from quarantine' : 'Quarantine this batch'}
      subtitle={
        held
          ? 'The batch becomes sellable again and FEFO can allocate it from the next bill.'
          : 'The quantity does not change. Nothing is written off — the stock simply stops being allocated.'
      }
      width={520}
    >
      {row ? <BatchHeadline row={row} /> : null}

      <div className="space-y-3 p-[var(--card-px)]">
        <p className="text-sm text-fg-muted">
          {held ? (
            <>
              Releasing puts <span className="num font-medium text-fg">{formatQty(row?.batch.qtyOnHand ?? '')}</span>{' '}
              {row?.medicine.baseUom} back in front of the counter. If it was held for a recall, be
              sure the recall has actually been lifted.
            </>
          ) : (
            <>
              A quarantined batch never allocates — not by FEFO, not by a manual batch pick at the
              till. Use it the moment stock is set aside for a supplier return, damaged, or recalled,
              so nobody dispenses it in the meantime.
            </>
          )}
        </p>

        {!held ? (
          <div className="flex flex-wrap gap-1.5">
            {HOLD_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setNote(r)}
                className="inline-flex h-7 items-center rounded-[var(--radius-full)] border border-border bg-surface px-2.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
              >
                {r}
              </button>
            ))}
          </div>
        ) : null}

        <label className="block">
          <span className="micro-label mb-1 block">Reason<span className="text-danger-9"> *</span></span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={held ? 'Supplier confirmed the recall is lifted on 04-09.' : 'Set aside for return to Medlife on the next visit.'}
            aria-invalid={trimmed !== '' && trimmed.length < NOTE_MIN}
            className={cn(
              'w-full resize-y rounded-[var(--radius-md)] border bg-surface px-2.5 py-2 text-base',
              trimmed !== '' && trimmed.length < NOTE_MIN ? 'border-danger-9' : 'border-border',
            )}
          />
          <span className="mt-1 block text-2xs text-fg-subtle">
            Required, both ways. A batch that goes in and out of quarantine with no reason recorded
            is a batch whose history nobody can reconstruct.
          </span>
        </label>
      </div>

      <div className="flex justify-end gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button
          variant={held ? 'primary' : 'danger'}
          disabled={!valid || busy}
          onClick={() => { if (valid) onCommit(next, trimmed) }}
        >
          <ShieldOff /> {busy ? 'Saving…' : held ? 'Release batch' : 'Quarantine batch'}
        </Button>
      </div>
    </Shell>
  )
}
