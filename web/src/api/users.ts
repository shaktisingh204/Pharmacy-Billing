import type {
  AuditChange, AuditEntry, AuditFilters, AuditPage, IsoDate, Money, Override, OverrideReason,
  Pct, Permission, PermissionArea, Role, User, UserInput, UserLimits,
} from '@contract'
import { ApiError, PERMISSIONS, ROLES } from '@contract'
import * as D from '@/domain/decimal'

/**
 * Access control, as pure value logic.
 *
 * Who may do what, what each person's ceilings are, when a second signature is
 * required and who is allowed to give it — all of it as functions over arrays,
 * so the Phase-5 Rust server has a readable specification of the answers it must
 * reproduce. `localAdapter` only feeds these from Dexie.
 *
 * The shape of the thing is the argument. A role alone is a coarse instrument:
 * it can say a cashier may bill, but every actual loss at a counter is a NUMBER
 * — a discount three points deeper than the shop allows, a refund nobody stood
 * over, a bill dated back into a return that has already been filed. So a role
 * grants the capability and `UserLimits` bounds it per person, and the gap
 * between the two is exactly where an override lives.
 *
 * Nothing here does arithmetic on a money string by hand: `@/domain/decimal`
 * does the sums, because a discount ceiling compared with `parseFloat` is a
 * ceiling that leaks at the fourth decimal place.
 */

// ------------------------------------------------------------- the matrix ---

export interface PermissionSpec {
  id: Permission
  area: PermissionArea
  label: string
  /** What granting it actually lets a person do, in one line. */
  detail: string
  /**
   * Set on the permissions a cashier must not hold, saying what goes wrong when
   * they do. These are the six the grid draws attention to; the rest are the
   * ordinary business of a shop and get no emphasis, because a matrix that
   * shouts everywhere shouts nowhere.
   */
  guard: string | null
  /** True when the grant is only half the control — a limit bounds it too. */
  bounded?: boolean
}

/*
 * Keyed by permission rather than written as a list, so a permission added to
 * the contract without a description here fails to compile. A grid silently
 * missing a row is a permission nobody reviews.
 */
const CATALOGUE: Record<Permission, Omit<PermissionSpec, 'id'>> = {
  'billing.sell': {
    area: 'Billing', label: 'Create a bill', guard: null,
    detail: 'Search, add lines, take payment and post an invoice.',
  },
  'billing.discount': {
    area: 'Billing', label: 'Apply a discount', guard: null, bounded: true,
    detail: 'Up to this person’s own ceiling. Beyond it, a manager signs.',
  },
  'billing.rate_edit': {
    area: 'Billing', label: 'Edit a rate or MRP', guard:
      'Selling under the printed price without recording a discount. The shortfall shows up in no discount report, and reconciles against nothing.',
    detail: 'Type over the selling rate, or correct a batch’s printed MRP.',
  },
  'billing.void': {
    area: 'Billing', label: 'Void a posted bill', guard:
      'The oldest till theft there is: take the cash, void the bill, and the goods have already left with the customer.',
    detail: 'Cancel a posted invoice. The number is burned, never reused.',
  },
  'billing.return': {
    area: 'Billing', label: 'Accept a return', guard: null, bounded: true,
    detail: 'Take goods back and issue a credit note, up to the refund ceiling.',
  },
  'billing.backdate': {
    area: 'Billing', label: 'Backdate a document', guard:
      'Moves a sale into a period that is already filed, or out of the day whose cash is about to be counted.',
    detail: 'Date a bill earlier than today, within the day limit.',
  },
  'billing.credit': {
    area: 'Billing', label: 'Sell on credit', guard: null,
    detail: 'Bill against a customer’s account instead of taking payment.',
  },

  'inventory.view': {
    area: 'Inventory', label: 'See stock and expiry', guard: null,
    detail: 'Batch quantities, expiry buckets and rack locations.',
  },
  'inventory.adjust': {
    area: 'Inventory', label: 'Adjust stock', guard: null,
    detail: 'Write off breakage or correct a count. The note is mandatory.',
  },
  'inventory.quarantine': {
    area: 'Inventory', label: 'Quarantine a batch', guard: null,
    detail: 'Block a batch from allocating, or release one back.',
  },
  'inventory.cost_view': {
    area: 'Inventory', label: 'See landed cost', guard:
      'Landed cost is what the shop paid. It is the one number a departing employee can carry to a competitor and use the same afternoon.',
    detail: 'Cost and PTR columns on batches, and stock value at cost.',
  },

  'purchases.view': {
    area: 'Purchases', label: 'Open the purchase register', guard: null,
    detail: 'Read goods receipts and what is outstanding to each distributor.',
  },
  'purchases.record': {
    area: 'Purchases', label: 'Book a goods receipt', guard: null,
    detail: 'Key a distributor’s bill, creating batches and stock.',
  },
  'purchases.rate_view': {
    area: 'Purchases', label: 'See purchase rates', guard:
      'The last deal from each distributor. Knowing it is the shop’s negotiating position, and it is worth money to the man across the counter.',
    detail: 'Rate per pack, scheme goods and the rate-change history.',
  },
  'purchases.pay': {
    area: 'Purchases', label: 'Record a payment', guard: null,
    detail: 'Settle a distributor’s bill against the payable.',
  },

  'customers.view': {
    area: 'Customers', label: 'Look up a customer', guard: null,
    detail: 'Find by phone, see allergies and past bills.',
  },
  'customers.edit': {
    area: 'Customers', label: 'Edit customer details', guard: null,
    detail: 'Correct a name, phone, address, GSTIN or allergy strip.',
  },
  'customers.credit_limit': {
    area: 'Customers', label: 'Set a credit limit', guard: null,
    detail: 'Decide how much a customer may owe before billing stops.',
  },
  'customers.erase': {
    area: 'Customers', label: 'Erase personal data', guard: null,
    detail: 'Redact on request. Register rows under legal hold survive it.',
  },

  'reports.sales': {
    area: 'Reports', label: 'Sales reports', guard: null,
    detail: 'Takings by day, till, medicine and customer.',
  },
  'reports.margin': {
    area: 'Reports', label: 'Margin and profit', guard:
      'Margin is cost with the arithmetic done for you. Denying the cost column and granting this one denies nothing.',
    detail: 'Gross margin by medicine, supplier and period.',
  },
  'reports.gst': {
    area: 'Reports', label: 'GST returns', guard: null,
    detail: 'GSTR-1, GSTR-3B working and the HSN summary.',
  },
  'reports.audit': {
    area: 'Reports', label: 'Read the audit trail', guard: null,
    detail: 'Who did what, when, and what it looked like before.',
  },

  'settings.store': {
    area: 'Settings', label: 'Store profile', guard: null,
    detail: 'Name, GSTIN, drug licences, invoice series and document footers.',
  },
  'settings.users': {
    area: 'Settings', label: 'Manage users', guard: null,
    detail: 'Create people, set roles and set the limits on this page.',
  },
  'settings.pricing': {
    area: 'Settings', label: 'Pricing policy', guard: null,
    detail: 'Default discount rules and how rates may be edited at all.',
  },
  'settings.backup': {
    area: 'Settings', label: 'Backup and restore', guard: null,
    detail: 'Take a backup, and restore one over live data.',
  },
}

/** Every permission with its description, in contract order. */
export const PERMISSION_CATALOGUE: PermissionSpec[] = PERMISSIONS.map((id) => ({
  id,
  ...CATALOGUE[id],
}))

export interface PermissionGroup {
  area: PermissionArea
  permissions: PermissionSpec[]
}

/**
 * The catalogue, grouped for the grid.
 *
 * Areas come out in the order their first permission appears, so the contract's
 * ordering is the single source of truth for both the list and the bands —
 * a second hand-written order is a second thing to keep in step.
 */
export function permissionGroups(): PermissionGroup[] {
  const groups: PermissionGroup[] = []
  for (const spec of PERMISSION_CATALOGUE) {
    const last = groups[groups.length - 1]
    if (last && last.area === spec.area) last.permissions.push(spec)
    else groups.push({ area: spec.area, permissions: [spec] })
  }
  return groups
}

/**
 * What each role grants.
 *
 * Read the cashier row first — it is the one that matters. A cashier bills,
 * discounts within a ceiling, looks a customer up and sees what is on the
 * shelf. Nothing else. Every line missing from it is a line that has cost some
 * shop money: the rate edit, the void, the backdate, the cost column.
 *
 * A pharmacist DOES see cost, because the same person books the goods receipt
 * that creates it, and a receipt keyed by someone who cannot see the rate they
 * are keying is a receipt keyed blind. Margin reporting is still denied: that
 * is the owner's question, not the dispensing counter's.
 */
export const ROLE_GRANTS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,

  manager: [
    'billing.sell', 'billing.discount', 'billing.rate_edit', 'billing.void',
    'billing.return', 'billing.backdate', 'billing.credit',
    'inventory.view', 'inventory.adjust', 'inventory.quarantine', 'inventory.cost_view',
    'purchases.view', 'purchases.record', 'purchases.rate_view', 'purchases.pay',
    'customers.view', 'customers.edit', 'customers.credit_limit',
    'reports.sales', 'reports.margin', 'reports.gst', 'reports.audit',
    'settings.store',
  ],

  pharmacist: [
    'billing.sell', 'billing.discount', 'billing.return', 'billing.credit',
    'inventory.view', 'inventory.adjust', 'inventory.quarantine', 'inventory.cost_view',
    'purchases.view', 'purchases.record', 'purchases.rate_view',
    'customers.view', 'customers.edit',
    'reports.sales', 'reports.gst',
  ],

  /* A return IS granted, and bounded to a few hundred rupees instead. A front
     counter that cannot hand back the price of a wrong-strength strip sends the
     customer away to wait for a manager, and the refund ceiling — the thing
     that actually contains the loss — would be a field that never applied. */
  cashier: [
    'billing.sell', 'billing.discount', 'billing.return',
    'inventory.view',
    'customers.view',
  ],
}

const GRANT_SETS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ROLE_GRANTS.admin),
  manager: new Set(ROLE_GRANTS.manager),
  pharmacist: new Set(ROLE_GRANTS.pharmacist),
  cashier: new Set(ROLE_GRANTS.cashier),
}

/** Does the ROLE grant it, ignoring the person and their limits. */
export function roleHas(role: Role, permission: Permission): boolean {
  return GRANT_SETS[role].has(permission)
}

/**
 * Cost is gated twice.
 *
 * The role opens the door and `canViewCost` can still close it for one person:
 * a trainee pharmacist during their first month is the ordinary case. Both have
 * to say yes, so revoking the flag revokes the margin report too — otherwise
 * the same number is denied in one column and printed in another.
 */
export const COST_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'inventory.cost_view', 'purchases.rate_view', 'reports.margin',
])

/** What this PERSON may do: role grant, cost flag, and the account being live. */
export function can(user: User, permission: Permission): boolean {
  if (!user.isActive) return false
  if (!roleHas(user.role, permission)) return false
  return !(COST_PERMISSIONS.has(permission) && !user.limits.canViewCost)
}

/**
 * "Does this person hold that", as a value the caller can substitute.
 *
 * `can` reads the SHIPPED matrix, which is the right default and the wrong
 * answer for a shop that has edited its own — see `src/api/rolePolicy.ts`. Every
 * function below that used to consult `can` directly now takes this instead, so
 * one shop's matrix can be asked without a second copy of the identity rule, the
 * approver's ceiling and the override wording living beside it. Omitted, the
 * behaviour is exactly what it was.
 */
export type Holds = (user: User, permission: Permission) => boolean

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Owner / admin',
  manager: 'Manager',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
}

/**
 * The same roles for a column too narrow to hold the real label.
 *
 * Only 'admin' actually differs: 'Owner / admin' needs about 90px and the audit
 * trail's "Who" column has 110px for a name AND a role. The alternative shipped
 * was the raw enum — a lowercase `manager` under a properly cased name, which is
 * a contract identifier leaking onto a screen. Shortening one entry is a much
 * smaller price than widening the column or printing the id.
 */
export const ROLE_SHORT: Record<Role, string> = {
  admin: 'Owner',
  manager: 'Manager',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
}

/** For counting people. "2 pharmacist" is the tell of a screen nobody read. */
export const ROLE_PLURAL: Record<Role, string> = {
  admin: 'owners / admins',
  manager: 'managers',
  pharmacist: 'pharmacists',
  cashier: 'cashiers',
}

export const ROLE_BLURB: Record<Role, string> = {
  admin: 'Everything, including who else gets an account.',
  manager: 'Runs the shop. Signs off what a counter may not do alone.',
  pharmacist: 'Dispenses under their own registration, and receives goods.',
  cashier: 'Bills and takes money. Nothing that changes a price.',
}

// -------------------------------------------------------------- the limits ---

/**
 * The hardest a role may ever be tuned.
 *
 * A per-user number is a dial BELOW the role's ceiling, never above it, or the
 * role stops meaning anything: a cashier carrying a 60% discount limit is a
 * cashier with a manager's authority and a cashier's supervision. The form
 * refuses the value rather than clamping it silently — a limit that was quietly
 * reduced is a limit nobody knows the value of.
 */
export const ROLE_CEILING: Record<Role, UserLimits> = {
  admin: { maxDiscountPct: '100', maxRefundAmount: '1000000.00', backdateDays: 365, canViewCost: true },
  manager: { maxDiscountPct: '25', maxRefundAmount: '25000.00', backdateDays: 30, canViewCost: true },
  pharmacist: { maxDiscountPct: '15', maxRefundAmount: '5000.00', backdateDays: 7, canViewCost: true },
  /* Zero backdating and no cost column, and neither is an oversight. A cashier
     who can date a bill into yesterday can move a sale out of the count that is
     about to happen. */
  cashier: { maxDiscountPct: '10', maxRefundAmount: '1000.00', backdateDays: 0, canViewCost: false },
}

/** Where a NEW person in each role starts. Deliberately below the ceiling. */
export const ROLE_STARTING_LIMITS: Record<Role, UserLimits> = {
  admin: { maxDiscountPct: '100', maxRefundAmount: '1000000.00', backdateDays: 365, canViewCost: true },
  manager: { maxDiscountPct: '20', maxRefundAmount: '10000.00', backdateDays: 7, canViewCost: true },
  pharmacist: { maxDiscountPct: '10', maxRefundAmount: '2000.00', backdateDays: 1, canViewCost: true },
  cashier: { maxDiscountPct: '5', maxRefundAmount: '500.00', backdateDays: 0, canViewCost: false },
}

const DECIMALISH = /^\d+(\.\d+)?$/

/** A backdate ask already counted in days rather than quoted as a date. */
const DAY_COUNT_RE = /^\d+$/

/**
 * A limit that cannot be read is not zero.
 *
 * `D.dec` throws on anything that is not a decimal string, which is right for
 * arithmetic and wrong for a screen that must still render a half-migrated row.
 * An unreadable ceiling reads as absent, and absent is treated as the strictest
 * possible answer everywhere below — a confident "yes, within limit" derived
 * from a value nobody could parse is the one wrong answer that costs money.
 */
function limitDec(v: string | null | undefined): D.Decimal | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return DECIMALISH.test(t) ? D.dec(t) : null
}

/** Midnight-to-midnight day difference. Null when either date is unreadable. */
export function daysBetween(fromIso: IsoDate, toIso: IsoDate): number | null {
  const a = new Date(`${fromIso}T00:00:00`)
  const b = new Date(`${toIso}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** What is being asked for, in the units the ceiling is written in. */
export type Ask =
  | { kind: 'discount'; pct: Pct }
  | { kind: 'refund'; amount: Money }
  | { kind: 'backdate'; date: IsoDate; today: IsoDate }
  | { kind: 'permission'; permission: Permission }

export interface Decision {
  allowed: boolean
  /** What a manager would be signing. Null when allowed, or when nothing helps. */
  reason: OverrideReason | null
  /** False when no signature unlocks it — a disabled account, or a future date. */
  overridable: boolean
  /** Both sides in display units, so the override record can quote them. */
  requested: string
  limit: string
  message: string
}

const ALLOWED: Omit<Decision, 'requested' | 'limit'> = {
  allowed: true, reason: null, overridable: false, message: '',
}

/**
 * The permission each override reason unlocks.
 *
 * An approver must HOLD the thing they are approving. Without this a pharmacist
 * could sign off a void they may not perform themselves, which turns the
 * approval into a signature-gathering exercise rather than a control.
 */
export const PERMISSION_FOR_REASON: Record<OverrideReason, Permission> = {
  DISCOUNT_LIMIT: 'billing.discount',
  REFUND_LIMIT: 'billing.return',
  RATE_EDIT: 'billing.rate_edit',
  BILL_VOID: 'billing.void',
  BACKDATE: 'billing.backdate',
  COST_VIEW: 'inventory.cost_view',
  CREDIT_LIMIT: 'customers.credit_limit',
}

export const OVERRIDE_REASON_LABEL: Record<OverrideReason, string> = {
  DISCOUNT_LIMIT: 'Discount over limit',
  REFUND_LIMIT: 'Refund over limit',
  RATE_EDIT: 'Rate or MRP edited',
  BILL_VOID: 'Bill voided',
  BACKDATE: 'Document backdated',
  COST_VIEW: 'Cost revealed',
  CREDIT_LIMIT: 'Credit limit exceeded',
}

const REASON_FOR_PERMISSION = new Map<Permission, OverrideReason>(
  (Object.keys(PERMISSION_FOR_REASON) as OverrideReason[])
    .map((reason) => [PERMISSION_FOR_REASON[reason], reason]),
)

/**
 * May this person do this, unaided?
 *
 * One entry point for all four kinds of ask, because the counter asks them the
 * same way — it wants a yes, or the name of the thing a manager has to sign.
 * A refusal that cannot name its reason code cannot be recorded as an override,
 * and an override that cannot be recorded is a rule that gets waved through.
 */
export function evaluate(user: User, ask: Ask, holds: Holds = can): Decision {
  if (!user.isActive) {
    return {
      ...ALLOWED,
      allowed: false,
      overridable: false,
      requested: '',
      limit: '',
      message: `${user.name}’s account is disabled. Re-enable it — an override cannot stand in for a login.`,
    }
  }

  if (ask.kind === 'discount') {
    const want = limitDec(ask.pct)
    const cap = limitDec(user.limits.maxDiscountPct)
    if (want === null) {
      return { allowed: false, reason: null, overridable: false, requested: ask.pct, limit: user.limits.maxDiscountPct, message: `“${ask.pct}” is not a percentage.` }
    }
    if (cap !== null && D.lte(want, cap)) {
      return { ...ALLOWED, requested: ask.pct, limit: user.limits.maxDiscountPct }
    }
    return {
      allowed: false,
      reason: 'DISCOUNT_LIMIT',
      overridable: true,
      requested: ask.pct,
      limit: user.limits.maxDiscountPct,
      message: `${ask.pct}% is past this account’s ${user.limits.maxDiscountPct}% ceiling.`,
    }
  }

  if (ask.kind === 'refund') {
    const want = limitDec(ask.amount)
    const cap = limitDec(user.limits.maxRefundAmount)
    if (want === null) {
      return { allowed: false, reason: null, overridable: false, requested: ask.amount, limit: user.limits.maxRefundAmount, message: `“${ask.amount}” is not an amount.` }
    }
    /* The tie between the matrix and the ceiling. Every role grants returns
       today, so this is unreachable — and it is here so that the day a shop's
       matrix drops the grant, the ceiling stops being the only thing consulted
       and a refund does not quietly become allowed because the number fits. */
    /* `holds` rather than `roleHas`: the account is already known to be live by
       the guard at the top, and returns are not cost-gated, so the two agree on
       the shipped matrix and only `holds` can see a shop's own. */
    if (!holds(user, 'billing.return')) {
      return {
        allowed: false,
        reason: 'REFUND_LIMIT',
        overridable: true,
        requested: ask.amount,
        limit: '0',
        message: `A ${ROLE_LABEL[user.role].toLowerCase()} does not take returns at all.`,
      }
    }
    if (cap !== null && D.lte(want, cap)) {
      return { ...ALLOWED, requested: ask.amount, limit: user.limits.maxRefundAmount }
    }
    return {
      allowed: false,
      reason: 'REFUND_LIMIT',
      overridable: true,
      requested: ask.amount,
      limit: user.limits.maxRefundAmount,
      message: `Past this account’s ₹${user.limits.maxRefundAmount} refund ceiling.`,
    }
  }

  if (ask.kind === 'backdate') {
    const back = daysBetween(ask.date, ask.today)
    if (back === null) {
      return { allowed: false, reason: null, overridable: false, requested: ask.date, limit: String(user.limits.backdateDays), message: `“${ask.date}” is not a date.` }
    }
    /* Forward-dating is a refusal, not an override. A bill dated into next week
       lands in a return that has not opened yet, and no signature makes that
       filing correct — which is why `overridable` is false and the UI must not
       offer an approver picker for it. */
    if (back < 0) {
      return {
        allowed: false,
        reason: null,
        overridable: false,
        requested: ask.date,
        limit: String(user.limits.backdateDays),
        message: 'A document cannot be dated into the future. No approval changes that.',
      }
    }
    if (back <= user.limits.backdateDays) {
      return { ...ALLOWED, requested: ask.date, limit: String(user.limits.backdateDays) }
    }
    return {
      allowed: false,
      reason: 'BACKDATE',
      overridable: true,
      requested: ask.date,
      limit: String(user.limits.backdateDays),
      message: user.limits.backdateDays === 0
        ? `${back} day${back === 1 ? '' : 's'} back. This account bills today only.`
        : `${back} days back, against a ${user.limits.backdateDays}-day limit.`,
    }
  }

  const spec = CATALOGUE[ask.permission]
  if (holds(user, ask.permission)) {
    return { ...ALLOWED, requested: ask.permission, limit: '' }
  }
  const reason = REASON_FOR_PERMISSION.get(ask.permission) ?? null
  return {
    allowed: false,
    reason,
    overridable: reason !== null,
    requested: ask.permission,
    limit: '',
    message: COST_PERMISSIONS.has(ask.permission) && roleHas(user.role, ask.permission)
      ? `${spec.label} is switched off for this account.`
      : `A ${ROLE_LABEL[user.role].toLowerCase()} cannot ${spec.label.toLowerCase()}.`,
  }
}

// ------------------------------------------------------------- the override ---

export interface Approval {
  ok: boolean
  /** Why not, in the words the UI shows. Null when ok. */
  why: string | null
}

/**
 * May this person sign for that one?
 *
 * The first rule is the whole point of the mechanism and it is checked first:
 * AN APPROVER IS NEVER THE REQUESTER (invariant I22, a CHECK constraint from
 * Phase 5). An approval a cashier can grant themselves is not a control, it is
 * a keystroke — and every system that has ever let the same session supply both
 * halves has ended up with a log full of self-signed voids.
 *
 * The second rule is nearly as easy to get wrong: an approver may not sign for
 * more than they could do themselves. A manager whose own discount stops at 20%
 * cannot authorise 30% — otherwise the ceiling is a suggestion that anybody can
 * launder through a colleague.
 */
export function canApprove(
  approver: User,
  requester: User,
  reason: OverrideReason,
  requested: string,
  /**
   * Only BACKDATE needs it, and it needs it absolutely: the ask is quoted as a
   * DATE and the ceiling is a count of DAYS, so without today they are two
   * numbers that cannot be compared. Absent, a backdate approval is refused
   * rather than waved through — see the branch below.
   */
  today?: IsoDate,
  /** The shop's matrix, when it has one. See `Holds`. */
  holds: Holds = can,
): Approval {
  if (approver.id === requester.id) {
    return { ok: false, why: 'An approver can never be the requester. Someone else has to stand at the till.' }
  }
  if (!approver.isActive) {
    return { ok: false, why: `${approver.name}’s account is disabled.` }
  }
  const needed = PERMISSION_FOR_REASON[reason]
  if (!holds(approver, needed)) {
    return { ok: false, why: `A ${ROLE_LABEL[approver.role].toLowerCase()} cannot ${CATALOGUE[needed].label.toLowerCase()} either.` }
  }

  /* The approver's own ceiling, in the units of the ask. Reasons that are a
     plain capability rather than a number fall through with nothing to compare. */
  if (reason === 'DISCOUNT_LIMIT') {
    const want = limitDec(requested)
    const cap = limitDec(approver.limits.maxDiscountPct)
    if (want !== null && (cap === null || D.gt(want, cap))) {
      return { ok: false, why: `${approver.name}’s own ceiling is ${approver.limits.maxDiscountPct}%.` }
    }
  }
  if (reason === 'REFUND_LIMIT') {
    const want = limitDec(requested)
    const cap = limitDec(approver.limits.maxRefundAmount)
    if (want !== null && (cap === null || D.gt(want, cap))) {
      return { ok: false, why: `${approver.name} may refund up to ₹${approver.limits.maxRefundAmount}.` }
    }
  }
  if (reason === 'BACKDATE') {
    /* Two different units, and only one of them is a number. `evaluate` quotes
       the ask as the DATE that was typed — that is what the override record has
       to carry — while the ceiling is a count of days, so `Number(requested)`
       is NaN and a comparison against it is silently false: a manager who may
       go back one day would be listed as able to sign for thirty-eight. What
       cannot be measured is refused, never passed. */
    const plain = requested.trim()
    const days = DAY_COUNT_RE.test(plain)
      ? Number(plain)
      : today === undefined ? null : daysBetween(plain, today)
    if (days === null) {
      return { ok: false, why: `“${requested}” cannot be measured against ${approver.name}’s ${approver.limits.backdateDays}-day reach.` }
    }
    if (days > approver.limits.backdateDays) {
      return { ok: false, why: `${approver.name} may go back ${approver.limits.backdateDays} day${approver.limits.backdateDays === 1 ? '' : 's'}.` }
    }
  }

  return { ok: true, why: null }
}

/** Everyone who could sign this one, in list order. Never includes the requester. */
export function eligibleApprovers(
  users: readonly User[],
  requester: User,
  reason: OverrideReason,
  requested: string,
  today?: IsoDate,
  holds: Holds = can,
): User[] {
  return users.filter((u) => canApprove(u, requester, reason, requested, today, holds).ok)
}

/**
 * The record an override leaves behind.
 *
 * Built here rather than at the call site so every screen that raises one
 * writes the same six fields. Throws when the pairing is illegal: a refused
 * approval that still produced a row would be the worst of both worlds — a log
 * entry that says a control was applied when it was not.
 */
export function buildOverride(
  approver: User,
  requester: User,
  decision: Decision,
  note: string | null,
  /** Passed straight to `canApprove`; a BACKDATE cannot be checked without it. */
  today?: IsoDate,
): Override {
  if (decision.reason === null) {
    throw new ApiError({ code: 'OVERRIDE_NOT_REQUIRED', message: 'Nothing here needs an approval.' })
  }
  const verdict = canApprove(approver, requester, decision.reason, decision.requested, today)
  if (!verdict.ok) {
    throw new ApiError({
      code: 'OVERRIDE_REFUSED',
      message: verdict.why ?? 'That approval is not allowed.',
      details: { approverId: approver.id, requesterId: requester.id, reasonCode: decision.reason },
    })
  }
  return {
    requesterId: requester.id,
    requesterName: requester.name,
    approverId: approver.id,
    approverName: approver.name,
    reasonCode: decision.reason,
    requested: decision.requested,
    limit: decision.limit,
    note: note?.trim() ? note.trim() : null,
  }
}

// -------------------------------------------------------------- validation ---

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ')

/* Lowercase and narrow on purpose. The username is what the audit trail is
   keyed on and what somebody types at six in the morning; 'Ravi.K' and 'ravi.k'
   being two accounts is how a trail stops answering "who". */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,19}$/
const MONEY_RE = /^\d{1,9}(\.\d{1,2})?$/
const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/

function invalid(field: string, message: string): ApiError {
  return new ApiError({ code: 'USER_INVALID', message, details: { field } })
}

export type UserFields = Omit<User, 'id' | 'storeId' | 'lastActiveAt'>

/**
 * Everything a new or edited account must satisfy.
 *
 * `existing` is every OTHER user — the caller drops the row being edited — so
 * the uniqueness check and the last-admin check read the same way on create and
 * on edit, and neither has to special-case "unless it is me".
 */
export function prepareUser(input: UserInput, existing: readonly User[]): UserFields {
  const name = collapse(input.name ?? '')
  if (!name) throw invalid('name', 'A name is required — it is what the audit trail prints.')

  const username = (input.username ?? '').trim().toLowerCase()
  if (!USERNAME_RE.test(username)) {
    throw invalid('username', '3–20 characters: lowercase letters, digits, dot, dash or underscore.')
  }
  const clash = existing.find((u) => u.username === username)
  if (clash) {
    throw new ApiError({
      code: 'USER_EXISTS',
      message: `${clash.name} already signs in as ${username}.`,
      details: { field: 'username', user: clash },
    })
  }

  const role = ROLES.find((r) => r === input.role)
  if (!role) throw invalid('role', 'Pick one of the four roles.')

  const reg = collapse(input.pharmacistRegNo ?? '')
  /* Blocking, and only for the pharmacist role. A prescription sale is
     dispensed under a named registered pharmacist and that number is printed on
     the bill; an account claiming the role without one puts a blank where the
     register expects an identity. Owners and managers who are themselves
     registered may carry one, and often do. */
  if (role === 'pharmacist' && !reg) {
    throw invalid('pharmacistRegNo', 'A pharmacist dispenses under their registration number, and it goes on the bill.')
  }

  const limits = prepareLimits(input.limits ?? ROLE_STARTING_LIMITS[role], role)

  const isActive = input.isActive ?? true
  if (!isActive && role === 'admin' && !existing.some((u) => u.role === 'admin' && u.isActive)) {
    throw new ApiError({
      code: 'USER_LAST_ADMIN',
      message: 'This is the only admin left. Promote somebody else before disabling this account.',
      details: { field: 'isActive' },
    })
  }

  return {
    name,
    username,
    role,
    pharmacistRegNo: reg ? reg : null,
    limits,
    isActive,
  }
}

/** The four numbers, checked against the role's hard ceiling. */
export function prepareLimits(limits: UserLimits, role: Role): UserLimits {
  const ceiling = ROLE_CEILING[role]

  const pct = (limits.maxDiscountPct ?? '').trim()
  if (!PCT_RE.test(pct)) throw invalid('maxDiscountPct', 'A percentage like 5 or 7.5.')
  const pctCap = limitDec(ceiling.maxDiscountPct)
  if (pctCap !== null && D.gt(D.dec(pct), pctCap)) {
    throw invalid('maxDiscountPct', `A ${ROLE_LABEL[role].toLowerCase()} may not exceed ${ceiling.maxDiscountPct}%. Change the role, or lower the number.`)
  }

  const refund = (limits.maxRefundAmount ?? '').trim()
  if (!MONEY_RE.test(refund)) throw invalid('maxRefundAmount', 'An amount in rupees, e.g. 500 or 500.00.')
  const refundCap = limitDec(ceiling.maxRefundAmount)
  if (refundCap !== null && D.gt(D.dec(refund), refundCap)) {
    throw invalid('maxRefundAmount', `A ${ROLE_LABEL[role].toLowerCase()} may not exceed ₹${ceiling.maxRefundAmount}.`)
  }

  const days = limits.backdateDays
  if (!Number.isSafeInteger(days) || days < 0) {
    throw invalid('backdateDays', 'Whole days, zero or more. Zero means today only.')
  }
  if (days > ceiling.backdateDays) {
    throw invalid('backdateDays', ceiling.backdateDays === 0
      ? `A ${ROLE_LABEL[role].toLowerCase()} bills today only.`
      : `A ${ROLE_LABEL[role].toLowerCase()} may go back at most ${ceiling.backdateDays} days.`)
  }

  const canViewCost = limits.canViewCost === true
  if (canViewCost && !ceiling.canViewCost) {
    throw invalid('canViewCost', `Cost is not visible to a ${ROLE_LABEL[role].toLowerCase()} at any setting.`)
  }

  return { maxDiscountPct: pct, maxRefundAmount: refund, backdateDays: days, canViewCost }
}

/**
 * Merge a patch onto an account and re-validate the WHOLE thing.
 *
 * Validating only the changed keys is how a role demotion leaves a cashier
 * holding a manager's discount ceiling: neither field is wrong on its own, and
 * the pair is. `limits` is replaced whole for the same reason — three of the
 * four numbers are only meaningful against the fourth and the role.
 */
export function applyUserUpdate(user: User, patch: Partial<UserInput>, others: readonly User[]): User {
  const role = patch.role ?? user.role
  const fields = prepareUser(
    {
      name: patch.name ?? user.name,
      username: patch.username ?? user.username,
      role,
      pharmacistRegNo: patch.pharmacistRegNo === undefined ? user.pharmacistRegNo : patch.pharmacistRegNo,
      /* A role change with no new limits re-seeds them: the old ceiling belongs
         to the old role and carrying it across is exactly the demotion hole
         above. Same role, no patch — the person keeps their tuned numbers. */
      limits: patch.limits ?? (role === user.role ? user.limits : ROLE_STARTING_LIMITS[role]),
      isActive: patch.isActive ?? user.isActive,
    },
    others,
  )

  /* The other half of the last-admin guard, and the half that has teeth.
     `prepareUser` refuses to DISABLE the last admin, but demoting them reaches
     the same shop by a door that check cannot see: it reads `isActive` only, so
     admin → manager walks straight past it and leaves a roster no account can
     administer — including the one that just made the change. */
  const wasTheLastAdmin = user.role === 'admin' && user.isActive
    && !others.some((u) => u.role === 'admin' && u.isActive)
  if (wasTheLastAdmin && !(fields.role === 'admin' && fields.isActive)) {
    throw new ApiError({
      code: 'USER_LAST_ADMIN',
      message: 'This is the only admin left. Promote somebody else before moving this account off admin.',
      details: { field: 'role' },
    })
  }

  return { ...user, ...fields }
}

// ------------------------------------------------------------------ audit ---

const LIMIT_FIELD_LABEL: Record<keyof UserLimits, string> = {
  maxDiscountPct: 'Max discount %',
  maxRefundAmount: 'Max refund ₹',
  backdateDays: 'Backdate days',
  canViewCost: 'Sees cost',
}

const yesNo = (v: boolean): string => (v ? 'Yes' : 'No')

/**
 * What changed, field by field.
 *
 * The trail is worth having only if it carries the BEFORE. "Ravi edited a user"
 * answers nothing; "Ravi raised Sunita's discount ceiling from 5% to 20%" is
 * the sentence an owner reads once and acts on.
 */
export function diffUsers(before: User, after: User): AuditChange[] {
  const out: AuditChange[] = []
  const push = (field: string, a: string, b: string) => {
    if (a !== b) out.push({ field, before: a, after: b })
  }

  push('Name', before.name, after.name)
  push('Username', before.username, after.username)
  push('Role', ROLE_LABEL[before.role], ROLE_LABEL[after.role])
  push('Pharmacist reg. no.', before.pharmacistRegNo ?? '—', after.pharmacistRegNo ?? '—')
  push('Active', yesNo(before.isActive), yesNo(after.isActive))
  push(LIMIT_FIELD_LABEL.maxDiscountPct, before.limits.maxDiscountPct, after.limits.maxDiscountPct)
  push(LIMIT_FIELD_LABEL.maxRefundAmount, before.limits.maxRefundAmount, after.limits.maxRefundAmount)
  push(LIMIT_FIELD_LABEL.backdateDays, String(before.limits.backdateDays), String(after.limits.backdateDays))
  push(LIMIT_FIELD_LABEL.canViewCost, yesNo(before.limits.canViewCost), yesNo(after.limits.canViewCost))

  return out
}

export interface AuditActionSpec {
  label: string
  /** True for the handful an owner opens this log to find. */
  loss: boolean
}

export const AUDIT_ACTION_SPEC: Record<string, AuditActionSpec> = {
  LOGIN: { label: 'Signed in', loss: false },
  SALE_POSTED: { label: 'Bill posted', loss: false },
  SALE_VOIDED: { label: 'Bill voided', loss: true },
  RATE_EDITED: { label: 'Rate edited', loss: true },
  DISCOUNT_APPLIED: { label: 'Discount applied', loss: false },
  REFUND_ISSUED: { label: 'Refund issued', loss: true },
  DOCUMENT_BACKDATED: { label: 'Document backdated', loss: true },
  STOCK_ADJUSTED: { label: 'Stock adjusted', loss: true },
  BATCH_QUARANTINED: { label: 'Batch quarantined', loss: false },
  PURCHASE_POSTED: { label: 'Goods received', loss: false },
  MEDICINE_EDITED: { label: 'Medicine edited', loss: false },
  CUSTOMER_EDITED: { label: 'Customer edited', loss: false },
  CREDIT_LIMIT_CHANGED: { label: 'Credit limit changed', loss: true },
  CASH_COUNTED: { label: 'Drawer counted', loss: false },
  EXPORT_RUN: { label: 'Data exported', loss: true },
  USER_CREATED: { label: 'User created', loss: false },
  USER_UPDATED: { label: 'User updated', loss: true },
  USER_DEACTIVATED: { label: 'User disabled', loss: false },
}

/** The label, never a raw code, and never a crash on a code we have not met. */
export function auditLabel(action: string): string {
  return AUDIT_ACTION_SPEC[action]?.label ?? action
}

/** The calendar day an instant fell on, where the reader is. */
export function localDay(iso: string): IsoDate {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`
}

function haystack(row: AuditEntry): string {
  return [
    row.actorName, row.entity, row.entityRef, row.summary,
    row.override?.approverName ?? '', row.override?.note ?? '',
    ...row.changes.flatMap((c) => [c.field, c.before ?? '', c.after ?? '']),
  ].join(' ').toLowerCase()
}

/**
 * The trail, filtered and paged.
 *
 * Newest first, with the id breaking a tie: two entries written in the same
 * millisecond under an unstable sort would swap places between renders, and the
 * cursor would then hand back a row the reader has already seen while skipping
 * one they have not.
 *
 * `total` counts every MATCH, not the page. "Who voided a bill last month"
 * is answered by the count as much as by the rows.
 */
export function filterAudit(rows: readonly AuditEntry[], f: AuditFilters): AuditPage {
  const term = (f.term ?? '').trim().toLowerCase()

  const matched = rows.filter((row) => {
    if (f.actorId !== undefined && row.actorId !== f.actorId) return false
    if (f.action !== undefined && row.action !== f.action) return false
    if (f.onlyOverrides === true && row.override === null) return false
    // The timestamp is a UTC instant; the filter is the shop's calendar day, and
    // both ends are inclusive because "1st to 7th" includes the 7th to whoever
    // typed it. Slicing the ISO prefix instead would file a 10pm entry under
    // tomorrow anywhere east of Greenwich — which is where the shop is.
    const day = localDay(row.at)
    if (f.from !== undefined && f.from !== '' && day < f.from) return false
    if (f.to !== undefined && f.to !== '' && day > f.to) return false
    return term === '' || haystack(row).includes(term)
  })

  matched.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id))

  const limit = Math.max(1, Math.min(Math.floor(f.limit ?? 50), 500))
  const start = f.cursor !== undefined && f.cursor > 0 ? Math.min(Math.floor(f.cursor), matched.length) : 0
  const page = matched.slice(start, start + limit)
  const next = start + page.length
  return { rows: page, total: matched.length, nextCursor: next < matched.length ? next : null }
}

// --------------------------------------------------------------- exposure ---

export interface GuardedHolders {
  spec: PermissionSpec
  /** Active people who hold it. The names ARE the answer; a count is not. */
  holders: User[]
}

/**
 * The widest a dial is set anywhere, AND who it belongs to.
 *
 * The number on its own is not readable. An owner glancing at "100%" learns
 * nothing until they see it is their own account; the same 100% against a
 * cashier's name is the most urgent thing on the screen.
 */
export interface WidestSetting<T> {
  value: T
  holder: User | null
}

export interface Exposure {
  total: number
  active: number
  byRole: Record<Role, number>
  /** One row per guarded permission, in catalogue order. */
  guarded: GuardedHolders[]
  widestDiscount: WidestSetting<Pct>
  largestRefund: WidestSetting<Money>
  furthestBackdate: WidestSetting<number>
  /** Active accounts that can be told what the shop paid. */
  costViewers: number
}

/**
 * What this roster can actually do, as of now.
 *
 * The question behind the whole screen is not "how many users are there" but
 * "how many people can void a bill, and which ones". Counting the ROLE would
 * answer it wrongly: a pharmacist with the cost flag off does not see cost, and
 * a disabled manager voids nothing. So it counts through `can`, one person at a
 * time, which is the same function the counter will be gated on.
 */
export function exposure(users: readonly User[], holds: Holds = can): Exposure {
  const active = users.filter((u) => u.isActive)
  const byRole: Record<Role, number> = { admin: 0, manager: 0, pharmacist: 0, cashier: 0 }
  for (const u of active) byRole[u.role] += 1

  let widest = D.ZERO
  const discount: WidestSetting<Pct> = { value: '0', holder: null }
  let largest = D.ZERO
  const refund: WidestSetting<Money> = { value: '0', holder: null }
  const backdate: WidestSetting<number> = { value: 0, holder: null }

  for (const u of active) {
    const pct = limitDec(u.limits.maxDiscountPct)
    if (pct !== null && D.gt(pct, widest)) {
      widest = pct
      discount.value = u.limits.maxDiscountPct
      discount.holder = u
    }
    const amount = limitDec(u.limits.maxRefundAmount)
    if (amount !== null && D.gt(amount, largest)) {
      largest = amount
      refund.value = u.limits.maxRefundAmount
      refund.holder = u
    }
    if (u.limits.backdateDays > backdate.value) {
      backdate.value = u.limits.backdateDays
      backdate.holder = u
    }
  }

  return {
    total: users.length,
    active: active.length,
    byRole,
    guarded: PERMISSION_CATALOGUE
      .filter((spec) => spec.guard !== null)
      .map((spec) => ({ spec, holders: active.filter((u) => holds(u, spec.id)) })),
    widestDiscount: discount,
    largestRefund: refund,
    furthestBackdate: backdate,
    costViewers: active.filter((u) => u.limits.canViewCost).length,
  }
}

/** How many of the catalogue's permissions a role grants. */
export function grantCount(role: Role): number {
  return ROLE_GRANTS[role].length
}
