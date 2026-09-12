import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { StatValue } from '@/components/ui/Money'

/**
 * The stat-tile contract: label, value, optional delta, and where it goes.
 *
 * A single headline number is a stat tile, never a one-bar bar chart — the number
 * IS the chart. The delta's colour encodes direction x whether up is good, which
 * is why `riseIsGood` is required rather than assumed: rising sales are green and
 * rising receivables are not, and a tile that paints both green is lying.
 *
 * Every tile is a LINK. A number with no way through to the rows behind it makes
 * the reader retype what they just read into another screen's filter, and the
 * question a dashboard raises is always "which ones?".
 */
export function StatTile({
  label,
  value,
  symbol,
  deltaPct,
  riseIsGood,
  comparedTo,
  icon: Icon,
  tone,
  to,
  linkLabel,
}: {
  label: string
  value: string
  symbol?: string
  /** Null when there is nothing to compare against. We do not invent a +100%. */
  deltaPct: string | null
  riseIsGood: boolean
  comparedTo: string
  icon: LucideIcon
  tone?: 'danger'
  /** The screen that explains this number. */
  to: string
  /** Named on the tile, so the destination is known before the click. */
  linkLabel: string
}) {
  const n = deltaPct === null ? null : Number(deltaPct)
  const flat = n !== null && Math.abs(n) < 0.05
  const good = n === null || flat ? null : n > 0 === riseIsGood

  const DeltaIcon = n === null || flat ? Minus : n > 0 ? ArrowUpRight : ArrowDownRight
  const deltaTone = good === null ? 'text-fg-subtle' : good ? 'text-success-11' : 'text-danger-11'

  return (
    <Link
      to={to}
      data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, '-')}`}
      className="card card-link group flex min-w-0 flex-col gap-3 p-[var(--card-px)] no-underline"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="micro-label truncate">{label}</span>
        <Icon size={16} className="shrink-0 text-fg-subtle" aria-hidden />
      </div>

      <StatValue
        value={value}
        {...(symbol ? { symbol } : {})}
        className={cn('text-3xl leading-none', tone === 'danger' ? 'text-danger-11' : 'text-fg')}
      />

      {/*
        One line, and it must never wrap or truncate: six of these sit across the
        row at ~200px each, and a comparison cut off mid-word ("vs previous 30 d…")
        tells the reader less than no comparison at all.

        So the two cases that have no number to print carry no "vs" either —
        "No change" already says what it was compared against, and the section
        heading above states the window in full for both.
      */}
      <div className="flex items-center gap-1.5 text-xs">
        <DeltaIcon size={14} aria-hidden className={cn('shrink-0', deltaTone)} />
        <span className={cn('whitespace-nowrap', deltaTone)}>
          {n === null ? 'Nothing to compare' : flat ? 'No change' : `${n > 0 ? '+' : ''}${deltaPct}%`}
        </span>
        {n !== null && !flat ? (
          <span className="truncate text-fg-subtle">vs {comparedTo}</span>
        ) : null}
      </div>

      {/* The destination, stated. It is quiet until the tile is hovered or
          focused, so a row of six tiles does not read as a row of six links. */}
      <span className="flex items-center gap-1 text-2xs text-fg-subtle transition-colors duration-[var(--dur-base)] group-hover:text-accent-11 group-focus-visible:text-accent-11">
        {linkLabel}
        <ArrowRight size={12} aria-hidden className="transition-transform duration-[var(--dur-base)] group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
