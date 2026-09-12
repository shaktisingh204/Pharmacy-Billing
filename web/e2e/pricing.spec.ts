import { expect, test } from '@playwright/test'

/**
 * The chain price list.
 *
 * Three properties are worth an end-to-end test, and they are the three that a
 * unit test of `pricePolicy.ts` cannot reach: the list REACHES THE COUNTER, the
 * editor refuses to publish something wrong, and a published list is shown as
 * what it is rather than as an editable settings field.
 */

async function openPricing(page: import('@playwright/test').Page) {
  await page.goto('/settings')
  await page.getByRole('button', { name: /Price list/ }).click()
  await expect(page.getByRole('heading', { name: 'Chain price list' })).toBeVisible()
}

test.describe('chain price list', () => {
  test('publishes a list and shows what every branch will see change', async ({ page }) => {
    await openPricing(page)

    // Nothing published yet: the screen says so rather than showing an empty grid.
    await expect(page.getByText(/No price list yet/)).toBeVisible()

    await page.getByRole('button', { name: 'Add a catch-all' }).click()
    await page.getByLabel('Discount for rule 1').fill('5')

    // The diff is the product: publishing blind is how a price mistake reaches
    // every shop at once.
    const preview = page.getByText('What every branch will see change')
    await expect(preview).toBeVisible()
    await expect(page.getByText(/newly priced at/)).toBeVisible()

    await page.getByRole('button', { name: 'Publish to every branch' }).click()
    await expect(page.getByText('List 1 in force')).toBeVisible()

    // In force means READ-ONLY. A published list is a document, not a field.
    const inForce = page.getByRole('table', { name: 'Price rules in force' })
    await expect(inForce.getByRole('row').filter({ hasText: 'Everything else' })).toContainText('5%')
  })

  test('refuses a negative discount, and says why rather than just disabling', async ({ page }) => {
    await openPricing(page)
    await page.getByRole('button', { name: 'Add a catch-all' }).click()
    await page.getByLabel('Discount for rule 1').fill('-3')

    // A rate above the printed MRP is an offence, not a pricing decision.
    await expect(page.getByText(/above the printed MRP/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Publish to every branch' })).toBeDisabled()
    await expect(page.getByText(/1 rule to fix first/)).toBeVisible()
  })

  test('refuses to start a list in the past', async ({ page }) => {
    await openPricing(page)
    await page.getByRole('button', { name: 'Add a catch-all' }).click()
    await page.getByLabel('Discount for rule 1').fill('4')
    await page.getByLabel(/Starts on/).fill('2020-01-01')

    await expect(page.getByText(/cannot start in the past/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Publish to every branch' })).toBeDisabled()
  })

  test('a REVERT publishes a new list rather than handing back the old one', async ({ page }) => {
    /* The idempotency key identifies the attempt, not the rules. A key derived
       from the content would collapse this third publish onto the first, and a
       shop deciding "8% was wrong, go back to 5%" would be handed a months-old
       revision instead of a new one. */
    await openPricing(page)
    const discount = page.getByLabel('Discount for rule 1')
    const publish = page.getByRole('button', { name: 'Publish to every branch' })

    await page.getByRole('button', { name: 'Add a catch-all' }).click()
    await discount.fill('5')
    await publish.click()
    await expect(page.getByText('List 1 in force')).toBeVisible()

    await discount.fill('8')
    await publish.click()
    await expect(page.getByText('List 2 in force')).toBeVisible()

    // Back to the original figures. This is a new decision, so a new list.
    await discount.fill('5')
    await publish.click()
    await expect(page.getByText('List 3 in force')).toBeVisible()
  })

  test('reaches the counter: a new line opens at the chain price', async ({ page }) => {
    await openPricing(page)
    await page.getByRole('button', { name: 'Add a catch-all' }).click()
    await page.getByLabel('Discount for rule 1').fill('8')
    await page.getByRole('button', { name: 'Publish to every branch' }).click()
    await expect(page.getByText(/List \d+ in force/)).toBeVisible()

    /* The whole point. A price list nothing bills against is a settings page. */
    await page.goto('/billing')
    const search = page.getByRole('combobox', { name: 'Medicine search' })
    await expect(search).toBeFocused()
    await search.pressSequentially('dolo', { delay: 60 })
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')

    const row = page.locator('[data-line-id]').first()
    await expect(row).toBeVisible()
    await expect(row.getByLabel(/^Discount for /)).toHaveValue('8')
  })
})
