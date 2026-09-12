import { Link } from 'react-router-dom'
import {
  AlertTriangle, Ban, CalendarClock, CircleSlash, ClipboardList, NotebookPen, Pause,
  PackageX, Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AttentionCounts } from '@contract'

/**
 * Work queues, not decoration.
 *
 * Every tile is a count of things somebody has to act on, and clicking it goes to
 * the screen where you act. A dashboard alert that is not a link is a guilt trip.
 *
 * These carry STATUS colour, which is reserved and never reused as a chart series —
 * and each ships an icon AND a word, so the state never rides on colour alone.
 */
interface Item {
  key: keyof AttentionCounts
  label: string
  icon: LucideIcon
  tone: string
  to: string
}

const ITEMS: Item[] = [
  { key: 'lowStock', label: 'Low stock', icon: AlertTriangle, tone: 'var(--status-low-stock)', to: '/inventory' },
  { key: 'outOfStock', label: 'Out of stock', icon: CircleSlash, tone: 'var(--status-out-of-stock)', to: '/inventory' },
  { key: 'nearExpiry30', label: 'Near expiry · 30d', icon: CalendarClock, tone: 'var(--status-expiry-30)', to: '/inventory' },
  { key: 'expired', label: 'Expired', icon: Ban, tone: 'var(--status-expired)', to: '/inventory' },
  { key: 'heldBills', label: 'Held bills', icon: Pause, tone: 'var(--status-expiry-180)', to: '/billing' },
  { key: 'shortbook', label: 'Short book', icon: NotebookPen, tone: 'var(--info-11)', to: '/purchases' },
  /* From the same engine the notification bell uses. These three were behind the
     bell for several waves while an owner opening the dashboard could not see
     any of them — and the dashboard is the screen people actually look at. */
  { key: 'claimsUnsettled', label: 'Claims unpaid', icon: PackageX, tone: 'var(--warning-11)', to: '/purchases?tab=returns' },
  { key: 'ordersOverdue', label: 'Orders late', icon: ClipboardList, tone: 'var(--status-expiry-90)', to: '/purchases?tab=order' },
  { key: 'dayUnclosed', label: 'Day not closed', icon: Wallet, tone: 'var(--status-expired)', to: '/sales' },
]

export function AttentionRow({ counts }: { counts: AttentionCounts }) {
  return (
    <div className="grid grid-cols-2 gap-[var(--card-gap)] sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9">
      {ITEMS.map((item) => {
        const n = counts[item.key]
        const quiet = n === 0
        return (
          <Link
            key={item.key}
            to={item.to}
            className="card-link flex items-center gap-3 rounded-[var(--radius-lg)] border bg-surface px-3.5 py-3 text-left no-underline"
            style={{
              borderColor: quiet ? 'var(--border-subtle)' : `color-mix(in srgb, ${item.tone} 38%, transparent)`,
              backgroundColor: quiet ? 'var(--bg-surface)' : `color-mix(in srgb, ${item.tone} 7%, var(--bg-surface))`,
            }}
          >
            <item.icon
              size={18}
              aria-hidden
              className="shrink-0"
              style={{ color: quiet ? 'var(--fg-subtle)' : item.tone }}
            />
            <span className="min-w-0">
              <span
                className="block text-xl leading-none font-semibold tabular-nums-off"
                style={{ color: quiet ? 'var(--fg-subtle)' : item.tone }}
              >
                {n}
              </span>
              <span className="mt-1 block truncate text-2xs text-fg-muted">{item.label}</span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
