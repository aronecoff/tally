// @vitest-environment jsdom
/**
 * Category names stay unique, and a budget typed the way people write money
 * is read as money. Values are invented.
 *
 *  - B05: renaming a category to a name already in use (any case, any spaces)
 *    is refused in place: the stored name comes back and the editor says why.
 *    Two new categories never share a name, and a fast double tap on Add
 *    category adds one row. (Signed in, two live rows of one name were merged
 *    by the next sync, which tombstoned the real category and its budget.)
 *  - B96: '$650' saves 650; a figure that is not a number reverts and says so.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Categories } from './Categories'
import { db, type Category } from '../db/db'

const T0 = 1_700_000_000_000

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 650, sortOrder: 0, updatedAt: T0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 350, sortOrder: 1, updatedAt: T0 },
  { id: 3, name: 'Fun', icon: 'sparkles', color: '#fff', kind: 'expense', monthlyBudget: 175, sortOrder: 2, updatedAt: T0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: T0 },
]

function Live() {
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])
  return <Categories categories={categories} />
}

const row = (name: string) => screen.getByText(name, { selector: '.cat-name' }).closest('.cat-row') as HTMLElement
const open = (name: string) => fireEvent.click(within(row(name)).getByRole('button', { expanded: false }))
/** A short real wait, only before checking that nothing was written. A write
 *  that should happen is awaited on its value: under a loaded full run a fixed
 *  wait ran out first, and the late write then landed in the next test. */
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn()
  await db.open()
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd(CATEGORIES)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('B05: a rename to a name already in use', () => {
  for (const typed of ['Dining', '  dining ', 'DINING']) {
    it(`is refused and says why (${JSON.stringify(typed)})`, async () => {
      render(<Live />)
      await screen.findByText('Fun')
      open('Fun')
      const name = within(row('Fun')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      fireEvent.focus(name)
      fireEvent.change(name, { target: { value: typed } })
      fireEvent.blur(name)
      await pause(30)
      expect(await db.categories.get(3)).toMatchObject({ name: 'Fun', updatedAt: T0 })
      expect(name.value).toBe('Fun')
      expect(screen.getByRole('alert').textContent).toBe('You already have Dining.')
      // Both rows are still there, each with its own budget.
      expect((await db.categories.toArray()).filter((c) => !c.deleted).map((c) => [c.name, c.monthlyBudget])).toEqual([
        ['Groceries', 650],
        ['Dining', 350],
        ['Fun', 175],
        ['Salary', 0],
      ])
    })
  }

  it('a change of case on the same row still saves', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    const name = within(row('Dining')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: 'DINING' } })
    fireEvent.blur(name)
    await waitFor(async () => expect((await db.categories.get(2))?.name).toBe('DINING'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an income name may match an expense name (another kind)', async () => {
    render(<Live />)
    await screen.findByText('Salary')
    open('Salary')
    const name = within(row('Salary')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: 'Fun' } })
    fireEvent.blur(name)
    await waitFor(async () => expect((await db.categories.get(7))?.name).toBe('Fun'))
  })
})

describe('B05: adding categories', () => {
  it('a second new category is numbered, and a double tap adds one', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    const add = () => screen.getAllByText('Add category')[0]
    fireEvent.click(add())
    // Lands while the first is being written: ignored.
    fireEvent.click(add())
    await waitFor(() => expect(screen.getByText('New category', { selector: '.cat-name' })).toBeTruthy())
    expect((await db.categories.toArray()).filter((c) => c.name.startsWith('New category')).map((c) => c.name)).toEqual([
      'New category',
    ])
    fireEvent.click(add())
    await waitFor(() => expect(screen.getByText('New category 2', { selector: '.cat-name' })).toBeTruthy())
    expect((await db.categories.toArray()).filter((c) => c.name.startsWith('New category')).map((c) => c.name)).toEqual([
      'New category',
      'New category 2',
    ])
  })
})

describe('B96: a budget typed as money', () => {
  /** Types a budget into Dining and leaves the field; what the field then shows. */
  const enter = (v: string) => {
    const limit = within(row('Dining')).getByRole('textbox', { name: 'Monthly budget' }) as HTMLInputElement
    fireEvent.focus(limit)
    fireEvent.change(limit, { target: { value: v } })
    fireEvent.blur(limit)
    return limit.value
  }
  const stored = async () => (await db.categories.get(2))?.monthlyBudget
  /** A save is a write: awaited on the stored value. */
  const saved = (n: number) => waitFor(async () => expect(await stored()).toBe(n))

  it("reads '$650', '$650.00', '$ 1,200' and '640 ' as money", async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    expect(enter('$650')).toBe('650')
    await saved(650)
    expect(enter('$650.00')).toBe('650')
    await saved(650)
    expect(enter('$ 1,200')).toBe('1200')
    await saved(1200)
    expect(enter('640 ')).toBe('640')
    await saved(640)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a figure that is not a number reverts and says so, never clearing the budget', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    expect(enter('abc')).toBe('350')
    expect(screen.getByRole('alert').textContent).toBe('Not a number. The budget stays $350.')
    await pause(30)
    expect(await stored()).toBe(350)
    expect(enter('$')).toBe('350')
    await pause(30)
    expect(await stored()).toBe(350)
    // The next good save clears the note.
    expect(enter('700')).toBe('700')
    await saved(700)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
