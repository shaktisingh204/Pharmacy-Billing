import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLES } from '@contract'
import type { Role, User, UserLimits } from '@contract'
import { ROLE_STARTING_LIMITS, can, eligibleApprovers, evaluate, exposure, roleHas } from './users'
import {
  LOCKED_ROLES, SHIPPED_POLICY, canUnderPolicy, changeCount, holdsUnder, isChanged,
  policyChanges, policyGrants, policyWarnings, readPolicy, revertRole, serialisePolicy, setCell,
} from './rolePolicy'
import type { RolePolicy } from './rolePolicy'

/**
 * The shop's own matrix.
 *
 * The rule that has to hold above every other one is that AN UNEDITED POLICY
 * CHANGES NOTHING. `canUnderPolicy`, `evaluate`, `exposure` and the approver
 * list all grew a seam for this file to reach through, and a seam that shifts an
 * answer by one cell when nobody has touched it is worse than no seam at all —
 * every screen would be quietly deciding a different question from the one the
 * server will decide.
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
const PHARMACIST = user({ id: 3, role: 'pharmacist', name: 'Sunita' })
const CASHIER = user({ id: 5, role: 'cashier', name: 'Akib' })
const ROSTER = [OWNER, MANAGER, PHARMACIST, CASHIER]

const BY = { name: 'Harshad', at: '2026-09-08T10:00:00.000Z' }

function edit(policy: RolePolicy, role: Role, permission: (typeof PERMISSIONS)[number], granted: boolean): RolePolicy {
  const result = setCell(policy, role, permission, granted, BY)
  expect(result.ok, result.why ?? '').toBe(true)
  return result.policy
}

// ----------------------------------------------------------- the null case ---

describe('an unedited matrix', () => {
  it('is the shipped matrix, cell for cell', () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(policyGrants(SHIPPED_POLICY, role, permission)).toBe(roleHas(role, permission))
        expect(isChanged(SHIPPED_POLICY, role, permission)).toBe(false)
      }
    }
    expect(changeCount(SHIPPED_POLICY)).toBe(0)
  })

  it('answers every person exactly as `can` does', () => {
    const people = [...ROSTER, user({ id: 9, role: 'manager', isActive: false }),
      user({ id: 10, role: 'pharmacist', limits: { ...LIMITS.pharmacist, canViewCost: false } })]
    for (const u of people) {
      for (const permission of PERMISSIONS) {
        expect(canUnderPolicy(SHIPPED_POLICY, u, permission)).toBe(can(u, permission))
      }
    }
  })

  it('hands back `can` itself, so nothing pays for a predicate it does not need', () => {
    expect(holdsUnder(SHIPPED_POLICY)).toBe(can)
  })

  it('leaves `evaluate`, `exposure` and the approver list where they were', () => {
    const holds = holdsUnder(SHIPPED_POLICY)
    expect(evaluate(CASHIER, { kind: 'permission', permission: 'billing.void' }, holds))
      .toEqual(evaluate(CASHIER, { kind: 'permission', permission: 'billing.void' }))
    expect(exposure(ROSTER, holds)).toEqual(exposure(ROSTER))
    expect(eligibleApprovers(ROSTER, CASHIER, 'BILL_VOID', '1640.00', undefined, holds).map((u) => u.id))
      .toEqual(eligibleApprovers(ROSTER, CASHIER, 'BILL_VOID', '1640.00').map((u) => u.id))
  })
})

// ------------------------------------------------------------------ edits ---

describe('editing a cell', () => {
  it('grants and revokes for the role, leaving the other roles alone', () => {
    const policy = edit(SHIPPED_POLICY, 'cashier', 'billing.void', true)
    expect(policyGrants(policy, 'cashier', 'billing.void')).toBe(true)
    expect(policyGrants(policy, 'pharmacist', 'billing.void')).toBe(false)
    expect(canUnderPolicy(policy, CASHIER, 'billing.void')).toBe(true)
    expect(can(CASHIER, 'billing.void')).toBe(false)
  })

  it('drops the cell again when it is put back, so the change count stays honest', () => {
    const on = edit(SHIPPED_POLICY, 'cashier', 'billing.void', true)
    expect(changeCount(on)).toBe(1)
    const off = edit(on, 'cashier', 'billing.void', false)
    expect(changeCount(off)).toBe(0)
    expect(off.changed).toEqual({})
  })

  it('refuses the owner’s column outright', () => {
    expect(LOCKED_ROLES.has('admin')).toBe(true)
    const result = setCell(SHIPPED_POLICY, 'admin', 'settings.users', false, BY)
    expect(result.ok).toBe(false)
    expect(result.why).toMatch(/no way back/i)
    expect(result.policy).toBe(SHIPPED_POLICY)
    expect(canUnderPolicy(result.policy, OWNER, 'settings.users')).toBe(true)
  })

  it('keeps the two gates that are not the role', () => {
    /* A grant does not resurrect a disabled account, and it does not overrule
       the one trainee whose cost flag is off. */
    const policy = edit(SHIPPED_POLICY, 'cashier', 'inventory.cost_view', true)
    expect(canUnderPolicy(policy, CASHIER, 'inventory.cost_view')).toBe(false)

    const seeing = user({ id: 6, role: 'cashier', limits: { ...LIMITS.cashier, canViewCost: true } })
    expect(canUnderPolicy(policy, seeing, 'inventory.cost_view')).toBe(true)
    expect(canUnderPolicy(policy, { ...seeing, isActive: false }, 'inventory.cost_view')).toBe(false)
  })

  it('reverts one column without touching another', () => {
    let policy = edit(SHIPPED_POLICY, 'cashier', 'billing.void', true)
    policy = edit(policy, 'manager', 'billing.void', false)
    policy = revertRole(policy, 'cashier', BY)
    expect(policyGrants(policy, 'cashier', 'billing.void')).toBe(false)
    expect(policyGrants(policy, 'manager', 'billing.void')).toBe(false)
    expect(changeCount(policy)).toBe(1)
  })

  it('lists what moved, with the live headcount it lands on', () => {
    const policy = edit(SHIPPED_POLICY, 'cashier', 'billing.void', true)
    const changes = policyChanges(policy, [...ROSTER, user({ id: 6, role: 'cashier' })])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      role: 'cashier', permission: 'billing.void', granted: true, shipped: false, affected: 2,
    })
  })
})

// -------------------------------------------------------- what it costs ---

describe('reaching every screen through the seam', () => {
  it('changes who may void, who is counted, and who may sign', () => {
    const policy = edit(SHIPPED_POLICY, 'pharmacist', 'billing.void', true)
    const holds = holdsUnder(policy)

    expect(evaluate(PHARMACIST, { kind: 'permission', permission: 'billing.void' }, holds).allowed).toBe(true)
    expect(evaluate(PHARMACIST, { kind: 'permission', permission: 'billing.void' }).allowed).toBe(false)

    const voiders = exposure(ROSTER, holds).guarded.find((g) => g.spec.id === 'billing.void')
    expect(voiders?.holders.map((u) => u.id)).toEqual([1, 2, 3])

    /* And the approver list widens with it — an approver must HOLD the thing
       they are approving, and that check now reads this shop's matrix. */
    expect(eligibleApprovers(ROSTER, CASHIER, 'BILL_VOID', '1640.00', undefined, holds).map((u) => u.id))
      .toEqual([1, 2, 3])
  })

  it('takes returns away from a role, and the refund ceiling stops being consulted', () => {
    const policy = edit(SHIPPED_POLICY, 'cashier', 'billing.return', false)
    const holds = holdsUnder(policy)
    const decision = evaluate(CASHIER, { kind: 'refund', amount: '100.00' }, holds)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('REFUND_LIMIT')
    // The ask is well inside the ₹500 ceiling; the grant is what refused it.
    expect(evaluate(CASHIER, { kind: 'refund', amount: '100.00' }).allowed).toBe(true)
  })
})

// --------------------------------------------------------------- warnings ---

describe('warnings', () => {
  it('quotes the catalogue’s own words when a guarded power is handed over', () => {
    const policy = edit(SHIPPED_POLICY, 'cashier', 'billing.void', true)
    const warning = policyWarnings(policy, ROSTER).find((w) => w.id === 'granted:cashier:billing.void')
    expect(warning?.severity).toBe('danger')
    expect(warning?.detail).toMatch(/oldest till theft/i)
    expect(warning?.detail).toMatch(/1 active account/)
  })

  it('says when the shop is down to a single approver, and when it has none', () => {
    let policy = edit(SHIPPED_POLICY, 'manager', 'billing.void', false)
    const roster = [MANAGER, PHARMACIST, CASHIER, { ...OWNER, isActive: true }]
    let warning = policyWarnings(policy, roster).find((w) => w.id === 'signers:BILL_VOID')
    expect(warning?.title).toMatch(/^Only Harshad/)
    expect(warning?.severity).toBe('warning')

    /* With the owner off the roster nobody is left, and that is the state where
       a counter stands at the till with a customer and no way forward. */
    policy = edit(policy, 'pharmacist', 'billing.void', false)
    warning = policyWarnings(policy, [MANAGER, PHARMACIST, CASHIER]).find((w) => w.id === 'signers:BILL_VOID')
    expect(warning?.title).toMatch(/^Nobody can sign/)
    expect(warning?.severity).toBe('danger')
  })

  it('names a revoked essential, with the people it lands on', () => {
    const policy = edit(SHIPPED_POLICY, 'cashier', 'billing.sell', false)
    const warning = policyWarnings(policy, ROSTER).find((w) => w.id === 'revoked:cashier:billing.sell')
    expect(warning?.title).toMatch(/1 active account can no longer create a bill/i)
  })

  it('calls out a role that has been emptied while people are still in it', () => {
    let policy = SHIPPED_POLICY
    for (const permission of PERMISSIONS) {
      if (roleHas('cashier', permission)) policy = edit(policy, 'cashier', permission, false)
    }
    const warning = policyWarnings(policy, ROSTER).find((w) => w.id === 'empty:cashier')
    expect(warning?.severity).toBe('danger')
    expect(warning?.detail).toMatch(/support call/i)
  })
})

// ------------------------------------------------------------ persistence ---

describe('reading a stored matrix', () => {
  it('round-trips what it wrote', () => {
    const policy = edit(edit(SHIPPED_POLICY, 'cashier', 'billing.void', true), 'manager', 'settings.users', true)
    const back = readPolicy(serialisePolicy(policy))
    expect(back.changed).toEqual(policy.changed)
    expect(back.updatedBy).toBe('Harshad')
  })

  it('treats anything it cannot read as the shipped matrix', () => {
    expect(readPolicy(null)).toEqual(SHIPPED_POLICY)
    expect(readPolicy('')).toEqual(SHIPPED_POLICY)
    expect(readPolicy('{oops')).toEqual(SHIPPED_POLICY)
    expect(readPolicy('"a string"')).toEqual(SHIPPED_POLICY)
    expect(readPolicy('null')).toEqual(SHIPPED_POLICY)
  })

  it('drops cells a newer contract has renamed away, rather than carrying them', () => {
    const stored = JSON.stringify({
      changed: {
        'cashier:billing.void': true,
        'cashier:billing.teleport': true,
        'wizard:billing.void': true,
        'manager:billing.sell': 'yes',
        /* Already the shipped value: stored by an older build that recorded
           every cell, and it must not inflate the change count. */
        'manager:billing.void': true,
        /* The locked column, whatever the file says. */
        'admin:settings.users': false,
      },
      updatedAt: 5,
      updatedBy: null,
    })
    const policy = readPolicy(stored)
    expect(policy.changed).toEqual({ 'cashier:billing.void': true })
    expect(changeCount(policy)).toBe(1)
    expect(policy.updatedAt).toBeNull()
    expect(canUnderPolicy(policy, OWNER, 'settings.users')).toBe(true)
  })
})
