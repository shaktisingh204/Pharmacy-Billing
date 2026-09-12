import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A scrollable list of things nobody can click.
 *
 * A `overflow: auto` box whose contents are plain text has NO keyboard access at
 * all: a mouse user scrolls it, and a keyboard user simply cannot reach the rows
 * below the fold. There is nothing to Tab to, so Tab skips the whole panel and
 * the content underneath might as well not be rendered. An axe sweep found four
 * of these on the dashboard alone — near-expiry batches, low stock, top sellers,
 * recent activity — which between them are most of what the page is for.
 *
 * The fix is one tab stop and a name, so the region can be focused and then
 * scrolled with the arrow keys like any other document region.
 *
 * USE IT ONLY WHERE THE CONTENT IS INERT. A scroll area full of links, buttons
 * or grid rows is already reachable — the focusable children are the keyboard
 * access — and wrapping one in this would add a tab stop before every table in
 * a product whose whole billing flow is Tab-driven. `role="group"` rather than
 * `region` for the same reason: a card body is not a landmark, and a dashboard
 * with eight landmarks is a screen-reader rotor nobody can use.
 */
export function ScrollList({
  label, className, children,
}: {
  /** What the list is, announced when it takes focus. */
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      className={cn('scroll-region', className)}
    >
      {children}
    </div>
  )
}
