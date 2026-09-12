import { expect, test } from '@playwright/test'

/**
 * The bell, and the two chips beside it.
 *
 * All three were controls with no `onClick` — and the bell carried a comment
 * saying a permanently lit indicator teaches staff to stop reading indicators,
 * above a button that did nothing, which is the same lesson taught differently.
 */
test.describe('needs attention', () => {
  test('the bell opens a list of things that can be acted on', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
  })

  test('every row states a number and goes to the screen that fixes it', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()

    /* Scoped to the popover: the sidebar nav is also a list, and an unscoped
       listitem matches every link in it. */
    const rows = page.getByRole('list', { name: 'Things needing attention' })
      .getByRole('listitem')
    const count = await rows.count()
    if (count === 0) {
      // A quiet shop is the designed outcome, and it says so rather than
      // showing an empty box.
      await expect(page.getByText(/meant to be empty most of the time/)).toBeVisible()
      return
    }

    // "12 batches on the shelf are expired" — the count is what makes it useful.
    await expect(rows.first()).toContainText(/\d/)
    await rows.first().click()
    await expect(page).not.toHaveURL(/\/dashboard$/)
  })

  test('the badge counts only what is a problem TODAY', async ({ page }) => {
    // Near-expiry is this week's work and must not light it, or the badge is on
    // permanently and stops being read.
    await page.goto('/dashboard')
    const bell = page.getByRole('button', { name: /^Notifications/ })
    const label = await bell.getAttribute('aria-label')
    expect(label).toMatch(/nothing needs attention|need attention, \d+ today/)
  })
})

test.describe('the chips that used to do nothing', () => {
  test('the operator chip goes to Users & Roles, where their limits live', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: /open Users & Roles/ }).click()
    await expect(page).toHaveURL(/\/users/)
  })

  test('the till chip states a fact rather than pretending to be a menu', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('Counter 1')).toBeVisible()
    // Not a button: there is nothing behind it, and a control that does nothing
    // teaches the operator that clicking here has no effect.
    await expect(page.getByRole('button', { name: 'Counter 1' })).toHaveCount(0)
  })
})
