import { CircleCheck, TriangleAlert } from 'lucide-react'
import type { ReportCheck } from '@contract'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'

/**
 * The proof that the filing is right.
 *
 * A rate-wise GST summary is only worth having if it foots. The two sides below
 * are the same supplies aggregated along different axes — grouped from batch
 * allocations on the left, folded from the document lines on the right — so they
 * MUST agree to the paisa, and `domain/gst` makes that true by construction:
 * every tax is taken as a residual of the GST-inclusive amount rather than
 * computed independently, which is what stops a paisa going missing between a
 * line and its rate row.
 *
 * That is why the difference is rendered as an exact figure and not as a
 * traffic light. An accountant filing a return does not want reassurance, they
 * want the number that has to be zero, and they want to see that it is.
 *
 * The panel is shown for every report that carries a reconciliation, not only
 * the GST one: any two RxBill figures that must agree get a third that proves
 * they do.
 */
export function GstSummary({ checks }: { checks: readonly ReportCheck[] }) {
  if (checks.length === 0) return null
  const broken = checks.filter((c) => !c.balanced)

  return (
    <section
      aria-label="Reconciliation"
      className={cn(
        'flex shrink-0 flex-col gap-2 rounded-[var(--radius-lg)] border p-[var(--card-px)]',
        broken.length > 0
          ? 'border-danger-9/30 bg-danger-3'
          : 'border-success-9/30 bg-success-3',
      )}
    >
      <header className="flex items-center gap-2">
        {broken.length > 0 ? (
          <TriangleAlert size={15} className="shrink-0 text-danger-9" aria-hidden />
        ) : (
          <CircleCheck size={15} className="shrink-0 text-success-11" aria-hidden />
        )}
        <h2 className={cn('text-base font-semibold', broken.length > 0 ? 'text-danger-11' : 'text-fg')}>
          {broken.length > 0
            ? `${broken.length} of ${checks.length} figures do not reconcile`
            : 'Reconciled to the paisa'}
        </h2>
        <p className="min-w-0 flex-1 truncate text-2xs text-fg-muted">
          {broken.length > 0
            ? 'Do not file from this. A difference here is damaged data, not rounding.'
            : 'Each figure below was computed twice, along different axes, and the two agree exactly.'}
        </p>
      </header>

      <div className="grid gap-2 @2xl:grid-cols-2">
        {checks.map((check) => (
          <div
            key={check.label}
            className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-border-subtle bg-surface px-3 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="micro-label">{check.label}</span>
              <span
                className={cn(
                  'inline-flex h-5 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-2xs font-medium',
                  check.balanced ? 'bg-subtle text-fg-muted' : 'bg-danger-3 text-danger-11',
                )}
              >
                {check.balanced ? 'Difference' : 'Out by'}
                {' '}
                <span className="num font-semibold">{formatMoney(check.difference)}</span>
              </span>
            </div>

            <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5">
              <dt className="truncate text-2xs text-fg-muted" title={check.leftLabel}>{check.leftLabel}</dt>
              <dd className="num text-base font-medium">{formatMoney(check.left)}</dd>
              <dt className="truncate text-2xs text-fg-muted" title={check.rightLabel}>{check.rightLabel}</dt>
              <dd className="num text-base font-medium">{formatMoney(check.right)}</dd>
            </dl>

            <p className="text-2xs leading-snug text-fg-subtle">{check.explain}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
