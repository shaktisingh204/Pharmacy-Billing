import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { ShieldCheck, ShieldOff, Tag, X } from 'lucide-react'
import type { BatchRow } from '@contract'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import type { Basis } from './analysis'
import { BASIS_SUFFIX, totalUnits, totalValue } from './analysis'

/**
 * Doing one thing to many batches.
 *
 * A recall names a manufacturer and a date range, not a batch, and answering it
 * one row at a time is how a shop takes forty minutes to pull stock that should
 * take two. So the grid selects, and three operations run over the selection:
 * hold, release, and print a label for each.
 *
 * What is deliberately NOT here is a bulk adjustment. An adjustment carries a
 * quantity and a reason per batch — "counted 138, system said 142" — and a
 * single number applied to forty batches is not a stock take, it is the
 * untraceable write-off this app exists to make impossible.
 */

/** The minimum a note has to be before it explains anything. Same bar as the
 *  single-batch dialog: a bulk action needs MORE justification, not less. */
const NOTE_MIN = 8

export function BulkBar({
  rows, basis, onLabels, onHold, onClear,
}: {
  rows: BatchRow[]
  basis: Basis
  onLabels: () => void
  onHold: () => void
  onClear: () => void
}) {
  if (rows.length === 0) return null
  const value = totalValue(rows, basis)
  const held = rows.filter((r) => r.batch.isQuarantined).length

  return (
    <div
      role="region"
      aria-label="Selected batches"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-accent-9/30 bg-accent-1 px-[var(--cell-px)] py-2"
    >
      <span className="flex items-baseline gap-1.5 text-sm text-fg">
        <span className="num text-base font-semibold">{rows.length}</span>
        {rows.length === 1 ? 'batch' : 'batches'} selected
        <span className="text-fg-muted">
          · <span className="num">{formatQty(totalUnits(rows))}</span> units ·{' '}
          <span className="num font-medium text-fg">₹{formatAmount(value)}</span> {BASIS_SUFFIX[basis]}
        </span>
        {held > 0 ? <span className="text-fg-muted">· <span className="num">{held}</span> already held</span> : null}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onLabels}><Tag /> Print labels</Button>
        <Button size="sm" onClick={onHold}><ShieldOff /> Quarantine or release</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear <Kbd>Esc</Kbd>
        </Button>
      </span>
    </div>
  )
}

/**
 * Hold or release a whole selection.
 *
 * A mixed selection is normal — you pull a manufacturer's shelf and half of it
 * is already held — so the dialog splits it and offers both actions with their
 * own counts rather than guessing at one intent and silently flipping the rest.
 */
export function BulkHoldDialog({
  open, onOpenChange, rows, basis, busy, progress, onCommit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  rows: BatchRow[]
  basis: Basis
  busy: boolean
  /** "3 of 12" while the writes are posting, so a long run is not a frozen button. */
  progress: { done: number; total: number } | null
  onCommit: (quarantined: boolean, note: string, targets: BatchRow[]) => void
}) {
  const [note, setNote] = useState('')

  const identity = `${open ? 'o' : 'c'}:${rows.length}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setNote('')
  }

  useHotkeys('modal', {}, { enabled: open })

  const toHold = rows.filter((r) => !r.batch.isQuarantined)
  const toRelease = rows.filter((r) => r.batch.isQuarantined)
  const trimmed = note.trim()
  const valid = trimmed.length >= NOTE_MIN

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(620px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]">
          <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-[var(--card-px)] py-3">
            <ShieldOff size={18} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">
                Hold or release {rows.length} {rows.length === 1 ? 'batch' : 'batches'}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
                Quantities do not change. A held batch simply stops being allocated — not by FEFO,
                and not by a manual batch pick at the till.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex shrink-0 flex-wrap gap-x-8 gap-y-2 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
            <Split label="On the shelf now" value={toHold.length} />
            <Split label="Already held" value={toRelease.length} />
            <Split label={`Value ${BASIS_SUFFIX[basis]}`} value={formatMoney(totalValue(rows, basis))} />
          </div>

          <div className="scroll-region min-h-0 flex-1 px-[var(--card-px)] py-3">
            <label className="block">
              <span className="micro-label mb-1 block">Reason<span className="text-danger-9"> *</span></span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Recall notice from Cipla dated 04-09 — pulling every batch of this lot."
                aria-invalid={trimmed !== '' && !valid}
                aria-label="Reason"
                className={cn(
                  'w-full resize-y rounded-[var(--radius-md)] border bg-surface px-2.5 py-2 text-base',
                  trimmed !== '' && !valid ? 'border-danger-9' : 'border-border',
                )}
              />
              <span className="mt-1 block text-2xs text-fg-subtle">
                {/* One reason for the whole run, on purpose: a bulk hold has one
                    cause, and the ledger row on every batch will carry it. */}
                Written onto every batch in the run. Required both ways — a batch that goes in and
                out of quarantine with no reason recorded is a batch whose history nobody can
                reconstruct.
              </span>
            </label>

            <h3 className="micro-label mt-4">What will change</h3>
            <ul className="mt-1.5 divide-y divide-border-subtle rounded-[var(--radius-md)] border border-border-subtle">
              {rows.slice(0, 12).map((r) => (
                <li key={r.batch.id} className="flex items-baseline gap-2 px-2.5 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-fg">{r.medicine.brandName}</span>
                  <span className="mono shrink-0 text-xs text-fg-muted">{r.batch.batchNo}</span>
                  <span className="mono num shrink-0 text-xs text-fg-subtle">
                    {formatExpiry(r.batch.expiryDate)}
                  </span>
                  <span className="shrink-0 text-2xs text-fg-muted">
                    {r.batch.isQuarantined ? 'held' : 'on the shelf'}
                  </span>
                </li>
              ))}
              {rows.length > 12 ? (
                <li className="px-2.5 py-1.5 text-2xs text-fg-subtle">
                  and <span className="num">{rows.length - 12}</span> more
                </li>
              ) : null}
            </ul>
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-[var(--card-px)] py-2.5">
            {progress ? (
              <span role="status" className="text-2xs text-fg-muted">
                <span className="num">{progress.done}</span> of{' '}
                <span className="num">{progress.total}</span> posted…
              </span>
            ) : (
              <span className="text-2xs text-fg-subtle">
                Each batch gets its own ledger row. Nothing is written off here.
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button
                variant="primary"
                disabled={!valid || busy || toRelease.length === 0}
                onClick={() => onCommit(false, trimmed, toRelease)}
              >
                <ShieldCheck /> Release {toRelease.length}
              </Button>
              <Button
                variant="danger"
                disabled={!valid || busy || toHold.length === 0}
                onClick={() => onCommit(true, trimmed, toHold)}
              >
                <ShieldOff /> Quarantine {toHold.length}
              </Button>
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Split({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <span className="micro-label block">{label}</span>
      <span className="num text-base font-semibold text-fg">
        {typeof value === 'number' ? value.toLocaleString('en-IN') : value}
      </span>
    </div>
  )
}
