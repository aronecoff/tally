/**
 * Where the savings plan is kept: one row per account in public.savings_plan
 * (supabase/migrations/20261112120000_savings_plan.sql), cached on the device
 * (lib/planCache.ts). The public build swaps this module for one that keeps the
 * plan on the device only (scripts/flavor.ts).
 *
 * A screen never writes the cache. It sends what was asked for, and the change
 * is worked out here from the account's own row, so a stale device cannot
 * loosen a plan by accident. Last write wins by updated_at, decided by the
 * table's trigger: this file adopts whatever row comes back, unless this device
 * already holds a newer one (planCache.adoptPlan).
 *
 * The plan is cleared only where the ledger it measures is erased (sync.ts).
 * A missing table, a missing backend, no connection and a session that ended
 * never clear it: each would otherwise take a lock off with nothing said.
 */
import { supabase } from '../db/supabase'
import { todayISO } from './dates'
import { adoptPlan, planEpoch } from './planCache'
import { planToSave, readPlan, type PlanChange, type SavingsPlan } from './savingsPlan'

const TABLE = 'savings_plan'
const COLUMNS = 'goal,cap,locked,since,pending,past_caps,updated_at'
/** How long a missing table is remembered before it is asked for again. */
const RECHECK_MS = 10 * 60 * 1000
/** How fresh a good read is, for a caller that only wants the plan kept up to date. */
const STALE_MS = 60 * 1000

export type SaveResult = { ok: true } | { ok: false; message: string }

const OFFLINE: SaveResult = { ok: false, message: 'You are offline. The plan was not changed.' }
const FAILED: SaveResult = { ok: false, message: 'Could not save the plan. Try again.' }
/** The account kept it and this session holds it, but storage would not, so a launch offline would not have it yet. */
const NOT_KEPT_HERE: SaveResult = { ok: false, message: 'Saved, but this device could not keep a copy. It tries again at the next sync.' }

/** When the table was last found missing. 0 when it was not. */
let missingAt = 0
/** The table has answered this session. */
let tableSeen = false
let inFlight: { epoch: number; promise: Promise<boolean> } | null = null
/** The last request: when it started, and the ledger it was for. */
let asked: { epoch: number; at: number } | null = null
/** The ledger whose plan a load last read in full. */
let goodEpoch = -1

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false
const tableMissing = () => missingAt > 0 && Date.now() - missingAt < RECHECK_MS

/** PostgREST's answer for a table it does not have (PGRST205), or Postgres's (42P01). */
const isMissingTable = (e: unknown) => {
  const x = (e ?? {}) as { code?: string; message?: string }
  return x.code === 'PGRST205' || x.code === '42P01' || /could not find the table|relation "?[\w.]*savings_plan"? does not exist/i.test(x.message ?? '')
}

/** A cloud row as a plan: the stamp in ms, and an amount the cloud sent as text read as the number it is. */
function planFromRow(row: unknown): SavingsPlan | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const amount = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v)
  return readPlan({ ...r, goal: amount(r.goal), cap: amount(r.cap), pastCaps: r.past_caps, updatedAt: Date.parse(String(r.updated_at)) })
}

type Found = { is: 'row'; plan: SavingsPlan } | { is: 'none' } | { is: 'missing' } | { is: 'failed' }

/** The account's row, asked for now. */
async function fetchRow(userId: string): Promise<Found> {
  try {
    const { data, error } = await supabase!.from(TABLE).select(COLUMNS).eq('user_id', userId).limit(1)
    if (error) {
      if (!isMissingTable(error)) return { is: 'failed' }
      missingAt = Date.now()
      tableSeen = false
      return { is: 'missing' }
    }
    if (!Array.isArray(data)) return { is: 'failed' }
    missingAt = 0
    tableSeen = true
    if (data.length === 0) return { is: 'none' }
    const plan = planFromRow(data[0])
    return plan ? { is: 'row', plan } : { is: 'failed' }
  } catch {
    return { is: 'failed' }
  }
}

/**
 * Read the account's plan into the cache. Resolves true when the cache now holds
 * what the account holds (or there is no backend at all), and false when it
 * could not be read: offline, signed out, the table missing, a failed query. On
 * false the cached plan stays exactly as it is.
 *
 * Overlapping callers share one request, within one ledger. With `ifStale` it
 * asks only when no read has succeeded for this ledger, or the last one started
 * a minute or more ago: the sync calls it that way after every run.
 */
export function loadSavingsPlan(opts: { ifStale?: boolean } = {}): Promise<boolean> {
  const epoch = planEpoch()
  if (opts.ifStale && goodEpoch === epoch && asked?.epoch === epoch && Date.now() - asked.at < STALE_MS) return Promise.resolve(true)
  if (inFlight && inFlight.epoch === epoch) return inFlight.promise
  const entry = {
    epoch,
    promise: fetchPlan(epoch).finally(() => {
      if (inFlight === entry) inFlight = null
    }),
  }
  inFlight = entry
  return entry.promise
}

/** A load that starts now, after any already in flight: one that asked before a write cannot stand in for it. */
function reloadSavingsPlan(): Promise<boolean> {
  const prev = inFlight?.promise
  return prev ? prev.catch(() => false).then(() => loadSavingsPlan()) : loadSavingsPlan()
}

async function fetchPlan(epoch: number): Promise<boolean> {
  // A page built without its environment file has no backend. It must not clear a cached lock.
  if (!supabase) return true
  if (offline()) return false
  if (tableMissing()) return false
  // The ledger was erased while the request was out: the answer is no longer this ledger's plan.
  // An answer older than a save made meanwhile, here or in another tab, is settled by adoptPlan.
  const overtaken = () => planEpoch() !== epoch
  try {
    const { data: auth } = await supabase.auth.getSession()
    const user = auth.session?.user
    if (!user) return false
    asked = { epoch, at: Date.now() }
    const found = await fetchRow(user.id)
    if (found.is === 'missing' || found.is === 'failed') return false
    if (overtaken()) return false
    // The session ended, or someone else signed in, while this was asked: not theirs.
    const { data: now } = await supabase.auth.getSession()
    if (now.session?.user?.id !== user.id || overtaken()) return false
    adoptPlan(found.is === 'row' ? found.plan : null)
    goodEpoch = epoch
    return true
  } catch {
    return false
  }
}

/** The plan can be changed from here: a backend, a session, and a table that has answered. */
export async function planCanSave(): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    if (!data.session) return false
    if (!tableSeen) await loadSavingsPlan()
    return tableSeen
  } catch {
    return false
  }
}

/**
 * Change the plan. The account's row is read first, with a request of its own,
 * and the change is applied to that row as it stands on `today`: the clock at
 * the moment of the save, never a date a screen was holding (planToSave). There
 * is no offline queue for the plan.
 */
export async function saveSavingsPlan(change: PlanChange, today: string = todayISO()): Promise<SaveResult> {
  if (!supabase || offline()) return OFFLINE
  let userId: string | undefined
  try {
    const { data } = await supabase.auth.getSession()
    userId = data.session?.user?.id
  } catch {
    return FAILED
  }
  if (!userId) return { ok: false, message: 'Sign in to change the plan.' }

  const found = await fetchRow(userId)
  if (found.is === 'missing' || found.is === 'failed') return FAILED
  const row = found.is === 'row' ? found.plan : null
  const next = planToSave(row, change, today)
  if (!next.ok) return next

  // Never older than the row it was made from, whatever this device's clock says.
  // In whole milliseconds, as it travels: the stamp that comes back is the test below.
  const now = Math.trunc(Date.now())
  const stamp = row ? Math.max(now, row.updatedAt + 1) : now
  const { goal, cap, locked, since, pending, pastCaps } = next.plan
  const epoch = planEpoch()
  let stored: SavingsPlan | null = null
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, goal, cap, locked, since, pending, past_caps: pastCaps ?? [], updated_at: new Date(stamp).toISOString() },
        { onConflict: 'user_id' },
      )
      .select(COLUMNS)
    if (!error && Array.isArray(data)) stored = planFromRow(data[0])
  } catch {
    /* it may have landed all the same: the load below finds out */
  }
  // The ledger was erased while the write was out: that plan is not this ledger's.
  if (planEpoch() !== epoch) return FAILED
  if (!stored) {
    await reloadSavingsPlan()
    return FAILED
  }
  const keptHere = adoptPlan(stored)
  // The stamp is the test: the rest of the row does not come back in a form that can be compared.
  if (stored.updatedAt === stamp) return keptHere ? { ok: true } : NOT_KEPT_HERE
  // The trigger kept a newer row that landed in between.
  return { ok: false, message: 'The plan changed on another device. Check it, then try again.' }
}
