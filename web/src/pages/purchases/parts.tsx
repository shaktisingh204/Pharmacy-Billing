import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'

/**
 * The furniture every Purchases tab is built out of.
 *
 * Five tabs were each drawing their own card header, their own figure block and
 * their own footer, at five slightly different sizes — which is what made the
 * screen read as five screens. They are one component each here, so a change to
 * the language lands on all of them at once.
 */

/**
 * A lit panel with a header that says what it is and what it is for.
 *
 * `title` is a heading, not a label: a screen reader user arriving on this page
 * should be able to walk it by panel.
 */
export function Panel({
  title, icon: Icon, description, actions, children, className, headerClassName, id,
}: {
  title: ReactNode
  icon?: LucideIcon
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  headerClassName?: string
  id?: string
}) {
  return (
    <section id={id} className={cn('card flex min-h-0 flex-col overflow-hidden', className)}>
      <header
        className={cn(
          'flex shrink-0 flex-wrap items-start gap-3 border-b border-border-subtle px-[var(--card-px)] py-3',
          headerClassName,
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-fg">
            {Icon ? <Icon size={17} className="shrink-0 text-fg-subtle" aria-hidden /> : null}
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export type StatTone = 'default' | 'accent' | 'warning' | 'danger' | 'success'

const TONE_TEXT: Record<StatTone, string> = {
  default: 'text-fg',
  accent: 'text-accent-11',
  warning: 'text-warning-11',
  danger: 'text-danger-11',
  success: 'text-success-11',
}

/**
 * One figure, at the size its importance earns.
 *
 * `hero` is for the one number a card exists to show; everything else is `md`.
 * The rupee symbol is set smaller and muted so the DIGITS are what the eye
 * lands on — at 44px a full-size ₹ reads as the first character of the number.
 */
export function Stat({
  label, value, symbol, hint, tone = 'default', size = 'md', icon: Icon,
}: {
  label: ReactNode
  /** Already formatted. Money must arrive through formatAmount, never computed here. */
  value: ReactNode
  symbol?: string
  hint?: ReactNode
  tone?: StatTone
  size?: 'hero' | 'lg' | 'md' | 'sm'
  icon?: LucideIcon
}) {
  const scale = size === 'hero' ? 'text-4xl' : size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-2xl' : 'text-lg'
  return (
    <div className="min-w-0">
      <div className="micro-label flex items-center gap-1.5">
        {Icon ? <Icon size={12} aria-hidden /> : null}
        {label}
      </div>
      <div className={cn('mt-1.5 flex items-baseline gap-1 truncate', TONE_TEXT[tone])}>
        {symbol ? (
          <span className="text-[0.6em] font-medium text-fg-muted" aria-hidden>{symbol}</span>
        ) : null}
        <span className={cn('display-num', scale)}>{value}</span>
      </div>
      {hint ? <p className="mt-1 truncate text-xs text-fg-muted">{hint}</p> : null}
    </div>
  )
}

/** A money figure at stat size, in the one place money formatting happens. */
export function MoneyStat(props: Omit<Parameters<typeof Stat>[0], 'value' | 'symbol'> & {
  amount: string
}) {
  const { amount, ...rest } = props
  return <Stat {...rest} symbol="₹" value={formatAmount(amount)} />
}

/**
 * A labelled figure on one line, for a strip of secondary numbers.
 *
 * Deliberately not a <Stat>: a row of eight of these at stat size is a wall of
 * digits with no hierarchy, which is the failure mode of every dashboard that
 * treats every number as a headline.
 */
export function Figure({
  label, value, tone = 'default', title,
}: {
  label: ReactNode
  value: ReactNode
  tone?: StatTone
  title?: string
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="micro-label truncate">{label}</div>
      <div className={cn('num mt-0.5 truncate text-base font-medium', TONE_TEXT[tone])}>{value}</div>
    </div>
  )
}

/**
 * A horizontal share bar. Used where a percentage is being compared down a
 * column — the eye reads bar lengths against each other far faster than it
 * reads two-digit numbers, and the number is still printed beside it.
 */
export function Meter({
  pct, tone = 'accent', ariaLabel,
}: {
  /** 0-100. Out of range is clamped, because a fill rate above 100 is a bug upstream. */
  pct: number
  tone?: 'accent' | 'warning' | 'danger' | 'success'
  ariaLabel: string
}) {
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const colour = tone === 'danger' ? 'var(--danger-11)'
    : tone === 'warning' ? 'var(--warning-11)'
      : tone === 'success' ? 'var(--success-11)'
        : 'var(--accent-9)'
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className="block h-1.5 w-full overflow-hidden rounded-[var(--radius-full)] bg-inset"
    >
      <span
        aria-hidden
        className="block h-full rounded-[var(--radius-full)]"
        style={{ width: `${width}%`, background: colour }}
      />
    </span>
  )
}

/** The quiet strip at the bottom of a panel: counts on the left, keys on the right. */
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle',
        'bg-subtle px-[var(--card-px)] py-2 text-xs text-fg-muted',
        className,
      )}
    >
      {children}
    </div>
  )
}
