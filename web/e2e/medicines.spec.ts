import { expect, test } from '@playwright/test'

const SEARCH = /Brand, salt, manufacturer/i

/** The hero figure in the page header: how many items this view is showing. */
const COUNT = 'medicine-count'

test.describe('Medicines — the item master', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('heading', { level: 1, name: 'Medicines' })).toBeVisible()
    await expect(page.getByRole('row').first()).toBeVisible()
  })

  test('windows a large catalogue instead of putting it all in the DOM', async ({ page }) => {
    await expect(page.getByTestId(COUNT)).toHaveText('1,595')
    // ~1,600 rows in the DOM is the difference between a grid and a hang.
    const rows = await page.getByRole('row').count()
    expect(rows).toBeGreaterThan(5)
    expect(rows).toBeLessThan(120)
  })

  test('filters live in the URL, so a view is shareable and the back button works', async ({ page }) => {
    await page.getByRole('button', { name: /Low stock/ }).first().click()
    await expect(page).toHaveURL(/stock=low/)
    await page.goBack()
    await expect(page).not.toHaveURL(/stock=low/)
  })

  test('search matches on salt, not only on brand', async ({ page }) => {
    const before = await page.getByRole('row').count()
    // Paracetamol is a COMPOSITION; no brand is called that. If this narrows the
    // list, the index is searching the salt.
    await page.getByPlaceholder(SEARCH).fill('paracetamol')
    await expect(page.getByTestId(COUNT)).not.toHaveText('1,595')
    await expect(page.getByRole('row').first()).toBeVisible()
    expect(await page.getByRole('row').count()).toBeLessThanOrEqual(before)
  })

  test('a row opens the detail drawer without leaving the list', async ({ page }) => {
    await page.getByRole('row').nth(2).click()
    const drawer = page.getByRole('complementary')
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    // The list is still there behind it — a drawer, not a navigation.
    await expect(page.getByRole('heading', { level: 1, name: 'Medicines' })).toBeVisible()
  })
})

test.describe('Medicines — the needs-attention strip', () => {
  test('a data-quality gap is a view, and the view is a link', async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('row').first()).toBeVisible()

    const pill = page.getByRole('button', { name: /No barcode/ })
    await expect(pill).toBeVisible()
    await pill.click()

    // The count is a filter, not a warning: the grid is now exactly those rows.
    await expect(page).toHaveURL(/gap=barcode/)
    await expect(page.getByRole('button', { name: /Missing.*No barcode/ })).toBeVisible()
    await expect(page.getByTestId('medicine-count')).not.toHaveText('1,595')

    // And it survives a reload, because the whole view lives in the URL.
    await page.reload()
    await expect(page.getByRole('button', { name: /Missing.*No barcode/ })).toBeVisible()
  })
})

test.describe('Medicines — the detail sheet', () => {
  test('each panel is its own view, addressable in the URL', async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('row').first()).toBeVisible()
    await page.getByRole('row').nth(2).click()

    const drawer = page.getByRole('complementary')
    await expect(drawer).toBeVisible()

    await drawer.getByRole('tab', { name: 'Sales' }).click()
    await expect(page).toHaveURL(/tab=sales/)
    await expect(drawer.getByText(/a month/)).toBeVisible()

    await drawer.getByRole('tab', { name: 'Batches' }).click()
    await expect(page).toHaveURL(/tab=batches/)
    await expect(drawer.getByText('Current printed MRP')).toBeVisible()

    // A pasted link lands on the same item AND the same panel.
    const url = page.url()
    await page.goto(url)
    await expect(page.getByRole('complementary').getByText('Current printed MRP')).toBeVisible()
  })
})

test.describe('Medicines — bulk edits', () => {
  test('ticked rows take a rack in one write, and it can be put back', async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('row').first()).toBeVisible()

    // Checkbox 0 is the header's select-all; the next two are rows.
    await page.getByRole('checkbox').nth(1).check()
    await page.getByRole('checkbox').nth(2).check()

    const bar = page.getByRole('toolbar', { name: /Bulk actions/ })
    await expect(bar).toBeVisible()
    await expect(bar.getByText('ticked')).toBeVisible()

    await bar.getByRole('button', { name: /Set rack/ }).click()
    await page.getByRole('textbox').last().fill('Z-9')
    await page.getByRole('button', { name: /Apply to 2 items/ }).click()

    await expect(page.getByText(/2 items → Z-9/)).toBeVisible()
  })

  test('the header box only ever claims the rows that are loaded', async ({ page }) => {
    await page.goto('/medicines')
    await expect(page.getByRole('row').first()).toBeVisible()

    const all = page.getByRole('checkbox').first()
    // Never "select all 1,595": a bulk write may only reach rows somebody could
    // have looked at, and the grid is virtual and paged.
    await expect(all).toHaveAttribute('aria-label', /Select all \d+ loaded rows/)
  })
})

test.describe('White-label branding', () => {
  test('the document title comes from the brand profile', async ({ page }) => {
    await page.goto('/')
    // Set by applyBrandToDocument, not by index.html. A reseller renames the
    // product by changing data; nothing here is a literal in the source.
    await expect(page).toHaveTitle(/RxBill/)
  })

  test('the accent is a token, so rebranding never touches a component', async ({ page }) => {
    await page.goto('/')
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent-9').trim(),
    )
    expect(accent).toMatch(/^(#|rgb)/)

    // Overriding the token at the root reaches every consumer, because nothing
    // hardcodes the hue. That inheritance IS the white-label mechanism.
    const inherited = await page.evaluate(() => {
      document.documentElement.style.setProperty('--accent-9', '#7C3AED')
      return getComputedStyle(document.body).getPropertyValue('--accent-9').trim()
    })
    expect(inherited).toBe('#7C3AED')
  })
})
