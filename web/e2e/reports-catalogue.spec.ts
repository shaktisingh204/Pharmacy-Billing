import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * Every report the contract defines is REACHABLE.
 *
 * A report can be fully built — a builder, a column set, tests — and still be
 * invisible, because the screen's own list is hand-written and adding to it is a
 * second, forgettable step. The failure is silent in the worst way: the report
 * works perfectly for anyone who knows the URL, and does not exist for everyone
 * else.
 *
 * So the list is checked against the contract rather than against a copy of
 * itself. `REPORT_IDS` is read from the contract source at test time for the
 * same reason the unit tests spread it instead of retyping it — a hand-written
 * list here would stop covering the fifteenth report the day one is added.
 */

function reportIds(): string[] {
  const src = readFileSync(new URL('../../contract/types.ts', import.meta.url), 'utf8')
  const block = /export const REPORT_IDS = \[([\s\S]*?)\] as const/.exec(src)
  if (!block) throw new Error('REPORT_IDS not found in contract/types.ts — has it been renamed?')
  return [...block[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!)
}

test.describe('the report catalogue', () => {
  test('offers every report the contract defines, and none it does not', async ({ page }) => {
    const ids = reportIds()
    expect(ids.length).toBeGreaterThan(10)

    /* The QUESTION, not the title: on this screen the title never appears — it
       goes to the export and the saved view — and the question under the header
       is what tells a reader which report they are looking at. A shared question
       means two list entries point at one report, which is the exact failure a
       hand-written catalogue produces.

       The gate is the question replacing its PLACEHOLDER, not a grid appearing.
       A report with nothing to show renders an empty state and has no grid at
       all — waiting for one would fail on a correctly-working report. */
    const question = page.getByTestId('report-question')
    const seen = new Map<string, string>()

    for (const id of ids) {
      await page.goto(`/reports?r=${id}`)
      await expect(question).not.toHaveText(/reports a pharmacy actually opens/, { timeout: 20_000 })
      const text = (await question.innerText()).trim()
      expect(text, `${id} rendered no question`).not.toBe('')
      const clash = seen.get(text)
      expect(clash, `${id} shows the same question as ${clash}`).toBeUndefined()
      seen.set(text, id)
    }

    // Every id resolved to a distinct report, so the list covers the contract.
    expect(seen.size).toBe(ids.length)
  })
})
