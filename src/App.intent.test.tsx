// @vitest-environment jsdom
/**
 * "Add expense" reaching the app. The sheet is its own, over whatever is open: an edit
 * half made underneath survives it, and nothing is written until Add. Values are invented.
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
const ROW: Transaction = { id: 1, date: '2026-09-12', amount: 120, type: 'expense', categoryId: 1, account: 'Card', note: 'Sample Shop', createdAt: 0, updatedAt: 0 }

const sheets = () => [...document.querySelectorAll<HTMLElement>('.sheet')]
const amounts = () => screen.getAllByLabelText('Amount').map((el) => (el as HTMLInputElement).value)
const pane = () => document.querySelector('section.pane:not([hidden])') as HTMLElement

/** The app around the page, holding `asks`, one per question. */
function native(...asks: Record<string, unknown>[]) {
  vi.stubGlobal('webkit', {
    messageHandlers: {
      tally: {
        postMessage: async ({ method }: { method: string }) => {
          if (method === 'addExpense.take') return asks.shift() ?? {}
          throw new Error('unavailable')
        },
      },
    },
  })
  return asks
}

async function boot() {
  vi.setSystemTime(new Date('2026-09-30T12:00:00'))
  history.replaceState(null, '', '#activity')
  render(<App />)
  await waitFor(() => expect(pane()?.getAttribute('aria-busy')).toBeNull())
  await waitFor(() => expect(pane().textContent).toContain('Sample Shop'))
}

const nudge = () =>
  act(async () => {
    window.dispatchEvent(new Event('app:add-expense'))
  })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  sessionStorage.clear()
  await db.categories.bulkAdd(CATS)
  await db.transactions.add(ROW)
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('Add expense', () => {
  it('opens the add sheet filled in when it is what launched the app', async () => {
    native({ amount: 12.5, note: 'Sample Cafe' })
    await boot()
    await waitFor(() => expect(sheets()).toHaveLength(1))
    expect(amounts()).toEqual(['12.50'])
    expect((screen.getByPlaceholderText('Merchant or note') as HTMLInputElement).value).toBe('Sample Cafe')
    expect(await db.transactions.count()).toBe(1)
  })

  it('opens it on a page already up, and Add writes one row and shows its month', async () => {
    const asks = native()
    await boot()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    })
    await waitFor(() => expect(document.querySelector('.app-head .ms-label')?.textContent).toBe('August'))
    expect(sheets()).toHaveLength(0)

    asks.push({ amount: 9, note: 'Sample Cafe' })
    await nudge()
    await waitFor(() => expect(sheets()).toHaveLength(1))
    await act(async () => {
      fireEvent.click(screen.getByText('Add'))
    })
    await waitFor(() => expect(sheets()).toHaveLength(0))

    const rows = await db.transactions.toArray()
    expect(rows).toHaveLength(2)
    expect(rows.find((t) => t.note === 'Sample Cafe')).toMatchObject({ amount: 9, date: '2026-09-30', manual: true })
    expect(document.querySelector('.app-head .ms-label')?.textContent).toBe('September')
  })

  it('leaves an edit half made underneath untouched', async () => {
    const asks = native()
    await boot()
    await act(async () => {
      fireEvent.click(screen.getByText('Sample Shop'))
    })
    await waitFor(() => expect(sheets()).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '133.00' } })

    asks.push({ amount: 12.5 })
    await nudge()
    await waitFor(() => expect(sheets()).toHaveLength(2))
    expect(amounts()).toEqual(['133.00', '12.50'])

    await act(async () => {
      fireEvent.click(sheets()[1].querySelector('.sheet-close')!)
    })
    await waitFor(() => expect(sheets()).toHaveLength(1))
    expect(amounts()).toEqual(['133.00'])
    expect((await db.transactions.get(1))?.amount).toBe(120)
  })

  it('a second ask replaces a first still open, as the newest thing said', async () => {
    const asks = native({ amount: 3 })
    await boot()
    await waitFor(() => expect(sheets()).toHaveLength(1))
    asks.push({ amount: 4 })
    await nudge()
    await waitFor(() => expect(amounts()).toEqual(['4.00']))
    expect(sheets()).toHaveLength(1)
  })

  it('closing the sheet writes nothing and the ask does not come back', async () => {
    native({ amount: 3 })
    await boot()
    await waitFor(() => expect(sheets()).toHaveLength(1))
    await act(async () => {
      fireEvent.click(document.querySelector('.sheet-close')!)
    })
    await waitFor(() => expect(sheets()).toHaveLength(0))
    await nudge()
    expect(sheets()).toHaveLength(0)
    expect(await db.transactions.count()).toBe(1)
  })

  it('in a browser no sheet opens, however the event is fired', async () => {
    await boot()
    await nudge()
    expect(sheets()).toHaveLength(0)
  })
})
