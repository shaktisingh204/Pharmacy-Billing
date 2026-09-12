import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { nanoid } from 'nanoid'
import { toast } from 'sonner'
import {
  ArrowRight, BadgeCheck, Building2, CircleAlert, CircleCheck, FileWarning,
  Plus, RotateCcw, ScanBarcode, Search, ShieldAlert, Truck, X,
} from 'lucide-react'
import type {
  GoodsScanResult, Medicine, PurchaseInvoice, PurchaseInvoiceInput, PurchaseLine, PurchaseOrder,
  Supplier,
} from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { orderedPacks } from '@/api/purchaseOrders'
import type { KeyedLine } from '@/api/purchaseOrders'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Chip } from '@/components/ui/Badge'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'
import { MedicineForm } from '@/pages/medicines/MedicineForm'
import { SupplierForm } from '@/pages/suppliers/SupplierForm'
import {
  GrnLineGrid, blankLine, isLineBlank, latestBatchDefaults, lineReady, toLineInput,
} from './GrnLineGrid'
import { OrderPicker, OrderProgressStrip } from './ReceiveOrder'
import { SupplierScoreStrip } from './SupplierScoreStrip'
import { createScannerListener } from '@/lib/scanner'
import type { ScanEvent } from '@/lib/scanner'
import type { BatchDefaults, DraftLine } from './GrnLineGrid'

/**
 * Goods receipt — the second-most-typed screen in a pharmacy.
 *
 * Three decisions carry it:
 *
 *  - THE SERVER OWNS EVERY NUMBER. `quotePurchase` is pure and read-only, so the
 *    draft is re-priced on every keystroke and the view renders what comes back.
 *    Landed cost divides by (paid + free) and freight is apportioned by value;
 *    both are non-terminating decimals on most scheme lines, and a second
 *    implementation up here would disagree with the batch that gets written.
 *  - THE PAPER TOTAL IS A CONTROL, NOT A FIELD. The operator types the grand
 *    total off the distributor's invoice and the footer states, continuously,
 *    whether the keyed bill agrees. It is the single check that catches a
 *    mistyped rate on line 23 of 40 — every other validation catches one kind of
 *    error, and this one catches all of them at once. Marg does not have it.
 *  - A DUPLICATE IS A REDIRECTION, NOT A FAILURE. Keying the same distributor
 *    bill twice is the most common goods-receipt error there is, so
 *    PURCHASE_EXISTS names the document that already holds it and offers to open
 *    it, rather than reporting that something clashed.
 */

// ------------------------------------------------------ shared panel state ---

/**
 * Three panels live on this screen — the receipt, the register and the short
 * book — and each fetches its own data and has to render the same five states
 * out of it. The rule is written once, here, rather than transcribed three times
 * into `if` ladders that drift apart the first time one of them grows a case.
 * They live in this file because it is the one the other two already depend on,
 * which keeps the module graph acyclic.
 */

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

export type PanelStatus = 'ready' | 'loading' | 'error' | 'offline' | 'denied'

/** Phase 5 gates purchases behind a real permission; the code is the contract. */
const DENIED_CODES = new Set(['FORBIDDEN', 'PERMISSION_DENIED'])

export function panelStatus(
  q: { isPending: boolean; error: unknown; hasData: boolean },
  online: boolean,
): PanelStatus {
  if (q.error instanceof ApiError && DENIED_CODES.has(q.error.code)) return 'denied'
  if (!online && !q.hasData) return 'offline'
  if (q.error) return 'error'
  if (q.isPending) return 'loading'
  return 'ready'
}

// ---------------------------------------------------------------- the seed ---

/** A line handed in from the short book, already resolved to a catalogue row. */
export interface GrnSeed {
  /** Bumped per request, so the same medicine can be sent twice. */
  nonce: number
  medicineId: number | null
  brandName: string
  packLabel: string
  unitsPerPack: number
  mrpPerPack: string
  gstRatePct: string
}

// ------------------------------------------------------------- duplicate doc ---

interface ExistingDoc {
  id: number | null
  purchaseNo: string
  supplierInvoiceNo: string
  invoiceDate: string
  netAmount: string
}

/**
 * `code` is the contract; `details` is not.
 *
 * The adapter puts the clashing document in `details`, which is what lets this
 * screen NAME it instead of only saying that something clashed — but the shape
 * is read defensively, because a later backend is free to send only an id, and a
 * screen that trusts an undocumented payload breaks at cutover.
 */
function existingFrom(details: unknown): ExistingDoc {
  const d = typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    id: typeof d.id === 'number' ? d.id : typeof d.purchaseId === 'number' ? d.purchaseId : null,
    purchaseNo: str(d.purchaseNo),
    supplierInvoiceNo: str(d.supplierInvoiceNo),
    invoiceDate: str(d.invoiceDate),
    netAmount: str(d.netAmount),
  }
}

// ------------------------------------------------------------------ totals ---

/** What the paper-total field HOLDS. '7.' is a keystroke on the way to '7.5'. */
const MONEYISH = /^\d+(\.\d{1,2})?$/

/** A `type="date"` input reads '' when it is cleared, and the API rejects that. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Today, on the SHOP's calendar.
 *
 * `toISOString()` would answer in UTC, and IST is five and a half hours ahead of
 * it: every receipt keyed before 05:30 — which is when a chemist near a hospital
 * opens — would date itself to yesterday, land in the wrong day's purchase
 * register and, one day in twelve, in the wrong month's return.
 */
function localToday(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Re-establish the ghost row: there is always exactly one blank line at the
 * bottom of the grid.
 *
 * That single invariant is what lets NATIVE Tab carry the operator off the end
 * of a line into the next medicine field — the row is already mounted, so
 * nothing has to be focused after a state update, and no interceptor has to
 * guess where the cursor was going.
 */
function withGhost(next: DraftLine[]): DraftLine[] {
  const last = next.at(-1)
  return last && isLineBlank(last) ? next : [...next, blankLine(nanoid())]
}

// ------------------------------------------------------------------ screen ---

export function GrnEntry({
  seed, onOpenPurchase,
}: {
  seed: GrnSeed | null
  /** Hands a document id to the register — used by the duplicate banner. */
  onOpenPurchase: (id: number) => void
}) {
  const api = useApi()
  const qc = useQueryClient()
  const online = useOnline()
  const today = useMemo(() => new Date(), [])
  const todayIso = useMemo(() => localToday(today), [today])
  const bodyRef = useRef<HTMLDivElement>(null)

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [invoiceNo, setInvoiceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(todayIso)
  const [freight, setFreight] = useState('')
  const [paperTotal, setPaperTotal] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(nanoid())])
  const [createFor, setCreateFor] = useState<{ lineId: string; term: string } | null>(null)
  const [supplierFormOpen, setSupplierFormOpen] = useState(false)
  const [supplierFormSeed, setSupplierFormSeed] = useState<Supplier | null>(null)
  const [duplicate, setDuplicate] = useState<ExistingDoc | null>(null)
  /** The order these goods are being received against, when there is one. */
  const [againstOrder, setAgainstOrder] = useState<PurchaseOrder | null>(null)
  const [seedingOrder, setSeedingOrder] = useState(false)

  /* Stable for the life of one draft: replaying it must return the ORIGINAL
     document, so it may not change between a failed post and its retry. */
  const [idempotencyKey, setIdempotencyKey] = useState(() => nanoid())

  // --------------------------------------------------------------- suppliers ---

  const suppliers = useQuery({
    queryKey: ['purchases', 'suppliers'],
    queryFn: () => api.listSuppliers(),
  })

  // ------------------------------------------------------ against an order ---

  /* Fetched only once a distributor is named: the picker is meaningless before
     that, and this tab is where the screen opens. */
  const orders = useQuery({
    queryKey: ['purchaseOrders'],
    queryFn: () => api.listPurchaseOrders({}),
    enabled: supplier !== null,
  })

  const openOrders = useMemo(
    () => (orders.data ?? []).filter((o) =>
      o.supplierId === supplier?.id && (o.status === 'OPEN' || o.status === 'PART')),
    [orders.data, supplier],
  )

  const status = panelStatus(
    { isPending: suppliers.isPending, error: suppliers.error, hasData: suppliers.data !== undefined },
    online,
  )

  // -------------------------------------------------------------- line edits ---

  const patchLine = useCallback((lineId: string, patch: Partial<DraftLine>) => {
    setLines((prev) => withGhost(prev.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l))))
  }, [])

  const resolveLine = useCallback((lineId: string, m: Medicine, defaults: BatchDefaults | null) => {
    setLines((prev) => withGhost(prev.map((l) => {
      if (l.lineId !== lineId) return l
      /* Seeded only into cells the operator has not answered. The last receipt
         is a default, never an overrule. */
      const seedMrp = defaults !== null && l.mrpPerPack.trim() === ''
      const seedGst = defaults !== null && l.gstRatePct.trim() === ''
      return {
        ...l,
        medicineId: m.id,
        brandName: m.brandName,
        packLabel: m.packLabel,
        unitsPerPack: m.unitsPerPack,
        ...(seedMrp ? { mrpPerPack: defaults.mrpPerPack, seededMrp: true } : {}),
        ...(seedGst ? { gstRatePct: defaults.gstRatePct, seededGst: true } : {}),
      }
    })))
  }, [])

  // --------------------------------------------------------------- scanner ---

  /**
   * Scanning a distributor's carton.
   *
   * Batch and expiry are the most error-prone typing in the whole app: keyed by
   * hand off a carton, forty lines at a time, usually while a driver waits. Both
   * print on the customer's bill and are what a Drug Inspector checks against
   * the strip — and a mis-keyed expiry also poisons FEFO allocation and every
   * near-expiry report for the next two years.
   *
   * The carton already carries all three in a GS1-128 or DataMatrix. The scan
   * fills the TRAILING BLANK ROW rather than whatever is focused: a scanner
   * fires while the cursor is wherever the last keystroke left it, and writing a
   * batch into a row somebody had already finished is worse than not scanning.
   */
  const [pendingLink, setPendingLink] = useState<GoodsScanResult | null>(null)

  const applyScan = useCallback((r: GoodsScanResult) => {
    if (!r.medicine) return
    const m = r.medicine
    setLines((prev) => {
      const target = prev.at(-1)
      if (!target) return prev
      return withGhost(prev.map((l) => (l.lineId === target.lineId
        ? {
            ...l,
            medicineId: m.id,
            brandName: m.brandName,
            packLabel: m.packLabel,
            unitsPerPack: m.unitsPerPack,
            /* Only what the CARTON carried. A plain product barcode has no batch
               and no expiry, and blanking those would delete what was typed. */
            ...(r.batchNo !== null ? { batchNo: r.batchNo } : {}),
            ...(r.expiry !== null ? { expiry: r.expiry } : {}),
          }
        : l)))
    })
  }, [])

  const onScan = useCallback((payload: string) => {
    void api.resolveGoodsScan(payload).then((r) => {
      if (r.kind === 'unknown') {
        toast.warning('Nothing matched that code', {
          description: 'Scan the product barcode, or type the name to find it.',
        })
        return
      }
      if (r.kind === 'unknownGtin') {
        /* The ordinary case on a first delivery. The batch and expiry are held
           and applied the moment the code is linked — one scan and one pick,
           never a re-scan. */
        setPendingLink(r)
        return
      }
      applyScan(r)
      toast.success(r.message)
    })
  }, [api, applyScan])

  useEffect(() => {
    const listener = createScannerListener({ onScan: (e: ScanEvent) => onScan(e.raw) })
    const handler = (ev: KeyboardEvent) => listener.handleKeyDown(ev)
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onScan])

  const linkScanned = useCallback((m: Medicine) => {
    const held = pendingLink
    if (!held?.gtin) return
    void api.linkBarcode(m.id, held.gtin, 'gs1').then(() => {
      applyScan({ ...held, medicine: m })
      setPendingLink(null)
      toast.success(`${m.brandName} linked to that carton`, {
        description: 'The next delivery of this line fills itself.',
      })
    })
  }, [api, applyScan, pendingLink])

  const removeLine = useCallback((lineId: string) => {
    setLines((prev) => withGhost(prev.filter((l) => l.lineId !== lineId)))
  }, [])

  /**
   * Fill the grid from a purchase order.
   *
   * What is seeded is exactly what the order KNOWS — the medicine, its pack, and
   * the quantity that was asked for — plus the MRP and purchase GST rate off the
   * last batch received, which is the same default a short-book pick gets. Batch,
   * expiry and rate are deliberately not invented: they come off the paper bill,
   * and a receipt whose rate was assumed is the one the total-match check exists
   * to catch.
   *
   * Nothing already keyed is thrown away. If the operator has started the bill,
   * the ordered lines they have not reached yet are APPENDED — losing ten keyed
   * rows to a mis-click on a dropdown is not a trade anybody would take.
   */
  const receiveOrder = useCallback(async (order: PurchaseOrder | null) => {
    if (order === null) {
      setAgainstOrder(null)
      return
    }
    setSeedingOrder(true)
    try {
      const ids = order.lines.map((l) => l.medicineId)
      const [found, batchLists] = await Promise.all([
        api.getMedicines(ids),
        Promise.all(ids.map((id) => api.getBatches(id).catch(() => []))),
      ])
      const byId = new Map(found.map((m) => [m.id, m]))

      setLines((prev) => {
        const keyed = prev.filter((l) => !isLineBlank(l))
        const already = new Set(keyed.map((l) => l.medicineId))
        const seeded = order.lines
          .filter((line) => !already.has(line.medicineId))
          .map((line) => {
            const m = byId.get(line.medicineId)
            const at = ids.indexOf(line.medicineId)
            const defaults = latestBatchDefaults(batchLists[at] ?? [])
            const perPack = m?.unitsPerPack ?? 1
            /* Null when the order does not divide into whole packs. A
               distributor cannot ship two thirds of a strip, and a number
               nobody typed has no business on a bill. */
            const packs = orderedPacks(line.qty, perPack)
            return {
              ...blankLine(nanoid()),
              medicineId: m?.id ?? line.medicineId,
              brandName: m?.brandName ?? line.brandName,
              packLabel: m?.packLabel ?? line.packLabel,
              unitsPerPack: perPack,
              qtyPacks: packs ?? '',
              ...(defaults === null ? {} : {
                mrpPerPack: defaults.mrpPerPack,
                seededMrp: true,
                gstRatePct: defaults.gstRatePct,
                seededGst: true,
              }),
            }
          })
        return withGhost([...keyed, ...seeded])
      })
      setAgainstOrder(order)
    } catch (e) {
      toast.error('That order could not be loaded', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    } finally {
      setSeedingOrder(false)
    }
  }, [api])

  /* A short-book pick lands in the trailing blank row, adjusted during render so
     the grid never paints a frame without it. */
  const [lastSeedNonce, setLastSeedNonce] = useState(0)
  if (seed !== null && seed.nonce !== lastSeedNonce) {
    setLastSeedNonce(seed.nonce)
    setLines((prev) => {
      const target = prev.at(-1)
      if (!target) return prev
      return withGhost(prev.map((l) => (l.lineId === target.lineId ? {
        ...l,
        medicineId: seed.medicineId,
        brandName: seed.brandName,
        packLabel: seed.packLabel,
        unitsPerPack: seed.unitsPerPack,
        ...(seed.mrpPerPack ? { mrpPerPack: seed.mrpPerPack, seededMrp: true } : {}),
        ...(seed.gstRatePct ? { gstRatePct: seed.gstRatePct, seededGst: true } : {}),
      } : l)))
    })
  }

  /* Focus follows the seeded row, which the ghost invariant puts second-to-last.
     An effect that only moves focus writes no state and is not the pattern the
     guardrails ban. */
  useEffect(() => {
    if (lastSeedNonce === 0) return
    const row = bodyRef.current?.querySelector<HTMLElement>('[data-line-row]:nth-last-child(2)')
    const cells = row?.querySelectorAll<HTMLInputElement>('input[data-cell]')
    const batch = cells?.[1]
    batch?.focus()
    batch?.select()
  }, [lastSeedNonce])

  // ------------------------------------------------------------------ pricing ---

  /* A blank row is not a line; a row with a blocking issue is a line the operator
     started and has not finished, and it is deliberately NOT dropped silently —
     it stays out of the quote and blocks the post, with the reason on the row. */
  const readyLines = useMemo(
    () => lines.filter((l) => !isLineBlank(l) && lineReady(l, today)),
    [lines, today],
  )
  const unfinished = useMemo(
    () => lines.filter((l) => !isLineBlank(l) && !lineReady(l, today)).length,
    [lines, today],
  )

  /*
   * The header is part of the request, not decoration.
   *
   * `pricePurchase` REJECTS a receipt with no distributor invoice number or a
   * malformed invoice date — both are PURCHASE_INVALID, the same code a bad rate
   * raises. Sending one anyway put a red "this bill could not be priced — do not
   * post it" across the top of a bill whose only fault was that the number had
   * not been keyed yet, which is the state every receipt passes through if the
   * operator keys the lines before the header. An incomplete header is a reason
   * not to ASK, and the grid says which field is missing.
   */
  const headerBlocker = supplier === null
    ? 'Choose the supplier above to price this bill — the tax split depends on their state.'
    : invoiceNo.trim() === ''
      ? 'Key the distributor’s bill number above — a receipt is priced and filed against it.'
      : !ISO_DATE.test(invoiceDate)
        ? 'Key the date printed on the distributor’s bill above to price this receipt.'
        : null

  const request: PurchaseInvoiceInput | null = supplier === null || headerBlocker !== null
    || readyLines.length === 0
    ? null
    : {
      idempotencyKey,
      supplierId: supplier.id,
      supplierInvoiceNo: invoiceNo.trim(),
      invoiceDate,
      lines: readyLines.map(toLineInput),
      ...(MONEYISH.test(freight.trim()) ? { freight: freight.trim() } : {}),
      /* The order this receipt answers, ON the document. Six weeks later "did
         this delivery ever come" is a question about a bill, and the answer has
         to be on the bill rather than in somebody's memory of a dropdown. */
      ...(againstOrder === null ? {} : { notes: `Received against ${againstOrder.orderNo}` }),
    }

  const fingerprint = JSON.stringify(request)

  const quote = useQuery({
    queryKey: ['purchases', 'quote', fingerprint],
    queryFn: () => api.quotePurchase(request as PurchaseInvoiceInput),
    enabled: request !== null,
    /* The previous totals stay on screen while the next resolve. A rail that
       blanks on every keystroke is how a fast screen manages to feel slow. */
    placeholderData: (prev) => prev,
    /* A quote that fails must not retry quietly behind a stale total: a receipt
       posted against numbers nobody computed is the worst outcome here. */
    retry: false,
    /* The key carries the whole draft, so every keystroke on a forty-line bill
       mints another cache entry that will never be asked for again. Pricing is
       pure and cheap; keeping hundreds of priced invoices alive is not. */
    gcTime: 30_000,
  })

  /*
   * `placeholderData` deliberately outlives the query key so the totals do not
   * blank between keystrokes — but it outlives the LAST key too. Delete the only
   * line, or clear the supplier, and the query goes idle holding the previous
   * bill's numbers: the rail would state a net for an empty grid and the
   * total-match check would go green against a document that no longer exists.
   * A quote belongs to the request that asked for it, so it is dropped with it.
   */
  const invoice = request === null ? undefined : quote.data

  const priced = useMemo(() => {
    const map = new Map<string, PurchaseLine>()
    for (const l of invoice?.lines ?? []) map.set(l.lineId, l)
    return map
  }, [invoice])

  // -------------------------------------------------------------- total match ---

  const paperClean = paperTotal.trim()
  const paperEntered = paperClean !== '' && MONEYISH.test(paperClean)
  const net = invoice?.netAmount ?? null
  const difference = paperEntered && net !== null ? D.sub(D.dec(paperClean), D.dec(net)) : null
  const matched = difference !== null && D.isZero(difference)

  // -------------------------------------------------------------------- post ---

  const reset = useCallback(() => {
    setLines([blankLine(nanoid())])
    setInvoiceNo('')
    setFreight('')
    setPaperTotal('')
    setDuplicate(null)
    setAgainstOrder(null)
    setIdempotencyKey(nanoid())
  }, [])

  const post = useMutation({
    mutationFn: (input: PurchaseInvoiceInput) => api.postPurchase(input),
    onSuccess: (doc: PurchaseInvoice) => {
      /* Stock, the catalogue's stock joins, the POS search and the register all
         read what this just wrote. A receipt that only refreshes one of them is a
         bug somebody hits at the counter twenty minutes later. */
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void qc.invalidateQueries({ queryKey: ['medicines'] })
      void qc.invalidateQueries({ queryKey: ['search'] })
      void qc.invalidateQueries({ queryKey: ['purchases'] })
      toast.success(`${doc.purchaseNo} posted`, {
        description: `${doc.lines.length} line${doc.lines.length === 1 ? '' : 's'} · ₹${formatAmount(doc.netAmount)} · stock is live`,
        action: { label: 'Open', onClick: () => onOpenPurchase(doc.id) },
      })
      reset()
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'PURCHASE_EXISTS') {
        setDuplicate(existingFrom(err.details))
        return
      }
      toast.error('The goods receipt was not posted', {
        description: (err as Error).message,
      })
    },
  })

  /* "New GRN" throws away work, so it only lights up when there IS work. */
  const dirty = invoiceNo.trim() !== '' || freight.trim() !== '' || paperTotal.trim() !== ''
    || lines.some((l) => !isLineBlank(l))

  /* `request !== null` already carries the whole header — supplier, bill number
     and a well-formed bill date — because nothing without them can be priced. */
  const canPost = request !== null
    && unfinished === 0
    && invoice !== undefined
    && quote.error === null
    && !post.isPending

  // ------------------------------------------------------------------ states ---

  if (status === 'loading') {
    return <div className="p-4"><SkeletonRows rows={10} cols={8} /></div>
  }
  if (status === 'offline') return <OfflineState />
  if (status === 'denied') return <PermissionDenied needs="purchases.record" />
  if (status === 'error') {
    return (
      <ErrorState
        code={suppliers.error instanceof ApiError ? suppliers.error.code : 'SUPPLIERS_FAILED'}
        message={(suppliers.error as Error | null)?.message}
        onRetry={() => void suppliers.refetch()}
      />
    )
  }
  if ((suppliers.data ?? []).length === 0 && supplier === null) {
    return (
      <EmptyState
        icon={Building2}
        title="No suppliers on file"
        body="A goods receipt is a document against a distributor: their GSTIN decides the tax split and their drug licence number is legally required on the bill. Add the first one to start receiving."
        actionLabel="Add a supplier"
        onAction={() => { setSupplierFormSeed(null); setSupplierFormOpen(true) }}
      />
    )
  }

  /* Read off `invoice`, never off `quote.data`: the placeholder outlives the last
     query key, so a cleared supplier or a deleted last line would otherwise leave
     the footer stating the previous bill's tax split. */
  const interState = invoice !== undefined && !D.isZero(D.dec(invoice.igst))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ------------------------------------------------------------ header --- */}
      <div className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="flex flex-wrap items-end gap-3">
          <SupplierPicker
            value={supplier}
            options={suppliers.data ?? []}
            /* A duplicate is a clash on (supplier, bill number), so CHANGING the
               distributor retires the warning exactly as retyping the number
               does — leaving it up would state that this supplier's bill is
               already in the register, about a supplier nobody checked.
               Re-confirming the same one is not a change and leaves it. */
            onPick={(s) => {
              setSupplier(s)
              if (s.id !== supplier?.id) setDuplicate(null)
            }}
            onCreate={() => { setSupplierFormSeed(null); setSupplierFormOpen(true) }}
          />
          <HeaderField label="Supplier bill no" width="w-[132px]" required>
            <input
              value={invoiceNo}
              onChange={(e) => { setInvoiceNo(e.target.value.toUpperCase()); setDuplicate(null) }}
              placeholder="INV-4471"
              autoComplete="off"
              spellCheck={false}
              aria-label="Supplier invoice number"
              className={cn(headerInputCls, 'mono')}
            />
          </HeaderField>
          <HeaderField label="Bill date" width="w-[132px]">
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              aria-label="Supplier invoice date"
              className={cn(headerInputCls, 'num')}
            />
          </HeaderField>
          <HeaderField label="Freight ₹" width="w-[92px]">
            <input
              value={freight}
              onChange={(e) => setFreight(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0"
              inputMode="decimal"
              aria-label="Freight"
              className={cn(headerInputCls, 'num')}
            />
          </HeaderField>

          {/* The order these goods answer, if there is one. Only offered once a
              distributor is named — an order belongs to one of them. */}
          {supplier !== null ? (
            <OrderPicker
              orders={openOrders}
              selected={againstOrder}
              busy={seedingOrder}
              onPick={(order) => void receiveOrder(order)}
            />
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {quote.isFetching ? <span className="text-xs text-fg-subtle">pricing…</span> : null}
            <Button onClick={reset} disabled={!dirty}>
              <RotateCcw /> New GRN
            </Button>
          </div>
        </div>

        {/* The drug licence is not decoration: Rule 65 puts the supplier's DL on
            the purchase bill, and a missing one is a finding at inspection. */}
        {supplier ? (
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border-subtle pt-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
              {supplier.dlNo ? (
                <Chip icon={BadgeCheck} tone="var(--success-11)">DL {supplier.dlNo}</Chip>
              ) : (
                <button
                  type="button"
                  onClick={() => { setSupplierFormSeed(supplier); setSupplierFormOpen(true) }}
                  className="inline-flex h-6 items-center gap-1 rounded-[var(--radius-sm)] bg-warning-3 px-2 text-2xs font-medium text-warning-11 hover:bg-warning-9/20"
                >
                  <ShieldAlert size={12} aria-hidden /> No drug licence on file — required on a purchase bill
                </button>
              )}
              {supplier.gstin ? <span className="mono">GSTIN {supplier.gstin}</span> : <span className="text-warning-11">No GSTIN — input credit cannot be claimed</span>}
              <span aria-hidden>·</span>
              <span>{supplier.phone}</span>
              <span aria-hidden>·</span>
              <span>{supplier.paymentTermsDays} day terms</span>
              {D.gt(D.dec(supplier.outstanding), D.ZERO) ? (
                <>
                  <span aria-hidden>·</span>
                  <span>Outstanding <span className="num">₹{formatAmount(supplier.outstanding)}</span></span>
                </>
              ) : null}
            </div>
            {/* Their record, at the one moment it can be acted on: the driver is
                at the counter and the salesman is on the phone. */}
            <SupplierScoreStrip supplier={supplier} />
          </div>
        ) : null}
      </div>

      {/* --------------------------------------------------------- duplicate --- */}
      {duplicate ? (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning-9/25 bg-warning-3 px-[var(--card-px)] py-2 text-sm text-warning-11">
          <FileWarning size={15} className="shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">This bill is already in the register.</span>{' '}
            {duplicate.purchaseNo
              ? <>Supplier bill <span className="mono">{duplicate.supplierInvoiceNo || invoiceNo}</span> was received as <span className="mono">{duplicate.purchaseNo}</span>
                {duplicate.invoiceDate ? <> on {duplicate.invoiceDate}</> : null}
                {duplicate.netAmount ? <> for <span className="num">₹{formatAmount(duplicate.netAmount)}</span></> : null}.</>
              : <>A receipt against <span className="mono">{invoiceNo}</span> from {supplier?.name} already exists.</>}{' '}
            Receiving it twice doubles the stock and claims the credit twice.
          </span>
          {/* Bound to a const rather than to `duplicate.id`: the narrowing above
              does not survive into the callback, and `?? 0` would silently ask
              the register for document zero. */}
          <OpenExisting id={duplicate.id} onOpen={onOpenPurchase} />
          <Button size="sm" variant="ghost" onClick={() => setDuplicate(null)}>Dismiss</Button>
        </div>
      ) : null}

      {quote.error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-danger-9/25 bg-danger-3 px-[var(--card-px)] py-1.5 text-xs text-danger-11">
          <CircleAlert size={13} className="shrink-0" aria-hidden />
          <span><span className="font-semibold">This bill could not be priced.</span> {(quote.error as Error).message} Do not post it.</span>
        </div>
      ) : null}

      {/* A carton whose code this shop has never seen. The batch and expiry from
          that same scan are HELD, so picking the medicine fills the whole row —
          one scan and one pick, never a re-scan. */}
      {pendingLink?.gtin ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning-9/25 bg-warning-3 px-[var(--card-px)] py-2">
          <ScanBarcode size={15} className="shrink-0 text-warning-11" aria-hidden />
          <span className="min-w-0 flex-1 text-2xs text-warning-11">
            Carton <span className="mono">{pendingLink.gtin}</span> is not linked to anything yet.
            {pendingLink.batchNo || pendingLink.expiry ? (
              <> Batch <span className="mono">{pendingLink.batchNo ?? '—'}</span> and expiry{' '}
                <span className="mono">{pendingLink.expiry ?? '—'}</span> are held, and will fill
                the row as soon as you pick the medicine.</>
            ) : null}
          </span>
          <LinkScanPicker onPick={linkScanned} />
          <button
            type="button"
            onClick={() => setPendingLink(null)}
            aria-label="Dismiss the unlinked carton"
            className="rounded-[var(--radius-sm)] p-1 text-warning-11 hover:bg-warning-9/10"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      ) : null}

      {/* The order laid over what is being keyed. It never blocks a post — a
          distributor is entitled to short-supply and the shop is entitled to
          receive what arrived; what it must not do is fail to notice. */}
      {againstOrder !== null ? (
        <OrderProgressStrip
          order={againstOrder}
          keyed={lines.filter((l) => !isLineBlank(l)).map((l): KeyedLine => ({
            medicineId: l.medicineId,
            qtyPacks: l.qtyPacks,
            freePacks: l.freePacks,
            unitsPerPack: l.unitsPerPack,
          }))}
          onDetach={() => setAgainstOrder(null)}
        />
      ) : null}

      {/* -------------------------------------------------------------- grid --- */}
      {/* The one region on this screen where density IS the point: forty lines
          off a distributor's bill, keyed in one sitting. */}
      <div ref={bodyRef} data-density="compact" className="scroll-region min-h-0 flex-1">
        <GrnLineGrid
          lines={lines}
          priced={priced}
          today={today}
          pricingBlockedBy={headerBlocker}
          onPatch={patchLine}
          onResolve={resolveLine}
          onRemove={removeLine}
          onCreateMedicine={(lineId, term) => setCreateFor({ lineId, term })}
        />
      </div>

      {/* ------------------------------------------------------------ totals --- */}
      <div className="shrink-0 border-t border-border-subtle bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border-subtle bg-raised px-[var(--card-px)] py-1.5 text-xs text-fg-muted">
          <Figure label="Lines" value={String(readyLines.length)} plain />
          <Figure label="Taxable" value={invoice?.taxableValue ?? null} />
          {interState
            ? <Figure label="IGST" value={invoice?.igst ?? null} />
            : <><Figure label="CGST" value={invoice?.cgst ?? null} /><Figure label="SGST" value={invoice?.sgst ?? null} /></>}
          <Figure label="Freight" value={invoice?.freight ?? null} />
          <Figure label="Round off" value={invoice?.roundOff ?? null} />
          <span className="ml-auto flex items-center gap-2">
            <Kbd>Tab</Kbd> or <Kbd>↵</Kbd> next cell · <Kbd>Esc</Kbd> leave the cell
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 px-[var(--card-px)] py-3">
          <TotalMatch
            value={paperTotal}
            onChange={setPaperTotal}
            entered={paperEntered}
            matched={matched}
            difference={difference}
            hasQuote={net !== null}
          />

          <div className="ml-auto flex items-center gap-5">
            {/* The one number this screen exists to produce. */}
            <div className="text-right">
              <div className="micro-label">Net on this bill</div>
              {quote.error || net === null
                /* --fg-subtle, not --fg-disabled. WCAG exempts INACTIVE
                   CONTROLS from contrast, and this is neither: it is the state
                   of the GRN, printed at 28px, and it was rendering at 1.9:1. */
                ? <div className="text-2xl font-semibold text-fg-subtle">Unpriced</div>
                : (
                  <div className="flex items-baseline justify-end gap-1">
                    <span className="text-base font-medium text-fg-muted" aria-hidden>₹</span>
                    <span className="display-num text-3xl">{formatAmount(net)}</span>
                  </div>
                )}
            </div>
            <Button
              variant={paperEntered && !matched ? 'danger' : 'primary'}
              size="lg"
              disabled={!canPost}
              onClick={() => { if (request) post.mutate(request) }}
            >
              <Truck />
              {paperEntered && !matched && difference !== null
                ? `Post with ₹${formatAmount(D.toStr(D.abs(difference), 2))} difference`
                : 'Post goods receipt'}
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ dialogs --- */}
      <MedicineForm
        open={createFor !== null}
        onOpenChange={(v) => { if (!v) setCreateFor(null) }}
        editing={null}
        onSaved={(m) => {
          const target = createFor
          setCreateFor(null)
          if (target) resolveLine(target.lineId, m, null)
          toast.success(`${m.brandName} added to the catalogue`, {
            description: 'Its first batch is created when this receipt posts.',
          })
        }}
        onOpenExisting={(id) => {
          const target = createFor
          setCreateFor(null)
          if (!target) return
          void api.getMedicines([id]).then((found) => {
            const m = found.at(0)
            if (m) resolveLine(target.lineId, m, null)
          })
        }}
        onSearchFor={(term) => {
          const target = createFor
          setCreateFor(null)
          if (target) patchLine(target.lineId, { brandName: term, medicineId: null })
        }}
      />

      {/* The distributor master is the Suppliers screen's dialog, not a second
          copy of it: GSTIN and drug-licence validation, the duplicate-name
          redirection and the payment terms that drive every ageing report all
          have to mean the same thing whichever screen the record was born on —
          and most of them are born HERE, with the delivery man at the counter. */}
      <SupplierForm
        open={supplierFormOpen}
        editing={supplierFormSeed}
        onOpenChange={setSupplierFormOpen}
        onSaved={(s) => {
          void qc.invalidateQueries({ queryKey: ['purchases', 'suppliers'] })
          void qc.invalidateQueries({ queryKey: ['suppliers'] })
          setSupplier(s)
          setSupplierFormOpen(false)
        }}
        onOpenExisting={(id) => {
          /* The name already exists. Take the operator to the record they were
             reaching for rather than making them cancel and search for it. */
          setSupplierFormOpen(false)
          void api.listSuppliers().then((all) => {
            const existing = all.find((x) => x.id === id)
            if (existing) setSupplier(existing)
          })
        }}
      />
    </div>
  )
}

// ------------------------------------------------------------------ pieces ---

const headerInputCls =
  'h-[var(--control-h)] w-full rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong'

function HeaderField({
  label, width, required, children,
}: {
  label: string
  width: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={cn('block shrink-0', width)}>
      <span className="micro-label mb-0.5 block">
        {label}{required ? <span className="text-danger-9"> *</span> : null}
      </span>
      {children}
    </label>
  )
}

/** Absent when the backend sent a clash it could not name — see `existingFrom`. */
function OpenExisting({ id, onOpen }: { id: number | null; onOpen: (id: number) => void }) {
  if (id === null) return null
  return (
    <Button size="sm" onClick={() => onOpen(id)}>
      Open it <ArrowRight />
    </Button>
  )
}

function Figure({ label, value, plain }: { label: string; value: string | null; plain?: boolean }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="micro-label">{label}</span>
      <span className={cn('num text-fg', plain && 'font-medium')}>
        {value === null ? '—' : plain ? value : formatAmount(value)}
      </span>
    </span>
  )
}

/**
 * The paper-bill check.
 *
 * It is optional on purpose — a store that does not use it still gets every
 * other validation — but it is the one control that catches a rate mistyped on
 * line 23 of 40, because it checks the whole bill at once rather than one field
 * at a time. A mismatch does not disable Post: Marg's own tri-state on every
 * purchase alert defaults to "indicate and save", and a hard stop on a screen
 * this long is a stop that gets worked around with a fake number. So the button
 * turns red and says the difference out loud instead.
 */
function TotalMatch({
  value, onChange, entered, matched, difference, hasQuote,
}: {
  value: string
  onChange: (v: string) => void
  entered: boolean
  matched: boolean
  difference: D.Decimal | null
  hasQuote: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-2">
        <span className="micro-label">Total on the paper bill ₹</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="0.00"
          inputMode="decimal"
          aria-label="Grand total printed on the supplier invoice"
          className="num h-[var(--control-h)] w-[120px] rounded-[var(--radius-md)] border border-border bg-surface px-2 text-base hover:border-border-strong"
        />
      </label>

      {!entered ? (
        <span className="text-2xs text-fg-subtle">
          {hasQuote ? 'Type it and every keyed rate is checked at once.' : 'Key a line to start pricing.'}
        </span>
      ) : !hasQuote ? (
        <span className="text-2xs text-fg-subtle">Nothing priced to compare against yet.</span>
      ) : matched ? (
        <span
          role="status"
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-md)] bg-success-3 px-2 text-xs font-medium text-success-11"
        >
          <CircleCheck size={14} aria-hidden /> Matches the paper bill
        </span>
      ) : (
        <span
          role="alert"
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-md)] bg-danger-3 px-2 text-xs font-medium text-danger-11"
        >
          <CircleAlert size={14} aria-hidden />
          {difference !== null && D.isNeg(difference)
            ? <>Keyed <span className="num">₹{formatAmount(D.toStr(D.abs(difference), 2))}</span> MORE than the paper</>
            : <>Keyed <span className="num">₹{difference === null ? '—' : formatAmount(D.toStr(difference, 2))}</span> LESS than the paper</>}
        </span>
      )}
    </div>
  )
}

/**
 * Supplier as a combobox over the whole list.
 *
 * A pharmacy deals with a few dozen distributors, not thousands, so the list is
 * fetched once and filtered here — a per-keystroke round trip would buy nothing
 * and would make the one control that gates the entire screen feel laggy.
 */
function SupplierPicker({
  value, options, onPick, onCreate,
}: {
  value: Supplier | null
  options: readonly Supplier[]
  onPick: (s: Supplier) => void
  onCreate: () => void
}) {
  /**
   * ONE box, two things to show in it: the distributor already on the bill, and
   * whatever is being typed to look for another one. `typed === null` means the
   * box is showing the chosen supplier; the first keystroke makes the typed text
   * the only truth, and abandoning the search puts the chosen one back.
   *
   * A single `term` cannot do this. Rendering the pick unconditionally freezes
   * the box — the operator types, the list filters underneath, and the text they
   * are typing never appears — and rendering the term unconditionally leaves the
   * header blank beside a bill that does have a supplier.
   */
  const [typed, setTyped] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const shown = useMemo(() => {
    const t = (typed ?? '').trim().toLowerCase()
    if (t === '') {
      /* Nothing typed: the supplier already on the bill LEADS the list, so the
         highlight that ↵ acts on is the distributor being received from. Handing
         an untouched box the alphabetical first row instead is how ↵ — the key
         every other cell on this screen means "next" by — silently moves a bill
         onto another distributor, taking the IGST-vs-CGST split with it. */
      const rest = options.filter((s) => s.id !== value?.id)
      return (value === null ? rest : [value, ...rest]).slice(0, 10)
    }
    return options.filter((s) =>
      s.name.toLowerCase().includes(t) || s.phone.includes(t) || (s.gstin ?? '').toLowerCase().includes(t),
    ).slice(0, 10)
  }, [options, typed, value])

  const label = typed ?? value?.name ?? ''

  function choose(s: Supplier) {
    onPick(s)
    setTyped(null)
    setOpen(false)
  }

  /* Abandoning a half-typed search restores the supplier on the bill rather than
     leaving the box reading something that is not the one being received from. */
  function abandon() {
    setOpen(false)
    setTyped(null)
  }

  return (
    <div className="relative w-[240px] shrink-0">
      <span className="micro-label mb-0.5 block">
        Supplier<span className="text-danger-9"> *</span>
      </span>
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          value={label}
          role="combobox"
          aria-expanded={open}
          aria-controls="grn-suppliers"
          aria-autocomplete="list"
          /* The highlight moves through the descendant, never through DOM focus:
             the operator is typing, and taking focus out of the box to walk a
             list is what makes a combobox eat keystrokes. */
          aria-activedescendant={open ? `grn-supplier-${active}` : undefined}
          aria-label="Supplier"
          placeholder="Distributor name or GSTIN…"
          autoComplete="off"
          onChange={(e) => { setTyped(e.target.value); setActive(0); setOpen(true) }}
          onFocus={(e) => { setOpen(true); setActive(0); e.currentTarget.select() }}
          /* Deferred, because a pick is a mousedown on an option and the blur it
             causes would otherwise close the list out from under it. */
          onBlur={() => window.setTimeout(abandon, 120)}
          onKeyDown={(e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return
            /*
             * Every branch below acts on `active`, which only means anything
             * while the list is up. With the list closed there is no visible
             * highlight, so acting on one is acting on a choice the operator
             * cannot see — ↵ would commit a row nobody is looking at. Closed,
             * ↓ opens the list and the rest is left to the browser, which is
             * what the other header fields do with ↵ too.
             */
            if (!open) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(0) }
              return
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = shown[active]
              if (hit) choose(hit)
              else onCreate()
            } else if (e.key === 'Escape') { e.stopPropagation(); abandon() }
          }}
          className={cn(headerInputCls, 'pl-7')}
        />
      </div>

      {open ? (
        <div
          id="grn-suppliers"
          role="listbox"
          aria-label="Suppliers"
          className="absolute inset-x-0 top-[calc(100%+2px)] z-30 max-h-[300px] overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-lg)]"
        >
          {shown.map((s, i) => (
            <div
              key={s.id}
              id={`grn-supplier-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(s) }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex h-[42px] cursor-pointer flex-col justify-center gap-0.5 border-b border-border-subtle px-2.5 last:border-0',
                i === active ? 'bg-accent-3' : 'hover:bg-hover',
              )}
            >
              <span className="truncate text-base font-medium">{s.name}</span>
              <span className="flex items-center gap-1.5 truncate text-2xs text-fg-subtle">
                {s.dlNo ? <span className="mono">DL {s.dlNo}</span> : <span className="text-warning-11">No DL</span>}
                <span>·</span>
                <span>{s.phone}</span>
              </span>
            </div>
          ))}
          <div
            id={`grn-supplier-${shown.length}`}
            role="option"
            aria-selected={active === shown.length}
            onMouseDown={(e) => { e.preventDefault(); onCreate() }}
            onMouseEnter={() => setActive(shown.length)}
            className={cn(
              'flex h-9 cursor-pointer items-center gap-2 border-t border-border-subtle px-2.5 text-sm',
              active === shown.length ? 'bg-accent-3 text-accent-11' : 'text-fg-muted hover:bg-hover',
            )}
          >
            <Plus size={13} aria-hidden /> New supplier
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Picking the medicine a scanned carton belongs to.
 *
 * The same debounced search the counter uses, scoped to one decision. A dropdown
 * cannot do this job — the catalogue is thousands of rows and the operator
 * already knows the name on the box in their hand.
 */
function LinkScanPicker({ onPick }: { onPick: (m: Medicine) => void }) {
  const api = useApi()
  const [term, setTerm] = useState('')
  const hits = useQuery({
    queryKey: ['grnLinkSearch', term],
    queryFn: () => api.searchMedicines({ term, limit: 5, includeOutOfStock: true }),
    enabled: term.trim().length >= 2,
  })
  return (
    <div className="flex items-center gap-1.5">
      <input
        aria-label="Link this carton to a medicine"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Which medicine?"
        autoComplete="off"
        className="h-7 w-[180px] rounded-[var(--radius-sm)] border border-border bg-surface px-1.5 text-xs"
      />
      {(hits.data ?? []).slice(0, 3).map((h) => (
        <button
          key={h.medicine.id}
          type="button"
          onClick={() => onPick(h.medicine)}
          className="rounded-[var(--radius-sm)] border border-border bg-surface px-2 py-1 text-2xs font-medium text-fg hover:border-border-strong"
        >
          {h.medicine.brandName} <span className="text-fg-subtle">{h.medicine.packLabel}</span>
        </button>
      ))}
    </div>
  )
}
