/**
 * Home's figures with a locked savings plan: the month is measured against the
 * plan's budget, never against what the category budgets add up to. Category
 * rows keep their own budgets. The amounts are invented.
 */
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../db/db'
import { homeFigures, homeHero, type HomeInput } from './homeFigures'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})
let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})

// Category budgets add up to 3,350.
const cats = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 1350), cat(9, 'Salary', 0, { kind: 'income' })]
const monthTxns = [
  ...[3, 6, 9, 12].map((d) => txn(`2031-04-${String(d).padStart(2, '0')}`, 475, 1)),
  ...[4, 8, 11].map((d) => txn(`2031-04-${String(d).padStart(2, '0')}`, 400, 2)),
  txn('2031-04-10', 3400, 9, { type: 'income' }),
]
const input = (extra: Partial<HomeInput> = {}): HomeInput => ({ monthTxns, recentTxns: monthTxns, month: '2031-04', cats, daysInMonth: 30, dayOfMonth: 15, ...extra })

describe('with a budget in force', () => {
  it('the total is that budget, and the hero follows it', () => {
    const d = homeFigures(input({ cap: 3000 }))
    expect(d.totalBudget).toBe(3000)
    expect(d.spend).toBe(3100)
    const hero = homeHero(d, 15, 30)
    expect(hero).toMatchObject({ overBudget: true, stateWord: 'Over budget', value: 100, unit: 'over', budgetLine: 'of $3,000 budget', budgetPct: 100, forecast: null })
  })

  it('under it, what is left and the rail are against it', () => {
    const d = homeFigures(input({ cap: 4000 }))
    const hero = homeHero(d, 15, 30)
    expect(hero).toMatchObject({ overBudget: false, value: 900, unit: 'left', budgetLine: 'of $4,000 budget', budgetPct: 77.5 })
    // The forecast is the same projection, now set against the budget in force.
    expect(hero.overPaceBudget).toBe(d.projectedTotal > 4000)
  })

  it('category rows are the same, each against its own budget', () => {
    const plain = homeFigures(input())
    const capped = homeFigures(input({ cap: 3000 }))
    expect(capped.rows).toEqual(plain.rows)
    expect(capped).toEqual({ ...plain, totalBudget: 3000 })
  })
})

describe('with none in force', () => {
  it('everything is what it was: the total is what the category budgets add up to', () => {
    const plain = homeFigures(input())
    expect(plain.totalBudget).toBe(3350)
    expect(homeFigures(input({ cap: null }))).toEqual(plain)
    expect(homeFigures(input({ cap: undefined }))).toEqual(plain)
    expect(homeHero(plain, 15, 30)).toMatchObject({ overBudget: false, value: 250, unit: 'left', budgetLine: 'of $3,350 budget' })
  })
})
