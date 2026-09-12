import { barsOf, encodeEan } from '@/lib/ean'
import { cn } from '@/lib/cn'

/**
 * A picture of a barcode, for comparing the master against the pack in hand.
 *
 * Not for scanning off the screen — a phone camera reading a monitor is not a
 * supported path and printed labels go through the print module, which knows
 * about module widths and printer DPI. What this answers is "is the code on
 * file the code on this strip", which is otherwise thirteen digits compared by
 * eye.
 *
 * A code that is not a drawable EAN — a shop's own internal number, a case
 * code — renders as digits rather than as a symbol that would not scan. Drawing
 * something plausible for an unknown symbology is how a wrong label gets
 * printed and trusted.
 */

const MODULE_W = 2
const QUIET = 8

/** Guard bars run past the digits. The ranges are fixed by the symbology. */
const GUARDS: Record<'EAN-13' | 'EAN-8', ReadonlyArray<readonly [number, number]>> = {
  'EAN-13': [[0, 2], [45, 49], [92, 94]],
  'EAN-8': [[0, 2], [31, 35], [64, 66]],
}

export function Barcode({
  code,
  height = 40,
  className,
}: {
  code: string
  height?: number
  className?: string
}) {
  const symbol = encodeEan(code)

  if (symbol === null) {
    return (
      <div
        className={cn(
          'flex items-center rounded-[var(--radius-sm)] bg-inset px-2 py-1.5',
          className,
        )}
      >
        <span className="mono truncate text-sm tracking-[0.08em] text-fg">{code}</span>
      </div>
    )
  }

  const guards = GUARDS[symbol.kind]
  const isGuard = (x: number): boolean => guards.some(([lo, hi]) => x >= lo && x <= hi)
  const width = symbol.modules.length * MODULE_W + QUIET * 2
  const textY = height + 11

  return (
    <svg
      width={width}
      height={textY + 3}
      role="img"
      aria-label={`${symbol.kind} barcode ${code}`}
      className={cn('block', className)}
    >
      <rect width={width} height={textY + 3} fill="var(--bg-surface)" />
      {barsOf(symbol.modules).map((bar) => (
        <rect
          key={bar.x}
          x={QUIET + bar.x * MODULE_W}
          y={0}
          width={bar.width * MODULE_W}
          // Guards run down past the baseline of the digits, which is what makes
          // the number read as three groups rather than as one long string.
          height={isGuard(bar.x) ? height + 6 : height}
          fill="var(--fg)"
        />
      ))}
      {symbol.groups.map((group, i) => (
        <text
          key={group + String(i)}
          // The leading digit of an EAN-13 sits OUTSIDE the bars, in the left
          // quiet zone; the other groups are centred under their half.
          x={i === 0 && symbol.kind === 'EAN-13' ? 0 : groupCentre(symbol.kind, i)}
          y={textY}
          textAnchor={i === 0 && symbol.kind === 'EAN-13' ? 'start' : 'middle'}
          className="mono"
          fontSize={11}
          fill="var(--fg)"
        >
          {group}
        </text>
      ))}
    </svg>
  )
}

/** Centre of the module span each printed group sits under. */
function groupCentre(kind: 'EAN-13' | 'EAN-8', index: number): number {
  const span: readonly [number, number] =
    kind === 'EAN-13'
      ? (index === 1 ? [3, 44] : [50, 91])
      : (index === 0 ? [3, 30] : [36, 63])
  return QUIET + ((span[0] + span[1] + 1) / 2) * MODULE_W
}
