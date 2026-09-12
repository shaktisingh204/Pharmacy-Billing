import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Ban, CalendarClock, CircleSlash, ClipboardList, PackageMinus, PackageSearch, ShoppingCart,
  TriangleAlert, UserRoundCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PurchaseOrder, ReorderSuggestion } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { URGENCY_LABEL } from '@/api/reorder'
import { cn } from '@/lib/cn'
import { formatQty } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import { Figure, Panel, PanelFooter, Stat } from './parts'

/**
 * What to order.
 *
 * The incumbent offers twelve reorder "bases" and arbitrates between them by
 * taking the largest number. This offers ONE suggestion and puts its working on
 * the row — because the failure mode of a reorder screen is not a wrong formula,
 * it is a number nobody can interrogate, which gets overtyped every time until
 * the engine is ornamental.
 *
 * Everything is editable and nothing is ordered until a supplier is named. The
 * rows arrive ranked by urgency, and "a customer asked for this" ranks above
 * every statistical gap however large.
 */

const URGENCY_TONE: Record<ReorderSuggestion['urgency'], string> = {
  waiting: 'var(--danger-11)',
  out: 'var(--status-expiry-30)',
  low: 'var(--warning-11)',
  watch: 'var(--fg-subtle)',
}

/** Colour never rides alone: every urgency carries its own mark and its word. */
const URGENCY_ICON: Record<ReorderSuggestion['urgency'], LucideIcon> = {
  waiting: UserRoundCheck,
  out: CircleSlash,
  low: PackageMinus,
  watch: CalendarClock,
}

export function ReorderPanel() {
  const api = useApi()
  const qc = useQueryClient()

  const [qty, setQty] = useState<Record<number, string>>({})
  const [dropped, setDropped] = useState<Set<number>>(() => new Set())
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [expectedOn, setExpectedOn] = useState('')

  const suggestions = useQuery({
    queryKey: ['reorder'],
    queryFn: () => api.suggestReorder(),
  })
  const suppliers = useQuery({ queryKey: ['suppliers', ''], queryFn: () => api.listSuppliers() })
  const orders = useQuery({
    queryKey: ['purchaseOrders'],
    queryFn: () => api.listPurchaseOrders({}),
  })

  const rows = useMemo(
    () => (suggestions.data ?? []).filter((s) => !dropped.has(s.medicineId)),
    [suggestions.data, dropped],
  )

  /* Only the rows for the chosen supplier go on the order. A distributor cannot
     ship somebody else's lines, and quietly including them produces an order the
     supplier deletes half of without telling anybody. */
  const forSupplier = useMemo(
    () => rows.filter((s) => supplierId === null || s.supplierId === supplierId),
    [rows, supplierId],
  )

  const counts = useMemo(() => ({
    waiting: forSupplier.filter((s) => s.urgency === 'waiting').length,
    out: forSupplier.filter((s) => s.urgency === 'out').length,
    packs: forSupplier.reduce((sum, s) => sum + s.suggestedPacks, 0),
  }), [forSupplier])

  const qtyOf = (s: ReorderSuggestion): string => qty[s.medicineId] ?? s.suggestedQty

  const place = useMutation({
    mutationFn: () => api.createPurchaseOrder({
      idempotencyKey: `po-${supplierId}-${Date.now()}`,
      supplierId: supplierId as number,
      expectedOn: expectedOn === '' ? null : expectedOn,
      lines: forSupplier
        .filter((s) => Number(qtyOf(s)) > 0)
        .map((s, i) => ({
          lineId: `o${i + 1}`,
          medicineId: s.medicineId,
          qty: qtyOf(s),
          basis: s.basis,
        })),
    }),
    onSuccess: (order) => {
      toast.success(`${order.orderNo} placed with ${order.supplierName}`, {
        description: `${order.lines.length} line${order.lines.length === 1 ? '' : 's'} — these quantities now count as "on order" and will not be suggested again`,
      })
      setQty({})
      setDropped(new Set())
      void qc.invalidateQueries({ queryKey: ['purchaseOrders'] })
      void qc.invalidateQueries({ queryKey: ['reorder'] })
    },
    onError: (e) => {
      toast.error('The order was not placed', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const open = (orders.data ?? []).filter((o) => o.status === 'OPEN' || o.status === 'PART')

  return (
    <div className="flex min-h-0 flex-1 gap-[var(--card-gap)]">
      <Panel
        className="min-w-0 flex-1"
        title="What to order"
        icon={PackageSearch}
        description="One suggestion per line, with the reasoning on the row. Anything already on an open order is taken off the number."
        actions={
          <>
            <label className="flex min-w-[200px] flex-col gap-1">
              <span className="micro-label">Order from</span>
              <select
                aria-label="Order from"
                value={supplierId ?? ''}
                onChange={(e) => setSupplierId(e.target.value === '' ? null : Number(e.target.value))}
                className="h-10 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
              >
                <option value="">Every supplier…</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="micro-label">Expected</span>
              <input
                aria-label="Expected delivery date"
                type="date"
                value={expectedOn}
                onChange={(e) => setExpectedOn(e.target.value)}
                className="num h-10 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm hover:border-border-strong"
              />
            </label>
          </>
        }
      >
        {/* The size of the job, before the list of it. A reorder run is decided
            on "how bad is it" long before any single line is read. */}
        <div className="flex shrink-0 flex-wrap items-end gap-x-10 gap-y-3 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
          <Stat
            label={supplierId === null ? 'Lines to order' : 'Lines for this supplier'}
            value={formatQty(forSupplier.length)}
            size="lg"
            hint={`${formatQty(counts.packs)} pack${counts.packs === 1 ? '' : 's'} in total`}
          />
          <Figure
            label="Customers waiting"
            value={formatQty(counts.waiting)}
            tone={counts.waiting > 0 ? 'danger' : 'default'}
            title="Somebody stood at the counter and asked for these"
          />
          <Figure
            label="Out of stock"
            value={formatQty(counts.out)}
            tone={counts.out > 0 ? 'warning' : 'default'}
          />
          {rows.length !== forSupplier.length ? (
            <Figure
              label="Other suppliers"
              value={formatQty(rows.length - forSupplier.length)}
              title="Lines last bought from somebody else — a distributor cannot ship them"
            />
          ) : null}
        </div>

        <div data-density="comfortable" className="scroll-region min-h-0 flex-1 overflow-auto">
          {suggestions.isPending ? (
            <SkeletonRows rows={10} cols={4} />
          ) : suggestions.error ? (
            <ErrorState
              code={suggestions.error instanceof ApiError ? suggestions.error.code : 'REORDER_FAILED'}
              message={(suggestions.error as Error).message}
              onRetry={() => void suggestions.refetch()}
            />
          ) : forSupplier.length === 0 ? (
            <EmptyState
              icon={ShoppingCart}
              title={rows.length === 0 ? 'Nothing needs ordering' : 'Nothing for this supplier'}
              body={rows.length === 0
                ? 'Every line has enough cover for the next four weeks once what is already on order arrives.'
                : 'These lines were last bought from somebody else. Choose "Every supplier" to see them all.'}
            />
          ) : (
            <ul aria-label="Suggested order lines">
              {forSupplier.map((s) => (
                <SuggestionRow
                  key={s.medicineId}
                  s={s}
                  qty={qtyOf(s)}
                  onQty={(v) => setQty((prev) => ({ ...prev, [s.medicineId]: v }))}
                  onDrop={() => setDropped((prev) => new Set(prev).add(s.medicineId))}
                />
              ))}
            </ul>
          )}
        </div>

        <PanelFooter className="py-3">
          <span>
            <span className="num font-medium text-fg">{forSupplier.length}</span> line
            {forSupplier.length === 1 ? '' : 's'}
            {rows.length !== forSupplier.length ? (
              <> · <span className="num">{rows.length - forSupplier.length}</span> from other suppliers</>
            ) : null}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {supplierId === null && forSupplier.length > 0 ? (
              <span className="text-xs text-warning-11">Choose a supplier to place the order</span>
            ) : null}
            <Button
              variant="primary"
              disabled={supplierId === null || forSupplier.length === 0 || place.isPending}
              onClick={() => place.mutate()}
            >
              <ShoppingCart /> Place order
            </Button>
          </div>
        </PanelFooter>
      </Panel>

      <OpenOrders
        orders={open}
        loading={orders.isPending}
        onChanged={() => {
          void qc.invalidateQueries({ queryKey: ['purchaseOrders'] })
          void qc.invalidateQueries({ queryKey: ['reorder'] })
        }}
      />
    </div>
  )
}

function SuggestionRow({
  s, qty, onQty, onDrop,
}: {
  s: ReorderSuggestion
  qty: string
  onQty: (v: string) => void
  onDrop: () => void
}) {
  const Icon = URGENCY_ICON[s.urgency]
  return (
    <li className="relative border-b border-border-subtle px-[var(--card-px)] py-2.5 hover:bg-hover">
      {/* Urgency as a bar, an icon AND a word — the row is read at an angle on a
          matte counter panel, where a tint alone does not survive. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: URGENCY_TONE[s.urgency] }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg" title={s.brandName}>
          {s.brandName} <span className="text-2xs font-normal text-fg-subtle">{s.packLabel}</span>
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium"
          style={{ color: URGENCY_TONE[s.urgency] }}
        >
          <Icon size={13} aria-hidden />
          {URGENCY_LABEL[s.urgency]}
        </span>
        <label className="flex shrink-0 items-center gap-1.5">
          <span className="sr-only">Order quantity for {s.brandName}</span>
          <input
            aria-label={`Order quantity for ${s.brandName}`}
            value={qty}
            onChange={(e) => onQty(e.target.value)}
            inputMode="decimal"
            className="num h-9 w-24 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-right text-sm hover:border-border-strong"
          />
          <span className="w-16 text-2xs text-fg-subtle">
            {s.suggestedPacks} pack{s.suggestedPacks === 1 ? '' : 's'}
          </span>
        </label>
        <button
          type="button"
          onClick={onDrop}
          aria-label={`Leave ${s.brandName} off this order`}
          className="shrink-0 rounded-[var(--radius-sm)] p-1.5 text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <Ban size={14} aria-hidden />
        </button>
      </div>
      {/* The working. Without it the number is a guess the operator overtypes,
          and the engine may as well not exist. */}
      <p className="mt-1 truncate text-xs text-fg-muted" title={s.basis}>{s.basis}</p>
    </li>
  )
}

function OpenOrders({
  orders, loading, onChanged,
}: {
  orders: PurchaseOrder[]
  loading: boolean
  onChanged: () => void
}) {
  const api = useApi()
  const [cancelling, setCancelling] = useState<number | null>(null)
  const [reason, setReason] = useState('')

  const cancel = useMutation({
    mutationFn: (v: { id: number; reason: string }) => api.cancelPurchaseOrder(v.id, v.reason),
    onSuccess: (order) => {
      toast.success(`${order.orderNo} cancelled`, {
        description: 'The order stays on file with its reason — a distributor who has already loaded the van will still deliver.',
      })
      setCancelling(null)
      setReason('')
      onChanged()
    },
    onError: (e) => {
      toast.error('Not cancelled', {
        description: e instanceof ApiError ? e.message : (e as Error).message,
      })
    },
  })

  const lines = orders.reduce((sum, o) => sum + o.lines.length, 0)

  return (
    <Panel
      className="hidden w-[320px] shrink-0 xl:flex"
      title="On order"
      icon={ClipboardList}
      description="Everything here is already subtracted from the suggestions on the left, and waiting to be received against."
    >
      {orders.length > 0 ? (
        <div className="flex shrink-0 items-end gap-8 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
          <Stat label="Open orders" value={formatQty(orders.length)} size="lg" />
          <Figure label="Lines" value={formatQty(lines)} />
        </div>
      ) : null}

      <div data-density="comfortable" className="scroll-region min-h-0 flex-1 overflow-auto">
        {loading ? (
          <SkeletonRows rows={4} cols={2} />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No open orders"
            body="Orders placed here stay listed until the goods arrive, so the next suggestion does not ask for them twice — and the goods receipt can be keyed straight against one."
          />
        ) : (
          <ul aria-label="Open orders">
            {orders.map((o) => (
              <li key={o.id} className="border-b border-border-subtle px-[var(--card-px)] py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="mono truncate text-sm font-medium text-fg">{o.orderNo}</span>
                  <span className="num ml-auto text-2xs text-fg-muted">
                    {o.lines.length} line{o.lines.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="truncate text-xs text-fg-muted">{o.supplierName}</div>
                <div className="mt-1 flex items-center gap-1.5 text-2xs text-fg-subtle">
                  <CalendarClock size={12} aria-hidden />
                  {o.expectedOn
                    ? `expected ${o.expectedOn}`
                    /* Absent is not today. Saying "expected today" about a date
                       nobody agreed is the screen inventing a fact. */
                    : 'no date agreed'}
                  {o.status === 'PART' ? <span className="text-warning-11">· part received</span> : null}
                </div>

                {cancelling === o.id ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      aria-label={`Why ${o.orderNo} is being cancelled`}
                      placeholder="Ordered twice by mistake"
                      className="h-9 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-sm"
                    />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={cancel.isPending || reason.trim().length < 6}
                        onClick={() => cancel.mutate({ id: o.id, reason: reason.trim() })}
                      >
                        <TriangleAlert /> Cancel it
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setCancelling(null)}>Keep</Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setCancelling(o.id); setReason('') }}
                    className={cn(
                      'mt-1.5 text-2xs font-medium text-fg-muted',
                      'hover:text-danger-11 hover:underline',
                    )}
                  >
                    Cancel this order
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}
