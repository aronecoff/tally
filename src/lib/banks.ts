import { userEdits } from './accountEdits'
import { applySyncedAccounts, syncBrokerages, type SyncedAccount } from './brokerage'
import {
  classifyBankTx, detectPendingTransferIds, detectTransferIds, effectiveTier, isoFromUnix, matchRentRefunds, rentDate, rentRefile, tierFromName,
  tierFromRows,
  RENT_EARLY_FROM_DAY,
  type SyncedTx,
} from './bankRules'
import { categorize, findCategoryFor, isRentCategory } from './categorize'
import { todayISO } from './dates'
import { edgeFailure } from './edgeError'
import { oneRowPerUid } from './ledger'
import { db, type Account, type Transaction, type TxType } from '../db/db'
import { supabase } from '../db/supabase'
import { currentLedgerGeneration, syncNow, type SyncResult } from '../sync/sync'
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

// ---- Connection warnings ------------------------------------------------------
// A connection SimpleFIN could not refresh this time ('Connection to … may need
// attention'). Its accounts are not archived while it says so (syncBanks), and
// Accounts shows the message instead of a bare 'Updated just now'.
let bankWarnings: string[] = []
const warningListeners = new Set<(w: string[]) => void>()

export function subscribeBankWarnings(l: (w: string[]) => void): () => void {
  warningListeners.add(l)
  l(bankWarnings)
  return () => {
    warningListeners.delete(l)
  }
}
function setBankWarnings(w: string[]) {
  if (w.length === bankWarnings.length && w.every((x, i) => x === bankWarnings[i])) return
  bankWarnings = w
  warningListeners.forEach((l) => l(w))
}

/** SimpleFIN's own error lines: `errors` (protocol 1) and `errlist` (protocol 2). */
type SimplefinProblems = { errors?: unknown[]; errlist?: { msg?: unknown }[] }
function problemsOf(d: SimplefinProblems): string[] {
  const lines = [...(d.errors ?? []).map((e) => String(e ?? '')), ...(d.errlist ?? []).map((e) => String(e?.msg ?? ''))]
  return lines.map((x) => x.trim()).filter(Boolean)
}
/** A 401/403 from SimpleFIN means the access token was revoked — reconnect needed. */
const isExpiredError = (e: unknown) =>
  e instanceof Error && /->\s*40[13]\b|forbidden|unauthorized token/i.test(e.message)

async function invoke<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Sync is not configured.')
  const { data, error } = await supabase.functions.invoke('simplefin', { body: { action, ...body } })
  if (error) throw await edgeFailure(error)
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
/** The floor: the last automatic fetch that reached SimpleFIN (answered, even
 *  with a refusal). One that never got there (offline, signed out) is not
 *  counted, or it blocked bank data for 6 hours while fetching nothing. */
const ATTEMPT_KEY = 'tally:bankAttemptAt'
/** When bank data last came back: Accounts' 'Bank data updated …'. */
const LAST_FETCH_KEY = 'tally:lastBankFetchAt'

function readTime(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}
function writeTime(key: string, at: number): void {
  try {
    if (at) localStorage.setItem(key, String(at))
    else localStorage.removeItem(key)
  } catch {
    /* private mode — falls back to per-session throttling */
  }
}
/** True when an automatic bank fetch is due. `force` = explicit user action. */
export function bankFetchDue(force = false): boolean {
  return force || Date.now() - readTime(ATTEMPT_KEY) >= BANK_MIN_INTERVAL_MS
}
/** Minutes until the next automatic bank refresh (0 when due now). */
export function minutesUntilBankRefresh(): number {
  const due = readTime(ATTEMPT_KEY) + BANK_MIN_INTERVAL_MS - Date.now()
  return due <= 0 ? 0 : Math.ceil(due / 60000)
}
/** A bank call that got as far as SimpleFIN: an answer, or SimpleFIN's own refusal. */
const reachedSimplefin = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' || (r.reason instanceof Error && /simplefin \/accounts ->\s*\d{3}/i.test(r.reason.message))

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

/**
 * Pull live bank/card accounts and merge them into Dexie under the 'simplefin'
 * source. `shown` counts the accounts now listed; `removed` the ones the user
 * deleted, which stay hidden (Accounts can restore them).
 *
 * An answer that reports a connection error may leave that connection's
 * accounts out: nothing is archived then, or net worth swung by a whole
 * account while reading 'Updated just now'.
 */
async function syncBankAccounts(): Promise<{ shown: number; removed: number }> {
  // A wipe of the local ledger while this runs: the answer is the old account's.
  const generation = currentLedgerGeneration()
  let data: { ok: boolean; accounts: SyncedAccount[] } & SimplefinProblems
  try {
    data = await invoke<{ ok: boolean; accounts: SyncedAccount[] } & SimplefinProblems>('sync')
  } catch (e) {
    // Before a bank is linked the function returns "not connected" — expected,
    // not an error worth surfacing during a routine combined sync.
    if (e instanceof Error && /not connected/i.test(e.message)) return { shown: 0, removed: 0 }
    if (isExpiredError(e)) setBankHealth('expired')
    throw e
  }
  setBankHealth('ok')
  if (currentLedgerGeneration() !== generation) return { shown: 0, removed: 0 }
  const problems = problemsOf(data)
  setBankWarnings(problems)
  writeTime(LAST_FETCH_KEY, Date.now())
  const incoming = (data.accounts ?? []).filter((a) => a.sourceAccountId)
  return applySyncedAccounts(incoming, 'simplefin', { archiveMissing: problems.length === 0, generation })
}

/** Pull live bank/card accounts; resolves to the number of accounts shown. */
export async function syncBanks(): Promise<number> {
  return (await syncBankAccounts()).shown
}

/**
 * The stored account a feed row belongs to: by the account id the Edge Function
 * sends (newer versions), else by the `<bank>:<account>` head of the row's id,
 * else by its label ('<institution> <account name>').
 */
function accountMatcher(accounts: Account[]): (t: SyncedTx) => Account | undefined {
  const byKey = new Map<string, Account>()
  for (const a of accounts) if (a.sourceAccountId) byKey.set(a.sourceAccountId, a)
  return (t) => {
    if (t.sourceAccountId && byKey.has(t.sourceAccountId)) return byKey.get(t.sourceAccountId)
    const parts = t.sourceTxId.split(':')
    if (parts.length >= 3) {
      const hit = byKey.get(`${parts[0]}:${parts[1]}`)
      if (hit) return hit
    }
    const label = (t.account || '').trim().toLowerCase()
    if (!label) return undefined
    // By the connector's own names too: the user may have renamed the row.
    const named = (institution: string, n: string) => {
      const inst = (institution || '').trim().toLowerCase()
      const name = (n || '').trim().toLowerCase()
      return !!inst && !!name && label.startsWith(`${inst} `) && label.endsWith(name)
    }
    return accounts.find((a) => named(a.institution, a.name) || (!!a.sourceSaid && named(a.sourceSaid.institution, a.sourceSaid.name)))
  }
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
export async function syncBankTransactions(days = 365, opts: { after?: Promise<unknown> } = {}): Promise<number> {
  // A wipe of the local ledger (sign-out, another account) while this runs
  // means its rows belong to the account that left: they are not written.
  const generation = currentLedgerGeneration()
  let data: { ok: boolean; transactions: SyncedTx[]; accounts?: unknown[] } & SimplefinProblems
  try {
    data = await invoke<{ ok: boolean; transactions: SyncedTx[]; accounts?: unknown[] } & SimplefinProblems>('transactions', { days })
  } catch (e) {
    if (e instanceof Error && /not connected/i.test(e.message)) return 0
    if (isExpiredError(e)) setBankHealth('expired')
    throw e
  }
  if (currentLedgerGeneration() !== generation) return 0
  writeTime(LAST_FETCH_KEY, Date.now())
  // SimpleFIN allows a pending row to carry posted 0 (and the Edge Function
  // passed a missing date on as 0 or null). Read as a date that was 1970: the
  // row was stored there for good, and the reconcile window widened to 366
  // days, tombstoning every older row. Such a row is dated now, once, here,
  // before anything reads `posted`.
  const nowSec = Math.floor(Date.now() / 1000)
  const undated = new Set<string>()
  const raw = (data.transactions ?? []).map((t) => {
    const p = Number(t.posted)
    if (Number.isFinite(p) && p >= MIN_POSTED) return t
    undated.add(t.sourceTxId)
    return { ...t, posted: nowSec }
  })
  // The balance sync of the same run, fetched side by side with this one,
  // lands first: an account whose balance moved back above zero is a bank
  // account again (bankRules.effectiveTier), and read before that its deposits
  // were filed as card credits until the next bank fetch. Its failure is its
  // own to report.
  if (opts.after) {
    await opts.after.catch(() => {})
    if (currentLedgerGeneration() !== generation) return 0
  }
  // Every account that answered, rows or not (newer Edge Functions), trusted
  // only from an answer with no errors: an errored bank may be listed bare.
  const responded = Array.isArray(data.accounts) && problemsOf(data).length === 0 ? data.accounts.map(String) : []
  if (!raw.length && !responded.length) return 0

  // Read each row by its account's real tier (bankRules.effectiveTier): the
  // Edge Function guesses from the balance, so a card at $0 read as cash and an
  // overdrawn checking as credit, which turned refunds into income and payroll
  // into refunds for as long as the balance said so. A row whose account is not
  // stored yet still has its own label to read: the first sync on a fresh or
  // wiped device fetches accounts and transactions side by side, and an account
  // can be skipped (no balance) or tombstoned. The account's own name is read
  // when the Edge Function sends it, so the institution's words ("… Investments",
  // "… Savings Bank") cannot decide; older ones send only "<institution> <name>".
  //
  // Failing a name, the account's own rows say what it is (bankRules.
  // tierFromRows): pay lands in a bank account, a payment received pays a card.
  // That is remembered on the stored account, so its balance sync reads it too
  // and an account overdrawn once is not a card for good.
  const sfAccounts = await db.accounts.filter((a) => a.source === 'simplefin' && !a.deleted).toArray()
  const accountOf = accountMatcher(sfAccounts)
  const rowsByLabel = new Map<string, SyncedTx[]>()
  for (const t of raw) {
    const list = rowsByLabel.get(t.account || '')
    if (list) list.push(t)
    else rowsByLabel.set(t.account || '', [t])
  }
  const saysOf = new Map([...rowsByLabel].map(([label, list]) => [label, tierFromRows(list)]))
  /** Stored accounts whose rows said what they are: account id -> what, and the bank's tier. */
  const learned = new Map<number, { says: 'cash' | 'credit'; edgeTier: string }>()
  //
  // A type the user set by hand on the account (lib/accountEdits.ts) decides:
  // they said what it is. The name read is the connector's, not one the user
  // typed over it.
  const incoming: SyncedTx[] = raw.map((t) => {
    const a = accountOf(t)
    const own = a?.sourceSaid?.name ?? a?.name
    const label = own && tierFromName(own) ? own : t.accountName || t.account || own || ''
    const says = saysOf.get(t.account || '') ?? null
    if (a?.id != null && says) learned.set(a.id, { says, edgeTier: t.tier })
    const tier = a && userEdits(a).type ? a.type : effectiveTier(label, t.tier, a?.type ?? null, { rows: says ?? a?.rowsSay ?? null })
    return tier === t.tier ? t : { ...t, tier }
  })

  const cats = await db.categories.filter((c) => !c.deleted).toArray()
  // A rule's category name resolves by the seeded key first (a renamed Rent
  // still files rent), then by name, kind-matched: duplicate names across
  // kinds are legal, so an expense never lands in an income category.
  const expenseCategoryOf = (t: SyncedTx) =>
    findCategoryFor(categorize({ description: t.description, payee: t.payee, memo: t.memo, mcc: t.mcc, kind: 'expense' }), 'expense', cats)
  const transferIds = detectTransferIds(incoming)
  const pendingTransferIds = detectPendingTransferIds(incoming)
  // Rent refunds, matched to the payment each one reverses (bankRules.ts).
  const rentRefunds = matchRentRefunds(incoming, (t) => {
    const c = expenseCategoryOf(t)
    return !!c && isRentCategory(c)
  }, transferIds)
  const now = Date.now()

  // The oldest days of the feed: a transfer leg posted here may have lost its
  // partner off the end of the bank's window, and on its own it reads as
  // income or spending ('DEPOSIT'). Bank-account rows here that no rule can
  // name are held: not added, not re-read, not tombstoned.
  let oldestReturned = Infinity
  for (const t of incoming) {
    const p = Number(t.posted)
    if (Number.isFinite(p) && p < oldestReturned) oldestReturned = p
  }
  const edgeEnd = oldestReturned + 5 * 86400
  const held = new Set<string>()
  // A rule that names a category with no live match (renamed or deleted):
  // uid -> 'kind|name', settled against the stored rows below.
  const unresolved = new Map<string, string>()

  // Desired = the real (non-transfer, non-investment) transactions, keyed by uid.
  const desired = new Map<string, Transaction>()
  for (const t of incoming) {
    // The built-in key where there is one, so a renamed Rent or Other is still known.
    let verdict = classifyBankTx(t, transferIds, pendingTransferIds, (x) => {
      const c = expenseCategoryOf(x)
      return c ? (c.key ?? c.name) : null
    })
    if (verdict.kind === 'skip') continue
    // A landlord's credit to checking that reverses a rent payment is a refund.
    const rentPaid = rentRefunds.get(t.sourceTxId)
    if (rentPaid && verdict.kind === 'income') verdict = { kind: 'refund' }
    const acct = t.account || ''
    // A refund files like the merchant's purchases (same rules, expense side),
    // so it lands in that category and offsets it.
    const type: TxType = verdict.kind === 'income' ? 'income' : 'expense'

    const name = categorize({ description: t.description, payee: t.payee, memo: t.memo, mcc: t.mcc, kind: type })
    const uid = `sf:${t.sourceTxId}`
    if (!name && t.tier === 'cash' && Number(t.posted) < edgeEnd && !transferIds.has(t.sourceTxId)) {
      held.add(uid)
      continue
    }
    // Guard: never file an expense under an income category (or vice versa),
    // even if a keyword slips through — that inversion is what broke the footing.
    const ruleName = type === 'income' && !name ? 'Other income' : name
    const cat = findCategoryFor(ruleName, type, cats)
    if (ruleName && !cat) unresolved.set(uid, `${type}|${ruleName.trim().toLowerCase()}`)
    const categoryId = cat?.id ?? null
    const posted = undated.has(t.sourceTxId) ? todayISO() : isoFromUnix(t.posted)
    const rent = cat != null && verdict.kind === 'expense' && isRentCategory(cat)
    // Rent paid early counts on the 1st of the month it pays for; a refund of
    // rent counts no earlier than the rent it reverses (bankRules.ts).
    let date = rent ? rentDate(posted) : posted
    if (rentPaid && cat != null && isRentCategory(cat)) {
      const reverses = rentDate(rentPaid)
      if (reverses > date) date = reverses
    }

    const cents = Math.round(Math.abs(Number(t.amount)) * 100) / 100
    desired.set(uid, {
      uid,
      date,
      amount: verdict.kind === 'refund' ? -cents : cents,
      type,
      categoryId,
      account: acct,
      note: t.payee || t.description || '',
      pending: !!t.pending,
      // The bank's own day beside a moved date (rent), so moving it out of
      // Rent by hand puts it back. Local only (Transaction.posted). A pending
      // row keeps it from the start, so a move the user makes before it posts
      // is told apart from the bank's day (the ghost pass below).
      ...((date !== posted || t.pending) && !undated.has(t.sourceTxId) ? { posted } : {}),
      // The bank's words for a pending row, so a note the user types on it is
      // told apart from them when it posts. Local only (Transaction.bankNote).
      ...(t.pending ? { bankNote: t.payee || t.description || '' } : {}),
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
  const requestedStart = isoFromUnix(nowSec - (days + 1) * 86400)
  const returnedStart = Number.isFinite(oldestReturned) ? isoFromUnix(oldestReturned) : requestedStart
  const windowStart = returnedStart > requestedStart ? returnedStart : requestedStart
  // ...and per account: one card answering a shorter span than another (a
  // partial answer, a re-link) must not lose its older rows. Built from every
  // row an account returned, transfers included; undated rows say nothing.
  // A pending row the bank no longer lists is gone whatever the account's
  // span, so it is reconciled over the whole feed's window.
  const acctStart = new Map<string, string>()
  for (const t of incoming) {
    if (undated.has(t.sourceTxId)) continue
    const a = t.account || ''
    const d = isoFromUnix(t.posted)
    const cur = acctStart.get(a)
    if (cur === undefined || d < cur) acctStart.set(a, d)
  }
  const startFor = (t: Transaction) => {
    if (t.pending) return windowStart
    const d = acctStart.get(t.account || '')
    if (d === undefined) return '￿' // only undated rows from this account: reconcile none
    return d > requestedStart ? d : requestedStart
  }
  // Likewise, an account missing from this payload (one bank erroring, a partial
  // response) must not mass-delete that account's in-window rows. One that
  // answered with no rows at all (newer Edge Functions say so) still retires
  // its dropped holds; its posted history is never touched.
  const seenAccounts = new Set(incoming.map((t) => t.account || ''))
  const quietAccounts = new Set(responded.filter((a) => !seenAccounts.has(a)))
  await db.transaction('rw', db.transactions, db.accounts, async () => {
    if (currentLedgerGeneration() !== generation) return
    // Remember what each account's rows said. One they move between cash and
    // credit moves now, its stored balance flipping sign with it (credit is
    // stored as the amount owed), so Accounts agrees with how its rows were
    // read instead of waiting for the next balance sync.
    for (const [id, { says, edgeTier }] of learned) {
      const a = await db.accounts.get(id)
      if (!a || a.deleted) continue
      const patch: Partial<Account> = {}
      if (a.rowsSay !== says) patch.rowsSay = says
      // Never over a type the user set by hand (lib/accountEdits.ts). The
      // connector's record moves with its own tier, so the row does not then
      // read as one the user retyped.
      const tier = effectiveTier(a.sourceSaid?.name ?? a.name, edgeTier, a.type, { rows: says })
      if (!userEdits(a).type && tier !== a.type && (tier === 'cash' || tier === 'credit') && (a.type === 'cash' || a.type === 'credit')) {
        Object.assign(patch, { type: tier, balance: -a.balance || 0, updatedAt: now })
        if (a.sourceSaid) patch.sourceSaid = { ...a.sourceSaid, type: tier }
      }
      if (Object.keys(patch).length) await db.accounts.update(id, patch)
    }
    // Read the synced rows INSIDE the write transaction: a device-sync pull that
    // landed between a read and these writes had its row added a second time
    // below, and a row stored twice counts twice.
    const existing = await db.transactions.filter((t) => (t.uid ?? '').startsWith('sf:')).toArray()
    const { byUid: existingByUid, copies } = oneRowPerUid(existing)
    // Copies are deleted outright. They used to be tombstoned, which pushed
    // `deleted` under the shared uid and set the resurrect branch below
    // flip-flopping the real row on every sync.
    if (copies.length) await db.transactions.bulkDelete(copies.map((c) => c.id!))

    // A rule naming a category that was renamed or deleted resolves to none.
    // That used to write null over every stored row of it at each sync. A row
    // keeps the live category it sits in (of its own kind), and a new one goes
    // where most of the stored rows of that rule now sit: Other after a delete,
    // the new name after a rename.
    if (unresolved.size) {
      const liveKind = new Map(cats.map((c) => [c.id!, c.kind]))
      const kept = (uid: string) => {
        const ex = existingByUid.get(uid)
        const id = ex && !ex.deleted ? ex.categoryId : null
        return id != null && liveKind.get(id) === desired.get(uid)!.type ? id : null
      }
      const votes = new Map<string, Map<number, number>>()
      for (const [uid, key] of unresolved) {
        const id = kept(uid)
        if (id == null) continue
        const v = votes.get(key) ?? new Map<number, number>()
        v.set(id, (v.get(id) ?? 0) + 1)
        votes.set(key, v)
      }
      const alias = new Map<string, number>()
      for (const [key, v] of votes) alias.set(key, [...v].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0])
      for (const [uid, key] of unresolved) desired.get(uid)!.categoryId = kept(uid) ?? alias.get(key) ?? null
    }

    // The day a stored row posted, as far as is known: the bank's own day kept
    // beside a moved date (Transaction.posted), else the earliest day rent
    // dating could have moved it from, for a row in Rent. Any other row posted
    // on its date: widening every row on a 1st kept a vanished row (income, a
    // transfer) alive while the 1st sat at the feed's first day.
    const rentIds = new Set(cats.filter((c) => isRentCategory(c)).map((c) => c.id!))
    const postedOn = (t: Transaction) =>
      t.posted ?? (t.type === 'expense' && t.categoryId != null && rentIds.has(t.categoryId) ? earliestPosted(t.date) : t.date)
    for (const t of existingByUid.values()) {
      if (!t.uid || t.deleted || t.manual || desired.has(t.uid) || held.has(t.uid)) continue
      const acct = t.account || ''
      // Stored in 1970 by an earlier version (a pending row with no date): never a real posting.
      const undatedGhost = t.date < '2000-01-01'
      const listed = seenAccounts.has(acct) || (!!t.pending && quietAccounts.has(acct))
      if (undatedGhost || (listed && postedOn(t) >= startFor(t))) {
        await db.transactions.update(t.id!, { deleted: true, updatedAt: now }) // now a transfer / gone
      }
    }

    // A PINNED pending row the bank no longer lists has posted under a new id,
    // or the hold was dropped. Pins never reconcile, so it used to stay live
    // beside the posted row (counted twice), a hidden one came back, and a
    // dropped hold counted for good. The user's edits move to the posted row
    // (same account, type and sign, amount within 25%, within 7 days of the
    // hold's date or of when it was imported; never a pinned row or one stored
    // before the hold), and the pending row is retired either way: a dropped
    // hold is not money spent, and the money comes out right even when no
    // successor is found.
    //
    // A hide moves only to a SURE successor: the one candidate with the hold's
    // exact amount or a word of its description. Otherwise a different charge
    // that first appeared on the card that day (a $48 lunch beside a dropped
    // $50 hold) was hidden for good; now the posted row counts, and the user
    // can hide it again. A filing or a move still goes to the closest match.
    const claimed = new Set<string>()
    for (const g of existingByUid.values()) {
      if (!g.uid || !g.manual || !g.pending || desired.has(g.uid)) continue
      const acct = g.account || ''
      if (!seenAccounts.has(acct) && !quietAccounts.has(acct)) continue
      const anchor = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : g.date
      // The bank retired this row before (a pinned tombstone an older version
      // then flipped back to pending when the hold was listed again): its
      // tombstone is the bank's, never the user's hide.
      const hidden = !!g.deleted && !g.retired
      // The bank's words, not a note the user typed over them.
      const words = noteWords(g.bankNote ?? g.note)
      const candidates: { d: Transaction; score: number; sure: boolean }[] = []
      for (const d of desired.values()) {
        if (claimed.has(d.uid!) || (d.account || '') !== acct || d.type !== g.type) continue
        if (!d.amount || Math.sign(d.amount) !== Math.sign(g.amount)) continue
        const off = Math.abs(Math.abs(d.amount) - Math.abs(g.amount)) / Math.max(Math.abs(g.amount), 0.01)
        if (off > 0.25 || (dayGap(d.date, g.date) > 7 && dayGap(d.date, anchor) > 7)) continue
        const ex = existingByUid.get(d.uid!)
        if (ex && (ex.manual || !(ex.createdAt > g.createdAt))) continue
        const sure = off === 0 || [...noteWords(d.note)].some((w) => words.has(w))
        candidates.push({ d, score: off * 100 + dayGap(d.date, anchor), sure })
      }
      candidates.sort((a, b) => a.score - b.score)
      const sure = candidates.filter((c) => c.sure)
      const best = sure.length === 1 ? sure[0].d : hidden ? undefined : candidates[0]?.d
      if (best) {
        claimed.add(best.uid!)
        // Everything the user set on the hold, as the sheet promises ('Edits
        // here carry over when it posts'):
        //  - the date only when it was really moved: marked so where it was set
        //    (Transaction.dateMoved), or else off the bank's own day kept
        //    beside it (Transaction.posted), which the date of an unmoved hold
        //    follows when the bank re-dates it (below), a move of one day across
        //    a month end included. Rows stored before that was kept fall back to
        //    a gap from the day the hold was imported. Never the bank's pending
        //    date, nor a 1970 date an earlier version stored;
        //  - a note the user typed, not the bank's words (Transaction.bankNote);
        //  - a category cleared on purpose, so the self-heal leaves it cleared.
        const moved = g.date >= '2000-01-01' && (!!g.dateMoved || (g.posted ? g.posted !== g.date : dayGap(g.date, anchor) > 3))
        const typedNote = g.bankNote !== undefined && g.note !== g.bankNote
        const carry: Partial<Transaction> = {
          categoryId: g.categoryId,
          deleted: hidden,
          manual: true,
          // The posted row's own day stays beside the moved one, as on any row,
          // and the move stays marked (a hold re-issued under a new id while
          // still pending is never re-dated off it).
          ...(moved ? { date: g.date, posted: best.posted ?? best.date, dateMoved: true } : {}),
          ...(typedNote ? { note: g.note } : {}),
          ...(g.uncategorized ? { uncategorized: true } : {}),
        }
        Object.assign(best, carry)
        const ex = existingByUid.get(best.uid!)
        if (ex) {
          const bank = { amount: best.amount, type: best.type, pending: best.pending }
          await db.transactions.update(ex.id!, { ...carry, ...bank, updatedAt: now })
          Object.assign(ex, carry, bank)
        }
      }
      // pending:false retires it for good: it can never be matched again. With
      // no successor and no hide of the user's, it is marked retiredPin
      // (synced, column retired_pin): the bank may only have left it out of
      // one answer, and if it lists the same id again the charge comes back
      // below, on whichever device sees that. Unmarked, it read as the user's
      // hide and the charge was gone from spending for good.
      const retiredPin = !best && !hidden
      // `retired` (synced) on every one, successor or not: the row keeps its
      // pin, and a pinned tombstone otherwise reads as the user's Delete, so
      // Activity › Removed and "unhide" offered it back to count twice.
      await db.transactions.update(g.id!, { deleted: true, pending: false, retired: true, ...(retiredPin ? { retiredPin } : {}), updatedAt: now })
    }

    const toAdd: Transaction[] = []
    for (const [uid, row] of desired) {
      const ex = existingByUid.get(uid)
      // A row the bank still sends undated keeps the day it was first stored.
      // Compared as such too: against today's date it was rewritten (and pushed)
      // at every sync while the bank kept it undated.
      const date = ex && undated.has(uid.slice(3)) ? ex.date : row.date
      if (!ex) {
        toAdd.push(row)
        added++
      } else if (ex.deleted && ex.retiredPin) {
        // A pinned pending charge retired above when the bank left it out, now
        // listed again under its id: back, as the pin would have kept it had
        // there been no gap (the user's category, date and note; the bank's
        // amount and pending state).
        await db.transactions.update(ex.id!, {
          deleted: false, retiredPin: false, retired: false, manual: true, amount: row.amount, pending: row.pending, updatedAt: now,
        })
        added++
      } else if (ex.deleted && !ex.manual) {
        // Manually-excluded rows stay excluded — the bank can't resurrect them.
        await db.transactions.update(ex.id!, {
          deleted: false, categoryId: row.categoryId, amount: row.amount, type: row.type, date: row.date,
          pending: row.pending, updatedAt: now,
        })
        added++
      } else if (
        !ex.manual &&
        (ex.categoryId !== row.categoryId || ex.type !== row.type ||
          ex.amount !== row.amount || ex.date !== date ||
          !!ex.pending !== !!row.pending)
      ) {
        // Row already present but our classification improved — re-apply it so a
        // re-sync fully re-categorizes existing transactions in place. Rows the
        // user edited by hand (`manual`) are pinned: the bank never overwrites them.
        await db.transactions.update(ex.id!, {
          categoryId: row.categoryId, amount: row.amount, type: row.type, date,
          pending: row.pending, updatedAt: now,
        })
      } else if (ex.manual && !(ex.deleted && ex.retired) && (!!ex.pending !== !!row.pending || (!!ex.pending && ex.amount !== row.amount))) {
        // A pin guards what the user edited. Pending is the bank's state, never
        // theirs, and so is a pending charge's amount until it posts: a row
        // pinned while pending used to read 'Pending' for good after it posted,
        // and keep the authorised amount instead of the final one. A row the
        // bank retired (it posted under a new id, or the hold was dropped) is
        // left alone: flipped back to pending while still a tombstone, it was
        // read as the user's hide when the hold posted, and hid the charge.
        await db.transactions.update(ex.id!, { pending: row.pending, ...(ex.pending ? { amount: row.amount } : {}), updatedAt: now })
      }
      // A tombstone the bank retired (banks.ts ghost pass) is left as it is.
      const bankRetired = !!ex?.deleted && !!ex.retired && !ex.retiredPin
      // The bank's own day beside a stored date that is another (rent dated
      // the 1st, here or filed into Rent by hand on another device), for a
      // move out of Rent to put back. Local only: no updatedAt, so no push.
      // Once kept, and on every pending row, it follows the bank's day.
      if (ex && !undated.has(uid.slice(3))) {
        const bankDay = row.posted ?? row.date
        const stored = ex.manual || (ex.deleted && ex.retiredPin) ? ex.date : date
        // So does the date of a pinned hold no one moved: a hold's day is the
        // bank's until it posts, and it may re-date one as it settles or post
        // it under the same id a day or two on. Left on the old day, the date
        // read as the user's move, and the charge posted under a new id was
        // pinned there, a month early across a month end. Unmoved means not
        // marked as set (Transaction.dateMoved) and still on the day the app
        // gives the bank's last one: that day, or for a payment in Rent the
        // 1st it pays for (bankRules.rentDate). A row an earlier version
        // stored kept no bank's day: unmoved within 3 days of when it was
        // imported, as the posting carry always read it (above). Pushed, as
        // the bank's amount on a pinned hold is, so every device reads it the
        // same way.
        const hold = (!!ex.pending && !bankRetired) || (!!ex.deleted && !!ex.retiredPin)
        const inRent = ex.type === 'expense' && ex.amount > 0 && ex.categoryId != null && rentIds.has(ex.categoryId)
        const dayFor = (d: string) => (inRent ? rentDate(d) : d)
        const imported = ex.createdAt ? new Date(ex.createdAt).toISOString().slice(0, 10) : ex.date
        const unmoved = !ex.dateMoved && ex.date >= '2000-01-01' &&
          (ex.posted !== undefined ? ex.date === dayFor(ex.posted) : dayGap(ex.date, imported) <= 3)
        if (ex.manual && hold && unmoved && ex.posted !== bankDay) {
          const to = dayFor(bankDay)
          await db.transactions.update(ex.id!, { posted: bankDay, ...(to !== ex.date ? { date: to, updatedAt: now } : {}) })
        } else if (ex.posted !== bankDay && (stored !== bankDay || ex.posted !== undefined || row.pending)) {
          await db.transactions.update(ex.id!, { posted: bankDay })
        }
      }
      // The bank's words for a pending row stored before they were kept: a
      // pinned row's own note may be the user's, so the bank's are read from
      // the feed. Local only, as above.
      if (ex && row.pending && ex.bankNote === undefined) {
        await db.transactions.update(ex.id!, { bankNote: ex.manual ? row.note : ex.note })
      } else if (ex && ex.bankNote !== undefined && !bankRetired && row.note && row.note !== ex.bankNote) {
        // A note still in the bank's words follows them: a pending stand-in
        // ('Debit') stayed for good after the row posted under the same id
        // with the merchant's name. A note the user typed stays theirs. One
        // already in the new words (another device's sync, pulled) only takes
        // them as the bank's, locally.
        if (ex.note === ex.bankNote) await db.transactions.update(ex.id!, { note: row.note, bankNote: row.note, updatedAt: now })
        else if (ex.note === row.note) await db.transactions.update(ex.id!, { bankNote: row.note })
      }
    }
    if (toAdd.length) await db.transactions.bulkAdd(toAdd)
  })
  return added
}

/** Before this, a posting time is a missing date (0, null), not a real posting. */
const MIN_POSTED = Date.UTC(2000, 0, 1) / 1000

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000

/** Words a bank adds to any charge's description, which say nothing of the merchant. */
const NOTE_FILLER = new Set([
  'pos', 'purchase', 'debit', 'credit', 'card', 'pending', 'ach', 'the', 'and', 'payment', 'www', 'com', 'net', 'inc',
  'llc', 'ref', 'online', 'recurring', 'visa', 'mastercard', 'auth', 'authorization', 'preauth', 'checkcard', 'check',
  'transaction', 'trans', 'des', 'web', 'ppd', 'ccd', 'paypal', 'tst', 'store', 'san', 'francisco', 'new', 'york',
])
/** The merchant words of a description: its first two of 3+ letters, filler left out
 *  (the place names banks append would match two different shops in one city). */
function noteWords(note: string | undefined): Set<string> {
  const words = (note ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w) && !NOTE_FILLER.has(w))
  return new Set(words.slice(0, 2))
}

/**
 * The earliest day a stored row may have posted. Rent paid from the
 * RENT_EARLY_FROM_DAY on is stored on the next 1st (rentDate), so a row on a
 * 1st may have posted that day of the month before. The reconcile compared the
 * stored 1st with the feed's window, so rent left the feed while its 1st was
 * still inside it, and was tombstoned for good about 90 days after payment.
 */
function earliestPosted(iso: string): string {
  if (!iso.endsWith('-01')) return iso
  const [y, m] = iso.split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}-${String(RENT_EARLY_FROM_DAY).padStart(2, '0')}`
}

/**
 * Self-heal: file any uncategorised transaction using the same rules the bank
 * sync uses.
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
  const liveKind = new Map(cats.map((c) => [c.id!, c.kind]))

  // NOTE: `manual` rows are included on purpose. That flag means "the user chose
  // this, don't let the bank overwrite it" — but an EMPTY category was never a
  // choice, so filling one in destroys nothing. Excluding them left the largest
  // orphan of all (a pinned rent charge) permanently uncategorised. The one
  // exception is a category the user cleared on purpose (`uncategorized`): that
  // was a choice, and re-filing it undid the edit at the next focus.
  // A row on a category that is no longer live (another device deleted it) is
  // as unfiled as an empty one: it counted in no budget row.
  const orphans = await db.transactions
    .filter((t) => !t.deleted && !t.uncategorized && (t.categoryId == null || !liveKind.has(t.categoryId)))
    .toArray()
  if (orphans.length === 0) return 0

  // A rule naming a renamed or deleted category: go where most rows of that
  // rule sit now (bank-filed rows, of the same kind), as the bank sync does.
  let aliases: Map<string, number> | null = null
  const aliasFor = async (key: string) => {
    if (!aliases) {
      const votes = new Map<string, Map<number, number>>()
      const filed = await db.transactions
        .filter((t) => !t.deleted && !t.manual && t.categoryId != null && liveKind.get(t.categoryId) === t.type)
        .toArray()
      for (const t of filed) {
        const guess = categorize({ description: t.note, payee: t.note, kind: t.type })
        if (!guess || findCategoryFor(guess, t.type, cats)) continue
        const k = `${t.type}|${guess.trim().toLowerCase()}`
        const v = votes.get(k) ?? new Map<number, number>()
        v.set(t.categoryId!, (v.get(t.categoryId!) ?? 0) + 1)
        votes.set(k, v)
      }
      aliases = new Map([...votes].map(([k, v]) => [k, [...v].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]]))
    }
    return aliases.get(key)
  }

  const now = Date.now()
  let fixed = 0
  for (const t of orphans) {
    const guess = categorize({ description: t.note, payee: t.note, kind: t.type })
    if (!guess) continue
    const cat = findCategoryFor(guess, t.type, cats)
    const id = cat?.id ?? (await aliasFor(`${t.type}|${guess.trim().toLowerCase()}`))
    if (id == null) continue
    // Filed as Rent, a bank payment moves to the 1st it pays for, exactly as
    // the bank sync would have dated it, its posted day kept (bankRules.rentRefile).
    const move = cat ? rentRefile(t, false, isRentCategory(cat)) : null
    await db.transactions.update(t.id!, { categoryId: id, ...(move ?? {}), updatedAt: now })
    fixed++
  }
  return fixed
}

/** What a connector run did. `total` counts live ACCOUNTS (not transactions). */
export interface ConnectorResult {
  total: number
  errors: string[]
  /** A connection SimpleFIN could not refresh this time: shown, not fatal. */
  warnings: string[]
  /** The bank pair was not due (its 6-hour floor), not that it failed. */
  bankSkipped?: boolean
  /** Bank accounts shown, and ones the user removed that stay hidden. */
  bank?: { shown: number; removed: number }
  /** The errors of the bank pair alone (not the brokerage's), for the bank's own notes. */
  bankErrors: string[]
}

/**
 * Refresh every connector — brokerage balances, bank balances, and real
 * transactions — independently. Transaction-sync failures are non-blocking.
 */
let syncInFlight: Promise<ConnectorResult> | null = null

/** Coalesces overlapping callers (boot timer, focus, 4-minute interval, Accounts
 *  mount) onto one run. Two concurrent runs each saw an empty table and both
 *  inserted, duplicating every bank transaction and account. */
export function syncAllConnectors(opts: { force?: boolean } = {}): Promise<ConnectorResult> {
  if (syncInFlight) return syncInFlight
  syncInFlight = runAllConnectors(opts.force ?? false)
    .then((res) => {
      // Not a failed run (nothing synced and errors): tell the screens, so an
      // error one of them shows from an earlier run can go.
      if (!(res.total === 0 && res.errors.length > 0)) {
        const at = Date.now()
        connectorOkListeners.forEach((l) => l(at))
      }
      return res
    })
    .finally(() => { syncInFlight = null })
  return syncInFlight
}

// ---- Successful connector runs ------------------------------------------------
// Every run goes through syncAllConnectors (App's boot, focus and interval
// pulls, the sign-in pull, Accounts' auto refresh and its manual taps), so a
// screen hears about a success it did not start itself.
const connectorOkListeners = new Set<(okAt: number) => void>()

/** Called with the time of each connector run that did not fail. */
export function subscribeConnectorSync(l: (okAt: number) => void): () => void {
  connectorOkListeners.add(l)
  return () => {
    connectorOkListeners.delete(l)
  }
}

/**
 * Link a bank from a SimpleFIN setup token, then fetch it at once, balances and
 * transactions, whatever the 6-hour floor says. Reconnecting an expired bank
 * used to fetch balances only, and the floor its failed fetch had set then kept
 * its transactions away for hours.
 */
export async function connectBank(setupToken: string): Promise<{ shown: number; removed: number; errors: string[] }> {
  await claimBank(setupToken)
  let res = await syncAllConnectors({ force: true })
  // A run already in flight absorbs the call and may skip the bank on its floor.
  if (res.bankSkipped) res = await syncAllConnectors({ force: true })
  // The bank's own errors only: a brokerage failing in the same run is not this
  // connection's problem ('Bank connected. Failed to send a request…').
  return { shown: res.bank?.shown ?? 0, removed: res.bank?.removed ?? 0, errors: res.bankErrors }
}

async function hasSession(): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    return !!data.session
  } catch {
    return false
  }
}

async function runAllConnectors(force: boolean): Promise<ConnectorResult> {
  // The user's own categorization rules live in the cloud (merchant_rules).
  // Until a copy exists on this device (fetched now, or cached from an earlier
  // run), every automatic re-filing waits: a fresh device would otherwise file
  // those merchants by the built-in rules alone and push that over the cloud.
  const rulesOk = (await loadMerchantRules().catch(() => false)) || userRulesReady()
  // Device sync FIRST: pull the cloud's truth (incl. `manual` pins and moved
  // dates) into Dexie before the bank overlay runs. Without this ordering, a
  // fresh boot ran the bank reconcile against pin-unaware local rows, re-dated
  // them from raw bank data, and pushed that over the user's edits. A pull that
  // FAILED leaves this device behind the cloud, so the bank pair waits for the
  // next run: on a fresh device its rows went up raw over the cloud's pins and
  // hides.
  const pull = await syncNow().catch((): SyncResult => 'failed')
  const pulled = pull !== 'failed'
  // Repair anything the pull could not fix on its own, then let the debounced
  // push carry the result back up.
  if (rulesOk && pulled) await recategorizeUncategorized().catch(() => {})
  // Brokerage has its own quota and is cheap; the BANK pair is the rate-limited
  // one, so it alone is gated behind the interval. It runs only when it can
  // work: signed in, online, after a good pull, with the rules in hand. A run
  // that could not is not counted against the floor, so the next one fetches.
  const signedIn = await hasSession()
  const online = typeof navigator === 'undefined' || navigator.onLine !== false
  const bankDue = bankFetchDue(force)
  const doBank = bankDue && signedIn && online && pulled && rulesOk
  const before = readTime(ATTEMPT_KEY)
  if (doBank) writeTime(ATTEMPT_KEY, Date.now()) // marked first, so an overlapping run cannot fetch too
  // Both bank fetches go out together; the transaction sync reads the stored
  // accounts only once the balance sync has written them (syncBankTransactions).
  const balances = doBank ? syncBankAccounts() : Promise.resolve(null)
  const [broker, bank, tx] = await Promise.allSettled([
    syncBrokerages(),
    balances,
    doBank ? syncBankTransactions(undefined, { after: balances }) : Promise.resolve(0),
  ])
  // Only a fetch that reached SimpleFIN counts (a refusal like 403 included:
  // it still spent the budget). Offline or unauthorised, it never got there.
  if (doBank && !reachedSimplefin(bank) && !reachedSimplefin(tx)) writeTime(ATTEMPT_KEY, before)
  let total = 0
  const errors: string[] = []
  const bankErrors: string[] = []
  const reason = (r: PromiseRejectedResult) => (r.reason instanceof Error ? r.reason.message : 'Could not refresh. Try again.')
  if (broker.status === 'fulfilled') total += broker.value || 0
  else errors.push(reason(broker))
  if (bank.status === 'fulfilled') total += bank.value?.shown ?? 0
  else {
    errors.push(reason(bank))
    bankErrors.push(reason(bank))
  }
  if (tx.status === 'rejected') {
    if (total === 0 && errors.length === 0) errors.push(reason(tx))
    bankErrors.push(reason(tx))
  }
  if (bankDue && !doBank && banksEnabled) {
    const why = !signedIn
      ? 'Sign in to Tally in Settings first.'
      : online && !pulled
        ? 'Could not reach your Tally data. Bank transactions will refresh on the next sync.'
        : null
    if (why) {
      errors.push(why)
      bankErrors.push(why)
    }
  }
  return {
    total,
    errors: [...new Set(errors)],
    bankErrors: [...new Set(bankErrors)],
    warnings: doBank && bank.status === 'fulfilled' ? bankWarnings : [],
    bankSkipped: !bankDue,
    bank: bank.status === 'fulfilled' && bank.value ? bank.value : undefined,
  }
}
