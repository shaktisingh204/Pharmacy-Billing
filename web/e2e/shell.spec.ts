import { expect, test } from '@playwright/test'

/* Billing, Dashboard, Medicines and Settings are deliberately absent: none is a
   stub any more. Their suites are e2e/billing*.spec.ts, dashboard.spec.ts,
   medicines.spec.ts and settings.spec.ts. */
/*
 * Every one of the eleven destinations is now a real page, so there is nothing
 * left to assert as a placeholder. What replaces this is stronger: e2e/pages.spec.ts
 * sweeps every route for one <h1>, no console errors, a non-scrolling document and
 * a visible focus ring, and each page has its own behavioural suite.
 *
 * The PhaseStub component stays — it is what a NEW screen scaffolds against.
 */

test.describe('app shell', () => {
  test('Medicines is the real item master, not a stub', async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('heading', { level: 1, name: 'Medicines' })).toBeVisible()
    await expect(page.getByText(/Full fidelity in Phase/)).toHaveCount(0)
  })

  test('Dashboard is the real dashboard, not a stub', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible()
    await expect(page.getByText(/Full fidelity in Phase/)).toHaveCount(0)
  })

  test('Billing is the real POS, not a stub', async ({ page }) => {
    await page.goto('/billing')
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeVisible()
    // An empty cart DOES show an empty state — "Scan or search to start billing".
    // What must be gone is the Phase-0 placeholder.
    await expect(page.getByText(/Full fidelity in Phase/)).toHaveCount(0)
    await expect(page.getByText(/is scaffolded/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Pay/ })).toBeVisible()
  })

  test('the page body never scrolls; only regions do', async ({ page }) => {
    await page.goto('/_design')
    const bodyOverflow = await page.evaluate(() =>
      getComputedStyle(document.body).overflow,
    )
    expect(bodyOverflow).toBe('hidden')
  })

  test('tailwind actually emits styles', async ({ page }) => {
    // The scaffold installed Tailwind but never imported it, so every utility
    // class was silently a no-op. Assert a utility resolves to a real value.
    await page.goto('/')
    const bg = await page.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'bg-accent-9'
      document.body.appendChild(el)
      const v = getComputedStyle(el).backgroundColor
      el.remove()
      return v
    })
    expect(bg).toBe('rgb(13, 148, 136)')
  })
})

test.describe('design system', () => {
  test('density applies to a SUBTREE, not just :root', async ({ page }) => {
    // Regression: density.css originally scoped these to :root[data-density],
    // so all three densities rendered identically and nothing errored. The app
    // runs comfortable while its grids run compact and /billing runs pos, so
    // subtree scoping is load-bearing.
    await page.goto('/_design')
    // The app seeds IndexedDB before first render, so the DOM is not present the
    // instant navigation resolves.
    await page.waitForSelector('[data-density="compact"]')
    const read = (d: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(`[data-density="${sel}"]`)
        if (!el) throw new Error(`no [data-density="${sel}"]`)
        const s = getComputedStyle(el)
        return {
          row: s.getPropertyValue('--row-h').trim(),
          font: s.getPropertyValue('--font-body').trim(),
        }
      }, d)

    expect(await read('comfortable')).toEqual({ row: '44px', font: '14px' })
    expect(await read('compact')).toEqual({ row: '36px', font: '13px' })
    // POS is LARGER than compact, deliberately.
    expect(await read('pos')).toEqual({ row: '44px', font: '15px' })
  })

  test('the focus ring is never suppressed on interactive controls', async ({ page }) => {
    await page.goto('/_design')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const outline = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      return getComputedStyle(el).outlineWidth
    })
    expect(outline).not.toBe('0px')
  })
})
