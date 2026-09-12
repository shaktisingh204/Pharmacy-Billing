import { expect, test } from '@playwright/test'

/**
 * Shelf labels.
 *
 * A real label printer cannot be driven from a headless browser, so what is
 * asserted here is everything around the bytes — which are covered exhaustively
 * in unit tests, where those bugs live. The one thing that matters most on
 * screen is that the price is understood to belong to the BATCH.
 */
test.describe('shelf labels', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    // Open a batch, because a label is issued for one.
    await page.getByRole('row').nth(1).click()
    await page.getByRole('button', { name: 'Labels' }).click()
    await expect(page.getByRole('heading', { name: 'Shelf labels' })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('says the price belongs to the batch, not the product', async ({ page }) => {
    // A shelf legitimately holds one medicine in two batches at two printed
    // MRPs, and the customer pays what is on the strip in their hand.
    await expect(page.getByText(/belongs to the batch, not the product/)).toBeVisible()
  })

  test('offers both printer languages and explains why it cannot guess', async ({ page }) => {
    const lang = page.getByLabel('Printer language')
    await expect(lang).toBeVisible()
    await expect(page.getByText(/prints the commands as literal text/)).toBeVisible()
    await expect(lang).toHaveValue('TSPL')
  })

  test('previews the ACTUAL commands, and they change with the language', async ({ page }) => {
    // The preview is the only way to tell a mis-set language before a roll is
    // wasted — so it has to show what will really be sent.
    await expect(page.getByText(/SIZE 50 mm,25 mm/)).toBeVisible()

    await page.getByLabel('Printer language').selectOption('ZPL')
    await expect(page.getByText(/\^XA/)).toBeVisible()
    await expect(page.getByText(/SIZE 50 mm,25 mm/)).toHaveCount(0)
  })

  test('the head density changes the geometry, not just a label', async ({ page }) => {
    // A 203dpi layout on a 300dpi head prints at two-thirds scale and clips.
    await page.getByLabel('Printer language').selectOption('ZPL')
    await expect(page.getByText(/\^PW400/)).toBeVisible()
    await page.getByLabel('Head density').selectOption('12')
    await expect(page.getByText(/\^PW600/)).toBeVisible()
  })

  test('the price can be left off, for a rack label under mixed batches', async ({ page }) => {
    await expect(page.getByText(/MRP Rs/)).toBeVisible()
    await page.getByRole('checkbox', { name: /Print the MRP/ }).uncheck()
    await expect(page.getByText(/MRP Rs/)).toHaveCount(0)
  })

  test('the settings survive a reload', async ({ page }) => {
    await page.getByLabel('Printer language').selectOption('ZPL')
    await page.reload()
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('row').nth(1).click()
    await page.getByRole('button', { name: 'Labels' }).click()
    await expect(page.getByLabel('Printer language')).toHaveValue('ZPL', { timeout: 10_000 })
  })
})
