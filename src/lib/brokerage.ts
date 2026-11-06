import { supabase } from '../db/supabase'
import { currentLedgerGeneration } from '../sync/sync'
import { edgeFailure } from './edgeError'
import { applySyncedAccounts as merge, restoreAccount, type SyncedAccount } from './accountMerge'

/** Brokerage connect/sync is only possible when Supabase is configured. */
export const brokerageEnabled = !!supabase

async function invoke<T>(action: string): Promise<T> {
  if (!supabase) throw new Error('Sync is not configured.')
  // functions.invoke attaches the apikey + the signed-in user's JWT
  // automatically — that JWT is what the backend gate checks.
  const { data, error } = await supabase.functions.invoke('snaptrade', { body: { action } })
  // Non-2xx surfaces as FunctionsHttpError with the real body on error.context;
  // the backend is gated to the signed-in owner, so 'unauthorized' asks to sign in.
  if (error) throw await edgeFailure(error)
  if (data && data.ok === false) throw new Error(data.error || 'Could not reach the server. Try again.')
  return data as T
}

/** Ask the backend for a SnapTrade connection-portal URL to link a brokerage.
 *  Only an https URL is accepted: a javascript: or data: URL would run inside
 *  Tally's own blank window, and a non-string reply would load '[object Object]'. */
export async function connectBrokerage(): Promise<string> {
  const data = await invoke<{ ok: boolean; redirectURI: unknown }>('connect')
  const fail = () => new Error('Could not start the connection. Try again.')
  if (typeof data.redirectURI !== 'string' || !data.redirectURI) throw fail()
  let url: URL
  try {
    url = new URL(data.redirectURI)
  } catch {
    throw fail()
  }
  if (url.protocol !== 'https:') throw fail()
  return url.href
}

/** Pull live brokerage accounts and merge them into the local accounts table.
 *  Resolves to the number of accounts shown (a removed one stays hidden). */
export async function syncBrokerages(): Promise<number> {
  // Taken before the fetch: a sign-out while it runs wipes the ledger, and the
  // answer belongs to the account that left (applySyncedAccounts).
  const generation = currentLedgerGeneration()
  const data = await invoke<{ ok: boolean; accounts: SyncedAccount[] }>('sync')
  const incoming = (data.accounts ?? []).filter((a) => a.sourceAccountId)
  return (await applySyncedAccounts(incoming, 'snaptrade', { generation })).shown
}

export { restoreAccount }
export type { SyncedAccount }

/** The shared merge (accountMerge.ts) with SnapTrade as the default source. */
export const applySyncedAccounts = (
  incoming: SyncedAccount[],
  source = 'snaptrade',
  opts: { archiveMissing?: boolean; generation?: number } = {},
) => merge(incoming, source, opts)
