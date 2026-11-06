// @vitest-environment jsdom
/**
 * The widget shows Home's figures or none. Each case renders Home and builds a
 * snapshot from the same rows, so a change to either that parts them fails here.
 * The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Home } from '../components/Home'
import { db, type Category, type Transaction } from '../db/db'
import { buildWidgetSnapshot } from './widgetSnapshot'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})

const CATS = [cat(1, 'Rent', 1200), cat(2, 'Shopping', 500.5), cat(3, 'Dining', 300), cat(9, 'Salary', 0, { kind: 'income' })]

async function both(now: string, txns: Transaction[], categories: Category[] = CATS) {
  vi.setSystemTime(new Date(now))
  await db.transactions.clear()
  await db.categories.clear()
  await db.transactions.bulkAdd(txns)
  await db.categories.bulkAdd(categories)
  const view = render(<Home categories={categories.filter((c) => !c.deleted)} onEdit={() => {}} onMore={() => {}} active />)
  await waitFor(() => expect(view.container.querySelector('.home-hero')).not.toBeNull())
  const hero = view.container.querySelector('.home-hero')!
  const text = (s: string) => hero.querySelector(s)?.textContent ?? null
  return {
    snapshot: await buildWidgetSnapshot(),
    label: text('.hero-label'),
    state: text('.hero-state'),
    stateClass: hero.querySelector('.hero-state')?.classList.item(1) ?? null,
    figure: text('.hero-fig'),
    caption: text('.hero-caption'),
    rail: hero.querySelector<HTMLElement>('.rail-fill')?.style.getPropertyValue('--p') ?? null,
    pace: hero.querySelector<HTMLElement>('.traj-pace')?.style.left ?? null,
  }
}

function agrees(home: Awaited<ReturnType<typeof both>>) {
  const s = home.snapshot
  expect(s.hasBudget).toBe(true)
  expect(s.label).toBe(home.label)
  expect(s.stateWord).toBe(home.state)
  expect(s.state).toBe(home.stateClass)
  expect(`${s.whole}${s.cents} ${s.unit}`).toBe(home.figure)
  expect(s.forecast ? `${s.budgetLine} · ${s.forecast}` : s.budgetLine).toBe(home.caption)
  expect(String(s.rail)).toBe(home.rail)
  expect(`${s.pace * 100}%`).toBe(home.pace)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('The widget says what Home says', () => {
  it('on track, with cents', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-01', 1200, 1), txn('2026-10-03', 60.15, 2), txn('2026-10-04', 25.5, 3)])
    agrees(home)
    expect(home.snapshot).toMatchObject({ stateWord: 'On track', whole: '$714', cents: '.85', unit: 'left', over: false, left: 714.85 })
  })

  it('early in the month, with no forecast yet', async () => {
    const home = await both('2026-10-03T12:00:00', [txn('2026-10-01', 20, 3)])
    agrees(home)
    expect(home.snapshot.forecast).toBe('')
  })

  it('likely to go over', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-01', 1200, 1), txn('2026-10-03', 240, 2), txn('2026-10-05', 180, 3)])
    agrees(home)
    expect(home.snapshot).toMatchObject({ state: 'pace', stateWord: 'Likely to go over', unit: 'left' })
  })

  it('over budget, where the figure is what is over', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-01', 1200, 1), txn('2026-10-03', 700, 2), txn('2026-10-05', 120.25, 3)])
    agrees(home)
    expect(home.snapshot).toMatchObject({ state: 'over', stateWord: 'Over budget', whole: '$19', cents: '.75', unit: 'over', over: true, left: -19.75 })
    expect(home.snapshot.forecast).toBe('')
    expect(home.snapshot.rail).toBe(1)
  })

  it('exactly on budget reads as nothing left, never over', async () => {
    const home = await both('2026-10-31T12:00:00', [txn('2026-10-01', 1200, 1), txn('2026-10-03', 500.5, 2), txn('2026-10-05', 300, 3)])
    agrees(home)
    expect(home.snapshot).toMatchObject({ whole: '$0', cents: '.00', unit: 'left', over: false, left: 0 })
  })

  it('counts what Home counts and leaves out what Home leaves out', async () => {
    const home = await both('2026-10-20T12:00:00', [
      txn('2026-10-01', 1200, 1),
      txn('2026-10-02', 90, 2),
      txn('2026-10-04', -30.1, 2, { note: 'REFUND Shop' }), // a refund offsets
      txn('2026-10-06', 15.2, null), // uncategorized still counts
      txn('2026-10-09', 40, 3, { pending: true }), // a hold still counts
      txn('2026-10-10', 55, 3, { deleted: true }), // a deleted row does not
      txn('2026-10-11', 900, 9, { type: 'income' }), // income is not spending
      txn('2026-11-01', 1200, 1), // rent dated to the 1st it pays for
      txn('2026-09-30', 80, 2), // last month
    ])
    agrees(home)
    expect(home.snapshot.spent).toBe(1315.1)
  })

  it('reads as far back as Home does, or a monthly bill would be paced', async () => {
    // Late in the month: only rows more than 100 days old make the car payment a
    // bill, and that is what keeps the forecast inside the budget.
    const cats = [cat(1, 'Transport', 1000), cat(2, 'Rent', 0)]
    const bill = (date: string) => txn(date, 300, 1, { note: 'Harbor Auto Finance' })
    const home = await both('2026-10-29T12:00:00', [bill('2026-07-01'), bill('2026-08-01'), bill('2026-09-01'), bill('2026-10-01'), txn('2026-10-02', 90, 1)], cats)
    agrees(home)
    expect(home.snapshot.stateWord).toBe('On track')
  })

  it('a month of nothing but refunds stays a snapshot the app will take', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-03', -50.25, 2, { note: 'REFUND Shop' })])
    agrees(home)
    expect(home.snapshot).toMatchObject({ rail: 0, spent: -50.25, whole: '$2,050', cents: '.75' })
  })

  it('names no merchant, category or account', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-03', 60, 2, { note: 'Harbor Coffee', account: 'Everyday Checking' })])
    const json = JSON.stringify(home.snapshot)
    for (const word of ['Harbor', 'Coffee', 'Everyday', 'Checking', 'Shopping', 'Rent', 'Dining']) expect(json).not.toContain(word)
  })

  it('with no budget says so and carries no figure the widget could show as one', async () => {
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-03', 60, 2)], CATS.map((c) => ({ ...c, monthlyBudget: 0 })))
    expect(home.snapshot).toMatchObject({ hasBudget: false, budget: 0, rail: 0 })
  })

  it('a removed category loses its budget and keeps its spending, as on Home', async () => {
    const cats = [...CATS, cat(4, 'Old', 400, { deleted: true })]
    const home = await both('2026-10-12T12:00:00', [txn('2026-10-03', 60, 4)], cats)
    agrees(home)
    expect(home.snapshot.budget).toBe(2000.5)
  })
})
