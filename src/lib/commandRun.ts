import { db, type Transaction } from '../db/db'
import { supabase } from '../db/supabase'
import { loadMerchantRules } from '../sync/merchantRules'
import type { Plan, RulePlan } from './commands'

type OkPlan = Extract<Plan, { ok: true }>

/** What undo needs: each changed field's old value, and how to take back a rule. */
export interface Applied {
  rows: { id: number; before: Partial<Transaction> }[]
  budget?: { id: number; before: number }
  rule?: { id: number; old?: { category: string; kind: string; priority: number } }
  /** Said after the change when the rule could not be saved. */
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
  return applied
}

export async function undoPlan(applied: Applied): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', db.transactions, db.categories, async () => {
    for (const r of applied.rows) await db.transactions.update(r.id, { ...r.before, updatedAt: now })
    if (applied.budget) await db.categories.update(applied.budget.id, { monthlyBudget: applied.budget.before, updatedAt: now })
  })
  if (applied.rule && supabase) {
    const { id, old } = applied.rule
    try {
      if (old) await supabase.from('merchant_rules').update(old).eq('id', id)
      else await supabase.from('merchant_rules').delete().eq('id', id)
    } finally {
      await loadMerchantRules().catch(() => false)
    }
  }
}

/** Insert the rule, or retarget one saved earlier for the same merchant. */
async function saveRule(rule: RulePlan): Promise<{ rule?: Applied['rule']; note?: string }> {
  const unsaved = 'The rule was not saved, so new charges may still land in the old category.'
  if (!supabase) return { note: unsaved }
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user) return { note: 'Sign in to have new charges follow this too.' }
  try {
    const { data: found } = await supabase
      .from('merchant_rules')
      .select('id,category,kind,priority')
      .eq('user_id', user.id)
      .eq('pattern', rule.pattern)
      .limit(1)
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
    await loadMerchantRules().catch(() => false)
  }
}
