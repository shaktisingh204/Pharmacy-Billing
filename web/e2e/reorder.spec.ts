import { expect, test } from '@playwright/test'

/**
 * What to order.
 *
 * The last test is the one that matters: placing an order must take those
 * quantities OFF the next suggestion. Not doing so is the double-order — the
 * most expensive mistake in this area and the hardest to spot, because nothing
 * looks wrong until the stock arrives twice.
 */
test.describe('reordering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/purchases?tab=order')
    await expect(page.getByRole('heading', { name: 'What to order' })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('shows the working on every row, not just a number', async ({ page }) => {
    /* Scoped to the suggestions list: the open-orders panel beside it is also a
       list, and an unscoped listitem matches both. */
    const first = page.getByRole('list', { name: 'Suggested order lines' })
      .getByRole('listitem').first()
    await expect(first).toBeVisible({ timeout: 15_000 })
    // "sells ~N a month · N on hand · N days' cover · covering 28 days"
    await expect(first).toContainText(/on hand/)
    await expect(first).toContainText(/covering 28 days/)
  })

  test('will not place an order without naming the supplier', async ({ page }) => {
    await expect(page.getByText('Choose a supplier to place the order')).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('button', { name: 'Place order' })).toBeDisabled()
  })

  test('ORDERING TAKES THOSE UNITS OFF THE NEXT SUGGESTION', async ({ page }) => {
    const list = page.getByRole('list', { name: 'Suggested order lines' })
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 15_000 })

    // Narrow to one supplier, so the order is something a distributor can ship.
    await page.getByLabel('Order from').selectOption({ index: 1 })
    const rows = list.getByRole('listitem')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })

    const before = await rows.count()
    expect(before).toBeGreaterThan(0)
    // Nothing is on order yet, so no row can be claiming otherwise.
    await expect(list.getByText(/already on order/)).toHaveCount(0)

    await page.getByRole('button', { name: 'Place order' }).click()
    await expect(page.getByText(/placed with/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/^PO/).first()).toBeVisible({ timeout: 10_000 })

    /* Most lines drop off entirely; a fast mover can legitimately still need
       more than one order's worth, and when it does its own working must SAY the
       order was counted. Both halves are asserted because either one alone would
       pass while the subtraction was broken. */
    await expect.poll(async () => rows.count(), { timeout: 15_000 })
      .toBeLessThan(before)
    const left = await rows.count()
    if (left > 0) await expect(list.getByText(/already on order/).first()).toBeVisible()
  })

  test('a cancelled order keeps its reason on file', async ({ page }) => {
    await page.getByLabel('Order from').selectOption({ index: 1 })
    await expect(page.getByRole('list', { name: 'Suggested order lines' })
      .getByRole('listitem').first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Place order' }).click()
    await expect(page.getByText(/placed with/)).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Cancel this order' }).first().click()
    // Refused without one: a distributor may still deliver, and somebody has to
    // be able to say what happened.
    await expect(page.getByRole('button', { name: 'Cancel it' })).toBeDisabled()
    await page.getByRole('textbox', { name: /^Why PO/ }).fill('Ordered twice by mistake')
    await page.getByRole('button', { name: 'Cancel it' }).click()
    await expect(page.getByText(/cancelled/)).toBeVisible({ timeout: 15_000 })
  })
})
