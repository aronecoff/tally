import { db } from '../../db/db'
import { listBackups, parseBackup, readBackup, type BackupFile } from '../../lib/backup'

const KEY = 'plainsum:onboarded'

function onboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* storage blocked: the ledger answers next time */
  }
}

/**
 * Whether this is a first run. A device with rows on it has been set up whatever
 * the flag says, so a lost flag never puts onboarding over someone's ledger.
 */
export async function needsFirstRun(): Promise<boolean> {
  if (onboarded()) return false
  if ((await db.transactions.count()) + (await db.accounts.count()) === 0) return true
  markOnboarded()
  return false
}

/**
 * The newest backup, on a device whose storage was lost: it has backups but no
 * categories. That can only be eviction, because a new install has no backups and
 * Erase removes them, so the onboarded flag says nothing here. A backup that will
 * not read is no offer.
 */
export async function restoreOffer(): Promise<BackupFile | null> {
  if ((await db.categories.count()) > 0) return null
  const [latest] = await listBackups()
  if (!latest) return null
  try {
    return parseBackup(await readBackup(latest.name))
  } catch {
    return null
  }
}
