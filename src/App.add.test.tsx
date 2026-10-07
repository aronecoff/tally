// @vitest-environment jsdom
/**
 * B95: adding a transaction while a past month is shown files it under its
 * own date (today by default) and then shows that month, so the new row is
 * on screen instead of silently landing in another month. A date in a month
 * the switcher cannot reach yet (the future) leaves the view alone. Values
 * are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db, type Category, type Transaction } from './db/db'
import App from './App'

vi.mock('./db/supabase', () => ({ supabase: null }))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  syncAllConnectors: vi.fn(async () => {}),
}))

const CATS: Category[] = [{ id: 1, name: 'Groceries', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 500, sortOrder: 1, updatedAt: 0 }]
const ROWS: Transaction[] = [
  { id: 1, date: '2026-08-10', amount: 40, type: 'expense', categoryId: 1, account: 'Card', note: 'August Shop', createdAt: 0, updatedAt: 0 },
  { id: 2, date: '2026-09-12', amount: 120, type: 'expense', categoryId: 1, account: 'Card', note: 'September Shop', createdAt: 0, updatedAt: 0 },
]

const label = () => document.querySelector('.app-head .ms-label')?.textContent ?? null
const visiblePane = () => document.querySelector('section.pane:not([hidden])') as HTMLElement
const tap = (el: Element) =>
  act(async () => {
    fireEvent.click(el)
  })

async function bootOnAugust() {
  vi.setSystemTime(new Date('2026-09-30T12:00:00'))
  history.replaceState(null, '', '#activity')
  render(<App />)
  await waitFor(() => expect(visiblePane()?.getAttribute('aria-busy')).toBeNull())
  await tap(screen.getByRole('button', { name: 'Previous month' }))
  await waitFor(() => expect(label()).toBe('August'))
  await waitFor(() => expect(visiblePane().textContent).toContain('August Shop'))
}

async function add(amount: string, note: string, date?: string) {
  await tap(screen.getAllByTestId('add-txn')[0])
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } })
  fireEvent.change(screen.getByPlaceholderText('Merchant or note'), { target: { value: note } })
  if (date) fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } })
  await tap(screen.getByText('Add'))
  await waitFor(() => expect(document.querySelector('.sheet')).toBeNull())
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  sessionStorage.clear()
  await db.categories.bulkAdd(CATS)
  await db.transactions.bulkAdd(ROWS)
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('B95: an add from a past month', () => {
  it("dated today, it shows today's month with the new row", async () => {
    await bootOnAugust()
    await add('9.99', 'QA Past')
    expect((await db.transactions.toArray()).find((t) => t.note === 'QA Past')?.date).toBe('2026-09-30')
    await waitFor(() => expect(label()).toBe('September'))
    await waitFor(() => expect(visiblePane().textContent).toContain('QA Past'))
  })

  it('dated in the month shown, it stays there with the new row', async () => {
    await bootOnAugust()
    await add('5.00', 'QA August', '2026-08-12')
    await waitFor(() => expect(visiblePane().textContent).toContain('QA August'))
    expect(label()).toBe('August')
  })

  it('dated in a month not reachable yet, the view stays', async () => {
    await bootOnAugust()
    await add('7.00', 'QA Ahead', '2026-10-01')
    expect((await db.transactions.toArray()).find((t) => t.note === 'QA Ahead')?.date).toBe('2026-10-01')
    expect(label()).toBe('August')
  })
})
