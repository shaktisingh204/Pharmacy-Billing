import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Users & roles, exercised the way an owner reads it.
 *
 * The five things asserted here are the five the screen exists for, and each of
 * them is a claim that could regress silently: a tile that counts roles instead
 * of people, a matrix edit that does not reach the exposure it changes, a rota
 * that files a lunch lull as a handover, a signature queue that lists overrides
 * without re-checking them. None of those throw, and all of them make the screen
 * confidently wrong.
 *
 * The seeded demo is the fixture. Its numbers are deliberate — two cashiers on
 * different ceilings, a pharmacist with the cost flag off, a disabled leaver
 * whose void is the exact amount the drawer came up short that night — so the
 * assertions below name behaviour rather than counts wherever a count would age.
 */

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/users${query}`)
  /* A cold context re-seeds the whole demo database before the shell can paint,
     and six workers do it at once. The budget is for the seed, not the page. */
  await expect(page.getByRole('heading', { level: 1, name: 'Users & roles' }))
    .toBeVisible({ timeout: 25_000 })
}

const tab = (page: Page, name: string) => page.getByRole('group', { name: 'View' }).getByRole('button', { name })

test.describe('the page', () => {
  test('leads with the money the roster can move without a signature', async ({ page }) => {
    await open(page)
    await expect(page.getByText('Refund authority at the counter')).toBeVisible()
    // Two cashiers, two pharmacists and a manager, none of them an owner account.
    await expect(page.getByText('can go back over the counter today with nobody signing')).toBeVisible()
  })

  test('keeps the tab in the URL, so a view is a link', async ({ page }) => {
    await open(page)
    await tab(page, /Shifts/).click()
    await expect(page).toHaveURL(/tab=shifts/)
    await page.reload()
    await expect(page.getByRole('columnheader').or(page.getByText('07:00 — 23:00'))).toBeVisible()
  })
})

test.describe('the exposure band', () => {
  test('counts people, names them, and filters the roster down to them', async ({ page }) => {
    await open(page)

    const tile = page.getByRole('button', { name: /Void a bill/ })
    await expect(tile).toBeVisible()
    // Counted through the person, not the role: the disabled leaver holds nothing.
    await expect(tile).toContainText('Harshad')

    await tile.click()
    await expect(page).toHaveURL(/hold=billing\.void/)
    const rows = page.locator('[data-user-row]')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Harshad Kulkarni')
  })

  test('says which of the powers leave no row behind', async ({ page }) => {
    await open(page)
    // Cost, buying rates and margin are reads, and a read cannot be audited after.
    await expect(page.getByText('A read — leaves no row').first()).toBeVisible()
  })
})

test.describe('a person’s record', () => {
  test('carries their limits, their shifts and what they did', async ({ page }) => {
    await open(page)
    await page.locator('[data-user-row]', { hasText: 'Akib Shaikh' }).click()

    const panel = page.getByRole('complementary', { name: 'Akib Shaikh' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Alone, without asking anyone')).toBeVisible()
    await expect(panel.getByText('On the counter')).toBeVisible()
    await expect(panel.getByText('Lately')).toBeVisible()
    // The cashier cannot void, and the panel names who could sign it off instead.
    await expect(panel.getByText(/can sign:/).first()).toBeVisible()
  })

  test('hands off to the trail, filtered to that person', async ({ page }) => {
    await open(page)
    await page.locator('[data-user-row]', { hasText: 'Akib Shaikh' }).click()
    await page.getByRole('button', { name: /everything by Akib/ }).click()
    await expect(page).toHaveURL(/tab=activity/)
    await expect(page).toHaveURL(/who=5/)
  })
})

test.describe('the permission matrix', () => {
  test('is editable per role, and the edit reaches the exposure it changes', async ({ page }) => {
    await open(page)
    await tab(page, /Permissions/).click()
    await expect(page.getByRole('heading', { name: 'Running the shipped matrix' })).toBeVisible()

    await page.getByRole('button', { name: /^Cashier: Void a posted bill/ }).click()
    await expect(page.getByRole('heading', { name: /1 cell moved from shipped/ })).toBeVisible()
    // The catalogue's own sentence about what goes wrong, not a generic warning,
    // and the headcount it lands on in this shop.
    await expect(page.getByText(/Costs money — Cashier can now void a posted bill/)).toBeVisible()
    await expect(page.getByText(/oldest till theft/).first()).toBeVisible()
    await expect(page.getByText(/2 active accounts in this role today/)).toBeVisible()

    /* Two people could void a bill before the edit and four can after it, and
       the tile names them rather than only counting: the answer to "four" is
       always "which four". The tile names two and says how many more. */
    await tab(page, /People/).click()
    const tile = page.getByRole('button', { name: /Void a bill/ })
    await expect(tile).toContainText('4')
    await expect(tile).toContainText('Harshad, Prakash')
    await expect(tile).toContainText('+2')
  })

  test('refuses the owner’s column, which has no way back', async ({ page }) => {
    await open(page, '?tab=permissions')
    // Locked cells are not buttons at all, so there is nothing to press by mistake.
    await expect(
      page.getByRole('button', { name: /^Owner \/ admin: Manage users/ }),
    ).toHaveCount(0)
    await expect(page.getByText('Owner / admin: Manage users: granted, not editable')).toHaveCount(1)
  })

  test('goes back to shipped in one press', async ({ page }) => {
    await open(page, '?tab=permissions')
    await page.getByRole('button', { name: /^Cashier: Edit a rate or MRP/ }).click()
    await expect(page.getByRole('heading', { name: /1 cell moved from shipped/ })).toBeVisible()
    await page.getByRole('button', { name: 'Back to shipped' }).click()
    await expect(page.getByRole('heading', { name: 'Running the shipped matrix' })).toBeVisible()
  })
})

test.describe('the counter rota', () => {
  test('names who was on which till, and flags the drawer that came up short', async ({ page }) => {
    await open(page, '?tab=shifts')
    await expect(page.getByText('07:00 — 23:00')).toBeVisible()

    const short = page.getByRole('button', { name: /Drawer came up short/ })
    await expect(short).toBeVisible()
    await short.click()
    // Every remaining shift is one whose closing count did not reconcile.
    await expect(page.getByText('Not counted')).toHaveCount(0)
    await expect(page.getByText(/Till \d/).first()).toBeVisible()
  })
})

test.describe('the approval queue', () => {
  test('re-checks each signature against the roster as it stands today', async ({ page }) => {
    await open(page, '?tab=approvals')
    await expect(page.getByText('Passed on a second signature')).toBeVisible()
    await expect(page.getByText(/6 overrides in the loaded window/)).toBeVisible()
    // Both halves of every recorded signature, always.
    await expect(page.getByText('Prakash Nene').first()).toBeVisible()
  })

  test('remembers being read, without writing anything into the trail', async ({ page }) => {
    await open(page, '?tab=approvals')
    /* From "Everything", because a row marked read leaves the needs-reading list
       — which is the behaviour, and would hide the row this test is watching. */
    await page.getByRole('button', { name: /^Everything/ }).click()
    await page.getByRole('button', { name: 'Read', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Undo' }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Read 1' })).toBeVisible()
    // The mark is a bookmark, not an event: the trail still has all six.
    await expect(page.getByText(/6 overrides in the loaded window/)).toBeVisible()
  })
})
