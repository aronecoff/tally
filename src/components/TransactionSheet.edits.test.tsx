// @vitest-environment jsdom
/**
 * The transaction sheet writes what the user changed, and nothing else.
 * Values are invented.
 *
 *  - B12: a cleared Date never saves (the row left every month and total).
 *  - B13: Save writes only the edited fields, measured against the row the
 *    sheet opened on, so a bank sync landing while it is open is kept; a Save
 *    with no edits writes nothing and pins nothing.
 *  - B59: the add sheet's category follows the latest guess while typing
 *    ('Uber Eats' is Dining, not the Transport 'Uber' turned on).
 *  - B60: a double tap on 'Save & next' never saves the next row unseen.
 *  - B61: reopening a charge already counted is not a budget warning; only an
 *    edit that adds spending is, and a fixed bill is never 'near'.
 *  - B93: a delete in the sort queue moves on to the next row.
 *  - B94: arming Delete puts focus on Cancel (never on the destructive
 *    button), and after a delete focus lands on the next row of the list.
 *  - B95: an add reports the date it was filed under.
 *  - B98: an income row talks about deposits, and offers no charge lookup.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { TransactionSheet } from './TransactionSheet'
import { db, type Category, type Transaction } from '../db/db'

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
  { id: 3, name: 'Transport', icon: 'car', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 },
  { id: 4, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 3, updatedAt: 0 },
  { id: 5, name: 'Subscriptions', icon: 'repeat', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 4, updatedAt: 0 },
  { id: 6, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 2400, sortOrder: 5, updatedAt: 0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 8, name: 'Other income', icon: 'plus-circle', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
]

const T0 = 1000
const row = (id: number, p: Partial<Transaction> = {}): Transaction => ({
  id, date: '2026-07-24', amount: 74.3, type: 'expense', categoryId: 1, account: 'Test Card', note: 'CORNER MARKET',
  createdAt: T0, updatedAt: T0, ...p,
})

const amountInput = () => screen.getByLabelText('Amount') as HTMLInputElement
const dateInput = () => screen.getByLabelText('Date') as HTMLInputElement
const submit = () => document.querySelector('button[type="submit"]') as HTMLButtonElement
const chip = (label: string) =>
  screen.getAllByRole('button').find((b) => b.className.includes('chip') && b.textContent?.trim() === label)!
function pressEnter(el: HTMLInputElement) {
  fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' })
  if (!submit().disabled) submit().click()
}
/** A short real wait, only before checking that something did NOT happen.
 *  Anything that should happen is awaited on its own condition (waitFor):
 *  a fixed 30 ms under a loaded full run was not always enough. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))

let now = 10_000
beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  // The queue's double-tap guard reads performance.now(); each test moves it by hand.
  now = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await db.open()
  await db.transactions.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.querySelectorAll('[data-test-list]').forEach((n) => n.remove())
})

describe('B12: a cleared Date', () => {
  it('editing: Save is disabled and Enter writes nothing', async () => {
    const t = row(42)
    await db.transactions.add(t)
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    fireEvent.change(dateInput(), { target: { value: '' } })
    expect(submit().disabled).toBe(true)
    expect(dateInput().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Pick a date to save.')).toBeTruthy()
    fireEvent.change(amountInput(), { target: { value: '80' } })
    fireEvent.submit(amountInput().form!)
    await flush()
    expect(await db.transactions.get(42)).toMatchObject({ date: '2026-07-24', amount: 74.3 })
    // A full date brings Save back.
    fireEvent.change(dateInput(), { target: { value: '2026-07-25' } })
    expect(submit().disabled).toBe(false)
  })

  it('adding: Add is disabled and Enter writes nothing', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    fireEvent.change(amountInput(), { target: { value: '12.34' } })
    fireEvent.change(dateInput(), { target: { value: '' } })
    expect(submit().disabled).toBe(true)
    fireEvent.submit(amountInput().form!)
    await flush()
    expect(await db.transactions.count()).toBe(0)
  })
})

describe('B13: Save writes only what was changed', () => {
  it('a bank update that lands while the sheet is open is kept', async () => {
    const t = row(42, { uid: 'sf:p1', amount: 12.34, date: '2026-09-28', pending: true, categoryId: null, note: 'TEST BISTRO' })
    await db.transactions.add(t)
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    // The bank posts it while the sheet is open.
    await act(async () => {
      await db.transactions.update(42, { amount: 19.53, date: '2026-09-29', pending: false, updatedAt: T0 + 5 })
    })
    fireEvent.click(chip('Dining'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(async () => expect((await db.transactions.get(42))?.categoryId).toBe(2))
    expect(await db.transactions.get(42)).toMatchObject({ amount: 19.53, date: '2026-09-29', pending: false, manual: true })
  })

  it('a Save with no edits writes nothing and pins nothing', async () => {
    const t = row(42, { uid: 'sf:p2' })
    await db.transactions.add(t)
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={onClose} />)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await db.transactions.get(42)).toEqual(t)
  })

  it('an untouched refund stays unpinned', async () => {
    const t = row(44, { uid: 'sf:r1', amount: -25, note: 'TEST SHOP REFUND' })
    await db.transactions.add(t)
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={onClose} />)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await db.transactions.get(44)).toEqual(t)
  })

  it('a note edit writes the note, not the amount or date the sheet opened with', async () => {
    const t = row(42, { uid: 'sf:p3' })
    await db.transactions.add(t)
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    await act(async () => {
      await db.transactions.update(42, { amount: 70, updatedAt: T0 + 5 })
    })
    fireEvent.change(screen.getByPlaceholderText('Merchant or note'), { target: { value: 'Corner Market' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(async () => expect((await db.transactions.get(42))?.note).toBe('Corner Market'))
    expect(await db.transactions.get(42)).toMatchObject({ amount: 70, categoryId: 1, manual: true })
  })

  it('a charge the bank removed while the sheet was open is not written to', async () => {
    const t = row(42, { uid: 'sf:p4' })
    await db.transactions.add(t)
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={onClose} />)
    await act(async () => {
      await db.transactions.update(42, { deleted: true, updatedAt: T0 + 5 })
    })
    fireEvent.click(chip('Dining'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await db.transactions.get(42)).toMatchObject({ deleted: true, categoryId: 1 })
    expect((await db.transactions.get(42))?.manual).toBeFalsy()
  })
})

describe('B59: the add sheet follows the latest guess', () => {
  const typeKeys = (text: string) => {
    const field = screen.getByPlaceholderText('Merchant or note') as HTMLInputElement
    for (let i = 1; i <= text.length; i++) fireEvent.change(field, { target: { value: text.slice(0, i) } })
    return field
  }
  for (const [text, want] of [
    ['Uber Eats', 2],
    ['Barber', null],
    ['Amazon Prime Video', 5],
    ['Gastropub', null],
    ['Starbucks', 2],
  ] as const) {
    it(`'${text}' is filed under ${want ?? 'nothing'}`, async () => {
      render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
      fireEvent.change(amountInput(), { target: { value: '23.50' } })
      pressEnter(typeKeys(text))
      await waitFor(async () => expect(await db.transactions.count()).toBe(1))
      expect((await db.transactions.toArray())[0]).toMatchObject({ note: text, categoryId: want })
    })
  }

  it('a chip the user tapped is kept while typing on', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    fireEvent.change(amountInput(), { target: { value: '9' } })
    typeKeys('Ub')
    fireEvent.click(chip('Groceries'))
    pressEnter(typeKeys('Uber Eats'))
    await waitFor(async () => expect(await db.transactions.count()).toBe(1))
    expect((await db.transactions.toArray())[0].categoryId).toBe(1)
  })

  it('Income guesses from the income rules', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    fireEvent.change(amountInput(), { target: { value: '1.20' } })
    fireEvent.click(screen.getAllByRole('radio').find((b) => b.textContent === 'Income')!)
    pressEnter(typeKeys('Interest on Deposit'))
    await waitFor(async () => expect(await db.transactions.count()).toBe(1))
    expect((await db.transactions.toArray())[0]).toMatchObject({ type: 'income', categoryId: 8 })
  })
})

/** The sort queue as App drives it: one sheet, its row swapped on each save. */
function Queue({ rows, onClose = () => {} }: { rows: Transaction[]; onClose?: () => void }) {
  const [i, setI] = useState(0)
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <TransactionSheet
      categories={CATEGORIES}
      initial={rows[i]}
      progress={`${i + 1} of ${rows.length}`}
      remaining={rows.length - i - 1}
      onSaved={() => setI((n) => (n + 1 < rows.length ? n + 1 : n))}
      onClose={() => {
        setOpen(false)
        onClose()
      }}
    />
  )
}
const queueRows = () => [
  row(61, { uid: 'sf:q1', amount: 30, categoryId: null, date: '2026-09-03', note: 'QA ONE' }),
  row(62, { uid: 'sf:q2', amount: 20, categoryId: null, date: '2026-09-04', note: 'QA TWO' }),
  row(63, { uid: 'sf:q3', amount: 10, categoryId: null, date: '2026-09-05', note: 'QA THREE' }),
]
const title = () => document.querySelector('.txn-head-name')?.textContent

describe('B60: a double tap on Save & next', () => {
  it('saves the row shown and never the next one unseen', async () => {
    const rows = queueRows()
    await db.transactions.bulkAdd(rows)
    render(<Queue rows={rows} />)
    now += 2000
    fireEvent.click(chip('Groceries'))
    fireEvent.click(screen.getByText('Save & next'))
    await waitFor(() => expect(title()).toBe('Sort · 2 of 3'))
    // The second tap of the double tap lands on the next row's button.
    now += 150
    fireEvent.click(screen.getByText('Save & next'))
    await flush()
    expect(title()).toBe('Sort · 2 of 3')
    expect(await db.transactions.get(61)).toMatchObject({ categoryId: 1, manual: true })
    expect(await db.transactions.get(62)).toEqual(rows[1])
    // A deliberate tap later still moves on (and an untouched row stays unpinned).
    now += 500
    fireEvent.click(screen.getByText('Save & next'))
    await waitFor(() => expect(title()).toBe('Sort · 3 of 3'))
    expect(await db.transactions.get(62)).toEqual(rows[1])
  })
})

describe('B93: a delete inside the sort queue', () => {
  it('moves on to the next row, and the last one closes the queue', async () => {
    const rows = queueRows()
    await db.transactions.bulkAdd(rows)
    const onClose = vi.fn()
    render(<Queue rows={rows} onClose={onClose} />)
    const del = () => {
      now += 2000
      fireEvent.click(screen.getByTestId('txn-delete'))
      now += 1000
      fireEvent.click(screen.getByText('Delete transaction'))
    }
    // The delete is written first, then the queue moves on (or closes), in one step.
    del()
    await waitFor(() => expect(title()).toBe('Sort · 2 of 3'))
    expect(onClose).not.toHaveBeenCalled()
    expect((await db.transactions.get(61))?.deleted).toBe(true)
    del()
    await waitFor(() => expect(title()).toBe('Sort · 3 of 3'))
    del()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect((await db.transactions.bulkGet([61, 62, 63])).map((t) => t?.deleted)).toEqual([true, true, true])
  })
})

describe('B61: the budget warning', () => {
  const warn = () => document.querySelector('.limit-warn:not([role="alert"])')

  it('reopening a charge already counted says nothing, even over budget', async () => {
    const t = row(42)
    await db.transactions.bulkAdd([t, row(45, { date: '2026-07-02', amount: 560, note: 'BIG SHOP' })])
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    await flush()
    expect(warn()).toBeNull()
    // Raising it is news: the total goes up. It shows once the month's other
    // charge is read, so the checks after it run with that charge counted.
    fireEvent.change(amountInput(), { target: { value: '90' } })
    await waitFor(() => expect(warn()?.textContent).toBe('This puts Groceries $50.00 over budget.'))
    // Lowering it is not news.
    fireEvent.change(amountInput(), { target: { value: '50' } })
    expect(warn()).toBeNull()
    // Nor is the amount it opened with: already counted, though over budget.
    fireEvent.change(amountInput(), { target: { value: '74.3' } })
    expect(warn()).toBeNull()
  })

  it('moving a charge into a category over budget warns', async () => {
    const t = row(42, { categoryId: 2, amount: 40 })
    await db.transactions.bulkAdd([t, row(45, { date: '2026-07-02', amount: 580, note: 'BIG SHOP' })])
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    fireEvent.click(chip('Groceries'))
    await waitFor(() => expect(warn()?.textContent).toBe('This puts Groceries $20.00 over budget.'))
  })

  it('a paid fixed bill is never "near"', async () => {
    const rent = row(46, { categoryId: 6, amount: 2400, date: '2026-10-01', note: 'RENT' })
    await db.transactions.add(rent)
    render(<TransactionSheet categories={CATEGORIES} initial={rent} onClose={() => {}} />)
    await flush()
    expect(warn()).toBeNull()
    cleanup()
    // A new rent payment that lands near the budget is not 'near' either.
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    fireEvent.change(amountInput(), { target: { value: '2100' } })
    fireEvent.change(dateInput(), { target: { value: '2026-11-01' } })
    fireEvent.click(chip('Rent'))
    await flush()
    expect(warn()).toBeNull()
  })

  it('a new charge still warns as before', async () => {
    await db.transactions.add(row(45, { date: '2026-07-02', amount: 560, note: 'BIG SHOP' }))
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} />)
    fireEvent.change(amountInput(), { target: { value: '20' } })
    fireEvent.change(dateInput(), { target: { value: '2026-07-20' } })
    fireEvent.click(chip('Groceries'))
    await waitFor(() => expect(warn()?.textContent).toBe('Only $20.00 left in Groceries after this.'))
  })
})

describe('B94: focus on the keyboard path to delete', () => {
  /** A list behind the sheet, as Activity renders it: focusable rows in a pane. */
  function list() {
    const pane = document.createElement('section')
    pane.className = 'pane'
    pane.setAttribute('data-test-list', '')
    for (const id of ['a', 'b', 'c']) {
      const li = document.createElement('li')
      li.className = 'txn-row'
      li.tabIndex = 0
      li.id = `row-${id}`
      pane.appendChild(li)
    }
    document.body.appendChild(pane)
    return pane
  }
  function Edit({ t }: { t: Transaction }) {
    const [open, setOpen] = useState(true)
    return open ? <TransactionSheet categories={CATEGORIES} initial={t} onClose={() => setOpen(false)} /> : null
  }

  it('arming focuses Cancel, Cancel returns to Delete, and a delete lands on the next row', async () => {
    const t = row(42)
    await db.transactions.add(t)
    list()
    ;(document.getElementById('row-b') as HTMLElement).focus()
    render(<Edit t={t} />)
    fireEvent.click(screen.getByTestId('txn-delete'))
    expect(document.activeElement?.textContent).toBe('Cancel')
    fireEvent.click(screen.getByText('Cancel'))
    expect(document.activeElement).toBe(screen.getByTestId('txn-delete'))
    fireEvent.click(screen.getByTestId('txn-delete'))
    now += 1000
    fireEvent.click(screen.getByText('Delete transaction'))
    await waitFor(() => expect(document.querySelector('.sheet')).toBeNull())
    await waitFor(() => expect(document.activeElement?.id).toBe('row-c'))
  })

  it('the last row hands focus to the one before it', async () => {
    const t = row(42)
    await db.transactions.add(t)
    list()
    ;(document.getElementById('row-c') as HTMLElement).focus()
    render(<Edit t={t} />)
    fireEvent.click(screen.getByTestId('txn-delete'))
    now += 1000
    fireEvent.click(screen.getByText('Delete transaction'))
    await waitFor(() => expect(document.querySelector('.sheet')).toBeNull())
    await waitFor(() => expect(document.activeElement?.id).toBe('row-b'))
  })
})

describe('B95: an add says where it went', () => {
  it('reports the date the row was filed under', async () => {
    const onAdded = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={() => {}} onAdded={onAdded} />)
    fireEvent.change(amountInput(), { target: { value: '9.99' } })
    fireEvent.change(dateInput(), { target: { value: '2026-08-12' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('2026-08-12'))
  })

  it('an edit does not', async () => {
    const t = row(42)
    await db.transactions.add(t)
    const onAdded = vi.fn()
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={onClose} onAdded={onAdded} />)
    fireEvent.change(amountInput(), { target: { value: '80' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onAdded).not.toHaveBeenCalled()
  })
})

describe('B98: words for income', () => {
  const pay = (id: number, p: Partial<Transaction> = {}) =>
    row(id, { type: 'income', categoryId: 8, amount: 1.2, note: 'Interest on Deposit', ...p })

  it('a deposit with history reads deposits, and offers no charge lookup', async () => {
    const t = pay(70)
    await db.transactions.bulkAdd([t, pay(71, { date: '2026-06-30', amount: 0.94 })])
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('.txn-history')?.textContent).toMatch(/^2 deposits · avg \$1\.07/))
    expect(screen.queryByText('Look up this charge')).toBeNull()
  })

  it('a first deposit, and a pending one', async () => {
    const t = pay(72, { pending: true, uid: 'sf:i1' })
    await db.transactions.add(t)
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('.txn-history')?.textContent).toBe('First deposit here'))
    expect(document.querySelector('.txn-pending-note')?.textContent).toMatch(/^This deposit is still pending\./)
  })

  it('a refund with one earlier charge reads "1 charge"', async () => {
    const t = row(73, { amount: -25, note: 'TEST SHOP' })
    await db.transactions.bulkAdd([t, row(74, { amount: 25, date: '2026-07-01', note: 'TEST SHOP' })])
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    await waitFor(() => expect(document.querySelector('.txn-history')?.textContent).toMatch(/^1 charge · avg \$25\.00/))
  })

  it('an expense still offers the lookup', async () => {
    const t = row(75, { note: 'TEST SHOP' })
    await db.transactions.add(t)
    render(<TransactionSheet categories={CATEGORIES} initial={t} onClose={() => {}} />)
    expect(screen.getByText('Look up this charge')).toBeTruthy()
  })
})
