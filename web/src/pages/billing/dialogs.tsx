import { useEffect, useMemo, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useQuery } from '@tanstack/react-query'
import { Check, Search } from 'lucide-react'
import type { Batch, Customer, PrescriptionInput } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry } from '@/lib/format'
import { daysUntil } from '@/lib/format'
import { expiryBucket } from '@/lib/expiry'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { ExpiryChip } from '@/components/ui/Badge'

function Shell({ open, onOpenChange, title, subtitle, children, width = 560 }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  subtitle?: string
  children: React.ReactNode
  width?: number
}) {
  /* Claims the narrowest scope while open. A dialog that binds nothing lets every
     key it does not implement reach the billing screen underneath — which is how
     F2 over an open batch picker discarded the whole bill. Radix already owns
     Escape at the capture phase, so this deliberately handles nothing. */
  useHotkeys('modal', {}, { enabled: open })

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            {subtitle && <Dialog.Description className="mt-0.5 text-sm text-fg-muted">{subtitle}</Dialog.Description>}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * F3 — manual batch selection.
 *
 * Landed cost is deliberately absent unless the operator may see it: a cashier
 * being able to read the shop's buying price off the till is a real leak.
 */
export function BatchPicker({
  open, onOpenChange, medicineId, brandName, today, onPick, canViewCost,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  medicineId: number | null
  brandName: string
  today: string
  onPick: (batch: Batch, reason: string) => void
  canViewCost: boolean
}) {
  const api = useApi()
  const [reason, setReason] = useState('Customer requested a specific batch')
  const { data: batches = [] } = useQuery({
    queryKey: ['stock', 'batches', medicineId],
    queryFn: () => api.getBatches(medicineId ?? 0),
    enabled: open && medicineId !== null,
  })
  const [active, setActive] = useState(0)
  const sorted = useMemo(
    () => [...batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.id - b.id),
    [batches],
  )
  useEffect(() => { if (open) setActive(0) }, [open, medicineId])

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={`Batches — ${brandName}`}
      subtitle="First-expiry-first-out is pre-selected. Overriding it is recorded with a reason." width={760}>
      <div className="scroll-region max-h-[46vh]">
        <div className="grid grid-cols-[1fr_84px_84px_72px_88px_88px_64px] gap-2 border-b border-border-subtle bg-subtle px-4 py-1.5">
          <span className="micro-label">Batch</span>
          <span className="micro-label">Expiry</span>
          <span className="micro-label text-right">Days</span>
          <span className="micro-label text-right">Qty</span>
          <span className="micro-label text-right">MRP</span>
          <span className="micro-label text-right">{canViewCost ? 'Cost' : ''}</span>
          <span className="micro-label">Rack</span>
        </div>
        {sorted.map((b, i) => {
          const days = daysUntil(b.expiryDate, new Date(`${today}T00:00:00`))
          const bucket = expiryBucket(b.expiryDate, new Date(`${today}T00:00:00`))
          const dead = b.isQuarantined || days < 0 || Number(b.qtyOnHand) <= 0
          return (
            <button
              key={b.id}
              type="button"
              disabled={dead}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(b, reason)}
              className={cn(
                'grid w-full grid-cols-[1fr_84px_84px_72px_88px_88px_64px] items-center gap-2 border-b border-border-subtle px-4 py-2 text-left text-sm',
                i === active && !dead && 'bg-accent-3',
                dead && 'cursor-not-allowed opacity-45',
              )}
            >
              <span className="mono flex items-center gap-2 font-medium">
                {b.batchNo}
                {i === 0 && !dead && <span className="rounded-[var(--radius-sm)] bg-accent-3 px-1 text-2xs text-accent-11">FEFO</span>}
                {b.isQuarantined && <span className="rounded-[var(--radius-sm)] bg-subtle px-1 text-2xs text-fg-muted">Quarantined</span>}
              </span>
              <span className="mono">{formatExpiry(b.expiryDate)}</span>
              <span className="text-right"><ExpiryChip bucket={bucket} label={days < 0 ? 'Expired' : `${days}d`} /></span>
              <span className="num">{Number(b.qtyOnHand)}</span>
              <span className="num">{formatAmount(b.mrpPerUnit)}</span>
              <span className="num text-fg-muted">{canViewCost ? formatAmount(b.landedCostPerUnit) : ''}</span>
              <span className="mono text-xs text-fg-muted">—</span>
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-border-subtle bg-subtle px-4 py-3">
        <label className="micro-label shrink-0" htmlFor="override-reason">Reason</label>
        <input
          id="override-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="h-8 flex-1 rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-sm"
        />
      </div>
    </Shell>
  )
}

/** Alt+O — the Schedule H1 capture, taken once per BILL on the way to payment. */
export function PrescriptionDialog({
  open, onOpenChange, initial, onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: PrescriptionInput | null
  onSave: (p: PrescriptionInput) => void
}) {
  const [p, setP] = useState<PrescriptionInput>(
    initial ?? { prescriberName: '', patientName: '', prescriptionDate: new Date().toISOString().slice(0, 10) },
  )
  useEffect(() => { if (open && initial) setP(initial) }, [open, initial])
  const valid = p.prescriberName.trim() !== '' && p.patientName.trim() !== ''

  return (
    <Shell open={open} onOpenChange={onOpenChange} title="Prescription details"
      subtitle="Schedule H1 requires the prescriber, the patient, the drug and the quantity, kept for three years.">
      <div className="space-y-3 p-4">
        <Field label="Prescriber name" value={p.prescriberName} onChange={(v) => setP({ ...p, prescriberName: v })} autoFocus required />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Registration no." value={p.prescriberRegNo ?? ''} onChange={(v) => setP({ ...p, prescriberRegNo: v })} />
          <Field label="Prescription date" value={p.prescriptionDate} onChange={(v) => setP({ ...p, prescriptionDate: v })} type="date" />
        </div>
        <Field label="Prescriber address" value={p.prescriberAddress ?? ''} onChange={(v) => setP({ ...p, prescriberAddress: v })} />
        <Field label="Patient name" value={p.patientName} onChange={(v) => setP({ ...p, patientName: v })} required />
        <Field label="Patient address" value={p.patientAddress ?? ''} onChange={(v) => setP({ ...p, patientAddress: v })} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border-subtle bg-subtle px-4 py-3">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={!valid} onClick={() => { onSave(p); onOpenChange(false) }}>
          <Check /> Record
        </Button>
      </div>
    </Shell>
  )
}

function Field({ label, value, onChange, type = 'text', required, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; autoFocus?: boolean
}) {
  return (
    <label className="block">
      <span className="micro-label mb-1 block">{label}{required && <span className="text-danger-9"> *</span>}</span>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-base"
      />
    </label>
  )
}

/** Alt+U — attach a customer by phone. */
export function CustomerPicker({ open, onOpenChange, onPick }: {
  open: boolean; onOpenChange: (v: boolean) => void; onPick: (c: Customer) => void
}) {
  const api = useApi()
  const [term, setTerm] = useState('')
  const { data: results = [] } = useQuery({
    queryKey: ['customers', term],
    queryFn: () => api.searchCustomers(term),
    enabled: open && term.trim().length > 0,
  })

  return (
    <Shell open={open} onOpenChange={onOpenChange} title="Attach customer" subtitle="Search by phone number or name.">
      <div className="p-4">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Phone or name…"
            className="h-10 w-full rounded-[var(--radius-md)] border border-border bg-surface pl-9 pr-3 text-base"
          />
        </div>
      </div>
      <div className="scroll-region max-h-[40vh] border-t border-border-subtle">
        {results.map((c) => (
          <button key={c.id} type="button" onClick={() => { onPick(c); onOpenChange(false) }}
            className="flex w-full items-center gap-3 border-b border-border-subtle px-4 py-2.5 text-left hover:bg-hover">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-medium">{c.name}</div>
              <div className="mono text-xs text-fg-muted">{c.phone}</div>
            </div>
            {c.allergies.length > 0 && (
              <span className="rounded-[var(--radius-sm)] bg-danger-3 px-1.5 py-0.5 text-2xs text-danger-11">
                {c.allergies.length} allerg{c.allergies.length === 1 ? 'y' : 'ies'}
              </span>
            )}
            {Number(c.outstanding) > 0 && (
              <span className="num text-sm text-warning-11">{formatAmount(c.outstanding)}</span>
            )}
          </button>
        ))}
        {term && results.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-fg-muted">No customer matches “{term}”.</p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-subtle px-4 py-2.5 text-xs text-fg-muted">
        <Kbd>Esc</Kbd> to close
      </div>
    </Shell>
  )
}
