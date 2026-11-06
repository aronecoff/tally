import type { SyncedAccount } from './accountMerge'
import type { AccountType } from '../db/db'
import type { SyncedTx } from './bankRules'

/**
 * What a SimpleFIN answer means in this app's terms, with no I/O: the account
 * tiers, the card sign clamp and the row mapping.
 *
 * supabase/functions/simplefin/index.ts holds the same code for the personal
 * build, which reads SimpleFIN on the server. That function is deployed on its
 * own, so it cannot import this file. simplefinNormalize.test.ts compares the two:
 * the tier functions line for line, because a table of names would miss a new
 * keyword, and the rest by their answers over a table of invented accounts. It
 * cannot see past that table, so change them together.
 */

export interface SimplefinTransaction {
  id?: unknown
  posted?: number | null
  transacted_at?: number | null
  pending?: boolean
  amount?: unknown
  description?: string | null
  payee?: string | null
  memo?: string | null
  mcc?: string | null
}

export interface SimplefinAccount {
  id?: unknown
  name?: string | null
  currency?: string | null
  balance?: unknown
  'available-balance'?: unknown
  org?: { domain?: string | null; name?: string | null } | null
  transactions?: SimplefinTransaction[] | null
}

/** A `GET /accounts` answer. */
export interface SimplefinSet {
  accounts?: SimplefinAccount[] | null
  errors?: unknown[] | null
  errlist?: { msg?: unknown }[] | null
}

const pick = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v)

// SimpleFIN gives no account-type field, so infer. Order matters: classify by
// product-type NAME first so a positive-balance deposit account (e.g. "Discover
// Online Savings", "Debit Card", or an overdrawn "Total Checking") is never
// inverted into a liability. Ambiguous brand/bare tokens ("card", "discover",
// bare "credit") are deliberately excluded: only unambiguous liability names
// count. Balance sign is the LAST resort to flag an otherwise-unlabeled,
// genuinely-owed account as credit.
export function inferTier(name: unknown, num: number): AccountType {
  const n = String(name ?? '').toLowerCase()
  if (/\b(?:401|403|457)(?:\s*\(?[kb]\)?|\b)|\bira\b|roth|retire|pension|rrsp|\bsep\b/.test(n)) return 'retirement'
  if (/\bhsa\b|health ?savings/.test(n)) return 'benefit'
  if (/check|chequing|saving|money ?market|\bcd\b|certificate|deposit|debit|cash management|\bhysa\b|\bckg\b|\bchk\b|\bdda\b/.test(n)) return 'cash'
  if (/brokerage|invest|securities|\bindividual\b|margin/.test(n)) return 'brokerage'
  if (/credit card|line of credit|\bloc\b|\bloan\b|mortgage|\bvisa\b|master ?card|\bamex\b|american express|\bsapphire\b|\bfreedom\b|gold card|platinum card/.test(n)) return 'credit'
  if (Number.isFinite(num) && num < 0) return 'credit'
  return 'cash'
}

// FROZEN copy of inferTier as it shipped before Oct 2026, which decides only the
// owed clamp below. Whether a positive card balance means owed or in your favour
// is unsettled (SimpleFIN does not define the sign).
function legacyInferTier(name: unknown, num: number): AccountType {
  const n = String(name ?? '').toLowerCase()
  if (/401|403|457|\bira\b|roth|retire|pension|rrsp|\bsep\b/.test(n)) return 'retirement'
  if (/brokerage|invest|securities|\bindividual\b|margin|\bhsa\b/.test(n)) return 'brokerage'
  if (/check|chequing|saving|money ?market|\bcd\b|certificate|deposit|debit|cash management|\bhysa\b/.test(n)) return 'cash'
  if (/credit card|line of credit|\bloc\b|\bloan\b|mortgage|\bvisa\b|master ?card|\bamex\b/.test(n)) return 'credit'
  if (Number.isFinite(num) && num < 0) return 'credit'
  return 'cash'
}

/** One account as the `sync` action reports it. */
export function normalize(a: SimplefinAccount): SyncedAccount {
  const org = a?.org ?? {}
  const balRaw = pick(a?.balance) ?? pick(a?.['available-balance'])
  const num = balRaw == null ? NaN : Number(balRaw)
  const tier = inferTier(a?.name, num)
  // Assets are stored positive, credit as the positive amount OWED (the client
  // flips it). SimpleFIN credit balances may be signed either way, so clamp to
  // owed, but only where the pre-Oct-2026 rules did (legacyInferTier above).
  const clamp = legacyInferTier(a?.name, num) === 'credit'
  const balance = Number.isNaN(num) ? null : clamp ? -Math.abs(num) : num
  return {
    sourceAccountId: `${org.domain || org.name || 'sf'}:${a?.id}`,
    institution: org.name || org.domain || 'Bank',
    name: a?.name || 'Account',
    tier,
    balance,
    currency: a?.currency || 'USD',
  }
}

/** Every row of an answer as the `transactions` action reports them, and every
 *  account that answered, rows or not: a dropped hold on a card that answered
 *  with no rows at all is retired by that. */
export function transactionsOf(data: SimplefinSet): { transactions: SyncedTx[]; accounts: string[] } {
  const transactions: SyncedTx[] = []
  const accounts: string[] = []
  for (const a of data?.accounts ?? []) {
    const balNum = Number(pick(a?.balance) ?? pick(a?.['available-balance']))
    const tier = inferTier(a?.name, balNum)
    const org = a?.org ?? {}
    const account = `${org.name || org.domain || 'Bank'} ${a?.name || ''}`.trim()
    // The same key `normalize` gives the account, so the app can read each row
    // by the account's remembered tier, and the account's own name for when it
    // has none stored yet (`account` also carries the institution).
    const sourceAccountId = `${org.domain || org.name || 'sf'}:${a?.id}`
    accounts.push(account)
    for (const t of a?.transactions ?? []) {
      transactions.push({
        sourceTxId: `${org.domain || 'sf'}:${a?.id}:${t?.id}`,
        sourceAccountId,
        accountName: a?.name || '',
        account,
        tier,
        // A pending row may carry posted 0 (allowed by SimpleFIN): that is no
        // date, not 1970. `||` skips it; the app dates such a row today.
        posted: (t?.transacted_at || t?.posted || null) as number,
        pending: !!t?.pending,
        amount: Number(t?.amount),
        description: t?.description || t?.payee || '',
        payee: t?.payee || '',
        memo: t?.memo || '',
        mcc: t?.mcc || null,
      })
    }
  }
  return { transactions, accounts }
}
