import { useCallback, useMemo, useState } from 'react'
import {
  CalendarClock, CalendarDays, CheckCheck, ClipboardCopy, Coins, Receipt,
  TriangleAlert, Users, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import * as D from '@/domain/decimal'
import { cn } from '@/lib/cn'
import { formatAmount, formatMoney } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'
import {
  DUE_BUCKETS, formatDate, groupPlanBySupplier, money, selectionTotal,
} from './supplierInsights'
import type { DueBill, DueBucketKey, PaymentPlan, SupplierDue } from './supplierInsights'
import type { PurchaseStatus } from './SupplierDetail'

/**
 * What has to be paid, and when.
 *
 * The outstanding list answers "what do we owe". It cannot answer the question a
 * shop owner actually asks on a Monday morning, which is "what leaves the bank
 * this week and to whom" — that needs a DUE date, and a due date needs the
 * supplier's own credit terms applied to each bill. Marg answers it with an
 * "Outstanding — bill wise" report printed on paper and gone over with a pen;
 * this is that report with the pen built in.
 *
 * Three decisions carry the screen:
 *
 *  - THE RUNNING TOTAL IS A COLUMN. A payables list gives you a per-bill amount
 *    and a grand total, and neither answers "if I release two lakh, how far down
 *    does it get me". The cumulative does, and it is the reason to read the list
 *    in due order at all.
 *  - IT GROUPS BY SUPPLIER ON DEMAND. A cheque is written to a distributor, not
 *    to an invoice. The bill-wise view is the working; the supplier-wise view is
 *    the instruction, and both are one keystroke apart because the argument at
 *    the counter moves between them.
 *  - NOTHING HERE POSTS A PAYMENT. There is no payment document in the contract
 *    yet, and a screen that looked like it recorded one would be worse than no
 *    screen. What it does is build the list and hand it over — ticked, totalled
 *    and copyable into whatever actually pays.
 */

export function PaymentPlanner({
  plan,
  status,
  error,
  onRetry,
  onOpenSupplier,
}: {
  plan: PaymentPlan
  status: PurchaseStatus
  error?: string
  onRetry: () => void
  onOpenSupplier: (id: number) => void
}) {
  /* Default ON: the planner exists for the week's run, and opening on ninety
     rows of "due in two months" buries the eleven that matter today. */
  const [weekOnly, setWeekOnly] = useState(true)
  const [bySupplier, setBySupplier] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set())

  const bills = useMemo(
    () => (weekOnly ? plan.bills.filter((b) => WEEK.has(b.bucket)) : plan.bills),
    [plan.bills, weekOnly],
  )
  const groups = useMemo(() => groupPlanBySupplier(bills), [bills])
  const run = useMemo(() => selectionTotal(plan.bills, picked), [plan.bills, picked])

  const toggle = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleMany = useCallback((ids: readonly number[], on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const copyRun = useCallback(() => {
    const chosen = plan.bills.filter((b) => picked.has(b.purchaseId))
    if (chosen.length === 0) return
    /* Tab-separated, because the destination is a spreadsheet or a WhatsApp
       message to whoever writes the cheques — not this application. */
    const text = [
      ['Supplier', 'Bill', 'Due', 'Amount'].join('\t'),
      ...chosen.map((b) => [
        b.supplierName,
        b.supplierInvoiceNo || b.purchaseNo,
        formatDate(b.dueOn),
        formatAmount(b.balance),
      ].join('\t')),
      ['', '', 'Total', formatAmount(run.amount)].join('\t'),
    ].join('\n')

    void navigator.clipboard?.writeText(text).then(
      () => toast.success(`${chosen.length} bill${chosen.length === 1 ? '' : 's'} copied`, {
        description: `${formatMoney(run.amount)} across ${run.suppliers} supplier${run.suppliers === 1 ? '' : 's'}.`,
      }),
      () => toast.error('The clipboard is not available in this browser'),
    )
  }, [plan.bills, picked, run])

  if (status === 'loading') {
    return (
      <div className="card min-h-0 flex-1 overflow-hidden">
        <SkeletonRows rows={12} cols={5} />
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="card flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <ErrorState
          code="PURCHASES_FAILED"
          message={error ?? 'The purchase register could not be read, so nothing can be scheduled against it.'}
          onRetry={onRetry}
        />
      </div>
    )
  }

  const nothingDue = plan.bills.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--card-gap)]">
      <WeekBand plan={plan} />

      <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-raised px-[var(--card-px)] py-3">
          <h2 className="text-base font-medium text-fg">
            {bySupplier ? 'Who to pay' : 'Which bills to release'}
          </h2>
          <span className="text-sm text-fg-muted">
            {bills.length} bill{bills.length === 1 ? '' : 's'}
            {weekOnly && plan.bills.length > bills.length
              ? ` of ${plan.bills.length} open`
              : ''}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Toggle
              on={weekOnly}
              icon={CalendarDays}
              label="This week only"
              onClick={() => setWeekOnly((v) => !v)}
            />
            <Toggle
              on={bySupplier}
              icon={Users}
              label="Group by supplier"
              onClick={() => setBySupplier((v) => !v)}
            />
          </div>
        </header>

        <div className="scroll-region min-h-0 flex-1" style={{ ['--pinned-h' as string]: '64px' }}>
          {nothingDue ? (
            <EmptyState
              icon={CheckCheck}
              title="Nothing is due"
              body="Every bill in the loaded purchase window is settled. That is the good answer."
            />
          ) : bills.length === 0 ? (
            <EmptyState
              icon={CheckCheck}
              title="Nothing due inside seven days"
              body="No bill falls due this week on the terms agreed with these distributors."
              actionLabel="Show everything open"
              onAction={() => setWeekOnly(false)}
            />
          ) : bySupplier ? (
            <SupplierList groups={groups} picked={picked} onToggleMany={toggleMany} onOpen={onOpenSupplier} />
          ) : (
            <BillList bills={bills} picked={picked} onToggle={toggle} onToggleMany={toggleMany} onOpen={onOpenSupplier} />
          )}
        </div>

        {/* The run only exists once something is ticked. A permanently pinned
            bar showing ₹0.00 trains the eye to stop reading it. */}
        {run.count > 0 ? (
          <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-subtle px-[var(--card-px)] py-3">
            <span className="flex items-center gap-2">
              <Wallet size={16} className="text-fg-subtle" aria-hidden />
              <span className="micro-label">Payment run</span>
            </span>
            <span data-run-total className="num text-xl font-semibold text-fg">{formatMoney(run.amount)}</span>
            <span className="text-sm text-fg-muted">
              {run.count} bill{run.count === 1 ? '' : 's'} · {run.suppliers} supplier{run.suppliers === 1 ? '' : 's'}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={copyRun}>
                <ClipboardCopy /> Copy list
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
            </span>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

const WEEK = new Set<DueBucketKey>(['overdue', 'today', 'week'])

// ------------------------------------------------------------- the band ---

function WeekBand({ plan }: { plan: PaymentPlan }) {
  const week = money(plan.dueThisWeek) ?? D.ZERO
  const overdue = money(plan.overdue) ?? D.ZERO
  const late = D.gt(overdue, D.ZERO)

  return (
    <div className="grid shrink-0 gap-[var(--card-gap)] lg:grid-cols-[minmax(320px,1.15fr)_minmax(0,2fr)]">
      <section className="card px-[var(--card-px)] py-[var(--card-px)]">
        <div className="flex items-center gap-2">
          <CalendarClock size={15} className="text-fg-subtle" aria-hidden />
          <span className="micro-label">Due this week</span>
        </div>
        <div className="display-num mt-2 text-5xl text-fg">{formatMoney(plan.dueThisWeek)}</div>
        <p className="mt-2 text-base text-fg-muted">
          {D.gt(week, D.ZERO)
            ? <>{plan.dueThisWeekCount} bill{plan.dueThisWeekCount === 1 ? '' : 's'} to {plan.suppliersThisWeek} distributor{plan.suppliersThisWeek === 1 ? '' : 's'}, counting everything already past terms.</>
            : 'Nothing falls due inside seven days on the terms agreed.'}
        </p>
        {late ? (
          <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              <span className="num font-semibold">{formatMoney(plan.overdue)}</span> of it is already past
              terms across {plan.overdueCount} bill{plan.overdueCount === 1 ? '' : 's'} — supply is what
              stops first.
            </span>
          </p>
        ) : null}
      </section>

      <section className="card flex flex-col overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-[var(--card-px)]">
          <Coins size={15} className="text-fg-subtle" aria-hidden />
          <span className="text-base font-medium text-fg">The whole payable, by when it falls due</span>
          <span className="num ml-auto text-sm text-fg-muted">{formatAmount(plan.total)}</span>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-px bg-border-subtle sm:grid-cols-3 xl:grid-cols-5">
          {plan.totals.map(({ spec, amount, count }) => (
            <div key={spec.key} className="flex flex-col justify-center bg-surface px-[var(--card-px)] py-3">
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: spec.tone }} />
                <span className="micro-label whitespace-nowrap">{spec.label}</span>
              </div>
              <div
                className={cn('num mt-1 text-xl font-semibold', count > 0 ? 'text-fg' : 'text-fg-subtle')}
              >
                {formatAmount(amount)}
              </div>
              <div className="text-2xs text-fg-subtle">
                {count > 0 ? `${count} bill${count === 1 ? '' : 's'} · ${spec.note}` : 'nothing here'}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// -------------------------------------------------------------- the lists ---

const BILL_COLS = 'grid-cols-[32px_minmax(140px,1.6fr)_minmax(110px,1fr)_128px_112px_128px]'

function BillList({
  bills, picked, onToggle, onToggleMany, onOpen,
}: {
  bills: readonly DueBill[]
  picked: ReadonlySet<number>
  onToggle: (id: number) => void
  onToggleMany: (ids: readonly number[], on: boolean) => void
  onOpen: (supplierId: number) => void
}) {
  /* Grouped under a heading per bucket rather than filtered to one: the break
     between "past terms" and "due Thursday" is the shape of the decision, and a
     flat list makes the reader find it by reading dates. */
  const sections = DUE_BUCKETS
    .map((spec) => ({ spec, rows: bills.filter((b) => b.bucket === spec.key) }))
    .filter((s) => s.rows.length > 0)

  return (
    <div>
      <div className={cn('sticky top-0 z-10 grid items-center gap-3 border-b border-border-subtle bg-subtle px-[var(--card-px)] py-2', BILL_COLS)}>
        <span aria-hidden />
        <span className="micro-label">Supplier</span>
        <span className="micro-label">Bill</span>
        <span className="micro-label">Due</span>
        <span className="micro-label text-right">Amount ₹</span>
        <span className="micro-label text-right">Running ₹</span>
      </div>

      {sections.map(({ spec, rows }) => {
        const ids = rows.map((r) => r.purchaseId)
        const allOn = ids.every((id) => picked.has(id))
        const total = D.sum(rows.map((r) => money(r.balance) ?? D.ZERO))
        return (
          <section key={spec.key}>
            <header className="flex items-center gap-2 border-b border-border-subtle bg-app px-[var(--card-px)] py-2">
              <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: spec.tone }} />
              <span className="text-sm font-medium text-fg">{spec.label}</span>
              <span className="text-xs text-fg-subtle">{spec.note}</span>
              <span className="num ml-auto text-sm text-fg">{formatAmount(D.toStr(total, 2))}</span>
              <button
                type="button"
                onClick={() => onToggleMany(ids, !allOn)}
                className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-accent-11 hover:bg-accent-2"
              >
                {allOn ? 'Unpick' : 'Pick all'}
              </button>
            </header>
            {rows.map((bill) => (
              <BillRow
                key={bill.purchaseId}
                bill={bill}
                picked={picked.has(bill.purchaseId)}
                onToggle={() => onToggle(bill.purchaseId)}
                onOpen={() => onOpen(bill.supplierId)}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}

function BillRow({
  bill, picked, onToggle, onOpen,
}: {
  bill: DueBill
  picked: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const late = bill.daysToDue < 0

  return (
    <div
      data-due-row
      className={cn(
        'grid items-center gap-3 border-b border-border-subtle px-[var(--card-px)]',
        BILL_COLS,
        picked ? 'bg-accent-2' : 'hover:bg-hover',
      )}
      style={{ minHeight: 'var(--row-h)' }}
    >
      <label className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={picked}
          onChange={onToggle}
          className="size-4 accent-[var(--accent-9)]"
          aria-label={`Include ${bill.supplierInvoiceNo || bill.purchaseNo} in the payment run`}
        />
      </label>

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left text-base font-medium text-fg hover:text-accent-11 hover:underline"
      >
        {bill.supplierName}
      </button>

      <span className="flex min-w-0 flex-col">
        <span className="mono truncate text-sm text-fg" title={bill.supplierInvoiceNo}>
          {bill.supplierInvoiceNo || bill.purchaseNo}
        </span>
        <span className="text-2xs text-fg-subtle">
          billed {formatDate(bill.invoiceDate)} · {bill.termsDays > 0 ? `${bill.termsDays}d` : 'cash'}
        </span>
      </span>

      <span className="flex min-w-0 flex-col">
        <span className={cn('text-sm', late ? 'font-medium text-danger-11' : 'text-fg')}>
          {formatDate(bill.dueOn)}
        </span>
        {/* The signed day count is also the sort key, exposed so a test can
            prove the list really is in due order rather than merely looking it. */}
        <span data-due-days={bill.daysToDue} className={cn('text-2xs', late ? 'text-danger-11' : 'text-fg-subtle')}>
          {late
            ? `${-bill.daysToDue} day${bill.daysToDue === -1 ? '' : 's'} late`
            : bill.daysToDue === 0 ? 'today' : `in ${bill.daysToDue} day${bill.daysToDue === 1 ? '' : 's'}`}
        </span>
      </span>

      <span data-due-amount className="num text-base font-medium text-fg">{formatAmount(bill.balance)}</span>
      {/* The point of the whole list: release this much and everything down to
          and including this row is clear. */}
      <span data-due-running className="num text-sm text-fg-subtle">{formatAmount(bill.cumulative)}</span>
    </div>
  )
}

function SupplierList({
  groups, picked, onToggleMany, onOpen,
}: {
  groups: readonly SupplierDue[]
  picked: ReadonlySet<number>
  onToggleMany: (ids: readonly number[], on: boolean) => void
  onOpen: (supplierId: number) => void
}) {
  return (
    <div>
      {groups.map((g) => {
        const ids = g.bills.map((b) => b.purchaseId)
        const allOn = ids.every((id) => picked.has(id))
        const someOn = !allOn && ids.some((id) => picked.has(id))
        const late = D.gt(money(g.overdue) ?? D.ZERO, D.ZERO)

        return (
          <section
            key={g.supplierId}
            data-due-supplier
            className={cn(
              'border-b border-border-subtle px-[var(--card-px)] py-3',
              allOn || someOn ? 'bg-accent-2' : null,
            )}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={() => onOpen(g.supplierId)}
                className="text-lg font-medium text-fg hover:text-accent-11 hover:underline"
              >
                {g.supplierName}
              </button>
              {late ? (
                <Chip icon={TriangleAlert} tone="var(--danger-11)">
                  {formatAmount(g.overdue)} past terms
                </Chip>
              ) : (
                <Chip icon={CalendarClock}>
                  {g.daysToDue === 0 ? 'due today' : `due in ${g.daysToDue}d`}
                </Chip>
              )}
              <span className="num ml-auto text-xl font-semibold text-fg">{formatAmount(g.total)}</span>
              <button
                type="button"
                onClick={() => onToggleMany(ids, !allOn)}
                className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-accent-11 hover:bg-accent-3"
              >
                {allOn ? 'Unpick' : `Pick ${ids.length} bill${ids.length === 1 ? '' : 's'}`}
              </button>
            </div>

            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {g.bills.map((b) => (
                <li key={b.purchaseId} className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <Receipt size={12} className="text-fg-subtle" aria-hidden />
                  <span className="mono">{b.supplierInvoiceNo || b.purchaseNo}</span>
                  <span className="num text-fg">{formatAmount(b.balance)}</span>
                  <span className={b.daysToDue < 0 ? 'text-danger-11' : 'text-fg-subtle'}>
                    {b.daysToDue < 0 ? `${-b.daysToDue}d late` : formatDate(b.dueOn)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function Toggle({
  on, icon: Icon, label, onClick,
}: {
  on: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm',
        on
          ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
          : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg',
      )}
    >
      <Icon size={15} aria-hidden />
      {label}
    </button>
  )
}
