// @vitest-environment jsdom
/**
 * Accounts in the public build: with no bank to read there is nothing to refresh,
 * so nothing offers to. The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Accounts } from '../../components/Accounts'
import { db, type Account } from '../../db/db'

const manual = (p: Partial<Account> = {}): Account => ({
  institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 100, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1, ...p,
})

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  await db.accounts.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const refreshRow = () => screen.queryByRole('button', { name: /Refresh balances/ })
const statusLine = () => document.querySelector('.nw-status')

describe('with no bank linked', () => {
  it('shows no refresh on an empty ledger, and still offers the ways in', async () => {
    render(<Accounts active />)
    await screen.findByText('No accounts yet')
    expect(refreshRow()).toBeNull()
    expect(screen.getByRole('button', { name: /Connect a bank/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Import a file/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add manually/ })).toBeTruthy()
  })

  it('shows no refresh beside accounts typed by hand', async () => {
    await db.accounts.add(manual())
    render(<Accounts active />)
    await screen.findByText('Net worth')
    expect(refreshRow()).toBeNull()
    expect(statusLine()).toBeNull()
  })

  it('shows no refresh after a disconnect, when the rows have stopped being live', async () => {
    await db.accounts.add(manual({ source: 'simplefin', sourceAccountId: 'bank.test:c1' }))
    render(<Accounts active />)
    await screen.findByText('Net worth')
    expect(refreshRow()).toBeNull()
  })
})

describe('with a bank linked', () => {
  it('offers a refresh', async () => {
    await db.accounts.add(manual({ source: 'simplefin', sourceAccountId: 'bank.test:c1', liveSync: true }))
    render(<Accounts active />)
    await screen.findByText('Net worth')
    expect(refreshRow()).not.toBeNull()
    expect(statusLine()).not.toBeNull()
  })
})

describe('Import a file', () => {
  it('opens the import sheet', async () => {
    render(<Accounts active />)
    fireEvent.click(await screen.findByRole('button', { name: /Import a file/ }))
    await waitFor(() => expect(document.querySelector('.sheet[data-sheet="import"]')).not.toBeNull())
  })
})
