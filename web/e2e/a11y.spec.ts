import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

/**
 * Every route, checked against WCAG by a machine.
 *
 * This exists because the failures it catches are exactly the ones a sighted
 * developer cannot see: a control whose only name is an icon, a form field whose
 * label is a `<div>` beside it, a status told in colour alone, a heading level
 * skipped so a screen-reader user cannot navigate the page at all. Every one of
 * them looks perfect on screen.
 *
 * WHAT IT CANNOT DO, stated so nobody reads a green run as more than it is: axe
 * finds roughly a third of real accessibility defects. It cannot tell whether a
 * label makes sense, whether the focus order matches the visual order, or
 * whether a keyboard user can actually finish a sale — which is why the billing
 * suite is keyboard-only and fails if a `page.click()` is needed. This is the
 * floor, not the ceiling.
 *
 * SCOPE. `wcag2a`, `wcag2aa` and `wcag21aa` — the level this product commits to.
 * `best-practice` rules are deliberately excluded: they are opinions, several
 * contradict a dense POS layout, and a suite that cries wolf gets muted.
 */

/** Every destination in the sidebar, plus the two surfaces outside the shell. */
const ROUTES = [
  { path: '/', name: 'Dashboard' },
  { path: '/billing', name: 'Billing' },
  { path: '/sales', name: 'Sales' },
  { path: '/purchases', name: 'Purchases' },
  { path: '/medicines', name: 'Medicines' },
  { path: '/inventory', name: 'Inventory' },
  { path: '/customers', name: 'Customers' },
  { path: '/suppliers', name: 'Suppliers' },
  { path: '/reports', name: 'Reports' },
  { path: '/users', name: 'Users & Roles' },
  { path: '/settings', name: 'Settings' },
  { path: '/display', name: 'Customer display' },
  { path: '/m', name: "Owner's phone" },
] as const

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa']

/** Every violation, as something a person can act on rather than a rule id. */
function describe(results: Awaited<ReturnType<AxeBuilder['analyze']>>): string {
  return results.violations
    .map((v) => {
      /* The node's own failure summary, not just its selector. For a contrast
         failure that is the measured ratio and the two colours — which is the
         difference between "fix the contrast somewhere" and a token to change. */
      const where = v.nodes.slice(0, 3).map((n) => {
        const why = (n.failureSummary ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
        return `${n.target.join(' ')}\n        ${why}`
      }).join('\n      ')
      return `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n    ${v.nodes.length} element(s):\n      ${where}`
    })
    .join('\n')
}

test.describe('accessibility', () => {
  for (const route of ROUTES) {
    test(`${route.name} has no WCAG violations`, async ({ page }) => {
      await page.goto(route.path)

      /* Waited for by CONTENT, not by a timer. Every context re-seeds the demo
         database before the first paint, and scanning a skeleton would pass by
         checking nothing. */
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 })

      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(results.violations, `${route.name}:\n${describe(results)}`).toEqual([])
    })
  }
})
