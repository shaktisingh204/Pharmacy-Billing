import { useCallback, useState, useSyncExternalStore } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useBrand } from '@/brand/useBrand'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight, ChevronsUpDown, CircleUser, Clock, LifeBuoy, Search, Smartphone, Wifi, WifiOff,
} from 'lucide-react'
import { NAV_GROUPS } from '@/lib/nav'
import type { NavItem } from '@/lib/nav'
import { useApi } from '@/api'
import { qk } from '@/api/queryKeys'
import { Kbd } from '@/components/ui/Kbd'
import { formatCombo } from '@/lib/keys'
import { cn } from '@/lib/cn'
import { useHotkeys } from '@/hooks/useHotkeys'
import { HelpPanel } from '@/components/HelpPanel'
import { ShortcutHelp } from '@/components/ShortcutHelp'
import { AttentionBell } from '@/components/AttentionBell'
import { StoreSwitcher } from '@/components/StoreSwitcher'

/**
 * Below 1280px the 232px sidebar costs the working pane more width than the
 * labels earn: a 1366x768 counter panel is the floor this app is designed for.
 */
const WIDE_QUERY = '(min-width: 1280px)'

/**
 * Phone width.
 *
 * Not "narrow": a shrunken desktop window is somebody resizing, and bouncing
 * them somewhere else mid-task would be obnoxious. This is the width at which
 * the counter layouts genuinely stop working, and at which the owner's own
 * surface is the better answer.
 */
const PHONE_QUERY = '(max-width: 640px)'

/** The combo the cheat sheet advertises for the same action. Never a second spelling. */
const PALETTE_COMBO = formatCombo('ctrl+k')

const OPERATOR = { name: 'Akib Ahamed', initials: 'AA', role: 'Owner' } as const

function subscribeWide(onChange: () => void) {
  const mql = window.matchMedia(WIDE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function subscribePhone(onChange: () => void) {
  const mql = window.matchMedia(PHONE_QUERY)
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
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches)
  // The POS owns its width, so /billing collapses the sidebar at any viewport.
  const collapsed = pathname.startsWith('/billing') || !wide

  const [helpOpen, setHelpOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  /* Mounted in the SHELL, not in a screen.
     `help.open` is declared `scope: 'global'` in `lib/keys`, but the cheat sheet
     was only ever mounted inside the billing screen — so `?` did nothing on ten
     of the eleven pages while every one of them advertised it. Bound once here,
     it works everywhere the shortcut says it does. The billing screen keeps its
     own copy because it passes its own scope, and a second sheet cannot open
     over the first: a modal is exclusive. */
  useHotkeys('global', {
    'help.open': () => setShortcutsOpen(true),
  }, { enabled: !pathname.startsWith('/billing') })

  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])

  return (
    <div className="flex h-full w-full overflow-hidden bg-app">
      <Sidebar collapsed={collapsed} onHelp={() => setHelpOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* OFFERED, never forced.
            A redirect would break every deep link somebody taps out of a
            WhatsApp message, and an owner who genuinely wants the reports on
            their phone is allowed to have them — cramped, but theirs. So the
            shell points at the better surface and gets out of the way. */}
        {phone && (
          <Link
            to="/m"
            className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-accent-3 px-4 py-2 text-sm font-medium text-accent-11"
          >
            <Smartphone size={15} aria-hidden />
            <span className="min-w-0 flex-1">Reading on a phone? Open the owner view</span>
            <ChevronRight size={15} aria-hidden />
          </Link>
        )}
        <main className="min-w-0 flex-1 overflow-hidden bg-app">
          {/* Scoped to the routed screen: a screen that throws is replaced by an
              error state while the shell, the nav and billing stay usable.
              Keyed on the path so navigating away clears the error. */}
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <HelpPanel open={helpOpen} onOpenChange={setHelpOpen} onShortcuts={openShortcuts} />
      {/* Scope 'global': the shell has no screen scope of its own, and the sheet
          lists everything global plus whatever the active screen adds. */}
      <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} scope="global" />
    </div>
  )
}

/* ------------------------------------------------------------------ sidebar */

function Sidebar({ collapsed, onHelp }: { collapsed: boolean; onHelp: () => void }) {
  return (
    <div
      // Width is switched, never transitioned: animating it reflows the whole
      // working pane for the length of the transition, and the one moment it
      // fires is the entry into /billing.
      className="flex h-full shrink-0 flex-col border-r border-border bg-surface"
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
              i > 0 ? <div aria-hidden className="mx-auto my-2 h-px w-6 bg-border" /> : null
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
        {/* Was a <button> with no onClick — a control that did nothing, which
            is worse than an absent one because it teaches the operator that
            clicking here has no effect. */}
        <button
          type="button"
          onClick={onHelp}
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

        {/* Goes to Users & Roles, which is where this person's role, their
            discount and refund ceilings, and every override they have needed
            actually live. It was labelled "account menu" and opened nothing —
            and a menu that does not exist is a worse promise than a link. */}
        <NavLink
          to="/users"
          aria-label={`${OPERATOR.name}, ${OPERATOR.role} — open Users & Roles`}
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
        </NavLink>
      </div>
    </div>
  )
}

function Brand({ collapsed }: { collapsed: boolean }) {
  const brand = useBrand()
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
          'grid size-7 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-md)]',
          brand.logoUrl ? 'bg-surface' : 'bg-accent-10 text-2xs font-semibold tracking-tight text-fg-on-accent',
        )}
      >
        {/* A reseller supplies a mark or a logo, never a code change — the whole
            point of white-labelling is that nobody has to fork this file. */}
        {brand.logoUrl
          ? <img src={brand.logoUrl} alt="" className="size-full object-contain" />
          : brand.markText}
      </span>
      {collapsed ? (
        <span className="sr-only">
          {brand.productName}{brand.tagline ? ` — ${brand.tagline}` : ''}
        </span>
      ) : (
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold leading-[18px] text-fg">
            {brand.productName}
          </span>
          {brand.tagline ? (
            <span className="block truncate text-2xs leading-[14px] text-fg-subtle">
              {brand.tagline}
            </span>
          ) : null}
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
                isActive ? 'bg-accent-10 text-fg-on-accent' : 'bg-subtle text-fg-muted',
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
  const api = useApi()
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine)
  // The chip only guards against billing into the wrong location if it reads the
  // store that is actually being billed against. A literal here would keep
  // reassuring the operator after the profile changed under it.
  const { data: store } = useQuery({ queryKey: qk.store, queryFn: () => api.getStore() })

  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
      style={{ height: 'var(--topbar-h)' }}
    >
      <div className="relative min-w-0 flex-1 max-w-[360px]">
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
            'h-8 w-full rounded-[var(--radius-md)] border border-border bg-inset ps-8 pe-20',
            'text-sm text-fg placeholder:text-fg-subtle hover:border-border-strong focus:bg-surface',
          )}
        />
        {/* Ctrl, not ⌘: the target hardware is a Windows counter panel, and
            SHORTCUTS['palette.open'] is the one spelling of this combo. */}
        <span className="pointer-events-none absolute end-2 top-1/2 flex -translate-y-1/2 gap-1">
          {PALETTE_COMBO.map((part) => <Kbd key={part}>{part}</Kbd>)}
        </span>
      </div>

      <div className="ms-auto flex shrink-0 items-center gap-2">
        {/* Visible on every screen so nobody bills into the wrong location. Absent
            rather than guessed for the one frame before the profile resolves. */}
        {store ? <StoreSwitcher store={store} /> : null}

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

        <AttentionBell />

        {/* A SPAN, not a button. Which till this is, stated — the same kind of
            fact as the two chips beside it. It was a button with no onClick,
            and a control that does nothing teaches the operator that clicking
            here has no effect, which is a lesson that spreads. */}
        <span className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-subtle px-2 py-1 text-2xs font-medium text-fg-muted">
          <CircleUser size={12} aria-hidden /> Counter 1
        </span>
      </div>
    </header>
  )
}
