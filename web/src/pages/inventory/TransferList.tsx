import { useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, FileText, Truck } from 'lucide-react'
import type { StockTransferDoc, StoreProfile } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'

/**
 * What has moved between branches.
 *
 * Both directions, deliberately. A movement this branch RECEIVED is as much its
 * business as one it sent — and without the incoming side a receiving shop has
 * no way to explain where its stock came from except by opening one batch's
 * movement history at a time, which nobody does.
 *
 * The document type is shown on every row because it is the thing that decides
 * the tax treatment: two branches on one GSTIN are one legal person and the
 * movement is not a supply, so it travels on a delivery challan. Between two
 * GSTINs it is a supply and the paper is a tax invoice.
 */
export function TransferList({ currentStore }: { currentStore: StoreProfile }) {
  const api = useApi()
  const transfers = useQuery({ queryKey: ['transfers'], queryFn: () => api.listTransfers() })

  if (transfers.error) {
    return (
      <ErrorState
        code={transfers.error instanceof ApiError ? transfers.error.code : 'TRANSFERS_FAILED'}
        message={(transfers.error as Error).message}
        onRetry={() => void transfers.refetch()}
      />
    )
  }
  if (transfers.isPending) return <SkeletonRows rows={4} cols={3} />

  const rows = transfers.data ?? []
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Truck}
        title="Nothing has moved between branches"
        body="Stock sent to or received from another branch is listed here with the document that moved it."
      />
    )
  }

  return (
    <ul aria-label="Branch transfers">
      {rows.map((t) => (
        <Row key={t.id} transfer={t} currentStoreId={currentStore.id} />
      ))}
    </ul>
  )
}

function Row({
  transfer, currentStoreId,
}: {
  transfer: StockTransferDoc
  currentStoreId: number
}) {
  /* Which way it went, from THIS branch's point of view. The same document is an
     outgoing movement to one shop and an incoming one to the other, and a list
     that does not say which is unreadable at the receiving end. */
  const outgoing = transfer.fromStoreId === currentStoreId
  const Icon = outgoing ? ArrowUpRight : ArrowDownLeft

  return (
    <li className="border-b border-border-subtle px-[var(--card-px)] py-2.5 last:border-0">
      <div className="flex items-baseline gap-2">
        <Icon
          size={14}
          aria-hidden
          className={cn('shrink-0 self-center', outgoing ? 'text-warning-11' : 'text-success-11')}
        />
        <span className="mono truncate text-sm font-medium text-fg">{transfer.documentNo}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {outgoing ? `to ${transfer.toStoreName}` : `from ${transfer.fromStoreName}`}
        </span>
        <span className="num shrink-0 text-base font-semibold text-fg">
          ₹{formatAmount(transfer.totalValue)}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5 text-2xs text-fg-subtle">
        <span>{transfer.issuedOn}</span>
        <span aria-hidden>·</span>
        <span className="num">{transfer.lines.length}</span>
        <span>batch{transfer.lines.length === 1 ? '' : 'es'}</span>
        <span aria-hidden>·</span>
        {/* In words, because it decides the tax treatment and the two are not
            interchangeable. */}
        <span className="flex items-center gap-1">
          <FileText size={10} aria-hidden />
          {transfer.document === 'CHALLAN' ? 'Delivery challan' : 'Tax invoice'}
        </span>
      </div>
      <p className="mt-0.5 truncate text-2xs text-fg-muted" title={transfer.reason}>
        {transfer.reason}
      </p>
    </li>
  )
}
