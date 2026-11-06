// @vitest-environment jsdom
/**
 * Where a haptic plays. It marks a change that landed, so it comes after the write, once,
 * and a Save with nothing to save, a first tap on Delete and a write that failed all stay
 * still. Values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AccountSheet } from './AccountSheet'
import { Categories } from './Categories'
import { CommandSheet } from './CommandSheet'
import { TransactionSheet } from './TransactionSheet'
import { db, type Account, type Category, type Transaction } from '../db/db'
import { applyPlan } from '../lib/commandRun'

vi.mock('../db/supabase', () => ({ supabase: null }))
vi.mock('../lib/commandRun', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/commandRun')>()
  return { ...real, applyPlan: vi.fn(real.applyPlan) }
})

const CATS: Category[] = [
  { id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]
const ROW: Transaction = { id: 42, date: '2026-09-12', amount: 74.3, type: 'expense', categoryId: 1, account: 'Card', note: 'Sample Shop', createdAt: 0, updatedAt: 0 }
const ACCT: Account = { id: 5, institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 1000, liveSync: false, lastUpdated: 1, sortOrder: 1, updatedAt: 1 }

let played: string[] = []
let now = 10_000

/** Past the double-tap window, as a person's second tap is. */
const later = () => {
  now += 1000
}
const settled = async (check: () => void | Promise<void>) => {
  await waitFor(check)
  await act(() => new Promise((r) => setTimeout(r, 10)))
}

beforeEach(async () => {
  played = []
  now = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  vi.stubGlobal('webkit', {
    messageHandlers: {
      tally: {
        postMessage: async ({ method, args }: { method: string; args: { kind: string } }) => {
          if (method === 'haptic.play') played.push(args.kind)
          return {}
        },
      },
    },
  })
  await db.open()
  await Promise.all([db.transactions.clear(), db.categories.clear(), db.accounts.clear()])
  await db.categories.bulkAdd(CATS)
  await db.transactions.add(ROW)
  await db.accounts.add(ACCT)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the transaction sheet', () => {
  function edit(props: Partial<Parameters<typeof TransactionSheet>[0]> = {}) {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATS} initial={ROW} onClose={onClose} {...props} />)
    return onClose
  }

  it('plays success once when a new row is added', async () => {
    const onClose = vi.fn()
    render(<TransactionSheet categories={CATS} initial={null} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '9.00' } })
    fireEvent.click(screen.getByText('Add'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['success'])
  })

  it('plays success when an edit is saved', async () => {
    const onClose = edit()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '80.00' } })
    fireEvent.click(screen.getByText('Save'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['success'])
  })

  it('stays still when Save had nothing to save', async () => {
    const onClose = edit()
    fireEvent.click(screen.getByText('Save'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual([])
  })

  it('stays still when the write fails', async () => {
    vi.spyOn(db.transactions, 'update').mockRejectedValueOnce(new Error('QuotaExceededError'))
    edit()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '80.00' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText('Could not save. Try again.')).toBeTruthy()
    expect(played).toEqual([])
  })

  it('plays light through the sort queue, and success on its last row', async () => {
    const onSaved = vi.fn()
    edit({ onSaved, progress: '1 of 2', remaining: 1 })
    later()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '80.00' } })
    fireEvent.click(screen.getByText('Save & next'))
    await settled(() => expect(onSaved).toHaveBeenCalled())
    expect(played).toEqual(['light'])
    cleanup()
    played = []

    const last = vi.fn()
    edit({ onSaved: last, progress: '2 of 2', remaining: 0 })
    later()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '81.00' } })
    fireEvent.click(screen.getByText('Save'))
    await settled(() => expect(last).toHaveBeenCalled())
    expect(played).toEqual(['success'])
  })

  it('plays warning on the confirming tap of a delete, not the first', async () => {
    const onClose = edit()
    fireEvent.click(screen.getByTestId('txn-delete'))
    expect(played).toEqual([])
    later()
    fireEvent.click(screen.getByText('Delete transaction'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['warning'])
  })

  it('stays still when the delete fails', async () => {
    vi.spyOn(db.transactions, 'update').mockRejectedValueOnce(new Error('QuotaExceededError'))
    edit()
    fireEvent.click(screen.getByTestId('txn-delete'))
    later()
    fireEvent.click(screen.getByText('Delete transaction'))
    expect(await screen.findByText('Could not delete. Try again.')).toBeTruthy()
    expect(played).toEqual([])
  })
})

describe('the account sheet', () => {
  const edit = async () => {
    const onClose = vi.fn()
    render(<AccountSheet initial={ACCT} onClose={onClose} />)
    await waitFor(() => expect((screen.getByLabelText('Balance') as HTMLInputElement).value).not.toBe(''))
    return onClose
  }

  it('plays success on a saved change', async () => {
    const onClose = await edit()
    fireEvent.change(screen.getByLabelText('Balance'), { target: { value: '1200.00' } })
    fireEvent.click(screen.getByText('Save'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['success'])
  })

  it('plays success on a new account', async () => {
    const onClose = vi.fn()
    render(<AccountSheet initial={null} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('Institution'), { target: { value: 'Test Bank' } })
    fireEvent.click(document.querySelector('.sheet-actions .btn-primary')!)
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['success'])
  })

  it('stays still on a plain Save', async () => {
    const onClose = await edit()
    fireEvent.click(screen.getByText('Save'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual([])
  })

  it('plays warning on the confirming tap of a delete', async () => {
    const onClose = await edit()
    fireEvent.click(screen.getByText('Delete account'))
    expect(played).toEqual([])
    later()
    fireEvent.click(screen.getByText('Tap again to delete'))
    await settled(() => expect(onClose).toHaveBeenCalled())
    expect(played).toEqual(['warning'])
  })
})

describe('a category', () => {
  it('plays warning on the confirming tap of a delete', async () => {
    render(<Categories categories={CATS} />)
    const row = screen.getByText('Dining', { selector: '.cat-name' }).closest('.cat-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { expanded: false }))
    const del = () => within(row).getByRole('button', { name: /delete/i })
    fireEvent.click(del())
    expect(played).toEqual([])
    later()
    fireEvent.click(del())
    await settled(async () => expect((await db.categories.get(2))?.deleted).toBe(true))
    expect(played).toEqual(['warning'])
  })
})

describe('Tell Tally', () => {
  async function preview() {
    render(<CommandSheet categories={CATS} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'set dining budget to 350' } })
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByText('Apply')
    later()
  }

  it('stays still at Preview, and plays success on Apply', async () => {
    await preview()
    expect(played).toEqual([])
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    await settled(() => expect(played).toEqual(['success']))
  })

  it('stays still on Undo', async () => {
    await preview()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    await settled(() => expect(played).toHaveLength(1))
    later()
    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Undone')
    await settled(() => expect(played).toHaveLength(1))
  })

  it('plays warning when only part of a plan landed', async () => {
    vi.mocked(applyPlan).mockResolvedValueOnce({ rows: [], title: 'Forgot 1 of 2 rules' })
    await preview()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Forgot 1 of 2 rules')
    await settled(() => expect(played).toEqual(['warning']))
  })

  it('stays still when Apply fails', async () => {
    vi.mocked(applyPlan).mockRejectedValueOnce(new Error('QuotaExceededError'))
    await preview()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Could not save. Try again.')
    expect(played).toEqual([])
  })
})
