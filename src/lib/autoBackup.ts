import Dexie from 'dexie'
import { defaultCategories } from '../db/seed'
import { buildBackup, type BackupFile } from './backup'
import { fingerprint } from './fingerprint'
import { hasNative, native } from './native'

/**
 * A copy of the ledger in the app's Documents folder, written a while after each
 * change and when the app goes to the background, and again when it comes back if
 * that failed. WebKit does not promise to keep the page's storage, and in the public
 * app the phone holds the only copy. The app keeps a week of them and prunes by name
 * (ios/Shared/Backups.swift).
 *
 * In a browser and in the Mac app there is nowhere to write, so this does nothing.
 */
const QUIET_MS = 20_000
const DIGEST_KEY = 'tally:backupDigest'

let started = false
let stopped = false
let dirty = false
let timer: ReturnType<typeof setTimeout> | undefined
let running: Promise<void> | null = null

function readDigest(): string | null {
  try {
    return localStorage.getItem(DIGEST_KEY)
  } catch {
    return null
  }
}

function writeDigest(digest: string): void {
  try {
    localStorage.setItem(DIGEST_KEY, digest)
  } catch {
    /* storage blocked: the next run writes one more copy */
  }
}

/**
 * Nothing worth keeping: no rows, and no budget beyond the defaults. Storage that
 * was evicted, or a sign-out, leaves that, and writing it would push the real
 * backups out of the week. A budget someone set is theirs, so it counts.
 */
function isEmpty(file: BackupFile): boolean {
  if (file.transactions.some((t) => !t.deleted) || file.accounts.some((a) => !a.deleted)) return false
  const defaults = new Map(defaultCategories().map((c) => [c.name, c.monthlyBudget]))
  return !file.categories.some((c) => !c.deleted && c.monthlyBudget > 0 && defaults.get(c.name) !== c.monthlyBudget)
}

async function write(file: BackupFile): Promise<void> {
  await native('backup.write', { json: JSON.stringify(file) })
}

async function run(): Promise<void> {
  dirty = false
  try {
    const file = await buildBackup()
    if (stopped || isEmpty(file)) return
    // The same rows as the last copy, whatever the clock says, are not a new copy.
    const digest = fingerprint(JSON.stringify({ ...file, exportedAt: '' }))
    if (digest === readDigest()) return
    await write(file)
    writeDigest(digest)
  } catch {
    dirty = true // it goes again at the next change, or when the app next comes back
  }
}

/** One at a time, so a write in progress is never overtaken by an older one. */
async function flush(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  if (!dirty) return
  running = (running ?? Promise.resolve()).then(run).finally(() => {
    running = null
  })
  await running
}

/**
 * A copy that failed has no timer to bring it back, so coming back to the app does.
 * A change still waiting for quiet has one. A write caught by the app leaving may only
 * fail now, so this waits to see.
 */
async function retry(): Promise<void> {
  await running
  if (dirty && timer === undefined) await flush()
}

function mark(): void {
  if (stopped) return
  dirty = true
  clearTimeout(timer)
  timer = setTimeout(() => void flush(), QUIET_MS)
}

/** The start point, once, after the first paint has what it needs. */
export function startAutoBackup(): void {
  if (started || !hasNative()) return
  started = true
  // After every commit, for every table of every database, in one place.
  Dexie.on('storagemutated', mark)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
    else void retry()
  })
  mark() // the first launch after an update has no copy yet
}

/** Nothing more is written until the page reloads: the ledger is being erased or replaced. */
export function stopAutoBackup(): void {
  stopped = true
  dirty = false
  clearTimeout(timer)
  timer = undefined
}

/** The erase or the replace failed, so the ledger is still here: carry on, and catch up. */
export function resumeAutoBackup(): void {
  stopped = false
  if (started) mark()
}

/** Save what is here now, whatever it holds, before something replaces it. */
export async function writeBackupNow(): Promise<void> {
  if (!hasNative()) return
  stopAutoBackup()
  await running
  const file = await buildBackup()
  if (!isEmpty(file)) await write(file)
}
