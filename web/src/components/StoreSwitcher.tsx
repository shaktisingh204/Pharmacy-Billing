import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronsUpDown, Store } from 'lucide-react'
import type { StoreProfile } from '@contract'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'

/**
 * Which branch this till is billing for.
 *
 * The chip has been on every screen from the beginning, with a comment saying it
 * is visible everywhere "so nobody bills into the wrong location" — and until
 * now it named one hardcoded store and could not be changed. `storeId` was on
 * every transactional row from the first migration and NOTHING read it, so the
 * scoping the whole schema was shaped around was untested by construction.
 *
 * Switching is deliberately heavy: it throws away every warm cache, rebuilds the
 * search index from the new branch's stock, and invalidates every query. A
 * cheaper switch that left the index loaded would let the counter allocate the
 * shop next door's shelf — which is the exact failure the chip was put there to
 * prevent, arriving through the control meant to prevent it.
 *
 * The choice is remembered per browser profile, because a counter machine
 * belongs to one branch and re-picking it every morning is a step that will
 * eventually be got wrong.
 */
export function StoreSwitcher({ store }: { store: StoreProfile }) {
  const api = useApi()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: () => api.listStores(),
    enabled: open,
  })

  const switchTo = useMutation({
    mutationFn: (id: number) => api.switchStore(id),
    onSuccess: (next) => {
      setOpen(false)
      /* EVERYTHING. Not a targeted list: every screen's data is store-scoped,
         and a missed key shows one branch's figures under another's name — which
         looks exactly like a busy day rather than like a bug. */
      void qc.invalidateQueries()
      toast.success(`Now billing for ${next.name}`, {
        description: 'Stock, bills, purchases and the day close all belong to this branch.',
      })
    },
    onError: (e) => toast.error('Could not switch branch', { description: (e as Error).message }),
  })

  const list = stores.data ?? []
  const only = list.length <= 1 && !stores.isPending

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Billing for ${store.name}, ${store.city} — change branch`}
          className={cn(
            'flex items-center gap-2 rounded-[var(--radius-md)] bg-subtle px-2.5 py-1',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-inset',
          )}
        >
          <Store size={14} className="text-accent-9" aria-hidden />
          <span className="text-sm font-medium text-fg">{store.name}</span>
          <span className="text-2xs text-fg-subtle">{store.city}</span>
          <ChevronsUpDown size={12} className="text-fg-subtle" aria-hidden />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[min(320px,92vw)] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-[var(--shadow-overlay)]"
        >
          <div className="border-b border-border-subtle px-3 py-2">
            <h2 className="text-sm font-semibold text-fg">Branch</h2>
            <p className="text-2xs text-fg-muted">
              Stock, bills, purchases and the day close all belong to the branch you pick. The
              medicine and party masters are shared across the chain.
            </p>
          </div>

          <ul aria-label="Branches">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={switchTo.isPending}
                  onClick={() => { if (s.id !== store.id) switchTo.mutate(s.id) }}
                  aria-current={s.id === store.id ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-0',
                    s.id === store.id ? 'bg-accent-1' : 'hover:bg-hover',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{s.name}</span>
                    <span className="block truncate text-2xs text-fg-muted">
                      {s.city} · <span className="mono">{s.invoicePrefix}</span> series
                    </span>
                  </span>
                  {s.id === store.id ? (
                    <Check size={14} className="shrink-0 text-accent-11" aria-hidden />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          {only ? (
            <p className="border-t border-border-subtle px-3 py-2 text-2xs text-fg-subtle">
              This chain has one branch. Adding another is an HQ action.
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
