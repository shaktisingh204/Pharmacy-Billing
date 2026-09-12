import type { Permission, Role, User } from '@contract'
import { PERMISSIONS, ROLES } from '@contract'
import {
  COST_PERMISSIONS, PERMISSION_CATALOGUE, PERMISSION_FOR_REASON, ROLE_LABEL, ROLE_PLURAL,
  can, roleHas,
} from './users'
import type { Holds, PermissionSpec } from './users'

/**
 * The shop's own permission matrix, as a diff against the shipped one.
 *
 * The matrix used to be read-only, and the argument for that was good: a shop
 * that can edit "cashier" ends up with a cashier who may edit a rate because
 * somebody needed it once on a Tuesday, and the word stops meaning anything in
 * the audit trail. But the argument only holds while the four roles fit every
 * shop, and they do not. A single-counter chemist where the owner's brother
 * receives goods needs a cashier who can book a GRN; a hospital-facing shop
 * needs a pharmacist who may never sell on credit. Refusing that pushes the shop
 * into the one workaround that is genuinely dangerous — everybody signs in as
 * the owner — and then the trail answers nothing at all.
 *
 * So it is editable, and the design is built around the two ways that goes
 * wrong:
 *
 *  1. NOBODY KNOWS WHAT WAS CHANGED. Stored as a DIFF, never as a full copy of
 *     the grants. A cell that is set back to its shipped value is deleted rather
 *     than recorded as "same", so "12 changes from shipped" is always the truth
 *     and reverting is a delete rather than a re-derivation.
 *  2. A SHOP LOCKS ITSELF OUT, or quietly hands the counter a power that costs
 *     money. The owner's column is refused outright — everything else is allowed
 *     and WARNED about, loudly, naming the guard text the catalogue already
 *     carries and the number of live accounts the change lands on.
 *
 * Nothing here decides anything on its own. It produces a `Holds` predicate,
 * which is what `can`, `evaluate`, `canApprove` and `exposure` consult, so one
 * shop's matrix reaches every answer on the screen without a second copy of the
 * rules living beside them.
 */

export type PolicyKey = `${Role}:${Permission}`

export interface RolePolicy {
  /** ONLY the cells that differ from the shipped grant. Empty means shipped. */
  changed: Partial<Record<PolicyKey, boolean>>
  /** When the matrix was last edited. Null on the shipped policy. */
  updatedAt: string | null
  /** Who edited it, by name. The trail records the change; this survives on the device. */
  updatedBy: string | null
}

export const SHIPPED_POLICY: RolePolicy = { changed: {}, updatedAt: null, updatedBy: null }

export const policyKey = (role: Role, permission: Permission): PolicyKey => `${role}:${permission}`

/**
 * The owner's column is not editable, and it is the only hard rule here.
 *
 * Narrowing it is the one edit with no way back: revoke `settings.users` from
 * admin and the screen that could put it back is gone, on every account, for
 * good. Every other cell can be argued about; this one is a locked door with the
 * key on the inside.
 */
export const LOCKED_ROLES: ReadonlySet<Role> = new Set<Role>(['admin'])

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)
const ROLE_SET: ReadonlySet<string> = new Set<string>(ROLES)

const SPEC_BY_ID = new Map<Permission, PermissionSpec>(
  PERMISSION_CATALOGUE.map((spec) => [spec.id, spec]),
)

/** The spec for a permission. Keyed off the catalogue, so it cannot be missing. */
export function specFor(permission: Permission): PermissionSpec {
  const spec = SPEC_BY_ID.get(permission)
  if (!spec) throw new Error(`no catalogue entry for ${permission}`)
  return spec
}

/** Does the shop's matrix grant it to the ROLE, ignoring the person? */
export function policyGrants(policy: RolePolicy, role: Role, permission: Permission): boolean {
  const cell = policy.changed[policyKey(role, permission)]
  return cell === undefined ? roleHas(role, permission) : cell
}

/** True when this cell has been moved off its shipped value. */
export function isChanged(policy: RolePolicy, role: Role, permission: Permission): boolean {
  return policy.changed[policyKey(role, permission)] !== undefined
}

export function changeCount(policy: RolePolicy): number {
  return Object.keys(policy.changed).length
}

/**
 * What this PERSON may do under the shop's matrix.
 *
 * Identical to `can` on the shipped policy, and deliberately so — the two gates
 * that are NOT the role survive unchanged. A disabled account holds nothing
 * whatever the matrix says, and the per-person cost flag still closes a door the
 * role opened, because a shop that grants `inventory.cost_view` to cashiers has
 * not thereby overridden the one trainee whose flag is off.
 */
export function canUnderPolicy(policy: RolePolicy, user: User, permission: Permission): boolean {
  if (!user.isActive) return false
  if (!policyGrants(policy, user.role, permission)) return false
  return !(COST_PERMISSIONS.has(permission) && !user.limits.canViewCost)
}

/** The predicate form, for `evaluate`, `canApprove`, `eligibleApprovers` and `exposure`. */
export function holdsUnder(policy: RolePolicy): Holds {
  if (changeCount(policy) === 0) return can
  return (user, permission) => canUnderPolicy(policy, user, permission)
}

// ------------------------------------------------------------------- edits ---

export interface CellEdit {
  ok: boolean
  policy: RolePolicy
  /** Why the edit was refused, in the words the screen shows. Null when it took. */
  why: string | null
}

/**
 * Move one cell, and drop it again the moment it agrees with the shipped value.
 *
 * The deletion is the point. Kept as an explicit `true` that happens to match,
 * a cell that was toggled twice would count for ever against "changes from
 * shipped", and the only number on this screen a reader trusts is that count.
 */
export function setCell(
  policy: RolePolicy,
  role: Role,
  permission: Permission,
  granted: boolean,
  by: { name: string; at: string },
): CellEdit {
  if (LOCKED_ROLES.has(role)) {
    return {
      ok: false,
      policy,
      why: `${ROLE_LABEL[role]} is not editable. Narrowing it is the one change with no way back — the screen that could undo it would be gone.`,
    }
  }

  const key = policyKey(role, permission)
  const changed = { ...policy.changed }
  if (granted === roleHas(role, permission)) delete changed[key]
  else changed[key] = granted

  return {
    ok: true,
    policy: { changed, updatedAt: by.at, updatedBy: by.name },
    why: null,
  }
}

/** Back to the shipped matrix, whole. */
export function revertPolicy(): RolePolicy {
  return SHIPPED_POLICY
}

/** Back to shipped for one role's column only. */
export function revertRole(policy: RolePolicy, role: Role, by: { name: string; at: string }): RolePolicy {
  const changed = { ...policy.changed }
  for (const permission of PERMISSIONS) delete changed[policyKey(role, permission)]
  return { changed, updatedAt: by.at, updatedBy: by.name }
}

export interface PolicyChange {
  role: Role
  permission: Permission
  spec: PermissionSpec
  /** What the shop's matrix says now. */
  granted: boolean
  /** What shipped said. Always the opposite of `granted`, or the cell would be gone. */
  shipped: boolean
  /** Live accounts in that role. A change nobody is in is a change nobody feels. */
  affected: number
}

/** Every moved cell, in catalogue order so the list reads like the grid. */
export function policyChanges(policy: RolePolicy, users: readonly User[]): PolicyChange[] {
  const heads = headcount(users)
  const out: PolicyChange[] = []
  for (const spec of PERMISSION_CATALOGUE) {
    for (const role of ROLES) {
      const cell = policy.changed[policyKey(role, spec.id)]
      if (cell === undefined) continue
      out.push({
        role,
        permission: spec.id,
        spec,
        granted: cell,
        shipped: roleHas(role, spec.id),
        affected: heads[role],
      })
    }
  }
  return out
}

function headcount(users: readonly User[]): Record<Role, number> {
  const counts: Record<Role, number> = { admin: 0, manager: 0, pharmacist: 0, cashier: 0 }
  for (const u of users) if (u.isActive) counts[u.role] += 1
  return counts
}

// ---------------------------------------------------------------- warnings ---

export interface PolicyWarning {
  id: string
  /** `danger` is money leaving the shop; `warning` is the counter getting stuck. */
  severity: 'danger' | 'warning'
  title: string
  detail: string
}

/**
 * What this matrix will cost, said before it costs it.
 *
 * Three questions, and the third is the one nobody asks until the Sunday it
 * bites:
 *
 *  1. Has a guarded power been handed to somebody it was kept from? The
 *     catalogue already says what goes wrong in each case; that sentence is the
 *     warning, verbatim, rather than a generic "this is risky".
 *  2. Has the shop revoked something its live accounts are standing on? Losing
 *     `billing.sell` across the counter is not a policy change, it is a closed
 *     shop.
 *  3. WHO IS LEFT TO SIGN? Every override needs an approver who holds the thing
 *     being approved and is not the requester. Narrow the matrix far enough and
 *     that set becomes one person — and an override mechanism with a single
 *     approver is a mechanism that stops working the day they take leave.
 */
export function policyWarnings(policy: RolePolicy, users: readonly User[]): PolicyWarning[] {
  const out: PolicyWarning[] = []
  const active = users.filter((u) => u.isActive)
  const heads = headcount(users)

  for (const change of policyChanges(policy, users)) {
    if (change.granted && change.spec.guard !== null) {
      out.push({
        id: `granted:${change.role}:${change.permission}`,
        severity: 'danger',
        title: `${ROLE_LABEL[change.role]} can now ${change.spec.label.toLowerCase()}`,
        detail: change.affected === 0
          ? `${change.spec.guard} Nobody is in this role today, so it costs nothing until somebody is.`
          : `${change.spec.guard} ${countPeople(change.affected)} in this role today.`,
      })
    }
    if (!change.granted && change.affected > 0 && ESSENTIAL.has(change.permission)) {
      out.push({
        id: `revoked:${change.role}:${change.permission}`,
        severity: 'warning',
        title: `${countPeople(change.affected)} can no longer ${change.spec.label.toLowerCase()}`,
        detail: `Every active ${ROLE_LABEL[change.role].toLowerCase()} loses it. ${change.spec.detail}`,
      })
    }
  }

  for (const reason of Object.keys(PERMISSION_FOR_REASON) as Array<keyof typeof PERMISSION_FOR_REASON>) {
    const needed = PERMISSION_FOR_REASON[reason]
    const signers = active.filter((u) => canUnderPolicy(policy, u, needed))
    if (signers.length > 1) continue
    const spec = specFor(needed)
    out.push({
      id: `signers:${reason}`,
      severity: signers.length === 0 ? 'danger' : 'warning',
      title: signers.length === 0
        ? `Nobody can sign off ${spec.label.toLowerCase()}`
        : `Only ${signers[0]?.name} can sign off ${spec.label.toLowerCase()}`,
      detail: signers.length === 0
        ? 'A counter that hits this limit has nobody to ask, and the customer waits until the matrix changes.'
        : 'One approver is one holiday away from none. An override is never signed by the person asking for it.',
    })
  }

  /* Roles that are now empty of everything read as an oversight rather than a
     decision, and the grid does not say it loudly enough on its own. */
  for (const role of ROLES) {
    if (heads[role] === 0) continue
    const grants = PERMISSIONS.filter((p) => policyGrants(policy, role, p)).length
    if (grants > 0) continue
    out.push({
      id: `empty:${role}`,
      severity: 'danger',
      title: `${ROLE_LABEL[role]} grants nothing at all`,
      detail: `${countPeople(heads[role])} in this role can sign in and do nothing. Disable the accounts instead — a live account that can do nothing is a support call.`,
    })
  }

  return out
}

/** Revoking one of these from a role somebody is actually in is worth saying out loud. */
const ESSENTIAL: ReadonlySet<Permission> = new Set<Permission>([
  'billing.sell', 'inventory.view', 'customers.view', 'billing.return', 'purchases.record',
])

function countPeople(n: number): string {
  return `${n} active account${n === 1 ? '' : 's'}`
}

/** "2 managers" / "1 manager" — the count with the right noun on it. */
export function roleCountLabel(role: Role, n: number): string {
  return `${n} ${n === 1 ? ROLE_LABEL[role].toLowerCase() : ROLE_PLURAL[role]}`
}

// ------------------------------------------------------------- persistence ---

export const POLICY_STORAGE_KEY = 'rxbill.rolePolicy'

/**
 * Read a stored matrix without trusting a byte of it.
 *
 * It is JSON in a browser store that a person can edit, that an older build
 * wrote, and that a future contract will have renamed permissions out of. Every
 * unknown role, unknown permission and non-boolean cell is DROPPED rather than
 * carried, and a cell that merely restates the shipped grant is dropped too, so
 * a stale file cannot inflate the change count it is read back through.
 */
export function readPolicy(raw: string | null): RolePolicy {
  if (raw === null || raw.trim() === '') return SHIPPED_POLICY
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return SHIPPED_POLICY
  }
  if (typeof parsed !== 'object' || parsed === null) return SHIPPED_POLICY

  const box = parsed as { changed?: unknown; updatedAt?: unknown; updatedBy?: unknown }
  const changed: Partial<Record<PolicyKey, boolean>> = {}
  if (typeof box.changed === 'object' && box.changed !== null) {
    for (const [key, value] of Object.entries(box.changed as Record<string, unknown>)) {
      if (typeof value !== 'boolean') continue
      const [role, permission] = splitKey(key)
      if (role === null || permission === null) continue
      if (LOCKED_ROLES.has(role)) continue
      if (value === roleHas(role, permission)) continue
      changed[policyKey(role, permission)] = value
    }
  }

  return {
    changed,
    updatedAt: typeof box.updatedAt === 'string' ? box.updatedAt : null,
    updatedBy: typeof box.updatedBy === 'string' ? box.updatedBy : null,
  }
}

function splitKey(key: string): [Role | null, Permission | null] {
  const at = key.indexOf(':')
  if (at < 0) return [null, null]
  const role = key.slice(0, at)
  const permission = key.slice(at + 1)
  return [
    ROLE_SET.has(role) ? (role as Role) : null,
    PERMISSION_SET.has(permission) ? (permission as Permission) : null,
  ]
}

export function serialisePolicy(policy: RolePolicy): string {
  return JSON.stringify(policy)
}
