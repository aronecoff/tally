// @vitest-environment jsdom
/**
 * The one guarded writer of category budgets. With no budget locked it is the
 * plain update the call sites made before. Locked, the check and the write
 * share a transaction. The amounts are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Category } from '../db/db'
import { BudgetRefused, writeBudgets } from './budgetWrite'
import { setPlan } from './planCache'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 1, ...extra,
})
const lock = (cap = 3000) => setPlan({ goal: 800, cap, locked: true, since: '2031-04', pending: null, updatedAt: 1 })
const budgets = async () => Object.fromEntries((await db.categories.toArray()).map((c) => [c.name, c.monthlyBudget]))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2031-04-10T12:00:00'))
  await db.categories.clear()
  await db.transactions.clear()
  // 2,750 assigned.
  await db.categories.bulkAdd([cat(1, 'Groceries', 2000), cat(2, 'Dining', 750), cat(3, 'Fun', 0), cat(9, 'Salary', 0, { kind: 'income' })])
})
afterEach(() => {
  setPlan(null)
  vi.useRealTimers()
})

describe('with no budget locked', () => {
  it('is one plain update for each change, stamped now', async () => {
    const update = vi.spyOn(db.categories, 'update')
    const scope = vi.spyOn(db, 'transaction')
    await writeBudgets([{ id: 2, monthlyBudget: 99999 }])
    expect(update.mock.calls).toEqual([[2, { monthlyBudget: 99999, updatedAt: new Date('2031-04-10T12:00:00').getTime() }]])
    expect(scope).not.toHaveBeenCalled()
    expect(await budgets()).toMatchObject({ Dining: 99999 })
    vi.restoreAllMocks()
  })

  it('takes the stamp it is given', async () => {
    await writeBudgets([{ id: 2, monthlyBudget: 10 }], { now: 4242 })
    expect((await db.categories.get(2))?.updatedAt).toBe(4242)
  })

  it('an unlocked plan locks nothing', async () => {
    setPlan({ goal: 800, cap: 3000, locked: false, since: null, pending: null, updatedAt: 1 })
    await writeBudgets([{ id: 2, monthlyBudget: 99999 }])
    expect(await budgets()).toMatchObject({ Dining: 99999 })
  })
})

describe('with a budget locked', () => {
  beforeEach(() => void lock())

  it('writes a raise into the room, and one to exactly the budget', async () => {
    await writeBudgets([{ id: 3, monthlyBudget: 100 }])
    await writeBudgets([{ id: 2, monthlyBudget: 900 }])
    expect(await budgets()).toMatchObject({ Groceries: 2000, Dining: 900, Fun: 100 })
  })

  it('refuses one cent past it, with the line, and writes nothing', async () => {
    const refused = await writeBudgets([{ id: 2, monthlyBudget: 1000.01 }]).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(BudgetRefused)
    expect((refused as Error).message).toBe('Your budget is locked at $3,000 a month, so Dining can be $1,000 at most. Lower another category first to go higher.')
    expect(await budgets()).toMatchObject({ Dining: 750 })
    expect((await db.categories.get(2))?.updatedAt).toBe(1)
  })

  it('is all or nothing', async () => {
    await expect(writeBudgets([{ id: 3, monthlyBudget: 100 }, { id: 2, monthlyBudget: 1000 }])).rejects.toBeInstanceOf(BudgetRefused)
    expect(await budgets()).toMatchObject({ Groceries: 2000, Dining: 750, Fun: 0 })
  })

  it('moving money between categories in one go passes', async () => {
    await writeBudgets([{ id: 1, monthlyBudget: 1500 }, { id: 2, monthlyBudget: 1500 }])
    expect(await budgets()).toMatchObject({ Groceries: 1500, Dining: 1500 })
  })

  it('two quick raises cannot both use the same room', async () => {
    const results = await Promise.allSettled([writeBudgets([{ id: 2, monthlyBudget: 1000 }]), writeBudgets([{ id: 3, monthlyBudget: 250 }])])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const now = await budgets()
    expect(now.Groceries + now.Dining + now.Fun).toBe(3000)
  })

  it('checks the budgets the store holds, not a copy a screen had', async () => {
    await db.categories.update(1, { monthlyBudget: 2250 }) // a sync used the room
    await expect(writeBudgets([{ id: 2, monthlyBudget: 1000 }])).rejects.toBeInstanceOf(BudgetRefused)
  })

  it('already over, a lower amount is written though it is still over, and a higher one is not', async () => {
    await db.categories.update(1, { monthlyBudget: 2600 }) // 3,350: a pull from an old copy of the app
    await writeBudgets([{ id: 2, monthlyBudget: 700 }])
    expect(await budgets()).toMatchObject({ Dining: 700 })
    await expect(writeBudgets([{ id: 2, monthlyBudget: 701 }])).rejects.toThrow(
      'Category budgets already add up to $300 more than your locked $3,000 budget. Lower one first.',
    )
  })

  it('inside another transaction, a refusal rolls the whole of it back', async () => {
    await db.transactions.add({ id: 1, date: '2031-04-01', amount: 5, type: 'expense', categoryId: 2, account: '', note: 'Kettle', createdAt: 1, updatedAt: 1 })
    const attempt = db.transaction('rw', db.transactions, db.categories, async () => {
      await db.transactions.update(1, { note: 'Changed' })
      await writeBudgets([{ id: 2, monthlyBudget: 5000 }])
    })
    await expect(attempt).rejects.toBeInstanceOf(BudgetRefused)
    expect((await db.transactions.get(1))?.note).toBe('Kettle')
    expect(await budgets()).toMatchObject({ Dining: 750 })
  })

  it('a pending raise of the budget is not room until the 1st', async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: { from: '2031-05', cap: 3600 }, updatedAt: 1 })
    await expect(writeBudgets([{ id: 2, monthlyBudget: 1200 }], { today: '2031-04-30' })).rejects.toBeInstanceOf(BudgetRefused)
    await writeBudgets([{ id: 2, monthlyBudget: 1200 }], { today: '2031-05-01' })
    expect(await budgets()).toMatchObject({ Dining: 1200 })
  })
})
