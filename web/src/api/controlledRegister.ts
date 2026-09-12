import type { DrugSchedule, IsoDate, LedgerReason, Qty, StockMovement } from '@contract'
import * as D from '@/domain/decimal'

/**
 * The running-balance register for controlled drugs.
 *
 * A shop selling Schedule X or H1 items is asked, by an inspector standing at
 * the counter, a question no ordinary stock report answers: for THIS drug, show
 * me every receipt and every issue in order, with the balance after each one,
 * and show me that it ends where the shelf is. A stock statement gives a figure;
 * a register gives the arithmetic that produced it.
 *
 * WHAT THIS IS AND IS NOT. It is the shop's own movement record, laid out as a
 * running balance and reconciled against the shelf. It is deliberately NOT a
 * rendering of a statutory form: the exact columns, the form number and the
 * retention period are in `docs/UNVERIFIED.md` and are not asserted anywhere in
 * this app until somebody has read them in the gazette. Printing a form number
 * this code cannot cite would be worse than printing none — it would tell a
 * pharmacist they are compliant on the strength of a guess.
 *
 * Two structural facts drive the whole module:
 *
 *  - THE LEDGER'S `balanceAfter` IS PER BATCH, AND A REGISTER IS PER DRUG. They
 *    cannot be reused, so the per-drug running balance is folded here — and
 *    because it is a second balance, it is checked against the shelf rather than
 *    trusted. `balanced` is the whole point of computing it at all.
 *  - ORDER IS (time, ledger id), NEVER TIME ALONE. Two movements land in the
 *    same second all day at a busy counter, and a register whose rows reorder
 *    between two readings of the same day is not a register. The ledger id is
 *    append-only and monotonic, which makes it the tie-break that exists.
 */

/**
 * Which schedules get a register, as data.
 *
 * X and H1 by default because those are the two this app already treats as
 * controlled elsewhere — the H1 capture at billing, the schedule chips. It is a
 * list rather than a condition so that adding G or a state-specific class later
 * is a row, not a branch.
 */
export const REGISTERED_SCHEDULES: readonly DrugSchedule[] = ['X', 'H1']

/** In the words a register column uses, not the enum's. */
export const MOVEMENT_LABEL: Record<LedgerReason, string> = {
  OPENING: 'Opening stock',
  PURCHASE: 'Received from supplier',
  SALE: 'Dispensed',
  SALE_RETURN: 'Returned by customer',
  PURCHASE_RETURN: 'Returned to supplier',
  ADJUSTMENT: 'Adjusted',
  EXPIRY_WRITEOFF: 'Written off — expired',
  TRANSFER: 'Branch transfer',
}

export interface RegisterEntry {
  /** The ledger row. Carried through so a row can be traced back to its source. */
  id: number
  at: string
  reason: LedgerReason
  direction: 'IN' | 'OUT'
  /** Always positive. `direction` carries the sign, because a register has two columns. */
  qty: Qty
  /** The running balance for the DRUG after this movement, not for the batch. */
  balanceAfter: Qty
  batchNo: string
  refType: string
  refId: string
  note: string | null
}

export interface DrugRegister {
  medicineId: number
  brandName: string
  schedule: DrugSchedule
  from: IsoDate
  to: IsoDate
  opening: Qty
  entries: RegisterEntry[]
  received: Qty
  issued: Qty
  closing: Qty
  /** Live stock across this drug's batches, or null when it was not supplied. */
  onHand: Qty | null
  /**
   * Whether the register's closing balance is the shelf.
   *
   * Null, not `true`, when the window ends before today: a closing balance from
   * March cannot be compared with a shelf counted in September, and reporting
   * "balanced" for a period whose stock has since moved would be a claim this
   * module has no basis for.
   */
  balanced: boolean | null
  /** Closing minus shelf. Zero when balanced, null when not comparable. */
  discrepancy: Qty | null
}

export interface RegisterInput {
  medicineId: number
  brandName: string
  schedule: DrugSchedule
  /** Every movement this drug has ever had, in any order. */
  movements: readonly StockMovement[]
  from: IsoDate
  to: IsoDate
  /** Sum of qtyOnHand across the drug's batches, when the caller has it. */
  onHand?: Qty | null
  /** The day the register is being read. Decides whether `balanced` is answerable. */
  today: IsoDate
}

/** The day part of a timestamp, so a window compares like with like. */
const dayOf = (at: string): string => at.slice(0, 10)

/**
 * Ordered by time, then by ledger id.
 *
 * The id tie-break is not a nicety. Three strips dispensed on one bill produce
 * three rows with the same timestamp, and a sort that leaves them in engine
 * order gives a different running balance on a second read of the same day.
 */
function inOrder(movements: readonly StockMovement[]): StockMovement[] {
  return [...movements].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id)
}

/**
 * One drug's register for a window.
 *
 * The opening balance is folded from everything BEFORE the window rather than
 * taken from a stored figure, so a register opened on any date is derivable from
 * the ledger alone — which is what makes it reconstructible after a restore.
 */
export function buildRegister(input: RegisterInput): DrugRegister {
  const ordered = inOrder(input.movements)

  let running = D.ZERO
  const entries: RegisterEntry[] = []
  let received = D.ZERO
  let issued = D.ZERO

  /* Captured as the window opens, NOT back-derived from the closing balance.
     A derived opening would make `foots()` a tautology — it would restate the
     fold instead of checking it, and a fold bug would pass silently. */
  let opening: D.Decimal | null = null

  for (const m of ordered) {
    const delta = D.dec(m.qtyDelta)
    const day = dayOf(m.at)

    if (day < input.from) {
      // Before the window: it moves the opening balance and nothing else.
      running = D.add(running, delta)
      continue
    }
    if (day > input.to) break
    if (opening === null) opening = running

    running = D.add(running, delta)
    const out = D.isNeg(delta)
    const qty = D.abs(delta)
    if (out) issued = D.add(issued, qty)
    else received = D.add(received, qty)

    entries.push({
      id: m.id,
      at: m.at,
      reason: m.reason,
      direction: out ? 'OUT' : 'IN',
      qty: D.toStr(qty, 3),
      balanceAfter: D.toStr(running, 3),
      batchNo: m.batchNo,
      refType: m.refType,
      refId: m.refId,
      note: m.note,
    })
  }

  const closing = running
  /* No movement in the window at all: the opening balance is still whatever the
     drug held when the window began, which is exactly where `running` stopped. */
  const openingBalance = opening ?? running

  /* Comparable only when the register runs up to today. A March closing balance
     against a September shelf is not a discrepancy, it is six months of trading. */
  const comparable = input.to >= input.today && input.onHand != null
  const shelf = input.onHand != null ? D.dec(input.onHand) : null
  const discrepancy = comparable && shelf ? D.sub(closing, shelf) : null

  return {
    medicineId: input.medicineId,
    brandName: input.brandName,
    schedule: input.schedule,
    from: input.from,
    to: input.to,
    opening: D.toStr(openingBalance, 3),
    entries,
    received: D.toStr(received, 3),
    issued: D.toStr(issued, 3),
    closing: D.toStr(closing, 3),
    onHand: input.onHand ?? null,
    balanced: discrepancy === null ? null : D.isZero(discrepancy),
    discrepancy: discrepancy === null ? null : D.toStr(discrepancy, 3),
  }
}

/**
 * The one line a register has to be able to state: where the balance came from.
 *
 * Opening plus received minus issued IS the closing balance, by construction —
 * so a register that cannot say this sentence has a fold bug, and printing it is
 * how the bug becomes visible to the person reading the page rather than only to
 * a test.
 */
export function foots(reg: DrugRegister): boolean {
  return D.eq(
    D.sub(D.add(D.dec(reg.opening), D.dec(reg.received)), D.dec(reg.issued)),
    D.dec(reg.closing),
  )
}

/**
 * Registers worth showing first.
 *
 * An unbalanced register is the only urgent row on the page: it means the
 * ledger and the shelf disagree on a controlled drug, which is the single thing
 * an inspection turns on. Everything else sorts by name so the list is findable.
 */
export function sortRegisters(regs: readonly DrugRegister[]): DrugRegister[] {
  return [...regs].sort((a, b) => {
    const bad = (r: DrugRegister) => (r.balanced === false ? 0 : 1)
    return bad(a) - bad(b) || a.brandName.localeCompare(b.brandName)
  })
}
