// @vitest-environment jsdom
/**
 * B108: a long category name ran its chip past the sheet's edge at 320px. The
 * name is now its own part that ends in '…' inside a chip held to the row's
 * width (controls.css); the button's name and text are unchanged, and the full
 * name is its tooltip. Names are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TransactionSheet } from './TransactionSheet'
import { db, type Category } from '../db/db'

const LONG = 'Dining Out, Coffee and Late-Night Takeout'
const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: LONG, icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  )
  await db.open()
  await db.transactions.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('B108: category chips', () => {
  it('hold the name in a label part that can end in an ellipsis', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    const chip = await screen.findByRole('button', { name: LONG })
    expect(chip.classList.contains('chip')).toBe(true)
    expect(chip.querySelector('.chip-label')?.textContent).toBe(LONG)
    expect(chip.textContent).toBe(LONG)
    expect(chip.getAttribute('title')).toBe(LONG)
  })
})
