import { describe, expect, it } from 'vitest'
import {
  MAX_SAVED_VIEWS, loadSavedViews, newViewId, removeView, renameView, resolveRange,
  storeSavedViews, upsertView, SAVED_VIEWS_KEY,
} from './savedViews'
import type { SavedView } from './savedViews'

/**
 * A saved view is trustworthy or it is a bookmark. These are mostly about the
 * rolling window and about surviving a bad blob.
 */

const TODAY = new Date('2026-09-09T10:00:00.000Z')

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: 'v1',
  name: 'Payables this month',
  reportId: 'SUPPLIER_OUTSTANDING',
  preset: 'month',
  from: '2026-09-01',
  to: '2026-09-30',
  term: '',
  facet: '',
  groupBy: '',
  savedAt: '2026-09-09T10:00:00.000Z',
  ...over,
})

describe('the window a saved view opens on', () => {
  it('RE-RESOLVES a rolling preset, so "this month" moves with the calendar', () => {
    // Frozen dates would turn every saved view into a historical snapshot within
    // a month, which is the opposite of why it was saved.
    const saved = view({ preset: 'month', from: '2026-01-01', to: '2026-01-31' })
    const opened = resolveRange(saved, TODAY)
    expect(opened.from).not.toBe('2026-01-01')
    expect(opened.from.slice(0, 7)).toBe('2026-09')
  })

  it('keeps a PINNED window exactly as saved', () => {
    // A festival week is the question; rolling it forward answers a different one.
    const pinned = view({ preset: null, from: '2026-10-18', to: '2026-10-25' })
    expect(resolveRange(pinned, TODAY)).toEqual({ from: '2026-10-18', to: '2026-10-25' })
  })

  it('falls back to the saved dates when a preset no longer exists', () => {
    // A stored blob from an older build must still open something.
    const stale = view({ preset: 'fortnight', from: '2026-08-01', to: '2026-08-14' })
    expect(resolveRange(stale, TODAY)).toEqual({ from: '2026-08-01', to: '2026-08-14' })
  })
})

describe('the list', () => {
  it('replaces by id rather than appending, so re-saving is idempotent', () => {
    // Otherwise the list fills with near-duplicates differing only by a filter
    // nobody can see from the name.
    const next = upsertView([view({ id: 'v1', name: 'Old' })], view({ id: 'v1', name: 'New' }))
    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe('New')
  })

  it('puts the newest save first', () => {
    const older = view({ id: 'a', savedAt: '2026-01-01T00:00:00.000Z' })
    const newer = view({ id: 'b', savedAt: '2026-09-01T00:00:00.000Z' })
    expect(upsertView([older], newer).map((v) => v.id)).toEqual(['b', 'a'])
  })

  it('caps the list, because a shortcut nobody can find is not a shortcut', () => {
    const many = Array.from({ length: MAX_SAVED_VIEWS }, (_, i) => view({
      id: `v${i}`, savedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))
    const next = upsertView(many, view({ id: 'new', savedAt: '2026-12-01T00:00:00.000Z' }))
    expect(next).toHaveLength(MAX_SAVED_VIEWS)
    expect(next[0]?.id).toBe('new')
  })

  it('removes exactly one', () => {
    expect(removeView([view({ id: 'a' }), view({ id: 'b' })], 'a').map((v) => v.id)).toEqual(['b'])
  })

  it('gives deterministic ids, so a test is not at the mercy of Math.random', () => {
    expect(newViewId(1_788_000_000_000)).toBe(newViewId(1_788_000_000_000))
    expect(newViewId(1)).not.toBe(newViewId(2))
  })
})

describe('renaming', () => {
  it('leaves the view alone on an empty name', () => {
    // The rename field submits on Enter, and a stray Enter on an empty box would
    // otherwise erase the only thing identifying the view in the list.
    const list = [view({ id: 'v1', name: 'Payables' })]
    expect(renameView(list, 'v1', '   ')[0]?.name).toBe('Payables')
  })

  it('collapses whitespace and caps the length', () => {
    const list = [view({ id: 'v1' })]
    expect(renameView(list, 'v1', '  Owed   by  supplier ')[0]?.name).toBe('Owed by supplier')
    expect(renameView(list, 'v1', 'x'.repeat(90))[0]?.name).toHaveLength(48)
  })

  it('touches only the named view', () => {
    const list = [view({ id: 'a', name: 'A' }), view({ id: 'b', name: 'B' })]
    expect(renameView(list, 'a', 'Z').map((v) => v.name)).toEqual(['Z', 'B'])
  })
})

describe('what is stored', () => {
  it('survives a corrupt blob rather than taking the page down', () => {
    // Every saved view is reconstructible in a few clicks; failing here would
    // cost a working Reports page for a list of conveniences.
    window.localStorage.setItem(SAVED_VIEWS_KEY, 'not json')
    expect(loadSavedViews()).toEqual([])
    window.localStorage.setItem(SAVED_VIEWS_KEY, '{"not":"an array"}')
    expect(loadSavedViews()).toEqual([])
  })

  it('drops one bad row without discarding the good ones', () => {
    window.localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([view({ id: 'a' }), { junk: true }, null]),
    )
    expect(loadSavedViews().map((v) => v.id)).toEqual(['a'])
  })

  it('rejects a PINNED view whose window will not parse', () => {
    // It would open on nothing at all; a rolling one can still resolve.
    window.localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([view({ id: 'bad', preset: null, from: 'soon', to: 'later' })]),
    )
    expect(loadSavedViews()).toEqual([])

    window.localStorage.setItem(
      SAVED_VIEWS_KEY,
      JSON.stringify([view({ id: 'ok', preset: 'month', from: '', to: '' })]),
    )
    expect(loadSavedViews().map((v) => v.id)).toEqual(['ok'])
  })

  it('round-trips through storage in save order', () => {
    storeSavedViews([
      view({ id: 'a', savedAt: '2026-01-01T00:00:00.000Z' }),
      view({ id: 'b', savedAt: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(loadSavedViews().map((v) => v.id)).toEqual(['b', 'a'])
  })
})
