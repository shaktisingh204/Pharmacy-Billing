import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as Popover from '@radix-ui/react-popover'
import { Bell, CircleCheck, ChevronRight, TriangleAlert } from 'lucide-react'
import type { AttentionAlert } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { formatAmount } from '@/lib/format'
import { SkeletonRows } from '@/components/states'

/**
 * The bell.
 *
 * It was a `<button>` with no `onClick` — a control that did nothing, with a
 * comment above it noting that a permanently lit indicator is the fastest way to
 * teach staff to stop reading indicators. The comment was right and the button
 * was empty, which is the same lesson taught a different way.
 *
 * What it shows now are six facts that already exist on six different screens:
 * expired stock, near-expiry, empty lines the shop stocks, customers over their
 * limit, unsettled expiry claims, orders past their date, and a day that took
 * money and was never closed. Nobody visits six screens daily. Every row links
 * to the one that fixes it, already filtered.
 *
 * The badge counts only what is a problem TODAY. Near-expiry is this week's
 * work and deliberately does not light it.
 */
export function AttentionBell() {
  const api = useApi()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const alerts = useQuery({
    queryKey: ['attention'],
    queryFn: () => api.attention(),
    /* A minute is fresh enough for a list about this week, and it means opening
       the popover twice in a row does not re-walk every batch in the shop. */
    staleTime: 60_000,
  })

  const items = alerts.data ?? []
  const urgent = items.filter((i) => i.severity === 'now').length

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={
            items.length === 0
              ? 'Notifications — nothing needs attention'
              : `Notifications — ${items.length} need attention, ${urgent} today`
          }
          className={cn(
            'relative grid size-8 place-items-center rounded-[var(--radius-md)] text-fg-muted',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
            'hover:bg-hover hover:text-fg',
          )}
        >
          <Bell size={16} aria-hidden />
          {items.length > 0 ? (
            /* Red only for a problem TODAY. A dot that is amber all week for
               near-expiry stock is the wallpaper this is written to avoid. */
            <span
              aria-hidden
              className={cn(
                'absolute right-1 top-1 grid min-w-[14px] place-items-center rounded-full px-1',
                'text-[9px] font-semibold leading-[14px] text-white',
                urgent > 0 ? 'bg-danger-9' : 'bg-warning-9',
              )}
            >
              {items.length}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[min(380px,92vw)] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle px-3 py-2">
            <h2 className="text-sm font-semibold text-fg">Needs attention</h2>
            <p className="text-2xs text-fg-muted">
              {items.length === 0
                ? 'Nothing today.'
                : `${urgent} to deal with today, ${items.length - urgent} this week.`}
            </p>
          </div>

          <div className="max-h-[60vh] overflow-auto">
            {alerts.isPending ? (
              <div className="p-3"><SkeletonRows rows={3} cols={1} /></div>
            ) : items.length === 0 ? (
              <p className="flex items-start gap-2 px-3 py-4 text-2xs text-fg-muted">
                <CircleCheck size={14} className="mt-px shrink-0 text-success-11" aria-hidden />
                Nothing is expired, nothing you stock is empty, every claim has been answered and
                the day is closed. This list is meant to be empty most of the time.
              </p>
            ) : (
              <ul aria-label="Things needing attention">
                {items.map((item) => (
                  <AlertRow
                    key={item.kind}
                    item={item}
                    onGo={() => { setOpen(false); void navigate(item.href) }}
                  />
                ))}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function AlertRow({ item, onGo }: { item: AttentionAlert; onGo: () => void }) {
  const now = item.severity === 'now'
  return (
    <li>
      <button
        type="button"
        onClick={onGo}
        className="flex w-full items-start gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-0 hover:bg-hover"
      >
        <span
          aria-hidden
          className={cn('mt-1 size-1.5 shrink-0 rounded-full', now ? 'bg-danger-9' : 'bg-warning-9')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className={cn('min-w-0 flex-1 text-sm font-medium', now ? 'text-danger-11' : 'text-fg')}>
              {item.title}
            </span>
            {item.amount ? (
              <span className="num shrink-0 text-2xs text-fg-muted">
                ₹{formatAmount(item.amount)}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-2xs leading-snug text-fg-muted">{item.detail}</span>
          {/* The severity in words as well as colour — this is read at an angle
              on a matte counter panel, where a tint alone does not survive. */}
          {now ? (
            <span className="mt-0.5 flex items-center gap-1 text-2xs font-medium text-danger-11">
              <TriangleAlert size={11} aria-hidden /> Today
            </span>
          ) : null}
        </span>
        <ChevronRight size={14} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
      </button>
    </li>
  )
}
