import { useEffect, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRight, Barcode, Check, Link2, Plus, ScanBarcode, Search, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Medicine, MedicineSearchHit } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { createScannerListener } from '@/lib/scanner'
import type { ScanEvent } from '@/lib/scanner'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { ScheduleChip } from '@/components/ui/Badge'

/**
 * Scan-to-link, and the recovery when a scan matches nothing.
 *
 * The recovery is the point. Marg raises a "Barcode not found" alert and its
 * documented fix is a Control Room setting that stops the alert appearing —
 * which suppresses the symptom and loses the digits. The digits are the whole
 * value: the pack is in the operator's hand right now, and that is the only
 * moment linking it costs nothing. So the code is held on screen and offered
 * two ways out — attach it to an item that already exists, or open a new item
 * with the code already filled in.
 *
 * Linking is master-wise, because that is what `linkBarcode` is. A shop-printed
 * label is per BATCH (MRP differs by batch) and cannot resolve to one here; the
 * counter will still ask which batch. That is a deliberate simplification of the
 * contract, not an oversight.
 */

interface OwnerRef {
  id: number | null
  brandName: string
  packLabel: string
}

/** `code` is the contract; `details` is not, so it is read defensively — a later
 *  backend may send only an id, and the dialog still has to say something true. */
function ownerFrom(details: unknown): OwnerRef | null {
  if (typeof details !== 'object' || details === null) return null
  const d = details as Record<string, unknown>
  const id = typeof d.id === 'number' ? d.id : typeof d.medicineId === 'number' ? d.medicineId : null
  if (id === null && typeof d.brandName !== 'string') return null
  return {
    id,
    brandName: typeof d.brandName === 'string' ? d.brandName : 'another item',
    packLabel: typeof d.packLabel === 'string' ? d.packLabel : '',
  }
}

function symbologyFor(code: string, scanned: string | null): string {
  if (scanned) return scanned
  if (/^\d{13}$/.test(code)) return 'EAN-13'
  if (/^\d{8}$/.test(code)) return 'EAN-8'
  if (/^\d{12}$/.test(code)) return 'UPC-A'
  if (/^\d{14}$/.test(code)) return 'GTIN-14'
  return 'CODE-128'
}

export function BarcodeLinker({
  open,
  onOpenChange,
  target,
  initialCode,
  onLinked,
  onOpenMedicine,
  onCreateNew,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The item the code should attach to. null means the scan has no home yet. */
  target: Medicine | null
  initialCode: string | null
  onLinked: (medicine: Medicine, code: string) => void
  onOpenMedicine: (id: number) => void
  /** Hands the code on and CLOSES this dialog itself — see the button below. */
  onCreateNew: (code: string) => void
}) {
  const api = useApi()
  useHotkeys('modal', {}, { enabled: open })

  const [code, setCode] = useState(initialCode ?? '')
  const [scannedSymbology, setScannedSymbology] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<Medicine | null>(null)
  const [taken, setTaken] = useState<{ code: string; owner: OwnerRef | null } | null>(null)

  /* Reset when the dialog is opened on a different code or item, during render
     rather than from an effect so the first paint is already correct. */
  const identity = `${target?.id ?? 'none'}:${initialCode ?? ''}:${String(open)}`
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (identity !== lastIdentity) {
    setLastIdentity(identity)
    if (open) {
      setCode(initialCode ?? '')
      setScannedSymbology(null)
      setTerm('')
      setPicked(null)
      setTaken(null)
    }
  }

  /* A USB wedge is a keyboard, so the only way to know a scan happened is the
     timing. Capture phase, because the payload otherwise lands in whichever
     field has focus and the terminator submits the form. */
  const onScanRef = useRef<(e: ScanEvent) => void>(() => {})
  useEffect(() => {
    onScanRef.current = (e: ScanEvent) => {
      setCode(e.parsed?.gtin ?? e.raw)
      setScannedSymbology(e.symbology)
      setTaken(null)
    }
  })
  useEffect(() => {
    if (!open) return
    const listener = createScannerListener({ onScan: (e) => onScanRef.current(e) })
    const handler = (ev: KeyboardEvent) => listener.handleKeyDown(ev)
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open])

  const trimmed = code.trim()

  const owner = useQuery({
    queryKey: ['barcode', trimmed],
    queryFn: () => api.lookupBarcode(trimmed),
    enabled: open && trimmed.length >= 4,
  })

  /* NOT `qk.search(term)`. The counter's own box caches under that key with a
     different limit and without out-of-stock rows, so sharing it hands whichever
     screen asked second the other one's answer. Still under the 'search' prefix,
     so one invalidation reaches both. */
  const results = useQuery({
    queryKey: ['search', 'linker', term],
    queryFn: () => api.searchMedicines({ term, limit: 6, includeOutOfStock: true }),
    enabled: open && target === null && term.trim().length > 0,
  })

  const ownerMedicine = owner.data?.medicine ?? null
  const attachTo = target ?? picked
  const alreadyHere = ownerMedicine !== null && attachTo !== null && ownerMedicine.id === attachTo.id
  const takenByOther = ownerMedicine !== null && (attachTo === null || ownerMedicine.id !== attachTo.id)

  const link = useMutation({
    mutationFn: async (): Promise<Medicine> => {
      if (!attachTo) throw new Error('No item selected')
      await api.linkBarcode(attachTo.id, trimmed, symbologyFor(trimmed, scannedSymbology))
      return attachTo
    },
    onSuccess: (m) => {
      onLinked(m, trimmed)
      onOpenChange(false)
    },
    onError: (err) => {
      /* BARCODE_TAKEN is a race we lost, or a code the operator typed against the
         wrong pack. Either way the useful answer is the NAME of the item holding
         it, not the error text — so the owning row rides on `details`. */
      if (err instanceof ApiError && err.code === 'BARCODE_TAKEN') {
        setTaken({ code: trimmed, owner: ownerFrom(err.details) })
      }
    },
  })

  const takenOwnerId = taken?.owner?.id ?? null
  const canLink = trimmed.length >= 4 && attachTo !== null && !alreadyHere && !takenByOther && !link.isPending

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgb(16_24_40/.32)]" />
        <Dialog.Content
          style={{ width: 620 }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="shrink-0 border-b border-border-subtle px-4 py-3">
            <Dialog.Title className="text-lg font-semibold">
              {target
                ? `Link a barcode to ${target.brandName}`
                : initialCode
                  ? 'Barcode not recognised'
                  : 'Scan a barcode'}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
              {target
                ? 'Scan the pack, or type the number printed under the bars. One item may carry several codes — a repack and a shop label are both legitimate.'
                : initialCode
                  ? 'The scan is held here rather than discarded. Attach it to an item that exists, or start a new one with the code already filled in.'
                  : 'Scan a pack to see what it resolves to. An unknown code can be attached to an item that exists, or become a new one.'}
            </Dialog.Description>
          </div>

          <div className="scroll-region min-h-0 flex-1 p-4">
            {/* The code, large and mono. It is the thing the whole dialog is about. */}
            <div
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-lg)] border px-4 py-3',
                trimmed ? 'border-border bg-subtle' : 'border-dashed border-border bg-surface',
              )}
            >
              <Barcode size={22} className={trimmed ? 'text-fg' : 'text-fg-subtle'} aria-hidden />
              <div className="min-w-0 flex-1">
                <label className="block">
                  <span className="micro-label">Barcode</span>
                  <input
                    value={code}
                    onChange={(e) => { setCode(e.target.value); setTaken(null) }}
                    placeholder="Scan now, or type the digits…"
                    aria-label="Barcode"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    className="mono mt-0.5 h-8 w-full rounded-[var(--radius-sm)] border border-border bg-surface px-2 text-lg tracking-wide"
                  />
                </label>
              </div>
              <span className="shrink-0 text-2xs text-fg-subtle">
                {trimmed ? symbologyFor(trimmed, scannedSymbology) : <span className="flex items-center gap-1"><ScanBarcode size={13} aria-hidden /> waiting</span>}
              </span>
            </div>

            {/* What the catalogue already thinks of this code. */}
            {trimmed.length >= 4 ? (
              <div className="mt-2">
                {owner.isPending ? (
                  <Status tone="muted">Checking the catalogue…</Status>
                ) : alreadyHere ? (
                  <Status tone="ok" icon={Check}>This code is already linked to {attachTo?.brandName}.</Status>
                ) : takenByOther && ownerMedicine ? (
                  <Status tone="warn" icon={TriangleAlert}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span>
                        Already carried by <span className="font-medium">{ownerMedicine.brandName}</span>{' '}
                        {ownerMedicine.strengthText} {ownerMedicine.packLabel}.
                      </span>
                      <Button size="sm" onClick={() => { onOpenMedicine(ownerMedicine.id); onOpenChange(false) }}>
                        Open it <ArrowRight />
                      </Button>
                    </span>
                  </Status>
                ) : (
                  <Status tone="ok" icon={Check}>No item carries this code yet.</Status>
                )}
              </div>
            ) : null}

            {taken ? (
              <div className="mt-2">
                <Status tone="warn" icon={TriangleAlert}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span>
                      <span className="mono">{taken.code}</span> is carried by{' '}
                      <span className="font-medium">{taken.owner?.brandName ?? 'another item'}</span>{' '}
                      {taken.owner?.packLabel}. Re-pointing it would put a different drug on the next bill,
                      so it is refused rather than performed.
                    </span>
                    {takenOwnerId !== null ? (
                      <Button size="sm" onClick={() => { onOpenMedicine(takenOwnerId); onOpenChange(false) }}>
                        Open it <ArrowRight />
                      </Button>
                    ) : null}
                  </span>
                </Status>
              </div>
            ) : null}

            {link.error && !taken ? (
              <div className="mt-2">
                <Status tone="danger" icon={TriangleAlert}>
                  {(link.error as Error).message}
                  {link.error instanceof ApiError ? <span className="mono ml-2 text-2xs">{link.error.code}</span> : null}
                </Status>
              </div>
            ) : null}

            {target === null ? (
              <div className="mt-4">
                <div className="micro-label mb-1.5">Attach it to</div>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
                  <input
                    value={term}
                    onChange={(e) => { setTerm(e.target.value); setPicked(null) }}
                    placeholder="Brand, salt or manufacturer…"
                    aria-label="Find the item this code belongs to"
                    autoComplete="off"
                    className="h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface pl-8 pr-3 text-base"
                  />
                </div>

                <div className="mt-1.5 overflow-hidden rounded-[var(--radius-md)] border border-border-subtle">
                  {picked ? (
                    <Row hit={null} medicine={picked} selected onSelect={() => setPicked(null)} />
                  ) : term.trim() === '' ? (
                    <p className="px-3 py-4 text-center text-sm text-fg-muted">
                      Search for the item on the pack in your hand.
                    </p>
                  ) : (results.data ?? []).length === 0 && !results.isPending ? (
                    <p className="px-3 py-4 text-center text-sm text-fg-muted">
                      Nothing matches “{term.trim()}”. It is probably a new item.
                    </p>
                  ) : (
                    (results.data ?? []).map((hit) => (
                      <Row
                        key={hit.medicine.id}
                        hit={hit}
                        medicine={hit.medicine}
                        selected={false}
                        onSelect={() => setPicked(hit.medicine)}
                      />
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-4 py-3">
            <span className="text-2xs text-fg-subtle"><Kbd>Esc</Kbd> closes · a wedge scan is picked up anywhere in this dialog</span>
            <span className="ml-auto flex gap-2">
              {/* Only `onCreateNew` — closing is the owner's job. Calling
                  `onOpenChange(false)` here too would batch a "forget the
                  pending code" behind the handoff that just set it, and the
                  digits this dialog exists to keep would be dropped between the
                  two setStates. */}
              {target === null ? (
                <Button onClick={() => onCreateNew(trimmed)} disabled={trimmed.length < 4}>
                  <Plus /> Create new item
                </Button>
              ) : null}
              <Button type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="primary" disabled={!canLink} onClick={() => link.mutate()}>
                <Link2 /> Link{attachTo ? ` to ${attachTo.brandName}` : ''}
              </Button>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({
  hit, medicine, selected, onSelect,
}: {
  hit: MedicineSearchHit | null
  medicine: Medicine
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-0',
        selected ? 'bg-accent-3' : 'hover:bg-hover',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-base font-medium">{medicine.brandName}</span>
          <span className="shrink-0 text-2xs text-fg-muted">{medicine.strengthText}</span>
          <span className="shrink-0 text-2xs text-fg-subtle">{medicine.packLabel}</span>
        </span>
        <span className="block truncate text-2xs text-fg-muted">
          {medicine.compositionText} · {medicine.manufacturer}
        </span>
      </span>
      <ScheduleChip code={medicine.drugSchedule} />
      {selected ? <Check size={14} className="text-accent-11" aria-hidden /> : null}
      {hit?.outOfStock ? <span className="shrink-0 text-2xs text-fg-subtle">No stock</span> : null}
    </button>
  )
}

function Status({
  tone, icon: Icon, children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'muted'
  icon?: LucideIcon
  children: React.ReactNode
}) {
  const cls = {
    ok: 'border-success-9/30 bg-success-3 text-success-11',
    warn: 'border-warning-9/40 bg-warning-3 text-warning-11',
    danger: 'border-danger-9/30 bg-danger-3 text-danger-11',
    muted: 'border-border-subtle bg-subtle text-fg-muted',
  }[tone]
  return (
    <div className={cn('flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-sm', cls)}>
      {Icon ? <Icon size={14} className="mt-0.5 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
