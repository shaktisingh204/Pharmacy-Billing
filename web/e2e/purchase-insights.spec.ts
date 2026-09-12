import { expect, test } from '@playwright/test'

/**
 * The distributor side of Purchases: receiving against an order, and the
 * scorecard that comes out of having done so.
 *
 * The second test is the one that matters. An order is a promise and a bill is
 * what turned up, and every incumbent lets you key the bill as though the order
 * never existed — so nobody finds out that four lines were dropped, and the
 * short line is quietly re-ordered next week at next week's rate.
 */

test.describe('purchase insights', () => {
  test('states where the money goes, and never invents a fill rate', async ({ page }) => {
    await page.goto('/purchases?tab=insights')
    await expect(page.getByRole('heading', { name: 'Supplier scorecard' }))
      .toBeVisible({ timeout: 15_000 })

    // Spend, by month and by distributor, off the register itself.
    await expect(page.getByRole('img', { name: 'Purchase spend by month' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Purchase spend by supplier' })).toBeVisible()

    /* A supplier nothing has been ordered from through this software has NO
       fill rate. 0% beside their name is a lie, and the kind that gets quoted
       back to them. */
    const row = page.locator('[data-supplier-score]').first()
    await expect(row).toBeVisible()
    await expect(row.getByText('has come due yet')).toHaveCount(1)
  })

  test('RECEIVING AGAINST AN ORDER FILLS THE GRID AND NAMES WHAT DID NOT ARRIVE', async ({ page }) => {
    // 1. Place an order with a distributor who has suggestions to order.
    await page.goto('/purchases?tab=order')
    await expect(page.getByRole('heading', { name: 'What to order' })).toBeVisible({
      timeout: 15_000,
    })
    const from = page.getByLabel('Order from')
    await expect(page.getByRole('list', { name: 'Suggested order lines' })
      .getByRole('listitem').first()).toBeVisible({ timeout: 15_000 })
    await from.selectOption({ index: 1 })
    const supplierName = (await from.locator('option').nth(1).innerText()).trim()

    await page.getByRole('button', { name: 'Place order' }).click()
    await expect(page.getByText(/placed with/)).toBeVisible({ timeout: 20_000 })

    // 2. Key a goods receipt against it.
    await page.goto('/purchases')
    const supplier = page.getByRole('combobox', { name: 'Supplier' })
    await supplier.click()
    await supplier.fill(supplierName)
    await page.getByRole('listbox', { name: 'Suppliers' }).getByRole('option').first().click()

    const against = page.getByLabel('Receive against a purchase order')
    await expect(against).toBeVisible({ timeout: 15_000 })
    await against.selectOption({ index: 1 })

    // The ordered lines land in the grid, with the pack quantity that was asked
    // for — but never a batch or a rate, which come off the paper bill.
    await expect(page.getByLabel('Quantity in packs').first()).not.toHaveValue('', {
      timeout: 15_000,
    })
    await expect(page.getByLabel('Batch number').first()).toHaveValue('')

    /* The strip names the order it is being received against. Asserted on the
       strip's own hook, not on the text: the same order number is also inside
       the picker's options, where it is not visible. */
    const strip = page.locator('[data-order-strip]')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText(/PO/)

    // 3. Short-supply one line: the strip says so, in a word and a number.
    await page.getByLabel('Quantity in packs').first().fill('1')
    await expect(strip.getByText(/short|not sent/).first()).toBeVisible({ timeout: 10_000 })
  })
})
