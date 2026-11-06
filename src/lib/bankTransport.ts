import type { Account } from '../db/db'
import { supabase } from '../db/supabase'
import { edgeFailure } from './edgeError'

/**
 * How the shared bank code (banks.ts) reaches SimpleFIN. In this build that is
 * the `simplefin` Edge Function. The public build swaps this module for one that
 * goes through the app's native bridge (scripts/flavor.ts), so banks.ts holds
 * the reconcile logic and no transport of its own.
 */

/** Bank & card linking (via SimpleFIN Bridge) requires Supabase configured. */
export const banksConfigured = !!supabase

/** Why a due bank fetch did not run, as the connector run reports it. */
export const bankBlockedCopy: { signIn: string | null; notPulled: string | null } = {
  signIn: 'Sign in to Tally in Settings first.',
  notPulled: 'Could not reach your Tally data. Bank transactions will refresh on the next sync.',
}

/** A failed connector's message as the screen shows it. Here it passes through. */
export const bankErrorCopy = (message: string): string => message

/** A failed claim as the bank sheet says it, or null for its own line. Here, always null. */
export const bankClaimCopy: (message: string) => string | null = () => null

export async function bankInvoke<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Sync is not configured.')
  const { data, error } = await supabase.functions.invoke('simplefin', { body: { action, ...body } })
  if (error) throw await edgeFailure(error)
  if (data && data.ok === false) throw new Error(data.error || 'Could not reach the server. Try again.')
  return data as T
}

/** Whether Accounts offers a refresh. Here it always does: a sync goes through the
 *  connectors even with nothing linked, and says what is missing. */
export const bankRefreshable: (accounts: Account[]) => boolean = () => true

/** Whether a bank fetch can run at all: here, a signed-in session. */
export async function bankReady(): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    return !!data.session
  } catch {
    return false
  }
}
