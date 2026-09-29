/**
 * A standing "file under" saves a rule so new charges follow, and Undo takes
 * the rule back as well as the rows. Signed out, the rows still change and the
 * sheet says the rule could not be saved.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  signedIn: true,
  existing: [] as { id: number; category: string; kind: string; priority: number }[],
  calls: [] as [string, unknown][],
}))

vi.mock('../db/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: h.signedIn ? { user: { id: 'u1' } } : null } }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: h.existing, error: null }) }) }) }),
      insert: (row: unknown) => {
        h.calls.push(['insert', row])
        return { select: () => ({ single: async () => ({ data: { id: 7 }, error: null }) }) }
      },
      update: (row: unknown) => ({
        eq: async (_col: string, id: number) => {
          h.calls.push(['update', { id, row }])
          return { error: null }
        },
      }),
      delete: () => ({
        eq: async (_col: string, id: number) => {
          h.calls.push(['delete', id])
          return { error: null }
        },
      }),
    }),
  },
}))
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

import { applyPlan, undoPlan } from './commandRun'
import { parseCommand, planCommand } from './commands'
import { db, type Category } from '../db/db'

const CATS: Category[] = [
  { id: 2, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 3, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]

async function fileAmazonUnderDining() {
  const parsed = parseCommand('file amazon under dining', CATS, '2026-09-29')
  if (!parsed.ok) throw new Error(parsed.message)
  const plan = planCommand(parsed.command, await db.transactions.toArray(), CATS)
  if (!plan.ok) throw new Error(plan.message)
  return plan
}

beforeEach(async () => {
  h.signedIn = true
  h.existing = []
  h.calls = []
  await db.transactions.clear()
  await db.transactions.bulkAdd([
    { id: 1, date: '2026-09-15', amount: 60, type: 'expense', categoryId: 2, account: 'Card', note: 'Amazon', createdAt: 0, updatedAt: 0 },
  ])
})

describe('file under, with a rule', () => {
  it('saves a new rule, and undo deletes it and restores the rows', async () => {
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([['insert', { pattern: 'amazon', flags: 'i', category: 'Dining', kind: 'expense', priority: 4 }]])
    expect(await db.transactions.get(1)).toMatchObject({ categoryId: 3, manual: true })
    expect(applied.note).toBeUndefined()

    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['delete', 7])
    expect((await db.transactions.get(1))?.categoryId).toBe(2)
  })

  it('retargets a rule saved earlier for the same merchant, and undo puts it back', async () => {
    h.existing = [{ id: 3, category: 'Shopping', kind: 'expense', priority: 4 }]
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([['update', { id: 3, row: { category: 'Dining', kind: 'expense', priority: 4 } }]])
    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['update', { id: 3, row: { category: 'Shopping', kind: 'expense', priority: 4 } }])
  })

  it('signed out: the rows still change, and it says the rule needs sign-in', async () => {
    h.signedIn = false
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([])
    expect((await db.transactions.get(1))?.categoryId).toBe(3)
    expect(applied.note).toBe('Sign in to have new charges follow this too.')
  })
})
