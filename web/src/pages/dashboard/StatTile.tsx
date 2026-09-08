import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { StatValue } from '@/components/ui/Money'

/**
 * The stat-tile contract: label, value, optional delta, optional trend.
 *
 * A single headline number is a stat tile, never a one-bar bar chart — the number
 * IS the chart. The delta's colour encodes direction x whether up is good, which
 * is why `riseIsGood` is required rather than assumed: rising sales are green and
 * rising receivables are not, and a tile that paints both green is lying.
 */
export function StatTile({
  label,
  value,
  symbol,
  deltaPct,
  riseIsGood,
  comparedTo,
  icon: Icon,
  footnote,
  tone,
}: {
  label: string
  value: string
  symbol?: string
  /** Null when there is nothing to compare against. We do not invent a +100%. */
  deltaPct: string | null
  riseIsGood: boolean
  comparedTo: string
  icon: LucideIcon
  footnote?: string
  tone?: 'danger'
}) {
  const n = deltaPct === null ? null : Number(deltaPct)
  const flat = n !== null && Math.abs(n) < 0.05
  const good = n === null || flat ? null : n > 0 === riseIsGood

  const DeltaIcon = n === null || flat ? Minus : n > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <div className="card flex min-w-0 flex-col gap-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-sm text-fg-muted">{label}</span>
        <Icon size={15} className="shrink-0 text-fg-subtle" aria-hidden />
      </div>

      <StatValue
        value={value}
        {...(symbol ? { symbol } : {})}
        className={cn('text-2xl leading-none', tone === 'danger' && 'text-danger-11')}
      />

      <div className="flex items-center gap-1 text-xs">
        <DeltaIcon
          size={13}
          aria-hidden
          className={cn(
            'shrink-0',
            good === null ? 'text-fg-subtle' : good ? 'text-success-11' : 'text-danger-11',
          )}
        />
        <span className={good === null ? 'text-fg-subtle' : good ? 'text-success-11' : 'text-danger-11'}>
          {n === null ? '—' : flat ? 'No change' : `${n > 0 ? '+' : ''}${deltaPct}%`}
        </span>
        <span className="truncate text-fg-subtle">{footnote ?? `vs ${comparedTo}`}</span>
      </div>
    </div>
  )
}
