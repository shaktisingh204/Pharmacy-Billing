import { Link } from 'react-router-dom'
import { FileText, Pill, ScanBarcode, Truck, UserPlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Kbd } from '@/components/ui/Kbd'

interface Action {
  label: string
  hint: string
  icon: LucideIcon
  to: string
  shortcut?: string
  primary?: boolean
}

const ACTIONS: Action[] = [
  { label: 'New sale', hint: 'Scan or search', icon: ScanBarcode, to: '/billing', shortcut: 'F2', primary: true },
  { label: 'Add customer', hint: 'Open an account', icon: UserPlus, to: '/customers' },
  { label: 'Add medicine', hint: 'Item master', icon: Pill, to: '/medicines' },
  { label: 'New purchase', hint: 'Book a GRN', icon: Truck, to: '/purchases' },
  { label: 'Reports', hint: 'Day book, GST', icon: FileText, to: '/reports' },
]

/** Real links, so a counter can middle-click one onto a second screen. */
export function QuickActions() {
  return (
    <div className="grid grid-cols-2 gap-[var(--card-gap)] sm:grid-cols-3 lg:grid-cols-5">
      {ACTIONS.map((a) => (
        <Link
          key={a.label}
          to={a.to}
          className="card card-link flex items-center gap-3 p-[var(--card-px)] no-underline"
        >
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-lg)]"
            style={{
              backgroundColor: a.primary ? 'var(--accent-3)' : 'var(--bg-subtle)',
              color: a.primary ? 'var(--accent-11)' : 'var(--fg-muted)',
            }}
          >
            <a.icon size={19} aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-base font-medium text-fg">
              <span className="truncate">{a.label}</span>
              {a.shortcut ? <Kbd>{a.shortcut}</Kbd> : null}
            </span>
            <span className="block truncate text-2xs text-fg-subtle">{a.hint}</span>
          </span>
        </Link>
      ))}
    </div>
  )
}
