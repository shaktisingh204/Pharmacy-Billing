import { useSyncExternalStore } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Bell, ChevronsUpDown, CircleUser, Clock, LifeBuoy, Search, Store, Wifi, WifiOff,
} from 'lucide-react'
import { NAV_GROUPS } from '@/lib/nav'
import type { NavItem } from '@/lib/nav'
import { Kbd } from '@/components/ui/Kbd'
import { cn } from '@/lib/cn'

/**
 * Below 1280px the 232px sidebar costs the working pane more width than the
 * labels earn: a 1366x768 counter panel is the floor this app is designed for.
 */
const WIDE_QUERY = '(min-width: 1280px)'

const STORE = { name: 'Sanjeevani Medical Store', branch: 'MG Road' } as const
const OPERATOR = { name: 'Akib Ahamed', initials: 'AA', role: 'Owner' } as const

function subscribeWide(onChange: () => void) {
  const mql = window.matchMedia(WIDE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * Fixed shell. The page body never scrolls — only designated regions do, which
 * here is the nav list alone: brand and user card stay pinned.
 */
export function AppShell() {
  const { pathname } = useLocation()
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches)
  // The POS owns its width, so /billing collapses the sidebar at any viewport.
  const collapsed = pathname.startsWith('/billing') || !wide

  return (
    <div className="flex h-full w-full overflow-hidden bg-app">
      <Sidebar collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-w-0 flex-1 overflow-hidden bg-app">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ sidebar */

function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border bg-surface',
        'transition-[width] duration-[var(--dur-base)] ease-[var(--ease)]',
      )}
      style={{ width: collapsed ? 'var(--rail-w)' : 'var(--sidebar-w)' }}
      data-collapsed={collapsed}
    >
      <Brand collapsed={collapsed} />

      <nav aria-label="Main" className="scroll-region min-h-0 flex-1 px-2 py-2">
        {NAV_GROUPS.map((group, i) => (
          <div key={group.label}>
            {collapsed ? (
              // Collapsed, a group label would be an unreadable stack of glyphs.
              // The grouping still has to survive, so it becomes a rule.
              i > 0 ? <div aria-hidden className="mx-auto my-2 h-px w-6 bg-border-subtle" /> : null
            ) : (
              <div className={cn('micro-label px-2.5 pb-1', i > 0 && 'pt-4')}>{group.label}</div>
            )}
            <ul aria-label={group.label} className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavItemLink item={item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border-subtle p-2">
        <button
          type="button"
          title={collapsed ? 'Help & Support' : undefined}
          className={cn(
            'flex h-[34px] w-full items-center rounded-[var(--radius-md)] text-base',
            'text-fg-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
            'hover:bg-hover hover:text-fg',
            collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
          )}
        >
          <LifeBuoy size={16} aria-hidden className="shrink-0" />
          {collapsed ? (
            <span className="sr-only">Help & Support</span>
          ) : (
            <span className="truncate">Help & Support</span>
          )}
        </button>

        <button
          type="button"
          aria-label={`${OPERATOR.name}, ${OPERATOR.role} — account menu`}
          title={collapsed ? `${OPERATOR.name} · ${OPERATOR.role}` : undefined}
          className={cn(
            'mt-1 flex w-full items-center rounded-[var(--radius-md)] p-1.5 text-start',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-hover',
            collapsed ? 'justify-center' : 'gap-2.5',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-[var(--radius-full)]',
              'bg-accent-3 text-2xs font-semibold text-accent-11',
            )}
          >
            {OPERATOR.initials}
          </span>
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-[18px] text-fg">
                  {OPERATOR.name}
                </span>
                <span className="block truncate text-2xs leading-[14px] text-fg-muted">
                  {OPERATOR.role}
                </span>
              </span>
              <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-fg-subtle" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center border-b border-border',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
      )}
      style={{ height: 'var(--topbar-h)' }}
    >
      <span
        aria-hidden
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-[var(--radius-md)]',
          'bg-accent-9 text-2xs font-semibold tracking-tight text-fg-on-accent',
        )}
      >
        Rx
      </span>
      {collapsed ? (
        <span className="sr-only">RxBill — Pharmacy POS</span>
      ) : (
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold leading-[18px] text-fg">
            RxBill
          </span>
          <span className="block truncate text-2xs leading-[14px] text-fg-subtle">
            Pharmacy POS
          </span>
        </span>
      )}
    </div>
  )
}

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex h-[34px] items-center rounded-[var(--radius-md)] text-base',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
          collapsed ? 'justify-center px-0' : 'gap-2.5 ps-2.5 pe-2',
          isActive
            ? 'bg-accent-3 font-medium text-accent-11'
            : 'text-fg-muted hover:bg-hover hover:text-fg',
          item.promoted && !isActive && 'text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* Active state is a bar PLUS a tint PLUS weight — never colour alone.
              The bar sits in the sidebar gutter so the pill's radius never clips it. */}
          {isActive ? (
            <span
              aria-hidden
              className="absolute inset-y-1 -start-2 w-[3px] rounded-e-[var(--radius-full)] bg-accent-9"
            />
          ) : null}
          <Icon size={16} strokeWidth={isActive ? 2.25 : 2} aria-hidden className="shrink-0" />
          {collapsed ? (
            <span className="sr-only">{item.label}</span>
          ) : (
            <span className="truncate">{item.label}</span>
          )}
          {!collapsed && item.badge !== undefined ? (
            <span
              className={cn(
                'num ms-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center',
                'rounded-[var(--radius-full)] px-1.5 text-2xs font-medium',
                isActive ? 'bg-accent-9 text-fg-on-accent' : 'bg-subtle text-fg-muted',
              )}
            >
              {item.badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  )
}

/* ------------------------------------------------------------------ top bar */

function TopBar() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)

  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
      style={{ height: 'var(--topbar-h)' }}
    >
      <div className="relative min-w-0 flex-1 md:max-w-[360px]">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          type="search"
          aria-label="Search medicines, customers and invoices"
          placeholder="Search medicines, customers, invoices…"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            'h-8 w-full rounded-[var(--radius-md)] border border-border bg-inset ps-8 pe-14',
            'text-sm text-fg placeholder:text-fg-subtle hover:border-border-strong focus:bg-surface',
          )}
        />
        <Kbd className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2">⌘K</Kbd>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* The store chip is ALWAYS visible so nobody bills into the wrong location. */}
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-subtle px-2.5 py-1">
          <Store size={14} className="text-accent-9" aria-hidden />
          <span className="text-sm font-medium text-fg">{STORE.name}</span>
          <span className="mono text-2xs text-fg-subtle">{STORE.branch}</span>
        </div>

        <span
          role="status"
          className={cn(
            'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-2xs font-medium',
            online ? 'bg-success-3 text-success-11' : 'bg-warning-3 text-warning-11',
          )}
        >
          {online ? <Wifi size={12} aria-hidden /> : <WifiOff size={12} aria-hidden />}
          {online ? 'Online' : 'Offline'}
        </span>

        <span className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-subtle px-2 py-1 text-2xs font-medium text-fg-muted">
          <Clock size={12} aria-hidden /> No open shift
        </span>

        <button
          type="button"
          aria-label="Notifications, unread"
          className={cn(
            'relative grid size-8 place-items-center rounded-[var(--radius-md)] text-fg-muted',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-hover hover:text-fg',
          )}
        >
          <Bell size={16} aria-hidden />
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 size-1.5 rounded-[var(--radius-full)] bg-danger-9 ring-2 ring-surface"
          />
        </button>

        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1 text-sm text-fg-muted',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] hover:bg-hover hover:text-fg',
          )}
        >
          <CircleUser size={16} aria-hidden />
          Counter 1
        </button>
      </div>
    </header>
  )
}
