import { supabase } from '../db/supabase'
import { rulesEpoch, setUserRules, type UserRuleRow } from '../lib/userRules'

let inFlight: { epoch: number; promise: Promise<boolean> } | null = null

/**
 * Load the signed-in user's categorization rules (public.merchant_rules, one
 * row per rule, owner-only under RLS) into the in-memory store and its cache.
 *
 * Resolves true when the store now holds the server's rules (or there is no
 * backend at all, so there are no personal rules to wait for), and false when
 * they could not be fetched: signed out, offline, or a failed query. On false
 * the cached rules stay as they are, and bank categorization should wait until
 * userRulesReady() says a copy exists (see runAllConnectors).
 *
 * Overlapping callers (boot, sign-in, the connector loop) share one request,
 * but only within one sign-in: a load that a sign-out overtook is discarded
 * (it used to write the old account's rules back), and the next caller starts
 * its own.
 */
export function loadMerchantRules(): Promise<boolean> {
  const epoch = rulesEpoch()
  if (inFlight && inFlight.epoch === epoch) return inFlight.promise
  const entry = {
    epoch,
    promise: fetchRules(epoch).finally(() => {
      if (inFlight === entry) inFlight = null
    }),
  }
  inFlight = entry
  return entry.promise
}

/**
 * A load that starts after any load in flight, for just after a rule was saved
 * or taken back: a load that asked before the write cannot stand in for one.
 */
export function reloadMerchantRules(): Promise<boolean> {
  const prev = inFlight?.promise
  return prev ? prev.catch(() => false).then(() => loadMerchantRules()) : loadMerchantRules()
}

async function fetchRules(epoch: number): Promise<boolean> {
  if (!supabase) {
    setUserRules([]) // local-only mode: nothing personal to load
    return true
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  try {
    const { data: auth } = await supabase.auth.getSession()
    const user = auth.session?.user
    if (!user) return false
    const { data, error } = await supabase
      .from('merchant_rules')
      .select('id,pattern,flags,category,kind,priority,updated_at')
      .eq('user_id', user.id)
      .order('priority')
    if (error || !Array.isArray(data)) return false
    // Rules that tie are tried newest first (the stable merge in categorize.ts
    // keeps this order). Every Tell Tally rule has one priority, so the latest
    // "file" wins, as it did for the rows it filed. Postgres returns ties in no
    // set order, so this used to depend on where a row sat on disk.
    const rows = (data as (UserRuleRow & { id?: number; updated_at?: string | null })[]).slice().sort(
      (a, b) =>
        a.priority - b.priority ||
        String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) ||
        (b.id ?? 0) - (a.id ?? 0),
    )
    // Signed out (or someone else signed in) while this was asked: not theirs.
    if (rulesEpoch() !== epoch) return false
    const { data: now } = await supabase.auth.getSession()
    if (now.session?.user?.id !== user.id) return false
    setUserRules(rows)
    return true
  } catch {
    return false
  }
}
