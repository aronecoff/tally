import { db, type Account, type Category, type Transaction } from '../db/db'
import { hasCloudSession, syncNow } from '../sync/sync'
import { backupExtras, backupFormat, replaceLedger, restoreMode, type RestoreMode } from './backupPolicy'
import { brand } from './brand'
import { todayISO } from './dates'
import { hasNative, native } from './native'
import { matchLedger, type Identified } from './rowMatch'
import { saveFile } from './share'

/** A backup file, row for row. See build-spec 8.3. */
export interface BackupFile {
  format: string
  v: number
  exportedAt: string
  app: string
  categories: Category[]
  transactions: Transaction[]
  accounts: Account[]
  rules: unknown[]
  prefs: Record<string, string>
}

const VERSION = 1

/** Why a backup cannot be restored, in words for the sheet. */
export class BackupError extends Error {}

export interface BackupEntry {
  name: string
  /** When it was written, in ms. */
  at: number
}

/** The app's own backups, newest first. A browser has none. */
export async function listBackups(): Promise<BackupEntry[]> {
  if (!hasNative()) return []
  try {
    return (await native<{ backups?: BackupEntry[] }>('backup.list')).backups ?? []
  } catch {
    return []
  }
}

export const readBackup = async (name: string) => (await native<{ json: string }>('backup.read', { name })).json

async function appVersion(): Promise<string> {
  try {
    const { version, build } = await native<{ version: string; build: string }>('app.info')
    return `${version} (${build})`
  } catch {
    return 'web'
  }
}

/** Everything on this device that a restore needs, rows verbatim. */
export async function buildBackup(): Promise<BackupFile> {
  const [categories, transactions, accounts] = await db.transaction('r', db.categories, db.transactions, db.accounts, () =>
    Promise.all([db.categories.toArray(), db.transactions.toArray(), db.accounts.toArray()]),
  )
  return {
    format: backupFormat,
    v: VERSION,
    exportedAt: new Date().toISOString(),
    app: await appVersion(),
    categories,
    transactions,
    accounts,
    ...(await backupExtras()),
  }
}

/** A backup to keep somewhere else: the share sheet in the iPhone app, a download anywhere else. */
export async function exportBackup(): Promise<boolean> {
  return saveFile({
    filename: `${brand.fileStem}-backup-${todayISO()}.json`,
    mime: 'application/json',
    text: JSON.stringify(await buildBackup()),
  })
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown) => Number.isInteger(v)
const isKind = (v: unknown) => v === 'expense' || v === 'income'
const ACCOUNT_TYPES = new Set(['cash', 'credit', 'brokerage', 'retirement', 'benefit'])

/**
 * The sync turns every stamp into a date, and one it cannot read throws for the whole
 * push. Nothing here writes such a stamp, so a file with one has been edited. No stamp
 * at all is another matter: JSON writes NaN as null, and parseBackup stamps those rows.
 */
const okStamp = (v: unknown) => v == null || (isNum(v) && !Number.isNaN(new Date(v).getTime()))

const okCategory = (c: Category) =>
  isId(c?.id) && typeof c.uid === 'string' && typeof c.name === 'string' && isKind(c.kind) && isNum(c.monthlyBudget) && okStamp(c.updatedAt)
const okTransaction = (t: Transaction) =>
  isId(t?.id) &&
  typeof t.uid === 'string' &&
  typeof t.date === 'string' &&
  ISO_DAY.test(t.date) &&
  isNum(t.amount) &&
  isKind(t.type) &&
  (t.categoryId === null || isId(t.categoryId)) &&
  typeof t.note === 'string' &&
  typeof t.account === 'string' &&
  okStamp(t.createdAt) &&
  okStamp(t.updatedAt)
const okAccount = (a: Account) =>
  isId(a?.id) && typeof a.uid === 'string' && typeof a.name === 'string' && ACCOUNT_TYPES.has(a.type) && isNum(a.balance) && okStamp(a.updatedAt) && okStamp(a.lastUpdated)

const uniqueIds = (rows: { id?: number }[]) => new Set(rows.map((r) => r.id)).size === rows.length

/**
 * A backup file's text, checked row by row. It is read as all or nothing: a restore
 * that took in half a damaged file would be worse than one that refused it.
 */
export function parseBackup(text: string): BackupFile {
  const bad = () => new BackupError('This file is not a backup from this app, or it is damaged.')
  let file: BackupFile
  try {
    file = JSON.parse(text) as BackupFile
  } catch {
    throw bad()
  }
  if (!file || file.format !== backupFormat) throw bad()
  if (!Number.isInteger(file.v) || file.v > VERSION) throw new BackupError('This backup came from a newer version of the app. Update it first.')
  const { categories, transactions, accounts } = file
  if (![categories, transactions, accounts].every(Array.isArray)) throw bad()
  if (!categories.every(okCategory) || !transactions.every(okTransaction) || !accounts.every(okAccount)) throw bad()
  if (![categories, transactions, accounts].every(uniqueIds)) throw bad()
  return {
    ...file,
    // A row with no stamp would stop the sync. 0 is what the app reads as not known, and
    // the oldest there is, so it never out-votes a row. An account's are not needed: the
    // sync reads a missing one as 0 by itself.
    categories: categories.map((c) => ({ ...c, updatedAt: c.updatedAt ?? 0 })),
    transactions: transactions.map((t) => ({ ...t, createdAt: t.createdAt ?? 0, updatedAt: t.updatedAt ?? 0 })),
    exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
    rules: Array.isArray(file.rules) ? file.rules : [],
    prefs: file.prefs && typeof file.prefs === 'object' ? file.prefs : {},
  }
}

const catKey = (c: Pick<Category, 'name' | 'kind'>) => `${c.name.trim().toLowerCase()}|${c.kind}`
const manualKey = (a: Account) => `${a.institution}|${a.name}|${a.type}`.toLowerCase()
const linkKey = (a: Account) => `${a.source}|${a.sourceAccountId}`

export interface Counts {
  transactions: number
  categories: number
  accounts: number
}

const liveCounts = (rows: { categories: Category[]; transactions: Transaction[]; accounts: Account[] }): Counts => ({
  transactions: rows.transactions.filter((t) => !t.deleted).length,
  categories: rows.categories.filter((c) => !c.deleted).length,
  accounts: rows.accounts.filter((a) => !a.deleted).length,
})

interface Merge {
  categories: Category[]
  accounts: Account[]
  transactions: Transaction[]
  /** Backup category id to the live one here, or to one of `categories` by uid. */
  homes: Map<number, number | string | null>
  here: number
  removed: number
  alike: number
}

/** What a backup would add to a ledger. Rows here are never in it, so they cannot change. */
function planMerge(file: BackupFile, ledger: { categories: Category[]; transactions: Transaction[]; accounts: Account[] }): Merge {
  const liveByKey = new Map(ledger.categories.filter((c) => !c.deleted).map((c) => [catKey(c), c.id!]))
  const byUid = new Map(ledger.categories.filter((c) => c.uid).map((c) => [c.uid!, c]))
  const homes: Merge['homes'] = new Map()
  const categories: Category[] = []
  for (const c of file.categories) {
    const known = byUid.get(c.uid!)
    const live = known && !known.deleted ? known.id! : liveByKey.get(catKey(c))
    if (live != null) homes.set(c.id!, live)
    else if (known || c.deleted) homes.set(c.id!, null) // removed here, or in the backup
    else {
      categories.push(c)
      homes.set(c.id!, c.uid!)
    }
  }

  const liveInBackup = file.transactions.filter((t) => !t.deleted)
  const { fresh, here, removed, twins } = matchLedger(liveInBackup as (Transaction & Identified)[], ledger.transactions, { sureOnly: true })
  const transactions = fresh.filter((t) => !twins.has(t))

  const accountUids = new Set(ledger.accounts.filter((a) => a.uid).map((a) => a.uid!))
  const links = new Set(ledger.accounts.filter((a) => a.sourceAccountId).map(linkKey))
  const manual = new Set(ledger.accounts.filter((a) => !a.deleted && !a.sourceAccountId).map(manualKey))
  const accounts = file.accounts.filter(
    (a) => !a.deleted && !accountUids.has(a.uid!) && !(a.sourceAccountId ? links.has(linkKey(a)) : manual.has(manualKey(a))),
  )
  return { categories, accounts, transactions, homes, here: here.length, removed: removed.length, alike: fresh.length - transactions.length }
}

async function readLedger() {
  const [categories, transactions, accounts] = await Promise.all([db.categories.toArray(), db.transactions.toArray(), db.accounts.toArray()])
  return { categories, transactions, accounts }
}

export interface RestorePlan {
  mode: RestoreMode
  /** What the backup holds, removed rows aside. */
  backup: Counts
  /** What this device holds now. */
  current: Counts
  /** What a merge would add. */
  add: Counts
  /** Transactions a merge leaves alone: on file, removed since, or alike in money and day. */
  here: number
  removed: number
  alike: number
}

/**
 * What a restore would do, for the person to read first. A ledger with a cloud is
 * brought up to date before the comparison, so the numbers are the cloud's too. If
 * the cloud cannot be read, nothing goes ahead: that goes for being offline too,
 * which a sync only skips. Signed out, there is no cloud to fall behind.
 */
export async function planRestore(file: BackupFile): Promise<RestorePlan> {
  if (restoreMode === 'merge') {
    const synced = await syncNow()
    if (synced === 'failed' || (synced === 'skipped' && hasCloudSession())) {
      throw new BackupError('Could not reach the cloud, so nothing was compared. Try again when you are online.')
    }
  }
  const ledger = await readLedger()
  const merge = planMerge(file, ledger)
  return {
    mode: restoreMode,
    backup: liveCounts(file),
    current: liveCounts(ledger),
    add: { transactions: merge.transactions.length, categories: merge.categories.length, accounts: merge.accounts.length },
    here: merge.here,
    removed: merge.removed,
    alike: merge.alike,
  }
}

/** A backup's row as a new one here: this ledger hands out its own ids. */
function withoutId<T extends { id?: number }>(row: T): T {
  const copy = { ...row }
  delete copy.id
  return copy
}

/**
 * Add what the backup has and the ledger does not, in one write, compared again
 * inside it. Rows keep their ids and stamps: the sync only ever pulls before it
 * pushes, and an old stamp never out-votes a newer row in the cloud, so what this
 * brings back cannot overwrite anything. They go up as new rows.
 */
export async function mergeBackup(file: BackupFile): Promise<Counts> {
  return db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
    const plan = planMerge(file, await readLedger())
    const fresh = new Map<string, number>()
    // `seeded` says the cloud has never claimed a default, which is not this row's story.
    for (const c of plan.categories) fresh.set(c.uid!, await db.categories.add({ ...withoutId(c), seeded: false }))
    const home = (id: number | null) => {
      const to = id == null ? null : (plan.homes.get(id) ?? null)
      return typeof to === 'string' ? (fresh.get(to) ?? null) : to
    }
    await db.transactions.bulkAdd(plan.transactions.map((t) => ({ ...withoutId(t), categoryId: home(t.categoryId) })))
    await db.accounts.bulkAdd(plan.accounts.map(withoutId))
    return { transactions: plan.transactions.length, categories: plan.categories.length, accounts: plan.accounts.length }
  })
}

/** Carry out a restore the person has confirmed. Null means the page reloads. */
export async function restoreBackup(file: BackupFile): Promise<Counts | null> {
  if (restoreMode === 'merge') return mergeBackup(file)
  await replaceLedger(file)
  location.reload()
  return null
}
