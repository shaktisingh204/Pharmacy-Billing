import { readLastBackup } from '@/db/backup'
import { printerConfigured } from '@/print/printJob'

/**
 * The two setup facts that belong to the MACHINE rather than to the shop.
 *
 * Whether a printer has been set up here, and when a backup last left here, are
 * both kept in localStorage — which nothing re-renders on. Without this the
 * header counts them once on mount and then goes quietly stale: a pharmacist
 * takes a backup, watches the file download, and the page still tells them they
 * have never taken one.
 *
 * A snapshot string rather than an object, because `useSyncExternalStore`
 * compares by identity and a fresh object every call is an infinite render loop.
 */

const listeners = new Set<() => void>()

export function subscribeDeviceFacts(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Call after writing either fact. */
export function notifyDeviceFactsChanged(): void {
  for (const listener of listeners) listener()
}

export function deviceFactsSnapshot(): string {
  return `${printerConfigured() ? '1' : '0'}|${readLastBackup() ?? ''}`
}

export interface DeviceFacts {
  printerConfigured: boolean
  lastBackupAt: string | null
}

export function parseDeviceFacts(snapshot: string): DeviceFacts {
  const cut = snapshot.indexOf('|')
  const backup = cut === -1 ? '' : snapshot.slice(cut + 1)
  return {
    printerConfigured: snapshot.startsWith('1'),
    lastBackupAt: backup === '' ? null : backup,
  }
}
