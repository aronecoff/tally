import { applySyncedAccounts, syncBrokerages, type SyncedAccount } from './brokerage'
import { classifyBankTx, detectTransferIds, isoFromUnix, rentDate, type SyncedTx } from './bankRules'
import { categorize } from './categorize'
import { oneRowPerUid } from './ledger'
import { db, type Transaction, type TxType } from '../db/db'
import { supabase } from '../db/supabase'
import { syncNow } from '../sync/sync'
import { loadMerchantRules } from '../sync/merchantRules'
import { userRulesReady } from './userRules'

/** Bank & card linking (via SimpleFIN Bridge) requires Supabase configured. */
export const banksEnabled = !!supabase

// ---- Bank-connection health (drives the "reconnect" banner) -----------------
export type BankHealth = 'unknown' | 'ok' | 'expired'
let bankHealth: BankHealth = 'unknown'
const healthListeners = new Set<(h: BankHealth) => void>()

export function subscribeBankHealth(l: (h: BankHealth) => void): () => void {
  healthListeners.add(l)
  l(bankHealth)
  return () => {
    healthListeners.delete(l)
  }
}
function setBankHealth(h: BankHealth) {
  if (h === bankHealth) return
  bankHealth = h
  healthListeners.forEach((l) => l(h))
}
/** A 401/403 from SimpleFIN means the access token was revoked — reconnect needed. */
const isExpiredError = (e: unknown) =>
  e instanceof Error && /->\s*40[13]\b|forbidden|unauthorized token/i.test(e.message)

async function invoke<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Sync is not configured.')
  const { data, error } = await supabase.functions.invoke('simplefin', { body: { action, ...body } })
  if (error) {
    let detail: string | undefined
    try {
      const ctx = (error as { context?: Response }).context
      detail = (await ctx?.json?.())?.error
    } catch {
      /* fall back to the generic message */
    }
    if (detail === 'unauthorized') throw new Error('Sign in to Tally in Settings first.')
    throw new Error(detail || error.message || 'Could not reach the server. Try again.')
  }
  if (data && data.ok === false) throw new Error(data.error || 'Could not reach the server. Try again.')
  return data as T
}

/**
 * SimpleFIN refreshes upstream data ONCE every 24h and expects ~24 requests/day.
 * The app was calling it on boot, on every window focus, AND every 4 minutes
 * (2 calls each) — roughly 720 requests/day, ~30x over budget. The bridge
 * answers that with 403 Forbidden, which looks exactly like a revoked token.
 * Hence a persisted floor between automatic fetches; polling faster than the
 * upstream refresh cannot surface newer data anyway.
 */
const BANK_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000 // 4 automatic fetches/day
const LAST_FETCH_KEY = 'tally:lastBankFetchAt'

function lastBankFetchAt(): number {
  try {
    return Number(localStorage.getItem(LAST_FETCH_KEY)) || 0
  } catch {
    return 0
  }
}
function markBankFetched(): void {
  try {
    localStorage.setItem(LAST_FETCH_KEY, String(Date.now()))
  } catch {
    /* private mode — falls back to per-session throttling */
  }
}
/** True when an automatic bank fetch is due. `force` = explicit user action. */
export function bankFetchDue(force = false): boolean {
  return force || Date.now() - lastBankFetchAt() >= BANK_MIN_INTERVAL_MS
}
/** Minutes until the next automatic bank refresh (0 when due now). */
export function minutesUntilBankRefresh(): number {
  const due = lastBankFetchAt() + BANK_MIN_INTERVAL_MS - Date.now()
  return due <= 0 ? 0 : Math.ceil(due / 60000)
}

/** Whether a SimpleFIN access link is already stored server-side. */
export async function bankStatus(): Promise<boolean> {
  try {
    const d = await invoke<{ ok: boolean; connected: boolean }>('status')
    return !!d.connected
  } catch {
    return false
  }
}

/** Exchange a SimpleFIN Bridge setup token for a stored access link. */
export async function claimBank(setupToken: string): Promise<void> {
  await invoke('claim', { setupToken: setupToken.trim() })
  setBankHealth('ok') // fresh token — connection healthy again
}

/** Pull live bank/card accounts and merge them into Dexie under the 'simplefin' source. */
export async function syncBanks(): Promise<number> {
  let data: { ok: boolean; accounts: SyncedAccount[] }
  try {
    data = await invoke<{ ok: boolean; accounts: SyncedAccount[] }>('sync')
  } catch (e) {
    // Before a bank is linked the function returns "not connected" — expected,
    // not an error worth surfacing during a routine combined sync.
    if (e instanceof Error && /not connected/i.test(e.message)) return 0
    if (isExpiredError(e)) setBankHealth('expired')
    throw e
  }
  setBankHealth('ok')
  const incoming = (data.accounts ?? []).filter((a) => a.sourceAccountId)
  await applySyncedAccounts(incoming, 'simplefin')
  return incoming.length
}

/**
 * Pull real transactions from the linked banks/cards and reconcile them into the
 * transactions table, so the budget runs on ACTUAL spending. Excludes internal
 * transfers / card-payments (matched debit↔credit across accounts + keyword
 * fallback). Card refunds come in as negative expenses (bankRules.ts).
 * Reconciles: rows now classified as transfers are removed, so re-syncing
 * corrects earlier over-counts. Idempotent (uid = sf:<tx id>).
 */
// 365, not 120: the banks return everything they have (in practice ~4 months)
// and a 120-day request was silently dropping a THIRD of the history — the app
// held barely half of one month's transactions.
export async function syncBankTransactions(days = 365): Promise<number> {
  let data: { ok: boolean; transactions: SyncedTx[] }
  try {
    data = await invoke<{ ok: boolean; transactions: SyncedTx[] }>('transactions', { days })
  } catch (e) {
    if (e instanceof Error && /not connected/i.test(e.message)) return 0
    if (isExpiredError(e)) setBankHealth('expired')
    throw e
  }
  const incoming = data.transactions ?? []
  if (!incoming.length) return 0

  const cats = await db.categories.filter((c) => !c.deleted).toArray()
  // Name → all categories with that name. Duplicate names across kinds are legal
  // (nothing stops "Salary" existing as both income and expense), so the lookup
  // must pick the entry whose kind matches the transaction, not the last one in.
  const catsByName = new Map<string, { id: number; kind: string }[]>()
  for (const c of cats) {
    const k = c.name.toLowerCase()
    const list = catsByName.get(k) ?? []
    list.push({ id: c.id!, kind: c.kind })
    catsByName.set(k, list)
  }
  const transferIds = detectTransferIds(incoming)
  const now = Date.now()

  // Desired = the real (non-transfer, non-investment) transactions, keyed by uid.
  const desired = new Map<string, Transaction>()
  for (const t of incoming) {
    const verdict = classifyBankTx(t, transferIds)
    if (verdict.kind === 'skip') continue
    const acct = t.account || ''
    // A refund files like the merchant's purchases (same rules, expense side),
    // so it lands in that category and offsets it.
    const type: TxType = verdict.kind === 'income' ? 'income' : 'expense'

    let name = categorize({ description: t.description, payee: t.payee, memo: t.memo, mcc: t.mcc, kind: type })
    if (type === 'income' && !name) name = 'Other income'
    // Guard: never file an expense under an income category (or vice versa),
    // even if a keyword slips through — that inversion is what broke the footing.
    const cat = name
      ? catsByName.get(name.toLowerCase())?.find((c) => (c.kind === 'income') === (type === 'income'))
      : undefined
    const categoryId = cat ? cat.id : null
    const posted = isoFromUnix(t.posted)
    const rent = cat != null && verdict.kind === 'expense' && name!.trim().toLowerCase() === 'rent'

    const uid = `sf:${t.sourceTxId}`
    const cents = Math.round(Math.abs(Number(t.amount)) * 100) / 100
    desired.set(uid, {
      uid,
      // Rent paid early counts on the 1st of the month it pays for (bankRules.ts).
      date: rent ? rentDate(posted) : posted,
      amount: verdict.kind === 'refund' ? -cents : cents,
      type,
      categoryId,
      account: acct,
      note: t.payee || t.description || '',
      pending: !!t.pending,
      createdAt: now,
      updatedAt: now,
    } as Transaction)
  }

  // Reconcile existing synced (sf:) rows to match `desired`.
  let added = 0
  // The bank only returned the last `days`, so anything older was never a
  // candidate for `desired` and must not be reconciled away. Without this the
  // whole history beyond the window was tombstoned on every single sync.
  // One day of slack absorbs client/server clock skew at the boundary.
  // Derive the window from what the bank ACTUALLY returned, not from what we
  // asked for: providers routinely return a shorter span than `days`, and every
  // real row falling in that gap was being tombstoned one payday at a time.
  // Whichever boundary is LATER wins, so we only ever reconcile rows we can see.
  const requestedStart = isoFromUnix(Math.floor(Date.now() / 1000) - (days + 1) * 86400)
  let oldestReturned = Infinity
  for (const t of incoming) {
    const p = Number(t.posted)
    if (Number.isFinite(p) && p < oldestReturned) oldestReturned = p
  }
  const returnedStart = Number.isFinite(oldestReturned) ? isoFromUnix(oldestReturned) : requestedStart
  const windowStart = returnedStart > requestedStart ? returnedStart : requestedStart
  // Likewise, an account missing from this payload (one bank erroring, a partial
  // response) must not mass-delete that account's in-window rows.
  const seenAccounts = new Set(incoming.map((t) => t.account || ''))
  await db.transaction('rw', db.transactions, async () => {
    // Read the synced rows INSIDE the write transaction: a device-sync pull that
    // landed between a read and these writes had its row added a second time
    // below, and a row stored twice counts twice.
    const existing = await db.transactions.filter((t) => (t.uid ?? '').startsWith('sf:')).toArray()
    const { byUid: existingByUid, copies } = oneRowPerUid(existing)
    // Copies are deleted outright. They used to be tombstoned, which pushed
    // `deleted` under the shared uid and set the resurrect branch below
    // flip-flopping the real row on every sync.
    if (copies.length) await db.transactions.bulkDelete(copies.map((c) => c.id!))
    for (const t of existingByUid.values()) {
      if (
        t.uid && !t.deleted && !t.manual &&
        t.date >= windowStart &&
        seenAccounts.has(t.account || '') &&
        !desired.has(t.uid)
      ) {
        await db.transactions.update(t.id!, { deleted: true, updatedAt: now }) // now a transfer / gone
      }
    }
    const toAdd: Transaction[] = []
    for (const [uid, row] of desired) {
      const ex = existingByUid.get(uid)
      if (!ex) {
        toAdd.push(row)
        added++
      } else if (ex.deleted && !ex.manual) {
        // Manually-excluded rows stay excluded — the bank can't resurrect them.
        await db.transactions.update(ex.id!, {
          deleted: false, categoryId: row.categoryId, amount: row.amount, type: row.type, date: row.date, updatedAt: now,
        })
        added++
      } else if (
        !ex.manual &&
        (ex.categoryId !== row.categoryId || ex.type !== row.type ||
          ex.amount !== row.amount || ex.date !== row.date ||
          !!ex.pending !== !!row.pending)
      ) {
        // Row already present but our classification improved — re-apply it so a
        // re-sync fully re-categorizes existing transactions in place. Rows the
        // user edited by hand (`manual`) are pinned: the bank never overwrites them.
        await db.transactions.update(ex.id!, {
          categoryId: row.categoryId, amount: row.amount, type: row.type, date: row.date,
          pending: row.pending, updatedAt: now,
        })
      }
    }
    if (toAdd.length) await db.transactions.bulkAdd(toAdd)
  })
  return added
}

/**
 * Self-heal: file any uncategorised, non-manual transaction using the same rules
 * the bank sync uses.
 *
 * A device whose categories were briefly broken (duplicate sets, a uid that
 * failed to resolve) ends up holding rows that are uncategorised locally AND
 * stamped NEWER than the corrected cloud rows — so last-write-wins means no pull
 * will ever fix them. Re-deriving locally is what breaks that stalemate; it
 * needs no network and cannot be out-voted by a timestamp.
 */
export async function recategorizeUncategorized(): Promise<number> {
  const cats = await db.categories.filter((c) => !c.deleted).toArray()
  if (cats.length === 0) return 0
  const byName = new Map<string, { id: number; kind: string }[]>()
  for (const c of cats) {
    if (c.id == null) continue
    const k = c.name.trim().toLowerCase()
    const list = byName.get(k) ?? []
    list.push({ id: c.id, kind: c.kind })
    byName.set(k, list)
  }

  // NOTE: `manual` rows are included on purpose. That flag means "the user chose
  // this, don't let the bank overwrite it" — but an EMPTY category was never a
  // choice, so filling one in destroys nothing. Excluding them left the largest
  // orphan of all (a pinned rent charge) permanently uncategorised.
  const orphans = await db.transactions
    .filter((t) => !t.deleted && t.categoryId == null)
    .toArray()
  if (orphans.length === 0) return 0

  const now = Date.now()
  let fixed = 0
  for (const t of orphans) {
    const guess = categorize({ description: t.note, payee: t.note, kind: t.type })
    if (!guess) continue
    const cat = byName
      .get(guess.trim().toLowerCase())
      ?.find((c) => (c.kind === 'income') === (t.type === 'income'))
    if (!cat) continue
    await db.transactions.update(t.id!, { categoryId: cat.id, updatedAt: now })
    fixed++
  }
  return fixed
}

/**
 * Refresh every connector — brokerage balances, bank balances, and real
 * transactions — independently. `total` counts live ACCOUNTS (not transactions);
 * transaction-sync failures are non-blocking.
 */
let syncInFlight: Promise<{ total: number; errors: string[]; bankSkipped?: boolean }> | null = null

/** Coalesces overlapping callers (boot timer, focus, 4-minute interval, Accounts
 *  mount) onto one run. Two concurrent runs each saw an empty table and both
 *  inserted, duplicating every bank transaction and account. */
export function syncAllConnectors(
  opts: { force?: boolean } = {},
): Promise<{ total: number; errors: string[]; bankSkipped?: boolean }> {
  if (syncInFlight) return syncInFlight
  syncInFlight = runAllConnectors(opts.force ?? false).finally(() => { syncInFlight = null })
  return syncInFlight
}

async function runAllConnectors(force: boolean): Promise<{ total: number; errors: string[]; bankSkipped?: boolean }> {
  // The user's own categorization rules live in the cloud (merchant_rules).
  // Until a copy exists on this device (fetched now, or cached from an earlier
  // run), every automatic re-filing waits: a fresh device would otherwise file
  // those merchants by the built-in rules alone and push that over the cloud.
  // Balances do not depend on categories, so they still refresh.
  const rulesOk = (await loadMerchantRules().catch(() => false)) || userRulesReady()
  // Device sync FIRST: pull the cloud's truth (incl. `manual` pins and moved
  // dates) into Dexie before the bank overlay runs. Without this ordering, a
  // fresh boot ran the bank reconcile against pin-unaware local rows, re-dated
  // them from raw bank data, and pushed that over the user's edits.
  await syncNow().catch(() => {})
  // Repair anything the pull could not fix on its own, then let the debounced
  // push carry the result back up.
  if (rulesOk) await recategorizeUncategorized().catch(() => {})
  // Brokerage has its own quota and is cheap; the BANK pair is the rate-limited
  // one, so it alone is gated behind the interval.
  const doBank = bankFetchDue(force)
  if (doBank) markBankFetched()
  const [broker, bank, tx] = await Promise.allSettled([
    syncBrokerages(),
    doBank ? syncBanks() : Promise.resolve(0),
    doBank && rulesOk ? syncBankTransactions() : Promise.resolve(0),
  ])
  let total = 0
  const errors: string[] = []
  for (const r of [broker, bank]) {
    if (r.status === 'fulfilled') total += r.value || 0
    else errors.push(r.reason instanceof Error ? r.reason.message : 'Could not refresh. Try again.')
  }
  if (tx.status === 'rejected' && total === 0 && errors.length === 0) {
    errors.push(tx.reason instanceof Error ? tx.reason.message : 'Could not refresh. Try again.')
  }
  return { total, errors, bankSkipped: !doBank }
}
