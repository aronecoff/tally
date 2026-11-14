// @vitest-environment jsdom
/**
 * The sample ledger: it shows the whole app whatever the date, nothing in it is
 * dated ahead of today, and it leaves as cleanly as it came.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'
import { guessCategoryName, isRentCategory } from '../../lib/categorize'
import { currentMonth, shiftMonth, todayISO } from '../../lib/dates'
import { setPlan } from '../../lib/planCache'
import { hasSampleData, loadSampleData, removeSampleData } from './sampleData'
import { seedIfEmpty } from './seed'

beforeEach(async () => {
  localStorage.clear()
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
  await seedIfEmpty()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadSampleData', () => {
  it.each(['2026-11-01T09:00:00', '2026-11-05T09:00:00', '2026-02-28T09:00:00', '2026-01-31T09:00:00', '2026-12-31T22:00:00'])(
    'on %s nothing is dated ahead of today, and every month has rows',
    async (now) => {
      vi.useFakeTimers({ now: new Date(now), toFake: ['Date'] })
      await loadSampleData()
      const rows = await db.transactions.toArray()
      const today = todayISO()
      expect(rows.filter((t) => t.date > today)).toEqual([])
      for (const d of [0, -1, -2, -3]) {
        expect(rows.filter((t) => t.date.startsWith(shiftMonth(currentMonth(), d))).length).toBeGreaterThan(9)
      }
      // Every date is a real one.
      expect(rows.every((t) => !Number.isNaN(Date.parse(t.date)) && /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true)
      // And Home has a budget to point at, whatever the day.
      const dining = (await db.categories.toArray()).find((c) => c.key === 'dining')!
      const spent = rows.filter((t) => t.categoryId === dining.id && t.date.startsWith(currentMonth())).reduce((s, t) => s + t.amount, 0)
      expect(spent).toBeGreaterThan(dining.monthlyBudget)
    },
  )

  it('fills in budgets, accounts of each kind, income, a refund and a row to sort', async () => {
    await loadSampleData()
    const cats = await db.categories.toArray()
    expect(cats.filter((c) => c.monthlyBudget > 0).length).toBeGreaterThan(5)
    expect(cats.filter((c) => c.kind === 'income').every((c) => c.monthlyBudget === 0)).toBe(true)

    const accounts = await db.accounts.toArray()
    expect(new Set(accounts.map((a) => a.type))).toEqual(new Set(['cash', 'credit', 'brokerage', 'retirement']))
    expect(accounts.every((a) => a.uid?.startsWith('sample:') && !a.liveSync)).toBe(true)

    const rows = (await db.transactions.toArray()).filter((t) => t.date.startsWith(currentMonth()))
    expect(rows.some((t) => t.type === 'income')).toBe(true)
    expect(rows.some((t) => t.amount < 0)).toBe(true)
    expect(rows.some((t) => t.type === 'expense' && t.categoryId == null)).toBe(true)
    const rent = cats.find(isRentCategory)!
    expect(rows.filter((t) => t.categoryId === rent.id)).toHaveLength(1)
  })

  it('keeps its unfiled row unfiled: the app files what it recognises on its own', async () => {
    await loadSampleData()
    const unfiled = (await db.transactions.toArray()).filter((t) => t.categoryId == null)
    expect(unfiled).toHaveLength(1)
    expect(guessCategoryName(unfiled[0].note, 'expense')).toBeNull()
  })

  it('files an expense only under a spending category, and income under income', async () => {
    await loadSampleData()
    const kind = new Map((await db.categories.toArray()).map((c) => [c.id, c.kind]))
    for (const t of await db.transactions.toArray()) {
      if (t.categoryId != null) expect(kind.get(t.categoryId)).toBe(t.type)
    }
  })

  it('tags every row, so removing it can find them all', async () => {
    await loadSampleData()
    const rows = await db.transactions.toArray()
    expect(rows.every((t) => t.uid?.startsWith('sample:'))).toBe(true)
    expect(new Set(rows.map((t) => t.uid)).size).toBe(rows.length)
  })

  it('loads once', async () => {
    await loadSampleData()
    const n = await db.transactions.count()
    await loadSampleData()
    expect(await db.transactions.count()).toBe(n)
    expect(await db.accounts.count()).toBe(5)
  })

  it('leaves a budget the user set', async () => {
    const groceries = (await db.categories.toArray()).find((c) => c.key === 'groceries')!
    await db.categories.update(groceries.id!, { monthlyBudget: 333 })
    await loadSampleData()
    expect((await db.categories.get(groceries.id!))?.monthlyBudget).toBe(333)
  })

  it('files nothing under a category the user deleted', async () => {
    const dining = (await db.categories.toArray()).find((c) => c.key === 'dining')!
    await db.categories.update(dining.id!, { deleted: true })
    await loadSampleData()
    expect((await db.transactions.toArray()).some((t) => t.categoryId === dining.id)).toBe(false)
    expect((await db.categories.get(dining.id!))?.monthlyBudget).toBe(0)
  })
})

describe('with a locked savings plan', () => {
  const lock = () => setPlan({ goal: 200, cap: 900, locked: true, since: '2031-01', pending: null, updatedAt: 1 })
  afterEach(() => void setPlan(null))

  it('the sample sets no budgets at all, and still loads its rows and accounts', async () => {
    const groceries = (await db.categories.toArray()).find((c) => c.key === 'groceries')!
    await db.categories.update(groceries.id!, { monthlyBudget: 333 })
    lock()
    await loadSampleData()
    const cats = await db.categories.toArray()
    expect(cats.filter((c) => c.monthlyBudget > 0).map((c) => [c.key, c.monthlyBudget])).toEqual([['groceries', 333]])
    expect(await db.transactions.count()).toBeGreaterThan(40)
    expect(await db.accounts.count()).toBe(5)
  })

  it('and removing it zeroes none', async () => {
    lock()
    await loadSampleData()
    // Budgets set by hand afterwards, one of them the amount the sample would have used.
    const dining = (await db.categories.toArray()).find((c) => c.key === 'dining')!
    await db.categories.update(dining.id!, { monthlyBudget: 240 })
    await removeSampleData()
    expect((await db.categories.get(dining.id!))?.monthlyBudget).toBe(240)
    expect(await db.transactions.count()).toBe(0)
  })

  it('with the lock off, the sample sets its budgets as before', async () => {
    setPlan({ goal: 200, cap: 900, locked: false, since: null, pending: null, updatedAt: 1 })
    await loadSampleData()
    expect((await db.categories.toArray()).filter((c) => c.monthlyBudget > 0).length).toBeGreaterThan(5)
  })
})

describe('removeSampleData', () => {
  it('leaves no trace on a ledger that had nothing else', async () => {
    await loadSampleData()
    expect(await hasSampleData()).toBe(true)
    await removeSampleData()
    expect(await hasSampleData()).toBe(false)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.accounts.count()).toBe(0)
    expect((await db.categories.toArray()).every((c) => c.monthlyBudget === 0)).toBe(true)
    expect(localStorage.getItem('plainsum:sampleBudgets')).toBeNull()
  })

  it('keeps what the user added or changed beside it', async () => {
    const groceries = (await db.categories.toArray()).find((c) => c.key === 'groceries')!
    await db.categories.update(groceries.id!, { monthlyBudget: 333 })
    await loadSampleData()
    const dining = (await db.categories.toArray()).find((c) => c.key === 'dining')!
    await db.categories.update(dining.id!, { monthlyBudget: 275 })
    await db.transactions.add({ date: todayISO(), amount: 9, type: 'expense', categoryId: null, account: '', note: 'Mine', createdAt: 1, updatedAt: 1 })
    await db.accounts.add({ institution: 'My Bank', name: 'Mine', type: 'cash', balance: 5, liveSync: false, lastUpdated: 1, sortOrder: 9, updatedAt: 1 })

    await removeSampleData()
    expect((await db.transactions.toArray()).map((t) => t.note)).toEqual(['Mine'])
    expect((await db.accounts.toArray()).map((a) => a.name)).toEqual(['Mine'])
    expect((await db.categories.get(groceries.id!))?.monthlyBudget).toBe(333)
    expect((await db.categories.get(dining.id!))?.monthlyBudget).toBe(275)
  })

  it('can be loaded again after', async () => {
    await loadSampleData()
    await removeSampleData()
    await loadSampleData()
    expect(await db.accounts.count()).toBe(5)
  })

  it('finds a sample account the user deleted too', async () => {
    await loadSampleData()
    const [a] = await db.accounts.toArray()
    await db.accounts.update(a.id!, { deleted: true })
    await removeSampleData()
    expect(await db.accounts.count()).toBe(0)
  })
})
