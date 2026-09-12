import { describe, expect, it } from 'vitest'
import type { AuditAction, AuditEntry, Override, Role, User, UserLimits } from '@contract'
import { ROLE_STARTING_LIMITS } from './users'
import { SHIPPED_POLICY, holdsUnder, setCell } from './rolePolicy'
import {
  activityFor, approvalQueue, approvalTotals, bucketOf, clearReview, counterDays, markReview,
  moneyPower, readReviews, reviewCounts, shiftsFrom,
} from './roster'

/**
 * Shifts, timelines, signatures and rupees — all of it derived.
 *
 * Nothing in this module is stored by anybody. The value of that is that it
 * cannot drift out of step with the trail, and the risk of it is that a fold
 * with an off-by-one in it looks like a shop with a problem: a till that reads
 * two people when one stood there, a drawer variance counted twice, an override
 * filed against the wrong name. Each of those is asserted below on a case a
 * person can check by reading it.
 */

const LIMITS: Record<Role, UserLimits> = ROLE_STARTING_LIMITS

function user(over: Partial<User> & { role: Role; id: number }): User {
  return {
    storeId: 1,
    name: `User ${over.id}`,
    username: `user${over.id}`,
    pharmacistRegNo: over.role === 'pharmacist' ? 'MSPC/2011/000001' : null,
    limits: { ...LIMITS[over.role] },
    isActive: true,
    lastActiveAt: null,
    ...over,
  }
}

const OWNER = user({ id: 1, role: 'admin', name: 'Harshad' })
const MANAGER = user({ id: 2, role: 'manager', name: 'Prakash' })
const CASHIER = user({ id: 5, role: 'cashier', name: 'Akib' })
const LEAVER = user({ id: 7, role: 'cashier', name: 'Vinod', isActive: false })

let nextId = 0

interface RowInput {
  at: string
  by?: User
  action: AuditAction
  amount?: string
  terminal?: number | null
  override?: Partial<Override> & { approverId: number; requesterId: number }
}

function row(input: RowInput): AuditEntry {
  const actor = input.by ?? CASHIER
  nextId += 1
  return {
    id: nextId,
    storeId: 1,
    at: input.at,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: input.action,
    entity: 'Bill',
    entityRef: `RX-${nextId}`,
    summary: 'A row',
    changes: [],
    terminalId: input.terminal === undefined ? 1 : input.terminal,
    amount: input.amount ?? null,
    override: input.override
      ? {
        requesterName: 'requester',
        approverName: 'approver',
        reasonCode: 'DISCOUNT_LIMIT',
        requested: '22',
        limit: '5',
        note: null,
        ...input.override,
      }
      : null,
  }
}

/** Local wall-clock, so `localDay` files the row on the day it was written for. */
const on = (day: string, hh: number, mm: number): string =>
  new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).toISOString()

// ------------------------------------------------------------------ shifts ---

describe('folding the trail into shifts', () => {
  it('is one shift per person per till per day, however quiet the afternoon', () => {
    const rows = [
      row({ at: on('2026-09-08', 9, 2), action: 'LOGIN' }),
      row({ at: on('2026-09-08', 10, 18), action: 'SALE_POSTED', amount: '1284.50' }),
      // Four hours of nothing. A lunch lull is not a handover.
      row({ at: on('2026-09-08', 16, 30), action: 'SALE_POSTED', amount: '215.50' }),
      row({ at: on('2026-09-08', 20, 15), action: 'CASH_COUNTED', amount: '-120.00' }),
    ]
    const shifts = shiftsFrom(rows)
    expect(shifts).toHaveLength(1)
    expect(shifts[0]).toMatchObject({
      day: '2026-09-08', terminalId: 1, actorId: 5, signedIn: true,
      bills: 2, takings: '1500.00', drawerVariance: '-120.00',
    })
    expect(shifts[0]?.minutes).toBe(11 * 60 + 13)
  })

  it('splits when the till changes, and when the day does', () => {
    const rows = [
      row({ at: on('2026-09-08', 9, 0), action: 'SALE_POSTED', amount: '100.00', terminal: 1 }),
      row({ at: on('2026-09-08', 15, 0), action: 'SALE_POSTED', amount: '200.00', terminal: 2 }),
      row({ at: on('2026-09-07', 9, 0), action: 'SALE_POSTED', amount: '300.00', terminal: 1 }),
    ]
    const shifts = shiftsFrom(rows)
    expect(shifts.map((s) => `${s.day}/${s.terminalId}`))
      .toEqual(['2026-09-08/1', '2026-09-08/2', '2026-09-07/1'])
  })

  it('leaves back-room work out of the counter rota', () => {
    const rows = [
      row({ at: on('2026-09-08', 11, 0), action: 'STOCK_ADJUSTED', amount: '-84.00', terminal: null }),
    ]
    expect(shiftsFrom(rows)).toEqual([])
  })

  it('counts the voids and the signatures, and keeps the last drawer count', () => {
    const rows = [
      row({ at: on('2026-09-08', 19, 52), action: 'SALE_VOIDED', amount: '1640.00', override: { approverId: 2, requesterId: 5 } }),
      row({ at: on('2026-09-08', 20, 0), action: 'CASH_COUNTED', amount: '-1640.00' }),
      row({ at: on('2026-09-08', 20, 6), action: 'CASH_COUNTED', amount: '-120.00' }),
      row({ at: on('2026-09-08', 12, 44), action: 'REFUND_ISSUED', amount: '1180.00' }),
    ]
    const shift = shiftsFrom(rows)[0]
    expect(shift).toMatchObject({
      voids: 1, voided: '1640.00', refunds: 1, refunded: '1180.00',
      overrides: 1, drawerVariance: '-120.00', signedIn: false,
    })
  })

  it('adds a day up across its tills, and only counts a drawer that was counted', () => {
    const rows = [
      row({ at: on('2026-09-08', 10, 0), action: 'SALE_POSTED', amount: '1000.00', terminal: 1 }),
      row({ at: on('2026-09-08', 20, 0), action: 'CASH_COUNTED', amount: '-120.00', terminal: 1 }),
      row({ at: on('2026-09-08', 11, 0), by: MANAGER, action: 'SALE_POSTED', amount: '500.50', terminal: 2 }),
    ]
    const [day] = counterDays(shiftsFrom(rows))
    expect(day).toMatchObject({
      day: '2026-09-08', tills: 2, people: 2, bills: 2, takings: '1500.50', variance: '-120.00',
    })

    const uncounted = counterDays(shiftsFrom([
      row({ at: on('2026-09-08', 10, 0), action: 'SALE_POSTED', amount: '1000.00' }),
    ]))
    expect(uncounted[0]?.variance).toBeNull()
  })
})

// ---------------------------------------------------------------- activity ---

describe('one person’s fortnight', () => {
  const rows = [
    row({ at: on('2026-09-08', 10, 0), action: 'SALE_POSTED', amount: '1000.00' }),
    row({ at: on('2026-09-08', 11, 0), action: 'SALE_VOIDED', amount: '-500.00', override: { approverId: 2, requesterId: 5 } }),
    row({ at: on('2026-09-07', 9, 0), action: 'LOGIN' }),
    row({ at: on('2026-09-06', 9, 0), by: MANAGER, action: 'RATE_EDITED', override: { approverId: 1, requesterId: 2 } }),
    // Signed by the manager for the cashier: never under the cashier's own name.
    row({ at: on('2026-09-05', 9, 0), action: 'REFUND_ISSUED', amount: '1180.00', override: { approverId: 2, requesterId: 5 } }),
  ]

  it('separates what they did from what they signed for', () => {
    const mine = activityFor(rows, shiftsFrom(rows), CASHIER.id)
    expect(mine.total).toBe(4)
    expect(mine.requested).toBe(2)
    expect(mine.approved).toBe(0)

    const boss = activityFor(rows, shiftsFrom(rows), MANAGER.id)
    expect(boss.total).toBe(1)
    // Two of the cashier's rows carry Prakash's signature, and neither is his row.
    expect(boss.approved).toBe(2)
    // His own override was signed by the owner, so it counts as asked, not signed.
    expect(boss.requested).toBe(1)
  })

  it('leads with the actions that cost money, and adds rupees as magnitudes', () => {
    const mine = activityFor(rows, shiftsFrom(rows), CASHIER.id)
    expect(mine.breakdown[0]?.loss).toBe(true)
    expect(mine.lossCount).toBe(2)
    // 1000 + 500 + 1180, the void counted at its size rather than its sign.
    expect(mine.moneyTouched).toBe('2680.00')
    expect(mine.entries[0]?.at).toBe(on('2026-09-08', 11, 0))
    expect(mine.lastSeen).toBe(on('2026-09-08', 11, 0))
    expect(mine.firstSeen).toBe(on('2026-09-05', 9, 0))
  })

  it('is empty rather than absent for somebody who has done nothing', () => {
    const none = activityFor(rows, shiftsFrom(rows), 99)
    expect(none.total).toBe(0)
    expect(none.moneyTouched).toBe('0.00')
    expect(none.lastSeen).toBeNull()
  })
})

// --------------------------------------------------------------- approvals ---

describe('re-checking the signatures', () => {
  const TODAY = '2026-09-08'
  const roster = [OWNER, MANAGER, CASHIER, LEAVER]

  it('leaves a sound one alone', () => {
    const rows = [row({
      at: on('2026-09-08', 11, 41), action: 'DISCOUNT_APPLIED', amount: '3200.00',
      override: { approverId: 2, requesterId: 5, reasonCode: 'DISCOUNT_LIMIT', requested: '18', limit: '5' },
    })]
    const [item] = approvalQueue(rows, roster, TODAY)
    expect(item?.standing).toBe('stands')
    expect(item?.why).toBeNull()
    expect(item?.atStake).toBe('3200.00')
    expect(item?.costly).toBe(true)
  })

  it('flags a signature past the approver’s own ceiling today', () => {
    const rows = [row({
      at: on('2026-09-08', 11, 41), action: 'DISCOUNT_APPLIED', amount: '3200.00',
      override: { approverId: 2, requesterId: 5, reasonCode: 'DISCOUNT_LIMIT', requested: '22', limit: '5' },
    })]
    const [item] = approvalQueue(rows, roster, TODAY)
    expect(item?.standing).toBe('approver-cannot')
    expect(item?.why).toMatch(/own ceiling is 20%/)
    expect(item?.why).toMatch(/stood when it was given/)
  })

  it('flags an approver who has since left, and a pairing it cannot resolve', () => {
    const rows = [
      row({ at: on('2026-09-06', 9, 0), action: 'SALE_VOIDED', amount: '2380.00', override: { approverId: 7, requesterId: 5, reasonCode: 'BILL_VOID', requested: '2380.00', limit: '0' } }),
      row({ at: on('2026-09-05', 9, 0), action: 'SALE_VOIDED', amount: '99.00', override: { approverId: 42, requesterId: 5, reasonCode: 'BILL_VOID', requested: '99.00', limit: '0' } }),
    ]
    const items = approvalQueue(rows, roster, TODAY)
    expect(items.map((i) => i.standing).sort()).toEqual(['approver-disabled', 'approver-gone'])
  })

  it('names a self-approval, which nothing in this app is allowed to write', () => {
    const rows = [row({
      at: on('2026-09-08', 9, 0), action: 'SALE_VOIDED', amount: '500.00',
      override: { approverId: 5, requesterId: 5, reasonCode: 'BILL_VOID', requested: '500.00', limit: '0' },
    })]
    expect(approvalQueue(rows, roster, TODAY)[0]?.standing).toBe('self-approved')
  })

  it('floats everything questionable above the sound rows, then reads newest first', () => {
    const rows = [
      row({ at: on('2026-09-08', 12, 0), action: 'DISCOUNT_APPLIED', amount: '100.00', override: { approverId: 2, requesterId: 5, requested: '18', limit: '5' } }),
      row({ at: on('2026-09-08', 13, 0), action: 'DISCOUNT_APPLIED', amount: '200.00', override: { approverId: 2, requesterId: 5, requested: '18', limit: '5' } }),
      row({ at: on('2026-09-01', 9, 0), action: 'DISCOUNT_APPLIED', amount: '300.00', override: { approverId: 2, requesterId: 5, requested: '99', limit: '5' } }),
    ]
    const items = approvalQueue(rows, roster, TODAY)
    expect(items.map((i) => i.entry.amount)).toEqual(['300.00', '200.00', '100.00'])

    const totals = approvalTotals(items)
    expect(totals).toEqual({ count: 3, atStake: '600.00', questionable: 1 })
  })

  it('follows the shop’s own matrix when it has one', () => {
    /* Prakash signed a void. Take voids away from managers and the same row
       stops standing, without anything about the row itself having changed. */
    const rows = [row({
      at: on('2026-09-08', 9, 0), action: 'SALE_VOIDED', amount: '1640.00',
      override: { approverId: 2, requesterId: 5, reasonCode: 'BILL_VOID', requested: '1640.00', limit: '0' },
    })]
    expect(approvalQueue(rows, roster, TODAY)[0]?.standing).toBe('stands')

    const edited = setCell(SHIPPED_POLICY, 'manager', 'billing.void', false, { name: 'Harshad', at: TODAY })
    const [item] = approvalQueue(rows, roster, TODAY, holdsUnder(edited.policy))
    expect(item?.standing).toBe('approver-cannot')
    expect(item?.why).toMatch(/cannot void a posted bill/i)
  })
})

// ------------------------------------------------------------- the reviews ---

describe('the review ledger', () => {
  it('marks, re-marks and clears one entry', () => {
    const mark = { state: 'flagged' as const, at: '2026-09-08T10:00:00.000Z', by: 'Harshad', note: '  ask Prakash  ' }
    let ledger = markReview({}, 12, mark)
    expect(bucketOf(ledger, 12)).toBe('flagged')
    expect(ledger['12']?.note).toBe('ask Prakash')

    ledger = markReview(ledger, 12, { ...mark, state: 'reviewed', note: '' })
    expect(bucketOf(ledger, 12)).toBe('reviewed')
    expect(ledger['12']?.note).toBeNull()

    ledger = clearReview(ledger, 12)
    expect(bucketOf(ledger, 12)).toBe('unread')
  })

  it('counts the queue into its three buckets', () => {
    const rows = [
      row({ at: on('2026-09-08', 9, 0), action: 'SALE_VOIDED', amount: '1.00', override: { approverId: 2, requesterId: 5 } }),
      row({ at: on('2026-09-08', 10, 0), action: 'SALE_VOIDED', amount: '2.00', override: { approverId: 2, requesterId: 5 } }),
      row({ at: on('2026-09-08', 11, 0), action: 'SALE_VOIDED', amount: '3.00', override: { approverId: 2, requesterId: 5 } }),
    ]
    const items = approvalQueue(rows, [OWNER, MANAGER, CASHIER], '2026-09-08')
    const ledger = markReview({}, items[0]!.entry.id, {
      state: 'reviewed', at: '2026-09-08T10:00:00.000Z', by: 'Harshad', note: null,
    })
    expect(reviewCounts(items, ledger)).toEqual({ unread: 2, reviewed: 1, flagged: 0 })
  })

  it('discards a stored ledger it cannot vouch for, key by key', () => {
    expect(readReviews(null)).toEqual({})
    expect(readReviews('{oops')).toEqual({})
    expect(readReviews(JSON.stringify({
      '7': { state: 'reviewed', at: '2026-09-08T10:00:00.000Z', by: 'Harshad', note: 'fine' },
      '8': { state: 'shrugged' },
      abc: { state: 'reviewed' },
      '9': 'reviewed',
    }))).toEqual({
      '7': { state: 'reviewed', at: '2026-09-08T10:00:00.000Z', by: 'Harshad', note: 'fine' },
    })
  })
})

// ------------------------------------------------------------ money power ---

describe('what the roster costs', () => {
  const roster = [OWNER, MANAGER, CASHIER, LEAVER]

  it('adds the unaided refund ceilings, and separates the owner’s from the counter’s', () => {
    const power = moneyPower(roster, [])
    // 1,000,000 owner + 10,000 manager + 500 cashier. Vinod is disabled.
    expect(power.refundAuthority).toBe('1010500.00')
    expect(power.ownerAuthority).toBe('1000000.00')
    expect(power.counterAuthority).toBe('10500.00')
    expect(power.activeAccounts).toBe(3)
  })

  it('counts holders through the person, not the role', () => {
    const blind = user({ id: 3, role: 'pharmacist', limits: { ...LIMITS.pharmacist, canViewCost: false } })
    const power = moneyPower([...roster, blind], [])
    const cost = power.powers.find((p) => p.spec.id === 'inventory.cost_view')
    expect(cost?.holders.map((u) => u.id)).toEqual([1, 2])
    expect(cost?.logged).toBe(false)
    expect(power.costViewers).toBe(2)
  })

  it('attaches what each logged power actually moved in the window', () => {
    const rows = [
      row({ at: on('2026-09-08', 9, 0), action: 'SALE_VOIDED', amount: '1640.00' }),
      row({ at: on('2026-09-07', 9, 0), action: 'SALE_VOIDED', amount: '-2380.00' }),
      row({ at: on('2026-09-06', 9, 0), action: 'RATE_EDITED' }),
    ]
    const power = moneyPower(roster, rows)
    expect(power.powers.find((p) => p.spec.id === 'billing.void')).toMatchObject({
      used: 2, moved: '4020.00', logged: true,
    })
    expect(power.powers.find((p) => p.spec.id === 'billing.rate_edit')).toMatchObject({
      used: 1, moved: '0.00',
    })
  })

  it('follows the shop’s matrix, so a granted power shows up in the exposure', () => {
    const edited = setCell(SHIPPED_POLICY, 'cashier', 'billing.void', true, { name: 'Harshad', at: '2026-09-08' })
    const power = moneyPower(roster, [], holdsUnder(edited.policy))
    expect(power.powers.find((p) => p.spec.id === 'billing.void')?.holders.map((u) => u.id))
      .toEqual([1, 2, 5])
  })
})
