import { expect, test } from '@playwright/test'

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible()
  })

  test('renders real figures, not zeroes', async ({ page }) => {
    // A dashboard whose every KPI reads zero looks identical to a broken one, and
    // the seed shipped with no sales history for exactly that reason.
    await expect(page.getByTestId('kpi-sales')).toContainText(/₹\s?[1-9]/)
    await expect(page.getByTestId('kpi-bills')).not.toContainText(/^Bills\s*0\b/)
    await expect(page.getByText('No data')).toHaveCount(0)
  })

  test('every chart carries a non-colour identity channel', async ({ page }) => {
    // Colour alone may never encode meaning: each chart exposes a labelled table
    // for assistive tech, and the donuts label every segment in the legend.
    // The panels paint after the aggregation resolves, not with the heading.
    const charts = page.locator('[role="img"]')
    await expect(charts.first()).toBeVisible()
    expect(await charts.count()).toBeGreaterThanOrEqual(3)
    await expect(page.getByRole('table')).not.toHaveCount(0)
    for (const label of ['Healthy', 'Low stock', 'Near expiry', 'Expired']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible()
    }
  })

  test('the Pharmacist view hides cost and margin', async ({ page }) => {
    await expect(page.getByText('Gross margin')).toBeVisible()
    await expect(page.getByText('Capital at risk')).toBeVisible()

    await page.getByRole('tab', { name: 'Pharmacist view' }).click()

    // A cashier has no business reading the shop's margin or what it paid.
    await expect(page.getByText('Gross margin')).toHaveCount(0)
    await expect(page.getByText('Outstanding')).toHaveCount(0)
    await expect(page.getByText('Capital at risk')).toHaveCount(0)
    // …but they still see WHICH stock is dying.
    await expect(page.getByText('Expiring soon')).toBeVisible()
  })

  test('attention tiles navigate to where the work is', async ({ page }) => {
    await page.getByText('Near expiry · 30d').click()
    await expect(page).toHaveURL(/\/inventory$/)
  })

  test('the date range drives the numbers and rides in the URL', async ({ page }) => {
    // A dashboard is something a manager sends to somebody. If the window is
    // state rather than a URL, the link opens on a different set of numbers than
    // the one the sender was looking at.
    await expect(page.getByRole('heading', { name: /Takings · today/ })).toBeVisible()
    const today = await page.getByTestId('kpi-bills').innerText()

    await page.getByRole('tab', { name: '30 days' }).click()
    await expect(page).toHaveURL(/[?&]range=30d/)
    await expect(page.getByRole('heading', { name: /Takings · the last 30 days/ })).toBeVisible()
    // Thirty days of a trading shop is more bills than one day of it.
    await expect(page.getByTestId('kpi-bills')).not.toHaveText(today)
    await expect(page.getByText('vs previous 30 days').first()).toBeVisible()

    // And the link opens where it was sent from.
    await page.reload()
    await expect(page.getByRole('heading', { name: /Takings · the last 30 days/ })).toBeVisible()
  })

  test('an unreadable range in the URL falls back rather than breaking the shop', async ({ page }) => {
    await page.goto('/?range=last-tuesday')
    await expect(page.getByRole('heading', { name: /Takings · today/ })).toBeVisible()
  })

  test('every stat tile goes through to the screen that explains it', async ({ page }) => {
    // A number with no way through to the rows behind it makes the reader retype
    // what they just read into another screen's filter.
    await page.getByTestId('kpi-outstanding').click()
    await expect(page).toHaveURL(/\/customers\?view=owes/)

    await page.goto('/')
    await page.getByTestId('kpi-gross-margin').click()
    await expect(page).toHaveURL(/\/reports\?r=BATCH_MARGIN/)
  })

  test('the takings chart answers "what did we take at that moment"', async ({ page }) => {
    const chart = page.locator('[aria-label^="Takings by"]').first()
    await expect(chart).toBeVisible()
    await expect(page.locator('[role="tooltip"]')).toHaveCount(0)

    await chart.hover()
    await expect(page.locator('[role="tooltip"]').first()).toBeVisible()

    // …and without a mouse. The crosshair is the whole point of the chart, so it
    // cannot be a hover-only affordance.
    await page.mouse.move(0, 0)
    await chart.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[role="tooltip"]').first()).toBeVisible()
  })

  test('the two branches are shown side by side', async ({ page }) => {
    const branches = page.getByRole('heading', { name: 'Branches' })
    await expect(branches).toBeVisible()
    // Both shops, with the one this till is billing for marked.
    await expect(page.getByText('Billing here')).toHaveCount(1)
    await expect(page.getByText(/Kothrud/).first()).toBeVisible()
  })

  test('top movers names risers and fallers in words, not only in colour', async ({ page }) => {
    await page.getByRole('tab', { name: '30 days' }).click()
    await expect(page.getByRole('heading', { name: 'Top movers' })).toBeVisible()
    await expect(page.getByText('Rising')).toBeVisible()
    await expect(page.getByText('Falling')).toBeVisible()
  })

  test('a screen that throws does not take down the shell', async ({ page }) => {
    // The charts deliberately throw rather than cycle a colour palette past its
    // safe slot count. That is right for the chart and fatal for the till without
    // a boundary — before this existed, one bad series rendered a blank page.
    await page.goto('/_boom')
    await expect(page.getByTestId('state-error')).toBeVisible()

    // The shell survives: navigation still works and billing is untouched.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await page.getByRole('link', { name: 'Billing' }).click()
    await expect(page.getByRole('combobox', { name: 'Medicine search' })).toBeVisible()
  })
})
