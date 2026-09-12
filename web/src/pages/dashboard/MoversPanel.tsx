import { useNavigate } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight, Scale, TrendingDown, TrendingUp } from 'lucide-react'
import type { MoverRow } from '@contract'
import { EmptyState } from '@/components/states'
import { formatAmount, formatQty } from '@/lib/format'
import { Panel } from './panels'

/**
 * What moved, and by how much, against the previous period.
 *
 * The two halves are deliberately equal weight. A faller is the more actionable
 * of the pair in a chemist shop — a line that has stopped moving is either out of
 * stock, priced wrong, or has lost its prescriber — and every dashboard that
 * shows only risers hides exactly that.
 *
 * Direction never rides on colour: each half is headed with a word and an icon,
 * and every row repeats the sign in the number itself.
 */
export function MoversPanel({
  movers,
  comparedTo,
}: {
  movers: { risers: MoverRow[]; fallers: MoverRow[] }
  comparedTo: string
}) {
  const navigate = useNavigate()
  const empty = movers.risers.length === 0 && movers.fallers.length === 0

  return (
    <Panel
      title="Top movers"
      icon={Scale}
      action="Reports"
      onAction={() => navigate('/reports?r=ITEM_SALES')}
    >
      <div className="border-b border-border-subtle px-[var(--card-px)] py-2 text-xs text-fg-muted">
        Revenue vs {comparedTo}
      </div>
      {empty ? (
        <EmptyState
          icon={Scale}
          title="Nothing has moved"
          body="No medicine sold differently enough in this window to be worth naming."
        />
      ) : (
        <div className="grid gap-0 md:grid-cols-2">
          <Half
            heading="Rising"
            icon={TrendingUp}
            rows={movers.risers}
            tone="var(--success-11)"
            empty="Nothing rose."
            onPick={(id) => navigate(`/medicines?id=${id}`)}
          />
          <div className="border-t border-border-subtle md:border-t-0 md:border-l">
            <Half
              heading="Falling"
              icon={TrendingDown}
              rows={movers.fallers}
              tone="var(--danger-11)"
              empty="Nothing fell."
              onPick={(id) => navigate(`/medicines?id=${id}`)}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

function Half({
  heading,
  icon: Icon,
  rows,
  tone,
  empty,
  onPick,
}: {
  heading: string
  icon: typeof TrendingUp
  rows: MoverRow[]
  tone: string
  empty: string
  onPick: (medicineId: number) => void
}) {
  const rising = heading === 'Rising'
  const Direction = rising ? ArrowUpRight : ArrowDownRight
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
        <Icon size={13} aria-hidden style={{ color: tone }} />
        <span className="micro-label" style={{ color: tone }}>{heading}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-[var(--card-px)] py-4 text-sm text-fg-subtle">{empty}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((r) => (
            <li key={r.medicineId}>
              <button
                type="button"
                onClick={() => onPick(r.medicineId)}
                className="flex w-full items-center gap-3 border-b border-border-subtle px-[var(--card-px)] py-2 text-left transition-colors duration-[var(--dur-fast)] last:border-0 hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{r.brandName}</span>
                  <span className="block truncate text-2xs text-fg-subtle">
                    {r.packLabel} · {formatQty(r.unitsSold)} units
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="flex items-center justify-end gap-1" style={{ color: tone }}>
                    <Direction size={13} aria-hidden />
                    <span className="num text-base font-medium">
                      {rising ? '+' : '−'}{formatAmount(stripSign(r.deltaAmount))}
                    </span>
                  </span>
                  <span className="num block text-2xs text-fg-subtle">
                    {/* A null percentage means the line sold nothing at all in the
                        comparison window — "+100%" would be a division that never
                        happened, and "new" would claim the medicine is new. */}
                    {r.deltaPct === null
                      ? 'from nothing'
                      : `${formatAmount(r.previous)} → ${formatAmount(r.current)}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The sign is drawn as a typographic minus beside the arrow, not as a hyphen. */
function stripSign(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : amount
}
