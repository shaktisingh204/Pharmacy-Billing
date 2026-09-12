import { expect, test } from '@playwright/test'

/**
 * A sweep every real page must survive.
 *
 * Each page has its own suite for behaviour; this one exists so that a page
 * cannot quietly regress into throwing, scrolling the document, or losing its
 * heading while its own suite keeps passing on a narrower assertion.
 */
/* All eleven destinations. Nothing is scaffolded any more. */
const REAL_PAGES = [
  ['/', 'Dashboard'],
  ['/billing', 'Billing'],
  ['/sales', 'Sales'],
  ['/purchases', 'Purchases'],
  ['/medicines', 'Medicines'],
  ['/inventory', 'Inventory'],
  ['/customers', 'Customers'],
  ['/suppliers', 'Suppliers'],
  ['/reports', 'Reports'],
  ['/users', 'Users & Roles'],
  ['/settings', 'Settings'],
] as const

for (const [path, name] of REAL_PAGES) {
  test.describe(`${name} (${path})`, () => {
    test('renders without console errors and with exactly one h1', async ({ page }) => {
      const errors: string[] = []
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`))

      await page.goto(path)
      await expect(page.locator('h1')).toHaveCount(1)
      await page.waitForTimeout(1200)
      expect(errors, `console errors on ${path}`).toEqual([])
    })

    test('the document never scrolls — only designated regions do', async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('h1')).toHaveCount(1)
      const overflow = await page.evaluate(() => ({
        bodyOverflow: getComputedStyle(document.body).overflow,
        horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }))
      expect(overflow.bodyOverflow).toBe('hidden')
      // A horizontally scrolling page at the 1366x768 POS floor is a layout bug,
      // not a preference — the operator cannot scroll a till sideways mid-bill.
      expect(overflow.horizontal, `${path} scrolls horizontally`).toBe(false)
    })

    test('the first tab stop is visible and keeps a focus ring', async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('h1')).toHaveCount(1)
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        const s = getComputedStyle(el)
        return { outline: s.outlineWidth, shadow: s.boxShadow }
      })
      expect(ring, `${path} has no reachable tab stop`).not.toBeNull()
      // base.css bans `outline: none`; dense cells swap it for an inset ring.
      const hasRing = ring!.outline !== '0px' || ring!.shadow !== 'none'
      expect(hasRing, `${path} first tab stop has no visible focus`).toBe(true)
    })
  })
}

test.describe('navigation', () => {
  test('no sidebar destination is a dead link', async ({ page }) => {
    /*
     * Deliberately NOT re-asserting each page's heading here — REAL_PAGES above
     * already does that once per page, in its own test. Eleven navigations inside
     * a single test just meant one slow load failed the whole thing under
     * parallel load, and told you nothing the per-page sweep had not.
     *
     * What this adds is the one thing the per-page sweep cannot see: a nav item
     * pointing at a route App.tsx never registered. That does not 404 — it falls
     * through to NotFound, which has a perfectly good <h1>.
     */
    await page.goto('/')
    const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link')
    await expect(links.first()).toBeVisible()

    const hrefs = (await links.evaluateAll((els) =>
      els.map((e) => e.getAttribute('href')).filter((h): h is string => Boolean(h)),
    ))
    expect(hrefs.length).toBeGreaterThanOrEqual(11)

    for (const href of hrefs) {
      await page.goto(href)
      await expect(
        page.getByRole('heading', { level: 1 }),
        `${href} fell through to NotFound`,
      ).not.toHaveText(/not found/i, { timeout: 15_000 })
    }
  })
})
