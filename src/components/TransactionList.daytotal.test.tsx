// @vitest-environment jsdom
/**
 * B106: a day whose refunds outweighed its purchases lost its total in the
 * Activity day heading. It now reads as money back ('+$85.00', green); a day
 * with a single expense row still shows no total. Values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TransactionList } from './TransactionList'
import { db, type Category, type Transaction } from '../db/db'

let nextId = 1
const txn = (date: string, amount: number, note: string): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId: 1, account: 'Card', note, createdAt: 0, updatedAt: 0,
})
const CATEGORIES: Category[] = [
  { id: 1, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 0, updatedAt: 0 },
]

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0))
  await db.transactions.clear()
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

async function heads(rows: Transaction[]) {
  await db.transactions.bulkPut(rows)
  const { container } = render(
    <TransactionList month="2026-09" categories={CATEGORIES} onEdit={() => {}} active onAdd={() => {}} />,
  )
  await screen.findByText(rows[0].note)
  return [...container.querySelectorAll('.txn-day-head')]
}

describe('B106: the day total', () => {
  it('a day that nets to money back reads +$x in the money-back colour', async () => {
    const [head] = await heads([txn('2026-09-27', 20, 'A'), txn('2026-09-27', 25, 'B'), txn('2026-09-27', -30, 'C'), txn('2026-09-27', -100, 'D')])
    expect(head.textContent).toBe('Sun, Sep 27+$85.00')
    expect(head.querySelector('.num')?.classList.contains('pos')).toBe(true)
  })

  it('a day that nets to exactly zero shows $0.00, uncoloured', async () => {
    const [head] = await heads([txn('2026-09-15', 20, 'A'), txn('2026-09-15', -20, 'B')])
    expect(head.textContent).toBe('Tue, Sep 15$0.00')
    expect(head.querySelector('.num')?.classList.contains('pos')).toBe(false)
  })

  it('a day with a single refund still shows no total', async () => {
    const [head] = await heads([txn('2026-09-10', -5, 'A')])
    expect(head.textContent).toBe('Thu, Sep 10')
  })
})
