import type { Account, AccountType, SourceSaid } from '../db/db'

type Said = Pick<Account, 'institution' | 'name' | 'type' | 'balance' | 'sourceSaid'>

/**
 * Which of a live account's institution, name and type the user set by hand:
 * the ones that differ from what its connector last said (Account.sourceSaid).
 * A row with no record of that (stored before it was kept) has no edits, so
 * its connector writes it as it always did.
 */
export function userEdits(a: Said | undefined): { institution: boolean; name: boolean; type: boolean } {
  const s = a?.sourceSaid
  if (!a || !s) return { institution: false, name: false, type: false }
  return { institution: a.institution !== s.institution, name: a.name !== s.name, type: a.type !== s.type }
}

/**
 * The stored balance of a live account whose type the user set by hand, from
 * the provider's new figure. The figure keeps the sign it had against the last
 * one: a card a bank reports at a positive figure, set to Credit with that
 * figure owed, stays owed; an overdrawn checking set to Cash below zero stays
 * below zero. With nothing to compare (either at zero), a connector whose own
 * tier now agrees with the user's reads it its own way (a card opened at $0
 * and set to Credit, then charged); otherwise the number reads the way the
 * connector's tier read it when the user set the type.
 */
export function balanceKeptByHand(a: Said, raw: number, connectorType: AccountType): number {
  const s = a.sourceSaid
  const sign =
    s && a.balance !== 0 && s.balance !== 0
      ? Math.sign(a.balance) * Math.sign(s.balance)
      : (connectorType === a.type ? connectorType : s?.type) === 'credit'
        ? -1
        : 1
  return sign * raw || 0
}

/**
 * What the connector says now, with what the user set kept: the patch a sync
 * writes to a linked row.
 */
export function syncedPatch(
  existing: Said,
  now: { institution: string; name: string; type: AccountType; raw: number },
): Pick<Account, 'institution' | 'name' | 'type' | 'balance' | 'sourceSaid'> {
  const edits = userEdits(existing)
  // While the user's type holds, the connector's own tier is kept as it was
  // when they set it: it is what the sign is read against.
  const saidType: AccountType = edits.type ? existing.sourceSaid!.type : now.type
  const said: SourceSaid = { institution: now.institution, name: now.name, type: saidType, balance: now.raw }
  return {
    institution: edits.institution ? existing.institution : now.institution,
    name: edits.name ? existing.name : now.name,
    type: edits.type ? existing.type : now.type,
    balance: edits.type ? balanceKeptByHand(existing, now.raw, now.type) : (now.type === 'credit' ? -now.raw : now.raw) || 0,
    sourceSaid: said,
  }
}

/** The connector's own record for a row that has none yet, read from the row as it stands. */
export function saidFromRow(a: Pick<Account, 'institution' | 'name' | 'type' | 'balance'>): SourceSaid {
  return { institution: a.institution, name: a.name, type: a.type, balance: (a.type === 'credit' ? -a.balance : a.balance) || 0 }
}
