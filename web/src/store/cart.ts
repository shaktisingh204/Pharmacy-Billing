import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { PrescriptionInput, Qty } from '@contract'

/**
 * The cart.
 *
 * Lines are NORMALISED ({ ids, byId }) rather than an array of objects so that
 * editing one row's quantity re-renders that row and nothing else. On a 30-line
 * bill an array-of-objects store re-renders every row on every keystroke, which is
 * exactly the sluggishness pharmacists complain about in incumbent software.
 */

export interface CartLine {
  lineId: string
  medicineId: number
  brandName: string
  packLabel: string
  unitsPerPack: number
  allowLooseSale: boolean
  qty: Qty
  freeQty: Qty
  discountPct: string
  /**
   * What the CHAIN's price list said for this medicine when the line was added.
   *
   * Kept beside the applied discount rather than folded into it, because the two
   * answer different questions. The chain's 9% off Cipla is the shop's price and
   * every cashier must be able to bill it; anything the operator adds on top is
   * discretion, and that is what a discount ceiling governs. Collapsing them
   * would either make the price list unbillable by junior staff or make the
   * ceiling meaningless.
   */
  policyPct: string
  /** Set only when the pharmacist overrode FEFO with F3. */
  batchOverride?: Array<{ batchId: number; qty: Qty }>
  overrideReason?: string
  /** A dispensing instruction for this line — "1-0-1 after food". */
  note?: string
}

export type CartStage = 'CART' | 'PAYMENT'

interface CartState {
  ids: string[]
  byId: Record<string, CartLine>
  customerId: number | null
  billDiscountPct: string
  /** A remark about the whole bill — delivery, who is collecting, what to tell them. */
  billNote: string
  prescription: PrescriptionInput | null
  stage: CartStage
  /** The row the keyboard is on. Drives F3/F4/Ctrl+D without a mouse. */
  focusedLineId: string | null
  recalledToken: number | null

  addLine(
    input: Omit<CartLine, 'lineId' | 'qty' | 'freeQty' | 'discountPct' | 'policyPct'>
      & Partial<Pick<CartLine, 'qty' | 'discountPct' | 'policyPct'>>,
  ): string
  setQty(lineId: string, qty: Qty): void
  bumpQty(lineId: string, delta: number): void
  setFreeQty(lineId: string, qty: Qty): void
  setDiscount(lineId: string, pct: string): void
  setLineNote(lineId: string, note: string): void
  setOverride(lineId: string, override: CartLine['batchOverride'], reason: string): void
  clearOverride(lineId: string): void
  removeLine(lineId: string): void
  focusLine(lineId: string | null): void
  setCustomer(id: number | null): void
  setBillDiscount(pct: string): void
  setBillNote(note: string): void
  setPrescription(p: PrescriptionInput | null): void
  setStage(s: CartStage): void
  loadLines(lines: CartLine[], customerId: number | null, token: number | null, billNote?: string): void
  reset(): void
}

const EMPTY = {
  ids: [] as string[],
  byId: {} as Record<string, CartLine>,
  customerId: null,
  billDiscountPct: '0',
  billNote: '',
  prescription: null,
  stage: 'CART' as CartStage,
  focusedLineId: null,
  recalledToken: null,
}

export const useCart = create<CartState>((set, get) => ({
  ...EMPTY,

  addLine(input) {
    // Scanning the same strip twice increments rather than creating a duplicate
    // row — a second row for the same medicine is never what the operator meant.
    const existing = get().ids.find((id) => get().byId[id]?.medicineId === input.medicineId)
    if (existing) {
      const line = get().byId[existing]
      if (line) {
        const next = String(Number(line.qty) + Number(input.qty ?? '1'))
        set((s) => ({ byId: { ...s.byId, [existing]: { ...line, qty: next } }, focusedLineId: existing }))
        return existing
      }
    }
    const lineId = nanoid(8)
    const line: CartLine = {
      ...input,
      lineId,
      qty: input.qty ?? '1',
      freeQty: '0',
      /* The list price is where a line STARTS. Zero when no list is in force —
         which is a real state, not a default: a chain that has published nothing
         has not priced anything, and pretending otherwise would invent a policy. */
      discountPct: input.discountPct ?? input.policyPct ?? '0',
      policyPct: input.policyPct ?? '0',
    }
    set((s) => ({ ids: [...s.ids, lineId], byId: { ...s.byId, [lineId]: line }, focusedLineId: lineId }))
    return lineId
  },

  setQty(lineId, qty) {
    const line = get().byId[lineId]
    if (!line) return
    set((s) => ({ byId: { ...s.byId, [lineId]: { ...line, qty } } }))
  },

  bumpQty(lineId, delta) {
    const line = get().byId[lineId]
    if (!line) return
    const step = line.allowLooseSale ? 1 : line.unitsPerPack
    const next = Math.max(step, Number(line.qty) + delta * step)
    set((s) => ({ byId: { ...s.byId, [lineId]: { ...line, qty: String(next) } } }))
  },

  setFreeQty(lineId, freeQty) {
    const line = get().byId[lineId]
    if (!line) return
    set((s) => ({ byId: { ...s.byId, [lineId]: { ...line, freeQty } } }))
  },

  setDiscount(lineId, discountPct) {
    const line = get().byId[lineId]
    if (!line) return
    set((s) => ({ byId: { ...s.byId, [lineId]: { ...line, discountPct } } }))
  },

  setLineNote(lineId, note) {
    const line = get().byId[lineId]
    if (!line) return
    /*
     * Stored EXACTLY as typed, and trimmed only at the wire.
     *
     * Trimming here instead looks harmless and makes a space untypeable: the
     * field is controlled, so "1-0-1 " came back as "1-0-1" on the very
     * keystroke that added the space and the next letter landed against it —
     * "1-0-1after food". An emptied note is still REMOVED rather than kept as
     * '', because an empty string reaches the receipt as a blank instruction
     * line under the item.
     */
    const { note: _dropped, ...withoutNote } = line
    const next: CartLine = note.trim() ? { ...line, note } : withoutNote
    set((s) => ({ byId: { ...s.byId, [lineId]: next } }))
  },

  setOverride(lineId, batchOverride, overrideReason) {
    const line = get().byId[lineId]
    if (!line) return
    set((s) => ({ byId: { ...s.byId, [lineId]: { ...line, batchOverride, overrideReason } } }))
  },

  clearOverride(lineId) {
    const line = get().byId[lineId]
    if (!line) return
    const { batchOverride: _b, overrideReason: _r, ...rest } = line
    set((s) => ({ byId: { ...s.byId, [lineId]: rest } }))
  },

  removeLine(lineId) {
    set((s) => {
      const { [lineId]: _removed, ...byId } = s.byId
      const ids = s.ids.filter((i) => i !== lineId)
      const wasFocused = s.focusedLineId === lineId
      const idx = s.ids.indexOf(lineId)
      return {
        ids,
        byId,
        focusedLineId: wasFocused ? (ids[Math.min(idx, ids.length - 1)] ?? null) : s.focusedLineId,
      }
    })
  },

  focusLine(focusedLineId) { set({ focusedLineId }) },
  setCustomer(customerId) { set({ customerId }) },
  setBillDiscount(billDiscountPct) { set({ billDiscountPct }) },
  setBillNote(billNote) { set({ billNote }) },
  setPrescription(prescription) { set({ prescription }) },
  setStage(stage) { set({ stage }) },

  loadLines(lines, customerId, recalledToken, billNote = '') {
    set({
      ids: lines.map((l) => l.lineId),
      byId: Object.fromEntries(lines.map((l) => [l.lineId, l])),
      customerId,
      billNote,
      recalledToken,
      stage: 'CART',
      focusedLineId: lines[0]?.lineId ?? null,
    })
  },

  reset() { set({ ...EMPTY }) },
}))

/** Atomic selectors: a row subscribes to ITSELF, not to the cart. */
export const selectLine = (lineId: string) => (s: CartState) => s.byId[lineId]
export const selectIds = (s: CartState) => s.ids
export const selectCount = (s: CartState) => s.ids.length
