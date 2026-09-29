// @vitest-environment jsdom
/**
 * Activity ledger. The day-total helper is pinned in lib/ledger.test.ts. These
 * component tests guard the rest of the money contract: every row figure is the
 * stored amount (expenses unsigned, income '+'), loading never reads as an
 * empty month, and the 'Needs category' filter never offers a pending charge.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TransactionList } from './TransactionList'
import { db, type Category, type Transaction } from '../db/db'

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

const CATEGORIES: Category[] = [
  { id: 1, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 0, updatedAt: 0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
]

const AMEX = 'American Express American Express Green Card (6152)'
const MM = 'Citizens Bank Money Market Account (4837)'
const CHECKING = 'Citizens Bank Checking Account (4821)'
const CHECKING_2 = 'Citizens Bank Checking (5509)'

describe('TransactionList', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0))
    nextId = 1
    await db.transactions.clear()
  })

  afterEach(async () => {
    cleanup()
    vi.useRealTimers()
    await db.transactions.clear()
  })

  const seed = (rows: Transaction[]) => db.transactions.bulkPut(rows)
  const view = (month = '2026-09', active = true) => (
    <TransactionList month={month} categories={CATEGORIES} onEdit={() => {}} active={active} onAdd={() => {}} />
  )

  it('shows a skeleton, never an empty month, while the query is loading', async () => {
    await seed([txn({ date: '2026-09-17', amount: 7.46, categoryId: 1, account: AMEX, note: 'PayPal Pay in 4' })])
    const { container } = render(view())
    expect(container.querySelector('.skel-wrap')).not.toBeNull()
    expect(container.textContent).not.toMatch(/No transactions/)
    await screen.findByText('PayPal Pay in 4')
    expect(container.querySelector('.skel-wrap')).toBeNull()
  })

  it('groups by day with totals; expenses unsigned, income signed', async () => {
    await seed([
      txn({ date: '2026-09-21', amount: 70, pending: true, account: MM, note: 'American Express' }),
      txn({ date: '2026-09-21', amount: 14, pending: true, account: CHECKING, note: 'Robinhood' }),
      txn({ date: '2026-09-17', amount: 7.46, categoryId: 1, account: AMEX, note: 'PayPal Pay in 4' }),
      txn({ date: '2026-09-17', amount: 28.93, categoryId: 1, account: AMEX, note: 'PayPal Pay in 4' }),
      txn({ date: '2026-09-10', amount: 2968.21, type: 'income', categoryId: 7, account: CHECKING, note: 'Payroll' }),
    ])
    const { container } = render(view())
    await screen.findByText('Payroll')

    const heads = [...container.querySelectorAll('.txn-day-head')].map((h) => h.textContent)
    expect(heads).toEqual(['Yesterday$84.00', 'Thu, Sep 17$36.39', 'Thu, Sep 10'])
    expect(container.querySelector('.txn-count')?.textContent).toBe('5 transactions · 2 pending')

    const amts = [...container.querySelectorAll('.txn-amt')].map((a) => a.textContent)
    expect(amts).toEqual(['$14.00', '$70.00', '$28.93', '$7.46', '+$2,968.21'])

    const subs = [...container.querySelectorAll('.txn-sub')].map((s) => s.textContent)
    expect(subs[0]).toBe('Pending · Uncategorized · Citizens Checking')
    expect(subs[2]).toBe('Shopping · Amex Green')
    expect(subs[4]).toBe('Salary · Citizens Checking')
    // The date lives in the day heading, not in the row.
    expect(subs.join('|')).not.toMatch(/Sep \d/)
  })

  it('adds the mask only when two accounts read the same', async () => {
    await seed([
      txn({ date: '2026-09-15', amount: 12, categoryId: 1, account: CHECKING, note: 'A' }),
      txn({ date: '2026-09-15', amount: 13, categoryId: 1, account: CHECKING_2, note: 'B' }),
      txn({ date: '2026-09-15', amount: 14, categoryId: 1, account: AMEX, note: 'C' }),
    ])
    const { container } = render(view())
    await screen.findByText('C')
    const subs = [...container.querySelectorAll('.txn-sub')].map((s) => s.textContent)
    expect(subs).toEqual(['Shopping · Amex Green', 'Shopping · Citizens Checking ··5509', 'Shopping · Citizens Checking ··4821'])
  })

  it('offers no filter while every uncategorized row is pending', async () => {
    await seed([
      txn({ date: '2026-09-21', amount: 70, pending: true, account: MM, note: 'American Express' }),
      txn({ date: '2026-09-17', amount: 7.46, categoryId: 1, account: AMEX, note: 'PayPal Pay in 4' }),
    ])
    const { container } = render(view())
    await screen.findByText('American Express')
    expect(container.querySelector('.txn-filter')).toBeNull()
  })

  it('filters to posted uncategorized expenses and resets on a new month', async () => {
    await seed([
      txn({ date: '2026-09-21', amount: 70, pending: true, account: MM, note: 'American Express' }),
      txn({ date: '2026-09-18', amount: 42.5, account: CHECKING, note: 'Corner Store' }),
      txn({ date: '2026-09-17', amount: 7.46, categoryId: 1, account: AMEX, note: 'PayPal Pay in 4' }),
      txn({ date: '2026-08-03', amount: 9, account: CHECKING, note: 'August thing' }),
    ])
    const { container, rerender } = render(view())
    await screen.findByText('Corner Store')
    const tabs = within(container.querySelector('.txn-filter') as HTMLElement).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Needs category 1'])

    fireEvent.click(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect([...container.querySelectorAll('.txn-note')].map((n) => n.textContent)).toEqual(['Corner Store'])
    // One row under the heading: no total, which would only repeat its figure.
    expect(container.querySelector('.txn-day-head')?.textContent).toBe('Fri, Sep 18')
    // The month summary stays the month's, not the filter's.
    expect(container.querySelector('.txn-count')?.textContent).toBe('3 transactions · 1 pending')

    rerender(view('2026-08'))
    await screen.findByText('August thing')
    const tabs8 = within(container.querySelector('.txn-filter') as HTMLElement).getAllByRole('tab')
    expect(tabs8[0].getAttribute('aria-selected')).toBe('true')

    // Coming back to the month it was picked in does not restore it either.
    rerender(view('2026-09'))
    await screen.findByText('PayPal Pay in 4')
    const tabs9 = within(container.querySelector('.txn-filter') as HTMLElement).getAllByRole('tab')
    expect(tabs9[0].getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toMatch(/American Express/)
  })

  it('totals a day only when it has two or more expense rows', async () => {
    await seed([
      txn({ date: '2026-09-18', amount: 118, pending: true, account: CHECKING, note: 'Debit' }),
      txn({ date: '2026-09-15', amount: 47.86, categoryId: 1, account: AMEX, note: 'Amazon' }),
      txn({ date: '2026-09-15', amount: 21.99, categoryId: 1, account: AMEX, note: 'Apple' }),
      txn({ date: '2026-09-10', amount: 40, categoryId: 1, account: AMEX, note: 'Lunch' }),
      txn({ date: '2026-09-10', amount: 2968.21, type: 'income', categoryId: 7, account: CHECKING, note: 'Payroll' }),
    ])
    const { container } = render(view())
    await screen.findByText('Payroll')
    const heads = [...container.querySelectorAll('.txn-day-head')].map((h) => h.textContent)
    // One expense (with or without income beside it) reads from its own row.
    expect(heads).toEqual(['Fri, Sep 18', 'Tue, Sep 15$69.85', 'Thu, Sep 10'])
  })

  it('a pending row with nothing else to say reads Pending, with no trailing separator', async () => {
    await seed([txn({ date: '2026-09-18', amount: 50, type: 'income', pending: true, note: 'Refund' })])
    const { container } = render(view())
    await screen.findByText('Refund')
    const sub = container.querySelector('.txn-sub') as HTMLElement
    expect(sub.textContent).toBe('Pending')
    expect(sub.querySelector('.meta-sep')).toBeNull()
  })

  it('says which month is empty, and offers Add only for the current month', async () => {
    const past = render(view('2026-03'))
    await screen.findByText('No transactions in March 2026.')
    expect(past.container.querySelector('.txn-empty button')).toBeNull()
    past.unmount()

    const now = render(view('2026-09'))
    await screen.findByText('No transactions in September 2026.')
    expect(now.container.querySelector('.txn-empty button')?.textContent).toMatch(/Add a transaction/)
  })

  it('a hidden pane keeps what it showed until it is visible again', async () => {
    await seed([txn({ date: '2026-09-17', amount: 7.46, categoryId: 1, account: AMEX, note: 'First' })])
    const { container, rerender } = render(view())
    await screen.findByText('First')

    rerender(view('2026-09', false))
    await db.transactions.put(txn({ date: '2026-09-18', amount: 5, categoryId: 1, account: AMEX, note: 'Second' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(container.textContent).not.toMatch(/Second/)

    rerender(view('2026-09', true))
    await waitFor(() => expect(container.textContent).toMatch(/Second/))
  })
})
