import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { MapPin, PackageMinus, Power, TriangleAlert, X } from 'lucide-react'
import type { MedicineRow } from '@contract'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'

/**
 * Bulk edits, restricted to the three fields that are safe to change in bulk.
 *
 * Rack and reorder level are per-store operational metadata: no invoice, ledger
 * row or return references either, so setting three hundred of them at once is
 * a tidy-up, not a restatement. Delisting is reversible and touches no history.
 *
 * Everything else is deliberately absent. Pack size, MRP, HSN and schedule all
 * change what a document SAYS, and a bulk write over rows nobody has read one
 * by one is how a hundred invoices end up with the wrong tariff heading. Those
 * stay in the form, one item at a time, with the duplicate check running.
 */

type Field = 'rack' | 'reorder'

export function MedicineBulkBar({
  rows,
  selectedIds,
  busy,
  onClear,
  onSetRack,
  onSetReorder,
  onSetActive,
}: {
  /** The loaded page. Ticks can only exist for rows the operator has seen. */
  rows: MedicineRow[]
  selectedIds: ReadonlySet<number>
  busy: boolean
  onClear: () => void
  onSetRack: (rack: string) => void
  onSetReorder: (level: number) => void
  onSetActive: (next: boolean) => void
}) {
  const [field, setField] = useState<Field | null>(null)

  const picked = rows.filter((r) => selectedIds.has(r.medicine.id))
  const live = picked.filter((r) => r.medicine.isActive).length
  const delisted = picked.length - live

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions on the ticked items"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b border-accent-6/60 bg-accent-2 px-[var(--cell-px)] py-2',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-accent-11">
        <span className="num rounded-[var(--radius-full)] bg-accent-10 px-2 py-0.5 text-2xs font-semibold text-fg-on-accent">
          {selectedIds.size}
        </span>
        ticked
      </span>

      <span aria-hidden className="mx-0.5 h-5 w-px bg-accent-6" />

      <Button size="sm" onClick={() => setField('rack')} disabled={busy}>
        <MapPin /> Set rack…
      </Button>
      <Button size="sm" onClick={() => setField('reorder')} disabled={busy}>
        <PackageMinus /> Set reorder level…
      </Button>
      {live > 0 ? (
        <Button size="sm" onClick={() => onSetActive(false)} disabled={busy}>
          <Power /> Delist {live}
        </Button>
      ) : null}
      {delisted > 0 ? (
        <Button size="sm" onClick={() => onSetActive(true)} disabled={busy}>
          <Power /> Relist {delisted}
        </Button>
      ) : null}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-sm text-accent-11 hover:bg-white/60"
      >
        <X size={14} aria-hidden /> Clear
      </button>

      <BulkFieldDialog
        field={field}
        count={selectedIds.size}
        onClose={() => setField(null)}
        onApply={(value) => {
          setField(null)
          if (field === 'rack') onSetRack(value.trim())
          else if (field === 'reorder') onSetReorder(Number(value))
        }}
      />
    </div>
  )
}

const COPY: Record<Field, {
  title: string
  description: string
  label: string
  hint: string
  placeholder: string
}> = {
  rack: {
    title: 'Set the rack',
    description:
      'Where these items sit on the shelf. Per-store metadata — no bill, ledger row or return references it, so this is safe to change in bulk.',
    label: 'Rack or bin',
    hint: 'Leave it empty to clear the rack on every ticked item.',
    placeholder: 'A-3',
  },
  reorder: {
    title: 'Set the reorder level',
    description:
      'The trigger, in base units, below which the purchase suggestion proposes these items. Zero means it never will.',
    label: 'Reorder level',
    hint: 'A whole number of base units — tablets, not strips.',
    placeholder: '100',
  },
}

function BulkFieldDialog({
  field, count, onClose, onApply,
}: {
  field: Field | null
  count: number
  onClose: () => void
  onApply: (value: string) => void
}) {
  const [value, setValue] = useState('')

  /* Reset as the dialog opens on a different field, during render rather than
     from an effect so the first paint already carries the right box. */
  const identity = field ?? 'closed'
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    setValue('')
  }

  const copy = field === null ? null : COPY[field]
  const level = Number(value)
  const badLevel = field === 'reorder'
    && (value.trim() === '' || !Number.isSafeInteger(level) || level < 0)
  /* An empty box is not yet wrong — it is untouched. What must never happen is
     a red border and nothing else: the refusal is said in words, because a
     colour on its own is not a message. */
  const rejected = badLevel && value.trim() !== ''

  return (
    <Dialog.Root open={field !== null} onOpenChange={(v) => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 460 }}
          className="fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!badLevel) onApply(value)
            }}
          >
            <div className="border-b border-border-subtle px-[var(--card-px)] py-3.5">
              <Dialog.Title className="text-lg font-semibold">{copy?.title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-fg-muted">
                {copy?.description}
              </Dialog.Description>
            </div>

            <div className="px-[var(--card-px)] py-4">
              <label className="block">
                <span className="micro-label">{copy?.label}</span>
                <input
                  // Focused on mount by Radix's own autofocus contract, which is
                  // why this is the first focusable thing in the content.
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  inputMode={field === 'reorder' ? 'numeric' : 'text'}
                  maxLength={field === 'reorder' ? 7 : 16}
                  placeholder={copy?.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={rejected ? true : undefined}
                  aria-describedby={rejected ? 'bulk-field-problem' : undefined}
                  className={cn(
                    'mt-1 h-[var(--control-h)] w-full rounded-[var(--radius-lg)] border bg-surface px-3 text-base',
                    field === 'reorder' ? 'num text-left' : 'mono',
                    rejected ? 'border-danger-9' : 'border-border hover:border-border-strong',
                  )}
                />
              </label>
              {rejected ? (
                <p id="bulk-field-problem" role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger-11">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" aria-hidden />
                  A reorder level is a whole number of base units, zero or more.
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-fg-muted">{copy?.hint}</p>
              )}

              <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-lg)] bg-subtle px-3 py-2 text-sm text-fg">
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warning-9" aria-hidden />
                <span>
                  This writes <span className="num font-semibold">{count}</span> item
                  {count === 1 ? '' : 's'}. Every one can be put back from the toast that follows.
                </span>
              </p>
            </div>

            <div className="flex items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-3">
              <Button type="submit" variant="primary" disabled={badLevel}>
                Apply to {count} item{count === 1 ? '' : 's'}
              </Button>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">Cancel</Button>
              </Dialog.Close>
              <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
                <Kbd>Esc</Kbd> cancel
              </span>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
