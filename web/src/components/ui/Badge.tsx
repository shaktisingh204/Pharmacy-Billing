import type { ReactNode } from 'react'
import {
  AlertTriangle, Ban, CalendarClock, CircleCheck, CircleSlash,
  PackageMinus, RotateCcwSquare, ShieldAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ExpiryBucket } from '@/lib/expiry'
import { EXPIRY_LABEL } from '@/lib/expiry'

/**
 * MEANING IS NEVER ENCODED IN COLOUR ALONE. Every chip carries an icon AND a
 * word: POS panels are matte, dim, and frequently viewed at an angle, and a
 * meaningful share of male pharmacists cannot separate the red/amber buckets.
 */
export function Chip({
  icon: Icon,
  children,
  tone,
  className,
}: {
  icon?: LucideIcon
  children: ReactNode
  /** A CSS colour value (token), used for both the text and a 12% tint. */
  tone?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-[var(--radius-sm)] px-1.5',
        'text-2xs font-medium whitespace-nowrap',
        !tone && 'bg-subtle text-fg-muted',
        className,
      )}
      style={
        tone
          ? { color: tone, backgroundColor: `color-mix(in srgb, ${tone} 12%, transparent)` }
          : undefined
      }
    >
      {Icon ? <Icon size={12} strokeWidth={2.25} aria-hidden /> : null}
      {children}
    </span>
  )
}

const EXPIRY_TONE: Record<ExpiryBucket, string> = {
  expired: 'var(--status-expired)',
  d30: 'var(--status-expiry-30)',
  d60: 'var(--status-expiry-60)',
  d90: 'var(--status-expiry-90)',
  d180: 'var(--status-expiry-180)',
  ok: 'var(--fg-muted)',
}

const EXPIRY_ICON: Record<ExpiryBucket, LucideIcon> = {
  expired: Ban,
  d30: AlertTriangle,
  d60: CalendarClock,
  d90: CalendarClock,
  /* Returnable is an OPPORTUNITY, not a danger — the icon says so too. */
  d180: RotateCcwSquare,
  ok: CircleCheck,
}

export function ExpiryChip({ bucket, label }: { bucket: ExpiryBucket; label?: string }) {
  return (
    <Chip icon={EXPIRY_ICON[bucket]} tone={EXPIRY_TONE[bucket]}>
      {label ?? EXPIRY_LABEL[bucket]}
    </Chip>
  )
}

export type ScheduleCode = 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'NRx'

const SCHEDULE_TONE: Record<ScheduleCode, string> = {
  OTC: 'var(--schedule-otc)',
  G: 'var(--schedule-otc)',
  H: 'var(--schedule-h)',
  H1: 'var(--schedule-h1)',
  X: 'var(--schedule-x)',
  NRx: 'var(--schedule-nrx)',
}

export function ScheduleChip({ code }: { code: ScheduleCode }) {
  if (code === 'OTC') return <Chip>OTC</Chip>
  return (
    <Chip icon={code === 'X' ? ShieldAlert : undefined} tone={SCHEDULE_TONE[code]}>
      {code}
    </Chip>
  )
}

export function StockChip({ qty, reorderLevel }: { qty: number; reorderLevel: number }) {
  if (qty <= 0) {
    return <Chip icon={CircleSlash} tone="var(--status-out-of-stock)">Out of stock</Chip>
  }
  if (qty <= reorderLevel) {
    return <Chip icon={PackageMinus} tone="var(--status-low-stock)">Low · {qty}</Chip>
  }
  return <Chip tone="var(--success-11)">{qty} in stock</Chip>
}
