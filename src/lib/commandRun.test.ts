/**
 * A standing "file under" saves a rule so new charges follow, and Undo takes
 * the rule back as well as the rows. Signed out, the rows still change and the
 * sheet says the rule could not be saved.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  signedIn: true,
  existing: [] as Record<string, unknown>[],
  calls: [] as [string, unknown][],
  // postgrest resolves { error } instead of throwing: a refused write looks like this.
  fail: { select: 0, update: 0, delete: 0, insert: 0 },
}))
const refused = (k: keyof typeof h.fail) => (h.fail[k] > 0 ? (h.fail[k]--, { message: 'JWT expired' }) : null)

vi.mock('../db/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: h.signedIn ? { user: { id: 'u1' } } : null } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            lte: (_col: string, max: number) => ({
              limit: async () => {
                const error = refused('select')
                return error ? { data: null, error } : { data: h.existing.filter((r) => Number(r.priority) <= max), error: null }
              },
            }),
          }),
        }),
      }),
      insert: (row: unknown) => {
        const error = refused('insert')
        if (!error) h.calls.push(['insert', row])
        const done = { data: error ? null : { id: 7 }, error }
        return { select: () => ({ single: async () => done }), then: (r: (v: unknown) => void) => r({ error }) }
      },
      update: (row: unknown) => ({
        eq: async (_col: string, id: number) => {
          const error = refused('update')
          if (!error) h.calls.push(['update', { id, row }])
          return { error }
        },
      }),
      delete: () => ({
        eq: async (_col: string, id: number) => {
          const error = refused('delete')
          if (!error) h.calls.push(['delete', id])
          return { error }
        },
      }),
    }),
  },
}))
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true), reloadMerchantRules: vi.fn(async () => true) }))

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
  h.fail = { select: 0, update: 0, delete: 0, insert: 0 }
  await db.transactions.clear()
  await db.transactions.bulkAdd([
    { id: 1, date: '2026-09-15', amount: 60, type: 'expense', categoryId: 2, account: 'Card', note: 'Amazon', createdAt: 0, updatedAt: 0 },
  ])
})

describe('file under, with a rule', () => {
  it('saves a new rule, and undo deletes it and restores the rows', async () => {
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([['insert', { pattern: '(?:^|[^a-z0-9])amazon(?![a-z0-9])', flags: 'i', category: 'Dining', kind: 'expense', priority: 4 }]])
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

  it('a private rule with the same pattern text is not retargeted: the new rule goes in beside it', async () => {
    h.existing = [{ id: 12, category: 'Shopping', kind: 'expense', priority: 35 }]
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([['insert', expect.objectContaining({ category: 'Dining', priority: 4 })]])
    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['delete', 7])
  })

  it('signed out: the rows still change, and it says the rule needs sign-in', async () => {
    h.signedIn = false
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([])
    expect((await db.transactions.get(1))?.categoryId).toBe(3)
    expect(applied.note).toBe('Sign in to have new charges follow this too.')
  })
})

describe('file under Rent, then Undo', () => {
  it('Undo puts back the date as well as the category', async () => {
    const cats: Category[] = [...CATS, { id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 2, updatedAt: 0 }]
    await db.transactions.add({
      id: 2, uid: 'sf:z1', date: '2026-09-27', amount: 2400, type: 'expense', categoryId: null, account: 'Checking', note: 'Zelle to J Quince', createdAt: 0, updatedAt: 0,
    })
    const parsed = parseCommand('file zelle to j quince under rent', cats, '2026-09-29')
    if (!parsed.ok) throw new Error(parsed.message)
    const plan = planCommand(parsed.command, await db.transactions.toArray(), cats)
    if (!plan.ok) throw new Error(plan.message)
    const applied = await applyPlan(plan)
    expect(await db.transactions.get(2)).toMatchObject({ categoryId: 1, date: '2026-10-01', manual: true, dateMoved: true })
    await undoPlan(applied)
    expect(await db.transactions.get(2)).toMatchObject({ categoryId: null, date: '2026-09-27' })
    expect((await db.transactions.get(2))?.dateMoved).toBeUndefined()
  })
})

describe('move, then Undo', () => {
  it('marks the date as moved (Transaction.dateMoved), and Undo takes the mark back with the date', async () => {
    const parsed = parseCommand('move amazon to sep 20', CATS, '2026-09-29')
    if (!parsed.ok) throw new Error(parsed.message)
    const plan = planCommand(parsed.command, await db.transactions.toArray(), CATS)
    if (!plan.ok) throw new Error(plan.message)
    const applied = await applyPlan(plan)
    expect(await db.transactions.get(1)).toMatchObject({ date: '2026-09-20', manual: true, dateMoved: true })
    await undoPlan(applied)
    expect(await db.transactions.get(1)).toMatchObject({ date: '2026-09-15' })
    expect((await db.transactions.get(1))?.dateMoved).toBeUndefined()
  })
})

describe('file out of Rent, then Undo', () => {
  it("puts back the bank's posted day, and Undo the 1st", async () => {
    const cats: Category[] = [...CATS, { id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 2, updatedAt: 0 }]
    const other = cats.find((c) => c.kind === 'expense' && c.id !== 1)!
    await db.transactions.add({
      id: 2, uid: 'sf:z1', date: '2026-10-01', posted: '2026-09-27', amount: 2400, type: 'expense', categoryId: 1, account: 'Checking',
      note: 'Zelle to J Quince', createdAt: 0, updatedAt: 0,
    })
    const parsed = parseCommand(`file zelle to j quince under ${other.name.toLowerCase()}`, cats, '2026-10-02')
    if (!parsed.ok) throw new Error(parsed.message)
    const plan = planCommand(parsed.command, await db.transactions.toArray(), cats)
    if (!plan.ok) throw new Error(plan.message)
    const applied = await applyPlan(plan)
    expect(await db.transactions.get(2)).toMatchObject({ categoryId: other.id, date: '2026-09-27', posted: '2026-09-27', manual: true })
    await undoPlan(applied)
    expect(await db.transactions.get(2)).toMatchObject({ categoryId: 1, date: '2026-10-01', posted: '2026-09-27' })
  })
})

describe('B08: an Undo the server refuses can be tried again', () => {
  it('a refused rule delete throws, and leaves the rows as applied (pinned), so a bank sync cannot re-file them', async () => {
    const applied = await applyPlan(await fileAmazonUnderDining())
    h.fail.delete = 1
    await expect(undoPlan(applied)).rejects.toThrow()
    expect(await db.transactions.get(1)).toMatchObject({ categoryId: 3, manual: true })
    // The retry takes the rule back, then the rows.
    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['delete', 7])
    expect((await db.transactions.get(1))?.categoryId).toBe(2)
  })

  it('a refused restore of a retargeted rule throws too', async () => {
    h.existing = [{ id: 3, category: 'Shopping', kind: 'expense', priority: 4 }]
    const applied = await applyPlan(await fileAmazonUnderDining())
    h.fail.update = 1
    await expect(undoPlan(applied)).rejects.toThrow()
    expect((await db.transactions.get(1))?.categoryId).toBe(3)
    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['update', { id: 3, row: { category: 'Shopping', kind: 'expense', priority: 4 } }])
  })

  it('a failed lookup saves no duplicate rule', async () => {
    h.fail.select = 1
    const applied = await applyPlan(await fileAmazonUnderDining())
    expect(h.calls).toEqual([])
    expect(applied.note).toMatch(/not saved/)
  })
})

describe('B10: forget a rule, and Undo puts it back', () => {
  const PATTERN = '(?:^|[^a-z0-9])acmefm(?![a-z0-9])'
  const forgetPlan = () => {
    const parsed = parseCommand('forget acmefm', CATS, '2026-09-29')
    if (!parsed.ok) throw new Error(parsed.message)
    const userRules = [{ match: new RegExp(PATTERN, 'i'), pattern: PATTERN, category: 'Dining', kind: 'expense' as const, priority: 4 }]
    const plan = planCommand(parsed.command, [], CATS, { today: '2026-09-29', userRules })
    if (!plan.ok) throw new Error(plan.message)
    return plan
  }
  it('deletes the saved row, and Undo inserts it again', async () => {
    h.existing = [{ id: 9, pattern: PATTERN, flags: 'i', category: 'Dining', kind: 'expense', priority: 4 }]
    const applied = await applyPlan(forgetPlan())
    expect(h.calls).toEqual([['delete', 9]])
    await undoPlan(applied)
    expect(h.calls.at(-1)).toEqual(['insert', { pattern: PATTERN, flags: 'i', category: 'Dining', kind: 'expense', priority: 4 }])
  })
  it('a private rule with the same pattern text is never deleted', async () => {
    h.existing = [
      { id: 9, pattern: PATTERN, flags: 'i', category: 'Dining', kind: 'expense', priority: 4 },
      { id: 12, pattern: PATTERN, flags: 'i', category: 'Other', kind: 'expense', priority: 35 },
    ]
    await applyPlan(forgetPlan())
    expect(h.calls).toEqual([['delete', 9]])
  })
  it('signed out, Apply fails rather than saying it forgot', async () => {
    h.signedIn = false
    await expect(applyPlan(forgetPlan())).rejects.toThrow()
  })
})
