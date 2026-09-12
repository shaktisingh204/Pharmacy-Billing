import { describe, expect, it } from 'vitest'
import { ApiError, PERMISSIONS, ROLES } from '@contract'
import type { AuditEntry, Role, User, UserLimits } from '@contract'
import * as D from '@/domain/decimal'
import {
  PERMISSION_CATALOGUE, ROLE_CEILING, ROLE_GRANTS, ROLE_STARTING_LIMITS,
  applyUserUpdate, auditLabel, buildOverride, can, canApprove, diffUsers, eligibleApprovers,
  evaluate, exposure, filterAudit, permissionGroups, prepareUser, roleHas,
} from './users'

/**
 * Access control, exercised as values.
 *
 * Three groups of these encode rules that are silently wrong rather than loudly
 * broken when they are got backwards — a cashier who quietly holds a permission
 * nobody reviewed, a ceiling that leaks because it was compared as a float, and
 * an approval the requester was allowed to sign themselves — so each is
 * asserted on a case a person can check by reading it.
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

const OWNER = user({ id: 1, role: 'admin', name: 'Harshad', username: 'harshad' })
const MANAGER = user({ id: 2, role: 'manager', name: 'Prakash', username: 'prakash' })
const PHARMACIST = user({ id: 3, role: 'pharmacist', name: 'Sunita', username: 'sunita' })
const CASHIER = user({ id: 5, role: 'cashier', name: 'Akib', username: 'akib' })

// -------------------------------------------------------------- the matrix ---

describe('the permission matrix', () => {
  it('describes every permission in the contract, exactly once', () => {
    expect(PERMISSION_CATALOGUE.map((p) => p.id)).toEqual([...PERMISSIONS])
    expect(new Set(PERMISSION_CATALOGUE.map((p) => p.id)).size).toBe(PERMISSIONS.length)
  })

  it('groups without losing or reordering a permission', () => {
    const flat = permissionGroups().flatMap((g) => g.permissions.map((p) => p.id))
    expect(flat).toEqual([...PERMISSIONS])
    // Each area appears once: a band split in two would read as two policies.
    const areas = permissionGroups().map((g) => g.area)
    expect(new Set(areas).size).toBe(areas.length)
  })

  it('grants an admin everything', () => {
    for (const p of PERMISSIONS) expect(roleHas('admin', p)).toBe(true)
  })

  /* Guards the unreachable branch in `evaluate`: the refund ceiling is only a
     control while the role it belongs to actually grants returns. */
  it('grants every role the return the refund ceiling bounds', () => {
    for (const role of ROLES) expect(roleHas(role, 'billing.return')).toBe(true)
  })

  /* The row this whole screen exists for. Each of these has cost some shop
     money, so each is named individually rather than counted. */
  it.each([
    'billing.rate_edit',
    'billing.void',
    'billing.backdate',
    'inventory.cost_view',
    'purchases.rate_view',
    'reports.margin',
  ] as const)('denies a cashier %s', (permission) => {
    expect(roleHas('cashier', permission)).toBe(false)
    expect(can(CASHIER, permission)).toBe(false)
  })

  it('still lets a cashier bill and look a customer up', () => {
    expect(can(CASHIER, 'billing.sell')).toBe(true)
    expect(can(CASHIER, 'billing.discount')).toBe(true)
    expect(can(CASHIER, 'customers.view')).toBe(true)
    expect(can(CASHIER, 'inventory.view')).toBe(true)
  })

  it('marks exactly the guarded permissions, and says why', () => {
    const guarded = PERMISSION_CATALOGUE.filter((p) => p.guard !== null)
    expect(guarded.map((p) => p.id)).toEqual([
      'billing.rate_edit', 'billing.void', 'billing.backdate',
      'inventory.cost_view', 'purchases.rate_view', 'reports.margin',
    ])
    for (const p of guarded) expect(p.guard?.length ?? 0).toBeGreaterThan(20)
  })

  it('gates cost twice: the role opens it and the flag can still close it', () => {
    const trainee = user({ id: 4, role: 'pharmacist', limits: { ...LIMITS.pharmacist, canViewCost: false } })
    expect(roleHas('pharmacist', 'inventory.cost_view')).toBe(true)
    expect(can(trainee, 'inventory.cost_view')).toBe(false)
    // …and the derived number goes with it, or the same figure is denied in one
    // column and printed in another.
    expect(can(trainee, 'reports.margin')).toBe(false)
    expect(can(trainee, 'purchases.rate_view')).toBe(false)
    expect(can(trainee, 'billing.sell')).toBe(true)
  })

  it('gives a disabled account nothing at all', () => {
    const gone = { ...MANAGER, isActive: false }
    for (const p of ROLE_GRANTS.manager) expect(can(gone, p)).toBe(false)
  })
})

// -------------------------------------------------------------- the limits ---

describe('per-user limits', () => {
  it('keeps every starting limit at or under its role ceiling', () => {
    for (const role of ROLES) {
      const start = ROLE_STARTING_LIMITS[role]
      const cap = ROLE_CEILING[role]
      expect(D.lte(D.dec(start.maxDiscountPct), D.dec(cap.maxDiscountPct))).toBe(true)
      expect(D.lte(D.dec(start.maxRefundAmount), D.dec(cap.maxRefundAmount))).toBe(true)
      expect(start.backdateDays).toBeLessThanOrEqual(cap.backdateDays)
      if (!cap.canViewCost) expect(start.canViewCost).toBe(false)
    }
  })

  it('allows a discount exactly at the ceiling and refuses the next paisa', () => {
    const at = evaluate(CASHIER, { kind: 'discount', pct: '5' })
    expect(at.allowed).toBe(true)

    /* Compared as decimals, not floats. 5.01 against 5 is the case a
       `parseFloat` comparison gets right and 0.1 + 0.2 does not. */
    const over = evaluate(CASHIER, { kind: 'discount', pct: '5.01' })
    expect(over.allowed).toBe(false)
    expect(over.reason).toBe('DISCOUNT_LIMIT')
    expect(over.overridable).toBe(true)
    expect(over.limit).toBe('5')
  })

  it('names the refund ceiling it exceeded', () => {
    const d = evaluate(CASHIER, { kind: 'refund', amount: '1180.00' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('REFUND_LIMIT')
    expect(d.limit).toBe('500.00')
  })

  it('lets a cashier refund inside their few hundred rupees', () => {
    expect(evaluate(CASHIER, { kind: 'refund', amount: '500.00' }).allowed).toBe(true)
  })

  it('measures backdating in whole days against the person, not the role', () => {
    const today = '2026-09-08'
    expect(evaluate(PHARMACIST, { kind: 'backdate', date: '2026-09-07', today }).allowed).toBe(true)
    const far = evaluate(PHARMACIST, { kind: 'backdate', date: '2026-09-05', today })
    expect(far.allowed).toBe(false)
    expect(far.reason).toBe('BACKDATE')
    expect(evaluate(CASHIER, { kind: 'backdate', date: today, today }).allowed).toBe(true)
    expect(evaluate(CASHIER, { kind: 'backdate', date: '2026-09-07', today }).allowed).toBe(false)
  })

  it('treats forward-dating as a refusal no signature can lift', () => {
    const d = evaluate(MANAGER, { kind: 'backdate', date: '2026-09-20', today: '2026-09-08' })
    expect(d.allowed).toBe(false)
    expect(d.overridable).toBe(false)
    expect(d.reason).toBeNull()
  })

  it('refuses a disabled account without offering an override', () => {
    const d = evaluate({ ...CASHIER, isActive: false }, { kind: 'discount', pct: '1' })
    expect(d.allowed).toBe(false)
    expect(d.overridable).toBe(false)
  })

  it('treats an unreadable ceiling as no ceiling at all', () => {
    // A half-migrated row must never answer "yes, within limit" with confidence.
    const broken = user({ id: 9, role: 'cashier', limits: { ...LIMITS.cashier, maxDiscountPct: 'n/a' } })
    expect(evaluate(broken, { kind: 'discount', pct: '1' }).allowed).toBe(false)
  })
})

// ------------------------------------------------------------ the override ---

describe('manager override', () => {
  /* 18% off, asked for by a cashier whose ceiling is 5. Inside the manager's
     own 20% and well inside the owner's — which is what makes the two ceiling
     cases below distinguishable rather than a single yes/no. */
  const decision = evaluate(CASHIER, { kind: 'discount', pct: '18' })

  it('refuses an approver who is the requester (invariant I22)', () => {
    const self = canApprove(CASHIER, CASHIER, 'DISCOUNT_LIMIT', '18')
    expect(self.ok).toBe(false)
    expect(self.why).toMatch(/never be the requester/i)
  })

  it('refuses an approver who could not do it themselves', () => {
    // A pharmacist cannot void a bill, so a pharmacist cannot sign one off.
    expect(canApprove(PHARMACIST, CASHIER, 'BILL_VOID', '1640.00').ok).toBe(false)
    expect(canApprove(MANAGER, CASHIER, 'BILL_VOID', '1640.00').ok).toBe(true)
  })

  it('refuses an approver whose own ceiling is lower than the ask', () => {
    expect(canApprove(MANAGER, CASHIER, 'DISCOUNT_LIMIT', '18').ok).toBe(true)
    expect(canApprove(MANAGER, CASHIER, 'DISCOUNT_LIMIT', '22').ok).toBe(false)
    // The owner's ceiling is 100%, so the same ask stands.
    expect(canApprove(OWNER, CASHIER, 'DISCOUNT_LIMIT', '22').ok).toBe(true)
  })

  it('refuses a disabled approver', () => {
    expect(canApprove({ ...MANAGER, isActive: false }, CASHIER, 'DISCOUNT_LIMIT', '18').ok).toBe(false)
  })

  /* The ceiling case that reads as a pass unless the units are converted: the
     ask is a DATE, the reach is a count of days, and `Number('2026-08-01')` is
     NaN. Without today in hand there is nothing to compare, and nothing to
     compare is a refusal. */
  it('measures a backdate approval in the approver’s own days, not the date string', () => {
    const today = '2026-09-08'
    const tight = { ...MANAGER, limits: { ...MANAGER.limits, backdateDays: 1 } }
    const asked = evaluate(CASHIER, { kind: 'backdate', date: '2026-08-01', today })
    expect(asked.reason).toBe('BACKDATE')
    expect(asked.requested).toBe('2026-08-01')

    // 38 days back, against a one-day reach.
    expect(canApprove(tight, CASHIER, 'BACKDATE', asked.requested, today).ok).toBe(false)
    // The owner's year covers it; the manager on his default seven days does not.
    expect(canApprove(OWNER, CASHIER, 'BACKDATE', asked.requested, today).ok).toBe(true)
    expect(canApprove(MANAGER, CASHIER, 'BACKDATE', asked.requested, today).ok).toBe(false)
    expect(eligibleApprovers([OWNER, tight, CASHIER], CASHIER, 'BACKDATE', asked.requested, today)
      .map((u) => u.id)).toEqual([OWNER.id])

    // Three days back is inside the manager's seven.
    const near = evaluate(CASHIER, { kind: 'backdate', date: '2026-09-05', today })
    expect(canApprove(MANAGER, CASHIER, 'BACKDATE', near.requested, today).ok).toBe(true)

    // A day count still reads as one, and an unmeasurable ask is refused.
    expect(canApprove(MANAGER, CASHIER, 'BACKDATE', '2').ok).toBe(true)
    expect(canApprove(MANAGER, CASHIER, 'BACKDATE', '30').ok).toBe(false)
    expect(canApprove(MANAGER, CASHIER, 'BACKDATE', '2026-08-01').ok).toBe(false)
  })

  it('never offers the requester as an eligible approver', () => {
    const roster = [OWNER, MANAGER, PHARMACIST, CASHIER]
    const eligible = eligibleApprovers(roster, CASHIER, 'DISCOUNT_LIMIT', '18')
    expect(eligible.map((u) => u.id)).toEqual([OWNER.id, MANAGER.id])
    expect(eligible.some((u) => u.id === CASHIER.id)).toBe(false)

    // And a manager asking for the same thing cannot land on themselves either.
    const forManager = eligibleApprovers(roster, MANAGER, 'DISCOUNT_LIMIT', '18')
    expect(forManager.map((u) => u.id)).toEqual([OWNER.id])

    // An ask above the manager's own ceiling leaves only the owner.
    expect(eligibleApprovers(roster, CASHIER, 'DISCOUNT_LIMIT', '22').map((u) => u.id))
      .toEqual([OWNER.id])
  })

  it('records both identities, the reason code and both numbers', () => {
    const record = buildOverride(MANAGER, CASHIER, decision, '  Standing arrangement  ')
    expect(record).toMatchObject({
      requesterId: CASHIER.id,
      requesterName: 'Akib',
      approverId: MANAGER.id,
      approverName: 'Prakash',
      reasonCode: 'DISCOUNT_LIMIT',
      requested: '18',
      limit: '5',
      note: 'Standing arrangement',
    })
  })

  it('refuses to write a record for a pairing it would not allow', () => {
    expect(() => buildOverride(CASHIER, CASHIER, decision, null)).toThrow(ApiError)
    // Nothing to approve is also an error: a row saying a control was applied
    // when none was needed is worse than no row.
    const fine = evaluate(CASHIER, { kind: 'discount', pct: '2' })
    expect(() => buildOverride(MANAGER, CASHIER, fine, null)).toThrow(/needs an approval/i)
  })
})

// -------------------------------------------------------------- validation ---

describe('preparing an account', () => {
  const roster = [OWNER, MANAGER, PHARMACIST, CASHIER]

  it('lowercases the username and refuses a duplicate in any case', () => {
    const fields = prepareUser(
      { name: '  Rekha   Pawar ', username: 'Rekha', role: 'cashier', limits: LIMITS.cashier },
      roster,
    )
    expect(fields.name).toBe('Rekha Pawar')
    expect(fields.username).toBe('rekha')

    expect(() => prepareUser(
      { name: 'Someone Else', username: 'AKIB', role: 'cashier', limits: LIMITS.cashier },
      roster,
    )).toThrow(/already signs in/i)
  })

  it('requires a registration number from a pharmacist', () => {
    expect(() => prepareUser(
      { name: 'New Pharmacist', username: 'newrp', role: 'pharmacist', limits: LIMITS.pharmacist },
      roster,
    )).toThrow(/registration number/i)

    const ok = prepareUser(
      {
        name: 'New Pharmacist', username: 'newrp', role: 'pharmacist',
        pharmacistRegNo: ' MSPC/2020/044120 ', limits: LIMITS.pharmacist,
      },
      roster,
    )
    expect(ok.pharmacistRegNo).toBe('MSPC/2020/044120')
  })

  it('refuses a limit above the role ceiling instead of clamping it', () => {
    // Clamping would leave a ceiling nobody can name the value of.
    expect(() => prepareUser(
      {
        name: 'Wide Cashier', username: 'wide', role: 'cashier',
        limits: { ...LIMITS.cashier, maxDiscountPct: '60' },
      },
      roster,
    )).toThrow(/may not exceed 10%/i)
  })

  it('refuses to show cost to a role that never sees it', () => {
    expect(() => prepareUser(
      {
        name: 'Curious', username: 'curious', role: 'cashier',
        limits: { ...LIMITS.cashier, canViewCost: true },
      },
      roster,
    )).toThrow(/not visible to a cashier/i)
  })

  it('refuses to disable the last admin', () => {
    expect(() => prepareUser(
      { name: OWNER.name, username: OWNER.username, role: 'admin', limits: LIMITS.admin, isActive: false },
      [MANAGER, PHARMACIST, CASHIER],
    )).toThrow(/only admin left/i)

    // With a second admin on the roster it is an ordinary edit.
    const second = user({ id: 8, role: 'admin', username: 'second' })
    expect(() => prepareUser(
      { name: OWNER.name, username: OWNER.username, role: 'admin', limits: LIMITS.admin, isActive: false },
      [second, MANAGER],
    )).not.toThrow()
  })
})

describe('editing an account', () => {
  it('re-seeds the limits on a role change rather than carrying them across', () => {
    // The hole this closes: demote a manager and their 20% ceiling would follow
    // them to the cashier's till. Neither field is wrong alone; the pair is.
    const demoted = applyUserUpdate(MANAGER, { role: 'cashier' }, [OWNER, CASHIER])
    expect(demoted.role).toBe('cashier')
    expect(demoted.limits).toEqual(ROLE_STARTING_LIMITS.cashier)
  })

  it('keeps tuned limits when the role does not move', () => {
    const tuned = { ...CASHIER, limits: { ...LIMITS.cashier, maxDiscountPct: '7' } }
    const renamed = applyUserUpdate(tuned, { name: 'Akib S' }, [OWNER])
    expect(renamed.limits.maxDiscountPct).toBe('7')
  })

  /* Disabling the last admin is refused; demoting them is the same locked shop
     reached by a door that only reads `isActive`. Both have to be shut, or the
     account that makes the change is the one it locks out. */
  it('refuses to move the last admin off admin', () => {
    expect(() => applyUserUpdate(OWNER, { role: 'manager' }, [MANAGER, PHARMACIST, CASHIER]))
      .toThrow(/only admin left/i)
    expect(() => applyUserUpdate(OWNER, { isActive: false }, [MANAGER, CASHIER]))
      .toThrow(/only admin left/i)

    // With a second live admin it is an ordinary edit, and a disabled one is
    // not a second admin.
    const second = user({ id: 8, role: 'admin', username: 'second' })
    expect(applyUserUpdate(OWNER, { role: 'manager' }, [second, MANAGER]).role).toBe('manager')
    expect(() => applyUserUpdate(OWNER, { role: 'manager' }, [{ ...second, isActive: false }]))
      .toThrow(/only admin left/i)

    // An edit that leaves the role alone is untouched by any of it.
    expect(applyUserUpdate(OWNER, { name: 'Harshad K' }, [MANAGER]).name).toBe('Harshad K')
  })

  it('re-validates the whole record, not just the patch', () => {
    expect(() => applyUserUpdate(
      MANAGER,
      { role: 'cashier', limits: { ...LIMITS.manager } },
      [OWNER],
    )).toThrow(ApiError)
  })

  it('reports the before and the after of every field that moved', () => {
    const after = applyUserUpdate(
      CASHIER,
      { limits: { ...LIMITS.cashier, maxDiscountPct: '8', maxRefundAmount: '900.00' } },
      [OWNER],
    )
    expect(diffUsers(CASHIER, after)).toEqual([
      { field: 'Max discount %', before: '5', after: '8' },
      { field: 'Max refund ₹', before: '500.00', after: '900.00' },
    ])
    expect(diffUsers(CASHIER, CASHIER)).toEqual([])
  })
})

// ------------------------------------------------------------------ audit ---

function entry(over: Partial<AuditEntry> & { id: number }): AuditEntry {
  return {
    storeId: 1,
    at: '2026-09-08T06:00:00.000Z',
    actorId: 5,
    actorName: 'Akib',
    actorRole: 'cashier',
    action: 'SALE_POSTED',
    entity: 'Bill',
    entityRef: `RX2627-0000${over.id}`,
    summary: 'Cash sale',
    changes: [],
    terminalId: 1,
    amount: '100.00',
    override: null,
    ...over,
  }
}

const TRAIL: AuditEntry[] = [
  entry({ id: 1, at: '2026-09-01T06:30:00.000Z' }),
  entry({ id: 2, at: '2026-09-04T09:00:00.000Z', action: 'SALE_VOIDED', summary: 'Voided at close' }),
  entry({
    id: 3,
    at: '2026-09-04T11:00:00.000Z',
    actorId: 2,
    actorName: 'Prakash',
    actorRole: 'manager',
    action: 'RATE_EDITED',
    entity: 'Batch',
    entityRef: 'DL2411A',
    summary: 'MRP corrected',
    changes: [{ field: 'MRP per pack', before: '30.00', after: '41.00' }],
    override: {
      requesterId: 2, requesterName: 'Prakash',
      approverId: 1, approverName: 'Harshad',
      reasonCode: 'RATE_EDIT', requested: '41.00', limit: '30.00', note: 'Pack in hand',
    },
  }),
  entry({ id: 4, at: '2026-09-07T14:00:00.000Z', action: 'STOCK_ADJUSTED', entity: 'Batch', entityRef: 'AZ2308B' }),
]

describe('reading the trail', () => {
  it('answers “who voided this” by action', () => {
    const page = filterAudit(TRAIL, { action: 'SALE_VOIDED' })
    expect(page.total).toBe(1)
    expect(page.rows[0]?.actorName).toBe('Akib')
  })

  it('answers “who changed this price” by the before and after it carries', () => {
    const page = filterAudit(TRAIL, { term: '41.00' })
    expect(page.rows.map((r) => r.id)).toEqual([3])
    expect(page.rows[0]?.changes[0]).toEqual({ field: 'MRP per pack', before: '30.00', after: '41.00' })
  })

  it('answers “who was on the counter” by actor and day', () => {
    const page = filterAudit(TRAIL, { actorId: 5, from: '2026-09-04', to: '2026-09-04' })
    expect(page.rows.map((r) => r.id)).toEqual([2])
  })

  it('includes both ends of the date range', () => {
    expect(filterAudit(TRAIL, { from: '2026-09-01', to: '2026-09-01' }).total).toBe(1)
    expect(filterAudit(TRAIL, { from: '2026-09-01', to: '2026-09-07' }).total).toBe(4)
  })

  it('finds an override by its approver', () => {
    expect(filterAudit(TRAIL, { term: 'harshad' }).rows.map((r) => r.id)).toEqual([3])
    expect(filterAudit(TRAIL, { onlyOverrides: true }).rows.map((r) => r.id)).toEqual([3])
  })

  it('sorts newest first and counts every match, not the page', () => {
    const page = filterAudit(TRAIL, { limit: 2 })
    expect(page.rows.map((r) => r.id)).toEqual([4, 3])
    expect(page.total).toBe(4)
    expect(page.nextCursor).toBe(2)

    const rest = filterAudit(TRAIL, { limit: 2, cursor: 2 })
    expect(rest.rows.map((r) => r.id)).toEqual([2, 1])
    expect(rest.nextCursor).toBeNull()
  })

  it('labels an action it has never met rather than throwing', () => {
    expect(auditLabel('SALE_VOIDED')).toBe('Bill voided')
    expect(auditLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})

// --------------------------------------------------------------- exposure ---

describe('what the roster can do', () => {
  const roster = [
    OWNER, MANAGER, PHARMACIST, CASHIER,
    user({ id: 7, role: 'cashier', username: 'vinod', isActive: false }),
  ]

  it('counts holders through the person, never through the role', () => {
    const e = exposure(roster)
    expect(e.total).toBe(5)
    expect(e.active).toBe(4)
    expect(e.byRole.cashier).toBe(1)

    const voiders = e.guarded.find((g) => g.spec.id === 'billing.void')
    expect(voiders?.holders.map((u) => u.name)).toEqual(['Harshad', 'Prakash'])

    const cost = e.guarded.find((g) => g.spec.id === 'inventory.cost_view')
    expect(cost?.holders.map((u) => u.name)).toEqual(['Harshad', 'Prakash', 'Sunita'])
  })

  it('reports the widest each dial is set, and whose account it is', () => {
    const e = exposure(roster)
    expect(e.widestDiscount).toEqual({ value: '100', holder: OWNER })
    expect(e.largestRefund.holder?.name).toBe('Harshad')
    expect(e.furthestBackdate.value).toBe(365)
  })

  it('ignores disabled accounts, and names nobody when there is nobody', () => {
    const e = exposure([CASHIER, { ...OWNER, isActive: false }])
    expect(e.widestDiscount).toEqual({ value: '5', holder: CASHIER })
    expect(e.furthestBackdate).toEqual({ value: 0, holder: null })
    expect(e.costViewers).toBe(0)
    expect(exposure([]).widestDiscount.holder).toBeNull()
  })
})
