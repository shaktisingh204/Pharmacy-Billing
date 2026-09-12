import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * The two pieces every tab of the customer sheet is built from.
 *
 * Shared rather than copied because they set the sheet's vertical rhythm, and a
 * second copy is how one tab quietly ends up two pixels out of step with the
 * next. Padding is `--card-px` throughout, so the sheet tightens with the
 * density it is rendered at instead of being pinned to one screen size.
 */

export function Section({
  title,
  icon: Icon,
  note,
  action,
  children,
}: {
  title: string
  icon: LucideIcon
  note?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-b border-border-subtle last:border-0">
      <header className="flex min-h-9 items-center gap-2 px-[var(--card-px)] pt-2.5 pb-1 [@media(max-height:800px)]:pt-1.5">
        <Icon size={14} className="shrink-0 text-fg-subtle" aria-hidden />
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {note ? <span className="ml-auto text-2xs text-fg-subtle">{note}</span> : null}
        {action ? <span className={cn(note ? 'ml-2' : 'ml-auto')}>{action}</span> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * A figure with its label above it.
 *
 * `hero` opts into `.display-num`, and exactly one tile per group may take it —
 * the one the tab exists to show. Three display numbers side by side is three
 * headlines and therefore none.
 */
export function StatTile({
  label,
  value,
  note,
  tone,
  hero,
}: {
  label: string
  value: string
  note?: string
  tone?: 'danger' | 'success'
  hero?: boolean
}) {
  return (
    <div className="min-w-0 bg-surface px-[var(--card-px)] py-2.5 [@media(max-height:800px)]:py-1.5">
      <div className="micro-label">{label}</div>
      <div
        className={cn(
          // `text-left` overrides `.num`, which right-aligns for column work. In
          // a tile the figure sits under its own label and has to line up with it.
          'mt-0.5 truncate text-left',
          hero ? 'display-num text-2xl [@media(max-height:800px)]:text-xl' : 'num text-lg font-semibold',
          tone === 'danger' ? 'text-danger-11' : tone === 'success' ? 'text-success-11' : 'text-fg',
        )}
        title={value}
      >
        {value}
      </div>
      {note ? <div className="truncate text-2xs text-fg-muted" title={note}>{note}</div> : null}
    </div>
  )
}
