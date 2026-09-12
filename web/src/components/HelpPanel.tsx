import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity, CircleCheck, Copy, Keyboard, LifeBuoy, MonitorDown, RefreshCw, ShieldAlert,
  TriangleAlert, WifiOff, X,
} from 'lucide-react'
import { ApiError } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { useBrand } from '@/brand/useBrand'
import { useHotkeys } from '@/hooks/useHotkeys'
import {
  canInstall, isInstalled, onInstallabilityChange, promptInstall,
} from '@/brand/installable'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { SkeletonRows } from '@/components/states'

/**
 * Help & Support.
 *
 * Wired to a button that had no `onClick` at all — a control that did nothing,
 * which is worse than an absent one because it teaches the operator that
 * clicking things here has no effect.
 *
 * What a support call actually needs is not an article. It is: which shortcuts
 * exist, and is this shop's data sound? The second is invariant I17 — the
 * append-only ledger against the shelf — which the plan says should be a health
 * chip rather than a log line, because a reconciliation nobody sees is a
 * reconciliation nobody acts on.
 *
 * The diagnostics are COPYABLE in one action. The alternative is a shopkeeper
 * reading numbers down a phone, which is where support calls go wrong.
 */
export function HelpPanel({
  open, onOpenChange, onShortcuts,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onShortcuts: () => void
}) {
  const api = useApi()
  const brand = useBrand()
  const [copied, setCopied] = useState(false)
  const [installable, setInstallable] = useState(canInstall)
  useEffect(() => onInstallabilityChange(setInstallable), [])
  const installed = isInstalled()

  /* Only while the panel is open. Reconciling reads the WHOLE ledger — tens of
     thousands of rows on a real shop — and doing that on every app boot for a
     panel nobody opened would be paid by every till, every morning. */
  const health = useQuery({
    queryKey: ['stockHealth'],
    queryFn: () => api.checkStockHealth(),
    enabled: open,
    staleTime: 60_000,
  })

  // A dialog is exclusive: without this, F2 starts a new bill under the overlay.
  useHotkeys('modal', {}, { enabled: open })

  const copy = () => {
    const h = health.data
    const lines = [
      `${brand.productName} diagnostics`,
      `Generated: ${h?.generatedAt ?? '—'}`,
      `Batches checked: ${h?.batchesChecked ?? '—'}`,
      `Movements checked: ${h?.movementsChecked ?? '—'}`,
      `Ledger: ${h?.balanced ? 'balanced' : `${h?.discrepancies.length ?? 0} discrepancies`}`,
      `Value at risk: ${h?.valueAtRisk ?? '0.00'}`,
      `Orphaned ledger rows: ${h?.orphanedLedgers ?? 0}`,
      `Batches with no history: ${h?.batchesWithoutHistory ?? 0}`,
      ...(h?.discrepancies ?? []).map(
        (d) => `  ${d.kind}: ${d.brandName} batch ${d.batchNo} — ledger ${d.ledger}, shelf ${d.shelf}${d.refId ? ` at ${d.refId}` : ''}`,
      ),
      `User agent: ${navigator.userAgent}`,
    ]
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgb(16_24_40/.35)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-4 py-3">
            <LifeBuoy size={18} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-fg">Help &amp; Support</Dialog.Title>
              <Dialog.Description className="text-2xs text-fg-muted">
                Shortcuts, and whether this shop&rsquo;s stock records still agree with each other.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close help"
                className="rounded-[var(--radius-sm)] p-1 text-fg-subtle hover:bg-hover hover:text-fg"
              >
                <X size={15} aria-hidden />
              </button>
            </Dialog.Close>
          </header>

          <div className="scroll-region min-h-0 flex-1 overflow-auto p-4">
            <button
              type="button"
              onClick={() => { onOpenChange(false); onShortcuts() }}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-lg)] border border-border px-3 py-2.5 text-start hover:border-border-strong hover:bg-hover"
            >
              <Keyboard size={16} className="shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">Keyboard shortcuts</span>
                <span className="block text-2xs text-fg-muted">
                  Everything the counter can do without the mouse
                </span>
              </span>
              <Kbd>?</Kbd>
            </button>

            {/* Installing is what makes this a till rather than a tab: it boots
                with no network, keeps its own window, and carries the reseller's
                name and icon rather than the browser's. */}
            <div className="mt-2 flex items-center gap-2.5 rounded-[var(--radius-lg)] border border-border px-3 py-2.5">
              {installed ? (
                <CircleCheck size={16} className="shrink-0 text-success-11" aria-hidden />
              ) : (
                <MonitorDown size={16} className="shrink-0 text-fg-muted" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">
                  {installed ? `${brand.productName} is installed` : `Install ${brand.productName}`}
                </span>
                <span className="block text-2xs text-fg-muted">
                  {installed
                    ? 'It opens in its own window and starts without a network.'
                    : installable
                      ? 'Adds it to this machine so it opens in its own window and starts without a network.'
                      : 'Chrome or Edge on a desktop can install this. Renaming the product renames the app installed after that — one already installed keeps the name it was installed with.'}
                </span>
              </span>
              {!installed && installable ? (
                <Button
                  variant="primary"
                  onClick={() => { void promptInstall() }}
                >
                  <MonitorDown /> Install
                </Button>
              ) : null}
            </div>

            <p className="mt-2 flex items-start gap-1.5 text-2xs text-fg-subtle">
              <WifiOff size={12} className="mt-px shrink-0" aria-hidden />
              Bills are written to this machine, not to the internet. The counter keeps working
              through an outage; nothing is waiting on a network to take money.
            </p>

            <section className="mt-4">
              <div className="flex items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                  <Activity size={15} aria-hidden /> Data health
                </h3>
                <Button
                  variant="ghost"
                  onClick={() => void health.refetch()}
                  disabled={health.isFetching}
                >
                  <RefreshCw className={cn(health.isFetching && 'animate-spin')} /> Re-check
                </Button>
              </div>
              <p className="mt-0.5 text-2xs text-fg-muted">
                The stock ledger is append-only and is the audit record; the quantity on each batch
                is what the counter reads. They are kept separate so they can be compared — this is
                that comparison.
              </p>

              {health.isPending ? (
                <div className="mt-2"><SkeletonRows rows={3} cols={2} /></div>
              ) : health.error ? (
                <p className="mt-2 flex items-start gap-1.5 rounded-[var(--radius-md)] border border-danger-9/25 bg-danger-3 px-2.5 py-2 text-2xs text-danger-11">
                  <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden />
                  The check could not run:{' '}
                  {health.error instanceof ApiError
                    ? health.error.message
                    : (health.error as Error).message}
                </p>
              ) : health.data ? (
                <HealthBody data={health.data} />
              ) : null}
            </section>
          </div>

          <footer className="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-subtle px-4 py-2.5">
            <span className="text-2xs text-fg-subtle">
              {/* Copyable, because the alternative is a shopkeeper reading
                  numbers down a phone. */}
              Copy this before calling — it saves the questions.
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={copy} disabled={!health.data}>
                <Copy /> {copied ? 'Copied' : 'Copy diagnostics'}
              </Button>
              <Dialog.Close asChild><Button variant="ghost">Close</Button></Dialog.Close>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function HealthBody({ data }: { data: NonNullable<ReturnType<typeof useHealth>> }) {
  return (
    <>
      <div
        className={cn(
          'mt-2 flex items-start gap-2 rounded-[var(--radius-lg)] border px-3 py-2.5',
          data.balanced
            ? 'border-success-9/25 bg-success-3/50'
            : 'border-danger-9/30 bg-danger-3',
        )}
      >
        {data.balanced ? (
          <CircleCheck size={16} className="mt-px shrink-0 text-success-11" aria-hidden />
        ) : (
          <TriangleAlert size={16} className="mt-px shrink-0 text-danger-11" aria-hidden />
        )}
        <div className="min-w-0">
          <p className={cn('text-sm font-medium', data.balanced ? 'text-success-11' : 'text-danger-11')}>
            {data.summary}
          </p>
          {!data.balanced ? (
            <p className="mt-0.5 text-2xs text-fg-muted">
              <span className="num">₹{formatAmount(data.valueAtRisk)}</span> of stock is affected at
              landed cost.
            </p>
          ) : null}
        </div>
      </div>

      {data.batchesWithoutHistory > 0 || data.orphanedLedgers > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {data.batchesWithoutHistory > 0 ? (
            <li className="text-2xs text-fg-muted">
              <span className="num font-medium text-fg">{data.batchesWithoutHistory}</span> batch
              {data.batchesWithoutHistory === 1 ? '' : 'es'} hold stock with no movement behind it.
            </li>
          ) : null}
          {data.orphanedLedgers > 0 ? (
            <li className="text-2xs text-fg-muted">
              <span className="num font-medium text-fg">{data.orphanedLedgers}</span> batch
              {data.orphanedLedgers === 1 ? '' : 'es'} have a movement history but no batch row.
            </li>
          ) : null}
        </ul>
      ) : null}

      {data.discrepancies.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {data.discrepancies.map((d) => (
            <li
              key={`${d.batchId}-${d.kind}`}
              className="rounded-[var(--radius-md)] border border-border-subtle px-2.5 py-1.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-2xs text-fg">
                  {d.brandName} <span className="mono text-fg-subtle">{d.batchNo}</span>
                </span>
                {/* The KIND in words: a broken history and a drifted balance are
                    different problems and are investigated differently. */}
                <span className="shrink-0 text-2xs font-medium text-danger-11">
                  {d.kind === 'chain' ? 'history broken' : 'does not match'}
                </span>
              </div>
              <div className="num mt-0.5 text-2xs text-fg-muted">
                ledger {d.ledger} · shelf {d.shelf} · off by {d.difference}
                {d.refId ? <span className="mono"> · at {d.refId}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/* Type-only helper: gives HealthBody the adapter's own return type without
   re-declaring it, so a contract change is a compile error here rather than a
   quietly stale prop shape. */
declare function useHealth(): Awaited<ReturnType<ReturnType<typeof useApi>['checkStockHealth']>>
