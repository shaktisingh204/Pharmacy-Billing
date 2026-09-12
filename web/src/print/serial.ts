/**
 * Talking to a thermal printer over WebSerial.
 *
 * WebSerial and NOT WebUSB, which is the decision the plan calls out: on Windows
 * the vendor's printer driver claims the device exclusively, so WebUSB cannot
 * open it at all while the driver is installed — and it always is, because that
 * is how the printer was set up. A serial or USB-serial endpoint is shared.
 *
 * Everything here degrades. A browser without WebSerial, a user who declines the
 * port prompt, a printer that is off — none of those may cost anybody a bill.
 * `window.print()` remains the fallback and the caller is told which one ran.
 */

/* The Web Serial API is not in this project's DOM lib, and pulling in a
   `@types` package for four members is more surface than writing them. */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): { usbVendorId?: number; usbProductId?: number }
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>
  getPorts(): Promise<SerialPortLike[]>
}

const serial = (): SerialLike | null =>
  (navigator as unknown as { serial?: SerialLike }).serial ?? null

export const isSupported = (): boolean => serial() !== null

export class PrinterError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PrinterError'
  }
}

/**
 * The one live connection.
 *
 * Module-level rather than per-component: a port can only be open once, and a
 * second screen mounting its own connection would fail to open the port the
 * first one holds — which presents as "printing works on the billing screen and
 * not from Sales", the least debuggable kind of report.
 */
let port: SerialPortLike | null = null
let baud = 9600

export interface ConnectOptions {
  /** 9600 is the near-universal default; some printers ship at 19200 or 115200. */
  baudRate?: number
}

/**
 * Ask the user to pick a port.
 *
 * MUST be called from a user gesture — Chrome refuses the prompt otherwise, and
 * the refusal looks exactly like the user declining. So this is only ever wired
 * to a button, never to a mount.
 */
export async function connect(opts: ConnectOptions = {}): Promise<void> {
  const api = serial()
  if (!api) {
    throw new PrinterError(
      'SERIAL_UNSUPPORTED',
      'This browser cannot talk to a printer directly. Chrome or Edge on desktop can; Safari and Firefox cannot.',
    )
  }
  baud = opts.baudRate ?? 9600
  const chosen = await api.requestPort()
  await chosen.open({ baudRate: baud })
  port = chosen
}

/** Reconnect silently to a port already granted, so a reload does not re-prompt. */
export async function reconnect(opts: ConnectOptions = {}): Promise<boolean> {
  const api = serial()
  if (!api) return false
  const [granted] = await api.getPorts()
  if (!granted) return false
  try {
    baud = opts.baudRate ?? baud
    await granted.open({ baudRate: baud })
    port = granted
    return true
  } catch {
    /* Already open, or the printer has gone. Neither is worth an error on boot:
       the fallback still prints and the operator finds out when they try. */
    return false
  }
}

export async function disconnect(): Promise<void> {
  const held = port
  port = null
  if (held) await held.close().catch(() => undefined)
}

export const isConnected = (): boolean => port !== null

export function connectedInfo(): { vendorId?: number; productId?: number } | null {
  if (!port) return null
  const info = port.getInfo()
  return { vendorId: info.usbVendorId, productId: info.usbProductId }
}

/**
 * Write a job.
 *
 * The writer lock is released in a `finally`: a job that throws mid-write and
 * leaves the stream locked makes every subsequent print fail with a message
 * about the stream rather than about the printer, and only a reload clears it.
 */
export async function write(bytes: Uint8Array): Promise<void> {
  if (!port) throw new PrinterError('PRINTER_NOT_CONNECTED', 'No printer is connected')
  const stream = port.writable
  if (!stream) throw new PrinterError('PRINTER_NOT_WRITABLE', 'The printer port is not writable')
  const writer = stream.getWriter()
  try {
    await writer.write(bytes)
  } finally {
    writer.releaseLock()
  }
}

export type PrintRoute = 'serial' | 'browser'

/**
 * Print, however it can.
 *
 * Returns which route ran, because the operator has to know: a bill that went to
 * the browser dialog when they expected paper is a different problem from one
 * that did not print at all, and a silent fallback makes those indistinguishable.
 */
export async function printBytes(
  bytes: Uint8Array,
  fallback: () => void,
): Promise<PrintRoute> {
  if (!isConnected()) { fallback(); return 'browser' }
  try {
    await write(bytes)
    return 'serial'
  } catch {
    /* The printer was connected and the write failed — out of paper, switched
       off, cable pulled. The customer still gets a bill. */
    fallback()
    return 'browser'
  }
}
