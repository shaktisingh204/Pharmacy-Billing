import type { ReactNode } from 'react'
import { CloudOff, Lock, RefreshCw, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { cn } from '@/lib/cn'

/**
 * The five mandatory states. Every data surface in the app renders all five, and
 * a Playwright sweep asserts it. They are components, not ad-hoc markup, so that
 * "loading" never degrades into a centred spinner.
 */

/** Skeleton rows at the REAL row height, so nothing shifts when data lands. */
export function SkeletonRows({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-testid="state-skeleton">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-border-subtle px-[var(--cell-px)]"
          style={{ height: 'var(--row-h)' }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <div
              key={c}
              className="h-2.5 animate-pulse rounded-[var(--radius-full)] bg-inset"
              style={{ width: c === 0 ? '28%' : `${10 + ((r + c) % 4) * 4}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function Shell({
  icon: Icon,
  tone,
  title,
  body,
  children,
  testid,
}: {
  icon: LucideIcon
  tone?: string
  title: ReactNode
  body?: ReactNode
  children?: ReactNode
  testid: string
}) {
  return (
    <div
      data-testid={testid}
      className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-12 text-center"
    >
      <Icon size={40} strokeWidth={1.5} style={{ color: tone ?? 'var(--fg-subtle)' }} aria-hidden />
      <div className="text-lg font-semibold text-fg">{title}</div>
      {body ? <div className="max-w-[46ch] text-base text-fg-muted">{body}</div> : null}
      {children ? <div className="mt-1 flex items-center gap-2">{children}</div> : null}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  shortcut,
}: {
  icon: LucideIcon
  title: ReactNode
  body?: ReactNode
  actionLabel?: string
  onAction?: () => void
  shortcut?: string
}) {
  return (
    <Shell icon={icon} title={title} body={body} testid="state-empty">
      {actionLabel ? (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
          {shortcut ? <Kbd className="border-white/25 bg-white/15 text-white">{shortcut}</Kbd> : null}
        </Button>
      ) : null}
    </Shell>
  )
}

/** Always shows the machine-readable error code — it is what a support call needs. */
export function ErrorState({
  code,
  message,
  onRetry,
}: {
  code?: string
  message?: string
  onRetry?: () => void
}) {
  return (
    <div
      data-testid="state-error"
      role="alert"
      className={cn(
        'm-4 flex flex-col items-center gap-3 rounded-[var(--radius-lg)] px-6 py-10 text-center',
        'border border-danger-9/25 bg-danger-3',
      )}
    >
      <TriangleAlert size={32} strokeWidth={1.75} className="text-danger-9" aria-hidden />
      <div className="text-lg font-semibold text-danger-11">Something went wrong</div>
      <div className="max-w-[52ch] text-base text-danger-11/85">
        {message ?? 'The request could not be completed.'}
      </div>
      {code ? <code className="mono text-xs text-danger-11/70">{code}</code> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      ) : null}
    </div>
  )
}

export function OfflineState({ queued }: { queued?: number }) {
  return (
    <Shell
      icon={CloudOff}
      tone="var(--warning-9)"
      title="Working offline"
      body={
        queued
          ? `Billing continues. ${queued} document${queued === 1 ? '' : 's'} will sync when the connection returns.`
          : 'Billing continues against this terminal. This view needs the store server.'
      }
      testid="state-offline"
    />
  )
}

export function PermissionDenied({ needs }: { needs?: string }) {
  return (
    <Shell
      icon={Lock}
      title="You do not have access to this"
      body={
        needs
          ? `This screen requires the ${needs} permission. Ask a manager to grant it.`
          : 'Ask a manager to grant access to this screen.'
      }
      testid="state-permission-denied"
    />
  )
}
