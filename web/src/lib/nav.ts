import {
  BarChart3, Boxes, Building2, LayoutDashboard, Pill, Receipt,
  ScanBarcode, Settings, ShieldCheck, Truck, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Phase at which this screen reaches full fidelity. Rendered in its placeholder. */
  phase: number
  /** Billing is pinned and visually promoted — it is the product. */
  promoted?: boolean
  end?: boolean
  /**
   * Optional count rendered as a chip on the inline end of the item. Left
   * undefined everywhere until a real, cheap-to-compute number exists: a badge
   * that is stale or always zero trains staff to stop reading badges.
   */
  badge?: number
}

export interface NavGroup {
  /** Rendered through .micro-label; replaced by a divider in the collapsed rail. */
  label: string
  items: NavItem[]
}

/**
 * Grouped by what the operator is DOING, not by data model. Eleven flat entries
 * force a linear scan every time; six labelled groups of one to three let the
 * eye jump straight to the band it wants.
 *
 * Every `to` is a route that exists in App.tsx. A nav item that 404s is worse
 * than an absent one, so nothing speculative belongs here.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, phase: 3, end: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/billing', label: 'Billing', icon: ScanBarcode, phase: 2, promoted: true },
      { to: '/sales', label: 'Sales', icon: Receipt, phase: 3 },
      { to: '/purchases', label: 'Purchases', icon: Truck, phase: 3 },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { to: '/medicines', label: 'Medicines', icon: Pill, phase: 3 },
      { to: '/inventory', label: 'Inventory', icon: Boxes, phase: 3 },
    ],
  },
  {
    label: 'Partners',
    items: [
      { to: '/customers', label: 'Customers', icon: Users, phase: 3 },
      { to: '/suppliers', label: 'Suppliers', icon: Building2, phase: 3 },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/reports', label: 'Reports', icon: BarChart3, phase: 3 },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/users', label: 'Users & Roles', icon: ShieldCheck, phase: 3 },
      { to: '/settings', label: 'Settings', icon: Settings, phase: 3 },
    ],
  },
]

/**
 * Flat view of the same entries. PhaseStub resolves a route's label, icon and
 * phase through this, so the groups above stay the single source of truth.
 */
export const NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)
