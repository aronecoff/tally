import { db, type Transaction } from '../db/db'
import { forgetRules, ruleUndo, saveRule } from './ruleStore'
import type { ForgetRule, Plan } from './commands'

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
  await ruleUndo(applied)
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
