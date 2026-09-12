import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownRight, ArrowUpRight, Building2, ChevronRight, CircleAlert, Clock, Eye, Minus,
  PackageX, TriangleAlert,
} from 'lucide-react'
import type { AttentionAlert, DashboardData, Kpi, Money, Pct } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { useBrand } from '@/brand/useBrand'
import * as D from '@/domain/decimal'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/states'

/**
 * The owner's phone.
 *
 * A separate surface, not a responsive dashboard, and that is the whole design
 * decision. Every screen in this app is built for somebody STANDING AT A
 * COUNTER: ten-column grids, a three-pane till, keyboard-first everything. None
 * of that becomes usable on a 390px screen by rearranging it — it becomes a
 * worse version of itself that also breaks the desk layout it came from. The
 * owner is asking a different question anyway.
 *
 * Two rules define it:
 *
 *  - IT IS READ-ONLY, and says so. Not because writing is hard, but because a
 *    phone is the device that gets left in an auto-rickshaw. Nothing here posts
 *    a document, moves stock, or changes a setting; the worst a lost phone
 *    costs is the day's figures, which the person holding it already knew.
 *  - IT ANSWERS THE FOUR QUESTIONS AN OWNER ACTUALLY ASKS. What did we take,
 *    what needs me today, what is at risk on the shelf, and — for a chain — how
 *    are the other shops doing. Everything else is a reason to open a laptop,
 *    and the screen says that rather than pretending otherwise.
 *
 * It is white-labelled like every other surface: the shop's name at the top, the
 * reseller's accent throughout, and no vendor mark anywhere.
 */
export default function OwnerMobile() {
  const api = useApi()
  const brand = useBrand()
  const [date] = useState(() => new Date().toISOString().slice(0, 10))

  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const dash = useQuery({
    queryKey: ['dashboard', date, 'today'],
    queryFn: () => api.getDashboard(date, 'today'),
  })
  const alerts = useQuery({ queryKey: ['attention'], queryFn: () => api.attention() })

  if (dash.error) {
    return (
      <div className="p-4">
        <ErrorState
          code="DASHBOARD_FAILED"
          message={(dash.error as Error).message}
          onRetry={() => void dash.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col bg-app pb-10" data-density="comfortable">
      <header
        className="page-header sticky top-0 z-10 flex items-center gap-3"
        style={{ paddingInline: 'var(--space-4)', paddingBlock: 'var(--space-3)' }}
      >
        <div className="min-w-0 flex-1">
          {/* The SHOP, never the software. */}
          <h1 className="truncate text-lg font-semibold tracking-tight text-fg">
            {store.data?.name ?? brand.productName}
          </h1>
          <p className="truncate text-xs text-fg-muted">
            {dash.data ? `Today · ${niceDay(dash.data.date)}` : 'Today'}
          </p>
        </div>
        {/* Read-only is a promise, so it is on the screen and not just in the
            code. An owner who believes they can void a bill from here will try
            it in front of a customer. */}
        <span className="flex shrink-0 items-center gap-1 rounded-[var(--radius-full)] border border-border bg-subtle px-2.5 py-1 text-2xs font-medium text-fg-muted">
          <Eye size={12} aria-hidden />
          View only
        </span>
      </header>

      <main className="flex flex-col gap-4 px-4 pt-4">
        {dash.isPending ? <SkeletonRows rows={4} cols={2} /> : dash.data ? (
          <>
            <Takings data={dash.data} />
            <Attention alerts={alerts.data ?? []} loading={alerts.isPending} />
            <AtRisk data={dash.data} />
            {dash.data.branches.length > 1 && <Branches data={dash.data} />}
          </>
        ) : null}

        <p className="px-1 pt-2 text-xs leading-relaxed text-fg-subtle">
          {'Billing, purchases, returns and settings are on the counter machine. '
           + 'This screen only reads — nothing here can change a document.'}
        </p>

        {/* The way back, because a surface with no exit is a trap. It is a link
            and not a redirect: somebody who wants a report on their phone is
            allowed to have one. */}
        <Link
          to="/"
          className="flex items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3 text-sm font-medium text-fg-muted active:bg-hover"
        >
          Open the full counter app
          <ChevronRight size={15} aria-hidden />
        </Link>
      </main>
    </div>
  )
}

/* --------------------------------------------------------------- takings --- */

function Takings({ data }: { data: DashboardData }) {
  return (
    <section className="card p-4" aria-label="Today's takings">
      <h2 className="micro-label">Taken today</h2>
      <p className="display-num mt-1 text-4xl text-fg">₹{formatAmount(data.kpis.sales.value)}</p>
      <Delta kpi={data.kpis.sales} comparedTo={data.comparedTo} />

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border-subtle pt-3">
        <Stat label="Bills" value={data.kpis.orders.value} plain />
        <Stat label="Margin" value={`${data.kpis.grossMarginPct.value}%`} plain />
        <Stat label="Owed to us" value={`₹${formatAmount(data.kpis.overdue.value)}`} plain />
      </dl>
    </section>
  )
}

function Stat({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label">{label}</dt>
      <dd className={cn('num mt-0.5 truncate text-base font-semibold text-fg', plain && 'font-medium')}>
        {value}
      </dd>
    </div>
  )
}

/**
 * The movement, with its direction said in WORDS as well as drawn.
 *
 * A red arrow alone is the classic phone-in-sunlight failure, and this is a
 * screen read one-handed on a shop floor. "down 12% on yesterday" survives a
 * glare, a colourblind reader and a screenshot pasted into a family chat.
 */
function Delta({ kpi, comparedTo }: { kpi: Kpi; comparedTo: string }) {
  if (kpi.deltaPct === null) {
    return <p className="mt-1 text-sm text-fg-subtle">No {comparedTo} to compare with.</p>
  }
  const pct = safeDec(kpi.deltaPct)
  const flat = pct !== null && D.isZero(pct)
  const rising = pct !== null && !D.isNeg(pct)
  const good = rising === kpi.riseIsGood
  const Icon = flat ? Minus : rising ? ArrowUpRight : ArrowDownRight

  return (
    <p
      className={cn(
        'mt-1 flex items-center gap-1.5 text-sm font-medium',
        flat ? 'text-fg-muted' : good ? 'text-success-11' : 'text-danger-11',
      )}
    >
      <Icon size={15} aria-hidden />
      {flat ? 'Level with' : `${rising ? 'Up' : 'Down'} ${strip(kpi.deltaPct)}% on`} {comparedTo}
    </p>
  )
}

/* ------------------------------------------------------------- attention --- */

function Attention({ alerts, loading }: { alerts: readonly AttentionAlert[]; loading: boolean }) {
  const now = alerts.filter((a) => a.severity === 'now')
  const soon = alerts.filter((a) => a.severity === 'soon')

  return (
    <section className="card overflow-hidden" aria-label="Needs attention">
      <header className="flex items-baseline gap-2 border-b border-border-subtle bg-subtle px-4 py-2.5">
        <h2 className="micro-label">Needs you</h2>
        {now.length > 0 && (
          <span className="num ml-auto text-xs font-semibold text-danger-11">
            {now.length} today
          </span>
        )}
      </header>

      {loading ? (
        <div className="p-4"><SkeletonRows rows={2} cols={1} /></div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={CircleAlert}
          title="Nothing waiting"
          body="No expiries, no overdue accounts and nothing short on the shelf."
        />
      ) : (
        <ul>
          {[...now, ...soon].map((a) => (
            <li key={a.kind} className="border-b border-border-subtle last:border-0">
              {/* A link INTO the desk app, deliberately. The owner taps it,
                  reads the detail, and does the work where the work belongs. */}
              <Link to={a.href} className="flex items-start gap-3 px-4 py-3 active:bg-hover">
                <span
                  className={cn(
                    'mt-0.5 shrink-0',
                    a.severity === 'now' ? 'text-danger-11' : 'text-warning-11',
                  )}
                >
                  {a.severity === 'now'
                    ? <TriangleAlert size={16} aria-hidden />
                    : <Clock size={16} aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-base font-medium text-fg">{a.title}</span>
                    {/* The word, never the colour alone. */}
                    <span className="text-2xs font-medium uppercase tracking-[var(--tracking-label)] text-fg-subtle">
                      {a.severity === 'now' ? 'Today' : 'This week'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-sm leading-snug text-fg-muted">{a.detail}</span>
                </span>
                {a.amount !== null && (
                  <span className="num shrink-0 text-sm font-semibold text-fg">
                    ₹{formatAmount(a.amount)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* --------------------------------------------------------------- at risk --- */

function AtRisk({ data }: { data: DashboardData }) {
  const expiring = data.expiring.slice(0, 4)
  const low = data.lowStock.slice(0, 4)

  return (
    <section className="card overflow-hidden" aria-label="On the shelf">
      <header className="border-b border-border-subtle bg-subtle px-4 py-2.5">
        <h2 className="micro-label">On the shelf</h2>
      </header>

      {/* A <dl>, because <Stat> renders a <dt>/<dd> pair. A plain grid div left
          four orphaned definition items on the page. */}
      <dl className="grid grid-cols-2 gap-3 border-b border-border-subtle p-4">
        {/* Value AT RISK, not total stock value: the number an owner acts on is
            the money with a deadline on it, and the shelf total is a figure they
            already know. */}
        <Stat label="Money expiring" value={`₹${formatAmount(data.inventoryHealth.valueAtRisk)}`} />
        <Stat
          label="Batches at risk"
          value={`${data.inventoryHealth.nearExpiry + data.inventoryHealth.expired}`}
        />
      </dl>

      {expiring.length === 0 && low.length === 0 ? (
        <EmptyState icon={PackageX} title="Nothing at risk" body="No batch near expiry and nothing below its reorder level." />
      ) : (
        <ul>
          {expiring.map((b) => (
            <li key={`x-${b.batchId}`} className="flex items-baseline gap-2 border-b border-border-subtle px-4 py-2.5 last:border-0">
              <TriangleAlert size={14} className="shrink-0 self-center text-warning-11" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base text-fg">{b.brandName}</span>
              <span className="shrink-0 text-xs text-fg-muted">expires {b.expiryDate}</span>
            </li>
          ))}
          {low.map((m) => (
            <li key={`l-${m.medicineId}`} className="flex items-baseline gap-2 border-b border-border-subtle px-4 py-2.5 last:border-0">
              <PackageX size={14} className="shrink-0 self-center text-danger-11" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base text-fg">{m.brandName}</span>
              <span className="num shrink-0 text-xs text-fg-muted">{m.qtyOnHand} left</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* -------------------------------------------------------------- branches --- */

function Branches({ data }: { data: DashboardData }) {
  return (
    <section className="card overflow-hidden" aria-label="Branches">
      <header className="border-b border-border-subtle bg-subtle px-4 py-2.5">
        <h2 className="micro-label">Every shop today</h2>
      </header>
      <ul>
        {data.branches.map((b) => (
          <li key={b.storeId} className="flex items-baseline gap-2 border-b border-border-subtle px-4 py-3 last:border-0">
            <Building2 size={14} className="shrink-0 self-center text-fg-subtle" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium text-fg">{b.name}</span>
              <span className="num block text-xs text-fg-muted">
                {b.orders} {b.orders === 1 ? 'bill' : 'bills'}
              </span>
            </span>
            <span className="num shrink-0 text-base font-semibold text-fg">
              ₹{formatAmount(b.sales)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* --------------------------------------------------------------- helpers --- */

/** A percentage without its sign — the direction is already a word and an icon. */
const strip = (pct: Pct): string => pct.replace(/^-/, '')

/** Never throws on a figure that arrived from the wire malformed. */
function safeDec(v: Money | Pct): D.Decimal | null {
  try {
    return D.dec(v)
  } catch {
    return null
  }
}

/** "Tue, 9 Sep" — a date an owner reads at a glance, not an ISO string. */
function niceDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}
