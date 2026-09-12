import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CircleAlert, CircleCheck, Info, ShieldAlert, TriangleAlert,
} from 'lucide-react'
import type { FilingIssue } from '@contract'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { ErrorState, SkeletonRows } from '@/components/states'

/**
 * Is this month fit to file?
 *
 * The alternative is finding out from the portal — an error against a line
 * number in a JSON nobody wrote by hand, at the end of the month, usually on the
 * due date. Everything checked here is knowable weeks earlier from documents the
 * shop already holds.
 *
 * The screen commits to two things and says so on itself:
 *
 *  - IT ASSERTS NO LAW. Every threshold it applies comes from Settings, every
 *    one is recorded as unverified, and the figure used is printed under the
 *    result. A compliance screen that states an unverified threshold as fact is
 *    worse than none, because it is believed.
 *  - IT FILES NOTHING. No GSTR-1 JSON is generated and nothing is uploaded. It
 *    is a readiness check, which is the part software can actually be right
 *    about.
 */

const SEVERITY: Record<FilingIssue['severity'], {
  icon: typeof CircleAlert
  tone: string
  bg: string
  border: string
  word: string
}> = {
  blocker: {
    icon: ShieldAlert,
    tone: 'text-danger-11',
    bg: 'bg-danger-3',
    border: 'border-danger-9/30',
    word: 'Will be rejected',
  },
  warning: {
    icon: TriangleAlert,
    tone: 'text-warning-11',
    bg: 'bg-warning-3',
    border: 'border-warning-9/30',
    word: 'Worth a look',
  },
}

export function FilingCheckPanel({ from, to }: { from: string; to: string }) {
  const api = useApi()
  const [showBasis, setShowBasis] = useState(false)

  const check = useQuery({
    queryKey: ['filing', from, to],
    queryFn: () => api.checkFiling({ from, to }),
  })

  if (check.isPending) return <div className="card p-[var(--card-px)]"><SkeletonRows rows={6} cols={2} /></div>
  if (check.error) {
    return (
      <div className="card">
        <ErrorState
          code={check.error instanceof ApiError ? check.error.code : 'FILING_CHECK_FAILED'}
          message={(check.error as Error).message}
          onRetry={() => void check.refetch()}
        />
      </div>
    )
  }

  const r = check.data
  if (!r) return null
  const blockers = r.issues.filter((i) => i.severity === 'blocker')
  const warnings = r.issues.filter((i) => i.severity === 'warning')

  return (
    <section
      aria-label="Filing readiness"
      /* shrink-0: this panel lives in a scrolling column beside the report,
         and a flex item that may shrink gets squashed to nothing there. */
      className="card flex shrink-0 flex-col overflow-hidden"
    >
      <header
        className={cn(
          'flex shrink-0 flex-wrap items-center gap-3 border-b px-[var(--card-px)] py-2.5',
          r.ready ? 'border-border-subtle bg-success-3/40' : 'border-danger-9/25 bg-danger-3',
        )}
      >
        {r.ready ? (
          <CircleCheck size={18} className="shrink-0 text-success-11" aria-hidden />
        ) : (
          <ShieldAlert size={18} className="shrink-0 text-danger-11" aria-hidden />
        )}
        <div className="min-w-0">
          <h2 className={cn('text-sm font-semibold', r.ready ? 'text-success-11' : 'text-danger-11')}>
            {r.ready
              ? 'Nothing here would be rejected'
              : `${blockers.length} thing${blockers.length === 1 ? '' : 's'} would be rejected`}
          </h2>
          <p className="text-2xs text-fg-muted">
            {r.from} to {r.to} · <span className="mono">{r.gstin}</span>
            {warnings.length > 0 ? ` · ${warnings.length} worth a look` : ''}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Figure label="Taxable" value={r.taxableValue} />
          <Figure label="CGST" value={r.cgst} />
          <Figure label="SGST" value={r.sgst} />
          <Figure label="IGST" value={r.igst} />
        </div>
      </header>

      <div className="scroll-region min-h-0 flex-1 overflow-auto p-[var(--card-px)]">
        {r.issues.length === 0 ? (
          <p className="flex items-start gap-1.5 rounded-[var(--radius-md)] border border-border-subtle bg-subtle px-2.5 py-2 text-2xs text-fg-muted">
            <CircleCheck size={13} className="mt-px shrink-0 text-success-11" aria-hidden />
            Every invoice in this period foots, carries an HSN, and names a usable GSTIN where one
            is needed. That is what this screen can check — it is not a statement that the return
            is correct.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {r.issues.map((i) => {
              const s = SEVERITY[i.severity]
              const Icon = s.icon
              return (
                <li
                  key={i.code}
                  className={cn('rounded-[var(--radius-lg)] border px-3 py-2', s.border, s.bg)}
                >
                  <div className="flex items-baseline gap-2">
                    <Icon size={14} className={cn('shrink-0 self-center', s.tone)} aria-hidden />
                    <span className={cn('min-w-0 flex-1 text-sm font-semibold', s.tone)}>
                      {i.title}
                    </span>
                    {/* The severity in WORDS as well as colour — this is read on
                        a matte counter panel, often at an angle. */}
                    <span className={cn('shrink-0 text-2xs font-medium', s.tone)}>{s.word}</span>
                  </div>
                  <p className="mt-1 text-2xs leading-snug text-fg-muted">{i.detail}</p>
                  {i.refs.length > 0 ? (
                    <p className="mono mt-1 truncate text-2xs text-fg-subtle" title={i.refs.join(', ')}>
                      {i.refs.join(' · ')}
                      {/* The count is the truth once the list is capped — four
                          hundred invoice numbers is not something anybody reads. */}
                      {i.count > i.refs.length ? ` … and ${i.count - i.refs.length} more` : ''}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        {r.buckets.length > 0 ? (
          <section className="mt-3">
            <h3 className="micro-label">How the period splits</h3>
            <div className="mt-1 grid gap-2 @sm:grid-cols-2 @2xl:grid-cols-4">
              {r.buckets.map((b) => (
                <div key={b.key} className="rounded-[var(--radius-md)] border border-border-subtle px-2.5 py-1.5">
                  <span className="block truncate text-2xs text-fg-muted" title={b.label}>{b.label}</span>
                  <span className="num text-sm font-medium text-fg">{b.count}</span>
                  <span className="num ml-1.5 text-2xs text-fg-subtle">
                    ₹{formatAmount(b.taxableValue)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {r.series.length > 0 ? (
          <section className="mt-3">
            <h3 className="micro-label">Documents issued</h3>
            {/* Table 13 asks for total, cancelled and net per series — which is
                exactly why a voided bill keeps its number and stays in the book
                rather than being deleted. */}
            <div className="mt-1 overflow-x-auto">
              <table className="w-full border-collapse text-2xs">
                <thead>
                  <tr>
                    {['Series', 'From', 'To', 'Total', 'Cancelled', 'Net'].map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn(
                          'micro-label border-b border-border-subtle px-2 py-1',
                          i >= 3 ? 'text-right' : 'text-left',
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.series.map((s) => (
                    <tr key={`${s.label}-${s.from}`} className="border-b border-border-subtle">
                      <td className="px-2 py-1 text-fg">{s.label}</td>
                      <td className="mono px-2 py-1 text-fg-muted">{s.from}</td>
                      <td className="mono px-2 py-1 text-fg-muted">{s.to}</td>
                      <td className="num px-2 py-1 text-right text-fg">{s.total}</td>
                      <td className={cn('num px-2 py-1 text-right', s.cancelled > 0 ? 'text-warning-11' : 'text-fg-subtle')}>
                        {s.cancelled}
                      </td>
                      <td className="num px-2 py-1 text-right font-medium text-fg">{s.net}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-border-subtle bg-subtle px-[var(--card-px)] py-2">
        <Button variant="ghost" onClick={() => setShowBasis((v) => !v)} aria-expanded={showBasis}>
          <Info /> {showBasis ? 'Hide' : 'What this checked, and what it did not'}
        </Button>
        {showBasis ? (
          <ul className="mt-1.5 flex flex-col gap-1">
            {r.basis.map((b) => (
              <li key={b} className="flex items-start gap-1.5 text-2xs text-fg-muted">
                <span aria-hidden className="mt-1 size-1 shrink-0 rounded-full bg-fg-subtle" />
                {b}
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </section>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[72px]">
      <span className="micro-label block">{label}</span>
      <span className="num text-sm font-medium text-fg">₹{formatAmount(value)}</span>
    </div>
  )
}
