// @vitest-environment jsdom
/**
 * The add sheet opened from Siri or Shortcuts. It is the same form with its fields filled
 * in, so nothing is written until Add, and a filled sheet is as safe from a stray swipe
 * as a typed one. Values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TransactionSheet } from './TransactionSheet'
import { db, type Category } from '../db/db'

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]

const amount = () => screen.getByLabelText('Amount') as HTMLInputElement
const note = () => screen.getByPlaceholderText('Merchant or note') as HTMLInputElement
const picked = () => [...document.querySelectorAll('.chip.on')].map((b) => b.textContent?.trim())

function open(amountText: string, noteText: string) {
  const onClose = vi.fn()
  const onAdded = vi.fn()
  render(
    <TransactionSheet categories={CATEGORIES} initial={null} prefill={{ n: 1, amount: amountText, note: noteText }} onClose={onClose} onAdded={onAdded} />,
  )
  return { onClose, onAdded }
}

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  await db.open()
  await db.transactions.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('a filled add sheet', () => {
  it('shows what was asked for and writes nothing', async () => {
    open('12.50', 'Sample Cafe')
    expect(amount().value).toBe('12.50')
    expect(note().value).toBe('Sample Cafe')
    await new Promise((r) => setTimeout(r, 30))
    expect(await db.transactions.count()).toBe(0)
  })

  it('files it the way typing the same words would', () => {
    open('40.00', 'Safeway')
    expect(picked()).toEqual(['Groceries'])
  })

  it('still follows the words if they change, until a chip is tapped', () => {
    open('40.00', 'Safeway')
    fireEvent.change(note(), { target: { value: 'Starbucks' } })
    expect(picked()).toEqual(['Dining'])
  })

  it('saves through the same form, as a hand-entered row', async () => {
    const { onClose, onAdded } = open('12.50', 'Sample Cafe')
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const [row] = await db.transactions.toArray()
    expect(row).toMatchObject({ amount: 12.5, type: 'expense', note: 'Sample Cafe', manual: true })
    expect(onAdded).toHaveBeenCalledWith(row.date)
  })

  it('leaves the keyboard down when the amount is there, so Add is in reach', () => {
    open('12.50', '')
    expect(document.activeElement).not.toBe(amount())
  })

  it('brings the keyboard up when the amount still has to be typed', () => {
    open('', 'Sample Cafe')
    expect(document.activeElement).toBe(amount())
  })

  it('counts as unsaved, so a swipe cannot lose it', () => {
    const { onClose } = open('12.50', '')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.sheet')).not.toBeNull()
  })
})

describe('a new row with nothing asked for', () => {
  it('is as it always was', () => {
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    expect(amount().value).toBe('')
    expect(note().value).toBe('')
    expect(picked()).toEqual([])
    expect(document.activeElement).toBe(amount())
  })
})
