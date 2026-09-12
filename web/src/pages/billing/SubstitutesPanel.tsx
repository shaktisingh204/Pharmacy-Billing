import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, FlaskConical, PackageSearch } from 'lucide-react'
import type { MedicineSearchHit, Money } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Kbd } from '@/components/ui/Kbd'
import { ScheduleChip, StockChip } from '@/components/ui/Badge'
import { EmptyState, SkeletonRows } from '@/components/states'

const COLS = 'grid grid-cols-[minmax(150px,1fr)_130px_78px_120px_82px_150px] items-center gap-2'

/**
 * F7 — the substitutes list.
 *
 * Substitution is the most common conversation at the counter (the prescribed
 * brand is out, or the customer wants the cheaper one) and it is a SALT match,
 * never a brand-name match. The composition is therefore stated at the top: an
 * operator who cannot see what was matched cannot defend the swap to the
 * customer, and swapping on anything but the salt is a dispensing error.
 */
export function SubstitutesPanel({
  open,
  onOpenChange,
  medicineId,
  brandName,
  onPick,
  currentMrp,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  medicineId: number | null
  brandName: string
  /** Adds the chosen substitute to the cart. */
  onPick: (hit: MedicineSearchHit) => void
  /** Shown for comparison; may be null when nothing is focused. */
  currentMrp: Money | null
}) {
  const api = useApi()
  /* Exclusive while open, or Num ↵ saves and prints the bill from under it. */
  useHotkeys('modal', {}, { enabled: open })

  const enabled = open && medicineId !== null

  const { data: subs = [], isPending } = useQuery({
    queryKey: ['substitutes', medicineId],
    queryFn: () => api.findSubstitutes(medicineId ?? 0),
    enabled,
  })

  /* The salt comes from the medicine itself, not from the first result: it has to
     be on screen precisely when the list is EMPTY, which is when the operator
     needs to know what was searched for. */
  const { data: source = null } = useQuery({
    queryKey: ['medicine', medicineId],
    queryFn: async () => (await api.getMedicines([medicineId ?? 0]))[0] ?? null,
    enabled,
  })

  const [active, setActive] = useState(0)
  useEffect(() => { if (open) setActive(0) }, [open, medicineId])

  /* The dialog opens on a skeleton, so Radix's mount-time focus lands on the
     content wrapper and the list does not exist yet to receive it. Without this
     the arrow keys are dead from the moment the rows arrive — which is the only
     moment they matter. */
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (subs.length > 0) listRef.current?.focus() }, [subs.length])

  function commit(hit: MedicineSearchHit | undefined) {
    if (!hit) return
    onPick(hit)
    onOpenChange(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Ctrl+Enter and Ctrl+S still belong to the bill even with this open.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, subs.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(subs.length - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(subs[active]) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 880 }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">Substitutes for {brandName}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              Matched on composition, not on brand. Only stock that can be dispensed today is listed.
            </Dialog.Description>
          </div>

          <div className="flex items-baseline gap-2 border-b border-border-subtle bg-subtle px-4 py-2">
            <FlaskConical size={14} className="translate-y-0.5 shrink-0 text-fg-subtle" aria-hidden />
            <span className="micro-label shrink-0">Composition</span>
            <span className="truncate text-sm font-medium text-fg">{source?.compositionText ?? '—'}</span>
            {currentMrp !== null && (
              <span className="ml-auto shrink-0 text-xs text-fg-muted">
                {brandName} at <span className="num text-fg">{formatAmount(currentMrp)}</span> per unit
              </span>
            )}
          </div>

          {isPending && enabled ? (
            <SkeletonRows rows={5} cols={6} />
          ) : subs.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title="No in-stock alternative shares this composition."
              body="An expired or quarantined batch is not an alternative, so it is not counted here."
            />
          ) : (
            <>
              <div className={cn(COLS, 'border-b border-border-subtle bg-subtle px-4 py-1.5')}>
                <span className="micro-label">Brand</span>
                <span className="micro-label">Manufacturer</span>
                <span className="micro-label">Pack</span>
                <span className="micro-label">Stock</span>
                <span className="micro-label text-right">MRP / unit</span>
                <span className="micro-label truncate text-right">vs {brandName}</span>
              </div>
              <div
                ref={listRef}
                role="listbox"
                aria-label={`Substitutes for ${brandName}`}
                tabIndex={0}
                onKeyDown={onKeyDown}
                aria-activedescendant={subs[active] ? `sub-${subs[active].medicine.id}` : undefined}
                className="scroll-region max-h-[46vh]"
              >
                {subs.map((hit, i) => (
                  <Row
                    key={hit.medicine.id}
                    hit={hit}
                    currentMrp={currentMrp}
                    active={i === active}
                    onPick={() => commit(hit)}
                    onHover={() => setActive(i)}
                  />
                ))}
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-1.5 border-t border-border-subtle bg-subtle px-4 py-2 text-2xs text-fg-subtle">
            <Kbd>↑</Kbd><Kbd>↓</Kbd> to move · <Kbd>↵</Kbd> to add · <Kbd>Esc</Kbd> to close
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({ hit, currentMrp, active, onPick, onHover }: {
  hit: MedicineSearchHit
  currentMrp: Money | null
  active: boolean
  onPick: () => void
  onHover: () => void
}) {
  const m = hit.medicine
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }) }, [active])

  return (
    <div
      ref={ref}
      id={`sub-${m.id}`}
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseEnter={onHover}
      className={cn(
        COLS,
        'relative cursor-pointer border-b border-border-subtle px-4 py-2 text-sm',
        active ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-9" />}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn('truncate font-medium', active && 'text-accent-11')}>{m.brandName}</span>
        <span className="shrink-0 text-xs text-fg-muted">{m.strengthText}</span>
        <ScheduleChip code={m.drugSchedule} />
      </span>
      <span className="truncate text-xs text-fg-muted">{m.manufacturer}</span>
      <span className="truncate text-xs text-fg-muted">{m.packLabel}</span>
      <span><StockChip qty={Number(hit.stockQty)} reorderLevel={m.reorderLevel} /></span>
      <span className="num">{hit.fefoBatch ? formatAmount(hit.fefoBatch.mrpPerUnit) : '—'}</span>
      <Delta mrpPerUnit={hit.fefoBatch?.mrpPerUnit ?? null} currentMrp={currentMrp} />
    </div>
  )
}

/**
 * The price difference, which is the whole reason the operator opened this.
 *
 * Signed AND worded: a saving that reads only as green is invisible to a
 * meaningful share of pharmacists, and on a matte counter panel at an angle it is
 * invisible to everyone. The arithmetic goes through the decimal module — money
 * is never subtracted as a JS number.
 */
function Delta({ mrpPerUnit, currentMrp }: { mrpPerUnit: Money | null; currentMrp: Money | null }) {
  if (mrpPerUnit === null || currentMrp === null) {
    return <span className="text-right text-xs text-fg-subtle">—</span>
  }

  const diff = D.round(D.sub(D.dec(mrpPerUnit), D.dec(currentMrp)), 2)
  if (D.isZero(diff)) {
    return <span className="text-right text-xs text-fg-muted">Same price</span>
  }

  const cheaper = D.isNeg(diff)
  return (
    <span
      className="flex items-baseline justify-end gap-1 whitespace-nowrap text-xs font-medium"
      style={{ color: cheaper ? 'var(--success-11)' : 'var(--danger-11)' }}
    >
      {cheaper
        ? <ArrowDown size={12} strokeWidth={2.5} className="translate-y-0.5 shrink-0" aria-hidden />
        : <ArrowUp size={12} strokeWidth={2.5} className="translate-y-0.5 shrink-0" aria-hidden />}
      <span className="num">{cheaper ? '−' : '+'}{formatAmount(D.toStr(D.abs(diff), 2))}</span>
      <span>{cheaper ? 'cheaper' : 'dearer'}</span>
    </span>
  )
}
