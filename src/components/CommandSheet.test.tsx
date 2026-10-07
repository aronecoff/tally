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

// Apply and Undo ignore a tap that lands right after they appear (the second
// half of a double tap, B07), so a deliberate tap waits a moment first.
const settle = () => vi.advanceTimersByTime(500)
const tick = () => new Promise((r) => setTimeout(r, 20))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
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
    expect(screen.getByText('The most recent of 2. Add an amount, a day or a month to pick another, or say "all".')).toBeTruthy()
    // Previewing wrote nothing.
    expect((await db.transactions.get(2))?.date).toBe('2026-09-28')

    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    expect(await db.transactions.get(2)).toMatchObject({ date: '2026-10-01', manual: true })
    expect(input().value).toBe('')

    settle()
    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Undone')
    const back = await db.transactions.get(2)
    expect(back?.date).toBe('2026-09-28')
    // The pin stays: it is one-way across devices (B90).
    expect(back?.manual).toBe(true)
  })

  it('sets a budget', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('set dining budget to 450')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Set Dining budget to $450')
    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    expect((await db.categories.get(2))?.monthlyBudget).toBe(450)
  })

  it('unknown words get the examples, once, and an example fills the box', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('hello there')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Tally did not understand that.')
    // The examples show as chips only, not again in the error line (B85).
    expect(screen.getAllByText('set Dining budget to 600')).toHaveLength(1)
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

  it('B07: a double tap on Preview does not apply, and a double tap on Apply does not undo', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    // The second tap lands on Apply, which took Preview's place.
    fireEvent.click(screen.getByText('Apply'))
    await tick()
    expect(screen.queryByText('Done')).toBeNull()
    expect((await db.transactions.get(2))?.date).toBe('2026-09-28')

    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    fireEvent.click(screen.getByText('Undo'))
    await tick()
    expect(screen.queryByText('Undone')).toBeNull()
    expect((await db.transactions.get(2))?.date).toBe('2026-10-01')
  })

  it('B08: a failed Undo says so and keeps Undo for another try', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((() => Promise.reject(new Error('disk'))) as never)
    settle()
    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Could not undo. Try again.')
    spy.mockRestore()
    expect((await db.transactions.get(2))?.date).toBe('2026-10-01')
    settle()
    fireEvent.click(screen.getByRole('button', { name: /^Undo/ }))
    await screen.findByText('Undone')
    expect((await db.transactions.get(2))?.date).toBe('2026-09-28')
  })

  it('B11: typing a new command keeps Undo for the last change', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    type('h')
    type('')
    settle()
    fireEvent.click(screen.getByRole('button', { name: /^Undo: Move Landlord LLC/ }))
    await screen.findByText('Undone')
    expect((await db.transactions.get(2))?.date).toBe('2026-09-28')
  })

  it('B49: a preview row keeps the amount in a cell of its own', async () => {
    const { container } = render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    expect(container.ownerDocument.querySelector('.cmd-row-name')?.textContent).toBe('Landlord LLC')
    expect(container.ownerDocument.querySelector('.cmd-row-amt')?.textContent).toBe('$2,400.00')
  })

  it('B83: signed out, the preview does not promise a rule', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('file landlord llc under dining')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Sign in to have new charges from this merchant follow too.')
    expect(screen.queryByText(/new ones too/)).toBeNull()
  })

  it('B84 · B48: the line is capped, and the hide example comes from a real row', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    expect(input().maxLength).toBe(200)
    await screen.findByRole('button', { name: 'hide Landlord LLC $2,400' })
    expect(screen.queryByRole('button', { name: /Venmo/ })).toBeNull()
  })

  it('B87: with the on-screen keyboard up, a preview drops it; an error keeps it', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    document.querySelector('.sheet-backdrop')!.setAttribute('data-kb', '')
    input().focus()
    type('hello there')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Tally did not understand that.')
    expect(document.activeElement).toBe(input())
    type('move rent to Oct 1')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    expect(document.activeElement?.getAttribute('role')).toBe('dialog')
  })
})

