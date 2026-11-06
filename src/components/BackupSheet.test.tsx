// @vitest-environment jsdom
/**
 * Restoring in the personal app: it shows what would happen, and nothing is written
 * before a confirming second tap. The figures and merchants are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const sync = vi.hoisted(() => ({ result: 'ok' }))
vi.mock('../db/supabase', () => ({ supabase: null }))
vi.mock('../sync/sync', () => ({ syncNow: async () => sync.result, currentLedgerGeneration: () => 0 }))

import { db, type Transaction } from '../db/db'
import { DOUBLE_TAP_MS } from '../lib/useArmed'
import { standIn, type Shell } from '../test-shells'
import { BackupSheet } from './BackupSheet'

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 1, uid: 'tx-1', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: null, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1, deleted: false, ...over,
})

const backup = (transactions: Transaction[]) =>
  JSON.stringify({ format: 'tally-backup', v: 1, exportedAt: '2026-11-01T12:00:00.000Z', app: '1.0 (1)', categories: [], transactions, accounts: [], rules: [], prefs: {} })

const sheet = () => document.querySelector<HTMLElement>('.sheet')!

function choose(text: string) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([text], 'backup.json')] } })
}

const tap = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }))
  await act(async () => {
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
  })
}

beforeEach(async () => {
  sync.result = 'ok'
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('in a browser or the Mac app', () => {
  it('offers to export and to restore from a file, with no list of saved copies', async () => {
    render(<BackupSheet onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Export a backup' })).toBeTruthy()
    expect(screen.getByText('Restore from a file')).toBeTruthy()
    expect(sheet().textContent).toContain('Export a backup to keep a copy')
  })
})

describe('on each shell', () => {
  it.each<Shell>(['safariOnMac', 'chromeOnMac', 'macApp', 'iphoneApp'])('offers both ways in %s', async (shell) => {
    standIn(shell)
    render(<BackupSheet onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Export a backup' })).toBeTruthy()
    expect(screen.getByText('Restore from a file')).toBeTruthy()
    await act(async () => {})
  })

  it('has no Export in an old iPhone app, and does not promise one', () => {
    standIn('oldIphoneApp')
    render(<BackupSheet onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Export a backup' })).toBeNull()
    expect(screen.getByText('Restore from a file')).toBeTruthy()
    expect(sheet().textContent).not.toMatch(/export/i)
  })
})

describe('in the iPhone app', () => {
  async function postMessage({ method, args }: { method: string; args: { name?: string } }) {
    if (method === 'backup.list') return { backups: [{ name: 'backup-20261101-120000.json', at: Date.parse('2026-11-01T12:00:00Z') }] }
    if (method === 'backup.read') return args.name === 'backup-20261101-120000.json' ? { json: backup([tx()]) } : Promise.reject(new Error('no_backup'))
    throw new Error('unavailable')
  }

  beforeEach(() => {
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  })

  it('lists the saved copies, and reads one', async () => {
    render(<BackupSheet onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Nov 1, 2026/ }))
    await screen.findByText(/Restoring adds 1 transaction/)
  })
})

describe('restoring', () => {
  it('refuses a file with a stamp the sync cannot read, says so plainly, and writes nothing', async () => {
    await db.transactions.add(tx({ uid: 'here', note: 'Corner Market', date: '2026-10-05' }))
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx(), tx({ id: 2, uid: 'tx-2', createdAt: 'yesterday' as unknown as number })]))
    await screen.findByText('This file is not a backup from this app, or it is damaged.')
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
    expect((await db.transactions.toArray()).map((t) => t.uid)).toEqual(['here'])
  })

  it('shows what would be added and changes nothing yet', async () => {
    await db.transactions.add(tx({ uid: 'here', note: 'Corner Market', date: '2026-10-05' }))
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx()]))
    await screen.findByText(/Restoring adds 1 transaction missing here/)
    expect(sheet().textContent).toContain('Nothing here is changed or removed.')
    expect(await db.transactions.count()).toBe(1)
  })

  it('needs a second tap, a real one, and then says what it added', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx()]))
    await screen.findByText(/Restoring adds/)
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to add' })) // a double tap
    expect(await db.transactions.count()).toBe(0)
    await act(async () => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
    })
    expect(await db.transactions.count()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to add' }))
    await screen.findByText('Added 1 transaction.')
    expect(await db.transactions.count()).toBe(1)
  })

  it('offers nothing to tap when nothing is missing, and says what stayed', async () => {
    await db.transactions.bulkAdd([tx(), tx({ id: 2, uid: 'gone', deleted: true, date: '2026-10-07' })])
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx(), tx({ id: 2, uid: 'gone', date: '2026-10-07' })]))
    await screen.findByText(/there is nothing to add/)
    expect(sheet().textContent).toContain('1 transaction already here.')
    expect(sheet().textContent).toContain('1 transaction removed since, and staying out.')
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('goes back to the list without writing anything', async () => {
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx()]))
    await screen.findByText(/Restoring adds/)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('button', { name: 'Export a backup' })
    expect(await db.transactions.count()).toBe(0)
  })

  it('stops at once if the cloud cannot be read', async () => {
    sync.result = 'failed'
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx()]))
    await screen.findByText(/Could not reach the cloud/)
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
    expect(await db.transactions.count()).toBe(0)
  })

  it('says so when a file is not a backup', async () => {
    render(<BackupSheet onClose={() => {}} />)
    choose('Date,Description,Amount\n')
    await screen.findByText(/not a backup from this app/)
  })

  it('does not leave a confirmed tap armed after a failure', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    render(<BackupSheet onClose={() => {}} />)
    choose(backup([tx()]))
    await screen.findByText(/Restoring adds/)
    vi.spyOn(db.transactions, 'bulkAdd').mockRejectedValueOnce(new Error('disk full'))
    await tap('Restore')
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to add' }))
    await screen.findByText(/Could not restore/)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy())
    expect(await db.transactions.count()).toBe(0)
    vi.restoreAllMocks()
  })
})
