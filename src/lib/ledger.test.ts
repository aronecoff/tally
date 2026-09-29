/**
 * Activity's day totals are display-only sums, so the helper is pinned to "the
 * sum of that day's expense rows, to the cent" (pending included, income
 * excluded), and to keeping the sorted row order.
 */
import { describe, expect, it } from 'vitest'
import { groupByDay } from './ledger'
import { money } from './format'
import type { Transaction } from '../db/db'

let nextId = 1
const txn = (p: Partial<Transaction> & Pick<Transaction, 'date' | 'amount'>): Transaction => ({
  id: nextId++,
  type: 'expense',
  categoryId: null,
  account: '',
  note: '',
  createdAt: 0,
  updatedAt: 0,
  ...p,
})

describe('groupByDay', () => {
  it('keeps the sorted order and makes one group per day', () => {
    const rows = [
      txn({ date: '2026-09-21', amount: 70 }),
      txn({ date: '2026-09-21', amount: 163.4 }),
      txn({ date: '2026-09-17', amount: 7.46 }),
      txn({ date: '2026-09-10', amount: 2968.21, type: 'income' }),
    ]
    const g = groupByDay(rows)
    expect(g.map((d) => d.date)).toEqual(['2026-09-21', '2026-09-17', '2026-09-10'])
    expect(g.map((d) => d.rows.length)).toEqual([2, 1, 1])
    expect(g.flatMap((d) => d.rows)).toEqual(rows)
  })

  it("sums the day's expense rows to the cent, pending included, income excluded", () => {
    const sep17 = [7.46, 28.93, 4.87, 13.62, 3.18].map((amount) => txn({ date: '2026-09-17', amount }))
    const sep21 = [
      txn({ date: '2026-09-21', amount: 70, pending: true }),
      txn({ date: '2026-09-21', amount: 163.4, pending: true }),
      txn({ date: '2026-09-21', amount: 14, pending: true }),
      txn({ date: '2026-09-21', amount: 500, type: 'income' }),
    ]
    const [d21, d17] = groupByDay([...sep21, ...sep17])
    expect(d21.out).toBe(247.4)
    expect(d17.out).toBe(58.06) // exact: plain float addition gives 58.059999999999995
    // The shown total is the sum of the shown row figures.
    const shown = (d: typeof d17) =>
      d.rows.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(money(t.amount).replace(/[$,]/g, '')) * 100, 0) / 100
    expect(money(d17.out)).toBe(money(shown(d17)))
    expect(money(d21.out)).toBe('$247.40')
  })

  it('an income-only day has no spend', () => {
    expect(groupByDay([txn({ date: '2026-09-10', amount: 2968.21, type: 'income' })])[0].out).toBe(0)
    expect(groupByDay([])).toEqual([])
  })
})
