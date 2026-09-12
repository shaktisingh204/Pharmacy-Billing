import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { compactINR } from '@/components/charts'
import type { Basis } from './analysis'
import { BASIS_SUFFIX, parse } from './analysis'

/**
 * Shared furniture for the three analytical views.
 *
 * Every one of them answers a question over the SAME bounded slice of the shelf,
 * and every one of them has to say so. A stock report that quietly analyses a
 * subset is the report that gets quoted at a bank.
 */

export function AnalysisShell({
  title, description, controls, children,
}: {
  title: string
  description: ReactNode
  controls?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-[var(--card-px)] py-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
          <p className="mt-0.5 max-w-[80ch] text-sm text-fg-muted">{description}</p>
        </div>
        {controls ? <div className="flex shrink-0 flex-wrap items-center gap-2">{controls}</div> : null}
      </header>
      <div className="scroll-region min-h-0 flex-1">{children}</div>
    </section>
  )
}

/** The one number the view exists to show. */
export function Hero({
  value, basis, caption, sub, tone,
}: {
  value: string | null
  basis: Basis
  caption: string
  sub: ReactNode
  tone?: string
}) {
  const n = value === null ? null : parse(value)
  return (
    <div className="min-w-0">
      <span className="micro-label block">{caption}</span>
      <span
        className="mt-1 flex items-baseline gap-1"
        title={value === null ? undefined : `${formatMoney(value)} ${BASIS_SUFFIX[basis]}`}
      >
        <span className="text-xl font-medium text-fg-muted">₹</span>
        <span className="display-num text-4xl" style={tone ? { color: tone } : undefined}>
          {n === null ? '—' : compactINR(D.toNumber(n))}
        </span>
      </span>
      <p className="mt-1.5 max-w-[52ch] text-sm text-fg-muted">{sub}</p>
    </div>
  )
}

/**
 * How much of the shelf this view actually looked at.
 *
 * The cap is real and it is not hidden. A panel that quietly analyses a subset
 * is the panel that gets quoted at a bank, so the count of what was read and the
 * count of what matched are both on screen, along with the lever that closes the
 * gap: filter harder.
 */
export function ScopeNote({
  analysed, total, ledger, filtered, onSortByValue,
}: {
  analysed: number
  total: number
  /** True when every analysed batch cost one ledger read. */
  ledger?: boolean
  filtered: boolean
  onSortByValue?: () => void
}) {
  const whole = analysed >= total
  return (
    <p className="flex flex-wrap items-start gap-1.5 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2 text-2xs text-fg-muted">
      <Info size={13} aria-hidden className="mt-px shrink-0 text-fg-subtle" />
      <span className="min-w-0">
        {whole ? (
          <>
            All <span className="num font-medium text-fg">{analysed.toLocaleString('en-IN')}</span>{' '}
            batches matching {filtered ? 'the filters above' : 'this view'} were analysed.
          </>
        ) : (
          <>
            The <span className="num font-medium text-fg">{analysed.toLocaleString('en-IN')}</span>{' '}
            highest-value batches holding stock, of{' '}
            <span className="num font-medium text-fg">{total.toLocaleString('en-IN')}</span>{' '}
            matching {filtered ? 'the filters above' : 'this view'}. Narrow the filters to reach
            the rest.
          </>
        )}
        {ledger ? (
          <>
            {' '}Each cost one movement history: the contract has no bulk “last movement per batch”,
            so ageing cannot be read for two thousand batches to paint a panel.
          </>
        ) : null}
        {onSortByValue ? (
          <>
            {' '}
            <button
              type="button"
              onClick={onSortByValue}
              className="rounded-[var(--radius-sm)] font-medium text-accent-11 underline-offset-2 hover:underline"
            >
              Sort the grid by value too
            </button>
          </>
        ) : null}
      </span>
    </p>
  )
}

/** A magnitude bar. Sequential ramp, direct label, never colour alone. */
export function ShareBar({ pct, tone }: { pct: string | null; tone: string }) {
  const n = pct === null ? 0 : D.toNumber(D.dec(pct))
  return (
    <span
      aria-hidden
      className="block h-2 w-full overflow-hidden rounded-[var(--radius-full)] bg-inset"
    >
      <span
        className="block h-full rounded-[var(--radius-full)]"
        style={{ width: `${Math.max(n, n > 0 ? 1.5 : 0)}%`, backgroundColor: tone }}
      />
    </span>
  )
}

/** Column head for the dense analysis tables. */
export function Th({
  children, align, className,
}: {
  children: ReactNode
  align?: 'right'
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        'micro-label sticky top-0 z-10 border-b border-border-subtle bg-subtle px-[var(--cell-px)] py-1.5',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  )
}
