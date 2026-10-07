import { db, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'
import { reloadMerchantRules } from '../sync/merchantRules'
import { TELL_PRIORITY, type ForgetRule, type Plan, type RulePlan } from './commands'

type OkPlan = Extract<Plan, { ok: true }>

/** What undo needs: each changed field's old value, and how to take back a rule. */
export interface Applied {
  rows: { id: number; before: Partial<Transaction> }[]
  budget?: { id: number; before: number }
  rule?: { id: number; old?: { category: string; kind: string; priority: number } }
  /**
   * Rules "forget" deleted and Undo has not yet put back, oldest first, each
   * with its stamp (it empties as it goes, so a retry never doubles one).
   */
  forgot?: ForgetRule[]
  /** Said in place of the plan's title when only part of it was saved: 'Forgot 1 of 2 rules'. */
  title?: string
  /** Said after the change: a rule that could not be saved, or what is left to do. */
  note?: string
}

/**
 * Write a plan exactly as the app's own edits do: rows are pinned (`manual`,
 * so a bank sync never reverts them) and stamped now, so the normal device sync
 * carries them to every device. A standing "file under" also saves a rule, so
 * new charges from that merchant follow it.
 */
export async function applyPlan(plan: OkPlan): Promise<Applied> {
  const now = Date.now()
  await db.transaction('rw', db.transactions, db.categories, async () => {
    for (const r of plan.rows) await db.transactions.update(r.t.id!, { ...r.after, updatedAt: now })
    if (plan.budget) await db.categories.update(plan.budget.category.id!, { monthlyBudget: plan.budget.after, updatedAt: now })
  })
  const applied: Applied = {
    rows: plan.rows.map((r) => ({ id: r.t.id!, before: r.before })),
    budget: plan.budget ? { id: plan.budget.category.id!, before: plan.budget.before } : undefined,
  }
  if (plan.rule) {
    const saved = await saveRule(plan.rule)
    applied.rule = saved.rule
    applied.note = saved.note
  }
  if (plan.forget?.length) {
    const { gone, of, error } = await forgetRules(plan.forget)
    // Nothing gone: the plan did not happen, and Apply can be tried again.
    if (error && !gone.length) throw new Error(error)
    // Some gone: say so, and keep them for Undo. Thrown, they were gone for
    // good while the sheet said "Could not save" and offered no Undo.
    applied.forgot = oldestFirst(gone)
    if (error) {
      applied.title = `Forgot ${gone.length} of ${of} rules`
      applied.note = 'The rest could not be removed. Try again, or Undo.'
    }
  }
  return applied
}

/**
 * Oldest first, so Undo inserts them in the order they were made and the new
 * ids rise with age as the old ones did (ties on priority and stamp are tried
 * newest id first, merchantRules.ts).
 */
function oldestFirst(rules: readonly ForgetRule[]): ForgetRule[] {
  // Deleted in the plan's order, newest first within a priority: reversed,
  // that is oldest first, and it stands if a stamp is ever missing.
  const out = [...rules].reverse()
  const at = (r: ForgetRule) => Date.parse(r.updated_at ?? '')
  if (out.every((r) => Number.isFinite(at(r)))) out.sort((a, b) => at(a) - at(b))
  return out
}

/**
 * Put back each field the plan changed. The pin stays: a pin is one-way across
 * devices (sync.ts), so an Undo that unpinned here left the other devices
 * pinned and the cloud flipping between the two on every sync.
 *
 * The rule goes first, and a refusal throws before any row changes. A refused
 * write resolves { error } rather than throwing, and it used to read as
 * "Undone" while the rule stayed and the next bank sync re-filed the rows.
 * Now a failed Undo leaves the change whole (rows still pinned, so no sync
 * re-files them) and can be tried again: deleting the same id, or writing the
 * same old values, twice is harmless.
 */
export async function undoPlan(applied: Applied): Promise<void> {
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
  const now = Date.now()
  await db.transaction('rw', db.transactions, db.categories, async () => {
    for (const r of applied.rows) {
      const fields: Partial<Transaction> = { ...r.before }
      delete fields.manual
      await db.transactions.update(r.id, { ...fields, updatedAt: now })
    }
    if (applied.budget) await db.categories.update(applied.budget.id, { monthlyBudget: applied.budget.before, updatedAt: now })
  })
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
async function forgetRules(rules: readonly ForgetRule[]): Promise<{ gone: ForgetRule[]; of: number; error?: string }> {
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
async function saveRule(rule: RulePlan): Promise<{ rule?: Applied['rule']; note?: string }> {
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
