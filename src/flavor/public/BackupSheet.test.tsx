// @vitest-environment jsdom
/** Restoring in the public app: it says it replaces, and it asks. The figures are invented. */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackupSheet } from '../../components/BackupSheet'
import { db, type Transaction } from '../../db/db'
import { DOUBLE_TAP_MS } from '../../lib/useArmed'

const reload = vi.fn()
const written: string[] = []

async function postMessage({ method, args }: { method: string; args: { json?: string } }) {
  if (method === 'backup.list') return { backups: [] }
  if (method === 'backup.write') {
    written.push(args.json!)
    return { name: 'backup-20261105-120000.json' }
  }
  throw new Error('unavailable')
}

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 4, uid: 'tx-4', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: null, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1, deleted: false, ...over,
})

const backup = JSON.stringify({
  format: 'plainsum-backup', v: 1, exportedAt: '2026-11-01T12:00:00.000Z', app: '1.0 (1)', categories: [], transactions: [tx()], accounts: [], rules: [], prefs: {},
})

const sheet = () => document.querySelector<HTMLElement>('.sheet')!

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  vi.stubGlobal('location', { ...window.location, reload })
  reload.mockClear()
  written.length = 0
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
  await db.transactions.bulkAdd([tx({ id: 1, uid: 'now-1', note: 'Corner Market' }), tx({ id: 2, uid: 'now-2', date: '2026-10-04', note: 'Metro Fare' })])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function review() {
  render(<BackupSheet onClose={() => {}} />)
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([backup], 'backup.json')] } })
  await screen.findByText(/Restoring replaces everything on this phone/)
}

describe('a file with a stamp that cannot be read', () => {
  it('is refused in plain words, and nothing here changes', async () => {
    render(<BackupSheet onClose={() => {}} />)
    const file = JSON.stringify({ ...JSON.parse(backup), transactions: [tx({ updatedAt: 1e20 })] })
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([file], 'backup.json')] } })
    await screen.findByText('This file is not a backup from this app, or it is damaged.')
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
    expect((await db.transactions.toArray()).map((t) => t.uid)).toEqual(['now-1', 'now-2'])
    expect(written).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('replacing', () => {
  it('says what is here now, what the backup holds, and that a copy is saved first', async () => {
    await review()
    expect(sheet().textContent).toContain('holds 1 transaction, 0 categories and 0 accounts.')
    expect(sheet().textContent).toContain('which holds 2 transactions, 0 categories and 0 accounts now.')
    expect(sheet().textContent).toContain('A copy of what is here is saved first.')
    expect(await db.transactions.count()).toBe(2)
  })

  it('does nothing on one tap', async () => {
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(screen.getByRole('button', { name: 'Tap again to replace' })).toBeTruthy()
    expect(await db.transactions.count()).toBe(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('replaces on the second, after saving what was here', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await act(async () => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to replace' }))
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect((await db.transactions.toArray()).map((t) => t.uid)).toEqual(['tx-4'])
    expect(JSON.parse(written[0]).transactions).toHaveLength(2)
  })
})
