import { useNavigate } from 'react-router-dom'
import {
  ArrowRight, CalendarClock, NotebookPen, PackageMinus, Receipt, TrendingUp, Truck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ActivityRow, ExpiringBatchRow, LowStockRow, TopMedicineRow } from '@contract'
import { cn } from '@/lib/cn'
import { ScrollList } from '@/components/ScrollList'
import { formatAmount, formatExpiry, formatMoney, formatQty } from '@/lib/format'
import { Chip, ExpiryChip } from '@/components/ui/Badge'
import { EmptyState } from '@/components/states'
import { expiryBucket } from '@/lib/expiry'

export function Panel({
  title, icon: Icon, action, onAction, children, tone,
}: {
  title: string
  icon?: LucideIcon
  action?: string
  onAction?: () => void
  children: React.ReactNode
  tone?: 'danger'
}) {
  return (
    <section
      className={cn('card flex min-w-0 flex-col overflow-hidden', tone === 'danger' && 'border-danger-9/25')}
    >
      <header
        className={cn(
          'flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-[var(--card-px)] py-2',
          tone === 'danger' && 'bg-danger-3',
        )}
      >
        <h3 className={cn('flex items-center gap-2 text-lg font-medium tracking-tight', tone === 'danger' && 'text-danger-11')}>
          {Icon ? <Icon size={16} aria-hidden className="shrink-0 text-fg-subtle" /> : null}
          {title}
        </h3>
        {action ? (
          <button
            type="button"
            onClick={onAction}
            className="flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-fg-muted transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg"
          >
            {action} <ArrowRight size={12} aria-hidden />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  )
}

/** Column headers use .micro-label; numeric columns use .num so they align. */
function Head({ cols }: { cols: Array<{ label: string; align?: 'right' }> }) {
  return (
    <div className="grid gap-2 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-1"
      style={{ gridTemplateColumns: `minmax(0,1fr) repeat(${cols.length - 1}, auto)` }}>
      {cols.map((c) => (
        <span key={c.label} className={cn('micro-label', c.align === 'right' && 'text-right')}>{c.label}</span>
      ))}
    </div>
  )
}

/**
 * Capital at risk: stock that expires soon, valued at what it COST rather than at
 * MRP. Expiry write-off is the biggest cash leak in a chemist shop, and the number
 * that matters is the money that walks out the door, not the retail price nobody
 * is going to pay for it.
 */
export function CapitalAtRisk({
  rows, totalAtCost, showsCost = true,
}: {
  rows: ExpiringBatchRow[]
  totalAtCost: string
  /** A pharmacist sees WHICH batches are dying, never what the shop paid for them. */
  showsCost?: boolean
}) {
  const navigate = useNavigate()
  const today = new Date()
  return (
    <Panel
      title={showsCost ? 'Capital at risk' : 'Expiring soon'}
      icon={CalendarClock}
      action="Inventory"
      onAction={() => navigate('/inventory')}
      tone="danger"
    >
      <div className="flex items-baseline justify-between border-b border-border-subtle px-[var(--card-px)] py-2">
        <span className="text-xs text-fg-muted">
          {showsCost ? 'Near-expiry stock, at cost' : 'Batches inside the near-expiry window'}
        </span>
        <span className="num text-lg font-semibold text-danger-11">
          {showsCost ? formatMoney(totalAtCost) : `${rows.length}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing expiring soon" body="No sellable batch falls inside the near-expiry window." />
      ) : (
        <ScrollList label="Near-expiry batches" className="max-h-[272px]">
          {rows.map((r) => (
            <div key={r.batchId} className="flex items-center gap-3 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium">{r.brandName}</div>
                <div className="mono truncate text-2xs text-fg-muted">
                  {r.batchNo} · {formatExpiry(r.expiryDate)} · {formatQty(r.qtyOnHand)} units
                </div>
              </div>
              <ExpiryChip bucket={expiryBucket(r.expiryDate, today)} label={`${r.daysLeft}d`} />
              {showsCost ? (
                <span className="num w-20 text-right text-base font-medium">{formatAmount(r.valueAtCost)}</span>
              ) : null}
            </div>
          ))}
        </ScrollList>
      )}
    </Panel>
  )
}

export function LowStockPanel({ rows }: { rows: LowStockRow[] }) {
  const navigate = useNavigate()
  return (
    <Panel title="Reorder now" icon={PackageMinus} action="Purchases" onAction={() => navigate('/purchases')}>
      {rows.length === 0 ? (
        <EmptyState icon={PackageMinus} title="Nothing below its reorder level" />
      ) : (
        <>
          <Head cols={[{ label: 'Medicine' }, { label: 'On hand', align: 'right' }, { label: 'Trigger', align: 'right' }, { label: 'Urgency', align: 'right' }]} />
          <ScrollList label="Medicines to reorder" className="max-h-[272px]">
            {rows.map((r) => {
              const pct = Number(r.shortfallPct)
              const urgency = pct >= 80 ? 'High' : pct >= 40 ? 'Medium' : 'Low'
              const tone = pct >= 80 ? 'var(--danger-11)' : pct >= 40 ? 'var(--warning-11)' : 'var(--fg-muted)'
              return (
                <div key={r.medicineId} className="grid items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto auto' }}>
                  <div className="min-w-0">
                    <div className="truncate text-base">{r.brandName}</div>
                    <div className="truncate text-2xs text-fg-subtle">{r.packLabel}{r.rackLocation ? ` · ${r.rackLocation}` : ''}</div>
                  </div>
                  <span className="num w-14 text-right">{formatQty(r.qtyOnHand)}</span>
                  <span className="num w-14 text-right text-fg-muted">{r.reorderLevel}</span>
                  {/* Urgency is a word AND a colour — never the colour alone. */}
                  <span className="w-16 text-right"><Chip tone={tone}>{urgency}</Chip></span>
                </div>
              )
            })}
          </ScrollList>
        </>
      )}
    </Panel>
  )
}

export function TopMedicinesPanel({ rows }: { rows: TopMedicineRow[] }) {
  const navigate = useNavigate()
  return (
    <Panel title="Top medicines by revenue · 30 days" icon={TrendingUp} action="Reports" onAction={() => navigate('/reports')}>
      {rows.length === 0 ? (
        <EmptyState icon={TrendingUp} title="No sales in the last 30 days" />
      ) : (
        <>
          <Head cols={[{ label: 'Medicine' }, { label: 'Units', align: 'right' }, { label: 'Revenue', align: 'right' }, { label: 'In stock', align: 'right' }]} />
          <ScrollList label="Top medicines by revenue" className="max-h-[272px]">
            {rows.map((r, i) => (
              <div key={r.medicineId} className="grid items-center gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5 last:border-0"
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto auto' }}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="num w-4 text-2xs text-fg-subtle">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-base">{r.brandName}</div>
                    <div className="truncate text-2xs text-fg-subtle">{r.packLabel}</div>
                  </div>
                </div>
                <span className="num w-14 text-right">{formatQty(r.unitsSold)}</span>
                <span className="num w-20 text-right font-medium">{formatAmount(r.revenue)}</span>
                <span className="num w-14 text-right text-fg-muted">{formatQty(r.qtyOnHand)}</span>
              </div>
            ))}
          </ScrollList>
        </>
      )}
    </Panel>
  )
}

const ACTIVITY_ICON: Record<ActivityRow['kind'], LucideIcon> = {
  SALE: Receipt,
  PURCHASE: Truck,
  LOW_STOCK: PackageMinus,
  EXPIRY: CalendarClock,
  SHORTBOOK: NotebookPen,
}

const ACTIVITY_TONE: Record<ActivityRow['kind'], string> = {
  SALE: 'var(--success-11)',
  PURCHASE: 'var(--info-11)',
  LOW_STOCK: 'var(--warning-11)',
  EXPIRY: 'var(--status-expiry-60)',
  SHORTBOOK: 'var(--fg-muted)',
}

export function ActivityPanel({ rows }: { rows: ActivityRow[] }) {
  return (
    <Panel title="Recent activity" icon={Receipt}>
      {rows.length === 0 ? (
        <EmptyState icon={Receipt} title="Nothing has happened yet today" />
      ) : (
        <ScrollList label="Recent activity" className="max-h-[272px]">
          {rows.map((r) => {
            const Icon = ACTIVITY_ICON[r.kind]
            return (
              <div key={r.id} className="flex items-start gap-2.5 border-b border-border-subtle px-[var(--card-px)] py-2 last:border-0">
                <span
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: `color-mix(in srgb, ${ACTIVITY_TONE[r.kind]} 12%, transparent)`, color: ACTIVITY_TONE[r.kind] }}
                >
                  <Icon size={13} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base">{r.title}</div>
                  <div className="truncate text-2xs text-fg-muted">{r.detail}</div>
                </div>
                {r.amount ? <span className="num shrink-0 text-base font-medium">{formatAmount(r.amount)}</span> : null}
              </div>
            )
          })}
        </ScrollList>
      )}
    </Panel>
  )
}
