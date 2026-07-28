// @vitest-environment jsdom
/**
 * Regression guard for a ledger-affecting rule:
 *
 *   Toggling Expense <-> Income must NEVER destroy the picked category.
 *
 * The original code cleared it from an effect, and that effect's
 * `if (categoryId == null) return` guard meant it never came back — so a
 * mis-tap on an already-categorized transaction silently saved
 * `categoryId: null` over real data and dropped the row out of its budget
 * totals. The category's validity for the current kind is a VIEW concern
 * (derive it), not a reason to throw the user's choice away.
 *
 * This is a component test on purpose: a unit test of the derivation helper
 * would still pass if someone re-added a clearing setState, which is exactly
 * the regression worth catching.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TransactionSheet } from './TransactionSheet'
import { db, type Category, type Transaction } from '../db/db'

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
]

const TXN: Transaction = {
  id: 42,
  date: '2026-07-24',
  amount: 74.3,
  type: 'expense',
  categoryId: 1, // Groceries
  account: 'Amex',
  note: "TRADER JOE'S #189",
  createdAt: 0,
  updatedAt: 0,
}

/** Which category chip is highlighted, by label. */
const selectedChip = () =>
  screen
    .getAllByRole('button')
    .filter((b) => b.className.includes('chip') && b.className.includes('on'))
    .map((b) => b.textContent?.trim())

const seg = (label: string) =>
  screen.getAllByRole('button').find((b) => b.textContent?.trim() === label)!

beforeEach(async () => {
  await db.open()
  await db.transactions.clear()
  await db.transactions.add(TXN)
})

afterEach(() => {
  cleanup()
})

describe('TransactionSheet — expense/income toggle', () => {
  it('keeps the picked category through an Expense -> Income -> Expense round-trip', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)

    // Opens on the stored category.
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    // Income has no Groceries — nothing valid is selected while we're here.
    fireEvent.click(seg('Income'))
    expect(selectedChip()).toEqual([])
    expect(screen.getByText('Salary')).toBeTruthy()

    // Back to Expense: the choice survived. The old code left this empty and
    // then persisted categoryId: null on save.
    fireEvent.click(seg('Expense'))
    expect(selectedChip()).toEqual(['Groceries'])
  })

  it('saves the category the user can see after the round-trip', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    fireEvent.click(seg('Income'))
    fireEvent.click(seg('Expense'))
    fireEvent.click(screen.getByText('Save changes'))

    // What is written must match what was highlighted — no silent null.
    await waitFor(async () => {
      const saved = await db.transactions.get(42)
      expect(saved?.categoryId).toBe(1)
      expect(saved?.type).toBe('expense')
    })
  })

  it('saves no category when the sheet is left on the other kind', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    // Switching kind and saving must not carry an expense category onto income.
    fireEvent.click(seg('Income'))
    expect(selectedChip()).toEqual([])
    fireEvent.click(screen.getByText('Save changes'))

    await waitFor(async () => {
      const saved = await db.transactions.get(42)
      expect(saved?.type).toBe('income')
      expect(saved?.categoryId).toBeNull()
    })
  })
})
