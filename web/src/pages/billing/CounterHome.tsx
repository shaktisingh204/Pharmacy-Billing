import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Flame, History, MapPin, ScanBarcode, Zap } from 'lucide-react'
import type { Medicine, MedicineRow, SaleInvoice } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { Kbd } from '@/components/ui/Kbd'
import { StockChip } from '@/components/ui/Badge'
import { RecentBillsList } from './RecentBills'

/**
 * What the counter looks like between customers.
 *
 * The empty cart used to say "scan or search to start billing" — true, and
 * worth nothing. A till at rest should be doing two jobs: putting the shop's
 * fastest movers one tap away, and keeping the last few bills reprintable.
 * Both vanish the moment a line lands, so neither costs the cart a pixel.
 *
 * Ordering is RECENCY OVER RANK. `saleRank` is a 90-day count and cannot know
 * about the fever going round this morning; the medicines actually dispensed in
 * the last few bills are the better predictor of the next one, so they lead and
 * the ranking fills in behind them.
 */

const TILE_COUNT = 12
const CANDIDATE_POOL = 48

export function CounterHome({
  today,
  recentInvoices,
  recentLoading,
  onPick,
  onReprint,
}: {
  today: string
  recentInvoices: SaleInvoice[]
  recentLoading: boolean
  onPick: (medicine: Medicine) => void
  onReprint: (invoice: SaleInvoice) => void
}) {
  const api = useApi()

  /* Only IN-STOCK candidates are asked for. A quick-pick tile that cannot be
     dispensed is worse than no tile: it costs a tap to discover the shelf is
     empty, at the one moment the operator is being watched. */
  const { data: page } = useQuery({
    queryKey: ['billing', 'quick-picks'],
    queryFn: () => api.listMedicines({ sort: 'saleRank', stock: 'in', limit: CANDIDATE_POOL }),
    staleTime: 60_000,
  })

  const soldToday = useMemo(() => {
    const seen: number[] = []
    for (const inv of recentInvoices) {
      if (inv.status === 'VOIDED') continue
      for (const line of inv.quote.lines) {
        if (!seen.includes(line.medicineId)) seen.push(line.medicineId)
      }
    }
    return seen
  }, [recentInvoices])

  const tiles = useMemo(() => {
    const rows = page?.rows ?? []
    const byId = new Map(rows.map((r) => [r.medicine.id, r]))
    const ordered: Array<{ row: MedicineRow; hot: boolean }> = []
    for (const id of soldToday) {
      const row = byId.get(id)
      if (row) {
        ordered.push({ row, hot: true })
        byId.delete(id)
      }
    }
    for (const row of rows) {
      if (byId.has(row.medicine.id)) ordered.push({ row, hot: false })
    }
    return ordered.slice(0, TILE_COUNT)
  }, [page, soldToday])

  return (
    <div className="scroll-region min-h-0 flex-1" style={{ ['--pinned-h' as string]: '0px' }}>
      <div
        className="mx-auto flex max-w-[900px] flex-col"
        style={{ padding: 'var(--card-px)', gap: 'var(--card-gap)' }}
      >
        <div className="flex items-center gap-2 pt-1">
          <ScanBarcode size={18} className="text-fg-subtle" aria-hidden />
          <h2 className="text-lg font-semibold tracking-tight">Scan a pack, or type a name</h2>
          <span className="ml-auto text-xs text-fg-subtle">
            Batch and expiry are chosen by first-expiry-first-out <Kbd>/</Kbd>
          </span>
        </div>

        <section className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border-subtle bg-subtle px-4 py-2">
            <Flame size={14} className="text-fg-subtle" aria-hidden />
            <span className="micro-label">Fast movers</span>
            <span className="ml-auto text-2xs text-fg-subtle">One tap adds one pack</span>
          </div>

          {tiles.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-fg-subtle">
              Nothing to suggest yet — the ranking builds itself out of what you dispense.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-3 lg:grid-cols-3 2xl:grid-cols-4">
              {tiles.map(({ row, hot }) => (
                <Tile key={row.medicine.id} row={row} hot={hot} onPick={onPick} />
              ))}
            </div>
          )}
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border-subtle bg-subtle px-4 py-2">
            <History size={14} className="text-fg-subtle" aria-hidden />
            <span className="micro-label">Recent bills</span>
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-fg-subtle">
              Reprint from here <Kbd>Alt+R</Kbd>
            </span>
          </div>
          <RecentBillsList
            invoices={recentInvoices}
            loading={recentLoading}
            onReprint={onReprint}
            emptyHint={`Nothing billed on ${today} yet. The first sale of the day lands here.`}
          />
        </section>
      </div>
    </div>
  )
}

function Tile({
  row, hot, onPick,
}: {
  row: MedicineRow
  hot: boolean
  onPick: (medicine: Medicine) => void
}) {
  const m = row.medicine
  return (
    <button
      type="button"
      onClick={() => onPick(m)}
      className={cn(
        'flex min-h-[74px] flex-col items-start gap-1 rounded-[var(--radius-lg)] border border-border',
        'bg-surface px-3 py-2 text-left',
        'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease)]',
        'hover:border-border-strong hover:bg-hover',
      )}
    >
      <span className="flex w-full items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate text-base font-medium leading-tight">{m.brandName}</span>
        {/* "Hot" is a word and an icon, never the tint alone. */}
        {hot && (
          <span className="flex shrink-0 items-center gap-0.5 text-2xs font-medium text-accent-11">
            <Zap size={10} aria-hidden /> sold today
          </span>
        )}
      </span>
      <span className="w-full truncate text-2xs text-fg-muted">
        {m.strengthText} · {m.packLabel}
      </span>
      <span className="mt-auto flex w-full items-center gap-1.5">
        <StockChip qty={Number(row.stockQty)} reorderLevel={m.reorderLevel} />
        {m.rackLocation && (
          <span className="flex shrink-0 items-center gap-0.5 text-2xs text-fg-subtle">
            <MapPin size={10} aria-hidden /> {m.rackLocation}
          </span>
        )}
      </span>
    </button>
  )
}
