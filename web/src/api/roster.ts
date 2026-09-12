import type {
  AuditAction, AuditEntry, IsoDate, Money, Override, Permission, Role, User,
} from '@contract'
import * as D from '@/domain/decimal'
import {
  AUDIT_ACTION_SPEC, PERMISSION_CATALOGUE, auditLabel, can, canApprove, localDay,
} from './users'
import type { Holds, PermissionSpec } from './users'

/**
 * What the roster and the trail say about the counter, as pure value logic.
 *
 * `users.ts` answers "may this person do that". This module answers the four
 * questions an owner asks about people AFTER the policy is settled, and every
 * one of them is derived rather than stored:
 *
 *   WHO WAS ON THE COUNTER, AND WHEN. A shift is not a record anybody keys — it
 *   is the shape the trail already has. Every stamped action carries a till and
 *   an actor, so a day at a till by a person IS the shift, and the drawer count
 *   at the end of it is the shift's result.
 *   WHAT HAS THIS PERSON BEEN DOING. The same rows, filtered to one actor, with
 *   the handful that cost money separated from the hundred that did not.
 *   WHICH SIGNATURES NEED READING. Every override in the window, RE-CHECKED
 *   against the roster as it stands today — because the manager who signed a
 *   ₹1,180 refund in June may since have had their ceiling cut, or left.
 *   WHAT DOES THE ROSTER COST. Not "how many users": how many rupees can leave
 *   the till today with nobody signing for them.
 *
 * Money is summed with `@/domain/decimal`, never with `+`. An audit amount is a
 * string that arrived from the wire and a day's takings added up as floats is a
 * figure that disagrees with the sales register by paise for no reason anybody
 * can explain at a month end.
 */

const MINUTE = 60_000

/** A money string that cannot be read is absent, never zero. */
function money(v: string | null | undefined): D.Decimal | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return /^-?\d+(\.\d+)?$/.test(t) ? D.dec(t) : null
}

const money2 = (d: D.Decimal): Money => D.toStr(D.round(d, 2), 2)

// ------------------------------------------------------------------ shifts ---

export interface Shift {
  /** Stable across renders: the three things that define the shift. */
  key: string
  day: IsoDate
  terminalId: number
  actorId: number
  actorName: string
  actorRole: Role
  /** First and last stamped action on this till, that day, by this person. */
  from: string
  to: string
  minutes: number
  /** True when a LOGIN row anchors the start rather than the first sale. */
  signedIn: boolean
  bills: number
  takings: Money
  voids: number
  voided: Money
  refunds: number
  refunded: Money
  /** Rows on this shift that a second person had to sign. */
  overrides: number
  /** The closing count, as it was recorded. Null when the drawer was never counted. */
  drawerVariance: Money | null
  entryIds: number[]
}

/**
 * The trail, folded into shifts.
 *
 * ONE SHIFT PER PERSON PER TILL PER DAY, deliberately, rather than splitting on
 * a gap between actions. A pharmacy counter goes quiet for two hours in the
 * afternoon and that is not two shifts; splitting on idle time would file the
 * lunch lull as a handover and then report twice as many people on the counter
 * as ever stood there. A person who genuinely works a morning at till 1 and an
 * evening at till 2 shows as two shifts, because the till changed.
 *
 * Rows with no terminal — a stock adjustment in the back room, a user edit — are
 * not counter work and are left out. They are still in the person's activity.
 */
export function shiftsFrom(rows: readonly AuditEntry[]): Shift[] {
  const byKey = new Map<string, Shift>()

  for (const row of rows) {
    if (row.terminalId === null) continue
    const day = localDay(row.at)
    if (day === '') continue
    const key = `${day}|${row.terminalId}|${row.actorId}`

    let shift = byKey.get(key)
    if (!shift) {
      shift = {
        key,
        day,
        terminalId: row.terminalId,
        actorId: row.actorId,
        actorName: row.actorName,
        actorRole: row.actorRole,
        from: row.at,
        to: row.at,
        minutes: 0,
        signedIn: false,
        bills: 0,
        takings: '0.00',
        voids: 0,
        voided: '0.00',
        refunds: 0,
        refunded: '0.00',
        overrides: 0,
        drawerVariance: null,
        entryIds: [],
      }
      byKey.set(key, shift)
    }

    if (row.at < shift.from) shift.from = row.at
    if (row.at > shift.to) shift.to = row.at
    shift.entryIds.push(row.id)
    if (row.action === 'LOGIN') shift.signedIn = true
    if (row.override !== null) shift.overrides += 1

    const amount = money(row.amount)
    if (row.action === 'SALE_POSTED') {
      shift.bills += 1
      if (amount) shift.takings = money2(D.add(D.dec(shift.takings), amount))
    } else if (row.action === 'SALE_VOIDED') {
      shift.voids += 1
      if (amount) shift.voided = money2(D.add(D.dec(shift.voided), D.abs(amount)))
    } else if (row.action === 'REFUND_ISSUED') {
      shift.refunds += 1
      if (amount) shift.refunded = money2(D.add(D.dec(shift.refunded), D.abs(amount)))
    } else if (row.action === 'CASH_COUNTED' && amount) {
      /* The LAST count of the shift wins. A till counted twice was counted
         again because the first answer was wrong. */
      shift.drawerVariance = money2(amount)
    }
  }

  const out = [...byKey.values()]
  for (const shift of out) {
    const spanned = new Date(shift.to).getTime() - new Date(shift.from).getTime()
    shift.minutes = Number.isFinite(spanned) ? Math.max(0, Math.round(spanned / MINUTE)) : 0
    shift.entryIds.sort((a, b) => a - b)
  }
  /* Newest first, and within a day the earliest till first: the reader is
     scanning days, and inside one day they are reading a counter rota. */
  out.sort((a, b) => (a.day === b.day
    ? a.terminalId - b.terminalId || (a.from < b.from ? -1 : 1)
    : a.day < b.day ? 1 : -1))
  return out
}

export interface CounterDay {
  day: IsoDate
  shifts: Shift[]
  tills: number
  people: number
  bills: number
  takings: Money
  voids: number
  overrides: number
  /** Every drawer variance on the day, added up. Null when nothing was counted. */
  variance: Money | null
}

/** Shifts grouped into the days they belong to. Newest day first. */
export function counterDays(shifts: readonly Shift[]): CounterDay[] {
  const byDay = new Map<IsoDate, Shift[]>()
  for (const shift of shifts) {
    const list = byDay.get(shift.day)
    if (list) list.push(shift)
    else byDay.set(shift.day, [shift])
  }

  const out: CounterDay[] = []
  for (const [day, list] of byDay) {
    let takings = D.ZERO
    let variance: D.Decimal | null = null
    let bills = 0
    let voids = 0
    let overrides = 0
    for (const shift of list) {
      takings = D.add(takings, D.dec(shift.takings))
      bills += shift.bills
      voids += shift.voids
      overrides += shift.overrides
      if (shift.drawerVariance !== null) {
        variance = D.add(variance ?? D.ZERO, D.dec(shift.drawerVariance))
      }
    }
    out.push({
      day,
      shifts: list,
      tills: new Set(list.map((s) => s.terminalId)).size,
      people: new Set(list.map((s) => s.actorId)).size,
      bills,
      takings: money2(takings),
      voids,
      overrides,
      variance: variance === null ? null : money2(variance),
    })
  }
  out.sort((a, b) => (a.day < b.day ? 1 : -1))
  return out
}

// ---------------------------------------------------------------- activity ---

export interface ActionCount {
  action: AuditAction
  label: string
  count: number
  /** The handful an owner opens the log to find. */
  loss: boolean
}

export interface Activity {
  /** Everything this person did in the loaded window, newest first. */
  entries: AuditEntry[]
  total: number
  /** Rows whose action is one of the ones that costs money. */
  lossCount: number
  /** Overrides they ASKED for. */
  requested: number
  /** Overrides they SIGNED for somebody else. */
  approved: number
  lastSeen: string | null
  firstSeen: string | null
  breakdown: ActionCount[]
  /** Rupees that passed through their hands in the window, as a magnitude. */
  moneyTouched: Money
  shifts: Shift[]
}

const EMPTY_ACTIVITY: Activity = {
  entries: [], total: 0, lossCount: 0, requested: 0, approved: 0,
  lastSeen: null, firstSeen: null, breakdown: [], moneyTouched: '0.00', shifts: [],
}

/**
 * One person's fortnight.
 *
 * `approved` counts rows where they are the APPROVER, which is why the whole
 * window is scanned rather than the rows already filtered by actor: signing for
 * somebody else's void is the single most important thing a manager does on this
 * screen and it never appears under their own name.
 */
export function activityFor(
  rows: readonly AuditEntry[],
  shifts: readonly Shift[],
  userId: number,
): Activity {
  if (rows.length === 0) return { ...EMPTY_ACTIVITY }

  const mine: AuditEntry[] = []
  let approved = 0
  for (const row of rows) {
    if (row.override?.approverId === userId && row.actorId !== userId) approved += 1
    if (row.actorId === userId) mine.push(row)
  }
  mine.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id))

  const counts = new Map<AuditAction, number>()
  let lossCount = 0
  let requested = 0
  let touched = D.ZERO
  for (const row of mine) {
    counts.set(row.action, (counts.get(row.action) ?? 0) + 1)
    if (AUDIT_ACTION_SPEC[row.action]?.loss === true) lossCount += 1
    if (row.override !== null) requested += 1
    const amount = money(row.amount)
    if (amount) touched = D.add(touched, D.abs(amount))
  }

  const breakdown = [...counts.entries()]
    .map(([action, count]) => ({
      action,
      label: auditLabel(action),
      count,
      loss: AUDIT_ACTION_SPEC[action]?.loss === true,
    }))
    /* Loss-bearing actions first, then by frequency. A panel that leads with
       "42 bills posted" buries the one voided bill underneath it. */
    .sort((a, b) => Number(b.loss) - Number(a.loss) || b.count - a.count)

  return {
    entries: mine,
    total: mine.length,
    lossCount,
    requested,
    approved,
    lastSeen: mine[0]?.at ?? null,
    firstSeen: mine[mine.length - 1]?.at ?? null,
    breakdown,
    moneyTouched: money2(touched),
    shifts: shifts.filter((s) => s.actorId === userId),
  }
}

// --------------------------------------------------------------- approvals ---

/**
 * Whether a recorded signature would still be given today.
 *
 * `self-approved` can only appear in data that came from somewhere this code did
 * not write — `buildOverride` refuses it and Phase 5 has it as a CHECK — which
 * is exactly why it is checked here. An invariant nobody re-reads is an
 * invariant that gets quietly relaxed by an import.
 */
export type ApprovalStanding =
  | 'stands'
  | 'self-approved'
  | 'approver-gone'
  | 'approver-disabled'
  | 'approver-cannot'

export interface ApprovalItem {
  entry: AuditEntry
  override: Override
  standing: ApprovalStanding
  /** Why it no longer stands, in the words the screen shows. Null when it does. */
  why: string | null
  /** Rupees the signature let through. '0.00' when the ask was not money. */
  atStake: Money
  /** True for the reasons that move stock or cash rather than reveal a number. */
  costly: boolean
}

const COSTLY_REASONS: ReadonlySet<Override['reasonCode']> = new Set<Override['reasonCode']>([
  'DISCOUNT_LIMIT', 'REFUND_LIMIT', 'RATE_EDIT', 'BILL_VOID', 'CREDIT_LIMIT',
])

/**
 * Every signature in the window, re-checked against today's roster.
 *
 * The re-check is the whole reason this is a queue rather than a filter on the
 * log. A signature is a fact about June; whether the person who gave it could
 * give it TODAY is a fact about the roster, and the gap between the two is where
 * an owner finds either a limit that was too generous or a manager who has been
 * quietly signing past their own ceiling.
 */
export function approvalQueue(
  rows: readonly AuditEntry[],
  users: readonly User[],
  today: IsoDate,
  holds: Holds = can,
): ApprovalItem[] {
  const byId = new Map<number, User>(users.map((u) => [u.id, u]))

  const out: ApprovalItem[] = []
  for (const entry of rows) {
    const override = entry.override
    if (override === null) continue

    const approver = byId.get(override.approverId) ?? null
    const requester = byId.get(override.requesterId) ?? null

    let standing: ApprovalStanding = 'stands'
    let why: string | null = null

    if (override.approverId === override.requesterId) {
      standing = 'self-approved'
      why = 'The same account asked and signed. That pairing is refused everywhere it can be checked.'
    } else if (approver === null || requester === null) {
      standing = 'approver-gone'
      why = 'One of the two accounts is no longer on the roster, so the pairing cannot be re-checked.'
    } else if (!approver.isActive) {
      standing = 'approver-disabled'
      why = `${approver.name}’s account has since been disabled.`
    } else {
      const verdict = canApprove(
        approver, requester, override.reasonCode, override.requested,
        override.reasonCode === 'BACKDATE' ? today : undefined,
        holds,
      )
      if (!verdict.ok) {
        standing = 'approver-cannot'
        why = `${verdict.why ?? 'They could not sign this today.'} It stood when it was given.`
      }
    }

    const amount = money(entry.amount) ?? money(override.requested)
    out.push({
      entry,
      override,
      standing,
      why,
      atStake: amount ? money2(D.abs(amount)) : '0.00',
      costly: COSTLY_REASONS.has(override.reasonCode),
    })
  }

  /* Anything that no longer stands floats to the top; the rest is newest first.
     A queue sorted purely by time buries the one row that has changed meaning
     since it was written. */
  out.sort((a, b) => {
    const flagged = Number(b.standing !== 'stands') - Number(a.standing !== 'stands')
    if (flagged !== 0) return flagged
    return a.entry.at < b.entry.at ? 1 : a.entry.at > b.entry.at ? -1 : b.entry.id - a.entry.id
  })
  return out
}

export interface ApprovalTotals {
  count: number
  /** Rupees that a second signature let through in the window. */
  atStake: Money
  /** Items that would not be given the same way today. */
  questionable: number
}

export function approvalTotals(items: readonly ApprovalItem[]): ApprovalTotals {
  let atStake = D.ZERO
  let questionable = 0
  for (const item of items) {
    atStake = D.add(atStake, D.dec(item.atStake))
    if (item.standing !== 'stands') questionable += 1
  }
  return { count: items.length, atStake: money2(atStake), questionable }
}

// ------------------------------------------------- the review of approvals ---

export type ReviewState = 'reviewed' | 'flagged'

export interface ReviewMark {
  state: ReviewState
  at: string
  by: string
  note: string | null
}

/** Keyed by audit entry id, as a string — JSON has no integer keys. */
export type ReviewLedger = Record<string, ReviewMark>

export const REVIEW_STORAGE_KEY = 'rxbill.approvalReview'

const EMPTY_LEDGER: ReviewLedger = {}

/**
 * Which signatures the owner has already read.
 *
 * Stored beside the log rather than in it, because reading an override is not an
 * event in the shop's history — it is a bookmark. Writing it into the trail
 * would double the trail's volume with rows that record nothing having happened,
 * and the one thing a trail must stay is readable.
 */
export function readReviews(raw: string | null): ReviewLedger {
  if (raw === null || raw.trim() === '') return EMPTY_LEDGER
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_LEDGER
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_LEDGER

  const out: ReviewLedger = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    if (typeof value !== 'object' || value === null) continue
    const mark = value as Partial<ReviewMark>
    if (mark.state !== 'reviewed' && mark.state !== 'flagged') continue
    out[key] = {
      state: mark.state,
      at: typeof mark.at === 'string' ? mark.at : '',
      by: typeof mark.by === 'string' ? mark.by : '',
      note: typeof mark.note === 'string' && mark.note.trim() !== '' ? mark.note.trim() : null,
    }
  }
  return out
}

export function markReview(ledger: ReviewLedger, entryId: number, mark: ReviewMark): ReviewLedger {
  return { ...ledger, [String(entryId)]: { ...mark, note: mark.note?.trim() ? mark.note.trim() : null } }
}

export function clearReview(ledger: ReviewLedger, entryId: number): ReviewLedger {
  const out = { ...ledger }
  delete out[String(entryId)]
  return out
}

export function reviewOf(ledger: ReviewLedger, entryId: number): ReviewMark | null {
  return ledger[String(entryId)] ?? null
}

export type ReviewBucket = 'unread' | 'reviewed' | 'flagged'

export function bucketOf(ledger: ReviewLedger, entryId: number): ReviewBucket {
  return reviewOf(ledger, entryId)?.state ?? 'unread'
}

export function reviewCounts(
  items: readonly ApprovalItem[],
  ledger: ReviewLedger,
): Record<ReviewBucket, number> {
  const out: Record<ReviewBucket, number> = { unread: 0, reviewed: 0, flagged: 0 }
  for (const item of items) out[bucketOf(ledger, item.entry.id)] += 1
  return out
}

// ------------------------------------------------------------ money power ---

export interface CostlyPower {
  spec: PermissionSpec
  /** Live accounts that hold it. The names ARE the answer; a count is not. */
  holders: User[]
  /** Times it was used in the loaded window. */
  used: number
  /** Rupees those uses moved, as a magnitude. */
  moved: Money
  /**
   * False for the powers that leave no row: seeing landed cost, a purchase rate
   * or a margin is a READ, and a read is not an event. Saying so is the point —
   * these are the three that cannot be audited after the fact, only granted
   * carefully.
   */
  logged: boolean
}

export interface MoneyPower {
  activeAccounts: number
  /** Every live account's unaided refund ceiling, added up. */
  refundAuthority: Money
  /**
   * The same figure without the accounts that are unlimited by definition.
   *
   * An owner's account carries a ten-lakh ceiling because it has to, and it
   * drowns the number that actually describes the counter. Both are shown; this
   * is the one that changes when a cashier is promoted.
   */
  counterAuthority: Money
  /** What the unlimited accounts contribute, so the difference is explained. */
  ownerAuthority: Money
  /** Live accounts that can be told what the shop paid. */
  costViewers: number
  powers: CostlyPower[]
}

/** Which audit action records a guarded power being exercised. */
const POWER_ACTION: Partial<Record<Permission, AuditAction>> = {
  'billing.rate_edit': 'RATE_EDITED',
  'billing.void': 'SALE_VOIDED',
  'billing.backdate': 'DOCUMENT_BACKDATED',
}

const UNLIMITED_ROLES: ReadonlySet<Role> = new Set<Role>(['admin'])

/**
 * Who can do what that costs money, with the rupees attached.
 *
 * The counting goes through `holds` one person at a time rather than through the
 * role, because a disabled manager voids nothing and a pharmacist with the cost
 * flag off sees no cost — and a summary that counts roles reports powers this
 * shop does not actually have.
 */
export function moneyPower(
  users: readonly User[],
  rows: readonly AuditEntry[],
  holds: Holds = can,
): MoneyPower {
  const active = users.filter((u) => u.isActive)

  let all = D.ZERO
  let owner = D.ZERO
  for (const u of active) {
    const ceiling = money(u.limits.maxRefundAmount)
    if (!ceiling) continue
    all = D.add(all, ceiling)
    if (UNLIMITED_ROLES.has(u.role)) owner = D.add(owner, ceiling)
  }

  const powers: CostlyPower[] = PERMISSION_CATALOGUE
    .filter((spec) => spec.guard !== null)
    .map((spec) => {
      const action = POWER_ACTION[spec.id]
      let used = 0
      let moved = D.ZERO
      if (action !== undefined) {
        for (const row of rows) {
          if (row.action !== action) continue
          used += 1
          const amount = money(row.amount)
          if (amount) moved = D.add(moved, D.abs(amount))
        }
      }
      return {
        spec,
        holders: active.filter((u) => holds(u, spec.id)),
        used,
        moved: money2(moved),
        logged: action !== undefined,
      }
    })

  return {
    activeAccounts: active.length,
    refundAuthority: money2(all),
    counterAuthority: money2(D.sub(all, owner)),
    ownerAuthority: money2(owner),
    costViewers: active.filter((u) => u.limits.canViewCost).length,
    powers,
  }
}
