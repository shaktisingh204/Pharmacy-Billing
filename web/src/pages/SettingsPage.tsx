import { useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight, Building2, CircleCheck, DatabaseBackup, Palette, Printer, ReceiptIndianRupee,
  Store, Tag, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatQty } from '@/lib/format'
import {
  deviceFactsSnapshot, parseDeviceFacts, subscribeDeviceFacts,
} from './settings/deviceFacts'
import { openInSection, outstanding, readiness, readyCount } from './settings/readiness'
import type { ReadinessCheck, SectionKey } from './settings/readiness'
import { BrandingSettings } from './settings/BrandingSettings'
import { BranchSettings } from './settings/BranchSettings'
import { StoreSettings } from './settings/StoreSettings'
import { PricingSettings } from './settings/PricingSettings'
import { PrintingSettings } from './settings/PrintingSettings'
import { InvoiceSettings } from './settings/InvoiceSettings'
import { PaymentSettings } from './settings/PaymentSettings'
import { DataSettings } from './settings/DataSettings'

/**
 * Settings.
 *
 * The trap this screen exists to avoid is the one every settings screen falls
 * into: everything on it is optional, so nothing on it gets done, and the fields
 * that decide whether a bill is a LEGAL bill sit in the same grey rows as the
 * ones that decide whether the footer says thank you. Nobody finds out which was
 * which until an inspector asks, or a customer's UPI payment lands in nobody's
 * account.
 *
 * So the page answers one question before it offers anything to edit — what is
 * still missing, and where — and the section list carries that count through to
 * the panel that fixes it. Everything below the header is a form; the header is
 * the only part that is a report.
 *
 * A vertical section list rather than tabs: this list only grows, and tabs stop
 * being scannable somewhere around six.
 */

interface Section {
  key: SectionKey
  label: string
  icon: LucideIcon
  hint: string
}

const SECTIONS: Section[] = [
  { key: 'store', label: 'Pharmacy', icon: Store, hint: 'Name, address, GSTIN and drug licence' },
  { key: 'branches', label: 'Branches', icon: Building2, hint: 'Every shop in the chain and what each issues' },
  { key: 'branding', label: 'Branding', icon: Palette, hint: 'Product name, mark and accent colour' },
  { key: 'invoice', label: 'Invoice & GST', icon: ReceiptIndianRupee, hint: 'Number series, tax and round-off' },
  { key: 'pricing', label: 'Price list', icon: Tag, hint: "The chain's discount off MRP, pushed to every branch" },
  { key: 'printing', label: 'Printing', icon: Printer, hint: 'Thermal width, templates and calibration' },
  { key: 'payments', label: 'Payments', icon: Wallet, hint: 'Modes, UPI and credit limits' },
  { key: 'data', label: 'Data & backup', icon: DatabaseBackup, hint: 'Back up, restore and what is stored here' },
]

export default function SettingsPage() {
  const api = useApi()
  const [active, setActive] = useState<SectionKey>('store')

  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api.listStores() })

  /* Subscribed, not read once. The printer and the last backup live in
     localStorage, which nothing re-renders on — and the panels that change them
     are children of this header, so without a subscription a pharmacist takes a
     backup, watches the file download, and is still told they have never taken
     one. */
  const facts = useSyncExternalStore(subscribeDeviceFacts, deviceFactsSnapshot, deviceFactsSnapshot)

  const checks = useMemo<ReadinessCheck[]>(
    () => (store.data
      ? readiness({ store: store.data, ...parseDeviceFacts(facts), now: new Date() })
      : []),
    [store.data, facts],
  )

  const open = outstanding(checks)
  const ready = readyCount(checks)

  return (
    <div className="flex h-full flex-col">
      <header className="page-header shrink-0" style={{ paddingInline: 'var(--page-px)' }}>
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-3 pb-3.5 pt-4">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-semibold tracking-display text-fg">Settings</h1>
            <p className="mt-1 max-w-[92ch] text-base text-fg-muted">
              What prints on a bill, what the counter may do, and where this shop&apos;s data lives.
            </p>
          </div>

          {checks.length > 0 ? (
            <div className="flex shrink-0 items-start gap-10">
              <div>
                <span className="micro-label block">Ready to bill</span>
                <span className="mt-0.5 flex items-baseline gap-1">
                  <span
                    className={cn(
                      'display-num text-5xl',
                      open.length === 0 ? 'text-success-11' : 'text-fg',
                    )}
                  >
                    {ready}
                  </span>
                  <span className="display-num text-2xl text-fg-subtle">/{checks.length}</span>
                </span>
                <span className="mt-0.5 block text-xs text-fg-muted">
                  {open.length === 0
                    ? 'nothing outstanding'
                    : `${open.length} still to set up`}
                </span>
              </div>

              {stores.data && stores.data.length > 0 ? (
                <div className="hidden lg:block">
                  <span className="micro-label block">Branches</span>
                  <span className="display-num mt-0.5 block text-4xl text-fg">
                    {formatQty(stores.data.length)}
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-muted">
                    {store.data ? `billing for ${store.data.city}` : 'in this chain'}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* The outstanding work, as the way into the panel that fixes it. A list
            of problems with no route to the fix is a list people learn to scroll
            past. */}
        {open.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 pb-3.5" aria-label="Outstanding setup">
            <CircleCheck size={14} className="text-fg-subtle" aria-hidden />
            <span className="micro-label">Still to do</span>
            {open.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.detail}
                onClick={() => setActive(c.section)}
                className={cn(
                  'group inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-full)]',
                  'border border-warning-9/30 bg-warning-3 px-2.5 text-xs font-medium text-warning-11',
                  'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-warning-9/15',
                )}
              >
                {c.label}
                <ArrowRight size={12} aria-hidden className="opacity-60" />
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div
        className="flex min-h-0 flex-1"
        style={{ paddingInline: 'var(--page-px)', paddingTop: 'var(--card-gap)', gap: 'var(--card-gap)' }}
      >
        <nav
          aria-label="Settings sections"
          className="scroll-region w-[260px] shrink-0 pb-6"
        >
          <ul className="flex flex-col gap-1">
            {SECTIONS.map((s) => {
              const Icon = s.icon
              const on = s.key === active
              const todo = openInSection(checks, s.key)
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => setActive(s.key)}
                    className={cn(
                      'relative flex w-full items-start gap-3 rounded-[var(--radius-lg)] px-3 py-2.5 text-left',
                      'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                      on
                        ? 'bg-surface shadow-card ring-1 ring-border'
                        : 'hover:bg-hover',
                    )}
                  >
                    {on && (
                      <span
                        aria-hidden
                        className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-accent-9"
                      />
                    )}
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 grid size-7 shrink-0 place-items-center rounded-[var(--radius-md)]',
                        on ? 'bg-accent-10 text-fg-on-accent' : 'bg-inset text-fg-muted',
                      )}
                    >
                      <Icon size={15} strokeWidth={2} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-base', on ? 'font-semibold text-fg' : 'font-medium text-fg')}>
                        {s.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-[17px] text-fg-muted">
                        {s.hint}
                      </span>
                    </span>
                    {todo > 0 ? (
                      <span
                        className="num mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-warning-9 px-1.5 text-2xs font-semibold text-white"
                        aria-label={`${todo} still to set up`}
                      >
                        {todo}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="scroll-region min-h-0 flex-1 rounded-t-[var(--radius-xl)]">
          {active === 'store' && <StoreSettings />}
          {active === 'branches' && <BranchSettings />}
          {active === 'branding' && <BrandingSettings />}
          {active === 'invoice' && <InvoiceSettings />}
          {active === 'pricing' && <PricingSettings />}
          {active === 'printing' && <PrintingSettings />}
          {active === 'payments' && <PaymentSettings />}
          {active === 'data' && <DataSettings />}
        </div>
      </div>
    </div>
  )
}
