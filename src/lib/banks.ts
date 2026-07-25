import { applySyncedAccounts, syncBrokerages, type SyncedAccount } from './brokerage'
import { categorize } from './categorize'
import { db, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'
import { syncNow } from '../sync/sync'

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
    if (detail === 'unauthorized') throw new Error('Sign in to sync — tap the cloud icon, top-right.')
    throw new Error(detail || error.message || 'Request failed')
  }
  if (data && data.ok === false) throw new Error(data.error || 'Request failed')
  return data as T
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

// Money-movement that must NOT count as spending or income: internal transfers,
// card payments, investment funding (Robinhood/Webull/brokerages), and bank
// reversals (returned/declined). Zelle is handled separately (account-aware).
const EXCLUDE_RE = /\btransfer\b|autopay|auto ?pay|online (payment|pmt|banking)|card ?payment|\bcredit card\b|payment thank ?you|\bpymt\b|\bxfer\b|web ?xfr|e-?transfer|bill ?pay|e-?payment|\bach\b.*(pmt|payment|debit|credit)|\bwire\b|to (savings|checking)|from (savings|checking)|balance ?payment|statement ?credit|\brobinhood\b|\bwebull\b|interactive ?brokers|\bschwab\b|\bfidelity\b|\bcoinbase\b|\bvanguard\b|\bbetterment\b|\bacorns\b|brokerage|returned ?check|declin|amex ?send|sav (incr|decr)ease int/i

interface SyncedTx {
  sourceTxId: string
  account: string
  tier: string
  posted: number
  amount: number
  description: string
  payee: string
  memo: string
  mcc: string | null
}

function isoFromUnix(sec: number): string {
  // UTC components, not local: banks stamp postings at UTC midnight-ish, so a
  // local-time conversion in any UTC-negative timezone (e.g. Pacific) shifted
  // every transaction one day EARLY — breaking month boundaries and footing.
  const d = new Date((Number(sec) || 0) * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Detect internal transfers / card payments: a debit on one account that pairs
 * with a credit of the SAME amount on ANOTHER account within ~5 days. That's
 * money moving between your own accounts (incl. paying a card), which must never
 * count as spend or income. Returns the set of transfer sourceTxIds.
 */
function detectTransferIds(txs: SyncedTx[]): Set<string> {
  const ids = new Set<string>()
  const byAmt = new Map<number, SyncedTx[]>()
  for (const t of txs) {
    const cents = Math.round(Math.abs(Number(t.amount)) * 100)
    if (!cents) continue
    const list = byAmt.get(cents)
    if (list) list.push(t)
    else byAmt.set(cents, [t])
  }
  for (const group of byAmt.values()) {
    if (group.length < 2) continue
    const used = new Set<number>()
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue
        const a = group[i]
        const b = group[j]
        const opposite = Math.sign(Number(a.amount)) !== Math.sign(Number(b.amount))
        const near = Math.abs((Number(a.posted) || 0) - (Number(b.posted) || 0)) <= 5 * 86400
        if (opposite && a.account !== b.account && near) {
          ids.add(a.sourceTxId)
          ids.add(b.sourceTxId)
          used.add(i)
          used.add(j)
          break
        }
      }
    }
  }
  return ids
}

/**
 * Pull real transactions from the linked banks/cards and reconcile them into the
 * transactions table, so the budget runs on ACTUAL spending. Excludes internal
 * transfers / card-payments (matched debit↔credit across accounts + keyword
 * fallback). Reconciles: rows now classified as transfers are removed, so
 * re-syncing corrects earlier over-counts. Idempotent (uid = sf:<tx id>).
 */
export async function syncBankTransactions(days = 120): Promise<number> {
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
    const amt = Number(t.amount)
    if (!Number.isFinite(amt) || amt === 0) continue
    const text = [t.payee, t.description, t.memo].filter(Boolean).join(' ')
    const acct = t.account || ''

    // Exclude money-movement so it never counts as spend/income:
    //  - debit↔credit pairs matched across your accounts (detectTransferIds)
    //  - keyword transfers / card payments / investment moves / reversals
    //  - Zelle OUT OF a savings/money-market account (large self-transfers);
    //    Zelle out of checking is kept as spending (you paying people).
    if (transferIds.has(t.sourceTxId) || EXCLUDE_RE.test(text)) continue
    if (/\bzelle\b/i.test(text) && /money ?market|savings|hysa|high ?yield/i.test(acct)) continue

    let type: 'expense' | 'income'
    if (t.tier === 'credit') {
      if (amt < 0) type = 'expense'
      else continue // a positive amount on a card is a payment/credit — skip
    } else {
      type = amt < 0 ? 'expense' : 'income'
    }

    let name = categorize({ description: t.description, payee: t.payee, memo: t.memo, mcc: t.mcc, kind: type })
    if (type === 'income' && !name) name = 'Other income'
    // Guard: never file an expense under an income category (or vice versa),
    // even if a keyword slips through — that inversion is what broke the footing.
    const cat = name
      ? catsByName.get(name.toLowerCase())?.find((c) => (c.kind === 'income') === (type === 'income'))
      : undefined
    const categoryId = cat ? cat.id : null

    const uid = `sf:${t.sourceTxId}`
    desired.set(uid, {
      uid,
      date: isoFromUnix(t.posted),
      amount: Math.round(Math.abs(amt) * 100) / 100,
      type,
      categoryId,
      account: acct,
      note: t.payee || t.description || '',
      createdAt: now,
      updatedAt: now,
    } as Transaction)
  }

  // Reconcile existing synced (sf:) rows to match `desired`.
  const existing = await db.transactions.filter((t) => (t.uid ?? '').startsWith('sf:')).toArray()
  const existingByUid = new Map(existing.map((t) => [t.uid!, t]))
  let added = 0
  await db.transaction('rw', db.transactions, async () => {
    for (const t of existing) {
      if (t.uid && !t.deleted && !t.manual && !desired.has(t.uid)) {
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
          ex.amount !== row.amount || ex.date !== row.date)
      ) {
        // Row already present but our classification improved — re-apply it so a
        // re-sync fully re-categorizes existing transactions in place. Rows the
        // user edited by hand (`manual`) are pinned: the bank never overwrites them.
        await db.transactions.update(ex.id!, {
          categoryId: row.categoryId, amount: row.amount, type: row.type, date: row.date, updatedAt: now,
        })
      }
    }
    if (toAdd.length) await db.transactions.bulkAdd(toAdd)
  })
  return added
}

/**
 * Refresh every connector — brokerage balances, bank balances, and real
 * transactions — independently. `total` counts live ACCOUNTS (not transactions);
 * transaction-sync failures are non-blocking.
 */
export async function syncAllConnectors(): Promise<{ total: number; errors: string[] }> {
  // Device sync FIRST: pull the cloud's truth (incl. `manual` pins and moved
  // dates) into Dexie before the bank overlay runs. Without this ordering, a
  // fresh boot ran the bank reconcile against pin-unaware local rows, re-dated
  // them from raw bank data, and pushed that over the user's edits.
  await syncNow().catch(() => {})
  const [broker, bank, tx] = await Promise.allSettled([
    syncBrokerages(),
    syncBanks(),
    syncBankTransactions(),
  ])
  let total = 0
  const errors: string[] = []
  for (const r of [broker, bank]) {
    if (r.status === 'fulfilled') total += r.value || 0
    else errors.push(r.reason instanceof Error ? r.reason.message : 'Sync failed')
  }
  if (tx.status === 'rejected' && total === 0 && errors.length === 0) {
    errors.push(tx.reason instanceof Error ? tx.reason.message : 'Sync failed')
  }
  return { total, errors }
}
