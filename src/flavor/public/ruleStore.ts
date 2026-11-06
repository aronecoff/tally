import { TELL_PRIORITY, type ForgetRule, type RulePlan } from '../../lib/commands'
import type { Applied } from '../../lib/commandRun'
import { localDb, type LocalRule } from './localDb'
import { reloadMerchantRules } from './merchantRules'

/**
 * Tell Plainsum's rules, kept on the device. The semantics are the cloud store's
 * (src/lib/ruleStore.ts), and localDb stands where the server stood.
 */

const stamp = () => new Date().toISOString()

/** Only Tell Plainsum's own: a rule above TELL_PRIORITY is not one it saved. */
const tellRules = (pattern: string) =>
  localDb.rules
    .where('pattern')
    .equals(pattern)
    .filter((r) => r.priority <= TELL_PRIORITY)

/** Rules need no account here. */
export const canSaveRules = async (): Promise<boolean> => true

/** The rule half of Undo (commandRun.ts): a failure throws before any row changes. */
export async function ruleUndo(applied: Applied): Promise<void> {
  if (!applied.rule && !applied.forgot?.length) return
  try {
    if (applied.rule) {
      const { id, old } = applied.rule
      if (old) await localDb.rules.update(id, { ...old, updated_at: stamp() })
      else await localDb.rules.delete(id)
    }
    // With its old stamp, so it takes its old place among rules that tie. Each
    // leaves the list as it goes, so a retry never doubles one.
    while (applied.forgot?.length) {
      const r = applied.forgot[0]
      await localDb.rules.add({
        pattern: r.pattern, flags: r.flags, category: r.category, kind: r.kind, priority: r.priority,
        updated_at: r.updated_at ?? stamp(),
      })
      applied.forgot.shift()
    }
  } finally {
    await reloadMerchantRules()
  }
}

/**
 * Delete the rules "forget" names, keeping each as stored (its stamp too) so
 * Undo can add it again in its old place. Every lookup comes first, so one that
 * fails deletes nothing and throws. A delete that fails stops there and resolves
 * with the rules already gone, out of `of` found, beside the error.
 */
export async function forgetRules(rules: readonly ForgetRule[]): Promise<{ gone: ForgetRule[]; of: number; error?: string }> {
  const found: LocalRule[] = []
  for (const r of rules) {
    // Two planned rules with one pattern find the same rows: each goes once.
    for (const row of await tellRules(r.pattern).toArray()) if (!found.some((f) => f.id === row.id)) found.push(row)
  }
  const gone: ForgetRule[] = []
  try {
    for (const row of found) {
      await localDb.rules.delete(row.id!)
      gone.push({
        pattern: row.pattern, flags: row.flags ?? 'i', category: row.category, kind: (row.kind ?? 'expense') as ForgetRule['kind'],
        priority: row.priority, updated_at: row.updated_at,
      })
    }
    return { gone, of: found.length }
  } catch (e) {
    return { gone, of: found.length, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await reloadMerchantRules()
  }
}

/**
 * Add the rule, or retarget one saved earlier for the same merchant. Both paths
 * stamp the row, as the cloud's trigger did, so the latest instruction wins a tie.
 */
export async function saveRule(rule: RulePlan): Promise<{ rule?: Applied['rule']; note?: string }> {
  const fields = { category: rule.category, kind: rule.kind, priority: rule.priority, updated_at: stamp() }
  try {
    const prior = await tellRules(rule.pattern).first()
    if (prior?.id != null) {
      await localDb.rules.update(prior.id, fields)
      return { rule: { id: prior.id, old: { category: prior.category, kind: prior.kind ?? 'expense', priority: prior.priority } } }
    }
    return { rule: { id: await localDb.rules.add({ pattern: rule.pattern, flags: 'i', ...fields }) } }
  } catch {
    return { note: 'The rule was not saved, so new charges may still land in the old category.' }
  } finally {
    // New rules take effect at once for categorization and the next bank sync.
    await reloadMerchantRules()
  }
}
