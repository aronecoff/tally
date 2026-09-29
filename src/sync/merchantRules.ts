import { supabase } from '../db/supabase'
import { setUserRules, type UserRuleRow } from '../lib/userRules'

let inFlight: Promise<boolean> | null = null

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
 * Overlapping callers (boot, sign-in, the connector loop) share one request.
 */
export function loadMerchantRules(): Promise<boolean> {
  if (!inFlight) inFlight = fetchRules().finally(() => { inFlight = null })
  return inFlight
}

async function fetchRules(): Promise<boolean> {
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
      .select('pattern,flags,category,kind,priority')
      .eq('user_id', user.id)
      .order('priority')
    if (error || !Array.isArray(data)) return false
    setUserRules(data as UserRuleRow[])
    return true
  } catch {
    return false
  }
}
