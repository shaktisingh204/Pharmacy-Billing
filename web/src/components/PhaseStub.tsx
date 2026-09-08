import { Card } from '@/components/ui/Card'
import { Chip } from '@/components/ui/Badge'
import { EmptyState } from '@/components/states'
import { Screen } from '@/components/Screen'
import { NAV } from '@/lib/nav'
import type { LucideIcon } from 'lucide-react'

/**
 * Every one of the eleven destinations is a REAL route from Phase 0 with a
 * designed empty state, so the app is never a dead link and "which screen is
 * thin right now" is always answerable.
 */
export function PhaseStub({ to, body }: { to: string; body: string }) {
  const item = NAV.find((n) => n.to === to)
  if (!item) throw new Error(`PhaseStub: no nav entry for ${to}`)
  const Icon: LucideIcon = item.icon

  return (
    <Screen
      title={item.label}
      subtitle={body}
      actions={<Chip tone="var(--accent-9)">Full fidelity in Phase {item.phase}</Chip>}
    >
      <Card className="flex h-full items-center justify-center">
        <EmptyState
          icon={Icon}
          title={`${item.label} is scaffolded`}
          body={`This route, its permissions and its empty state are real. The working screen lands in Phase ${item.phase}.`}
        />
      </Card>
    </Screen>
  )
}
