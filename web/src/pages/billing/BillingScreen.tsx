import {
  Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { nanoid } from 'nanoid'
import {
  CircleAlert, ExternalLink, Monitor, Pause, Printer, RotateCcw, Wifi, WifiOff,
} from 'lucide-react'
import type {
  Customer, Doctor, Medicine, MedicineSearchHit, PaymentInput, SaleInvoice,
} from '@contract'
import { ApiError } from '@contract'
import * as D from '@/domain/decimal'
import { useApi } from '@/api'
import { useCart } from '@/store/cart'
import { useHotkeys } from '@/hooks/useHotkeys'
import { createScannerListener } from '@/lib/scanner'
import { digitFromEvent } from '@/lib/keys'
import type { ScanEvent } from '@/lib/scanner'
import { formatAmount } from '@/lib/format'
import { cn } from '@/lib/cn'
import { createPublisher } from '@/lib/counterDisplay'
import type { DisplaySnapshot, DisplayStage } from '@/lib/counterDisplay'
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
import { useBrand } from '@/brand/useBrand'
import { reprintInvoice } from '@/print/printJob'
import { isConnected } from '@/print/serial'
import { MedicineSearch } from './MedicineSearch'
import { CustomerPanel } from './CustomerPanel'
import { DoctorBar } from './DoctorBar'
import { SubstitutesPanel } from './SubstitutesPanel'
import { BillRail } from './BillRail'
import { CartGrid } from './CartGrid'
import { CounterHome } from './CounterHome'
import { PaymentPanel } from './PaymentPanel'
import { RecentBillsButton } from './RecentBills'
import { usePriceList } from '@/api/usePriceList'
import { useRecentInvoices } from './useRecentInvoices'
import { BatchPicker, CustomerPicker, PrescriptionDialog } from './dialogs'
import { EMPTY_QUOTE, useQuote } from './useQuote'

const TERMINAL_ID = 1

/** The customer display is a window, not a tab: it lives on the second screen. */
const DISPLAY_WINDOW = 'rxbill-customer-display'

/* The header's network chip has to be the REAL state, not a decoration. A till
   that keeps saying "Online" while the shop's link is down is worse than no
   indicator at all: the operator carries on billing and only finds out at the
   end of the day that nothing synced. Subscribed here rather than imported so
   the counter does not pull in another screen's module for six lines. */
function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function BillingScreen() {
  const api = useApi()
  const qc = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: store } = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  /* For the receipt's reseller credit line — see ThermalReceipt. */
  const brand = useBrand()
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const cart = useCart()
  const { data: quote = EMPTY_QUOTE, isFetching, error: quoteError } = useQuote(store?.id ?? 1, today, false)

  const [batchPickerLine, setBatchPickerLine] = useState<string | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [prescriptionOpen, setPrescriptionOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [doctor, setDoctor] = useState<Doctor | null>(null)
  const [substitutesFor, setSubstitutesFor] = useState<string | null>(null)
  /** The row whose dispensing instruction is being typed, if any (Alt+M). */
  const [noteLineId, setNoteLineId] = useState<string | null>(null)
  const customerRef = useRef<HTMLInputElement>(null)
  const discountRef = useRef<HTMLInputElement>(null)
  const billNoteRef = useRef<HTMLInputElement>(null)
  const [lastInvoice, setLastInvoice] = useState<SaleInvoice | null>(null)
  /* Distinct from `lastInvoice`, which lives until the next sale so Ctrl+P can
     reprint it. This one is only what the CUSTOMER's screen is still showing,
     and it is cleared the moment the next bill starts. */
  const [showingPaid, setShowingPaid] = useState<SaleInvoice | null>(null)
  const submitPaymentRef = useRef<(() => void) | null>(null)

  const { data: recentInvoices = [], isLoading: recentLoading } = useRecentInvoices(today)

  /* The chain's list, resolved for THIS bill's date. Never awaited — a price
     list that has not loaded prices at zero and the queue keeps moving. */
  const { policyFor } = usePriceList(today)

  const hasH1 = quote.lines.some((l) => l.drugSchedule === 'H1')

  /** Focus returns to search after every completed action. It is the resting place. */
  const focusSearch = useCallback(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])

  const addMedicine = useCallback((m: Medicine, qty = '1') => {
    cart.addLine({
      medicineId: m.id,
      brandName: m.brandName,
      packLabel: m.packLabel,
      unitsPerPack: m.unitsPerPack,
      allowLooseSale: m.allowLooseSale,
      // A pack-only item must not start at a single unit; the operator would have
      // to correct every line.
      qty: m.allowLooseSale ? qty : String(m.unitsPerPack),
      /* The line opens AT the chain's price. Anything the operator does from
         here is discretion, and is measured against this. */
      policyPct: policyFor(m),
    })
    setShowingPaid(null)
    focusSearch()
  }, [cart, focusSearch, policyFor])

  const addHit = useCallback((hit: MedicineSearchHit, qty = '1') => {
    addMedicine(hit.medicine, qty)
  }, [addMedicine])

  const reprint = useCallback((invoice: SaleInvoice) => {
    if (!store) return
    /* A reprint, so never the drawer: the money went in an hour ago and an
       unexplained open till is what a shrinkage investigation starts from. */
    void reprintInvoice(invoice, store, brand).then(({ route }) => {
      if (route === 'browser' && isConnected()) {
        toast.warning('The printer did not take it', {
          description: 'Sent to the browser print dialog instead — check the paper and the power.',
        })
      } else {
        toast.success(`Reprinted ${invoice.invoiceNo}`)
      }
    })
  }, [store, brand])

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
  /** Selecting a prescriber IS recording it on the bill; keep the two in step. */
  const attachDoctor = useCallback((d: Doctor | null) => {
    setDoctor(d)
    if (!d) return
    const existing = useCart.getState().prescription
    cart.setPrescription({
      ...(existing ?? { patientName: '', prescriptionDate: today }),
      prescriberId: d.id,
      prescriberName: d.name,
      ...(d.registrationNo ? { prescriberRegNo: d.registrationNo } : {}),
      ...(d.clinicName ? { prescriberAddress: d.clinicName } : {}),
    })
  }, [cart, today])

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
          /* Trimmed at the wire, never in the store: a controlled field that
             trims on every keystroke can never hold a space. */
          ...(l.note?.trim() ? { note: l.note.trim() } : {}),
        }]
      })
      const reason = cart.ids.map((id) => cart.byId[id]?.overrideReason).find(Boolean)
      const billNote = cart.billNote.trim()
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
        ...(billNote ? { note: billNote } : {}),
      })
    },
    onSuccess: (invoice) => {
      setLastInvoice(invoice)
      setShowingPaid(invoice)
      toast.success(`Saved ${invoice.invoiceNo}`, {
        description: `₹${invoice.quote.netAmount}${Number(invoice.changeDue) > 0 ? ` · change ₹${invoice.changeDue}` : ''}`,
        action: { label: 'Print', onClick: () => window.print() },
      })
      cart.reset()
      setCustomer(null)
      setDoctor(null)
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void qc.invalidateQueries({ queryKey: ['search'] })
      // The reprint strip is only useful if the bill just posted is already in it.
      void qc.invalidateQueries({ queryKey: ['billing', 'recent-invoices'] })
      // The dashboard caches for five minutes; a completed sale is exactly the
      // event that must beat that cache.
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
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
      const billNote = cart.billNote.trim()
      return api.holdBill({
        token,
        label: customer?.name ?? `Counter ${TERMINAL_ID}`,
        itemCount: cart.ids.length,
        netAmount: quote.netAmount,
        lines: cart.ids.flatMap((id) => {
          const l = cart.byId[id]
          return l
            ? [{
                lineId: l.lineId, medicineId: l.medicineId, qty: l.qty,
                freeQty: l.freeQty, discountPct: l.discountPct,
                ...(l.note?.trim() ? { note: l.note.trim() } : {}),
              }]
            : []
        }),
        ...(cart.customerId ? { customerId: cart.customerId } : {}),
        ...(billNote ? { note: billNote } : {}),
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
          /* Re-resolved against the list in force NOW, not the one that was live
             when the bill was parked: it will be posted today and priced today.
             If a new list started while it sat on the shelf, the line reads as
             short of policy — which is exactly what it is. */
          policyPct: policyFor(m),
          // The instruction was written before the interruption; it survives it.
          ...(l.note ? { note: l.note } : {}),
        }]
      })
      const dropped = bill.lines.length - lines.length
      cart.loadLines(lines, bill.customerId ?? null, token, bill.note ?? '')
      setShowingPaid(null)
      await api.dropHeldBill(token)
      void qc.invalidateQueries({ queryKey: ['held'] })
      toast.success(`Recalled token ${token}`, {
        description: dropped > 0 ? `${dropped} item(s) no longer in the catalogue were dropped.` : undefined,
      })
      focusSearch()
    } catch {
      toast.error(`Nothing held on token ${token}`)
    }
  }, [api, cart, qc, focusSearch, policyFor])

  // ------------------------------------------------------------ shortcuts ---
  useHotkeys('billing', {
    'search.focus': focusSearch,
    'bill.new': () => {
      // F2 is one key away from the cart grid, and an unconfirmed reset there
      // silently destroys a bill the operator has been building.
      if (cart.ids.length > 0 && !window.confirm(`Discard this bill (${cart.ids.length} items)?`)) return
      cart.reset(); setCustomer(null); setShowingPaid(null); focusSearch()
    },
    'bill.hold': () => { if (cart.ids.length) hold.mutate() },
    'bill.recall': () => { if (held[0]) void recall(held[0].token) },
    'bill.recallSlot': (e) => {
      // Not Number(e.key): macOS composes Option+digit into another character
      // entirely, so the digit has to come off the physical code.
      const n = digitFromEvent(e)
      if (n !== null && n >= 1 && n <= 9) void recall(n)
    },
    'customer.attach': () => { customerRef.current?.focus(); customerRef.current?.select() },
    /*
     * F4 means "discount", and WHICH discount depends on where you are — a line
     * discount inside the grid, the bill discount everywhere else. Declaring it in
     * both scopes did not work: the cart binding is enabled whenever the cart has
     * lines, not when focus is in it, so the narrower scope swallowed F4 from the
     * moment there was anything to discount — including from inside the rail's own
     * discount box, which it then yanked focus out of.
     */
    'bill.discount': () => {
      const row = document.activeElement?.closest('[data-line-id]')
      if (row) {
        const cell = row.querySelectorAll('input')[2] as HTMLInputElement | undefined
        cell?.focus()
        cell?.select()
        return
      }
      discountRef.current?.focus()
      discountRef.current?.select()
    },
    /* Alt+M is contextual for exactly the reason F4 is, and resolved the same
       way — from where focus actually IS, not from which scope happens to be
       enabled. Inside a row it opens that line's dispensing instruction; outside
       one it goes to the bill's own remark. */
    'bill.note': () => {
      const row = document.activeElement?.closest('[data-line-id]')
      const lineId = row?.getAttribute('data-line-id')
      if (lineId) {
        setNoteLineId(lineId)
        return
      }
      billNoteRef.current?.focus()
      billNoteRef.current?.select()
    },
    'search.salt': () => {
      const id = useCart.getState().focusedLineId
      if (id) setSubstitutesFor(id)
    },
    /* Alt+O belongs to DoctorBar, which owns prescriber selection. Two hooks in
       the SAME scope claiming one id fight, and the first mounted one wins — so
       binding it here silently shadowed the popover with the patient dialog.
       Patient details are reached from the compliance strip in the bill rail. */
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
      if (!lastInvoice || !store) {
        toast.info('Nothing to reprint yet', { description: 'Alt+R lists today’s bills.' })
        return
      }
      reprint(lastInvoice)
    },
    'escape': () => {
      if (noteLineId) setNoteLineId(null)
      else if (cart.stage === 'PAYMENT') cart.setStage('CART')
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
  }, { enabled: cart.ids.length > 0 })

  // Depends on `store`: until it resolves this component renders a skeleton and
  // the input does not exist yet, so focusing on mount alone silently does nothing.
  useEffect(() => {
    if (store) focusSearch()
  }, [store, focusSearch])

  // -------------------------------------------------------- second screen ---
  const displayStage: DisplayStage =
    cart.ids.length === 0
      ? (showingPaid ? 'PAID' : 'IDLE')
      : cart.stage === 'PAYMENT' ? 'PAYMENT' : 'CART'

  const snapshot = useMemo<DisplaySnapshot | null>(() => {
    if (!store) return null
    const paid = displayStage === 'PAID' ? showingPaid : null
    const shown = paid ? paid.quote : quote
    return {
      v: 2,
      at: Date.now(),
      stage: displayStage,
      storeName: store.name,
      tagline: store.tagline,
      upiVpa: store.upiVpa,
      customerName: paid ? paid.customerName : (customer?.name ?? null),
      lines: shown.lines.map((l) => ({
        lineId: l.lineId,
        brandName: l.brandName,
        packLabel: l.packLabel,
        qty: l.allocatedQty,
        /* Summed in decimal, not with `+`: a loose-sale free quantity is a
           fraction, and 0.1 + 0.2 on the customer's own screen is exactly the
           figure nobody can explain across a counter. */
        freeQty: D.toStr(D.sum(l.allocations.map((a) => D.dec(a.freeQty))), 3),
        ratePerUnit: l.allocations[0]?.ratePerUnit ?? '0.00',
        amount: l.lineTotal,
        ...(l.note ? { note: l.note } : {}),
      })),
      itemCount: shown.lines.length,
      grossAmount: shown.grossAmount,
      /* Two server-computed figures added together, never re-derived: the
         "you saved" line has to agree with the two discount rows on the rail. */
      savedAmount: D.toStr(D.add(D.dec(shown.itemDiscount), D.dec(shown.billDiscount))),
      netAmount: shown.netAmount,
      billNote: paid ? (paid.note ?? '') : cart.billNote,
      ...(paid ? { invoiceNo: paid.invoiceNo, amountPaid: paid.amountPaid, changeDue: paid.changeDue } : {}),
    }
  }, [store, displayStage, showingPaid, quote, customer, cart.billNote])

  /* One channel per mount, closed on unmount. A publisher recreated per render
     would drop the `hello` handler a display window is relying on to catch up. */
  const publisherRef = useRef<ReturnType<typeof createPublisher> | null>(null)
  if (publisherRef.current === null) publisherRef.current = createPublisher()
  useEffect(() => () => { publisherRef.current?.close(); publisherRef.current = null }, [])
  useEffect(() => {
    if (snapshot) publisherRef.current?.publish(snapshot)
  }, [snapshot])

  if (!store) {
    return <div className="p-6"><SkeletonRows rows={10} cols={6} /></div>
  }

  const pickerLine = batchPickerLine ? cart.byId[batchPickerLine] : null
  const itemCount = cart.ids.length

  return (
    <div className="flex h-full min-h-0 flex-col" data-density="pos">
      <PosHeader
        itemCount={itemCount}
        netAmount={quote.netAmount}
        priced={quoteError === null}
        busy={isFetching}
        lastInvoiceNo={lastInvoice?.invoiceNo ?? null}
        held={held.length}
        onHold={() => hold.mutate()}
        canHold={itemCount > 0}
        onRecall={() => { if (held[0]) void recall(held[0].token) }}
        recentInvoices={recentInvoices}
        recentLoading={recentLoading}
        onReprint={reprint}
        doctor={doctor}
        onDoctor={attachDoctor}
        doctorRequired={hasH1}
      />

      <div className="flex min-h-0 flex-1">
        {/* LEFT — who is buying. Search, create-in-place, allergies, credit, history. */}
        <div className="flex h-full w-[272px] shrink-0 flex-col border-r border-border bg-surface 2xl:w-[300px]">
          <CustomerPanel
            customer={customer}
            focusRef={customerRef}
            onAttach={(c) => { setCustomer(c); cart.setCustomer(c.id); focusSearch() }}
            onClear={() => { setCustomer(null); cart.setCustomer(null) }}
          />
        </div>

        {/* MIDDLE — what is being dispensed, and the bill lines. */}
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          {/* The results float over the cart, which is idle while anyone is typing. */}
          <div className="relative z-20 shrink-0 border-b border-border-subtle px-3 py-2">
            <MedicineSearch
              inputRef={searchRef}
              onPick={(hit) => addHit(hit)}
              onShortbook={(term, hit) => {
                void api.addToShortbook(hit?.medicine.id ?? null, term, '1')
                toast.success('Added to short book', { description: `“${term}” — the reorder list will show it.` })
                focusSearch()
              }}
            />
          </div>

          {itemCount === 0 ? (
            <CounterHome
              today={today}
              recentInvoices={recentInvoices}
              recentLoading={recentLoading}
              onPick={addMedicine}
              onReprint={reprint}
            />
          ) : (
            <CartGrid
              quote={quote}
              today={today}
              noteLineId={noteLineId}
              onOpenNote={setNoteLineId}
              onNoteDone={(returnFocus) => { setNoteLineId(null); if (returnFocus) focusSearch() }}
              onEscapeToSearch={focusSearch}
              onOpenBatchPicker={(id) => setBatchPickerLine(id)}
            />
          )}
        </div>

        {/* RIGHT — the bill. Compact enough to sit above the fold at 1366x768. */}
        {cart.stage === 'CART' ? (
          <BillRail
            quote={quote}
            quoteError={quoteError}
            itemCount={itemCount}
            hasH1={hasH1}
            prescriptionDone={cart.prescription !== null && Boolean(cart.prescription.patientName)}
            onPrescription={() => setPrescriptionOpen(true)}
            billDiscountPct={cart.billDiscountPct}
            onBillDiscount={cart.setBillDiscount}
            discountRef={discountRef}
            billNote={cart.billNote}
            onBillNote={cart.setBillNote}
            billNoteRef={billNoteRef}
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
      </div>

      <SubstitutesPanel
        open={substitutesFor !== null}
        onOpenChange={(v) => !v && setSubstitutesFor(null)}
        medicineId={substitutesFor ? (cart.byId[substitutesFor]?.medicineId ?? null) : null}
        brandName={substitutesFor ? (cart.byId[substitutesFor]?.brandName ?? '') : ''}
        currentMrp={
          substitutesFor
            ? (quote.lines.find((l) => l.lineId === substitutesFor)?.allocations[0]?.mrpPerUnit ?? null)
            : null
        }
        onPick={(hit) => { addHit(hit); setSubstitutesFor(null) }}
      />

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
            <ThermalReceipt invoice={lastInvoice} store={store} brand={brand} />
          </Suspense>,
          document.body,
        )}
    </div>
  )
}

/**
 * The POS page header.
 *
 * Full width and above all three columns on purpose: the bill's identity, the
 * prescriber and the till's own state are facts about the WHOLE screen, and
 * scattering them into the middle column left the customer panel and the totals
 * rail starting at three different heights.
 *
 * It is still two lines. The 1366x768 floor buys the cart every pixel it can,
 * so the header carries a title, one line of description, and nothing that
 * could equally have been a tooltip.
 */
function PosHeader({
  itemCount, netAmount, priced, busy, lastInvoiceNo, held, onHold, canHold, onRecall,
  recentInvoices, recentLoading, onReprint, doctor, onDoctor, doctorRequired,
}: {
  itemCount: number
  netAmount: string
  priced: boolean
  busy: boolean
  lastInvoiceNo: string | null
  held: number
  onHold: () => void
  canHold: boolean
  onRecall: () => void
  recentInvoices: SaleInvoice[]
  recentLoading: boolean
  onReprint: (invoice: SaleInvoice) => void
  doctor: Doctor | null
  onDoctor: (d: Doctor | null) => void
  doctorRequired: boolean
}) {
  const printerLinked = isConnected()
  /* `() => true` is the server snapshot: this never renders on a server, but
     omitting it makes the hook throw if it ever does. */
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

  return (
    <header
      className="page-header shrink-0"
      style={{ paddingInline: 'var(--page-px)' }}
    >
      <div className="flex items-center gap-3 pt-2">
        <h1 className="shrink-0 text-2xl font-semibold tracking-tight">Billing</h1>
        <span className="shrink-0 rounded-[var(--radius-full)] border border-border bg-surface px-2 py-0.5 text-2xs font-medium text-fg-muted">
          Counter {TERMINAL_ID}
        </span>

        {/* Live total in the header as well as on the rail. The operator's eyes
            are on the middle of the screen while scanning, not on the far right. */}
        {itemCount > 0 && (
          <span className="shrink-0 text-lg font-medium tabular-nums-off">
            {/* The symbol belongs to the FIGURE, not to the slot: rendered
                unconditionally it read "₹Unpriced", which is the one phrase a
                till must never put in front of a customer. */}
            {priced
              ? <><span className="text-fg-muted">₹</span>{formatAmount(netAmount)}</>
              : <span className="text-danger-11">Unpriced</span>}
          </span>
        )}

        <div className="min-w-0 flex-1" />

        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 text-2xs',
            printerLinked ? 'text-success-11' : 'text-fg-subtle',
          )}
        >
          <Printer size={13} aria-hidden />
          {printerLinked ? 'Printer linked' : 'Browser print'}
        </span>
        {/* Colour never carries it alone: the glyph and the word both change. */}
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 text-2xs',
            online ? 'text-fg-subtle' : 'text-warning-11',
          )}
        >
          {online
            ? <><Wifi size={13} aria-hidden /> Online</>
            : <><WifiOff size={13} aria-hidden /> Offline</>}
        </span>

        <button
          type="button"
          onClick={() => window.open('/display', DISPLAY_WINDOW, 'width=1280,height=800')}
          className="flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 text-sm text-fg-muted hover:border-border-strong hover:bg-hover hover:text-fg"
        >
          <Monitor size={15} aria-hidden />
          Customer screen
          <ExternalLink size={12} aria-hidden />
        </button>

        <RecentBillsButton
          invoices={recentInvoices}
          loading={recentLoading}
          onReprint={onReprint}
        />

        <Button size="sm" className="h-9" onClick={onHold} disabled={!canHold}>
          <Pause /> Hold <Kbd>F8</Kbd>
        </Button>
        <Button size="sm" className="h-9" onClick={onRecall} disabled={held === 0}>
          <RotateCcw /> Recall {held > 0 && <span className="num">{held}</span>} <Kbd>F9</Kbd>
        </Button>
      </div>

      <div className="flex items-center gap-3 pb-2 pt-1">
        <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {itemCount === 0
            ? 'New bill — scan a pack or type a brand, salt or manufacturer. Batch and expiry are chosen by first-expiry-first-out.'
            : `${itemCount} ${itemCount === 1 ? 'item' : 'items'} on this bill — Ctrl ↵ takes payment, F8 parks it, Alt+M adds a remark.`}
          {lastInvoiceNo && (
            <span className="mono ml-2 text-fg-subtle">last {lastInvoiceNo}</span>
          )}
        </p>
        {busy && <span className="shrink-0 text-2xs text-fg-subtle">re-quoting…</span>}
        <DoctorBar doctor={doctor} onSelect={onDoctor} required={doctorRequired} />
      </div>
    </header>
  )
}

export function BillingError({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-danger-11"><CircleAlert size={18} /> {message}</div>
    </div>
  )
}
