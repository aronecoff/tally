// @vitest-environment jsdom
/**
 * Categories: the working delete and the editor's store discipline.
 *
 *  - Delete takes two taps in place and never calls window.confirm (a silent
 *    no-op in the iPhone wrapper, which made the old Delete do nothing).
 *  - A delete re-homes the category's transactions exactly as before: to the
 *    first live 'Other' of the same kind, else uncategorized; the category is
 *    tombstoned (deleted: true), never removed, so the delete syncs.
 *  - The editor mirrors the store while a field is not being edited, and a
 *    blur writes only a real change (blank names and non-numbers revert).
 *  - The icon picker offers category glyphs only, every option a real button.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Categories } from './Categories'
import { CATEGORY_ICONS, ICON_LABELS } from './iconPaths'
import { db, type Category, type Transaction } from '../db/db'

const T0 = 1_700_000_000_000

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 0, updatedAt: T0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 800, sortOrder: 1, updatedAt: T0 },
  { id: 3, name: 'Other', icon: 'box', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: T0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: T0 },
  // A legacy icon from the old picker, which offered chrome glyphs.
  { id: 8, name: 'Freelance', icon: 'sun', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: T0 },
]

const tx = (id: number, categoryId: number | null, type: 'expense' | 'income' = 'expense'): Transaction => ({
  id,
  date: '2026-09-10',
  amount: 10 + id,
  type,
  categoryId,
  account: 'Amex',
  note: `row ${id}`,
  createdAt: T0,
  updatedAt: T0,
})

const TRANSACTIONS: Transaction[] = [
  tx(101, 2), // Dining
  tx(102, 2), // Dining
  tx(103, 1), // Groceries
  tx(104, 3), // Other
  tx(105, null), // uncategorized
  tx(106, 7, 'income'), // Salary
]

/** The screen as App feeds it: the live, non-deleted categories. */
function Live() {
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])
  return <Categories categories={categories} />
}

const row = (name: string) => screen.getByText(name, { selector: '.cat-name' }).closest('.cat-row') as HTMLElement
const open = (name: string) => fireEvent.click(within(row(name)).getByRole('button', { expanded: false }))
const deleteButton = (name: string) => within(row(name)).getByRole('button', { name: /delete/i })
/** A short real wait, only before checking that nothing was written. A write
 *  that should happen is awaited on its value: under a loaded full run a fixed
 *  wait could run out before the write landed. */
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

let confirmSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true)
  // jsdom has no scrollIntoView (used to bring a new category into view).
  Element.prototype.scrollIntoView = vi.fn()
  await db.open()
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd(CATEGORIES)
  await db.transactions.bulkAdd(TRANSACTIONS)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Categories: loading and rows', () => {
  it('shows a skeleton, not an empty list, while the query is loading', () => {
    render(<Categories categories={undefined} />)
    expect(screen.getByLabelText('Loading')).toBeTruthy()
    expect(screen.queryByText('Add category')).toBeNull()
  })

  it('states the budgets total and each budget per month, trimmed', async () => {
    render(<Live />)
    await screen.findByText('Groceries')
    expect(screen.getByText(/Your budgets total/).textContent).toBe('Your budgets total $1,200 a month.')
    expect(within(row('Groceries')).getByText(/\$400/).textContent).toBe('$400/mo')
    expect(within(row('Other')).getByText('No budget')).toBeTruthy()
    // Income rows carry no budget.
    expect(within(row('Salary')).queryByText(/budget|\$/)).toBeNull()
    expect(screen.getAllByText('Add category')).toHaveLength(2)
  })

  it('keeps one editor open at a time', async () => {
    render(<Live />)
    await screen.findByText('Groceries')
    open('Groceries')
    open('Dining')
    expect(document.querySelectorAll('.cat-edit')).toHaveLength(1)
    expect(within(row('Dining')).getByRole('button', { expanded: true })).toBeTruthy()
  })
})

describe('Categories: delete', () => {
  // The double-tap window (useArmed) reads performance.now(); the taps move it
  // by hand. With the real clock, the pauses between taps ran past the 350 ms
  // window under a loaded full run, and the 'inside the window' tap confirmed.
  let now = 10_000
  beforeEach(() => {
    now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  it('needs two taps, never calls window.confirm, and re-homes to Other exactly as before', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')

    fireEvent.click(deleteButton('Dining'))
    expect(deleteButton('Dining').textContent).toBe('Tap again to delete')
    expect(within(row('Dining')).getByText('Transactions move to Other')).toBeTruthy()
    // One tap changes nothing.
    await pause(50)
    expect((await db.categories.get(2))?.deleted).toBeFalsy()
    expect((await db.transactions.bulkGet([101, 102])).map((t) => t?.categoryId)).toEqual([2, 2])

    // A second tap inside the double-tap window is not a confirmation: still armed.
    now += 150
    fireEvent.click(deleteButton('Dining'))
    expect(deleteButton('Dining').textContent).toBe('Tap again to delete')
    await pause(50)
    expect((await db.categories.get(2))?.deleted).toBeFalsy()

    now += 400
    fireEvent.click(deleteButton('Dining'))
    await waitFor(async () => expect((await db.categories.get(2))?.deleted).toBe(true))

    // Tombstoned, not removed (so the delete syncs); every other field kept.
    const tomb = await db.categories.get(2)
    expect(tomb).toMatchObject({ ...CATEGORIES[1], deleted: true, updatedAt: expect.any(Number) })
    expect(tomb!.updatedAt).toBeGreaterThan(T0)
    // Dining's transactions moved to Other (id 3); nothing else touched.
    const after = await db.transactions.orderBy('id').toArray()
    expect(after.map((t) => [t.id, t.categoryId])).toEqual([
      [101, 3],
      [102, 3],
      [103, 1],
      [104, 3],
      [105, null],
      [106, 7],
    ])
    expect(after.filter((t) => t.updatedAt !== T0).map((t) => t.id)).toEqual([101, 102])
    expect(confirmSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Dining', { selector: '.cat-name' })).toBeNull())
  })

  it('without a fallback, transactions become uncategorized', async () => {
    render(<Live />)
    await screen.findByText('Other')
    open('Other')
    fireEvent.click(deleteButton('Other'))
    expect(within(row('Other')).getByText('Transactions become uncategorized')).toBeTruthy()
    now += 400
    fireEvent.click(deleteButton('Other'))
    await waitFor(async () => expect((await db.categories.get(3))?.deleted).toBe(true))
    expect((await db.transactions.get(104))?.categoryId).toBeNull()
    expect((await db.transactions.orderBy('id').toArray()).map((t) => t.categoryId)).toEqual([2, 2, 1, null, null, 7])
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

describe('Categories: editor', () => {
  it('offers category glyphs only, as real buttons, with the current one pressed', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    const picker = within(row('Dining')).getByRole('group', { name: 'Icon' })
    const opts = within(picker).getAllByRole('button')
    expect(opts.map((b) => b.getAttribute('aria-label'))).toEqual(CATEGORY_ICONS.map((k) => ICON_LABELS[k]))
    for (const k of ['sun', 'moon', 'cloud', 'chevron', 'plus', 'check', 'alert', 'x']) {
      expect(CATEGORY_ICONS).not.toContain(k)
      expect(opts.some((b) => b.getAttribute('aria-label') === k)).toBe(false)
    }
    expect(opts.every((b) => b.getAttribute('type') === 'button')).toBe(true)
    expect(opts.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Dining',
    ])

    // A tap saves at once.
    fireEvent.click(within(picker).getByRole('button', { name: 'Coffee' }))
    await waitFor(async () => expect((await db.categories.get(2))?.icon).toBe('coffee'))
  })

  it('keeps a legacy icon visible and selected, up front', async () => {
    render(<Live />)
    await screen.findByText('Freelance')
    open('Freelance')
    const opts = within(within(row('Freelance')).getByRole('group', { name: 'Icon' })).getAllByRole('button')
    expect(opts).toHaveLength(CATEGORY_ICONS.length + 1)
    expect(opts[0].getAttribute('aria-label')).toBe('sun')
    expect(opts[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('mirrors the store while unfocused (an edit from another device shows at once)', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    await act(async () => {
      await db.categories.update(2, { name: 'Dining out', monthlyBudget: 850, updatedAt: T0 + 5 })
    })
    await waitFor(() => expect(screen.getByText('Dining out', { selector: '.cat-name' })).toBeTruthy())
    expect(within(row('Dining out')).getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Dining out')
    expect(within(row('Dining out')).getByRole('textbox', { name: 'Monthly budget' })).toHaveProperty('value', '850')
    expect(within(row('Dining out')).getByText(/\$850/).textContent).toBe('$850/mo')
  })

  it('writes a name only when it changed, and never a blank one', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    const name = within(row('Dining')).getByRole('textbox', { name: 'Name' }) as HTMLInputElement

    // Focus and leave: nothing written.
    fireEvent.focus(name)
    fireEvent.blur(name)
    await pause(30)
    expect((await db.categories.get(2))?.updatedAt).toBe(T0)

    // Blank: the stored name comes back, nothing written.
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.blur(name)
    await pause(30)
    expect(name.value).toBe('Dining')
    expect((await db.categories.get(2))?.updatedAt).toBe(T0)

    // A real change is trimmed and saved; the row previews it while typing.
    fireEvent.focus(name)
    fireEvent.change(name, { target: { value: '  Restaurants ' } })
    expect(within(row('Restaurants')).getByRole('button', { expanded: true })).toBeTruthy()
    fireEvent.blur(name)
    await waitFor(async () => expect((await db.categories.get(2))?.name).toBe('Restaurants'))
    await waitFor(() => expect(name.value).toBe('Restaurants'))
  })

  it('saves a budget the same way as before, and reverts what is not a number', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    const limit = within(row('Dining')).getByRole('textbox', { name: 'Monthly budget' }) as HTMLInputElement
    expect(limit.getAttribute('inputmode')).toBe('decimal')
    expect(limit.getAttribute('placeholder')).toBe('No budget')
    const enter = (v: string) => {
      fireEvent.focus(limit)
      fireEvent.change(limit, { target: { value: v } })
      fireEvent.blur(limit)
    }
    const stored = () => db.categories.get(2)
    /** A save is a write: awaited on the stored budget. */
    const saved = (n: number) => waitFor(async () => expect((await stored())?.monthlyBudget).toBe(n))

    enter('abc')
    await pause(30)
    const c = await stored()
    expect([c?.monthlyBudget, c?.updatedAt, limit.value]).toEqual([800, T0, '800'])
    enter('800')
    await pause(30)
    expect((await stored())?.updatedAt).toBe(T0) // unchanged: no write
    enter('650.5')
    await saved(650.5)
    enter('-20')
    await saved(0) // max(0, n), as before
    enter('')
    await pause(30)
    expect((await stored())?.monthlyBudget).toBe(0)
    enter('1,200')
    await saved(1200)
  })

  it('adds a category with the same fields as before and opens it', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    fireEvent.click(screen.getAllByText('Add category')[0])
    await waitFor(() => expect(screen.getByText('New category', { selector: '.cat-name' })).toBeTruthy())
    const added = (await db.categories.toArray()).find((c) => c.name === 'New category')!
    expect(added).toMatchObject({ icon: 'tag', color: '#9a9aa2', kind: 'expense', monthlyBudget: 0, sortOrder: 3, deleted: false })
    expect(within(row('New category')).getByRole('button', { expanded: true })).toBeTruthy()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})
