// @vitest-environment jsdom
/**
 * Tell Tally end to end: type, preview, apply, undo. Nothing is written before
 * Apply; Apply writes like a hand edit (pinned); Undo puts every field back.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { CommandSheet } from './CommandSheet'
import { db, type Category, type Transaction } from '../db/db'

const CATS: Category[] = [
  { id: 1, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]
const base = { type: 'expense' as const, account: 'Test Bank Checking (1111)', createdAt: 0, updatedAt: 0 }
const ROWS: Transaction[] = [
  { ...base, id: 1, date: '2026-09-01', amount: 2400, categoryId: 1, note: 'Landlord LLC', manual: true },
  { ...base, id: 2, date: '2026-09-28', amount: 2400, categoryId: 1, note: 'Landlord LLC' },
]

const input = () => screen.getByLabelText('Command') as HTMLInputElement
const type = (s: string) => fireEvent.change(input(), { target: { value: s } })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 29, 12, 0, 0))
  // Reduce Motion: sheets close without waiting on an animation.
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })))
  await db.transactions.clear()
  await db.categories.clear()
  await db.categories.bulkAdd(CATS)
  await db.transactions.bulkAdd(ROWS)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Tell Tally', () => {
  it('previews, applies as a pinned edit, and undoes every field', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Move Landlord LLC $2,400.00 from Sep 28 to Oct 1')
    expect(screen.getByText('The most recent of 2. Add an amount or a date to pick another, or say "all".')).toBeTruthy()
    // Previewing wrote nothing.
    expect((await db.transactions.get(2))?.date).toBe('2026-09-28')

    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    expect(await db.transactions.get(2)).toMatchObject({ date: '2026-10-01', manual: true })
    expect(input().value).toBe('')

    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Undone')
    const back = await db.transactions.get(2)
    expect(back?.date).toBe('2026-09-28')
    expect(back?.manual).toBeFalsy()
  })

  it('sets a budget', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('set dining budget to 450')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Set Dining budget to $450')
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    expect((await db.categories.get(2))?.monthlyBudget).toBe(450)
  })

  it('unknown words get the examples, and an example fills the box', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('hello there')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText(/^Try: move rent to Oct 1/)
    fireEvent.click(screen.getByRole('button', { name: 'set Dining budget to 600' }))
    expect(input().value).toBe('set Dining budget to 600')
  })

  it('editing the words drops a stale preview', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    type('move rent to Oct 2')
    await waitFor(() => expect(screen.queryByText('Apply')).toBeNull())
    expect(screen.getByText('Preview')).toBeTruthy()
  })
})
