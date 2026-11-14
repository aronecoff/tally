// @vitest-environment jsdom
/**
 * Erase all data: the app goes first, then the page, and nothing is left behind.
 * The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'
import { applySyncedAccounts } from '../../lib/accountMerge'
import { startAutoBackup } from '../../lib/autoBackup'
import { localDb } from './localDb'
import { currentLedgerGeneration, eraseAllData } from './sync'

const calls: string[] = []
let fail: string | null = null
let hold: Promise<void> | null = null

async function postMessage({ method }: { method: string }) {
  calls.push(method)
  if (fail) throw new Error(fail)
  if (method === 'erase.all') await hold
  if (method === 'alerts.status') return { permission: 'allowed', budgets: true, weekly: false, weekday: 1, hour: 18, fired: [] }
  if (method === 'lock.status') return { enabled: false, available: true, biometry: 'none', after: 60 }
  return { erased: true }
}

const reload = vi.fn()

beforeEach(async () => {
  calls.length = 0
  fail = null
  hold = null
  reload.mockClear()
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  vi.stubGlobal('location', { ...window.location, reload })
  history.replaceState(null, '', '#accounts')
  localStorage.setItem('plainsum:onboarded', '1')
  localStorage.setItem('plainsum:bankCoveredTo', '123')
  localStorage.setItem('tally-theme', 'dark')
  sessionStorage.setItem('tally-month', '2026-01')
  await db.categories.add({ name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 5, sortOrder: 0, updatedAt: 1 })
  await db.transactions.add({ date: '2026-01-02', amount: 9, type: 'expense', categoryId: null, account: '', note: 'x', createdAt: 1, updatedAt: 1 })
  await db.accounts.add({ institution: 'Test Bank', name: 'Checking', type: 'cash', balance: 5, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1 })
  await localDb.rules.add({ pattern: 'x', flags: 'i', category: 'Groceries', kind: null, priority: 1, updated_at: '2026-01-01' })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  await db.delete({ disableAutoOpen: false })
  await localDb.delete({ disableAutoOpen: false })
})

const empty = async () => {
  expect(await db.categories.count()).toBe(0)
  expect(await db.transactions.count()).toBe(0)
  expect(await db.accounts.count()).toBe(0)
  expect(await localDb.rules.count()).toBe(0)
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
}

describe('eraseAllData', () => {
  it('sends no backup out while the app erases, or one would outlive it', async () => {
    let release = () => {}
    hold = new Promise((r) => (release = r))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    startAutoBackup() // a write is now waiting
    const erasing = eraseAllData()
    await vi.advanceTimersByTimeAsync(60_000) // its time comes with the rows still here
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    release()
    await erasing
    expect(calls).not.toContain('backup.write')
  })

  it('sends no widget figures once the erase has begun', async () => {
    vi.resetModules()
    const [{ eraseAllData: erase }, { startWidgetSnapshot: start }] = await Promise.all([import('./sync'), import('../../lib/widgetSnapshot')])
    let release = () => {}
    hold = new Promise((r) => (release = r))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    start() // a publish is on its way
    const erasing = erase()
    await db.transactions.add({ date: '2026-01-03', amount: 2, type: 'expense', categoryId: null, account: '', note: 'y', createdAt: 1, updatedAt: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    release()
    await erasing
    expect(calls).not.toContain('widget.publish')
  })

  it('carries on with the widget when the app could not erase, as the ledger is still here', async () => {
    vi.resetModules()
    const [{ eraseAllData: erase }, { startWidgetSnapshot: start, stopWidgetSnapshot: stop }] = await Promise.all([import('./sync'), import('../../lib/widgetSnapshot')])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    start()
    fail = 'unavailable'
    await expect(erase()).rejects.toThrow('unavailable')
    fail = null
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toContain('widget.publish')
    stop()
  })

  it('sends no alert once the erase has begun', async () => {
    vi.resetModules()
    const [{ eraseAllData: erase }, { startBudgetAlerts: start }] = await Promise.all([import('./sync'), import('../../lib/budgetAlerts')])
    await db.categories.update((await db.categories.toArray())[0].id!, { monthlyBudget: 5 })
    let release = () => {}
    hold = new Promise((r) => (release = r))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    start() // a check is on its way
    const erasing = erase()
    await db.transactions.add({ date: new Date().toLocaleDateString('en-CA'), amount: 5, type: 'expense', categoryId: null, account: '', note: 'y', createdAt: 1, updatedAt: 1 })
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    release()
    await erasing
    expect(calls).not.toContain('alerts.post')
  })

  it('carries on with alerts when the app could not erase, as the ledger is still here', async () => {
    vi.resetModules()
    const [{ eraseAllData: erase }, { startBudgetAlerts: start, stopBudgetAlerts: stop }] = await Promise.all([import('./sync'), import('../../lib/budgetAlerts')])
    await db.transactions.add({ date: new Date().toLocaleDateString('en-CA'), amount: 5, type: 'expense', categoryId: null, account: '', note: 'y', createdAt: 1, updatedAt: 1 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    start()
    fail = 'unavailable'
    await expect(erase()).rejects.toThrow('unavailable')
    fail = null
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toContain('alerts.post')
    stop()
  })

  it('asks the app first, then clears every store and starts over from Home', async () => {
    await eraseAllData()
    expect(calls).toEqual(['erase.all'])
    await empty()
    expect(document.URL.endsWith('#home')).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves everything alone when the app could not erase, so it can be tried again', async () => {
    fail = 'unavailable'
    await expect(eraseAllData()).rejects.toThrow('unavailable')
    expect(await db.transactions.count()).toBe(1)
    expect(await localDb.rules.count()).toBe(1)
    expect(localStorage.getItem('plainsum:onboarded')).toBe('1')
    expect(reload).not.toHaveBeenCalled()

    fail = null
    await eraseAllData()
    await empty()
  })

  it('carries on with backups when the app could not erase, as the ledger is still here', async () => {
    vi.resetModules()
    const [{ eraseAllData: erase }, { startAutoBackup: start, stopAutoBackup: stop }] = await Promise.all([import('./sync'), import('../../lib/autoBackup')])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    start()
    fail = 'unavailable'
    await expect(erase()).rejects.toThrow('unavailable')
    fail = null
    await vi.advanceTimersByTimeAsync(20_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toContain('backup.write')
    stop()
  })

  it('clears the page in a browser, where there is no app', async () => {
    vi.stubGlobal('webkit', undefined)
    await eraseAllData()
    await empty()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a bank answer still in the air writes nothing afterwards', async () => {
    const generation = currentLedgerGeneration()
    await eraseAllData()
    await applySyncedAccounts(
      [{ sourceAccountId: 'bank.test:a1', institution: 'Test Bank', name: 'Checking', tier: 'cash', balance: 10, currency: 'USD' }],
      'simplefin',
      { generation },
    )
    expect(await db.accounts.count()).toBe(0)
  })
})

describe('the savings plan', () => {
  it('goes with everything else: erase is erase', async () => {
    localStorage.setItem('tally:savingsPlan:v1', JSON.stringify({ goal: 800, cap: 3000, locked: true, since: '2031-03', pending: null, updatedAt: 1 }))
    await eraseAllData()
    expect(localStorage.getItem('tally:savingsPlan:v1')).toBeNull()
    // The page reloads next, and the fresh one holds no plan.
    vi.resetModules()
    expect((await import('../../lib/planCache')).getPlan()).toBeNull()
  })
})
