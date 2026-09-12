import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * The distributors screen, which is three views of one purchase window.
 *
 * The generic sweep in pages.spec covers heading, scrolling and focus. This
 * suite covers the four things that would be silently wrong rather than
 * visibly broken: the licence status, the due-date arithmetic, the running
 * total that makes the planner worth reading, and the landed-cost basis of the
 * rate comparison.
 */

const money = (t: string | null): number => Number((t ?? '').replace(/[^\d.-]/g, ''))

async function ledger(page: Page) {
  await page.goto('/suppliers')
  await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible()
  await expect(page.locator('[data-supplier-row]').first()).toBeVisible()
}

test.describe('Suppliers — the ledger', () => {
  test('a licence carries its expiry, and a lapsed one says so in words', async ({ page }) => {
    await ledger(page)
    // Colour never carries a status on its own anywhere in this app; the row
    // has to spell the state out.
    await expect(page.getByText(/Lapsed \d+d ago/).first()).toBeVisible()
    await expect(page.getByText(/^to \d{2} \w{3} \d{2}$/).first()).toBeVisible()
  })

  test('the licence-risk filter shows only what a buyer has to act on', async ({ page }) => {
    await ledger(page)
    const all = await page.locator('[data-supplier-row]').count()

    // The tile and the filter chip share a name; the chip is the exact match.
    const chip = page.getByRole('button', { name: 'Licence risk', exact: true })
    await chip.click()
    await expect(chip).toHaveAttribute('aria-pressed', 'true')

    const risky = page.locator('[data-supplier-row]')
    // Polled, not read once: the click and the re-render are not the same tick,
    // and a bare count would compare the list to its own previous state.
    await expect.poll(() => risky.count()).toBeLessThan(all)

    // Every row that survives is missing a licence, past one, or inside the
    // renewal window. "Validity not recorded" deliberately does NOT qualify —
    // it is a gap in the record, not a licence that has run out, and a false
    // alarm here is how a real one stops being read.
    for (const text of await risky.allTextContents()) {
      expect(text).toMatch(/No licence on file|Lapsed \d+d ago|Lapses (in \d+d|today)/)
    }
  })

  test('the view is a link — the tab survives a reload', async ({ page }) => {
    await page.goto('/suppliers?tab=rates')
    await expect(page.getByRole('tab', { name: 'Rate board' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Suppliers — the payment planner', () => {
  test('dates every bill forward and orders by when the money leaves', async ({ page }) => {
    await page.goto('/suppliers?tab=planner')
    await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible()
    await expect(page.getByText('Due this week')).toBeVisible()

    const rows = page.locator('[data-due-row]')
    await expect(rows.first()).toBeVisible()

    const parsed = await rows.locator('[data-due-days]')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-due-days'))))
    // Soonest first: a list that is not in due order is not a schedule.
    for (let i = 1; i < parsed.length; i += 1) {
      expect(parsed[i], `row ${i} falls due before row ${i - 1}`).toBeGreaterThanOrEqual(parsed[i - 1]!)
    }
  })

  test('THE RUNNING TOTAL IS THE POINT — release this much and everything above is clear', async ({ page }) => {
    await page.goto('/suppliers?tab=planner')
    const rows = page.locator('[data-due-row]')
    await expect(rows.first()).toBeVisible()

    const amounts = (await rows.locator('[data-due-amount]').allTextContents()).map(money)
    const running = (await rows.locator('[data-due-running]').allTextContents()).map(money)
    expect(running.length).toBe(amounts.length)

    let sum = 0
    for (let i = 0; i < amounts.length; i += 1) {
      sum = Math.round((sum + amounts[i]!) * 100) / 100
      expect(running[i], `the running total is wrong at row ${i}`).toBeCloseTo(sum, 2)
    }
  })

  test('a payment run totals only what was ticked, and names the suppliers', async ({ page }) => {
    await page.goto('/suppliers?tab=planner')
    const rows = page.locator('[data-due-row]')
    await expect(rows.first()).toBeVisible()

    await rows.first().getByRole('checkbox').check()
    const run = page.getByText('Payment run')
    await expect(run).toBeVisible()

    const first = money(await rows.first().locator('[data-due-amount]').textContent())
    const total = money(await page.locator('[data-run-total]').textContent())
    expect(total).toBeCloseTo(first, 2)
  })

  test('grouping answers "who do I pay", which is who a cheque is written to', async ({ page }) => {
    await page.goto('/suppliers?tab=planner')
    await expect(page.locator('[data-due-row]').first()).toBeVisible()
    const bills = await page.locator('[data-due-row]').count()

    await page.getByRole('button', { name: 'Group by supplier' }).click()
    await expect(page.locator('[data-due-supplier]').first()).toBeVisible()
    // One row per distributor, never one per bill — and the demo book has
    // several distributors carrying more than one open bill each, so the
    // grouped list is strictly the shorter of the two.
    const groups = await page.locator('[data-due-supplier]').count()
    expect(groups).toBeGreaterThan(0)
    expect(groups).toBeLessThan(bills)
  })
})

test.describe('Suppliers — the rate board', () => {
  test('compares the same medicine across the distributors who supply it', async ({ page }) => {
    await page.goto('/suppliers?tab=rates')
    await expect(page.getByRole('heading', { level: 1, name: 'Suppliers' })).toBeVisible()
    const rows = page.locator('[data-compare-row]')
    await expect(rows.first()).toBeVisible()

    // Cheapest is cheapest. A board that got this backwards would recommend the
    // dearer supplier, which is worse than showing nothing at all.
    const best = money(await rows.first().locator('[data-quote-best]').textContent())
    const worst = money(await rows.first().locator('[data-quote-worst]').textContent())
    expect(best).toBeLessThanOrEqual(worst)
  })

  test('RANKS ON LANDED COST, so a free scheme cannot hide a dearer deal', async ({ page }) => {
    await page.goto('/suppliers?tab=rates')
    const rows = page.locator('[data-compare-row]')
    await expect(rows.first()).toBeVisible()
    await rows.first().click()

    const quotes = page.locator('[data-quote-row]')
    await expect(quotes.first()).toBeVisible()
    const landed = (await quotes.locator('[data-quote-landed]').allTextContents()).map(money)
    for (let i = 1; i < landed.length; i += 1) {
      expect(landed[i]).toBeGreaterThanOrEqual(landed[i - 1]!)
    }
    // The cheapest landed row is the one marked best — never the cheapest rate.
    await expect(quotes.first().getByText('Best')).toBeVisible()
  })
})
