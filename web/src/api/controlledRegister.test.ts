import { describe, expect, it } from 'vitest'
import type { StockMovement } from '@contract'
import { buildRegister, foots, sortRegisters } from './controlledRegister'
import type { DrugRegister } from './controlledRegister'

/**
 * The controlled-drug register.
 *
 * A register is not a stock figure, it is the ARITHMETIC that produced one. So
 * these tests are almost entirely about two things: that the running balance is
 * reproducible (same rows in, same balances out, every time), and that it says
 * "I cannot compare this" rather than claiming a reconciliation it has no basis
 * for.
 */

const TODAY = '2026-09-09'

let seq = 0
const mv = (over: Partial<StockMovement> & { at: string; qtyDelta: string }): StockMovement => ({
  id: (seq += 1),
  batchId: 1,
  batchNo: 'B-1',
  medicineId: 7,
  brandName: 'Alprax 0.5',
  balanceAfter: '0',
  reason: 'SALE',
  refType: 'INVOICE',
  refId: 'RX-1',
  note: null,
  ...over,
})

const build = (movements: StockMovement[], over: Partial<Parameters<typeof buildRegister>[0]> = {}) =>
  buildRegister({
    medicineId: 7,
    brandName: 'Alprax 0.5',
    schedule: 'X',
    movements,
    from: '2026-09-01',
    to: '2026-09-30',
    today: TODAY,
    ...over,
  })

describe('the running balance', () => {
  it('runs forward through the window, one row per movement', () => {
    const reg = build([
      mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '30', reason: 'PURCHASE' }),
      mv({ at: '2026-09-03T11:00:00.000Z', qtyDelta: '-10' }),
      mv({ at: '2026-09-04T09:00:00.000Z', qtyDelta: '-4' }),
    ])
    expect(reg.entries.map((e) => e.balanceAfter)).toEqual(['30.000', '20.000', '16.000'])
    expect(reg.closing).toBe('16.000')
  })

  it('carries an OPENING balance in from before the window', () => {
    // The opening is folded from the ledger, never taken from a stored figure —
    // that is what makes a register reconstructible after a restore.
    const reg = build([
      mv({ at: '2026-08-20T10:00:00.000Z', qtyDelta: '50', reason: 'PURCHASE' }),
      mv({ at: '2026-08-29T10:00:00.000Z', qtyDelta: '-5' }),
      mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '-3' }),
    ])
    expect(reg.opening).toBe('45.000')
    expect(reg.closing).toBe('42.000')
    expect(reg.entries).toHaveLength(1)
  })

  it('ignores movements after the window', () => {
    const reg = build([
      mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '10', reason: 'PURCHASE' }),
      mv({ at: '2026-10-05T10:00:00.000Z', qtyDelta: '-10' }),
    ])
    expect(reg.closing).toBe('10.000')
    expect(reg.entries).toHaveLength(1)
  })

  it('is REPRODUCIBLE when movements share a timestamp', () => {
    /* Three strips on one bill land in the same second all day at a busy
       counter. Sorting by time alone leaves them in whatever order the engine
       returned, and the register reads differently on a second look. */
    const at = '2026-09-02T10:00:00.000Z'
    const rows = [
      mv({ id: 11, at, qtyDelta: '-1' }),
      mv({ id: 12, at, qtyDelta: '-2' }),
      mv({ id: 13, at, qtyDelta: '-3' }),
    ]
    const forward = build([...rows]).entries.map((e) => e.balanceAfter)
    const shuffled = build([rows[2]!, rows[0]!, rows[1]!]).entries.map((e) => e.balanceAfter)
    expect(shuffled).toEqual(forward)
    expect(forward).toEqual(['-1.000', '-3.000', '-6.000'])
  })

  it('splits receipts from issues, both as positive figures', () => {
    // A register has two columns, so the sign lives in the direction.
    const reg = build([
      mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '40', reason: 'PURCHASE' }),
      mv({ at: '2026-09-03T10:00:00.000Z', qtyDelta: '-6' }),
      mv({ at: '2026-09-04T10:00:00.000Z', qtyDelta: '2', reason: 'SALE_RETURN' }),
    ])
    expect(reg.received).toBe('42.000')
    expect(reg.issued).toBe('6.000')
    expect(reg.entries.map((e) => e.direction)).toEqual(['IN', 'OUT', 'IN'])
    expect(reg.entries.every((e) => !e.qty.startsWith('-'))).toBe(true)
  })

  it('FOOTS — opening plus received minus issued is the closing balance', () => {
    // The one sentence a register has to be able to state. The opening is
    // captured as the window opens rather than back-derived, so this is a check
    // and not a restatement of the fold.
    const reg = build([
      mv({ at: '2026-08-01T10:00:00.000Z', qtyDelta: '100', reason: 'PURCHASE' }),
      mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '-7' }),
      mv({ at: '2026-09-03T10:00:00.000Z', qtyDelta: '25', reason: 'PURCHASE' }),
      mv({ at: '2026-09-05T10:00:00.000Z', qtyDelta: '-13' }),
    ])
    expect(foots(reg)).toBe(true)
    expect(reg.opening).toBe('100.000')
    expect(reg.closing).toBe('105.000')
  })

  it('foots for an empty window too', () => {
    const reg = build([mv({ at: '2026-07-01T10:00:00.000Z', qtyDelta: '20', reason: 'PURCHASE' })])
    expect(reg.entries).toHaveLength(0)
    expect(reg.opening).toBe('20.000')
    expect(reg.closing).toBe('20.000')
    expect(foots(reg)).toBe(true)
  })
})

describe('reconciling against the shelf', () => {
  const rows = [
    mv({ at: '2026-09-02T10:00:00.000Z', qtyDelta: '30', reason: 'PURCHASE' }),
    mv({ at: '2026-09-03T10:00:00.000Z', qtyDelta: '-10' }),
  ]

  it('balances when the ledger ends where the stock is', () => {
    const reg = build(rows, { onHand: '20', to: TODAY })
    expect(reg.balanced).toBe(true)
    expect(reg.discrepancy).toBe('0.000')
  })

  it('reports the DIFFERENCE rather than just failing', () => {
    // "It does not tally" is not actionable. "Two more on the ledger than on the
    // shelf" is what somebody counts against.
    const reg = build(rows, { onHand: '18', to: TODAY })
    expect(reg.balanced).toBe(false)
    expect(reg.discrepancy).toBe('2.000')
  })

  it('refuses to compare a PAST window with today\'s shelf', () => {
    /* A March closing balance against a September shelf is not a discrepancy,
       it is six months of trading. Null, never `true` — reporting "balanced"
       here would be a claim with nothing behind it. */
    const reg = build(rows, { onHand: '5', from: '2026-03-01', to: '2026-03-31' })
    expect(reg.balanced).toBeNull()
    expect(reg.discrepancy).toBeNull()
  })

  it('refuses to compare when no shelf figure was supplied', () => {
    const reg = build(rows, { to: TODAY })
    expect(reg.balanced).toBeNull()
    expect(reg.onHand).toBeNull()
  })
})

describe('which register is read first', () => {
  const reg = (over: Partial<DrugRegister>): DrugRegister => ({
    medicineId: 1, brandName: 'B', schedule: 'X', from: '2026-09-01', to: '2026-09-30',
    opening: '0', entries: [], received: '0', issued: '0', closing: '0',
    onHand: '0', balanced: true, discrepancy: '0.000', ...over,
  })

  it('puts an UNBALANCED register above everything else', () => {
    // The ledger and the shelf disagreeing on a controlled drug is the single
    // thing an inspection turns on; alphabetical order buries it.
    const sorted = sortRegisters([
      reg({ brandName: 'Alprax', balanced: true }),
      reg({ brandName: 'Zolpidem', balanced: false }),
      reg({ brandName: 'Barbital', balanced: null }),
    ])
    expect(sorted.map((r) => r.brandName)).toEqual(['Zolpidem', 'Alprax', 'Barbital'])
  })

  it('does not treat "cannot compare" as a problem', () => {
    const sorted = sortRegisters([reg({ brandName: 'B', balanced: null }), reg({ brandName: 'A', balanced: true })])
    expect(sorted.map((r) => r.brandName)).toEqual(['A', 'B'])
  })
})
