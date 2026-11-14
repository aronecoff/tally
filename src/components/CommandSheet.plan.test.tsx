// @vitest-environment jsdom
/**
 * Tell Tally's sheet under a locked savings plan: a budget that does not fit
 * says why, in the refusal's own words, at Preview, at Apply and at Undo. The
 * amounts are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { CommandSheet } from './CommandSheet'
import { db, type Category } from '../db/db'
import { setPlan } from '../lib/planCache'

// 2,750 assigned, against a 3,000 budget.
const CATS: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 2000, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 750, sortOrder: 1, updatedAt: 0 },
]

/** The sheet as App feeds it: the live categories. */
function Live() {
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])
  if (!categories) return null
  return (
    <>
      {/* What the sheet has been handed, so a test can wait for a write to reach it. */}
      <output data-testid="handed">{categories.map((c) => c.monthlyBudget).join(',')}</output>
      <CommandSheet categories={categories} onClose={() => {}} />
    </>
  )
}

const input = () => screen.getByLabelText('Command') as HTMLInputElement
const type = (s: string) => fireEvent.change(input(), { target: { value: s } })
const settle = () => vi.advanceTimersByTime(500)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date(2031, 3, 10, 12, 0, 0))
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })))
  await db.transactions.clear()
  await db.categories.clear()
  await db.categories.bulkAdd(CATS)
  setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 1 })
})
afterEach(() => {
  cleanup()
  setPlan(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Tell Tally with a locked budget', () => {
  it('refuses a raise past it at Preview, and nothing can be applied', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('set dining budget to 1200')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Your budget is locked at $3,000 a month, so Dining can be $1,000 at most. Lower another category first to go higher.')
    expect(screen.queryByText('Apply')).toBeNull()
    expect((await db.categories.get(2))?.monthlyBudget).toBe(750)
  })

  it('says why at Apply when the room went after the preview', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('set dining budget to 1000')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Set Dining budget to $1,000')
    await db.categories.update(1, { monthlyBudget: 2250 }) // a sync used the room
    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Your budget is locked at $3,000 a month and all of it is assigned. Lower another category first.')
    expect(screen.queryByText('Could not save. Try again.')).toBeNull()
    expect((await db.categories.get(2))?.monthlyBudget).toBe(750)
  })

  it('says why at Undo, and keeps Undo for another try', async () => {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    type('set dining budget to 400')
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Set Dining budget to $400')
    settle()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    await db.categories.update(1, { monthlyBudget: 2500 }) // the freed room went elsewhere
    settle()
    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Your budget is locked at $3,000 a month, so Dining can be $500 at most. Lower another category first to go higher.')
    expect(screen.queryByText('Could not undo. Try again.')).toBeNull()
    expect((await db.categories.get(2))?.monthlyBudget).toBe(400)
    expect(screen.getByRole('button', { name: /^Undo/ })).toBeTruthy()
  })

  it('moving money between two categories works: lower one, then raise the other', async () => {
    render(<Live />)
    await screen.findByLabelText('Command')
    const steps = [
      ['set groceries budget to 1500', 'Set Groceries budget to $1,500', '1500,750'],
      ['set dining budget to 1500', 'Set Dining budget to $1,500', '1500,1500'],
    ]
    for (const [words, title, then] of steps) {
      type(words)
      fireEvent.click(screen.getByText('Preview'))
      await screen.findByText(title)
      settle()
      fireEvent.click(screen.getByText('Apply'))
      await screen.findByText('Done')
      // The next preview reads the categories the sheet holds: wait for this write to reach it.
      await waitFor(() => expect(screen.getByTestId('handed').textContent).toBe(then))
      settle()
    }
    expect((await db.categories.toArray()).map((c) => c.monthlyBudget)).toEqual([1500, 1500])
  })
})
