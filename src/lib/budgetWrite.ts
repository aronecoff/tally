/**
 * The one writer of category budgets for an edit a person makes: the Categories
 * screen, Tell Tally and its Undo, and the public app's first run. While the
 * savings plan is locked, category budgets may not add up to more than its
 * budget (lib/savingsPlan.ts), and this is where that holds.
 *
 * Rows that arrive (a sync pull, a restore, the default categories) do not come
 * through here. They are never refused, because refusing them would split the
 * devices: budgets that then run past the plan are said on Home, Budget and
 * Categories, and Home keeps measuring against the plan.
 */
import { db } from '../db/db'
import { todayISO } from './dates'
import { getPlan } from './planCache'
import { capInForce, checkBudgets } from './savingsPlan'

/** A budget edit the locked plan does not allow. The message says why and what to do. */
export class BudgetRefused extends Error {}

/**
 * Write whole new budgets by category id. With no budget locked this is exactly
 * what each call site did before: one update for each change, stamped `now`.
 * Locked, the check and the writes share one transaction, so two quick edits
 * cannot both pass on the same room, and a refusal throws BudgetRefused with
 * nothing written. Called inside another transaction (Tell Tally's Apply), the
 * throw rolls that back too.
 */
export async function writeBudgets(
  changes: readonly { id: number; monthlyBudget: number }[],
  opts: { today?: string; now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now()
  const write = async () => {
    for (const c of changes) await db.categories.update(c.id, { monthlyBudget: c.monthlyBudget, updatedAt: now })
  }
  const cap = capInForce(getPlan(), opts.today ?? todayISO())
  if (cap == null) return write()
  await db.transaction('rw', db.categories, async () => {
    const fits = checkBudgets(await db.categories.toArray(), changes, cap)
    if (!fits.ok) throw new BudgetRefused(fits.message)
    await write()
  })
}
