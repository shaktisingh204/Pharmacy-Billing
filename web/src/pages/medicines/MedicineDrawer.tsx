import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight, Barcode, Boxes, ChartNoAxesColumn, FlaskConical, Layers, Minus, Pencil,
  Plus, Power, Replace, ScanBarcode, TrendingDown, TrendingUp, TriangleAlert, Unlink, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Batch, MedicineRow, MedicineSearchHit, StockMovement } from '@contract'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import { buildPriceHistory, marginOverMrp, salesVelocity } from '@/api/medicines'
import type { BatchPricePoint } from '@/api/medicines'
import { cn } from '@/lib/cn'
import { formatAmount, formatExpiry, formatMoney, formatPercent, formatQty } from '@/lib/format'
import { expiryBucket } from '@/lib/expiry'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Barcode as BarcodeSymbol } from '@/components/ui/Barcode'
import { Chip, ExpiryChip, ScheduleChip, StockChip } from '@/components/ui/Badge'
import { BarChart } from '@/components/charts'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'

/**
 * The item detail, as a SIDE SHEET.
 *
 * It is not a modal, and that is the whole design. The grid keeps its keyboard
 * focus while this is open, so ↑/↓ still walk the catalogue and ↵ swaps what is
 * shown here — which is how a pharmacist actually works through a shelf. A modal
 * would make every item a two-keystroke round trip, and stacking the edit form
 * on top of it would be a modal over a modal.
 *
 * The four tabs are also a fetching plan. Arrowing down a shelf must cost
 * nothing, so Overview reads only what the grid row already carries; batches are
 * fetched when batches are asked for, the ledger when velocity is, and the salt
 * match only when somebody is actually looking for a substitute. The tab lives
 * in the URL, so "look at how fast this moves" is a link like every other view
 * on this screen.
 *
 * What it deliberately does NOT carry: how the drug works, side effects,
 * pregnancy and lactation notes. Those are real fields in a patient-facing
 * catalogue and they are noise at a counter. Schedule and prescription status
 * are here because they are compliance, not education.
 */

export const DETAIL_TABS = ['overview', 'batches', 'sales', 'subs'] as const
export type DetailTab = (typeof DETAIL_TABS)[number]

const TAB_LABEL: Record<DetailTab, string> = {
  overview: 'Overview',
  batches: 'Batches',
  sales: 'Sales',
  subs: 'Substitutes',
}

const TAB_ICON: Record<DetailTab, LucideIcon> = {
  overview: Layers,
  batches: Boxes,
  sales: ChartNoAxesColumn,
  subs: Replace,
}

/** Six months of ledger. The adapter serves the most recent rows within a cap,
 *  and the panel says so when it has hit it rather than quietly under-counting. */
const VELOCITY_MONTHS = 6
const LEDGER_LIMIT = 500

export function MedicineDrawer({
  row,
  today,
  tab,
  onTabChange,
  onClose,
  onEdit,
  onLinkBarcode,
  onUnlinkBarcode,
  onToggleActive,
  onOpenMedicine,
  busy,
}: {
  row: MedicineRow
  today: Date
  tab: DetailTab
  onTabChange: (tab: DetailTab) => void
  onClose: () => void
  onEdit: () => void
  onLinkBarcode: () => void
  onUnlinkBarcode: (barcode: string) => void
  onToggleActive: () => void
  onOpenMedicine: (id: number) => void
  busy: boolean
}) {
  const api = useApi()
  const m = row.medicine

  const batches = useQuery({
    queryKey: qk.batches(m.id),
    queryFn: () => api.getBatches(m.id),
    enabled: tab === 'overview' || tab === 'batches',
  })

  const movements = useQuery({
    queryKey: ['medicines', 'movements', m.id],
    queryFn: () => api.listMovements({ medicineId: m.id, limit: LEDGER_LIMIT }),
    enabled: tab === 'sales',
  })

  const substitutes = useQuery({
    queryKey: ['substitutes', m.id],
    queryFn: () => api.findSubstitutes(m.id),
    enabled: tab === 'subs',
  })

  return (
    <aside
      role="complementary"
      aria-label={`${m.brandName} details`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      className="card flex w-[400px] shrink-0 flex-col overflow-hidden xl:w-[460px]"
    >
      <header className="flex shrink-0 items-start gap-2 px-[var(--card-px)] pb-2.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight text-fg">{m.brandName}</h2>
            <span className="shrink-0 text-base text-fg-muted">{m.strengthText}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
            <span>{m.packLabel}</span>
            <span aria-hidden>·</span>
            <span>{m.form}</span>
            <ScheduleChip code={m.drugSchedule} />
            {m.requiresPrescription ? <Chip tone="var(--schedule-h)">Rx required</Chip> : null}
            {!m.isActive ? <Chip icon={Power} tone="var(--status-quarantine)">Delisted</Chip> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={17} aria-hidden />
        </button>
      </header>

      {/* The number the sheet exists to show, and the two valuations beside it. */}
      <div className="flex shrink-0 items-end gap-4 border-y border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <div className="min-w-0">
          <div className="micro-label">On hand</div>
          <div className="flex items-baseline gap-1.5">
            <span className="display-num text-4xl text-fg">{formatQty(row.stockQty)}</span>
            <span className="text-sm text-fg-muted">{m.baseUom}</span>
          </div>
          <div className="mt-0.5 text-2xs text-fg-subtle">
            {row.batchCount === 0
              ? 'no sellable batch'
              : `across ${row.batchCount} sellable batch${row.batchCount === 1 ? '' : 'es'}`}
          </div>
        </div>
        <div className="ml-auto grid shrink-0 grid-cols-2 gap-x-4 text-right">
          <Figure label="At MRP" value={formatMoney(row.valueAtMrp)} />
          <Figure
            label="At cost"
            value={formatMoney(row.valueAtCost)}
            note={(() => {
              /* The ratio of the two valuations already on the row. Computed
                 through the decimal module, not with float division — a view
                 does no arithmetic on money in this codebase. */
              const margin = marginOverMrp(row.valueAtMrp, row.valueAtCost)
              return margin === null ? undefined : `${formatPercent(margin)} margin`
            })()}
          />
        </div>
      </div>

      <div role="tablist" aria-label="Item detail" className="flex shrink-0 gap-1 border-b border-border-subtle px-2 pt-1.5">
        {DETAIL_TABS.map((id) => {
          const Icon = TAB_ICON[id]
          const on = tab === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onTabChange(id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-t-[var(--radius-md)] border-b-2 px-2.5 text-sm',
                'transition-colors duration-[var(--dur-fast)]',
                on
                  ? 'border-accent-9 font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <Icon size={14} aria-hidden />
              {TAB_LABEL[id]}
            </button>
          )
        })}
      </div>

      <div className="scroll-region min-h-0 flex-1" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === 'overview' ? (
          <Overview
            row={row}
            today={today}
            batches={batches}
            onLinkBarcode={onLinkBarcode}
            onUnlinkBarcode={onUnlinkBarcode}
            onSeeBatches={() => onTabChange('batches')}
          />
        ) : tab === 'batches' ? (
          <Batches row={row} today={today} query={batches} />
        ) : tab === 'sales' ? (
          <Sales row={row} today={today} query={movements} />
        ) : (
          <Substitutes query={substitutes} onOpenMedicine={onOpenMedicine} />
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2.5">
        <Button variant="primary" onClick={onEdit}>
          <Pencil /> Edit item
        </Button>
        {/* Never delete. A medicine is referenced by every bill it ever appeared
            on; delisting removes it from search and leaves the history intact. */}
        <Button variant={m.isActive ? 'secondary' : 'primary'} onClick={onToggleActive} disabled={busy}>
          <Power /> {m.isActive ? 'Delist' : 'Relist'}
        </Button>
        <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </aside>
  )
}

type QueryLike<T> = {
  data: T | undefined
  isPending: boolean
  error: unknown
  refetch: () => unknown
}

// ---------------------------------------------------------------- overview ---

function Overview({
  row, today, batches, onLinkBarcode, onUnlinkBarcode, onSeeBatches,
}: {
  row: MedicineRow
  today: Date
  batches: QueryLike<Batch[]>
  onLinkBarcode: () => void
  onUnlinkBarcode: (barcode: string) => void
  onSeeBatches: () => void
}) {
  const m = row.medicine
  const held = batches.data ?? []
  /* Expired batches are NOT filtered out: what an operator wants at the top of
     this panel is the thing to act on, and a dead strip still on the shelf is
     exactly that. Quarantined and empty ones are, because neither is a date
     anybody has to do something about. */
  const soonest = held
    .filter((b) => Number(b.qtyOnHand) > 0 && !b.isQuarantined)
    .slice()
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .slice(0, 3)

  return (
    <>
      {/* Composition first: it is what a substitution is decided on, and the
          one line the operator reads out loud to the customer. */}
      <div className="flex items-start gap-2.5 border-b border-border-subtle px-[var(--card-px)] py-3">
        <FlaskConical size={16} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
        <div className="min-w-0">
          <div className="micro-label">Composition</div>
          <div className="text-base font-medium text-fg">{m.compositionText || '—'}</div>
          {m.genericName ? <div className="text-xs text-fg-muted">{m.genericName}</div> : null}
        </div>
      </div>

      <Section title="Master" icon={Layers}>
        <Facts
          rows={[
            { label: 'Manufacturer', value: m.manufacturer },
            { label: 'HSN', value: m.hsnCode || 'Unset', mono: true, missing: m.hsnCode.trim() === '' },
            { label: 'Rack', value: m.rackLocation ?? 'Unset', mono: true, missing: (m.rackLocation ?? '') === '' },
            { label: 'Reorder level', value: `${m.reorderLevel} ${m.baseUom}`, missing: m.reorderLevel <= 0 },
            { label: 'Pack', value: `${m.packLabel} · ${m.unitsPerPack} ${m.baseUom} per pack` },
            {
              label: 'Loose sale',
              value: m.allowLooseSale
                ? `Allowed, in steps of ${formatQty(m.saleStep)} ${m.baseUom}`
                : 'Whole pack only',
            },
            { label: 'Dispensed · 90d', value: String(m.saleRank), missing: m.saleRank <= 0 },
          ]}
        />
      </Section>

      <Section title="Nearest expiry" icon={Boxes} note={held.length > 3 ? `${held.length} batches` : undefined}>
        {batches.isPending ? (
          <SkeletonRows rows={2} cols={3} />
        ) : soonest.length === 0 ? (
          <p className="px-[var(--card-px)] pb-3 text-sm text-fg-muted">
            Nothing on the shelf. Either it has never been received, or every batch has sold out.
          </p>
        ) : (
          <div className="pb-1">
            {soonest.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-2 px-[var(--card-px)] py-1.5"
              >
                <span className="mono flex-1 truncate text-sm">{b.batchNo}</span>
                <ExpiryChip bucket={expiryBucket(b.expiryDate, today)} label={formatExpiry(b.expiryDate)} />
                <span className="num w-16 text-sm">{formatQty(b.qtyOnHand)}</span>
              </div>
            ))}
            {held.length > soonest.length ? (
              <button
                type="button"
                onClick={onSeeBatches}
                className="mx-[var(--card-px)] mb-1.5 mt-0.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] text-sm text-accent-11 hover:underline"
              >
                All {held.length} batches and their prices <ArrowRight size={13} aria-hidden />
              </button>
            ) : null}
          </div>
        )}
      </Section>

      <Section title={`Barcodes${row.barcodes.length > 0 ? ` · ${row.barcodes.length}` : ''}`} icon={Barcode}>
        {row.barcodes.length === 0 ? (
          <div className="px-[var(--card-px)] pb-3">
            <p className="text-sm text-fg-muted">
              No code is linked. Most Indian strips carry no scannable EAN at all — link the
              manufacturer's GTIN, or a label this shop prints, and the counter stops typing
              this name.
            </p>
            <Button className="mt-2.5" onClick={onLinkBarcode}>
              <ScanBarcode /> Scan to link
            </Button>
          </div>
        ) : (
          <div className="pb-2">
            {row.barcodes.map((code) => (
              <div key={code} className="flex items-center gap-3 px-[var(--card-px)] py-2">
                {/* The symbol, so the pack in hand can be checked against the
                    master by eye instead of digit by digit. */}
                <BarcodeSymbol code={code} height={34} />
                <button
                  type="button"
                  onClick={() => onUnlinkBarcode(code)}
                  aria-label={`Unlink ${code}`}
                  title="Unlink this code"
                  className="ml-auto flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-fg-subtle hover:bg-danger-3 hover:text-danger-11"
                >
                  <Unlink size={14} aria-hidden />
                </button>
              </div>
            ))}
            <div className="px-[var(--card-px)] pt-1">
              <Button size="sm" onClick={onLinkBarcode}><Plus /> Link another</Button>
            </div>
          </div>
        )}
      </Section>
    </>
  )
}

// ----------------------------------------------------------------- batches ---

const BATCH_COLS = 'grid grid-cols-[minmax(0,1fr)_72px_54px_72px_66px] items-center gap-2'

function Batches({
  row, today, query,
}: {
  row: MedicineRow
  today: Date
  query: QueryLike<Batch[]>
}) {
  if (query.isPending) return <SkeletonRows rows={5} cols={5} />
  if (query.error) {
    return (
      <ErrorState
        code="BATCHES_FAILED"
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const history = buildPriceHistory(query.data ?? [])
  if (history.points.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No batches on hand"
        body="Nothing has been received against this item, or every batch has been sold out."
      />
    )
  }

  return (
    <>
      {/* There is no price table in this app and there should not be: the MRP a
          shop charges is the one printed on the strip, so a medicine's price
          history IS the sequence of batches it has received. */}
      <div className="border-b border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <div className="micro-label">Current printed MRP</div>
        <div className="mt-0.5 flex items-baseline gap-2.5">
          <span className="display-num text-3xl text-fg">
            {formatMoney(history.latestMrpPerPack ?? '')}
          </span>
          <span className="text-xs text-fg-muted">per pack</span>
          {history.mrpChangePct !== null && history.previousMrpPerPack !== null ? (
            <MrpDelta pct={history.mrpChangePct} from={history.previousMrpPerPack} />
          ) : null}
        </div>
        <p className="mt-1 text-2xs text-fg-subtle">
          {history.points.length} batch{history.points.length === 1 ? '' : 'es'} on file, earliest
          expiry first. Two batches of one strip legitimately carry two printed MRPs.
        </p>
      </div>

      <div className={cn(BATCH_COLS, 'border-b border-border-subtle px-[var(--card-px)] py-1.5')}>
        <span className="micro-label">Batch</span>
        <span className="micro-label">Expiry</span>
        <span className="micro-label text-right">Qty</span>
        <span className="micro-label text-right">MRP/pk</span>
        <span className="micro-label text-right">Margin</span>
      </div>

      {history.points.map((p) => <PriceRow key={p.batchId} point={p} today={today} uom={row.medicine.baseUom} />)}
    </>
  )
}

function MrpDelta({ pct, from }: { pct: string; from: string }) {
  const n = Number(pct)
  const up = n > 0
  const flat = !Number.isFinite(n) || n === 0
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-2xs font-medium"
      style={{
        color: flat ? 'var(--fg-muted)' : up ? 'var(--warning-11)' : 'var(--success-11)',
        backgroundColor: flat
          ? 'var(--bg-inset)'
          : up ? 'var(--warning-3)' : 'var(--success-3)',
      }}
      title={`Previous batch was priced at ${formatMoney(from)} per pack`}
    >
      <Icon size={11} strokeWidth={2.5} aria-hidden />
      {up ? '+' : ''}{formatPercent(pct)} on the last batch
    </span>
  )
}

function PriceRow({ point, today, uom }: { point: BatchPricePoint; today: Date; uom: string }) {
  const dead = point.isQuarantined || Number(point.qtyOnHand) <= 0
  return (
    <div
      className={cn(
        BATCH_COLS,
        'border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0',
        dead && 'opacity-55',
      )}
      title={`Landed at ${formatMoney(point.landedCostPerUnit)} per ${uom}, bought at ${formatPercent(point.purchaseGstPct)} GST`}
    >
      <span className="mono flex min-w-0 items-center gap-1.5 truncate text-sm">
        {point.batchNo}
        {point.isQuarantined ? <Chip tone="var(--status-quarantine)">Held</Chip> : null}
      </span>
      <span>
        <ExpiryChip bucket={expiryBucket(point.expiryDate, today)} label={formatExpiry(point.expiryDate)} />
      </span>
      <span className="num text-sm">{formatQty(point.qtyOnHand)}</span>
      <span className="num text-sm">{formatAmount(point.mrpPerPack)}</span>
      <span className={cn('num text-sm', point.marginPct === null && 'text-fg-subtle')}>
        {point.marginPct === null ? '—' : formatPercent(point.marginPct)}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------- sales ---

function Sales({
  row, today, query,
}: {
  row: MedicineRow
  today: Date
  query: QueryLike<StockMovement[]>
}) {
  if (query.isPending) return <SkeletonRows rows={5} cols={3} />
  if (query.error) {
    return (
      <ErrorState
        code="MOVEMENTS_FAILED"
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const movements = query.data ?? []
  const iso = isoOf(today)
  const velocity = salesVelocity(movements, {
    today: iso,
    months: VELOCITY_MONTHS,
    stockQty: row.stockQty,
  })
  const sold = Number(velocity.totalUnits) > 0

  return (
    <>
      <div className="border-b border-border-subtle bg-subtle px-[var(--card-px)] py-3">
        <div className="micro-label">Dispensed</div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="display-num text-4xl text-fg">{formatQty(velocity.perMonth)}</span>
          <span className="text-sm text-fg-muted">{row.medicine.baseUom} a month</span>
        </div>
        <p className="mt-1 text-2xs text-fg-subtle">
          Averaged over {VELOCITY_MONTHS} months of the stock ledger, with returns netted off.
          Not the same measure as the 90-day dispense count that ranks search.
        </p>
      </div>

      {sold ? (
        <div className="border-b border-border-subtle px-[var(--card-px)] py-3">
          <BarChart
            ariaLabel={`Units of ${row.medicine.brandName} dispensed each month`}
            height={132}
            color="accent"
            valueFormat={(n) => formatQty(n)}
            data={velocity.points.map((p) => ({
              key: p.key,
              label: p.label,
              value: Number(p.units),
              hint: `${formatQty(p.units)} ${row.medicine.baseUom}`,
            }))}
          />
        </div>
      ) : null}

      <Section title="At this rate" icon={ChartNoAxesColumn}>
        <Facts
          rows={[
            {
              label: 'Cover left',
              value: velocity.daysOfCover === null
                ? 'Nothing has sold'
                : `${velocity.daysOfCover} days of stock`,
              missing: velocity.daysOfCover !== null && velocity.daysOfCover <= 14,
            },
            { label: 'Last 30 days', value: `${formatQty(velocity.last30Units)} ${row.medicine.baseUom}` },
            { label: `Last ${VELOCITY_MONTHS} months`, value: `${formatQty(velocity.totalUnits)} ${row.medicine.baseUom}` },
            {
              label: 'Last dispensed',
              value: velocity.lastSoldAt === null ? 'Never' : dayOf(velocity.lastSoldAt),
              missing: velocity.lastSoldAt === null,
            },
            { label: 'Reorder level', value: `${row.medicine.reorderLevel} ${row.medicine.baseUom}` },
          ]}
        />
      </Section>

      {movements.length >= LEDGER_LIMIT ? (
        <p className="px-[var(--card-px)] pb-3 text-2xs text-fg-subtle">
          Read from the most recent {LEDGER_LIMIT} ledger rows, which is the adapter's window.
          An item that moves faster than that has older months under-counted here.
        </p>
      ) : null}
    </>
  )
}

/** The shop's own calendar date, which is what the ledger months are read against. */
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

function dayOf(stamp: string): string {
  const at = new Date(stamp)
  return Number.isNaN(at.getTime()) ? '—' : DAY.format(at)
}

// ------------------------------------------------------------ substitutes ---

function Substitutes({
  query, onOpenMedicine,
}: {
  query: QueryLike<MedicineSearchHit[]>
  onOpenMedicine: (id: number) => void
}) {
  if (query.isPending) return <SkeletonRows rows={5} cols={3} />
  if (query.error) {
    return (
      <ErrorState
        code="SUBSTITUTES_FAILED"
        message={(query.error as Error).message}
        onRetry={() => void query.refetch()}
      />
    )
  }

  const hits = query.data ?? []
  if (hits.length === 0) {
    return (
      <EmptyState
        icon={Replace}
        title="No substitute in stock"
        body="Nothing else on the shelf carries this composition. A salt match is the only kind of substitution that is safe to offer, so a near-miss on the brand name is deliberately not listed here."
      />
    )
  }

  return (
    <>
      <p className="border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2.5 text-xs text-fg-muted">
        Matched on the SALT, never on the brand name. {hits.length} alternative
        {hits.length === 1 ? '' : 's'} are in stock.
      </p>
      {hits.map((hit) => (
        <button
          key={hit.medicine.id}
          type="button"
          onClick={() => onOpenMedicine(hit.medicine.id)}
          className="flex w-full items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-2 text-left last:border-0 hover:bg-hover"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-base font-medium text-fg">{hit.medicine.brandName}</span>
              <span className="shrink-0 text-2xs text-fg-subtle">{hit.medicine.packLabel}</span>
            </span>
            <span className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className="truncate">{hit.medicine.manufacturer}</span>
              <ScheduleChip code={hit.medicine.drugSchedule} />
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="num block text-sm font-medium text-fg">
              {hit.fefoBatch ? formatMoney(hit.fefoBatch.mrpPerPack) : '—'}
            </span>
            <span className="block text-2xs text-fg-subtle">per pack</span>
          </span>
          <StockChip qty={Number(hit.stockQty)} reorderLevel={hit.medicine.reorderLevel} />
        </button>
      ))}
    </>
  )
}

// ------------------------------------------------------------------ pieces ---

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="micro-label">{label}</div>
      <div className="num text-base font-semibold text-fg">{value}</div>
      {note ? <div className="text-2xs text-fg-muted">{note}</div> : null}
    </div>
  )
}

function Section({
  title, icon: Icon, note, children,
}: {
  title: string
  icon: LucideIcon
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border-subtle last:border-0">
      <header className="flex h-9 items-center gap-2 px-[var(--card-px)]">
        <Icon size={14} className="text-fg-subtle" aria-hidden />
        <span className="text-sm font-medium text-fg">{title}</span>
        {note ? <span className="ml-auto text-2xs text-fg-subtle">{note}</span> : null}
      </header>
      {children}
    </section>
  )
}

function Facts({
  rows,
}: {
  rows: Array<{ label: string; value: string; mono?: boolean; missing?: boolean }>
}) {
  return (
    <dl className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-[var(--card-px)] pb-3">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-xs text-fg-muted">{r.label}</dt>
          <dd
            className={cn(
              'flex min-w-0 items-center gap-1 text-sm text-fg',
              /* A hole in the master is stated, not merely left blank: the whole
                 point of the strip on the page header is that these are work.
                 Stated as a MARK and a word, never as the tint alone — a zero
                 reorder level and a fortnight of cover read as ordinary numbers
                 to anyone the amber does not reach. */
              r.missing && 'font-medium text-warning-11',
            )}
            title={r.value}
          >
            {r.missing ? (
              <>
                <TriangleAlert size={12} className="shrink-0" aria-hidden />
                <span className="sr-only">Needs attention: </span>
              </>
            ) : null}
            <span className={cn('min-w-0 truncate', r.mono && 'mono')}>{r.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
