import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Page chrome. The header is fixed; only `children` scrolls. */
export function Screen({
  title,
  subtitle,
  actions,
  children,
  density,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  /** Grid-heavy screens default to compact. */
  density?: 'comfortable' | 'compact' | 'pos'
}) {
  return (
    <div className="flex h-full flex-col" data-density-scope={density}>
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 px-6">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-fg">{title}</h1>
          {subtitle ? <div className="truncate text-sm text-fg-muted">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn('scroll-region min-h-0 flex-1 px-6 pb-6')}>{children}</div>
    </div>
  )
}
