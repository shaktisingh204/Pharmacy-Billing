import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT, BACKUP_VERSION, BackupError, backupFilename, readBackup, restoreImpact,
  summarise, totalRows,
} from './backup'
import type { BackupFile } from './backup'

/**
 * The pure half of backup and restore.
 *
 * Dexie's own reads and writes are Dexie's test to run (and `fake-indexeddb` is
 * not a dependency here). What is asserted is the part that can be wrong in a
 * way that costs somebody their shop: accepting a file that is not a backup,
 * accepting one from a newer build, or silently dropping a table.
 */

const KNOWN = ['stores', 'medicines', 'batches', 'invoices', 'meta']

function file(over: Partial<BackupFile> = {}): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: '2026-09-09T09:00:00.000Z',
    takenFrom: { storeId: 1, storeName: 'Sanjeevani Medical Store' },
    schemaVersion: 3,
    tables: { stores: [{ id: 1 }], medicines: [{ id: 1 }, { id: 2 }], invoices: [], meta: [] },
    ...over,
  }
}

const reason = (text: string): string => {
  try {
    readBackup(text, KNOWN)
  } catch (e) {
    return (e as BackupError).message
  }
  return 'DID_NOT_THROW'
}

describe('reading a backup file', () => {
  it('accepts one this build wrote', () => {
    const read = readBackup(JSON.stringify(file()), KNOWN)
    expect(read.format).toBe(BACKUP_FORMAT)
    expect(read.takenFrom).toEqual({ storeId: 1, storeName: 'Sanjeevani Medical Store' })
    expect(read.tables.medicines).toHaveLength(2)
  })

  it('refuses a file that is not JSON, in words a pharmacist can act on', () => {
    // Not "Unexpected token" — the person restoring has just lost their data.
    expect(reason('<html>')).toMatch(/not readable as JSON/)
    expect(reason('')).toMatch(/not readable as JSON/)
  })

  it('refuses JSON that is not a backup', () => {
    expect(reason('[1,2,3]')).toMatch(/does not contain a backup/)
    expect(reason('null')).toMatch(/does not contain a backup/)
    expect(reason(JSON.stringify({ hello: 'world' }))).toMatch(/not an RxBill backup/)
  })

  it('REFUSES a backup from a newer build rather than restoring part of it', () => {
    // Restoring it would drop whatever this build cannot see, silently.
    expect(reason(JSON.stringify(file({ version: BACKUP_VERSION + 1 }))))
      .toMatch(/newer version of RxBill/)
  })

  it('refuses a backup carrying a table this build does not have', () => {
    expect(reason(JSON.stringify(file({ tables: { stores: [], prescriptions: [] } }))))
      .toMatch(/"prescriptions" table this version of RxBill does not have/)
  })

  it('refuses a table that is not a list of rows', () => {
    expect(reason(JSON.stringify(file({ tables: { stores: { id: 1 } as never } }))))
      .toMatch(/"stores" table in that backup is not a list of rows/)
  })

  it('refuses an empty backup instead of wiping a shop with it', () => {
    expect(reason(JSON.stringify(file({ tables: {} })))).toMatch(/is empty/)
  })

  it('survives a file with no timestamp or origin rather than refusing it', () => {
    // Neither is load-bearing: they are shown, not applied.
    const read = readBackup(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, tables: { stores: [{ id: 1 }] } }),
      KNOWN,
    )
    expect(read.createdAt).toBe('')
    expect(read.takenFrom).toBeNull()
  })
})

describe('what a backup holds', () => {
  it('counts rows per table, largest first', () => {
    expect(summarise(file())).toEqual([
      { table: 'medicines', rows: 2 },
      { table: 'stores', rows: 1 },
      { table: 'invoices', rows: 0 },
      { table: 'meta', rows: 0 },
    ])
    expect(totalRows(file())).toBe(3)
  })
})

describe('what a restore would replace', () => {
  it('shows both sides per table, including what is about to be lost', () => {
    // A restore is a replacement, not a merge. A table with rows here and none
    // in the file is the one a person most needs to see before confirming.
    const impact = restoreImpact(file(), [
      { table: 'medicines', rows: 900 },
      { table: 'invoices', rows: 40 },
      { table: 'batches', rows: 12 },
    ])
    expect(impact).toEqual([
      { table: 'medicines', rows: 2, was: 900 },
      { table: 'invoices', rows: 0, was: 40 },
      { table: 'batches', rows: 0, was: 12 },
      { table: 'stores', rows: 1, was: 0 },
    ])
  })

  it('leaves out tables that are empty on both sides', () => {
    expect(restoreImpact(file({ tables: { stores: [] } }), []).map((r) => r.table)).toEqual([])
  })
})

describe('the filename', () => {
  it('carries the shop and the moment, because a folder of backups is normal', () => {
    expect(backupFilename('Sanjeevani Medical Store', new Date(2026, 8, 9, 14, 32)))
      .toBe('rxbill-backup-sanjeevani-medical-store-2026-09-09-1432.json')
  })

  it('never produces a nameless file', () => {
    expect(backupFilename('—', new Date(2026, 0, 1, 0, 5)))
      .toBe('rxbill-backup-shop-2026-01-01-0005.json')
  })

  it('does not let a long shop name run away with the filename', () => {
    const name = backupFilename('A'.repeat(90), new Date(2026, 0, 1, 0, 0))
    expect(name).toBe(`rxbill-backup-${'a'.repeat(40)}-2026-01-01-0000.json`)
  })
})
