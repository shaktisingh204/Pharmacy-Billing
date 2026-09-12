import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import * as Dialog from '@radix-ui/react-dialog'
import { Printer, Tag, TriangleAlert, X } from 'lucide-react'
import type { BatchRow } from '@contract'
import { useApi } from '@/api'
import { useHotkeys } from '@/hooks/useHotkeys'
import { Button } from '@/components/ui/Button'
import { DEFAULT_LABEL, labelBytes, labelFor, renderLabels, testLabel } from '@/print/labels'
import type { LabelData, LabelOptions } from '@/print/labels'
import { PrinterError, isConnected, isSupported, write } from '@/print/serial'

/**
 * Printing shelf labels for one batch, or for a whole selection.
 *
 * Per BATCH, never per product, and the dialog says why: a shelf legitimately
 * holds one medicine in two batches at two printed MRPs, so a product label is
 * wrong about half the stock behind it — and the customer pays what is printed
 * on the strip in their hand.
 *
 * The two settings that actually break a label roll are the LANGUAGE and the
 * print HEAD DENSITY. A TSPL job sent to a Zebra prints command text as literal
 * characters; a 203dpi layout on a 300dpi head prints at two-thirds scale and
 * clips. Neither can be detected, so both are settings with a test label beside
 * them and the preview shows the raw commands.
 */

const STORAGE_KEY = 'rxbill.labels'

/**
 * A roll of 60 is the usual, and a mis-set language wastes every label before
 * anyone notices. A run is capped so that a mistake costs a roll rather than a
 * box, and the dialog says what it will not print.
 */
const RUN_CAP = 60

/** Barcodes are a per-medicine lookup, so a very wide selection stops asking. */
const BARCODE_LOOKUP_CAP = 40

function readOpts(): LabelOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_LABEL, ...(JSON.parse(raw) as Partial<LabelOptions>) } : DEFAULT_LABEL
  } catch {
    return DEFAULT_LABEL
  }
}

export function LabelDialog({
  open, onOpenChange, rows,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** One batch from the sheet, or a whole selection from the grid. */
  rows: BatchRow[]
}) {
  const api = useApi()
  const [opts, setOpts] = useState<LabelOptions>(readOpts)
  const [busy, setBusy] = useState(false)

  useHotkeys('modal', {}, { enabled: open })

  const printable = rows.slice(0, RUN_CAP)
  const dropped = rows.length - printable.length
  const first = printable[0] ?? null

  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore(), enabled: open })

  /* The barcode comes off the medicine listing, which already carries them —
     rather than a new endpoint for one string the catalogue is holding anyway.
     One lookup per distinct medicine, and a wide selection simply stops asking:
     a label with no barcode still carries the price, the batch and the expiry. */
  const names = useMemo(
    () => [...new Map(rows.slice(0, RUN_CAP).map((r) => [r.medicine.id, r.medicine.brandName])).entries()]
      .slice(0, BARCODE_LOOKUP_CAP),
    [rows],
  )

  const codes = useQuery({
    queryKey: ['medicines', 'forLabel', names.map(([id]) => id)],
    queryFn: async () => {
      const found = await Promise.all(
        names.map(async ([id, term]) => {
          const page = await api.listMedicines({ term, limit: 5 })
          return [id, page.rows.find((r) => r.medicine.id === id)?.barcodes[0] ?? null] as const
        }),
      )
      return new Map<number, string | null>(found)
    },
    enabled: open && names.length > 0,
  })

  const set = <K extends keyof LabelOptions>(key: K, value: LabelOptions[K]) => {
    const next = { ...opts, [key]: value }
    setOpts(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Per-viewer convenience. The setting still applies for this session.
    }
  }

  const labels: LabelData[] = printable.map((r) =>
    labelFor(r.batch, r.medicine, codes.data?.get(r.medicine.id) ?? null))
  const preview = labels.length > 0 ? renderLabels(labels, opts) : ''
  const sheets = labels.length * opts.copies

  const send = async (bytes: Uint8Array, what: string) => {
    setBusy(true)
    try {
      await write(bytes)
      toast.success(what)
    } catch (e) {
      toast.error('Nothing printed', {
        description: e instanceof PrinterError ? e.message : (e as Error).message,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgb(16_24_40/.35)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]">
          <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-[var(--card-px)] py-3">
            <Tag size={18} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">
                Shelf labels
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-sm text-fg-muted">
                {first === null ? (
                  'Choose a batch first.'
                ) : printable.length === 1 ? (
                  <>
                    For batch <span className="mono">{first.batch.batchNo}</span> of{' '}
                    {first.medicine.brandName} — the price on a label belongs to the batch, not the
                    product.
                  </>
                ) : (
                  <>
                    For <span className="num font-medium text-fg">{printable.length}</span> selected
                    batches — one label each, because the price on a label belongs to the batch, not
                    the product.
                  </>
                )}
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

          <div className="scroll-region min-h-0 flex-1 overflow-auto p-[var(--card-px)]">
            {!isSupported() ? (
              <p className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-warning-9/25 bg-warning-3 px-2.5 py-2 text-2xs text-warning-11">
                <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
                This browser cannot drive a label printer directly. Chrome or Edge on a desktop
                can. The commands below can still be copied into the printer&rsquo;s own tool.
              </p>
            ) : null}

            {dropped > 0 ? (
              <p className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-warning-9/25 bg-warning-3 px-2.5 py-2 text-2xs text-warning-11">
                <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
                <span>
                  {/* A wrong language or density ruins every label in the run, so
                      the run is capped at a roll rather than a box. */}
                  <span className="num font-medium">{dropped}</span> of the selected batches are not
                  in this run. A run is capped at {RUN_CAP} labels so that a mis-set printer costs a
                  roll and not a box — print the rest as a second run.
                </span>
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="micro-label">Printer language</span>
                <select
                  aria-label="Printer language"
                  value={opts.language}
                  onChange={(e) => set('language', e.target.value as LabelOptions['language'])}
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                >
                  <option value="TSPL">TSPL — TSC, TVS and most Indian units</option>
                  <option value="ZPL">ZPL — Zebra and emulators</option>
                </select>
                <span className="text-2xs text-fg-subtle">
                  {/* Not detectable, and the failure is unmistakable once it
                      happens: the wrong one prints the commands as text. */}
                  The wrong one prints the commands as literal text. Nothing can ask the printer
                  which it speaks — try a test label.
                </span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="micro-label">Head density</span>
                <select
                  aria-label="Head density"
                  value={opts.dpmm}
                  onChange={(e) => set('dpmm', Number(e.target.value) as LabelOptions['dpmm'])}
                  className="h-[var(--control-h)] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                >
                  <option value={8}>203 dpi — the usual</option>
                  <option value={12}>300 dpi</option>
                </select>
                <span className="text-2xs text-fg-subtle">
                  Set wrong, a label prints at two-thirds scale and clips.
                </span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="micro-label">Label size (mm)</span>
                <div className="flex items-center gap-1.5">
                  <input
                    aria-label="Label width in millimetres"
                    type="number"
                    min={20}
                    max={110}
                    value={opts.widthMm}
                    onChange={(e) => set('widthMm', Number(e.target.value))}
                    className="num h-[var(--control-h)] w-20 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                  />
                  <span className="text-2xs text-fg-subtle">×</span>
                  <input
                    aria-label="Label height in millimetres"
                    type="number"
                    min={10}
                    max={110}
                    value={opts.heightMm}
                    onChange={(e) => set('heightMm', Number(e.target.value))}
                    className="num h-[var(--control-h)] w-20 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                  />
                </div>
              </label>

              <label className="flex flex-col gap-1">
                <span className="micro-label">Copies of each</span>
                <input
                  aria-label="Copies"
                  type="number"
                  min={1}
                  max={200}
                  value={opts.copies}
                  onChange={(e) => set('copies', Number(e.target.value))}
                  className="num h-[var(--control-h)] w-24 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base"
                />
                {printable.length > 1 ? (
                  <span className="text-2xs text-fg-subtle">
                    <span className="num">{sheets}</span> labels in total across{' '}
                    <span className="num">{printable.length}</span> batches.
                  </span>
                ) : null}
              </label>
            </div>

            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={opts.showPrice}
                onChange={(e) => set('showPrice', e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent-9)]"
              />
              <span>
                <span className="block text-sm text-fg">Print the MRP</span>
                <span className="block text-2xs text-fg-muted">
                  {/* The reason this is a choice at all. */}
                  On for a price sticker. Off for a rack label, which sits under stock from several
                  batches and must not contradict the price on any pack behind it.
                </span>
              </span>
            </label>

            <div className="mt-4">
              <h3 className="micro-label">What will be sent</h3>
              <pre className="mono mt-1 max-h-40 overflow-auto rounded-[var(--radius-md)] border border-border-subtle bg-subtle p-2 text-2xs text-fg-muted">
                {preview || '—'}
              </pre>
            </div>
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-[var(--card-px)] py-2.5">
            <span className="text-2xs text-fg-subtle">
              {isConnected()
                ? 'Sends to the connected printer.'
                : 'Connect a printer in Settings → Printing first.'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                disabled={!isConnected() || busy || !store.data}
                onClick={() => {
                  if (store.data) void send(testLabel(store.data, opts), 'Test label sent')
                }}
              >
                <Printer /> Test label
              </Button>
              <Button
                variant="primary"
                disabled={!isConnected() || busy || labels.length === 0}
                onClick={() => {
                  if (labels.length > 0) {
                    void send(
                      labelBytes(labels, opts),
                      `${sheets} label${sheets === 1 ? '' : 's'} sent`,
                    )
                  }
                }}
              >
                <Tag /> Print {sheets}
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
