import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Shortcut hint. Every keyboard affordance in the app is discoverable on screen. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'mono inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-sm)]',
        'border border-border-subtle bg-subtle px-1.5 text-2xs font-medium text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
