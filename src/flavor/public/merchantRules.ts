import { setUserRules } from '../../lib/userRules'
import { localDb } from './localDb'

let latest = 0

/**
 * Load the stored rules into the in-memory store and its cache. Rules that tie
 * are tried newest first, so the latest "file" wins, as it does in the cloud
 * version (src/sync/merchantRules.ts). A load overtaken by a later one leaves
 * the store to that one: it may have asked before a rule was saved.
 */
export async function loadMerchantRules(): Promise<boolean> {
  const mine = ++latest
  try {
    const rows = await localDb.rules.toArray()
    rows.sort(
      (a, b) => a.priority - b.priority || b.updated_at.localeCompare(a.updated_at) || (b.id ?? 0) - (a.id ?? 0),
    )
    if (mine === latest) setUserRules(rows)
    return true
  } catch {
    return false
  }
}

export const reloadMerchantRules = loadMerchantRules
