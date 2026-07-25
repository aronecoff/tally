import { db, type Account, type AccountType } from '../db/db'
import { supabase } from '../db/supabase'

/** One account as returned by the `snaptrade` Edge Function `sync` action. */
export interface SyncedAccount {
  sourceAccountId: string
  institution: string
  name: string
  tier: AccountType
  /** SnapTrade-signed total (credit / line-of-credit is negative when owed). */
  balance: number | null
  currency: string
}

/** Brokerage connect/sync is only possible when Supabase is configured. */
export const brokerageEnabled = !!supabase

async function invoke<T>(action: string): Promise<T> {
  if (!supabase) throw new Error('Sync is not configured.')
  // functions.invoke attaches the apikey + the signed-in user's JWT
  // automatically — that JWT is what the backend gate checks.
  const { data, error } = await supabase.functions.invoke('snaptrade', { body: { action } })
  if (error) {
    // Non-2xx surfaces as FunctionsHttpError; the real body is on error.context.
    let detail: string | undefined
    try {
      const ctx = (error as { context?: Response }).context
      detail = (await ctx?.json?.())?.error
    } catch {
      /* fall back to the generic message */
    }
    // The backend is gated to the signed-in owner; guide instead of "unauthorized".
    if (detail === 'unauthorized') {
      throw new Error('Sign in to sync — tap the cloud icon, top-right.')
    }
    throw new Error(detail || error.message || 'Request failed')
  }
  if (data && data.ok === false) throw new Error(data.error || 'Request failed')
  return data as T
}

/** Ask the backend for a SnapTrade connection-portal URL to link a brokerage. */
export async function connectBrokerage(): Promise<string> {
  const data = await invoke<{ ok: boolean; redirectURI: string }>('connect')
  if (!data.redirectURI) throw new Error('No connection URL returned')
  return data.redirectURI
}

/** Pull live brokerage accounts and merge them into the local accounts table. */
export async function syncBrokerages(): Promise<number> {
  const data = await invoke<{ ok: boolean; accounts: SyncedAccount[] }>('sync')
  const incoming = (data.accounts ?? []).filter((a) => a.sourceAccountId)
  await applySyncedAccounts(incoming, 'snaptrade')
  return incoming.length
}

/** Drop a redundant leading institution name and tidy IRA casing. */
function cleanName(institution: string, name: string): string {
  let n = (name ?? '').trim()
  const inst = (institution ?? '').trim()
  if (inst && n.toLowerCase().startsWith(inst.toLowerCase())) n = n.slice(inst.length).trim()
  n = n.replace(/\bira\b/gi, 'IRA')
  return n || 'Account'
}

// Canonicalize an institution name so SnapTrade's free-form label matches the
// hand-typed seed shell — e.g. "Charles Schwab" ~ "Schwab", "American Express"
// ~ "Amex", "Citizens Bank" ~ "Citizens", "Robinhood Securities" ~ "Robinhood".
const INST_ALIASES: Record<string, string> = {
  'american express': 'amex',
  'charles schwab': 'schwab',
  'citizens bank': 'citizens',
  'robinhood markets': 'robinhood',
  'robinhood securities': 'robinhood',
  'webull financial': 'webull',
}
const INST_SUFFIX = /\b(securities|markets|brokerage|bank|financial|investments?|advisors?|llc|inc|na|corp|co|company|group)\b/g
function canonInstitution(s: string): string {
  let c = (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (INST_ALIASES[c]) return INST_ALIASES[c]
  c = c.replace(INST_SUFFIX, ' ').replace(/\s+/g, ' ').trim()
  return INST_ALIASES[c] ?? c
}
function institutionsMatch(a: string, b: string): boolean {
  const ca = canonInstitution(a)
  const cb = canonInstitution(b)
  if (!ca || !cb) return false
  if (ca === cb) return true
  // Word-level containment for leftover cases ("charles schwab" ⊇ "schwab").
  const wa = ca.split(' ')
  const wb = cb.split(' ')
  return (ca.length >= 4 && wb.includes(ca)) || (cb.length >= 4 && wa.includes(cb))
}

/**
 * Merge a provider's live accounts into Dexie, in priority order per account:
 *   1. a row already linked by `sourceAccountId` → update in place (re-sync);
 *      a user-removed (deleted) row is respected, not resurrected.
 *   2. an unclaimed manual shell, same canonical institution + tier → claim it
 *   3. otherwise → create a new live row
 * Then reconcile: any previously-live row OF THIS SOURCE whose account is no
 * longer reported (closed/unlinked) is archived so it stops counting; it
 * revives on return. Reconciliation is scoped to `source` so syncing one
 * connector never archives another connector's accounts.
 *
 * Credit / line-of-credit balances arrive negative-when-owed; Tally stores the
 * `credit` tier as the positive amount OWED, so the sign is flipped there.
 * Idempotent: re-running matches on `sourceAccountId`, so nothing duplicates.
 */
export async function applySyncedAccounts(incoming: SyncedAccount[], source = 'snaptrade'): Promise<void> {
  if (!incoming.length) return
  await db.transaction('rw', db.accounts, async () => {
    const all = await db.accounts.toArray()
    const now = Date.now()
    const claimed = new Set<number>()
    const seen = new Set<string>()
    let maxOrder = all.reduce((m, a) => Math.max(m, a.sortOrder), -1)

    for (const inc of incoming) {
      // Mark present FIRST: an account the provider still reports but whose
      // balance is momentarily unavailable (a transient balances-fetch failure
      // surfaces as null) must not be archived as if it had disappeared — keep
      // its last known balance and skip the update.
      seen.add(inc.sourceAccountId)
      if (inc.balance == null || Number.isNaN(inc.balance)) continue
      const tier = inc.tier
      const balance = tier === 'credit' ? -inc.balance : inc.balance
      const institution = (inc.institution ?? '').trim() || 'Brokerage'
      const name = cleanName(institution, inc.name)

      // 1) a row already linked to this provider account (incl. tombstoned/archived)
      const existing = all.find((a) => a.sourceAccountId === inc.sourceAccountId)
      if (existing?.id != null) {
        // Honor an explicit user removal — don't bring a deleted account back.
        if (existing.deleted) continue
        await db.accounts.update(existing.id, {
          institution, name, type: tier, balance, liveSync: true, source,
          archived: false, lastUpdated: now, updatedAt: now,
        })
        continue
      }

      // 2) claim a manual shell of the same canonical institution + tier
      const shell = all.find(
        (a) =>
          a.id != null &&
          !a.deleted &&
          !a.liveSync &&
          !a.sourceAccountId &&
          a.type === tier &&
          !claimed.has(a.id) &&
          institutionsMatch(a.institution, institution),
      )
      if (shell?.id != null) {
        claimed.add(shell.id)
        await db.accounts.update(shell.id, {
          sourceAccountId: inc.sourceAccountId, institution, name, type: tier, source,
          balance, liveSync: true, archived: false, lastUpdated: now, updatedAt: now,
        })
        continue
      }

      // 3) brand-new live account
      maxOrder += 1
      await db.accounts.add({
        institution, name, type: tier, balance, liveSync: true, source,
        sourceAccountId: inc.sourceAccountId, lastUpdated: now, sortOrder: maxOrder, updatedAt: now,
      } as Account)
    }

    // Reconcile WITHIN this source: a live account no longer reported by the
    // provider (closed or unlinked) is archived (reversible) so it drops out of
    // net worth. It revives via step 1 if it reappears in a later sync. Scoped
    // to `source` so a Teller sync never archives a SnapTrade row, or vice-versa.
    for (const a of all) {
      if (
        a.id != null &&
        a.liveSync &&
        a.source === source &&
        !a.deleted &&
        !a.archived &&
        a.sourceAccountId &&
        !seen.has(a.sourceAccountId)
      ) {
        await db.accounts.update(a.id, { archived: true, updatedAt: now })
      }
    }
  })
}

// Dev-only handle for deterministic merge tests in the preview (import.meta.env
// .DEV is statically false in production, so this is tree-shaken from the build).
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __tally?: unknown }).__tally = {
    db,
    applySyncedAccounts,
    canonInstitution,
    institutionsMatch,
  }
}
