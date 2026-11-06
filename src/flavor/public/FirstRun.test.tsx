// @vitest-environment jsdom
/**
 * The first thing a new install shows. Each path has to end somewhere that works,
 * and closing the sheet at any step has to leave a working app. The figures and
 * merchants are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db } from '../../db/db'
import { hasSampleData } from './sampleData'
import { seedIfEmpty } from './seed'
import { FirstRun } from './slots'

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  localStorage.clear()
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
  await seedIfEmpty()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const flag = () => localStorage.getItem('plainsum:onboarded')
const sheet = () => document.querySelector<HTMLElement>('.sheet')

async function start() {
  const onConnectBank = vi.fn()
  render(<FirstRun onConnectBank={onConnectBank} />)
  await screen.findByRole('heading', { name: /^Welcome to / })
  return onConnectBank
}

const gone = () => waitFor(() => expect(sheet()).toBeNull())

describe('when it shows', () => {
  it('shows on a new install, with three ways in and the sample', async () => {
    await start()
    for (const name of [/Track by hand/, /Import a file/, /Connect SimpleFIN/, /Load sample data/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('does not ask for an account or a sign-in', async () => {
    await start()
    expect(sheet()?.textContent).not.toMatch(/sign in|password|email/i)
  })

  it('says SimpleFIN is a separate paid service before anyone goes there', async () => {
    await start()
    expect(sheet()?.textContent).toContain('separate paid service')
  })

  it('does not show again once it has been closed', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await gone()
    expect(flag()).toBe('1')
    cleanup()
    render(<FirstRun onConnectBank={() => {}} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(sheet()).toBeNull()
  })

  it('never covers a ledger, even if the flag is lost', async () => {
    await db.transactions.add({ date: '2026-01-02', amount: 9, type: 'expense', categoryId: null, account: '', note: 'x', createdAt: 1, updatedAt: 1 })
    render(<FirstRun onConnectBank={() => {}} />)
    await waitFor(() => expect(flag()).toBe('1'))
    expect(sheet()).toBeNull()
  })

  it('counts an account as a ledger too', async () => {
    await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 5, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1 })
    render(<FirstRun onConnectBank={() => {}} />)
    await waitFor(() => expect(flag()).toBe('1'))
    expect(sheet()).toBeNull()
  })
})

describe('by hand', () => {
  it('sets the budgets typed and leaves the rest at none', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Track by hand/ }))
    await screen.findByRole('heading', { name: 'Set your budgets' })
    const groceries = await screen.findByLabelText('Groceries')
    fireEvent.change(groceries, { target: { value: '$1,250.50' } })
    expect((groceries as HTMLInputElement).value).toBe('1250.50')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await gone()
    const cats = await db.categories.toArray()
    expect(cats.find((c) => c.key === 'groceries')?.monthlyBudget).toBe(1250.5)
    expect(cats.filter((c) => c.key !== 'groceries').every((c) => c.monthlyBudget === 0)).toBe(true)
    expect(flag()).toBe('1')
  })

  it('offers only spending categories', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Track by hand/ }))
    await screen.findByLabelText('Groceries')
    expect(screen.queryByLabelText('Salary')).toBeNull()
  })

  it('is fine with nothing typed', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Track by hand/ }))
    await screen.findByLabelText('Groceries')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await gone()
    expect((await db.categories.toArray()).every((c) => c.monthlyBudget === 0)).toBe(true)
  })

  it('ignores a dot with no figure', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Track by hand/ }))
    fireEvent.change(await screen.findByLabelText('Groceries'), { target: { value: '.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await gone()
    expect((await db.categories.toArray()).every((c) => c.monthlyBudget === 0)).toBe(true)
  })

  it('keeps one dot and cents as a budget is typed', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Track by hand/ }))
    const field = (await screen.findByLabelText('Groceries')) as HTMLInputElement
    for (const [typed, kept] of [['1.2.3', '1.23'], ['250.509', '250.50'], ['1..5', '1.5'], ['$40', '40']]) {
      fireEvent.change(field, { target: { value: typed } })
      expect(field.value).toBe(kept)
    }
    fireEvent.change(field, { target: { value: '1.2.3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await gone()
    expect((await db.categories.toArray()).find((c) => c.name === 'Groceries')?.monthlyBudget).toBe(1.23)
  })
})

describe('import a file', () => {
  const csv = (text: string, name = 'export.csv') => new File([text], name, { type: 'text/csv' })
  const pick = (file: File) =>
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })

  it('reads the columns, brings the rows in, and goes on to budgets', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Import a file/ }))
    await screen.findByRole('heading', { name: 'Import a file' })
    pick(csv('Date,Description,Amount\n2026-06-03,Corner Market,-54.20\n2026-06-01,Payroll,3200.00\n'))
    const go = await screen.findByRole('button', { name: 'Import 2 transactions' })
    expect(sheet()?.textContent).toContain('Corner Market')
    expect(document.querySelector('.sheet-actions .import-sum')?.textContent).toContain('Largest money inPayroll$3,200.00')
    fireEvent.click(go)
    await screen.findByText(/Imported 2 transactions\./)
    expect(await db.transactions.count()).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('heading', { name: 'Set your budgets' })
  })

  it('asks for the columns it could not guess', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Import a file/ }))
    await screen.findByRole('heading', { name: 'Import a file' })
    pick(csv('When,What,How much\n2026-06-03,Corner Market,-54.20\n'))
    const go = (await screen.findByRole('button', { name: 'Import 0 transactions' })) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2' } })
    expect(((await screen.findByRole('button', { name: 'Import 1 transaction' })) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so when a file has nothing to read, and stays put', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Import a file/ }))
    await screen.findByRole('heading', { name: 'Import a file' })
    pick(csv('not a table'))
    await screen.findByText(/no rows to read/)
    expect(document.querySelector('input[type=file]')).not.toBeNull()
  })

  it('warns about a file and a bank link for the same account', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Import a file/ }))
    await screen.findByText(/rows already in the app are skipped/)
  })
})

describe('connect SimpleFIN', () => {
  it('closes first, then opens the bank sheet, so two sheets are never up', async () => {
    const onConnectBank = await start()
    fireEvent.click(screen.getByRole('button', { name: /Connect SimpleFIN/ }))
    await gone()
    expect(onConnectBank).toHaveBeenCalledTimes(1)
    expect(flag()).toBe('1')
  })
})

describe('load sample data', () => {
  it('loads it and closes', async () => {
    await start()
    fireEvent.click(screen.getByRole('button', { name: /Load sample data/ }))
    await gone()
    expect(await hasSampleData()).toBe(true)
    expect(flag()).toBe('1')
  })
})

describe('after storage was lost', () => {
  const reload = vi.fn()
  const backup = JSON.stringify({
    format: 'plainsum-backup', v: 1, exportedAt: '2026-11-01T12:00:00.000Z', app: '1.0 (1)', rules: [], prefs: {}, accounts: [],
    categories: [{ id: 3, uid: 'c3', name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1 }],
    transactions: [{ id: 8, uid: 't8', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: 3, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1 }],
  })
  let saved: { name: string; at: number }[]
  let json: string

  async function postMessage({ method }: { method: string }) {
    if (method === 'backup.list') return { backups: saved }
    if (method === 'backup.read') return { json }
    if (method === 'backup.write') return { name: 'x' }
    throw new Error('unavailable')
  }

  beforeEach(async () => {
    vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
    vi.stubGlobal('location', { ...window.location, reload })
    reload.mockClear()
    saved = [{ name: 'backup-20261101-120000.json', at: 1 }]
    json = backup
    await db.categories.clear()
    await db.transactions.clear()
  })

  const offered = async () => {
    render(<FirstRun onConnectBank={() => {}} />)
    await screen.findByRole('heading', { name: 'Restore your data' })
  }

  it('does not seed over the chance to restore', async () => {
    await seedIfEmpty()
    expect(await db.categories.count()).toBe(0)
  })

  it('offers the newest backup, by day and rows, even if the onboarded flag survived', async () => {
    localStorage.setItem('plainsum:onboarded', '1')
    await offered()
    expect(sheet()!.textContent).toContain('a backup from Nov 1, 2026 holds 1 transaction.')
  })

  it('brings the ledger back', async () => {
    await offered()
    fireEvent.click(screen.getByRole('button', { name: 'Restore your data' }))
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect((await db.transactions.toArray()).map((t) => t.categoryId)).toEqual([3])
  })

  it('starts fresh when asked, with the defaults, and keeps the backups for Settings', async () => {
    await offered()
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }))
    await gone()
    await waitFor(async () => expect(await db.categories.count()).toBeGreaterThan(0))
    expect(flag()).toBe('1')
    expect(reload).not.toHaveBeenCalled()
  })

  it('never asks a device that has its data', async () => {
    await db.categories.add({ name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 1 })
    render(<FirstRun onConnectBank={() => {}} />)
    await screen.findByRole('heading', { name: /^Welcome to / })
    expect(screen.queryByRole('heading', { name: 'Restore your data' })).toBeNull()
  })

  it('seeds and goes on when the only backup will not read', async () => {
    json = 'damaged'
    render(<FirstRun onConnectBank={() => {}} />)
    await screen.findByRole('heading', { name: /^Welcome to / })
    expect(await db.categories.count()).toBeGreaterThan(0)
  })

  it('has nothing to offer a fresh install', async () => {
    saved = []
    await seedIfEmpty()
    render(<FirstRun onConnectBank={() => {}} />)
    await screen.findByRole('heading', { name: /^Welcome to / })
  })
})
