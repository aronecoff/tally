// @vitest-environment jsdom
/**
 * Categories under a locked savings plan: the line above the lists says how the
 * budgets sit against the plan, and no edit may take their total past it. The
 * amounts are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Categories } from './Categories'
import { db, type Category } from '../db/db'
import { setPlan } from '../lib/planCache'

const T0 = 1_700_000_000_000
const cat = (id: number, name: string, monthlyBudget: number, kind: Category['kind'] = 'expense'): Category => ({
  id, name, icon: 'tag', color: '#fff', kind, monthlyBudget, sortOrder: id, updatedAt: T0,
})
// 2,750 assigned.
const CATEGORIES = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 750), cat(3, 'Fun', 0), cat(7, 'Salary', 0, 'income')]
const lock = (cap = 3000) => setPlan({ goal: 800, cap, locked: true, since: '2031-04', pending: null, updatedAt: 1 })

function Live() {
  const categories = useLiveQuery(() => db.categories.filter((c) => !c.deleted).toArray(), [])
  return <Categories categories={categories} />
}

const row = (name: string) => screen.getByText(name, { selector: '.cat-name' }).closest('.cat-row') as HTMLElement
const open = (name: string) => fireEvent.click(within(row(name)).getByRole('button', { expanded: false }))
const field = (name: string) => within(row(name)).getByRole('textbox', { name: 'Monthly budget' }) as HTMLInputElement
const enter = (name: string, v: string) => {
  const el = field(name)
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: v } })
  fireEvent.blur(el)
}
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
const stored = async (id: number) => (await db.categories.get(id))!
const saved = (id: number, n: number) => waitFor(async () => expect((await stored(id)).monthlyBudget).toBe(n))
const sub = () => document.querySelector('.cats-sub')!

beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn()
  await db.open()
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd(CATEGORIES)
})
afterEach(() => {
  cleanup()
  setPlan(null)
  vi.restoreAllMocks()
})

describe('the line above the lists', () => {
  it('says what is unassigned', async () => {
    lock()
    render(<Live />)
    await screen.findByText('Dining')
    expect(sub().textContent).toBe('Your budget is locked at $3,000 a month. $250 is unassigned.')
    expect([...sub().querySelectorAll('strong.num')].map((n) => n.textContent)).toEqual(['$3,000', '$250'])
  })

  it('says when all of it is assigned', async () => {
    lock(2750)
    render(<Live />)
    await screen.findByText('Dining')
    expect(sub().textContent).toBe('Your budget is locked at $2,750 a month. All of it is assigned.')
  })

  it('says by how much the budgets are over', async () => {
    lock(2400)
    render(<Live />)
    await screen.findByText('Dining')
    expect(sub().textContent).toBe('Your budget is locked at $2,400 a month. Category budgets add up to $350 more. Lower one to fit.')
  })

  it('with the lock off, or no plan, it is the line it always was', async () => {
    setPlan({ goal: 800, cap: 3000, locked: false, since: null, pending: null, updatedAt: 1 })
    render(<Live />)
    await screen.findByText('Dining')
    expect(sub().innerHTML).toBe('Your budgets total <strong class="num">$2,750</strong> a month.')
  })

  it('follows the plan while the screen is open', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    expect(sub().textContent).toBe('Your budgets total $2,750 a month.')
    act(() => void lock())
    expect(sub().textContent).toBe('Your budget is locked at $3,000 a month. $250 is unassigned.')
  })
})

describe('editing a budget while locked', () => {
  beforeEach(() => void lock())

  it('refuses a raise past the room: the line shows, the field goes back, and nothing is stored', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    enter('Dining', '1200')
    const alert = await within(row('Dining')).findByRole('alert')
    expect(alert.textContent).toBe('Your budget is locked at $3,000 a month, so Dining can be $1,000 at most. Lower another category first to go higher.')
    expect(field('Dining').value).toBe('750')
    await pause(30)
    expect(await stored(2)).toMatchObject({ monthlyBudget: 750, updatedAt: T0 })
  })

  it('takes a raise to exactly the budget, and the line then says all of it is assigned', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    enter('Dining', '1,000')
    await saved(2, 1000)
    expect(within(row('Dining')).queryByRole('alert')).toBeNull()
    await waitFor(() => expect(sub().textContent).toBe('Your budget is locked at $3,000 a month. All of it is assigned.'))
  })

  it('moving money works: lower one, then raise another', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Groceries')
    enter('Groceries', '1500')
    await saved(1, 1500)
    // The screen checks against the categories it holds: wait for the write to reach it.
    await waitFor(() => expect(sub().textContent).toContain('$750 is unassigned'))
    open('Dining')
    enter('Dining', '1500')
    await saved(2, 1500)
    expect(within(row('Dining')).queryByRole('alert')).toBeNull()
  })

  it('a lower amount is always taken, and clears a refusal that was showing', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    enter('Dining', '5000')
    await within(row('Dining')).findByRole('alert')
    enter('Dining', '500')
    await saved(2, 500)
    expect(within(row('Dining')).queryByRole('alert')).toBeNull()
  })

  it('a new category can take only what is unassigned', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    fireEvent.click(screen.getAllByText('Add category')[0])
    await waitFor(() => expect(screen.getByText('New category', { selector: '.cat-name' })).toBeTruthy())
    const added = (await db.categories.toArray()).find((c) => c.name === 'New category')!
    enter('New category', '251')
    const alert = await within(row('New category')).findByRole('alert')
    expect(alert.textContent).toContain('so New category can be $250 at most')
    enter('New category', '250')
    await saved(added.id!, 250)
  })

  it('deleting a category frees its budget as unassigned', async () => {
    lock(2750)
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    const del = within(row('Dining')).getByRole('button', { name: /delete/i })
    fireEvent.click(del)
    await pause(400)
    fireEvent.click(within(row('Dining')).getByRole('button', { name: /tap again/i }))
    await waitFor(() => expect(sub().textContent).toBe('Your budget is locked at $2,750 a month. $750 is unassigned.'))
  })

  it('odd amounts: a huge one is refused, and what is not a number says so as before', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    enter('Dining', '1e9')
    expect((await within(row('Dining')).findByRole('alert')).textContent).toContain('can be $1,000 at most')
    enter('Dining', 'Infinity')
    await waitFor(() => expect(within(row('Dining')).getByRole('alert').textContent).toBe('Not a number. The budget stays $750.'))
    // Half a cent past the budget counts as the cent it rounds to.
    enter('Dining', '$1,000.005')
    await waitFor(() => expect(within(row('Dining')).getByRole('alert').textContent).toContain('can be $1,000 at most'))
    await pause(30)
    expect((await stored(2)).monthlyBudget).toBe(750)
    enter('Dining', '$1,000.004')
    await saved(2, 1000.004)
    enter('Dining', '-5')
    await saved(2, 0)
  })

  it('a store that refuses, because the room went since the screen was drawn, says so and goes back', async () => {
    render(<Live />)
    await screen.findByText('Dining')
    open('Dining')
    // The store moves under the screen in the same instant as the edit.
    const el = field('Dining')
    fireEvent.focus(el)
    fireEvent.change(el, { target: { value: '1000' } })
    await db.categories.update(1, { monthlyBudget: 2250, updatedAt: T0 })
    fireEvent.blur(el)
    const alert = await within(row('Dining')).findByRole('alert')
    expect(alert.textContent).toMatch(/all of it is assigned|at most/)
    expect((await stored(2)).monthlyBudget).toBe(750)
  })
})
