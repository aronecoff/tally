/**
 * The scenarios of src/lib/commandRun*.test.ts against the on-device store:
 * applyPlan and undoPlan are the shared code, and the rules land in localDb
 * where the personal build reaches the cloud. Invented merchants and stamps.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Category } from '../../db/db'
import { guessCategoryName } from '../../lib/categorize'
import { applyPlan, undoPlan } from '../../lib/commandRun'
import { parseCommand, planCommand, TELL_PRIORITY } from '../../lib/commands'
import { canSaveRules } from '../../lib/ruleStore'
import { clearUserRules } from '../../lib/userRules'
import { loadMerchantRules } from '../../sync/merchantRules'
import { localDb, type LocalRule } from './localDb'

const CATS: Category[] = [
  { id: 2, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 3, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
  { id: 4, name: 'Subscriptions', icon: 'repeat', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 },
  { id: 5, name: 'Fun', icon: 'sparkles', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 3, updatedAt: 0 },
]
const TODAY = '2031-02-10'
const ZENTRIX = '(?:^|[^a-z0-9])zentrix(?![a-z0-9])'

async function planOf(words: string) {
  const parsed = parseCommand(words, CATS, TODAY)
  if (!parsed.ok) throw new Error(parsed.message)
  const plan = planCommand(parsed.command, await db.transactions.toArray(), CATS, { today: TODAY })
  if (!plan.ok) throw new Error(plan.message)
  return plan
}

const stored = async () => (await localDb.rules.toArray()).sort((a, b) => a.pattern.localeCompare(b.pattern))
/** Each rule as Undo must bring it back: everything but its id. */
const unkeyed = (rows: LocalRule[]) =>
  rows.map((r) => ({ pattern: r.pattern, flags: r.flags, category: r.category, kind: r.kind, priority: r.priority, updated_at: r.updated_at }))
const guess = (note: string) => guessCategoryName(note, 'expense')
const seedRule = (over: Partial<LocalRule>) =>
  localDb.rules.add({
    pattern: ZENTRIX, flags: 'i', category: 'Shopping', kind: 'expense', priority: TELL_PRIORITY,
    updated_at: '2031-01-01T00:00:00.000Z', ...over,
  })

/** Rule A ("zentrix", older) and rule B ("zentrix plus", newer): both catch Zentrix Plus, and the newer wins the tie. */
async function twoOverlappingRules() {
  await applyPlan(await planOf('file zentrix under shopping'))
  await new Promise((r) => setTimeout(r, 2))
  await applyPlan(await planOf('file zentrix plus under subscriptions'))
  expect((await localDb.rules.toArray()).map((r) => [r.category, r.priority])).toEqual([
    ['Shopping', TELL_PRIORITY],
    ['Subscriptions', TELL_PRIORITY],
  ])
}

beforeEach(async () => {
  clearUserRules()
  await localDb.rules.clear()
  await db.transactions.clear()
  await db.transactions.bulkAdd([
    { id: 1, date: '2031-02-01', amount: 41.5, type: 'expense', categoryId: 2, account: 'Card', note: 'ZENTRIX STORE 0042', createdAt: 0, updatedAt: 0 },
    { id: 2, date: '2031-02-02', amount: 9.25, type: 'expense', categoryId: 2, account: 'Card', note: 'ZENTRIX PLUS 7781', createdAt: 0, updatedAt: 0 },
  ])
  await loadMerchantRules()
})
afterEach(() => {
  vi.restoreAllMocks()
  clearUserRules()
})

describe('saving', () => {
  it('needs no account', async () => {
    await expect(canSaveRules()).resolves.toBe(true)
  })

  it('adds a new rule, and Undo deletes it and restores the rows', async () => {
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    expect(await stored()).toEqual([
      expect.objectContaining({ pattern: ZENTRIX, flags: 'i', category: 'Dining', kind: 'expense', priority: TELL_PRIORITY }),
    ])
    expect((await stored())[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await db.transactions.get(1)).toMatchObject({ categoryId: 3, manual: true })
    expect(applied.note).toBeUndefined()
    expect(guess('ZENTRIX STORE 0042')).toBe('Dining')

    await undoPlan(applied)
    expect(await stored()).toEqual([])
    expect((await db.transactions.get(1))?.categoryId).toBe(2)
    expect(guess('ZENTRIX STORE 0042')).not.toBe('Dining')
  })

  it('retargets a rule saved earlier for the same merchant, and Undo puts it back', async () => {
    const id = await seedRule({})
    await loadMerchantRules()
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    expect(await stored()).toEqual([expect.objectContaining({ id, category: 'Dining' })])
    expect((await stored())[0].updated_at).not.toBe('2031-01-01T00:00:00.000Z')
    await undoPlan(applied)
    expect(await stored()).toEqual([expect.objectContaining({ id, category: 'Shopping', kind: 'expense', priority: TELL_PRIORITY })])
  })

  it('a rule above Tell priority with the same pattern is not retargeted: the new rule goes in beside it', async () => {
    const mine = await seedRule({ priority: 35 })
    await loadMerchantRules()
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    expect((await stored()).map((r) => [r.id === mine, r.category])).toEqual([
      [true, 'Shopping'],
      [false, 'Dining'],
    ])
    await undoPlan(applied)
    expect(await stored()).toEqual([expect.objectContaining({ id: mine, category: 'Shopping', priority: 35 })])
  })

  it('a failed lookup saves no duplicate rule, and says so', async () => {
    vi.spyOn(localDb.rules, 'where').mockImplementationOnce(() => {
      throw new Error('lookup failed')
    })
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    expect(await stored()).toEqual([])
    expect(applied.note).toMatch(/not saved/)
    expect((await db.transactions.get(1))?.categoryId).toBe(3)
  })
})

describe('an Undo that fails can be tried again', () => {
  it('a failed rule delete throws, and leaves the rows as applied', async () => {
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    vi.spyOn(localDb.rules, 'delete').mockRejectedValueOnce(new Error('write failed'))
    await expect(undoPlan(applied)).rejects.toThrow('write failed')
    expect(await db.transactions.get(1)).toMatchObject({ categoryId: 3, manual: true })
    await undoPlan(applied)
    expect(await stored()).toEqual([])
    expect((await db.transactions.get(1))?.categoryId).toBe(2)
  })

  it('a failed restore of a retargeted rule throws too', async () => {
    const id = await seedRule({})
    await loadMerchantRules()
    const applied = await applyPlan(await planOf('file zentrix under dining'))
    vi.spyOn(localDb.rules, 'update').mockRejectedValueOnce(new Error('write failed'))
    await expect(undoPlan(applied)).rejects.toThrow('write failed')
    expect((await db.transactions.get(1))?.categoryId).toBe(3)
    await undoPlan(applied)
    expect(await stored()).toEqual([expect.objectContaining({ id, category: 'Shopping' })])
  })
})

describe('forget, then Undo', () => {
  it('Undo brings both rules back in their old order, so the newer one still wins', async () => {
    await twoOverlappingRules()
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
    const before = unkeyed(await stored())

    const plan = await planOf('forget zentrix')
    expect(plan.forget).toHaveLength(2)
    const applied = await applyPlan(plan)
    expect(await stored()).toEqual([])
    expect(applied.title).toBeUndefined()
    expect(guess('ZENTRIX PLUS 7781')).not.toBe('Subscriptions')

    await undoPlan(applied)
    // Each is back as stored, its stamp included: a fresh stamp would make the
    // older, broader rule the newest, and it would take Zentrix Plus.
    expect(unkeyed(await stored())).toEqual(before)
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
    // Oldest first, so the ids rise with age as they did.
    const [older, newer] = (await localDb.rules.toArray()).sort((a, b) => a.updated_at.localeCompare(b.updated_at))
    expect(older.id!).toBeLessThan(newer.id!)
    expect(applied.forgot).toEqual([])
  })

  it('a rule saved after the forget stays newest: Undo does not stamp the old ones newer', async () => {
    await twoOverlappingRules()
    const applied = await applyPlan(await planOf('forget zentrix'))
    await new Promise((r) => setTimeout(r, 2))
    await applyPlan(await planOf('file zentrix plus under fun'))
    await undoPlan(applied)
    expect(await stored()).toHaveLength(3)
    expect(guess('ZENTRIX PLUS 7781')).toBe('Fun')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
  })

  it('a rule above Tell priority with the same pattern is never deleted', async () => {
    await seedRule({})
    const mine = await seedRule({ category: 'Fun', priority: 35 })
    await loadMerchantRules()
    await applyPlan(await planOf('forget zentrix'))
    expect(await stored()).toEqual([expect.objectContaining({ id: mine, priority: 35 })])
  })

  it('a rule stored twice goes once each, and Undo puts back two, not four', async () => {
    await seedRule({})
    await seedRule({ updated_at: '2031-01-02T00:00:00.000Z' })
    await loadMerchantRules()
    const before = unkeyed(await stored())
    const plan = await planOf('forget zentrix')
    expect(plan.forget).toHaveLength(2)
    const applied = await applyPlan(plan)
    expect(await stored()).toEqual([])
    expect(applied.forgot).toHaveLength(2)
    await undoPlan(applied)
    expect(unkeyed(await stored())).toEqual(before)
  })
})

describe('a forget stopped partway', () => {
  it('reports what it did and keeps Undo for the rules that went', async () => {
    await twoOverlappingRules()
    const before = unkeyed(await stored())
    const plan = await planOf('forget zentrix')
    const real = localDb.rules.delete.bind(localDb.rules)
    let n = 0
    vi.spyOn(localDb.rules, 'delete').mockImplementation(((id: number) =>
      ++n === 2 ? Promise.reject(new Error('write failed')) : real(id)) as typeof localDb.rules.delete)
    const applied = await applyPlan(plan)
    vi.restoreAllMocks()
    expect(await stored()).toHaveLength(1)
    expect(applied.forgot).toHaveLength(1)
    expect(applied.title).toBe('Forgot 1 of 2 rules')
    expect(applied.note).toMatch(/could not be removed/)

    await undoPlan(applied)
    expect(unkeyed(await stored())).toEqual(before)
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
  })

  it('a lookup that fails is an error before anything is deleted', async () => {
    await twoOverlappingRules()
    const plan = await planOf('forget zentrix')
    const real = localDb.rules.where.bind(localDb.rules)
    let n = 0
    vi.spyOn(localDb.rules, 'where').mockImplementation(((index: string) => {
      if (++n === 2) throw new Error('lookup failed')
      return real(index)
    }) as typeof localDb.rules.where)
    await expect(applyPlan(plan)).rejects.toThrow('lookup failed')
    expect(await stored()).toHaveLength(2)
  })

  it('a first delete that fails is an error, and nothing is gone', async () => {
    await twoOverlappingRules()
    const plan = await planOf('forget zentrix')
    vi.spyOn(localDb.rules, 'delete').mockRejectedValueOnce(new Error('write failed'))
    await expect(applyPlan(plan)).rejects.toThrow('write failed')
    expect(await stored()).toHaveLength(2)
  })
})
