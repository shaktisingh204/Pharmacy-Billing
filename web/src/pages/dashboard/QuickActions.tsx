import { useNavigate } from 'react-router-dom'
import { FileText, Pill, ScanBarcode, Truck, UserPlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Kbd } from '@/components/ui/Kbd'

interface Action {
  label: string
  icon: LucideIcon
  to: string
  shortcut?: string
  primary?: boolean
}

const ACTIONS: Action[] = [
  { label: 'New sale', icon: ScanBarcode, to: '/billing', shortcut: 'F2', primary: true },
  { label: 'Add customer', icon: UserPlus, to: '/customers' },
  { label: 'Add medicine', icon: Pill, to: '/medicines' },
  { label: 'New purchase', icon: Truck, to: '/purchases' },
  { label: 'Reports', icon: FileText, to: '/reports' },
]

export function QuickActions() {
  const navigate = useNavigate()
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={() => navigate(a.to)}
          className="card flex flex-col items-center justify-center gap-2 px-3 py-4 transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:bg-hover"
        >
          <span
            className="flex size-9 items-center justify-center rounded-full"
            style={{
              backgroundColor: a.primary ? 'var(--accent-3)' : 'var(--bg-subtle)',
              color: a.primary ? 'var(--accent-11)' : 'var(--fg-muted)',
            }}
          >
            <a.icon size={18} aria-hidden />
          </span>
          <span className="flex items-center gap-1.5 text-base font-medium">
            {a.label}
            {a.shortcut ? <Kbd>{a.shortcut}</Kbd> : null}
          </span>
        </button>
      ))}
    </div>
  )
}
