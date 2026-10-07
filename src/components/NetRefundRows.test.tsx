// @vitest-environment jsdom
/**
 * Rows whose refunds outweigh their purchases on Home and Budget, with the
 * clock pinned. Values are invented.
 *  - An uncategorized refund bigger than the uncategorized purchases hid the
 *    Uncategorized row: the purchase that needs a category vanished, Home said
 *    'Nothing needs you', and the sort queue could not be reached from Home.
 *  - A net refund in a category with no budget vanished from both lists.
 * Either way the rows no longer added up to the month's spending.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Home } from './Home'
import { Dashboard } from './Dashboard'
import { db, type Category, type Transaction } from '../db/db'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})
let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})
const CATS = [cat(2, 'Shopping', 1150), cat(3, 'Dining', 300), cat(4, 'Returns', 0), cat(9, 'Salary', 0, { kind: 'income' })]
const money = (s: string | null | undefined) => Number(String(s ?? '').replace(/[^\d.−-]/g, '').replace('−', '-'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-12T12:00:00'))
  try {
    localStorage.setItem('tally-home-detail', '1')
  } catch {
    /* storage blocked */
  }
})
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

async function homeOf(rows: Transaction[], onSort = () => {}) {
  await db.transactions.bulkAdd(rows)
  const view = render(<Home categories={CATS} onEdit={() => {}} onMore={() => {}} active onSort={onSort} />)
  await waitFor(() => expect(view.container.querySelector('.home-hero')).not.toBeNull())
  return view.container
}
async function budgetOf(rows: Transaction[]) {
  await db.transactions.bulkAdd(rows)
  const view = render(<Dashboard month="2026-10" categories={CATS} active />)
  await waitFor(() => expect(view.container.querySelector('.bud-list')).not.toBeNull())
  return view.container
}
const homeRows = (root: HTMLElement) =>
  [...root.querySelectorAll('.home-brow')].map((r) => [r.querySelector('.traj-name')?.textContent, money(r.querySelector('.traj-figs strong')?.textContent)] as const)
const budgetRows = (root: HTMLElement) =>
  [...root.querySelectorAll('.bud-cat:not(.bud-idle)')].map((r) => [r.querySelector('.traj-name')?.textContent, money(r.querySelector('.traj-figs strong')?.textContent)] as const)
const sum = (rows: readonly (readonly [unknown, number])[]) => Math.round(rows.reduce((s, [, v]) => s + v, 0) * 100) / 100

describe('an uncategorized refund bigger than the uncategorized purchases', () => {
  const OCT = () => [
    txn('2026-10-02', 200, 2),
    txn('2026-10-03', 40, 3),
    txn('2026-10-04', 30, null, { note: 'ACME WIDGETS' }),
    txn('2026-10-05', -90, null, { note: 'ZENTRIX OUTFITTERS' }),
    txn('2026-10-01', 5000, 9, { type: 'income' }),
  ]

  it('Home lists Uncategorized as needing you, and its rows add up to Spending', async () => {
    const onSort = vi.fn()
    const root = await homeOf(OCT(), onSort)
    expect(root.textContent).not.toContain('Nothing needs you')
    const needs = [...root.querySelectorAll('.home-row')].find((r) => r.querySelector('.traj-name')?.textContent === 'Uncategorized')
    expect(needs?.querySelector('.traj-meta')?.textContent).toBe('2 to categorize')
    ;(needs!.closest('li') as HTMLElement).click()
    expect(onSort).toHaveBeenCalled()
    const rows = homeRows(root)
    expect(rows).toContainEqual(['Uncategorized', -60])
    expect(sum(rows)).toBe(180)
  })

  it('Budget lists Uncategorized, and its rows add up to the hero', async () => {
    const root = await budgetOf(OCT())
    const rows = budgetRows(root)
    expect(rows).toContainEqual(['Uncategorized', -60])
    expect(sum(rows)).toBe(money(root.querySelector('.hero-fig')?.textContent))
    const uncat = [...root.querySelectorAll('.bud-cat')].find((r) => r.querySelector('.traj-name')?.textContent === 'Uncategorized')
    expect(uncat?.querySelector('.traj-meta')?.textContent).toBe('2 to categorize')
  })
})

describe('a net refund in a category with no budget', () => {
  const OCT = () => [txn('2026-10-02', 200, 2), txn('2026-10-03', 40, 3), txn('2026-10-06', -55.5, 4, { note: 'Big Store refund' })]

  it('stays on Home', async () => {
    const root = await homeOf(OCT())
    const rows = homeRows(root)
    expect(rows).toContainEqual(['Returns', -55.5])
    expect(sum(rows)).toBe(184.5)
  })

  it('stays on Budget, and the rows add up to the hero', async () => {
    const root = await budgetOf(OCT())
    const rows = budgetRows(root)
    expect(rows).toContainEqual(['Returns', -55.5])
    expect(sum(rows)).toBe(money(root.querySelector('.hero-fig')?.textContent))
  })

  it('an unbudgeted category with nothing this month is still left out', async () => {
    const root = await budgetOf([txn('2026-10-02', 200, 2)])
    expect(budgetRows(root).map(([n]) => n)).not.toContain('Returns')
  })
})
