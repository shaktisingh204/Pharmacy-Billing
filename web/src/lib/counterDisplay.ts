/**
 * The counter's second screen.
 *
 * A customer-facing display is what an Indian pharmacy queue trusts: the person
 * paying watches each strip land, sees the MRP that is printed on the pack, and
 * reads the total before the operator says it. Half the disputes at a counter
 * are about a figure nobody could see being typed.
 *
 * It is a BroadcastChannel, not shared state or a store subscription, because
 * the display runs in its OWN window — dragged onto the customer-facing monitor
 * and left there. Same origin, no server, no polling.
 *
 * The snapshot is deliberately a flat, already-formatted-safe value object:
 * money crosses as decimal STRINGS exactly as it does everywhere else, and the
 * display never computes. It renders what the till told it.
 */

export const DISPLAY_CHANNEL = 'rxbill.display'

/** Snapshot shape version. A stale display window must not misread a new till. */
export const DISPLAY_VERSION = 2

export interface DisplayLine {
  lineId: string
  brandName: string
  packLabel: string
  qty: string
  freeQty: string
  ratePerUnit: string
  amount: string
  /** The dispensing instruction, so the customer can confirm it at the counter. */
  note?: string
}

export type DisplayStage = 'IDLE' | 'CART' | 'PAYMENT' | 'PAID'

export interface DisplaySnapshot {
  v: number
  at: number
  stage: DisplayStage
  storeName: string
  tagline: string | null
  upiVpa: string | null
  customerName: string | null
  lines: DisplayLine[]
  itemCount: number
  grossAmount: string
  /** Item discount + bill discount. The one number that earns customer loyalty. */
  savedAmount: string
  netAmount: string
  billNote: string
  /** Present only at stage PAID. */
  invoiceNo?: string
  amountPaid?: string
  changeDue?: string
}

type Envelope =
  | { kind: 'state'; snapshot: DisplaySnapshot }
  /** A display that has just opened asks the till to repeat itself. */
  | { kind: 'hello' }

/**
 * BroadcastChannel is absent in jsdom and in a hardened kiosk browser. Neither
 * is a reason for the till to throw mid-bill, so every entry point degrades to
 * "there is no second screen" rather than failing.
 */
function open(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    return new BroadcastChannel(DISPLAY_CHANNEL)
  } catch {
    return null
  }
}

export interface DisplayPublisher {
  publish(snapshot: DisplaySnapshot): void
  close(): void
}

/**
 * The till side. Publishes on every change and answers `hello` with whatever it
 * last sent, so opening the display window mid-bill shows the bill in progress
 * instead of an empty screen until the next keystroke.
 */
export function createPublisher(): DisplayPublisher {
  const channel = open()
  let last: DisplaySnapshot | null = null

  if (channel) {
    channel.onmessage = (e: MessageEvent<Envelope>) => {
      if (e.data?.kind === 'hello' && last) channel.postMessage({ kind: 'state', snapshot: last })
    }
  }

  return {
    publish(snapshot) {
      last = snapshot
      channel?.postMessage({ kind: 'state', snapshot })
    },
    close() {
      if (!channel) return
      channel.onmessage = null
      channel.close()
    },
  }
}

/**
 * The display side. Returns an unsubscribe, and says hello on the way in.
 * A snapshot from an older till build is ignored rather than half-rendered.
 */
export function subscribe(onSnapshot: (s: DisplaySnapshot) => void): () => void {
  const channel = open()
  if (!channel) return () => {}

  channel.onmessage = (e: MessageEvent<Envelope>) => {
    const data = e.data
    if (data?.kind !== 'state') return
    if (data.snapshot.v !== DISPLAY_VERSION) return
    onSnapshot(data.snapshot)
  }
  channel.postMessage({ kind: 'hello' })

  return () => {
    channel.onmessage = null
    channel.close()
  }
}
