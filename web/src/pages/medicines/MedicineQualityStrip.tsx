import { BadgeIndianRupee, Barcode, CircleCheck, MapPin, PackageMinus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MedicineGap, MedicineQuality } from '@contract'
import { cn } from '@/lib/cn'

/**
 * The four holes in the master, counted and clickable.
 *
 * Every one of these is cheap to fix on a slow afternoon and expensive on the
 * day it bites, and the day it bites is never on this screen: a blank HSN stops
 * a GSTR-1 upload weeks later, a missing code is typed by hand at the counter
 * for the life of the product, a zero reorder level makes an item invisible to
 * the purchase suggestion, and an unset rack is a customer waiting while
 * somebody walks the shelves.
 *
 * So they are stated as WORK, not as a warning: a count, and one click that
 * turns the count into the list of rows to fix. A banner that only says
 * "problems exist" is one people learn to look past.
 */

interface GapSpec {
  id: MedicineGap
  label: string
  icon: LucideIcon
  tone: string
  /** What it costs, said in one line. Shown as the control's title. */
  why: string
}

const GAPS: GapSpec[] = [
  {
    id: 'hsn',
    label: 'No HSN',
    icon: BadgeIndianRupee,
    tone: 'var(--danger-11)',
    why: 'GSTR-1 Table 12 is built from HSN. A blank one stops the return being filed.',
  },
  {
    id: 'barcode',
    label: 'No barcode',
    icon: Barcode,
    tone: 'var(--warning-11)',
    why: 'The counter types this name on every sale until a code is linked.',
  },
  {
    id: 'reorder',
    label: 'No reorder level',
    icon: PackageMinus,
    tone: 'var(--warning-11)',
    why: 'Nothing is ever at or below zero, so the purchase suggestion never proposes it.',
  },
  {
    id: 'rack',
    label: 'No rack',
    icon: MapPin,
    tone: 'var(--info-11)',
    why: 'Staff walk the shelves for it instead of reading where it is.',
  },
]

export function MedicineQualityStrip({
  quality,
  active,
  onPick,
}: {
  quality: MedicineQuality | null
  /** The gap the grid is currently filtered to, if any. */
  active: MedicineGap | ''
  onPick: (gap: MedicineGap | '') => void
}) {
  const counts: Record<MedicineGap, number> | null = quality === null ? null : {
    hsn: quality.hsn,
    barcode: quality.barcode,
    reorder: quality.reorder,
    rack: quality.rack,
    neverSold: quality.neverSold,
  }
  const outstanding = counts === null ? 0 : GAPS.reduce((n, g) => n + counts[g.id], 0)

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="micro-label mr-0.5">
        {counts !== null && outstanding === 0 ? 'Master' : 'Needs attention'}
      </span>

      {counts !== null && outstanding === 0 ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <CircleCheck size={15} className="text-success-9" aria-hidden />
          Every live item carries an HSN, a code, a reorder level and a rack.
        </span>
      ) : (
        GAPS.map((gap) => (
          <GapPill
            key={gap.id}
            spec={gap}
            count={counts?.[gap.id] ?? null}
            on={active === gap.id}
            onClick={() => onPick(active === gap.id ? '' : gap.id)}
          />
        ))
      )}
    </div>
  )
}

function GapPill({
  spec, count, on, onClick,
}: {
  spec: GapSpec
  count: number | null
  on: boolean
  onClick: () => void
}) {
  const clear = count === 0
  const Icon = clear ? CircleCheck : spec.icon
  return (
    <button
      type="button"
      aria-pressed={on}
      /* Nothing to open when the count is zero, and a control that filters to an
         empty grid is a control that lies about having found something. */
      disabled={clear}
      onClick={onClick}
      title={clear ? `${spec.label}: nothing outstanding` : spec.why}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-full)] border pl-2.5 pr-1.5',
        'text-sm transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
        on
          ? 'border-accent-6 bg-accent-3 font-medium text-accent-11'
          : clear
            ? 'border-transparent bg-transparent text-fg-subtle'
            : 'border-border bg-surface text-fg hover:border-border-strong hover:bg-hover',
      )}
    >
      <Icon
        size={14}
        aria-hidden
        style={on ? undefined : { color: clear ? 'var(--success-9)' : spec.tone }}
      />
      {spec.label}
      <span
        className={cn(
          'num min-w-[1.5rem] rounded-[var(--radius-full)] px-1.5 py-0.5 text-2xs font-semibold',
          on ? 'bg-white/70 text-accent-11' : clear ? 'text-fg-subtle' : 'bg-inset text-fg',
        )}
      >
        {count === null ? '—' : count.toLocaleString('en-IN')}
      </span>
    </button>
  )
}
