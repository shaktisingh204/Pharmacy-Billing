import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleCheck, NotebookPen, Plus, X } from 'lucide-react'
import type { Batch, ShortbookEntry } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { Kbd } from '@/components/ui/Kbd'
import {
  EmptyState, ErrorState, OfflineState, PermissionDenied, SkeletonRows,
} from '@/components/states'
import { panelStatus, useOnline } from './GrnEntry'
import type { GrnSeed } from './GrnEntry'
import { latestBatchDefaults } from './GrnLineGrid'

/**
 * The short book: what the shop was asked for and could not sell.
 *
 * It sits beside the goods receipt because that is the moment it is worth
 * something. A refused sale is the highest-signal demand event a pharmacy
 * produces — higher than any sales report, because it is a customer who walked
 * out — and the only thing that converts it into stock is one click while the
 * distributor's bill is open in the next pane.
 *
 * Two states matter and are shown differently: an entry that is still short, and
 * an entry that has since been restocked. The second is noise on a reorder list,
 * and a list that keeps showing satisfied demand is one nobody reads.
 */

/**
 * How long ago, on the SHOP's calendar.
 *
 * `at` is a UTC instant and IST runs five and a half hours ahead of it, so
 * slicing the date out of the string and comparing the strings labels
 * everything captured before 05:30 as "yesterday" — including the row a counter
 * hand added ten minutes ago, which is exactly the row that still matters.
 */
function daysAgo(at: string, today: Date): number {
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return 0
  const then = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return Math.round((now - then) / 86_400_000)
}

export function ShortbookPanel({
  onAddToGrn,
}: {
  onAddToGrn: (seed: Omit<GrnSeed, 'nonce'>) => void
}) {
  const api = useApi()
  const qc = useQueryClient()
  const online = useOnline()
  const today = useMemo(() => new Date(), [])

  const shortbook = useQuery({
    queryKey: ['purchases', 'shortbook'],
    queryFn: () => api.listShortbook(),
  })

  const status = panelStatus(
    { isPending: shortbook.isPending, error: shortbook.error, hasData: shortbook.data !== undefined },
    online,
  )

  const clear = useMutation({
    mutationFn: (id: number) => api.clearShortbook(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases', 'shortbook'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (err) => toast.error('Could not clear the entry', { description: (err as Error).message }),
  })

  /**
   * Resolve the entry before handing it over.
   *
   * The lookup happens HERE rather than in the grid because it is a click, and a
   * click can be async. What comes back is a fully-formed line: the medicine, its
   * pack, and the MRP and purchase GST rate this shop last received it at.
   */
  async function add(entry: ShortbookEntry) {
    if (entry.medicineId === null) {
      /* A free-text row is the whole point of the short book: the customer asked
         for something that is not in the master yet. It goes across as text and
         the grid's medicine cell offers to create it. */
      onAddToGrn({
        medicineId: null,
        brandName: entry.term,
        packLabel: '',
        unitsPerPack: 1,
        mrpPerPack: '',
        gstRatePct: '',
      })
      return
    }
    const id = entry.medicineId
    const [found, batches] = await Promise.all([
      api.getMedicines([id]),
      api.getBatches(id).catch((): Batch[] => []),
    ])
    const m = found.at(0)
    if (!m) {
      toast.error('That medicine is no longer in the catalogue', {
        description: 'Clear the entry, or search for its replacement in the grid.',
      })
      return
    }
    /* The quantity is deliberately NOT carried over. A shortbook row counts BASE
       units of demand and a receipt is keyed in PACKS, and dividing one by the
       other produces a fraction of a strip that nobody can order. The demand is
       on screen beside the row; the operator decides how many packs to buy. */
    const defaults = latestBatchDefaults(batches)
    onAddToGrn({
      medicineId: m.id,
      brandName: m.brandName,
      packLabel: m.packLabel,
      unitsPerPack: m.unitsPerPack,
      mrpPerPack: defaults?.mrpPerPack ?? '',
      gstRatePct: defaults?.gstRatePct ?? '',
    })
  }

  const rows = shortbook.data ?? []
  const open = rows.filter((r) => r.stockQty === null || Number(r.stockQty) <= 0).length

  return (
    <aside className="card flex w-[292px] shrink-0 flex-col overflow-hidden" data-density="comfortable">
      <div className="shrink-0 border-b border-border-subtle px-[var(--card-px)] py-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
          <NotebookPen size={17} className="shrink-0 text-fg-subtle" aria-hidden />
          Short book
        </h2>
        {status === 'ready' && rows.length > 0 ? (
          <p className="mt-0.5 text-xs text-fg-muted">
            <span className="num font-medium text-fg">{open}</span> still short of{' '}
            <span className="num">{rows.length}</span> asked for — one click puts one on this bill.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-fg-muted">
            What the counter could not dispense, beside the bill that can fix it.
          </p>
        )}
      </div>

      {status === 'loading' ? (
        <SkeletonRows rows={6} cols={2} />
      ) : status === 'offline' ? (
        <OfflineState />
      ) : status === 'denied' ? (
        <PermissionDenied needs="purchases.view" />
      ) : status === 'error' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ErrorState
            code={shortbook.error instanceof ApiError ? shortbook.error.code : 'SHORTBOOK_FAILED'}
            message={(shortbook.error as Error | null)?.message}
            onRetry={() => void shortbook.refetch()}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <EmptyState
            icon={NotebookPen}
            title="Nothing is short"
            body="Anything the counter could not dispense lands here — including names that are not in the catalogue at all. Press S at the till on a refused sale."
          />
        </div>
      ) : (
        <div className="scroll-region min-h-0 flex-1">
          {rows.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              today={today}
              busy={clear.isPending && clear.variables === entry.id}
              onAdd={() => void add(entry)}
              onClear={() => clear.mutate(entry.id)}
            />
          ))}
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-[var(--card-px)] text-2xs text-fg-muted">
        <Kbd>S</Kbd> at the till adds to this list
      </div>
    </aside>
  )
}

function Entry({
  entry, today, busy, onAdd, onClear,
}: {
  entry: ShortbookEntry
  today: Date
  busy: boolean
  onAdd: () => void
  onClear: () => void
}) {
  const age = daysAgo(entry.at, today)
  const restocked = entry.stockQty !== null && Number(entry.stockQty) > 0
  const name = entry.brandName ?? entry.term

  return (
    <div
      className={cn(
        'group flex flex-col gap-1.5 border-b border-border-subtle px-[var(--card-px)] py-2.5',
        busy && 'opacity-50',
      )}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-base font-medium" title={name}>{name}</span>
        {entry.medicineId === null ? (
          <span
            className="shrink-0 rounded-[var(--radius-sm)] bg-subtle px-1 text-2xs text-fg-muted"
            title="Typed at the counter — not in the catalogue yet"
          >
            new
          </span>
        ) : null}
        <span className="num ml-auto shrink-0 text-2xs text-fg-muted">×{entry.qty}</span>
      </div>

      <div className="flex items-center gap-1.5 text-2xs text-fg-subtle">
        <span>
          {age <= 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`}
        </span>
        {restocked ? (
          <span className="flex items-center gap-1 text-success-11">
            <CircleCheck size={11} aria-hidden /> back in stock ({entry.stockQty})
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        {restocked ? (
          /* Restocked demand has already been answered. Ordering it again is how
             a reorder list turns into dead stock, so the primary action flips to
             clearing it and adding it stays available but quiet. */
          <>
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-success-3 px-2 text-xs font-medium text-success-11 hover:bg-success-9/20"
            >
              <CircleCheck size={11} aria-hidden /> Received — clear it
            </button>
            <button
              type="button"
              onClick={onAdd}
              title="Order it anyway"
              className="inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <Plus size={12} aria-hidden />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-accent-3 px-2 text-xs font-medium text-accent-11 hover:bg-accent-6/40"
            >
              <Plus size={11} aria-hidden /> Add to this GRN
            </button>
            <button
              type="button"
              onClick={onClear}
              aria-label={`Drop ${name} from the short book`}
              title="Drop it — no longer wanted"
              className="inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] text-fg-subtle hover:bg-danger-3 hover:text-danger-9"
            >
              <X size={12} aria-hidden />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
