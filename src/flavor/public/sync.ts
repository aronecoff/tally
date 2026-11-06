import { db } from '../../db/db'
import { resumeAutoBackup, stopAutoBackup } from '../../lib/autoBackup'
import { resumeBudgetAlerts, stopBudgetAlerts } from '../../lib/budgetAlerts'
import { resumeWidgetSnapshot, stopWidgetSnapshot } from '../../lib/widgetSnapshot'
import { localDb } from './localDb'
import { loadMerchantRules } from './merchantRules'
import { native } from './native'

/**
 * The public build has nothing to sync, so this holds the app's local lifecycle:
 * the same exports the shared code reads, and the one start point App calls.
 */
export interface SyncSnapshot {
  email: string | null
  status: 'signedout' | 'idle' | 'syncing' | 'synced' | 'error'
  lastSyncedAt: number | null
  error: string | null
}

export type SyncResult = 'ok' | 'failed' | 'skipped'

const snapshot: SyncSnapshot = { email: null, status: 'signedout', lastSyncedAt: null, error: null }

/** One snapshot, once: App's status dot stays off because `supabase` is null. */
export function subscribeSync(l: (s: SyncSnapshot) => void): () => void {
  l(snapshot)
  return () => {}
}

let generation = 0

/** A bank run keeps what it fetched only while this has not moved. */
export const currentLedgerGeneration = (): number => generation

/** The bank link went while a fetch may be running: what it brings back is not written. */
export function bumpLedgerGeneration(): void {
  generation++
}

export const syncNow = async (): Promise<SyncResult> => 'skipped'

export const hasCloudSession = (): boolean => false

/**
 * Remove everything this app keeps on this device, then start again from first
 * run. The app goes first, because it holds what the page cannot reach: the bank
 * link in the Keychain, the backups, the widget's figures and the page's own
 * storage. If it fails nothing here has gone, so the user can try again, and backups
 * carry on. The page then clears its own stores too, which is all there is in a
 * browser. Each database reopens on the next read, so a live query that wakes before
 * the reload finds an empty table and not a closed one.
 */
export async function eraseAllData(): Promise<void> {
  // First: a bank run in flight answers for data that is going, and writes nothing,
  // and no backup, widget figure or alert goes out to sit beside the ones being removed.
  bumpLedgerGeneration()
  stopAutoBackup()
  stopWidgetSnapshot()
  stopBudgetAlerts()
  try {
    await native('erase.all').catch((e: unknown) => {
      if (!(e instanceof Error) || e.message !== 'no_bridge') throw e
    })
    await Promise.all([db.delete({ disableAutoOpen: false }), localDb.delete({ disableAutoOpen: false })])
  } catch (e) {
    resumeAutoBackup()
    resumeWidgetSnapshot()
    resumeBudgetAlerts()
    throw e
  }
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* storage blocked: there was nothing in it */
  }
  history.replaceState(null, '', '#home')
  location.reload()
}

let started = false

export function initSync(): void {
  if (started) return // StrictMode mounts twice
  started = true
  void loadMerchantRules()
}
