import { useMemo, useState } from 'react'
import { Download, FileText, Scale, TriangleAlert } from 'lucide-react'
import type { StoreProfile } from '@contract'
import type { CustomerRow } from '@/api/customers'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { ErrorState, SkeletonRows } from '@/components/states'
import { Section } from './sheet'
import { formatDay, formatLongDay } from './CustomerTable'
import type { BillStatus } from './CustomerTable'
import { toIsoDate } from './profile'
import { RANGE_PRESETS, downloadStatement, statementOf } from './statement'
import type { Statement } from './statement'

/**
 * The statement of account, for a period the operator chooses.
 *
 * The panel's job is to make the document DEFENSIBLE, not merely to list rows.
 * Three things are therefore always on screen with it: what is in it (only
 * amounts that went on the account), what the opening balance contains (every
 * older document, unitemised), and why the closing balance can differ from the
 * balance shown at the top of the sheet (documents dated after the period).
 * Every one of those is a question a customer asks at the counter, and a
 * statement that cannot answer them loses the argument it was printed to win.
 */

export function StatementPanel({
  row,
  store,
  today,
  billStatus,
  billError,
  onRetryBills,
}: {
  row: CustomerRow
  store: StoreProfile | null
  today: Date
  billStatus: BillStatus
  billError?: string
  onRetryBills: () => void
}) {
  const fallback = RANGE_PRESETS[2] ?? RANGE_PRESETS[0]
  const initial = useMemo(
    () => (fallback ? fallback.of(today) : { from: toIsoDate(today), to: toIsoDate(today) }),
    [fallback, today],
  )
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)

  const backwards = from > to
  const statement = useMemo(
    () => (backwards ? null : statementOf(row, from, to)),
    [backwards, row, from, to],
  )
  const activePreset = RANGE_PRESETS.find((p) => {
    const r = p.of(today)
    return r.from === from && r.to === to
  })

  if (billStatus === 'loading') return <SkeletonRows rows={7} cols={3} />
  if (billStatus === 'error') {
    return (
      <ErrorState
        code="CUSTOMER_BILLS_FAILED"
        message={billError ?? 'Bills could not be read, so no statement can be drawn from them.'}
        onRetry={onRetryBills}
      />
    )
  }

  return (
    <div>
      <div className="border-b border-border-subtle px-[var(--card-px)] py-2.5">
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((preset) => {
            const on = activePreset?.id === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const r = preset.of(today)
                  setFrom(r.from)
                  setTo(r.to)
                }}
                className={cn(
                  'inline-flex h-7 items-center rounded-[var(--radius-md)] border px-2 text-2xs',
                  on
                    ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
                    : 'border-border-subtle bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
                )}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="micro-label">From</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mono h-8 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-xs hover:border-border-strong"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="micro-label">To</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="mono h-8 rounded-[var(--radius-md)] border border-border bg-surface px-2 text-xs hover:border-border-strong"
            />
          </label>
          <Button
            size="sm"
            className="ml-auto"
            disabled={statement === null}
            onClick={() => {
              if (!statement) return
              downloadStatement({
                store,
                customer: row.customer,
                statement,
                generatedAt: new Date().toISOString(),
              })
            }}
          >
            <Download /> Export CSV
          </Button>
        </div>
      </div>

      {statement === null ? (
        <p className="flex items-start gap-1.5 px-[var(--card-px)] py-3 text-sm text-warning-11">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          The start of the period is after its end. Swap the two dates.
        </p>
      ) : (
        <StatementBody statement={statement} name={row.customer.name} />
      )}
    </div>
  )
}

function StatementBody({ statement: s, name }: { statement: Statement; name: string }) {
  const movement = D.sub(D.dec(s.debit), D.dec(s.credit))
  const afterMoved = !D.isZero(D.dec(s.after))

  return (
    <div>
      <div className="grid grid-cols-2 gap-px border-b border-border-subtle bg-border-subtle">
        <Cell label={`Opening ${formatDay(s.from)}`} value={formatMoney(s.opening)} />
        <Cell label="Billed on account" value={formatMoney(s.debit)} tone={D.gt(D.dec(s.debit), D.ZERO) ? 'debit' : undefined} />
        <Cell label="Received" value={formatMoney(s.credit)} tone={D.gt(D.dec(s.credit), D.ZERO) ? 'credit' : undefined} />
        <Cell label={`Closing ${formatDay(s.to)}`} value={formatMoney(s.closing)} hero />
      </div>

      <Section title="Documents" icon={FileText} note={`${s.entries.length} in this period`}>
        <div className="grid grid-cols-[1fr_80px_88px] gap-2 border-b border-border-subtle px-[var(--card-px)] py-1">
          <span className="micro-label">Date and document</span>
          <span className="micro-label text-right">Amount ₹</span>
          <span className="micro-label text-right">Balance ₹</span>
        </div>

        <div className="grid grid-cols-[1fr_80px_88px] items-baseline gap-2 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-1.5">
          <span className="text-2xs font-medium text-fg-muted">Balance brought forward</span>
          <span className="text-2xs text-fg-subtle" />
          <span className="num text-sm font-medium text-fg">{formatAmount(s.opening)}</span>
        </div>

        {s.entries.length === 0 ? (
          <p className="px-[var(--card-px)] py-3 text-sm text-fg-muted">
            Nothing went on or came off this account between {formatLongDay(s.from)} and{' '}
            {formatLongDay(s.to)}. The balance either side of the period is the same.
          </p>
        ) : (
          s.entries.map((e) => (
            <div
              key={e.key}
              className={cn(
                'grid grid-cols-[1fr_80px_88px] items-baseline gap-2 border-b border-border-subtle px-[var(--card-px)] py-1.5',
                e.voided && 'opacity-60',
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-2xs text-fg-subtle">{formatDay(e.date)}</span>
                  <span className="mono truncate text-sm text-fg" title={e.ref}>{e.ref}</span>
                </span>
                <span className="truncate text-2xs text-fg-subtle" title={e.particulars}>{e.particulars}</span>
              </span>
              <span
                className={cn(
                  'num text-sm',
                  e.debit ? 'text-warning-11' : e.credit ? 'text-success-11' : 'text-fg-subtle',
                )}
              >
                {e.debit ? `+ ${formatAmount(e.debit)}` : e.credit ? `− ${formatAmount(e.credit)}` : 'Nil'}
              </span>
              <span className="num text-sm text-fg">{formatAmount(e.balance)}</span>
            </div>
          ))
        )}

        <div className="grid grid-cols-[1fr_80px_88px] items-baseline gap-2 bg-subtle px-[var(--card-px)] py-2">
          <span className="text-sm font-semibold text-fg">Balance carried forward</span>
          <span className={cn('num text-2xs', D.isNeg(movement) ? 'text-success-11' : 'text-warning-11')}>
            {D.isNeg(movement) ? '−' : '+'} {formatAmount(D.toStr(D.abs(movement), 2))}
          </span>
          <span className="num text-sm font-semibold text-fg">{formatAmount(s.closing)}</span>
        </div>
      </Section>

      <Section title="What this document is" icon={Scale}>
        <ul className="space-y-1.5 px-[var(--card-px)] pb-3 text-2xs text-fg-muted">
          <li>
            Only amounts that went <strong>on the account</strong> are here. Bills {name} settled in
            cash, by UPI or by card never moved this balance and are not listed.
          </li>
          <li>
            The closing balance is pinned to the balance held on the customer master; the opening
            balance is worked back from it across the documents above.
            {s.earlier > 0 ? (
              <> <span className="num">{s.earlier}</span> earlier document{s.earlier === 1 ? ' is' : 's are'} inside
              it and not itemised.</>
            ) : null}
          </li>
          {!s.windowStartsInside ? (
            <li className="text-warning-11">
              The opening balance also carries anything older than the loaded bill window — including
              a balance brought in from previous software. It is real money; it simply cannot be
              itemised here.
            </li>
          ) : null}
          {afterMoved ? (
            <li className="text-warning-11">
              Documents dated after {formatLongDay(s.to)} move this account by{' '}
              <span className="num">{formatAmount(s.after)}</span>, which is why the closing balance
              above is not the balance shown at the top of this sheet.
            </li>
          ) : null}
          {s.stated === null ? (
            <li className="text-danger-11">
              The balance on the customer master is not a readable amount, so nothing here could be
              pinned to it. Treat every figure above as unverified until that is corrected at source.
            </li>
          ) : null}
        </ul>
      </Section>
    </div>
  )
}

function Cell({
  label, value, hero, tone,
}: {
  label: string
  value: string
  hero?: boolean
  tone?: 'debit' | 'credit'
}) {
  return (
    <div className="min-w-0 bg-surface px-[var(--card-px)] py-2">
      <div className="micro-label truncate">{label}</div>
      <div
        className={cn(
          // `text-left` overrides `.num`: these four sit under their own labels.
          'mt-0.5 truncate text-left',
          hero ? 'display-num text-xl' : 'num text-base font-semibold',
          tone === 'debit' ? 'text-warning-11' : tone === 'credit' ? 'text-success-11' : 'text-fg',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  )
}
