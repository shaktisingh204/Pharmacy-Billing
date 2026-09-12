import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CloudOff, Database, Download, HardDriveDownload, Lock, ShieldAlert, TriangleAlert, Upload,
} from 'lucide-react'
import { formatQty } from '@/lib/format'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Badge'
import { SkeletonRows } from '@/components/states'
import {
  BackupError, backupFilename, eraseEverything, exportBackup, localStorageKeys, readBackup,
  readLastBackup, restoreBackup, restoreImpact, summarise, tableCounts, tableNames, totalRows,
  writeLastBackup,
} from '@/db/backup'
import type { BackupFile, TableCount } from '@/db/backup'
import { notifyDeviceFactsChanged } from './deviceFacts'
import { daysSince } from './readiness'
import { PanelHeader, PanelShell, Section, inputClass } from './SettingsForm'

/**
 * Where the shop actually lives, and how to get a copy of it out.
 *
 * Everything this app knows is in IndexedDB in one browser profile on one
 * machine behind the counter. That is what makes it fast and what makes it work
 * with the line down, and it has exactly one failure mode: the profile. A
 * cleared site-data, a re-imaged Windows box, a replacement till — each of them
 * takes the shop's entire history, and none of them looks like a disaster while
 * it is happening.
 *
 * So this panel does three things, in the order they matter:
 *
 *  1. SAYS HOW EXPOSED THE SHOP IS RIGHT NOW. One number: days since the last
 *     copy left this machine. Not a setting — a fact, at display size.
 *  2. MAKES THE COPY, as plain JSON a person can put on a pen drive, mail to
 *     their accountant, and open in a text editor to satisfy themselves that
 *     their bills really are in it.
 *  3. PUTS IT BACK, showing what will be replaced before anything is.
 *
 * And then it says what is stored, because "it's all local" is a claim, and a
 * claim about somebody's customers' phone numbers should be itemised.
 */

const CONFIRM_RESTORE = 'RESTORE'
const CONFIRM_ERASE = 'ERASE'

export function DataSettings() {
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<BackupFile | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState('')
  const [confirmErase, setConfirmErase] = useState('')
  const [lastBackup, setLastBackup] = useState<string | null>(() => readLastBackup())
  const fileInput = useRef<HTMLInputElement>(null)

  const counts = useQuery({ queryKey: ['dataCounts'], queryFn: () => tableCounts() })

  const age = daysSince(lastBackup, new Date())
  const rows = counts.data?.reduce((n, c) => n + c.rows, 0) ?? 0

  async function onExport() {
    setBusy(true)
    try {
      const at = new Date()
      const file = await exportBackup(at)
      download(JSON.stringify(file, null, 2), backupFilename(file.takenFrom?.storeName ?? 'shop', at))
      writeLastBackup(at)
      setLastBackup(at.toISOString())
      // The header counts this; it has no other way to hear about it.
      notifyDeviceFactsChanged()
      toast.success('Backup saved', {
        description: `${formatQty(totalRows(file))} rows across ${summarise(file).length} tables. Keep it somewhere that is not this machine.`,
      })
    } catch (e) {
      toast.error('The backup was not written', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function onPick(file: File) {
    setRefusal(null)
    setPending(null)
    setConfirmRestore('')
    const reader = new FileReader()
    reader.onerror = () => setRefusal('That file could not be read off the disk.')
    reader.onload = () => {
      try {
        const parsed = readBackup(String(reader.result ?? ''), tableNames())
        setPending(parsed)
        setPendingName(file.name)
      } catch (e) {
        setRefusal(e instanceof BackupError ? e.message : (e as Error).message)
      }
    }
    reader.readAsText(file)
  }

  async function onRestore() {
    if (!pending) return
    setBusy(true)
    try {
      const written = await restoreBackup(pending)
      toast.success(`${formatQty(written)} rows restored`, {
        description: 'Reloading, because every cached figure on screen belongs to the shop that was here a moment ago.',
      })
      /* A reload rather than a cache invalidation. The search index, the active
         branch and every warm query were built from a database that no longer
         exists, and half of them would keep answering from the old shop. */
      window.setTimeout(() => window.location.reload(), 900)
    } catch (e) {
      setBusy(false)
      toast.error('Nothing was restored', { description: (e as Error).message })
    }
  }

  async function onErase() {
    setBusy(true)
    try {
      await eraseEverything()
      toast.success('Everything on this machine has been cleared', {
        description: 'Reloading. The demo data seeds itself again on the next boot.',
      })
      window.setTimeout(() => window.location.reload(), 900)
    } catch (e) {
      setBusy(false)
      toast.error('Not everything could be cleared', { description: (e as Error).message })
    }
  }

  return (
    <PanelShell>
      <PanelHeader
        title="Data & backup"
        intro="This shop's whole history sits in one browser profile on this machine. This is where a copy of it gets out, and where it comes back."
      />

      {/* ---------------------------------------------------------- exposure */}
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-8 p-[var(--card-px)]">
          <div className="min-w-[190px]">
            <span className="micro-label block">Since the last backup</span>
            {/* A word, not a dash. An em dash set at display size reads as a rule
                across the card rather than as "none", and this is the one figure
                on the page somebody has to be able to take in at a glance. */}
            {age === null ? (
              <span className="mt-1 block text-4xl font-semibold tracking-display text-danger-11">
                Never
              </span>
            ) : (
              <span
                className={cn('display-num mt-1 block text-5xl', age > 7 ? 'text-danger-11' : 'text-fg')}
              >
                {age}
              </span>
            )}
            <span className="mt-1 block text-sm text-fg-muted">
              {age === null
                ? 'no copy has left this machine'
                : age === 1 ? 'day' : 'days'}
            </span>
          </div>

          <div className="min-w-[160px]">
            <span className="micro-label block">Rows on this machine</span>
            <span className="display-num mt-1 block text-3xl text-fg">
              {counts.isPending ? '…' : formatQty(rows)}
            </span>
            <span className="mt-1 block text-sm text-fg-muted">
              across {counts.data?.length ?? 0} tables
            </span>
          </div>

          <p className="min-w-[240px] max-w-[46ch] flex-1 text-base text-fg-muted">
            {age === null || age > 7 ? (
              <>
                <TriangleAlert size={16} className="mr-1.5 inline align-[-3px] text-danger-11" aria-hidden />
                Every bill, batch and customer here exists in exactly one place. Clearing this
                browser's site data would take all of it.
              </>
            ) : (
              <>A copy left this machine {age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}. Take another after a busy day — a backup is only worth the bills it contains.</>
            )}
          </p>

          <Button variant="primary" size="lg" disabled={busy} onClick={() => void onExport()}>
            <Download /> Back up now
          </Button>
        </div>
      </section>

      {/* ----------------------------------------------------------- restore */}
      <Section
        title="Restore from a backup"
        icon={HardDriveDownload}
        description="Replaces everything on this machine with the contents of the file. It is not a merge — the ids in a backup are the ids its own documents reference, and a renumbered invoice is a different invoice."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>
            <Upload /> Choose a backup file
          </Button>
          {pending ? (
            <span className="mono text-sm text-fg-muted">{pendingName}</span>
          ) : (
            <span className="text-sm text-fg-subtle">A .json file this app wrote.</span>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onPick(file)
              // Re-picking the same file after a refusal must fire again.
              e.target.value = ''
            }}
          />
        </div>

        {refusal ? (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-danger-9/30 bg-danger-3 px-3 py-2.5 text-sm text-danger-11"
          >
            <ShieldAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span className="max-w-[76ch]">{refusal}</span>
          </p>
        ) : null}

        {pending ? (
          <RestorePlan
            file={pending}
            current={counts.data ?? []}
            confirm={confirmRestore}
            onConfirm={setConfirmRestore}
            busy={busy}
            onRestore={() => void onRestore()}
            onCancel={() => { setPending(null); setConfirmRestore('') }}
          />
        ) : null}
      </Section>

      {/* ----------------------------------------------------------- privacy */}
      <Section
        title="What is stored, and where"
        icon={Lock}
        description="Nothing here is sent anywhere. There is no account, no server and no analytics in this build — which is worth itemising rather than asserting."
      >
        <p className="flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-border-subtle bg-subtle px-3 py-2.5 text-sm text-fg-muted">
          <CloudOff size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="max-w-[76ch]">
            Customer names, phone numbers and what each of them was dispensed are the most
            sensitive rows in this list. They stay in this browser profile on this counter machine.
            Anyone who can unlock this machine can read them, so the machine's own lock screen is
            part of the shop's patient privacy.
          </span>
        </p>

        {counts.isPending ? (
          <SkeletonRows rows={6} cols={2} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <caption className="sr-only">Rows stored in each table</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-4 text-left micro-label">Table</th>
                  <th scope="col" className="py-2 pr-4 text-right micro-label">Rows</th>
                  <th scope="col" className="py-2 text-left micro-label">What it holds</th>
                </tr>
              </thead>
              <tbody>
                {(counts.data ?? []).map((c) => (
                  <tr key={c.table} className="border-b border-border-subtle last:border-0">
                    <td className="mono py-2 pr-4 text-fg">{c.table}</td>
                    <td className="num py-2 pr-4 text-fg">{formatQty(c.rows)}</td>
                    <td className="py-2 text-fg-muted">{TABLE_MEANING[c.table] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <span className="micro-label">Also on this device, outside the backup</span>
          <p className="mt-1 max-w-[76ch] text-sm text-fg-muted">
            Preferences that belong to the MACHINE rather than to the shop: the printer port and
            roll width, the density, the saved report views, which branch this till bills for.
            They are deliberately left out of a backup — restoring one counter's printer settings
            onto another is how a working till stops printing.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {localStorageKeys().map((k) => (
              <li key={k}><Chip>{k}</Chip></li>
            ))}
            {localStorageKeys().length === 0 ? (
              <li className="text-sm text-fg-subtle">Nothing stored yet.</li>
            ) : null}
          </ul>
        </div>
      </Section>

      {/* ------------------------------------------------------------- erase */}
      <Section
        title="Clear everything on this machine"
        icon={Database}
        description="For handing the machine on, returning a rented till, or starting a demo over. It cannot be undone from inside the app — only from a backup file."
      >
        <div className="rounded-[var(--radius-lg)] border border-danger-9/30 bg-danger-3/50 p-4">
          <p className="max-w-[76ch] text-sm text-danger-11">
            This deletes every bill, batch, customer and purchase in this browser profile, and the
            per-device preferences with them. Take a backup first — the button above writes one in
            a couple of seconds.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="micro-label">
                Type {CONFIRM_ERASE} to confirm
              </span>
              <input
                aria-label={`Type ${CONFIRM_ERASE} to confirm`}
                value={confirmErase}
                onChange={(e) => setConfirmErase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={cn('mono w-[200px] uppercase', inputClass())}
              />
            </label>
            <Button
              variant="danger"
              disabled={busy || confirmErase.trim().toUpperCase() !== CONFIRM_ERASE}
              onClick={() => void onErase()}
            >
              <TriangleAlert /> Clear this machine
            </Button>
          </div>
        </div>
      </Section>
    </PanelShell>
  )
}

// --------------------------------------------------------------- restore ---

function RestorePlan({
  file, current, confirm, onConfirm, busy, onRestore, onCancel,
}: {
  file: BackupFile
  current: readonly TableCount[]
  confirm: string
  onConfirm: (v: string) => void
  busy: boolean
  onRestore: () => void
  onCancel: () => void
}) {
  const impact = restoreImpact(file, current)
  const losing = impact.filter((r) => r.was > r.rows)
  const takenAt = file.createdAt === '' ? null : new Date(file.createdAt)

  return (
    <div className="rounded-[var(--radius-lg)] border border-warning-9/30 bg-warning-3/40 p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-base font-semibold text-fg">
          {file.takenFrom?.storeName ?? 'An unnamed shop'}
        </span>
        <span className="text-sm text-fg-muted">
          {takenAt && !Number.isNaN(takenAt.getTime())
            ? `taken ${takenAt.toLocaleString('en-IN')}`
            : 'no timestamp in the file'}
        </span>
        <span className="num text-sm text-fg-muted">{formatQty(totalRows(file))} rows</span>
      </div>

      {losing.length > 0 ? (
        <p className="mt-3 flex items-start gap-2.5 text-sm text-warning-11">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span className="max-w-[76ch]">
            {/* Named, not counted. "You will lose 3 tables" is not something a
                pharmacist can weigh; "40 invoices" is. */}
            This machine currently holds more in{' '}
            {losing.map((r) => `${formatQty(r.was)} ${r.table}`).join(', ')}
            {' '}than the file does. Restoring replaces them.
          </span>
        </p>
      ) : null}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[380px] border-collapse text-sm">
          <caption className="sr-only">What each table holds now and after the restore</caption>
          <thead>
            <tr className="border-b border-warning-9/25">
              <th scope="col" className="py-1.5 pr-4 text-left micro-label">Table</th>
              <th scope="col" className="py-1.5 pr-4 text-right micro-label">Now</th>
              <th scope="col" className="py-1.5 text-right micro-label">After</th>
            </tr>
          </thead>
          <tbody>
            {impact.map((r) => (
              <tr key={r.table} className="border-b border-warning-9/15 last:border-0">
                <td className="mono py-1.5 pr-4 text-fg">{r.table}</td>
                <td className="num py-1.5 pr-4 text-fg-muted">{formatQty(r.was)}</td>
                <td className={cn('num py-1.5', r.rows < r.was ? 'font-medium text-danger-11' : 'text-fg')}>
                  {formatQty(r.rows)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-warning-9/25 pt-3">
        <label className="flex flex-col gap-1.5">
          <span className="micro-label">Type {CONFIRM_RESTORE} to confirm</span>
          <input
            aria-label={`Type ${CONFIRM_RESTORE} to confirm`}
            value={confirm}
            onChange={(e) => onConfirm(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={cn('mono w-[200px] uppercase', inputClass())}
          />
        </label>
        <Button
          variant="danger"
          disabled={busy || confirm.trim().toUpperCase() !== CONFIRM_RESTORE}
          onClick={onRestore}
        >
          <HardDriveDownload /> Replace everything
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ bits ---

/**
 * A download from a Blob, revoked immediately after.
 *
 * An un-revoked object URL holds the whole backup — which on a real shop is
 * megabytes of invoice JSON — alive in memory until the tab is closed, and this
 * button is pressed daily on a machine that is never restarted.
 */
function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Said in the shop's words, not the schema's. */
const TABLE_MEANING: Record<string, string> = {
  stores: 'Each branch and its statutory numbers',
  medicines: 'The item master — shared across the chain',
  barcodes: 'Pack codes that scan to an item',
  batches: 'Stock on the shelf, by batch and expiry',
  customers: 'Names, phone numbers and khata balances',
  doctors: 'Prescribers written against',
  invoices: 'Every bill, including cancelled ones',
  ledger: 'Every stock movement, append-only',
  docSeries: 'The next number in each document series',
  heldBills: 'Parked bills waiting at the counter',
  shortbook: 'What a customer asked for and was not in stock',
  taxRates: 'GST rates by HSN, with their effective dates',
  idempotency: 'Replay guards for posted sales',
  suppliers: 'Distributors and what is owed to them',
  purchases: 'Goods received, and the bills behind them',
  purchaseIdempotency: 'Replay guards for goods receipts',
  meta: 'Branding, users, returns, transfers and orders',
}
