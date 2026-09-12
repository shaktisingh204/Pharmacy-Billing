import { expect, test } from '@playwright/test'

/**
 * The second screen, the counter home and the bill remark.
 *
 * These three are the parts of the counter a keyboard-only test of the sale
 * flow cannot see: what the CUSTOMER is looking at, what the till offers
 * between customers, and the note that travels with the bill.
 */

test.describe('customer display', () => {
  test('stands by on its own, with no shell around it', async ({ page }) => {
    await page.goto('/display')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(/waiting for the counter/i)).toBeVisible()
    // Outside the app shell on purpose: no nav, nothing for a customer to click
    // into. Main is the shell's own landmark, so its absence IS the assertion.
    await expect(page.locator('nav[aria-label="Main"]')).toHaveCount(0)
  })

  test("carries the SHOP's name and never the software's", async ({ page }) => {
    /* The screen a customer actually reads. It hardcoded the vendor name once,
       which means a shop that bought this white-labelled advertised a product
       its customers have never heard of, on its own counter. The heading and
       the tab title both come from the store profile. */
    await page.goto('/display')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sanjeevani Medical Store')
    await expect(page).toHaveTitle(/^Sanjeevani Medical Store —/)
    await expect(page.locator('body')).not.toContainText('RxBill')
  })

  test('mirrors the cart, the total and the saving as items are scanned', async ({ context }) => {
    const display = await context.newPage()
    await display.goto('/display')
    await expect(display.getByText(/waiting for the counter/i)).toBeVisible()

    const till = await context.newPage()
    await till.goto('/billing')
    const search = till.getByRole('combobox', { name: 'Medicine search' })
    await expect(search).toBeFocused()
    await search.pressSequentially('dolo', { delay: 60 })
    await expect(till.getByRole('option').first()).toBeVisible()
    await till.keyboard.press('Enter')
    await expect(till.locator('[data-line-id]')).toHaveCount(1)

    // The customer sees the line and the running total without the till doing
    // anything else — the whole point of the second screen.
    await display.bringToFront()
    await expect(display.getByText(/dolo/i).first()).toBeVisible()
    const net = display.getByTestId('display-net')
    await expect(net).toBeVisible()
    expect(Number((await net.innerText()).replace(/[₹,\s]/g, ''))).toBeGreaterThan(0)
  })

  test('shows the bill remark the counter typed', async ({ context }) => {
    const till = await context.newPage()
    await till.goto('/billing')
    const search = till.getByRole('combobox', { name: 'Medicine search' })
    await search.pressSequentially('dolo', { delay: 60 })
    await expect(till.getByRole('option').first()).toBeVisible()
    await till.keyboard.press('Enter')

    // Alt+M outside the grid is the BILL remark; inside a row it is that line's
    // dispensing instruction. Focus rests in search here, so it is the bill's.
    await till.keyboard.press('Alt+m')
    await expect(till.getByLabel('Bill remark')).toBeFocused()
    await till.keyboard.type('Home delivery 6pm')

    const display = await context.newPage()
    await display.goto('/display')
    await expect(display.getByText('Home delivery 6pm')).toBeVisible()
  })
})

test.describe('counter home', () => {
  test('offers fast movers that add a line in one tap', async ({ page }) => {
    await page.goto('/billing')
    await expect(page.getByText('Fast movers')).toBeVisible()

    // The tiles live under the "Fast movers" heading; take the first one.
    const panel = page.locator('section', { has: page.getByText('Fast movers') })
    const pick = panel.getByRole('button').first()
    await expect(pick).toBeVisible()
    const name = (await pick.innerText()).split('\n')[0] ?? ''
    expect(name.length).toBeGreaterThan(0)

    await pick.click()
    await expect(page.locator('[data-line-id]')).toHaveCount(1)
    // Adding a line replaces the counter home with the cart — the tiles never
    // cost the grid a row.
    await expect(page.getByText('Fast movers')).toHaveCount(0)
  })

  test('lists recent bills for reprint without leaving the till', async ({ page }) => {
    await page.goto('/billing')
    await expect(page.getByText('Recent bills').first()).toBeVisible()

    // Alt+R reaches the same list from mid-bill, where the counter actually is.
    await page.keyboard.press('Alt+r')
    await expect(page.getByText('Posted today')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Posted today')).toHaveCount(0)
  })
})
