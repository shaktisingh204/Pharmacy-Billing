import { expect, test } from '@playwright/test'

/**
 * The owner's phone.
 *
 * Runs only at 390x844, which is the point: this surface exists because the
 * counter screens cannot be squeezed onto a phone, so asserting it at a till
 * width would prove nothing.
 *
 * Three things have to hold. It answers the owner's questions, it does not
 * scroll sideways on the narrowest screen the product supports, and it is
 * honestly read-only — a phone is the device that gets left in a rickshaw.
 */
test.describe("the owner's phone", () => {
  test('answers the four questions an owner opens it for', async ({ page }) => {
    await page.goto('/m')

    // The SHOP's name, never the software's.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sanjeevani Medical Store')

    await expect(page.getByRole('region', { name: "Today's takings" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'On the shelf' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Branches' })).toBeVisible()

    // A real figure, not a placeholder.
    const takings = page.getByRole('region', { name: "Today's takings" })
    await expect(takings.locator('.display-num')).toContainText('₹')
  })

  test('says it is READ-ONLY rather than only behaving that way', async ({ page }) => {
    /* An owner who believes they can void a bill from here will try it in front
       of a customer. The promise is on the screen. */
    await page.goto('/m')
    await expect(page.getByText('View only')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/nothing here can change a document/)).toBeVisible()

    // And nothing on the page can post anything.
    await expect(page.getByRole('button', { name: /save|post|delete|void|publish/i })).toHaveCount(0)
  })

  test('never scrolls sideways on the narrowest screen it supports', async ({ page }) => {
    await page.goto('/m')
    await expect(page.getByRole('region', { name: "Today's takings" })).toBeVisible({ timeout: 20_000 })

    // Horizontal overflow on a phone is the difference between a usable screen
    // and one where half the figures sit off the edge.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

  test('is DISCOVERABLE from the counter app, and offers a way back', async ({ page }) => {
    /* Nobody types /m. The shell offers it at phone width — offered and not
       forced, because a redirect would break every deep link somebody taps out
       of a message. */
    await page.goto('/')
    const offer = page.getByRole('link', { name: /Open the owner view/ })
    await expect(offer).toBeVisible({ timeout: 20_000 })
    await offer.click()
    await expect(page).toHaveURL(/\/m$/)

    // And back out again: a surface with no exit is a trap.
    await expect(page.getByRole('region', { name: "Today's takings" })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('link', { name: /Open the full counter app/ }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('carries no vendor mark — the shop bought a white label', async ({ page }) => {
    await page.goto('/m')
    await expect(page.getByRole('region', { name: "Today's takings" })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('body')).not.toContainText('RxBill')
  })
})
