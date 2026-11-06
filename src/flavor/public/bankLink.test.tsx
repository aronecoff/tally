// @vitest-environment jsdom
/**
 * Disconnect bank: what it removes, what it keeps, and what a fetch still in the
 * air can do afterwards. The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { db } from '../../db/db'
import { bankReady } from './bankTransport'
import { clearBankState, connectBank, subscribeBankHealth, syncAllConnectors, type BankHealth } from '../../lib/banks'
import { disconnectBank } from './bankLink'
import { Account } from './Settings'

const app = {
  connected: true,
  fetches: 0,
  disconnects: 0,
  hold: null as Promise<void> | null,
  body: JSON.stringify({
    accounts: [
      {
        id: 'c1',
        name: 'Rewards Visa',
        balance: '-42.00',
        org: { domain: 'bank.test', name: 'Northgate Bank' },
        transactions: [{ id: 't1', posted: Math.floor(Date.now() / 1000) - 86400, amount: '-42.00', payee: 'Corner Cafe', description: 'Corner Cafe' }],
      },
    ],
  }),
}

async function postMessage({ method }: { method: string }) {
  if (method === 'simplefin.status') return { connected: app.connected }
  if (method === 'simplefin.claim') {
    app.connected = true
    return { connected: true }
  }
  if (method === 'simplefin.disconnect') {
    app.disconnects++
    app.connected = false
    return { connected: false }
  }
  if (method === 'simplefin.fetch') {
    app.fetches++
    await app.hold
    return { status: 200, body: app.body, used: app.fetches, cap: 24 }
  }
  throw new Error('unavailable')
}

const health = () => {
  let now: BankHealth = 'unknown'
  subscribeBankHealth((h) => { now = h })()
  return now
}

beforeEach(async () => {
  Object.assign(app, { connected: true, fetches: 0, disconnects: 0, hold: null })
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  localStorage.clear()
  clearBankState()
  await db.accounts.clear()
  await db.transactions.clear()
  await db.categories.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('disconnectBank', () => {
  it('drops the link and keeps the accounts, their keys and their rows', async () => {
    await syncAllConnectors({ force: true })
    await disconnectBank()
    expect(app.disconnects).toBe(1)
    const [a] = await db.accounts.toArray()
    expect(a).toMatchObject({ liveSync: false, source: 'simplefin', sourceAccountId: 'bank.test:c1', balance: 42 })
    expect(await db.transactions.count()).toBe(1)
  })

  it('leaves nothing asking to be reconnected, and nothing to fetch', async () => {
    await syncAllConnectors({ force: true })
    await disconnectBank()
    expect(await bankReady()).toBe(false)
    const before = app.fetches
    expect((await syncAllConnectors({ force: true })).errors).toEqual([])
    expect(app.fetches).toBe(before)
    expect(health()).toBe('unknown')
  })

  it('keeps a hand-kept account out of it', async () => {
    await db.accounts.add({ name: 'Cash', institution: 'Wallet', type: 'cash', balance: 10, liveSync: false, lastUpdated: 7, sortOrder: 0, updatedAt: 7 })
    await disconnectBank()
    expect((await db.accounts.toArray())[0].updatedAt).toBe(7)
  })

  it('writes nothing from a fetch that was already in the air', async () => {
    await syncAllConnectors({ force: true })
    await db.accounts.clear()
    await db.transactions.clear()
    let release = () => {}
    app.hold = new Promise((r) => { release = r })
    const before = app.fetches
    const run = syncAllConnectors({ force: true })
    await vi.waitFor(() => expect(app.fetches).toBe(before + 1))
    await disconnectBank()
    release()
    await run
    expect(await db.accounts.count()).toBe(0)
    expect(await db.transactions.count()).toBe(0)
  })

  it('lets the same bank back in without a second copy, reading its history again', async () => {
    await syncAllConnectors({ force: true })
    await disconnectBank()
    const before = app.fetches
    await connectBank('c2V0dXA=')
    expect(app.fetches).toBeGreaterThan(before)
    expect(await db.accounts.count()).toBe(1)
    expect((await db.accounts.toArray())[0].liveSync).toBe(true)
    expect(await db.transactions.count()).toBe(1)
  })
})

describe('Settings', () => {
  const open = async () => {
    render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
    await screen.findByText('Appearance')
  }

  it('has no Disconnect row with no bank linked', async () => {
    app.connected = false
    await open()
    await waitFor(() => expect(screen.queryByText('Acknowledgements')).not.toBeNull())
    expect(screen.queryByText('Disconnect bank')).toBeNull()
  })

  it('asks once, then says what is left to do and links to it', async () => {
    await syncAllConnectors({ force: true })
    await open()
    fireEvent.click(await screen.findByText('Disconnect bank'))
    expect(app.disconnects).toBe(0)
    screen.getByText('Your accounts and transactions stay here and stop updating.')
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await screen.findByText('Disconnected. To finish, revoke access at SimpleFIN.')
    expect(app.disconnects).toBe(1)
    expect(screen.getByRole('link', { name: 'Open SimpleFIN' }).getAttribute('href')).toBe('https://bridge.simplefin.org/')
    expect(screen.queryByText('Disconnect bank')).toBeNull()
  })

  it('says so when it could not', async () => {
    await open()
    fireEvent.click(await screen.findByText('Disconnect bank'))
    vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage: () => Promise.reject(new Error('unavailable')) } } })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await screen.findByText('Could not disconnect. Try again.')
    screen.getByText('Disconnect bank')
  })
})
