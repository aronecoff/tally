// @vitest-environment jsdom
/**
 * Regression guards for the transaction sheet's ledger-affecting rules.
 *
 *   Toggling Expense <-> Income must NEVER destroy the picked category.
 *
 * The original code cleared it from an effect, and that effect's
 * `if (categoryId == null) return` guard meant it never came back — so a
 * mis-tap on an already-categorized transaction silently saved
 * `categoryId: null` over real data and dropped the row out of its budget
 * totals. The category's validity for the current kind is a VIEW concern
 * (derive it), not a reason to throw the user's choice away.
 *
 * Also: Delete works without window.confirm (a silent no-op in the iOS
 * wrapper) and needs two taps; picking a chip or a type writes nothing until
 * Save; Enter submits once through the form (never through a stray default
 * button); a failed save keeps the sheet and its values; an edit to any field,
 * the date and the account included, makes a drag down spring back instead of
 * closing the sheet and losing it.
 *
 * These are component tests on purpose: a unit test of a helper would still
 * pass if someone re-added a clearing setState, which is exactly the
 * regression worth catching.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TransactionSheet } from './TransactionSheet'
import { db, type Category, type Transaction } from '../db/db'

const CATEGORIES: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
  { id: 7, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
]

const TXN: Transaction = {
  id: 42,
  date: '2026-07-24',
  amount: 74.3,
  type: 'expense',
  categoryId: 1, // Groceries
  account: 'Amex',
  note: "TRADER JOE'S #123",
  createdAt: 0,
  updatedAt: 0,
}

const PAY: Transaction = {
  id: 43,
  date: '2026-07-15',
  amount: 2875,
  type: 'income',
  categoryId: 7, // Salary
  account: 'Citizens Checking',
  note: 'ACME CORP PAYROLL',
  createdAt: 0,
  updatedAt: 0,
}

/** Which category chip is highlighted, by label. */
const selectedChip = () =>
  screen
    .getAllByRole('button')
    .filter((b) => b.className.includes('chip') && b.className.includes('on'))
    .map((b) => b.textContent?.trim())

const seg = (label: string) =>
  screen.getAllByRole('radio').find((b) => b.textContent?.trim() === label)!

const amountInput = () => screen.getByLabelText('Amount') as HTMLInputElement

/**
 * What a browser does on Enter in a text field: the keydown, then implicit
 * submission, which clicks the form's default button (its FIRST submit button
 * in tree order, wherever it sits) when that button is enabled. A button left
 * without type="button" would become that default button.
 */
function pressEnter(el: HTMLInputElement) {
  fireEvent.keyDown(el, { key: 'Enter', code: 'Enter' })
  const form = el.form
  if (!form) throw new Error('the field is not inside a form')
  const submit = Array.from(form.elements).find((x) => (x as HTMLButtonElement).type === 'submit') as
    | HTMLButtonElement
    | undefined
  if (submit && !submit.disabled) submit.click()
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 30)))

// The sheet closes through its exit animation unless Reduce Motion is on.
// Stub matchMedia to 'reduce' so onClose runs synchronously, as it does on a
// device with Reduce Motion (and in any runtime without matchMedia).
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  )
})

beforeEach(async () => {
  await db.open()
  await db.transactions.clear()
  await db.transactions.bulkAdd([TXN, PAY])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TransactionSheet — expense/income toggle', () => {
  it('keeps the picked category through an Expense -> Income -> Expense round-trip', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)

    // Opens on the stored category.
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    // Income has no Groceries — nothing valid is selected while we're here.
    fireEvent.click(seg('Income'))
    expect(selectedChip()).toEqual([])
    expect(screen.getByText('Salary')).toBeTruthy()

    // Back to Expense: the choice survived. The old code left this empty and
    // then persisted categoryId: null on save.
    fireEvent.click(seg('Expense'))
    expect(selectedChip()).toEqual(['Groceries'])
  })

  it('saves the category the user can see after the round-trip', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    fireEvent.click(seg('Income'))
    fireEvent.click(seg('Expense'))
    fireEvent.click(screen.getByText('Save'))

    // What is written must match what was highlighted — no silent null.
    await waitFor(async () => {
      const saved = await db.transactions.get(42)
      expect(saved?.categoryId).toBe(1)
      expect(saved?.type).toBe('expense')
    })
  })

  it('saves no category when the sheet is left on the other kind', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    // Switching kind and saving must not carry an expense category onto income.
    fireEvent.click(seg('Income'))
    expect(selectedChip()).toEqual([])
    fireEvent.click(screen.getByText('Save'))

    await waitFor(async () => {
      const saved = await db.transactions.get(42)
      expect(saved?.type).toBe('income')
      expect(saved?.categoryId).toBeNull()
    })
  })
})

describe('TransactionSheet — amount', () => {
  it('shows the stored amount with two decimals and saves the same value', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    expect(amountInput().value).toBe('74.30')

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect((await db.transactions.get(42))?.amount).toBe(74.3)
  })

  it('does not focus a field when an existing transaction opens', () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    expect(document.activeElement?.matches('input, textarea, select')).toBe(false)
  })
})

describe('TransactionSheet — a refund', () => {
  const REFUND: Transaction = {
    id: 44,
    date: '2026-07-20',
    amount: -18.5,
    type: 'expense',
    categoryId: 1,
    account: 'Amex',
    note: 'AMAZON MKTPLACE PMTS',
    createdAt: 0,
    updatedAt: 0,
  }
  beforeEach(async () => {
    await db.transactions.add(REFUND)
  })

  it('shows the figure unsigned and saves it back as a refund', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={REFUND} onClose={onClose} />)
    expect(amountInput().value).toBe('18.50')
    expect(screen.getByText('A refund. It comes off what you spent in its category.')).toBeTruthy()
    fireEvent.change(amountInput(), { target: { value: '20' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await db.transactions.get(44)).toMatchObject({ amount: -20, type: 'expense', manual: true })
  })

  it('switched to Income it saves as ordinary money in', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={REFUND} onClose={onClose} />)
    fireEvent.click(seg('Income'))
    fireEvent.click(screen.getByText('Salary'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(await db.transactions.get(44)).toMatchObject({ amount: 18.5, type: 'income', categoryId: 7 })
  })

  it('never warns about a budget', async () => {
    // Groceries (600) already holds 74.30 this month; a warning would need more.
    await db.transactions.add({ ...TXN, id: 45, date: '2026-07-02', amount: 560 })
    render(<TransactionSheet categories={CATEGORIES} initial={REFUND} onClose={() => {}} />)
    await flush()
    expect(document.querySelector('.limit-warn')).toBeNull()
  })
})

describe('TransactionSheet — head and account', () => {
  const SYNCED: Transaction = {
    ...TXN,
    id: 44,
    uid: 'sf:abc',
    pending: true,
    account: 'Citizens Bank Money Market Account (4837)',
    note: 'American Express',
  }

  it('names the account once, in the Account row, with its mask kept whole', () => {
    render(<TransactionSheet categories={CATEGORIES} initial={SYNCED} onClose={() => {}} />)
    const sub = document.querySelector('.txn-head-sub')?.textContent ?? ''
    expect(sub).not.toMatch(/Money Market|4837/)
    expect(sub).toMatch(/Pending/)
    // The mask is its own element, so the label ellipsizes first.
    const value = document.querySelector('.field-value')
    expect(value?.querySelector('.txn-acct-name')?.textContent).toBe('Citizens Money Market')
    expect(value?.querySelector('.txn-acct-mask')?.textContent).toBe('\u00a0··4837')
    expect(value?.textContent).toBe('Citizens Money Market\u00a0··4837')
  })
})

describe('TransactionSheet — delete', () => {
  it('needs two taps and never calls window.confirm', async () => {
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    let t = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => t)
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)

    // First tap arms: the in-sheet confirm shows and nothing is written.
    fireEvent.click(screen.getByTestId('txn-delete'))
    expect(screen.getByText('Delete this transaction? It stays deleted after the next bank sync.')).toBeTruthy()
    await flush()
    expect((await db.transactions.get(42))?.deleted).toBeFalsy()

    // A second tap that lands inside the double-tap window is ignored.
    t += 100
    fireEvent.click(screen.getByText('Delete transaction'))
    await flush()
    expect((await db.transactions.get(42))?.deleted).toBeFalsy()

    // The confirming tap runs the unchanged delete: tombstone + manual pin.
    t += 1000
    fireEvent.click(screen.getByText('Delete transaction'))
    await waitFor(async () => {
      const row = await db.transactions.get(42)
      expect(row?.deleted).toBe(true)
      expect(row?.manual).toBe(true)
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('Cancel disarms without writing', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('txn-delete'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Delete transaction')).toBeNull()
    expect(screen.getByTestId('txn-delete')).toBeTruthy()
    await flush()
    expect((await db.transactions.get(42))?.deleted).toBeFalsy()
  })
})

describe('TransactionSheet — nothing is written until Save', () => {
  it('clicking a chip or a type option writes nothing to the DB', async () => {
    const before = await db.transactions.toArray()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Groceries']))

    fireEvent.click(screen.getByText('Dining'))
    expect(selectedChip()).toEqual(['Dining'])
    fireEvent.click(seg('Income'))
    fireEvent.click(seg('Expense'))
    await flush()

    expect(await db.transactions.toArray()).toEqual(before)
  })

  it('every button except the primary is type="button"', () => {
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('txn-delete')) // show the confirm buttons too
    const submits = screen.getAllByRole('button').filter((b) => (b as HTMLButtonElement).type === 'submit')
    expect(submits.map((b) => b.textContent)).toEqual(['Save'])
  })
})

describe('TransactionSheet — Enter', () => {
  it('Enter on a NEW transaction creates exactly one row', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={null} onClose={onClose} />)
    fireEvent.change(amountInput(), { target: { value: '12.50' } })

    // Twice in quick succession: the in-flight guard lets one through.
    pressEnter(amountInput())
    pressEnter(amountInput())
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    await flush()

    const added = (await db.transactions.toArray()).filter((t) => t.id !== 42 && t.id !== 43)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ amount: 12.5, type: 'expense', manual: true })
  })

  it('Enter on an income row keeps type income', async () => {
    render(<TransactionSheet categories={CATEGORIES} initial={PAY} onClose={() => {}} />)
    await waitFor(() => expect(selectedChip()).toEqual(['Salary']))

    pressEnter(amountInput())
    await waitFor(async () => {
      const saved = await db.transactions.get(43)
      expect(saved?.manual).toBe(true)
      expect(saved?.type).toBe('income')
      expect(saved?.categoryId).toBe(7)
      expect(saved?.amount).toBe(2875)
    })
    // No stray default button was clicked on the way: the type shown is still Income.
    expect(seg('Income').getAttribute('aria-checked')).toBe('true')
    expect(selectedChip()).toEqual(['Salary'])
  })
})

describe('TransactionSheet — save outcome', () => {
  it('a successful Save calls onClose', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    fireEvent.change(amountInput(), { target: { value: '80' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect((await db.transactions.get(42))?.amount).toBe(80)
  })

  it('a failed save keeps the sheet open with its values', async () => {
    vi.spyOn(db.transactions, 'update').mockRejectedValueOnce(new Error('QuotaExceededError'))
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    fireEvent.change(amountInput(), { target: { value: '55.20' } })
    fireEvent.click(screen.getByText('Dining'))
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText('Could not save. Try again.')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(amountInput().value).toBe('55.20')
    expect(selectedChip()).toEqual(['Dining'])
    expect((await db.transactions.get(42))?.amount).toBe(74.3)

    // The guard is released on failure: a retry goes through.
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect((await db.transactions.get(42))?.amount).toBe(55.2)
  })
})

describe('TransactionSheet — unsaved edits survive a drag down', () => {
  /** A 250px downward drag on the grab area, as a finger would make it. */
  function dragDown() {
    const drag = document.querySelector('.sheet-drag') as HTMLElement
    const grab = document.querySelector('.sheet-grab') as HTMLElement
    fireEvent.pointerDown(grab, { pointerId: 1, button: 0, clientY: 100 })
    fireEvent.pointerMove(drag, { pointerId: 1, clientY: 350 })
    fireEvent.pointerUp(drag, { pointerId: 1, clientY: 350 })
  }

  it('an untouched sheet closes on the drag', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    await flush()
    dragDown()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a date-only edit keeps the sheet open', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-07-02' } })
    await flush()
    dragDown()
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-07-02')
  })

  it('an account-only edit keeps the sheet open', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATEGORIES} initial={TXN} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'Amex Green' } })
    await flush()
    dragDown()
    expect(onClose).not.toHaveBeenCalled()
  })
})
