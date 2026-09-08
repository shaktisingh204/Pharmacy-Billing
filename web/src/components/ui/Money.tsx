import { formatAmount, formatMoney, formatPercent, formatQty } from '@/lib/format'
import { cn } from '@/lib/cn'

interface NumProps {
  value: string | number
  className?: string
  /** Show the ₹ symbol. Off in columns whose header already carries it. */
  symbol?: boolean
}

/**
 * The ONLY way money is rendered. Applies tabular figures so a rupee column does
 * not jitter as digits change, and keeps every amount right-aligned.
 */
export function Money({ value, className, symbol = true }: NumProps) {
  return (
    <span className={cn('num', className)}>
      {symbol ? formatMoney(value) : formatAmount(value)}
    </span>
  )
}

export function Qty({ value, className }: NumProps) {
  return <span className={cn('num', className)}>{formatQty(value)}</span>
}

export function Percent({ value, className }: NumProps) {
  return <span className={cn('num', className)}>{formatPercent(value)}</span>
}

/**
 * A display-size number: a stat tile value or a hero figure.
 *
 * Deliberately NOT `.num`. Tabular figures give every digit the width of a zero,
 * which is exactly right in a column and visibly loose at 24px and above — '121'
 * develops gaps. Tabular is for columns that must align vertically; a standalone
 * headline number wants the font's proportional figures.
 */
export function StatValue({
  value,
  symbol,
  className,
}: {
  value: string
  symbol?: string
  className?: string
}) {
  return (
    <span className={cn('font-semibold tracking-[-0.02em] tabular-nums-off', className)}>
      {symbol ? <span className="text-[0.62em] font-medium text-fg-muted">{symbol}</span> : null}
      {value}
    </span>
  )
}

/** Batch numbers, HSN codes, invoice numbers — mono, never proportional. */
export function Code({ value, className }: { value: string; className?: string }) {
  return <span className={cn('mono text-sm', className)}>{value}</span>
}
