import { expect, test } from '@playwright/test'

/**
 * Two branches.
 *
 * `storeId` has been on every transactional row since the first migration —
 * because retrofitting store scoping is the classic rewrite trigger — and until
 * now NOTHING read it. These tests exist to make the scoping fail loudly rather
 * than silently: a register showing the other branch's bills looks exactly like
 * a busy day, and stock that includes another shop's shelf looks exactly like
 * stock.
 */

const branch = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /— change branch$/ })

async function switchTo(page: import('@playwright/test').Page, name: RegExp) {
  await branch(page).click()
  await page.getByRole('list', { name: 'Branches' }).getByRole('button', { name }).click()
  await expect(page.getByText(/Now billing for/)).toBeVisible({ timeout: 20_000 })
}

test.describe('branches', () => {
  test('the chip names the branch and can change it', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(branch(page)).toBeVisible({ timeout: 15_000 })
    await branch(page).click()
    await expect(page.getByRole('list', { name: 'Branches' })).toBeVisible()
    // Two seeded branches, and the current one is marked.
    await expect(page.getByRole('list', { name: 'Branches' }).getByRole('listitem'))
      .toHaveCount(2)
  })

  test('SWITCHING SCOPES THE STOCK, not just the name', async ({ page }) => {
    await page.goto('/inventory')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })

    /* The branch's batches are prefixed `KT-` in the seed precisely so a batch
       on screen says which shop it belongs to. Seeing one here would mean the
       counter could allocate stock forty kilometres away. */
    await expect(page.getByText(/^KT-/).first()).toHaveCount(0)

    await switchTo(page, /Kothrud/)
    await page.goto('/inventory')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/^KT-/).first()).toBeVisible({ timeout: 20_000 })
  })

  test('the branch has its own sales register, not the head shop\'s', async ({ page }) => {
    await page.goto('/sales')
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 20_000 })
    const head = await page.getByRole('row').count()
    expect(head).toBeGreaterThan(1)

    await switchTo(page, /Kothrud/)
    await page.goto('/sales')
    await expect(page.getByRole('heading', { level: 1, name: 'Sales' })).toBeVisible()
    // The branch has taken no bills, so its register is empty rather than
    // showing the head shop's day.
    await expect(page.getByRole('row').filter({ hasText: /RX\d/ })).toHaveCount(0, {
      timeout: 20_000,
    })
  })

  test('the branch is remembered across a reload', async ({ page }) => {
    // A counter machine belongs to one branch; re-picking it every morning is a
    // step that will eventually be got wrong.
    await page.goto('/dashboard')
    await switchTo(page, /Kothrud/)
    await page.reload()
    await expect(branch(page)).toContainText('Kothrud', { timeout: 20_000 })
  })
})
