import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { nanoid } from 'nanoid'
import { CircleAlert, Pause, RotateCcw, Wifi } from 'lucide-react'
import type { Customer, MedicineSearchHit, PaymentInput, SaleInvoice } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { useCart } from '@/store/cart'
import { useHotkeys } from '@/hooks/useHotkeys'
import { createScannerListener } from '@/lib/scanner'
import { digitFromEvent } from '@/lib/keys'
import type { ScanEvent } from '@/lib/scanner'
import { Kbd } from '@/components/ui/Kbd'
import { Button } from '@/components/ui/Button'
import { ShortcutHelp } from '@/components/ShortcutHelp'

/* The receipt pulls in bwip-js for the UPI QR — about a megabyte, and not needed
   until a sale actually completes. Loading it eagerly would put it in front of
   first paint on a till that reboots every morning. */
const ThermalReceipt = lazy(() =>
  import('@/print').then((m) => ({ default: m.ThermalReceipt })),
)
import { SkeletonRows } from '@/components/states'
import { SearchPane } from './SearchPane'
import { CartGrid } from './CartGrid'
import { TotalsRail } from './TotalsRail'
import { PaymentPanel } from './PaymentPanel'
import { BatchPicker, CustomerPicker, PrescriptionDialog } from './dialogs'
import { EMPTY_QUOTE, useQuote } from './useQuote'

const TERMINAL_ID = 1

export function BillingScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: store } = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const cart = useCart()
  const { data: quote = EMPTY_QUOTE, isFetching, error: quoteError } = useQuote(store?.id ?? 1, today, false)

  const [batchPickerLine, setBatchPickerLine] = useState<string | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [prescriptionOpen, setPrescriptionOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [lastInvoice, setLastInvoice] = useState<SaleInvoice | null>(null)
  const submitPaymentRef = useRef<(() => void) | null>(null)

  const hasH1 = quote.lines.some((l) => l.drugSchedule === 'H1')

  /** Focus returns to search after every completed action. It is the resting place. */
  const focusSearch = useCallback(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])

  const addHit = useCallback((hit: MedicineSearchHit, qty = '1') => {
    const m = hit.medicine
    cart.addLine({
      medicineId: m.id,
      brandName: m.brandName,
      packLabel: m.packLabel,
      unitsPerPack: m.unitsPerPack,
      allowLooseSale: m.allowLooseSale,
      // A pack-only item must not start at a single unit; the operator would have
      // to correct every line.
      qty: m.allowLooseSale ? qty : String(m.unitsPerPack),
    })
    focusSearch()
  }, [cart, focusSearch])

  // ------------------------------------------------------------- scanner ----
  useEffect(() => {
    const listener = createScannerListener({
      onScan: (e: ScanEvent) => { void onScan(e) },
    })
    const handler = (ev: KeyboardEvent) => listener.handleKeyDown(ev)
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onScan(e: ScanEvent) {
    // A fast typist hitting Enter after a short word looks exactly like a scan to
    // a timing heuristic. The AIM prefix and the payload shape are facts, not
    // guesses, so anything the parser could not classify is treated as typing and
    // left to the search box rather than raised as a scan failure.
    if (e.kind === 'unknown') return

    const code = e.parsed?.gtin ?? e.raw
    const hit = await api.lookupBarcode(code)
    if (!hit) {
      toast.error('Unknown barcode', {
        description: `${code} is not linked to any medicine. Link it from Medicines, or search by name.`,
      })
      focusSearch()
      return
    }
    if (hit.outOfStock) {
      toast.warning(`${hit.medicine.brandName} is out of stock`, {
        description: 'Added to the short book instead.',
      })
      void api.addToShortbook(hit.medicine.id, hit.medicine.brandName, '1')
      return
    }
    addHit(hit)
    // A batch scanned off a GS1 pack is a fact about which strip is in the hand;
    // it is worth more than the FEFO guess.
    if (e.parsed?.batch) {
      toast.info(`Scanned batch ${e.parsed.batch}`, { description: 'Verify it matches the strip.' })
    }
  }

  // ---------------------------------------------------------------- save ----
  const post = useMutation({
    mutationFn: async (payments: PaymentInput[]) => {
      if (!store) throw new Error('store not loaded')
      const lines = cart.ids.flatMap((id) => {
        const l = cart.byId[id]
        if (!l || Number(l.qty) <= 0) return []
        return [{
          lineId: l.lineId, medicineId: l.medicineId, qty: l.qty,
          freeQty: l.freeQty, discountPct: l.discountPct,
          ...(l.batchOverride ? { batchOverride: l.batchOverride } : {}),
        }]
      })
      const reason = cart.ids.map((id) => cart.byId[id]?.overrideReason).find(Boolean)
      return api.postSale({
        idempotencyKey: nanoid(),
        terminalId: TERMINAL_ID,
        quote: {
          storeId: store.id, invoiceDate: today, interState: false,
          ...(cart.customerId ? { customerId: cart.customerId } : {}),
          billDiscountPct: cart.billDiscountPct, lines,
        },
        payments,
        ...(cart.prescription ? { prescription: cart.prescription } : {}),
        ...(reason ? { batchOverrideReason: reason } : {}),
        ...(cart.customerId ? { customerId: cart.customerId } : {}),
      })
    },
    onSuccess: (invoice) => {
      setLastInvoice(invoice)
      toast.success(`Saved ${invoice.invoiceNo}`, {
        description: `₹${invoice.quote.netAmount}${Number(invoice.changeDue) > 0 ? ` · change ₹${invoice.changeDue}` : ''}`,
        action: { label: 'Print', onClick: () => window.print() },
      })
      cart.reset()
      setCustomer(null)
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void qc.invalidateQueries({ queryKey: ['search'] })
      focusSearch()
    },
    onError: (err) => {
      const e = err as ApiError
      toast.error(e.code === 'STOCK_INSUFFICIENT' ? 'Not enough stock' : 'Could not save the bill', {
        description: e.message,
      })
    },
  })

  // ---------------------------------------------------------------- hold ----
  const hold = useMutation({
    mutationFn: async () => {
      const taken = (await api.listHeldBills()).map((b) => b.token)
      const token = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((t) => !taken.includes(t)) ?? 1
      return api.holdBill({
        token,
        label: customer?.name ?? `Counter ${TERMINAL_ID}`,
        itemCount: cart.ids.length,
        netAmount: quote.netAmount,
        lines: cart.ids.flatMap((id) => {
          const l = cart.byId[id]
          return l ? [{ lineId: l.lineId, medicineId: l.medicineId, qty: l.qty, freeQty: l.freeQty, discountPct: l.discountPct }] : []
        }),
        ...(cart.customerId ? { customerId: cart.customerId } : {}),
      })
    },
    onSuccess: (b) => {
      toast.success(`Held on token ${b.token}`, { description: `Recall with Alt+${b.token}.` })
      cart.reset(); setCustomer(null); focusSearch()
      void qc.invalidateQueries({ queryKey: ['held'] })
    },
  })

  const { data: held = [] } = useQuery({ queryKey: ['held'], queryFn: () => api.listHeldBills() })

  const recall = useCallback(async (token: number) => {
    try {
      const bill = await api.recallBill(token)
      // Held rows carry ids, not names: hydrate before they reach the grid, or the
      // operator sees a cart full of numbers.
      const meds = await api.getMedicines(bill.lines.map((l) => l.medicineId))
      const byId = new Map(meds.map((m) => [m.id, m]))
      const lines = bill.lines.flatMap((l) => {
        const m = byId.get(l.medicineId)
        if (!m) return []
        return [{
          lineId: l.lineId,
          medicineId: m.id,
          brandName: m.brandName,
          packLabel: m.packLabel,
          unitsPerPack: m.unitsPerPack,
          allowLooseSale: m.allowLooseSale,
          qty: l.qty,
          freeQty: l.freeQty ?? '0',
          discountPct: l.discountPct ?? '0',
        }]
      })
      const dropped = bill.lines.length - lines.length
      cart.loadLines(lines, bill.customerId ?? null, token)
      await api.dropHeldBill(token)
      void qc.invalidateQueries({ queryKey: ['held'] })
      toast.success(`Recalled token ${token}`, {
        description: dropped > 0 ? `${dropped} item(s) no longer in the catalogue were dropped.` : undefined,
      })
      focusSearch()
    } catch {
      toast.error(`Nothing held on token ${token}`)
    }
  }, [api, cart, qc, focusSearch])

  // ------------------------------------------------------------ shortcuts ---
  useHotkeys('billing', {
    'search.focus': focusSearch,
    'bill.new': () => {
      // F2 is one key away from the cart grid, and an unconfirmed reset there
      // silently destroys a bill the operator has been building.
      if (cart.ids.length > 0 && !window.confirm(`Discard this bill (${cart.ids.length} items)?`)) return
      cart.reset(); setCustomer(null); focusSearch()
    },
    'bill.hold': () => { if (cart.ids.length) hold.mutate() },
    'bill.recall': () => { if (held[0]) void recall(held[0].token) },
    'bill.recallSlot': (e) => {
      // Not Number(e.key): macOS composes Option+digit into another character
      // entirely, so the digit has to come off the physical code.
      const n = digitFromEvent(e)
      if (n !== null && n >= 1 && n <= 9) void recall(n)
    },
    'customer.attach': () => setCustomerOpen(true),
    'doctor.attach': () => setPrescriptionOpen(true),
    'payment.open': () => { if (cart.ids.length && !quoteError) cart.setStage('PAYMENT') },
    'bill.save': () => {
      // From the cart, save means "go and take the money"; from the payment panel
      // it means "commit". One key, two stages, no second shortcut to learn.
      if (cart.stage === 'PAYMENT') submitPaymentRef.current?.()
      else if (cart.ids.length && !quoteError) cart.setStage('PAYMENT')
    },
    'bill.saveNoPrint': () => { if (cart.stage === 'PAYMENT') submitPaymentRef.current?.() },
    'help.open': () => setHelpOpen(true),
    'print': () => {
      if (!lastInvoice) {
        toast.info('Nothing to reprint yet')
        return
      }
      window.print()
    },
    'escape': () => {
      if (cart.stage === 'PAYMENT') cart.setStage('CART')
      else focusSearch()
    },
  })

  /** Focus a numeric cell of the focused row by column index. */
  const focusCell = useCallback((col: number) => {
    const id = useCart.getState().focusedLineId
    if (!id) return
    const row = document.querySelector(`[data-line-id="${id}"]`)
    const inputs = row?.querySelectorAll('input')
    const target = inputs?.[col] as HTMLInputElement | undefined
    target?.focus()
    target?.select()
  }, [])

  useHotkeys('cart', {
    'line.batch': () => { if (cart.focusedLineId) setBatchPickerLine(cart.focusedLineId) },
    'line.delete': () => { if (cart.focusedLineId) cart.removeLine(cart.focusedLineId) },
    // Both MUST be implemented. A shortcut the cart scope declares but does not
    // handle falls through to the broader billing scope, where F2 is "new bill" —
    // so an unimplemented F2 here quietly discarded the cart.
    'cell.edit': () => focusCell(0),
    'line.discount': () => focusCell(2),
  }, { enabled: cart.ids.length > 0 })

  // Depends on `store`: until it resolves this component renders a skeleton and
  // the input does not exist yet, so focusing on mount alone silently does nothing.
  useEffect(() => {
    if (store) focusSearch()
  }, [store, focusSearch])

  if (!store) {
    return <div className="p-6"><SkeletonRows rows={10} cols={6} /></div>
  }

  const pickerLine = batchPickerLine ? cart.byId[batchPickerLine] : null

  return (
    <div className="flex h-full min-h-0" data-density="pos">
      <SearchPane
        inputRef={searchRef}
        onPick={(hit) => addHit(hit)}
        onShortbook={(term, hit) => {
          void api.addToShortbook(hit?.medicine.id ?? null, term, '1')
          toast.success('Added to short book', { description: `“${term}” — the reorder list will show it.` })
          focusSearch()
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <BillBar
          invoiceNo={lastInvoice ? `Last: ${lastInvoice.invoiceNo}` : 'New bill'}
          held={held.length}
          busy={isFetching}
          onHold={() => hold.mutate()}
          canHold={cart.ids.length > 0}
          onRecall={() => { if (held[0]) void recall(held[0].token) }}
        />
        <CartGrid
          quote={quote}
          today={today}
          onEscapeToSearch={focusSearch}
          onOpenBatchPicker={(id) => setBatchPickerLine(id)}
        />
      </div>

      {cart.stage === 'CART' ? (
        <TotalsRail
          quote={quote}
          customer={customer}
          hasH1={hasH1}
          prescriptionDone={cart.prescription !== null}
          quoteError={quoteError}
          onAttachCustomer={() => setCustomerOpen(true)}
          onClearCustomer={() => { setCustomer(null); cart.setCustomer(null) }}
          onPrescription={() => setPrescriptionOpen(true)}
          onPay={() => cart.setStage('PAYMENT')}
        />
      ) : (
        <PaymentPanel
          quote={quote}
          submitRef={submitPaymentRef}
          busy={post.isPending}
          allowCredit={customer !== null}
          onBack={() => cart.setStage('CART')}
          onComplete={(payments) => {
            if (hasH1 && !cart.prescription) {
              toast.error('Schedule H1 details are required', { description: 'Press Alt+O to record the prescriber and patient.' })
              cart.setStage('CART')
              setPrescriptionOpen(true)
              return
            }
            post.mutate(payments)
          }}
        />
      )}

      <BatchPicker
        open={batchPickerLine !== null}
        onOpenChange={(v) => !v && setBatchPickerLine(null)}
        medicineId={pickerLine?.medicineId ?? null}
        brandName={pickerLine?.brandName ?? ''}
        today={today}
        canViewCost
        onPick={(batch, reason) => {
          if (batchPickerLine && pickerLine) {
            cart.setOverride(batchPickerLine, [{ batchId: batch.id, qty: pickerLine.qty }], reason)
            toast.info(`Batch ${batch.batchNo} selected`, { description: 'Recorded as a manual override.' })
          }
          setBatchPickerLine(null)
          focusSearch()
        }}
      />

      <CustomerPicker
        open={customerOpen}
        onOpenChange={setCustomerOpen}
        onPick={(c) => { setCustomer(c); cart.setCustomer(c.id); focusSearch() }}
      />

      <PrescriptionDialog
        open={prescriptionOpen}
        onOpenChange={setPrescriptionOpen}
        initial={cart.prescription}
        onSave={(p) => { cart.setPrescription(p); toast.success('Prescription recorded'); focusSearch() }}
      />

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} scope="billing" />

      {/* The sheet mounts as a direct child of <body>: print.css hides every other
          body child on paper, which is the only way the shell is guaranteed gone
          whatever the screen happens to be showing. */}
      {lastInvoice &&
        createPortal(
          <Suspense fallback={null}>
            <ThermalReceipt invoice={lastInvoice} store={store} />
          </Suspense>,
          document.body,
        )}
    </div>
  )
}

function BillBar({ invoiceNo, held, busy, onHold, canHold, onRecall }: {
  invoiceNo: string; held: number; busy: boolean; onHold: () => void; canHold: boolean; onRecall: () => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
      <span className="mono text-sm text-fg-muted">{invoiceNo}</span>
      <span className="text-xs text-fg-subtle">{new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
      {busy && <span className="text-2xs text-fg-subtle">re-quoting…</span>}
      <div className="flex-1" />
      <Button size="sm" onClick={onHold} disabled={!canHold}>
        <Pause /> Hold <Kbd>F8</Kbd>
      </Button>
      <Button size="sm" onClick={onRecall} disabled={held === 0}>
        <RotateCcw /> Recall {held > 0 && <span className="num">{held}</span>} <Kbd>F9</Kbd>
      </Button>
      <span className="flex items-center gap-1 text-2xs text-fg-subtle"><Wifi size={12} aria-hidden /> Online</span>
    </div>
  )
}

export function BillingError({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-danger-11"><CircleAlert size={18} /> {message}</div>
    </div>
  )
}
