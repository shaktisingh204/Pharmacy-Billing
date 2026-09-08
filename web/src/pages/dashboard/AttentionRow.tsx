import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, Ban, CalendarClock, CircleSlash, NotebookPen, Pause,
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
  { key: 'shortbook', label: 'Short book', icon: NotebookPen, tone: 'var(--info-9)', to: '/purchases' },
]

export function AttentionRow({ counts }: { counts: AttentionCounts }) {
  const navigate = useNavigate()
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {ITEMS.map((item) => {
        const n = counts[item.key]
        const quiet = n === 0
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => navigate(item.to)}
            className="flex items-center gap-2.5 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hover"
            style={{
              borderColor: quiet ? 'var(--border-subtle)' : `color-mix(in srgb, ${item.tone} 35%, transparent)`,
              backgroundColor: quiet ? 'transparent' : `color-mix(in srgb, ${item.tone} 8%, transparent)`,
            }}
          >
            <item.icon
              size={16}
              aria-hidden
              className="shrink-0"
              style={{ color: quiet ? 'var(--fg-subtle)' : item.tone }}
            />
            <span className="min-w-0">
              <span
                className="block text-base font-semibold leading-tight tabular-nums-off"
                style={{ color: quiet ? 'var(--fg-subtle)' : item.tone }}
              >
                {n}
              </span>
              <span className="block truncate text-2xs text-fg-muted">{item.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
