import { db, type Account, type AccountType } from '../db/db'
import { currentLedgerGeneration } from '../sync/sync'
import { saidFromRow, syncedPatch } from './accountEdits'
import { effectiveTier } from './bankRules'
import { canonInstitution, institutionsMatch } from './institutions'

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

/** Bring back an account the user removed (it was only hidden); the next sync refreshes it. */
export async function restoreAccount(id: number): Promise<void> {
  await db.accounts.update(id, { deleted: false, archived: false, updatedAt: Date.now() })
}

/**
 * Read a live account's balance the other way round, or back. The row flips at
 * once, and so does the connector's own record of it, so the sign kept for a
 * type set by hand (accountEdits.balanceKeptByHand) reads as it did. A row with
 * no record gets one: the setting travels to other devices inside it (sync.ts).
 */
export async function setFlipSign(id: number, on: boolean): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const a = await db.accounts.get(id)
    if (!a || !!a.flipSign === on) return
    const said = a.sourceSaid ?? saidFromRow(a)
    await db.accounts.update(id, {
      flipSign: on || undefined,
      balance: -a.balance || 0,
      sourceSaid: { ...said, balance: -said.balance || 0 },
      updatedAt: Date.now(),
    })
  })
}

/** Drop a redundant leading institution name and tidy IRA casing. */
function cleanName(institution: string, name: string): string {
  let n = (name ?? '').trim()
  const inst = (institution ?? '').trim()
  if (inst && n.toLowerCase().startsWith(inst.toLowerCase())) n = n.slice(inst.length).trim()
  n = n.replace(/\bira\b/gi, 'IRA')
  return n || 'Account'
}

/**
 * An account's name as one key: lower case, letters and digits only, without
 * a leading institution name (its own or the canonical one) or a trailing
 * mask, so 'Roth IRA', 'Northgate Roth IRA' and 'Roth IRA (1234)' at Northgate
 * are one name.
 */
function nameKey(institution: string, name: string): string {
  const flat = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  let n = flat(name).replace(/\s*\d{3,}$/, '')
  for (const inst of [flat(institution), canonInstitution(institution)]) {
    if (inst && n.startsWith(`${inst} `)) n = n.slice(inst.length + 1)
  }
  return n.replace(/ /g, '')
}

/**
 * Merge a provider's live accounts into Dexie, in priority order per account:
 *   1. a row already linked by `sourceAccountId` → update in place (re-sync);
 *      a user-removed (deleted) row is respected, not resurrected, but its
 *      balance stays current so a restore (restoreAccount) shows today's.
 *   2. an unclaimed hand-typed row, same canonical institution + tier, that is
 *      the same account by name or a $0 shell → claim it (a typed figure
 *      under another name stays, and the connector's account is added)
 *   3. otherwise → create a new live row
 * Then reconcile: any previously-live row OF THIS SOURCE whose account is no
 * longer reported (closed/unlinked) is archived so it stops counting; it
 * revives on return. Reconciliation is scoped to `source` so syncing one
 * connector never archives another connector's accounts, and skipped when the
 * provider said part of its answer is missing (`archiveMissing: false`).
 *
 * Resolves to how many incoming accounts are shown, and how many the user
 * removed (still hidden), so a "Connected N accounts" note tells the truth.
 *
 * `generation` is the ledger generation (sync.ts) taken before the provider was
 * asked. If the local ledger was wiped since (sign-out, another account), the
 * answer belongs to the account that left and nothing is written: it put the
 * old account's balances back on a signed-out device.
 *
 * Credit / line-of-credit balances arrive negative-when-owed; Tally stores the
 * `credit` tier as the positive amount OWED, so the sign is flipped there.
 * Idempotent: re-running matches on `sourceAccountId`, so nothing duplicates.
 */
export async function applySyncedAccounts(
  incoming: SyncedAccount[],
  source: string,
  opts: { archiveMissing?: boolean; generation?: number } = {},
): Promise<{ shown: number; removed: number }> {
  let shown = 0
  let removed = 0
  if (!incoming.length) return { shown, removed }
  await db.transaction('rw', db.accounts, async () => {
    if (opts.generation !== undefined && currentLedgerGeneration() !== opts.generation) return
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
      // 1) a row already linked to this provider account (incl. tombstoned/archived)
      const existing = all.find((a) => a.sourceAccountId === inc.sourceAccountId)
      if (inc.balance == null || Number.isNaN(inc.balance)) {
        if (existing?.deleted) removed++
        else if (existing && !existing.archived) shown++
        continue
      }
      // Read the other way round when the user said so, before anything uses it.
      const raw = (existing?.flipSign ? -inc.balance : inc.balance) || 0
      // SimpleFIN has no account type: the Edge Function guesses from the name,
      // then the balance sign. The name decides when it can, then what the
      // account's own rows said (remembered by the transaction sync); a card
      // stays a card when its balance reads $0 (bankRules.effectiveTier).
      // SnapTrade sends real types. What was stored is read as the connector
      // last left it (sourceSaid), never as a type the user set by hand.
      const tier = (
        source === 'simplefin'
          ? effectiveTier(inc.name ?? '', inc.tier, existing?.sourceSaid?.type ?? existing?.type, {
              rows: existing?.rowsSay ?? null,
              balance: raw,
            })
          : inc.tier
      ) as AccountType
      const balance = (tier === 'credit' ? -raw : raw) || 0
      const institution = (inc.institution ?? '').trim() || 'Brokerage'
      const name = cleanName(institution, inc.name)
      const said = { institution, name, type: tier, balance: raw }

      if (existing?.id != null) {
        // An institution, name or type the user set in the account sheet stays
        // (lib/accountEdits.ts): the sync used to write the connector's over
        // them, so a rename was undone at the next refresh, and a card its bank
        // reports at a positive figure could not be kept as Credit.
        const patch = syncedPatch(existing, { institution, name, type: tier, raw })
        // Honor an explicit user removal — don't bring a deleted account back.
        // Keep its balance current, so a restore shows today's.
        if (existing.deleted) {
          await db.accounts.update(existing.id, { ...patch, lastUpdated: now })
          removed++
          continue
        }
        await db.accounts.update(existing.id, {
          ...patch, liveSync: true, source,
          archived: false, lastUpdated: now, updatedAt: now,
        })
        shown++
        continue
      }

      // 2) claim a hand-typed row of the same canonical institution + tier, but
      //    only a shell (still at $0, 'No balance yet') or the same account by
      //    name. A typed figure under another name is another account: claiming
      //    it wrote the connector's balance over it, and the typed one left net
      //    worth with nothing to restore. Same name first, then any $0 shell.
      const free = all.filter(
        (a) =>
          a.id != null &&
          !a.deleted &&
          !a.liveSync &&
          !a.sourceAccountId &&
          a.type === tier &&
          !claimed.has(a.id) &&
          institutionsMatch(a.institution, institution),
      )
      const key = nameKey(institution, name)
      const shell = (key ? free.find((a) => nameKey(a.institution, a.name) === key) : undefined) ?? free.find((a) => a.balance === 0)
      if (shell?.id != null) {
        claimed.add(shell.id)
        await db.accounts.update(shell.id, {
          sourceAccountId: inc.sourceAccountId, institution, name, type: tier, source, sourceSaid: said,
          balance, liveSync: true, archived: false, lastUpdated: now, updatedAt: now,
        })
        shown++
        continue
      }

      // 3) brand-new live account
      maxOrder += 1
      await db.accounts.add({
        institution, name, type: tier, balance, liveSync: true, source, sourceSaid: said,
        sourceAccountId: inc.sourceAccountId, lastUpdated: now, sortOrder: maxOrder, updatedAt: now,
      } as Account)
      shown++
    }
    if (opts.archiveMissing === false) return

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
  return { shown, removed }
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
