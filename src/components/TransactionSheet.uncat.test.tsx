// @vitest-environment jsdom
/**
 * B51: clearing a charge's category by hand is a choice. The self-heal that
 * files empty categories (banks.recategorizeUncategorized) re-filed it at the
 * next focus. The sheet now records the choice, and only that choice.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { TransactionSheet } from './TransactionSheet'
import { recategorizeUncategorized } from '../lib/banks'
import { db, type Category, type Transaction } from '../db/db'

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
]
const TXN: Transaction = {
  id: 42, uid: 'sf:t42', date: '2026-07-24', amount: 74.3, type: 'expense', categoryId: 1, account: 'Amex', note: "TRADER JOE'S #123",
  createdAt: 0, updatedAt: 0,
}
const chip = (label: string) =>
  screen.getAllByRole('button').find((b) => b.className.includes('chip') && b.textContent?.trim() === label)!
const seg = (label: string) => screen.getAllByRole('radio').find((b) => b.textContent?.trim() === label)!

beforeEach(async () => {
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })))
  await db.categories.clear()
  await db.categories.bulkAdd(CATEGORIES)
  await db.transactions.clear()
  await db.transactions.add(TXN)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('clearing a category by hand', () => {
  it('stays cleared through the self-heal', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    fireEvent.click(chip('Groceries'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(async () => expect(await db.transactions.get(42)).toMatchObject({ categoryId: null, uncategorized: true, manual: true }))
    await recategorizeUncategorized()
    expect((await db.transactions.get(42))?.categoryId).toBeNull()
  })

  it('picking a category again lifts it', async () => {
    await db.transactions.update(42, { categoryId: null, uncategorized: true, manual: true })
    const t = (await db.transactions.get(42))!
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    fireEvent.click(chip('Dining'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(async () => expect(await db.transactions.get(42)).toMatchObject({ categoryId: 2, uncategorized: false }))
  })

  it('a kind switch that drops the category is not a clear', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    fireEvent.click(seg('Income'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(async () => expect(await db.transactions.get(42)).toMatchObject({ type: 'income', categoryId: null, uncategorized: false }))
  })
})
