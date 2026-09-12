import { expect, test } from '@playwright/test'

/**
 * Grouping — "Index On", the one report feature that is worth more than another
 * report screen.
 *
 * The assertions below are about TRUST, not layout. A grouped report that shows
 * a different total from its flat form is worse than no grouping at all, so the
 * footer is read before and after and has to be character-identical.
 */
test.describe('reports — grouping', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/reports?r=ITEM_SALES')
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 15_000 })
  })

  const footer = (page: import('@playwright/test').Page) =>
    page.getByRole('grid').getByRole('row').last().innerText()

  test('grouping does not change one figure in the footer', async ({ page }) => {
    const flat = await footer(page)
    expect(flat).toMatch(/\d/)

    const groupBy = page.getByLabel('Group the rows by a column')
    await groupBy.selectOption({ label: 'By Company' })
    await expect(page.getByText(/in \d+ groups?/)).toBeVisible()

    expect(await footer(page)).toBe(flat)

    // …and back. A control that cannot be undone is a trap on a report screen.
    await groupBy.selectOption('')
    expect(await footer(page)).toBe(flat)
  })

  test('a band folds away its rows and keeps its count', async ({ page }) => {
    await page.getByLabel('Group the rows by a column').selectOption({ label: 'By Company' })
    const band = page.getByRole('row', { expanded: true }).first()
    await expect(band).toBeVisible()

    /* aria-rowcount, not the rendered rows. The grid is virtualised, so folding
       a band frees the viewport to draw MORE of the rows below it and the DOM
       count barely moves — the count a screen reader is given is the one that
       actually reflects the fold. */
    const grid = page.getByRole('grid')
    const before = Number(await grid.getAttribute('aria-rowcount'))
    expect(before).toBeGreaterThan(1)

    await band.click()
    await expect(page.getByRole('row', { expanded: false }).first()).toBeVisible()
    await expect(grid).not.toHaveAttribute('aria-rowcount', String(before))
    expect(Number(await grid.getAttribute('aria-rowcount'))).toBeLessThan(before)
  })

  test('the grouping is in the URL, so a banded report is a link', async ({ page }) => {
    await page.getByLabel('Group the rows by a column').selectOption({ label: 'By Company' })
    await expect(page).toHaveURL(/[?&]g=company/)

    await page.reload()
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('row', { expanded: true }).first()).toBeVisible()
  })
})
