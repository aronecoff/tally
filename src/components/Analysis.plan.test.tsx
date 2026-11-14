// @vitest-environment jsdom
/**
 * Insights' savings plan section, with the clock pinned: the average of whole
 * months since the lock began, set against the goal, in plain words. The
 * amounts are invented: an 800 goal and a 3,200 budget, locked from April 2031.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Analysis } from './Analysis'
import { db, type Category, type Transaction } from '../db/db'
import { setPlan } from '../lib/planCache'
import type { SavingsPlan } from '../lib/savingsPlan'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})
const CATS = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 1200), cat(9, 'Salary', 0, { kind: 'income' })]

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Store ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})
/** A month that took in `income` and spent `spend` over `purchases` charges. */
const month = (m: string, spend: number, income = 4000, purchases = 12): Transaction[] => [
  txn(`${m}-02`, Math.round((spend - (purchases - 1) * 10) * 100) / 100, 1),
  ...Array.from({ length: purchases - 1 }, (_, i) => txn(`${m}-${String(3 + i).padStart(2, '0')}`, 10, 2)),
  ...(income ? [txn(`${m}-15`, income, 9, { type: 'income' })] : []),
]
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3200, locked: true, since: '2031-04', pending: null, updatedAt: 1, ...extra })

async function renderAt(now: string, shown: string, txns: Transaction[]) {
  vi.setSystemTime(new Date(now))
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Analysis month={shown} categories={CATS} active />)
  await waitFor(() => expect(view.container.querySelector('.analysis')).not.toBeNull())
  return view.container
}
const section = (root: HTMLElement) => [...root.querySelectorAll('section')].find((s) => s.querySelector('.sect-title')?.textContent === 'Savings plan')
const row = (root: HTMLElement) => {
  const s = section(root)!
  const fig = s.querySelector('.an-fig')
  return {
    name: s.querySelector('.an-name')?.textContent ?? null,
    fig: fig?.textContent ?? null,
    tone: fig ? ['pos', 'over'].find((c) => fig.classList.contains(c)) ?? '' : null,
    sub: s.querySelector('.an-sub')?.textContent ?? null,
    said: s.querySelector('.an-mix-note')?.textContent ?? null,
  }
}
/** April, May and June, each spending the same. Today is in July. */
const three = (spend: number) => [...month('2031-04', spend), ...month('2031-05', spend), ...month('2031-06', spend), txn('2031-07-02', 50, 2), txn('2031-07-05', 4000, 9, { type: 'income' })]

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(async () => {
  cleanup()
  setPlan(null)
  vi.useRealTimers()
  await db.transactions.clear()
})

describe('the section', () => {
  it('is the first thing beside the hero, headed with the goal', async () => {
    setPlan(plan())
    const root = await renderAt('2031-07-10T12:00:00', '2031-07', three(3140))
    const s = section(root)!
    expect(root.querySelector('.an-side')?.firstElementChild).toBe(s)
    expect(s.querySelector('.sect-note')?.textContent).toBe('goal $800 a month')
    expect(s.querySelector('.cat-tile svg')).not.toBeNull()
  })

  it('is not there with no plan, or with the lock off', async () => {
    const root = await renderAt('2031-07-10T12:00:00', '2031-07', three(3140))
    expect(section(root)).toBeUndefined()
    cleanup()
    setPlan(plan({ locked: false, since: null }))
    expect(section(await renderAt('2031-07-10T12:00:00', '2031-07', three(3140)))).toBeUndefined()
  })

  it('is about now, so it stays off a past month', async () => {
    setPlan(plan())
    const root = await renderAt('2031-07-10T12:00:00', '2031-06', three(3140))
    expect(section(root)).toBeUndefined()
  })

  it('is there on the morning of the 1st, before the new month has any rows', async () => {
    setPlan(plan())
    const root = await renderAt('2031-07-01T08:00:00', '2031-07', [...month('2031-04', 3140), ...month('2031-05', 3140), ...month('2031-06', 3140)])
    expect(root.querySelector('.hero-state')?.textContent).toBe('No activity in July 2031.')
    expect(row(root)).toMatchObject({ fig: '$860', sub: '3 whole months · $60 above goal' })
    expect([...root.querySelectorAll('.analysis > section')]).toHaveLength(2)
  })
})

describe('the average row', () => {
  it('above the goal: green, with how far above', async () => {
    setPlan(plan())
    expect(row(await renderAt('2031-07-10T12:00:00', '2031-07', three(3140)))).toEqual({
      name: 'Saved a month, on average',
      fig: '$860',
      tone: 'pos',
      sub: '3 whole months · $60 above goal',
      said: 'Spending was inside the budget in 3 of 3 months. July is not counted until it ends.',
    })
  })

  it('on the goal to the cent', async () => {
    setPlan(plan())
    expect(row(await renderAt('2031-07-10T12:00:00', '2031-07', three(3200)))).toMatchObject({ fig: '$800', tone: 'pos', sub: '3 whole months · on goal' })
  })

  it('short of the goal but above zero: no colour, and it says how far short', async () => {
    setPlan(plan())
    expect(row(await renderAt('2031-07-10T12:00:00', '2031-07', three(3250)))).toEqual({
      name: 'Saved a month, on average',
      fig: '$750',
      tone: '',
      sub: '3 whole months · $50 short of goal',
      said: 'Spending was inside the budget in 0 of 3 months. July is not counted until it ends.',
    })
  })

  it('below zero: Overspent, in red', async () => {
    setPlan(plan())
    expect(row(await renderAt('2031-07-10T12:00:00', '2031-07', three(4120)))).toMatchObject({
      name: 'Overspent a month, on average',
      fig: '$120',
      tone: 'over',
      sub: '3 whole months · $920 short of goal',
    })
  })

  it('one whole month, inside the budget and then over it', async () => {
    setPlan(plan())
    const inside = row(await renderAt('2031-05-10T12:00:00', '2031-05', [...month('2031-04', 3140), txn('2031-05-02', 50, 2), txn('2031-05-03', 4000, 9, { type: 'income' })]))
    expect(inside).toMatchObject({ sub: '1 whole month · $60 above goal', said: 'Spending was inside the budget in April. May is not counted until it ends.' })
    cleanup()
    const over = row(await renderAt('2031-05-10T12:00:00', '2031-05', [...month('2031-04', 3250), txn('2031-05-02', 50, 2), txn('2031-05-03', 4000, 9, { type: 'income' })]))
    expect(over.said).toBe('Spending went over the budget in April. May is not counted until it ends.')
  })

  it('a month with fewer deposits can be short of the goal and still inside the budget', async () => {
    setPlan(plan())
    const rows = [...month('2031-04', 3100, 3500), ...month('2031-05', 3100, 3500), ...month('2031-06', 3100, 3500), txn('2031-07-02', 50, 2), txn('2031-07-05', 4000, 9, { type: 'income' })]
    expect(row(await renderAt('2031-07-10T12:00:00', '2031-07', rows))).toMatchObject({
      fig: '$400',
      tone: '',
      sub: '3 whole months · $400 short of goal',
      said: 'Spending was inside the budget in 3 of 3 months. July is not counted until it ends.',
    })
  })
})

describe('partial data', () => {
  const live = [txn('2031-07-02', 50, 2), txn('2031-07-05', 4000, 9, { type: 'income' })]
  const flagged = (root: HTMLElement) =>
    [...root.querySelectorAll('.cfc-col')].map((c) => c.getAttribute('aria-label') ?? '').filter((l) => l.endsWith(', partial data')).map((l) => l.split(':')[0])

  it('a counted month with 9 purchases is said, and one with 10 is not', async () => {
    setPlan(plan())
    const nine = await renderAt('2031-07-10T12:00:00', '2031-07', [...month('2031-04', 3140), ...month('2031-05', 3140, 4000, 9), ...month('2031-06', 3140), ...live])
    expect(row(nine).said).toBe('Spending was inside the budget in 3 of 3 months. 1 month has partial data. July is not counted until it ends.')
    // The chart flags the same month, by the same rule.
    expect(flagged(nine)).toEqual(['May 2031'])
    cleanup()
    const ten = await renderAt('2031-07-10T12:00:00', '2031-07', [...month('2031-04', 3140), ...month('2031-05', 3140, 4000, 10), ...month('2031-06', 3140), ...live])
    expect(row(ten).said).toBe('Spending was inside the budget in 3 of 3 months. July is not counted until it ends.')
    expect(flagged(ten)).toEqual([])
  })

  it('a counted month with no rows at all is partial too, and still counts in the average', async () => {
    setPlan(plan())
    const root = await renderAt('2031-07-10T12:00:00', '2031-07', [...month('2031-04', 3140), ...month('2031-06', 3140, 4000, 4), ...live])
    // 860 + 0 + 860 over three months.
    expect(row(root)).toMatchObject({
      fig: '$573.33',
      sub: '3 whole months · $226.67 short of goal',
      said: 'Spending was inside the budget in 3 of 3 months. 2 months have partial data. July is not counted until it ends.',
    })
  })
})

describe('before any whole month is counted', () => {
  it('in the month the lock was turned on, it says when counting starts, and shows no average', async () => {
    setPlan(plan({ since: '2031-05' }))
    const root = await renderAt('2031-04-20T12:00:00', '2031-04', [...month('2031-03', 3140), txn('2031-04-02', 900, 1), txn('2031-04-05', 4000, 9, { type: 'income' })])
    const s = section(root)!
    expect(s.querySelector('.an-row')).toBeNull()
    expect(s.querySelector('.an-mix-note')?.textContent).toBe('Counting starts with May, the first whole month. The average shows when it ends.')
  })

  it('in the first month counted, it says so', async () => {
    setPlan(plan({ since: '2031-04' }))
    const root = await renderAt('2031-04-20T12:00:00', '2031-04', [...month('2031-03', 3140), txn('2031-04-02', 900, 1), txn('2031-04-05', 4000, 9, { type: 'income' })])
    const s = section(root)!
    expect(s.querySelector('.an-row')).toBeNull()
    expect(s.querySelector('.an-mix-note')?.textContent).toBe('April is the first month counted. The average shows when it ends.')
  })
})

describe('the live month before payday', () => {
  it('is said by the hero above, and the section holds no figure for it', async () => {
    setPlan(plan())
    const rows = [...month('2031-04', 3140), ...month('2031-05', 3140), ...month('2031-06', 3140), txn('2031-07-01', 1937.25, 1), txn('2031-07-02', 61.5, 2)]
    const root = await renderAt('2031-07-04T12:00:00', '2031-07', rows)
    expect(root.querySelector('.hero-state')?.textContent).toBe('No income yet')
    const s = section(root)!
    // Whole months only: green, whatever the live month has spent so far.
    expect(row(root)).toMatchObject({ fig: '$860', tone: 'pos', sub: '3 whole months · $60 above goal' })
    expect(s.textContent).not.toMatch(/1,998|1,937|61\.5|Overspent/)
    expect([...s.querySelectorAll('.num')].map((n) => n.textContent)).toEqual(['goal $800 a month', '$860', '3 whole months · $60 above goal'])
  })
})
