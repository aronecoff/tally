// @vitest-environment jsdom
/**
 * Pins the two display-only sums the Budget screen adds (money is reconciled
 * to the cent, so a new figure on screen must be provably made of figures
 * already there):
 *
 *   - the hero note '$X of this has no budget' = Other + Uncategorized (every
 *     row with no budget and some spend), shown only on a pace or over month;
 *   - the idle group 'Nothing yet · $X ready' = the budgets of the untouched
 *     categories (budget > 0, nothing spent, nothing filed).
 *
 * The fixture is an illustrative September 2026 on day 22: $5,525.66 spent
 * against $6,375 of budgets, projected ~$6,774, so the hero reads 'Likely to go over'.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'

const cat = (id: number, name: string, monthlyBudget: number, sortOrder: number, kind: Category['kind'] = 'expense'): Category => ({
  id,
  name,
  icon: 'tag',
  color: '#fff',
  kind,
  monthlyBudget,
  sortOrder,
  updatedAt: 0,
})

const CATEGORIES: Category[] = [
  cat(1, 'Groceries', 400, 0),
  cat(2, 'Dining', 800, 1),
  cat(3, 'Rent', 2875, 2),
  cat(4, 'Transport', 600, 3),
  cat(5, 'Subscriptions', 250, 4),
  cat(6, 'Health', 150, 5),
  cat(7, 'Shopping', 1150, 6),
  cat(8, 'Fun', 150, 7),
  cat(9, 'Other', 0, 8),
  cat(20, 'Salary', 0, 0, 'income'),
]

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++,
  date,
  amount,
  type: 'expense',
  categoryId,
  account: 'Card',
  note: `T${nextId}`,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

const SEPTEMBER: Transaction[] = [
  txn('2026-09-01', 2875, 3),
  txn('2026-09-14', 1742.58, 9),
  txn('2026-09-05', 296.18, 7),
  txn('2026-09-08', 214.53, 4),
  txn('2026-09-03', 84.97, 5),
  // Uncategorized: four pending charges, $312.40 in all.
  txn('2026-09-20', 64.2, null, { pending: true }),
  txn('2026-09-21', 91.35, null, { pending: true }),
  txn('2026-09-21', 88.65, null, { pending: true }),
  txn('2026-09-22', 68.2, null, { pending: true }),
  txn('2026-09-15', 2984.37, 20, { type: 'income' }),
]

async function renderMonth(month: string, txns: Transaction[]) {
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Dashboard month={month} categories={CATEGORIES} active />)
  await waitFor(() => expect(view.container.querySelector('.bud-list')).not.toBeNull())
  return view.container
}

const figureOf = (root: HTMLElement, key: string) => {
  const t = root.querySelector(`#bud-${key} .traj-figs strong`)?.textContent ?? ''
  return Number(t.replace(/[$,]/g, ''))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-22T12:00:00'))
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

describe('Budget hero: unbudgeted note', () => {
  it('equals Other + Uncategorized, to the cent', async () => {
    const root = await renderMonth('2026-09', SEPTEMBER)
    expect(root.querySelector('.hero-state')?.textContent).toBe('Likely to go over')

    const other = figureOf(root, '9')
    const uncat = figureOf(root, 'uncat')
    expect(other).toBe(1742.58)
    expect(uncat).toBe(312.4)

    const note = root.querySelector('.bud-cap-note')?.textContent
    expect(note).toBe(`${money(other + uncat)} of this has no budget`)
    expect(note).toBe('$2,054.98 of this has no budget')
  })

  it('is not shown on an on-track month', async () => {
    // Same month without the big Other payment: projected under the budget.
    const root = await renderMonth('2026-09', SEPTEMBER.filter((t) => t.amount !== 1742.58))
    expect(root.querySelector('.hero-state')?.textContent).toBe('On track')
    expect(root.querySelector('.bud-cap-note')).toBeNull()
  })

  it('shows on an over month, and the caption carries the overage', async () => {
    const august = [
      txn('2026-08-01', 2875, 3),
      txn('2026-08-10', 3894.17, 7),
      txn('2026-08-12', 3517.62, 9),
      txn('2026-08-20', 986.45, null),
    ]
    const root = await renderMonth('2026-08', august)
    expect(root.querySelector('.hero-state')?.textContent).toBe('Over budget')
    expect(root.querySelector('.hero-caption')?.textContent).toBe(`${money(11273.24 - 6375)} over a $6,375 budget`)
    expect(root.querySelector('.bud-cap-note')?.textContent).toBe(`${money(3517.62 + 986.45)} of this has no budget`)
  })

  it('gives a past month with nothing in it no verdict: no state word, no sage', async () => {
    const root = await renderMonth('2026-03', [])
    expect(root.querySelector('.hero-state')).toBeNull()
    expect(root.querySelector('.hero-fig')?.textContent).toBe('$0.00')
    expect(root.querySelector('.bud-meta .pos, .bud-meta .over')).toBeNull()
    // The current month keeps its verdict even before anything is spent.
    cleanup()
    const now = await renderMonth('2026-09', [])
    expect(now.querySelector('.hero-state')?.textContent).toBe('On track')
  })
})

describe('Budget list: idle group', () => {
  it('sums the budgets of untouched categories', async () => {
    const root = await renderMonth('2026-09', SEPTEMBER)
    // Groceries, Dining, Health and Fun: budgeted, nothing spent, nothing filed.
    const idle = [...root.querySelectorAll('.bud-idle .traj-name')].map((n) => n.textContent)
    expect(idle).toEqual(['Groceries', 'Dining', 'Health', 'Fun'])
    const sum = CATEGORIES.filter((c) => idle.includes(c.name)).reduce((s, c) => s + c.monthlyBudget, 0)
    expect(root.querySelector('.bud-group')?.textContent).toBe(`Nothing yet · ${money(sum, { trim: true })} ready`)
    expect(root.querySelector('.bud-group')?.textContent).toBe('Nothing yet · $1,500 ready')
  })

  it('puts Uncategorized first among the unbudgeted rows', async () => {
    const root = await renderMonth('2026-09', SEPTEMBER)
    const order = [...root.querySelectorAll('.bud-cat:not(.bud-idle) .traj-name')].map((n) => n.textContent)
    expect(order).toEqual(['Uncategorized', 'Other', 'Rent', 'Shopping', 'Transport', 'Subscriptions'])
    // Pending-only: never routed into categorizing.
    expect(root.querySelector('#bud-uncat .traj-meta')?.textContent).toBe('4 pending · categorize once posted')
  })
})

describe('Budget: opened from another screen', () => {
  it('expands the requested row once per nonce and brings it into view', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await db.transactions.clear()
    await db.transactions.bulkAdd(SEPTEMBER)
    const consumed = vi.fn()
    const view = render(
      <Dashboard month="2026-09" categories={CATEGORIES} active initialOpen={{ key: 'uncat', n: 1 }} onInitialOpenConsumed={consumed} />,
    )
    await waitFor(() => expect(view.container.querySelector('#bud-uncat.open .bud-txns')).not.toBeNull())
    expect(consumed).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'nearest' }))
    // The same nonce again is a no-op; a new one re-applies.
    view.rerender(<Dashboard month="2026-09" categories={CATEGORIES} active initialOpen={{ key: 'uncat', n: 1 }} onInitialOpenConsumed={consumed} />)
    expect(consumed).toHaveBeenCalledTimes(1)
    view.rerender(<Dashboard month="2026-09" categories={CATEGORIES} active initialOpen={{ key: '9', n: 2 }} onInitialOpenConsumed={consumed} />)
    await waitFor(() => expect(view.container.querySelector('#bud-9.open')).not.toBeNull())
    expect(consumed).toHaveBeenCalledTimes(2)
  })
})

describe('Budget loading', () => {
  it('shows a skeleton, never a false $0.00, before the query resolves', () => {
    const { container } = render(<Dashboard month="2026-09" categories={CATEGORIES} active />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.textContent).not.toContain('$0.00')
  })
})
