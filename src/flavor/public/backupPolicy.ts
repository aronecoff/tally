import { db } from '../../db/db'
import type { BackupFile } from '../../lib/backup'
import { resumeAutoBackup, writeBackupNow } from '../../lib/autoBackup'
import type { RestoreMode } from '../../lib/backupPolicy'
import { todayISO } from '../../lib/dates'
import { PLAN_KEY, getPlan, setPlan } from '../../lib/planCache'
import { planOn, readPlan, type SavingsPlan } from '../../lib/savingsPlan'
import { forgetBankCoverage } from './bankTransport'
import { localDb, type LocalRule } from './localDb'
import { reloadMerchantRules } from './merchantRules'
import { markOnboarded } from './onboarded'
import { bumpLedgerGeneration } from './sync'

/**
 * How this app treats a backup. The phone holds the only copy of the ledger, and
 * WebKit does not promise to keep it, so a backup is the ledger: a restore puts
 * back exactly what it holds. See build-spec 8.3.
 */
export const restoreMode: RestoreMode = 'replace'

export const backupFormat = 'plainsum-backup'

/** Preferences that travel with a backup. Nothing about a bank or this device. */
const PREF_KEYS = ['tally-theme', 'tally-home-detail', 'plainsum:rentDating']

function readPrefs(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const key of PREF_KEYS) {
      const value = localStorage.getItem(key)
      if (value != null) out[key] = value
    }
  } catch {
    /* storage blocked: there is nothing to carry */
  }
  return out
}

function writePrefs(prefs: Record<string, string>): void {
  try {
    for (const key of PREF_KEYS) {
      if (typeof prefs[key] === 'string') localStorage.setItem(key, prefs[key])
    }
  } catch {
    /* storage blocked: the settings stay as they are */
  }
}

/**
 * The savings plan travels too, as its stored text: the phone holds the only
 * copy, and WebKit does not promise to keep page storage. It is not on the list
 * above, so nothing writes it back blind (restorePlan decides).
 */
export async function backupExtras(): Promise<Pick<BackupFile, 'rules' | 'prefs'>> {
  const prefs = readPrefs()
  const plan = getPlan()
  if (plan) prefs[PLAN_KEY] = JSON.stringify(plan)
  return { rules: await localDb.rules.toArray(), prefs }
}

/**
 * Bring a backup's savings plan in, without ever loosening the one here. Each
 * part is judged on this device's plan as it stands today:
 *  - locked today: it stays exactly as it is, pending change included;
 *  - no plan here: the file's comes in, if it is one;
 *  - an unlocked plan here: the file's comes in only if it is the newer.
 * So a restore can bring a lock back (a phone whose storage was lost), never
 * take one off or loosen one, and never undo an unlock that has landed.
 */
function restorePlan(prefs: Record<string, string>): void {
  const here = planOn(getPlan(), todayISO())
  if (here?.locked) return
  let theirs: SavingsPlan | null = null
  try {
    if (typeof prefs[PLAN_KEY] === 'string') theirs = readPlan(JSON.parse(prefs[PLAN_KEY]))
  } catch {
    /* not JSON: the file brings no plan */
  }
  if (theirs && (!here || theirs.updatedAt > here.updatedAt)) setPlan(theirs)
}

const isRule = (r: unknown): r is LocalRule => {
  const x = r as Partial<LocalRule> | null
  return !!x && typeof x.pattern === 'string' && typeof x.category === 'string' && typeof x.priority === 'number'
}

/**
 * Put back exactly what a backup holds, in one write, so a failure leaves the
 * ledger as it was. Rows keep their ids, because transactions point at categories
 * by id, and tombstones stay, so a hidden bank row stays hidden. What is here now
 * is saved first, so a restore can itself be undone. The caller reloads the page.
 * If it fails, what is here stays, and so do its backups.
 */
export async function replaceLedger(file: BackupFile): Promise<void> {
  try {
    await writeBackupNow()
    // A bank run in flight answers for rows that are going, and writes nothing.
    bumpLedgerGeneration()
    await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
      await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
      await db.categories.bulkPut(file.categories)
      await db.transactions.bulkPut(file.transactions)
      await db.accounts.bulkPut(file.accounts)
    })
    await localDb.transaction('rw', localDb.rules, async () => {
      await localDb.rules.clear()
      await localDb.rules.bulkPut(file.rules.filter(isRule))
    })
    await reloadMerchantRules()
  } catch (e) {
    resumeAutoBackup()
    throw e
  }
  writePrefs(file.prefs)
  restorePlan(file.prefs)
  // The days since the backup are not in the ledger any more, so a linked bank's
  // next pull reads them again. Rows it has already are matched by their ids.
  forgetBankCoverage()
  markOnboarded()
}
