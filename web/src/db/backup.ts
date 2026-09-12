import { db } from './schema'

/**
 * The whole shop, in one file.
 *
 * This app keeps everything in IndexedDB on the counter machine. That is fast,
 * it works with the internet down, and it has exactly one failure mode: the
 * browser profile. A cleared site-data, a re-imaged Windows box, a new machine
 * for the new till — all of them take the shop's entire history with them, and
 * none of them looks like a disaster while it is happening. So a backup is not a
 * nice-to-have here, it is the only copy.
 *
 * The file is plain JSON on purpose. A pharmacist should be able to put it on a
 * pen drive, mail it to their accountant, and open it in any text editor to see
 * that it really does contain their bills. A compressed or encrypted blob would
 * be smaller and would also be unverifiable by the person whose data it is.
 *
 * WHAT IS AND IS NOT IN IT is stated on the panel rather than left to be
 * discovered: every IndexedDB table is, and the per-device preferences kept in
 * localStorage (printer port, roll width, density, saved report views) are not.
 * Those belong to the machine, not to the shop, and restoring one counter's
 * printer settings onto another is how a working till stops printing.
 */

export const BACKUP_FORMAT = 'rxbill.backup'
/** Bumped only when the FILE shape changes — not when a table is added. */
export const BACKUP_VERSION = 1

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  /** Which branch was active when it was taken. Shown before a restore. */
  takenFrom: { storeId: number; storeName: string } | null
  /** Dexie's schema version, so a restore into an older build can be refused. */
  schemaVersion: number
  tables: Record<string, unknown[]>
}

export interface TableCount {
  table: string
  rows: number
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

// ------------------------------------------------------------------ pure ---

/** Row counts per table, largest first — what the panel shows before an export. */
export function summarise(file: BackupFile): TableCount[] {
  return Object.entries(file.tables)
    .map(([table, rows]) => ({ table, rows: rows.length }))
    .sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table))
}

export function totalRows(file: BackupFile): number {
  return Object.values(file.tables).reduce((n, rows) => n + rows.length, 0)
}

/**
 * `rxbill-backup-sanjeevani-medical-store-2026-09-09-1432.json`.
 *
 * The shop name and the timestamp are both in the filename because a folder of
 * backups is the normal case, and `backup.json` twice is how the good one gets
 * overwritten by the empty one.
 */
export function backupFilename(storeName: string, at: Date): string {
  const slug = storeName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  return `rxbill-backup-${slug === '' ? 'shop' : slug}-${stamp}.json`
}

/**
 * Read a file the user picked, and refuse it in words if it is not one of ours.
 *
 * Every refusal here names what was wrong with the FILE rather than reporting a
 * parse failure, because the person restoring is the person whose data has just
 * been lost and "Unexpected token < in JSON" is not something they can act on.
 *
 * `knownTables` is passed in rather than read off the database so this stays a
 * pure function: it is the one part of restore that can be wrong in a way tests
 * can catch.
 */
export function readBackup(text: string, knownTables: readonly string[]): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError(
      'That file is not readable as JSON. Pick the .json file the backup button produced, not a spreadsheet or a zip.',
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BackupError('That file does not contain a backup.')
  }
  const file = raw as Partial<BackupFile>

  if (file.format !== BACKUP_FORMAT) {
    throw new BackupError(
      'That is not an RxBill backup. An RxBill backup names itself in its first line; this file does not.',
    )
  }
  if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1) {
    throw new BackupError('That backup does not say which version it is, so it cannot be trusted.')
  }
  if (file.version > BACKUP_VERSION) {
    throw new BackupError(
      `That backup was written by a newer version of RxBill (file version ${file.version}, this build reads ${BACKUP_VERSION}). Restoring it here could drop data this build cannot see. Update RxBill first.`,
    )
  }
  if (file.tables === null || typeof file.tables !== 'object' || Array.isArray(file.tables)) {
    throw new BackupError('That backup has no tables in it.')
  }

  const known = new Set(knownTables)
  const tables: Record<string, unknown[]> = {}
  for (const [name, rows] of Object.entries(file.tables)) {
    if (!Array.isArray(rows)) {
      throw new BackupError(`The "${name}" table in that backup is not a list of rows.`)
    }
    if (!known.has(name)) {
      /* Refused rather than skipped. A backup carrying a table this build does
         not have came from a newer schema, and restoring the rest of it would
         produce a shop whose bills reference rows that were silently dropped. */
      throw new BackupError(
        `That backup contains a "${name}" table this version of RxBill does not have. It was taken from a newer build; update RxBill before restoring it.`,
      )
    }
    tables[name] = rows
  }

  if (Object.keys(tables).length === 0) {
    throw new BackupError('That backup is empty — there is nothing in it to restore.')
  }

  return {
    format: BACKUP_FORMAT,
    version: file.version,
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
    takenFrom: isTakenFrom(file.takenFrom) ? file.takenFrom : null,
    schemaVersion: typeof file.schemaVersion === 'number' ? file.schemaVersion : 0,
    tables,
  }
}

function isTakenFrom(v: unknown): v is { storeId: number; storeName: string } {
  if (v === null || typeof v !== 'object') return false
  const t = v as { storeId?: unknown; storeName?: unknown }
  return typeof t.storeId === 'number' && typeof t.storeName === 'string'
}

/**
 * What a restore will do to what is here now, said before it is done.
 *
 * A restore is a REPLACEMENT, not a merge — see `restoreBackup` — so the honest
 * thing to show is both sides of the trade, per table, including the tables that
 * are about to lose rows.
 */
export function restoreImpact(
  file: BackupFile,
  current: readonly TableCount[],
): Array<TableCount & { was: number }> {
  const now = new Map(current.map((c) => [c.table, c.rows]))
  const names = new Set([...Object.keys(file.tables), ...now.keys()])
  return [...names]
    .map((table) => ({
      table,
      rows: file.tables[table]?.length ?? 0,
      was: now.get(table) ?? 0,
    }))
    .filter((row) => row.rows > 0 || row.was > 0)
    .sort((a, b) => Math.max(b.rows, b.was) - Math.max(a.rows, a.was) || a.table.localeCompare(b.table))
}

// ---------------------------------------------------------------- dexie ----

/** Every table this build knows about, in schema order. */
export function tableNames(): string[] {
  return db.tables.map((t) => t.name)
}

export async function tableCounts(): Promise<TableCount[]> {
  const rows = await Promise.all(
    db.tables.map(async (t) => ({ table: t.name, rows: await t.count() })),
  )
  return rows.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table))
}

export async function exportBackup(now: Date): Promise<BackupFile> {
  const active = await db.stores.toCollection().first()
  const tables: Record<string, unknown[]> = {}
  /* Sequential, not Promise.all: a counter machine reading a year of bills and
     ledger rows in parallel is how the tab goes unresponsive mid-backup, and a
     backup that looks like a hang is a backup nobody takes twice. */
  for (const table of db.tables) {
    tables[table.name] = await table.toArray()
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    takenFrom: active ? { storeId: active.id, storeName: active.name } : null,
    schemaVersion: db.verno,
    tables,
  }
}

/**
 * Replace everything with the file's contents, in ONE transaction.
 *
 * Replacement rather than merge, and deliberately: the ids in a backup are the
 * ids the documents inside it reference. Merging would have to renumber, and a
 * renumbered invoice is a different invoice — the number is the identifier a tax
 * officer, a customer and the GSTR-1 document series all use.
 *
 * One transaction so a restore that fails half way leaves the shop as it was
 * rather than as half of two shops.
 */
export async function restoreBackup(file: BackupFile): Promise<number> {
  const targets = db.tables.filter((t) => file.tables[t.name] !== undefined)
  let written = 0
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
    for (const table of targets) {
      const rows = file.tables[table.name] ?? []
      if (rows.length === 0) continue
      await table.bulkPut(rows as never[])
      written += rows.length
    }
  })
  return written
}

/**
 * Every trace of this shop on this machine.
 *
 * The IndexedDB tables AND the localStorage preferences, because "clear my data"
 * that leaves the active branch, the role policy and the saved report views
 * behind has not cleared the data — and the person asking is usually handing the
 * machine to somebody else.
 */
export async function eraseEverything(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
  for (const key of localStorageKeys()) {
    try {
      localStorage.removeItem(key)
    } catch {
      // A browser that blocks site data has nothing stored to remove.
    }
  }
}

/**
 * When this machine last took a backup.
 *
 * Per device rather than in the database, deliberately: the question it answers
 * is "does a copy of this shop exist off this machine", and a flag stored INSIDE
 * the thing being backed up would be restored along with it and start lying.
 */
export const LAST_BACKUP_KEY = 'rxbill.lastBackup'

export function readLastBackup(): string | null {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY)
  } catch {
    return null
  }
}

export function writeLastBackup(at: Date): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, at.toISOString())
  } catch {
    // A browser that blocks site data still made the file; only the reminder is lost.
  }
}

/** Every `rxbill.` key this app writes to localStorage, for the privacy list. */
export function localStorageKeys(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith('rxbill.'))
      .sort()
  } catch {
    return []
  }
}
