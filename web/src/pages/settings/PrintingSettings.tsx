import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CircleCheck, Gauge, Inbox, IndianRupee, Plug, PlugZap, Printer, Ruler, TriangleAlert, Wallet,
} from 'lucide-react'
import { useApi } from '@/api'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { drawerBytes, testPageBytes } from '@/print/escpos'
import {
  PrinterError, connect, connectedInfo, disconnect, isConnected, isSupported, reconnect, write,
} from '@/print/serial'
import { notifyDeviceFactsChanged } from './deviceFacts'
import { PanelHeader, PanelShell, Section } from './SettingsForm'

/**
 * Printing.
 *
 * `window.print()` works and stays as the fallback, but it costs a driver
 * install, a print dialog and a page setup that every Windows update is at
 * liberty to reset. A counter prints two hundred bills a day; a dialog on each
 * one is the difference between a till that flows and one that does not.
 *
 * The panel is built around the two things that actually go wrong, because both
 * are invisible until a queue has formed: the column width being wrong for the
 * roll, and the rupee sign printing as rubbish. The test page shows both in one
 * glance, and it is the first control here rather than the last.
 */

const WIDTHS = [
  { cols: 32, label: '58 mm', hint: 'The small roll — 32 characters' },
  { cols: 42, label: '80 mm', hint: 'The usual counter roll — 42 characters' },
  { cols: 48, label: '80 mm wide', hint: 'Some printers fit 48 at font B' },
] as const

const BAUDS = [9600, 19200, 38400, 115200] as const

const STORAGE_KEY = 'rxbill.printer'

interface PrinterPrefs {
  columns: number
  baudRate: number
  transliterateRupee: boolean
}

const DEFAULTS: PrinterPrefs = { columns: 42, baudRate: 9600, transliterateRupee: true }

function readPrefs(): PrinterPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PrinterPrefs>) }
  } catch {
    // Per-viewer convenience, never a source of truth. A browser that blocks
    // site data gets the defaults and everything still prints.
    return DEFAULTS
  }
}

export function PrintingSettings() {
  const api = useApi()
  const [prefs, setPrefs] = useState<PrinterPrefs>(readPrefs)
  const [connected, setConnected] = useState(isConnected)
  const [busy, setBusy] = useState(false)

  const store = useQuery({ queryKey: ['store'], queryFn: () => api.getStore() })
  const supported = isSupported()

  /* Silently pick up a port the user has already granted, so a reload does not
     re-prompt. Never prompts — Chrome requires a gesture for that, and a prompt
     fired on mount is refused in a way that looks like the user declining. */
  useEffect(() => {
    void reconnect({ baudRate: prefs.baudRate }).then((ok) => { if (ok) setConnected(true) })
    // Deliberately once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Persisted HERE rather than in an effect on `prefs`.
     An effect wrote the defaults on mount, which meant merely opening this panel
     recorded a printer as configured — and the setup checklist on the header
     reads exactly that key to decide whether anybody has set one up. Writing on
     the change makes the stored value mean what it says. */
  function set<K extends keyof PrinterPrefs>(key: K, value: PrinterPrefs[K]): void {
    const next = { ...prefs, [key]: value }
    setPrefs(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Nothing to do and nothing to say: the setting still applies this session.
    }
    notifyDeviceFactsChanged()
  }

  const guard = async (label: string, run: () => Promise<void>) => {
    setBusy(true)
    try {
      await run()
    } catch (e) {
      toast.error(label, {
        description: e instanceof PrinterError
          ? e.message
          : e instanceof DOMException && e.name === 'NotFoundError'
            /* Chrome throws NotFoundError when the picker is dismissed. That is
               not a failure and must not read like one. */
            ? 'No printer was chosen.'
            : (e as Error).message,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelShell>
      <PanelHeader
        title="Printing"
        intro="Bills print through the browser unless a thermal printer is connected here. A connected printer skips the print dialog, cuts the paper and opens the drawer on a cash sale."
      />

      {!supported ? (
        <p className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-warning-9/25 bg-warning-3 px-3 py-2.5 text-sm text-warning-11">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="max-w-[76ch]">
            This browser cannot talk to a printer directly. Chrome or Edge on a desktop can;
            Safari and Firefox cannot. Bills will keep printing through the browser dialog, which
            works — it is just slower.
          </span>
        </p>
      ) : (
        <section className="card p-[var(--card-px)]">
          <div className="flex flex-wrap items-center gap-4">
            {connected ? (
              <CircleCheck size={18} className="shrink-0 text-success-11" aria-hidden />
            ) : (
              <Plug size={18} className="shrink-0 text-fg-subtle" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn('text-lg font-semibold tracking-tight', connected ? 'text-success-11' : 'text-fg')}>
                {connected ? 'Printer connected' : 'No printer connected'}
              </p>
              <p className="text-sm text-fg-muted">
                {connected
                  ? describePort()
                  : 'Bills go to the browser print dialog until one is chosen.'}
              </p>
            </div>
            {connected ? (
              <Button
                onClick={() => void guard('Could not disconnect', async () => {
                  await disconnect()
                  setConnected(false)
                })}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void guard('Could not connect', async () => {
                  await connect({ baudRate: prefs.baudRate })
                  setConnected(true)
                  toast.success('Printer connected', {
                    description: 'Print a test page to check the width and the rupee sign.',
                  })
                })}
              >
                <PlugZap /> Choose a printer
              </Button>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-4">
            {/* The test page FIRST. Both failures worth catching — a wrong roll
                width and a broken rupee sign — are invisible until a queue has
                formed, and both show in one glance here. */}
            <Button
              disabled={!connected || busy || !store.data}
              onClick={() => void guard('The test page did not print', async () => {
                if (!store.data) return
                await write(testPageBytes(store.data, {
                  columns: prefs.columns,
                  transliterateRupee: prefs.transliterateRupee,
                }))
              })}
            >
              <Printer /> Print a test page
            </Button>
            <Button
              disabled={!connected || busy}
              onClick={() => void guard('The drawer did not open', async () => {
                await write(drawerBytes())
              })}
            >
              <Wallet /> Open the drawer
            </Button>
          </div>
        </section>
      )}

      <Section
        title="Roll width"
        icon={Ruler}
        description="Wrong here and every long line wraps — which is invisible on a short bill and ruins every long one."
      >
        <div role="radiogroup" aria-label="Roll width" className="flex flex-wrap gap-2.5">
          {WIDTHS.map((w) => (
            <button
              key={w.cols}
              type="button"
              role="radio"
              aria-checked={prefs.columns === w.cols}
              onClick={() => set('columns', w.cols)}
              className={cn(
                'flex min-w-[180px] flex-col items-start rounded-[var(--radius-lg)] border px-3.5 py-2.5 text-left',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]',
                prefs.columns === w.cols
                  ? 'border-accent-9/45 bg-accent-1 shadow-xs'
                  : 'border-border bg-surface hover:border-border-strong',
              )}
            >
              <span className="text-base font-semibold text-fg">{w.label}</span>
              <span className="text-xs text-fg-muted">{w.hint}</span>
            </button>
          ))}
        </div>

        <Ruler42 cols={prefs.columns} transliterate={prefs.transliterateRupee} />
      </Section>

      <Section
        title="The rupee sign"
        icon={IndianRupee}
        description="The single most likely thing to look broken on a brand new printer."
      >
        <label className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-border-subtle bg-subtle px-3 py-2.5">
          <input
            type="checkbox"
            checked={prefs.transliterateRupee}
            onChange={(e) => set('transliterateRupee', e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-[var(--accent-9)]"
          />
          <span className="text-base text-fg">
            Print <span className="mono">Rs</span> instead of ₹
            <span className="mt-0.5 block max-w-[70ch] text-xs text-fg-muted">
              {/* The single most likely thing to look broken on a new printer,
                  and the reason is genuinely not the shop's fault. */}
              ₹ was adopted in 2010 and exists in none of the classic printer
              character sets, so most printers show a stray glyph on every money line. Leave this
              on unless the test page proves otherwise.
            </span>
          </span>
        </label>
      </Section>

      {supported ? (
        <Section
          title="Speed"
          icon={Gauge}
          description="Takes effect the next time the printer is connected."
        >
          <label className="flex flex-col gap-1.5">
            <span className="sr-only">Baud rate</span>
            <select
              aria-label="Baud rate"
              value={prefs.baudRate}
              onChange={(e) => set('baudRate', Number(e.target.value))}
              className="h-[var(--control-h)] w-[200px] rounded-[var(--radius-md)] border border-border bg-surface px-3 text-base hover:border-border-strong"
            >
              {BAUDS.map((b) => (
                <option key={b} value={b}>{b} baud{b === 9600 ? ' — usual' : ''}</option>
              ))}
            </select>
            <span className="max-w-[70ch] text-xs text-fg-muted">
              If the test page prints garbage characters rather than a stray symbol, this is what
              is wrong.
            </span>
          </label>
        </Section>
      ) : null}

      <p className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-border-subtle bg-subtle px-3 py-2.5 text-sm text-fg-muted">
        <Inbox size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span className="max-w-[76ch]">
          A connected printer that runs out of paper, is switched off, or has its cable pulled falls
          back to the browser dialog for that bill and says so. Nobody loses a receipt because the
          printer did.
        </span>
      </p>
    </PanelShell>
  )
}

/**
 * The chosen width, on screen, before a roll is spent proving it.
 *
 * The test page is the real check and it needs a printer. This is the half of it
 * that does not: a character ruler and one real money line at the selected
 * column count, so a 42-column setting on a 32-column roll is visible from the
 * settings screen rather than from a queue.
 */
function Ruler42({ cols, transliterate }: { cols: number; transliterate: boolean }) {
  const symbol = transliterate ? 'Rs' : '₹'
  const tens = Array.from({ length: cols }, (_, i) => (i + 1) % 10 === 0 ? '|' : '.').join('')
  const money = `${symbol}1,284.50`
  const item = 'AZITHROMYCIN 500MG TAB'
  const pad = Math.max(1, cols - item.length - money.length)
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-border bg-subtle p-3.5">
      <span className="micro-label">{cols} characters, at real width</span>
      <pre className="mono mt-2 overflow-x-auto text-2xs leading-[1.7] text-fg">
{tens}
{'\n'}{item.slice(0, Math.max(0, cols - money.length - 1))}{' '.repeat(pad)}{money}
{'\n'}{'-'.repeat(cols)}
      </pre>
    </div>
  )
}

function describePort(): string {
  const info = connectedInfo()
  if (!info || info.vendorId === undefined) return 'Connected over serial.'
  const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`
  return `USB ${hex(info.vendorId)}${info.productId !== undefined ? `:${hex(info.productId)}` : ''}`
}
