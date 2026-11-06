import { supabase } from '../db/supabase'
import { reloadMerchantRules } from '../sync/merchantRules'
import { TELL_PRIORITY, type ForgetRule, type RulePlan } from './commands'
import type { Applied } from './commandRun'

/**
 * Where Tell Tally's rules are kept: the account's merchant_rules table. The
 * public build swaps this module for an on-device store (scripts/flavor.ts).
 */

/** Rules are saved to the account, so a plan only promises one when signed in. */
export async function canSaveRules(): Promise<boolean> {
  if (!supabase) return false
  try {
    const { data } = await supabase.auth.getSession()
    return !!data.session
  } catch {
    return false
  }
}

/** The rule half of Undo (commandRun.ts): a refusal throws before any row changes. */
export async function ruleUndo(applied: Applied): Promise<void> {
  if ((applied.rule || applied.forgot?.length) && supabase) {
    try {
      if (applied.rule) {
        const { id, old } = applied.rule
        const { error } = old
          ? await supabase.from('merchant_rules').update(old).eq('id', id)
          : await supabase.from('merchant_rules').delete().eq('id', id)
        if (error) throw new Error(error.message)
      }
      // With its old stamp (the touch trigger fires on update only), so it
      // takes its old place among rules that tie, not the newest.
      while (applied.forgot?.length) {
        const { error } = await supabase.from('merchant_rules').insert(applied.forgot[0])
        if (error) throw new Error(error.message)
        applied.forgot.shift()
      }
    } finally {
      await reloadMerchantRules().catch(() => false)
    }
  }
}

/**
 * Delete the rules "forget" names, keeping each as stored (its stamp too) so
 * Undo can insert it again in its old place. Only Tell Tally's own (priority
 * TELL_PRIORITY and under): a private rule with the same pattern text is the
 * user's, and the plan never offered it.
 *
 * Every lookup comes first, so one that fails deletes nothing and throws. A
 * delete that fails stops there and resolves with the rules already gone, out
 * of `of` found, beside the error.
 */
export async function forgetRules(rules: readonly ForgetRule[]): Promise<{ gone: ForgetRule[]; of: number; error?: string }> {
  if (!supabase) throw new Error('Rules need an account.')
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user) throw new Error('Sign in to change your rules.')
  const found: (ForgetRule & { id: number })[] = []
  for (const r of rules) {
    const { data: rows, error } = await supabase
      .from('merchant_rules')
      .select('id,pattern,flags,category,kind,priority,updated_at')
      .eq('user_id', user.id)
      .eq('pattern', r.pattern)
      .lte('priority', TELL_PRIORITY)
      .limit(50)
    if (error) throw new Error(error.message)
    // Two planned rules with one pattern find the same rows: each goes once.
    for (const row of (rows ?? []) as (ForgetRule & { id: number })[]) if (!found.some((f) => f.id === row.id)) found.push(row)
  }
  const gone: ForgetRule[] = []
  try {
    for (const row of found) {
      const { error } = await supabase.from('merchant_rules').delete().eq('id', row.id)
      if (error) return { gone, of: found.length, error: error.message }
      gone.push({
        pattern: row.pattern, flags: row.flags, category: row.category, kind: row.kind, priority: row.priority,
        ...(row.updated_at ? { updated_at: row.updated_at } : {}),
      })
    }
    return { gone, of: found.length }
  } catch (e) {
    return { gone, of: found.length, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await reloadMerchantRules().catch(() => false)
  }
}

/**
 * Insert the rule, or retarget one Tell Tally saved earlier for the same
 * merchant. A private rule (priority above TELL_PRIORITY) with the same pattern
 * text is never retargeted: the new rule is inserted beside it and wins on
 * priority, and Undo deletes only that.
 */
export async function saveRule(rule: RulePlan): Promise<{ rule?: Applied['rule']; note?: string }> {
  const unsaved = 'The rule was not saved, so new charges may still land in the old category.'
  if (!supabase) return { note: unsaved }
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user) return { note: 'Sign in to have new charges follow this too.' }
  try {
    const { data: found, error: lookup } = await supabase
      .from('merchant_rules')
      .select('id,category,kind,priority')
      .eq('user_id', user.id)
      .eq('pattern', rule.pattern)
      .lte('priority', TELL_PRIORITY)
      .limit(1)
    // A failed lookup is not "no rule yet": inserting then saved a duplicate.
    if (lookup) return { note: unsaved }
    const prior = found?.[0] as { id: number; category: string; kind: string; priority: number } | undefined
    const fields = { category: rule.category, kind: rule.kind, priority: rule.priority }
    if (prior) {
      const { error } = await supabase.from('merchant_rules').update(fields).eq('id', prior.id)
      if (error) return { note: unsaved }
      return { rule: { id: prior.id, old: { category: prior.category, kind: prior.kind, priority: prior.priority } } }
    }
    const { data: row, error } = await supabase
      .from('merchant_rules')
      .insert({ pattern: rule.pattern, flags: 'i', ...fields })
      .select('id')
      .single()
    if (error || !row) return { note: unsaved }
    return { rule: { id: (row as { id: number }).id } }
  } catch {
    return { note: unsaved }
  } finally {
    // New rules take effect at once for categorization and the next bank sync.
    // A load that asked before this write cannot stand in for one after it.
    await reloadMerchantRules().catch(() => false)
  }
}
