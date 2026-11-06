// @vitest-environment jsdom
/**
 * Restore in the public app, where the phone holds the only copy: a backup is the
 * ledger, and a restore puts back exactly what it holds. The figures are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Account, type Category, type Transaction } from '../../db/db'
import { buildBackup, parseBackup, planRestore, restoreBackup } from '../../lib/backup'
import { rentDatingOn, setRentDating } from '../../lib/prefs'
import { localDb } from './localDb'
import { currentLedgerGeneration } from './sync'
import { needsFirstRun } from './onboarded'
import { loadSampleData } from './sampleData'
import { seedIfEmpty } from './seed'

const calls: string[] = []
const written: string[] = []
const reload = vi.fn()

async function postMessage({ method, args }: { method: string; args: { json?: string } }) {
  calls.push(method)
  if (method === 'app.info') return { version: '1.0', build: '12' }
  if (method === 'backup.write') {
    written.push(args.json!)
    return { name: 'backup-20261105-120000.json' }
  }
  throw new Error('unavailable')
}

const cat = (over: Partial<Category> = {}): Category => ({
  id: 5, uid: 'cat-5', name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1, ...over,
})
const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 9, uid: 'sf:bank:acct:1', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: 5, account: 'Test Bank', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1, deleted: false, ...over,
})
const acct = (over: Partial<Account> = {}): Account => ({
  id: 3, uid: 'acct-3', name: 'Everyday', institution: 'Test Bank', type: 'cash', balance: 10, liveSync: true, source: 'simplefin', sourceAccountId: 'conn:1', lastUpdated: 1, sortOrder: 0, updatedAt: 1, ...over,
})

async function seed() {
  await db.categories.add(cat())
  await db.transactions.bulkAdd([tx(), tx({ id: 10, uid: 'hidden', deleted: true, manual: true, posted: '2026-10-02' })])
  await db.accounts.add(acct({ rowsSay: 'cash' }))
  await localDb.rules.add({ pattern: 'harbor', flags: 'i', category: 'Dining', kind: null, priority: 1, updated_at: '2026-01-01T00:00:00Z' })
}

beforeEach(async () => {
  calls.length = 0
  written.length = 0
  reload.mockClear()
  vi.stubGlobal('webkit', { messageHandlers: { plainsum: { postMessage } } })
  vi.stubGlobal('location', { ...window.location, reload })
  localStorage.clear()
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear(), localDb.rules.clear()])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('buildBackup', () => {
  it('carries the rows verbatim, the rules, and the preferences on the list', async () => {
    await seed()
    setRentDating(true)
    localStorage.setItem('tally-theme', 'dark')
    const backup = await buildBackup()
    expect(backup).toMatchObject({ format: 'plainsum-backup', v: 1, app: '1.0 (12)' })
    expect(backup.transactions[1]).toMatchObject({ id: 10, uid: 'hidden', deleted: true, manual: true, posted: '2026-10-02' })
    expect(backup.accounts[0]).toMatchObject({ rowsSay: 'cash' })
    expect(backup.rules).toHaveLength(1)
    expect(backup.prefs).toEqual({ 'plainsum:rentDating': '1', 'tally-theme': 'dark' })
  })

  it('holds nothing about the bank link or the device', async () => {
    await seed()
    localStorage.setItem('plainsum:bankCoveredTo', '123')
    localStorage.setItem('plainsum:bankReadTo', '456')
    localStorage.setItem('plainsum:sampleBudgets', '{}')
    localStorage.setItem('plainsum:onboarded', '1')
    localStorage.setItem('tally:lastBankFetchAt', '789')
    const text = JSON.stringify(await buildBackup())
    for (const word of ['bankCoveredTo', 'bankReadTo', 'sampleBudgets', 'onboarded', 'lastBankFetchAt', 'accessUrl', 'simplefin.org', 'token']) {
      expect(text).not.toContain(word)
    }
  })
})

describe('restoreBackup', () => {
  const cycle = async () => {
    await seed()
    setRentDating(true)
    const file = parseBackup(JSON.stringify(await buildBackup()))
    await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear(), localDb.rules.clear()])
    localStorage.clear()
    return file
  }

  it('round-trips every row with its id, so a row still points at its category', async () => {
    const before = await (async () => {
      await seed()
      return { c: await db.categories.toArray(), t: await db.transactions.toArray(), a: await db.accounts.toArray() }
    })()
    await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
    await db.categories.bulkAdd(before.c)
    await db.transactions.bulkAdd(before.t)
    await db.accounts.bulkAdd(before.a)
    const file = parseBackup(JSON.stringify(await buildBackup()))
    await db.transactions.add(tx({ id: 77, uid: 'made-later' }))
    await restoreBackup(file)
    expect(await db.categories.toArray()).toEqual(before.c)
    expect(await db.transactions.toArray()).toEqual(before.t)
    expect(await db.accounts.toArray()).toEqual(before.a)
  })

  it('puts the rules and the preferences back, reloads, and skips first run', async () => {
    const file = await cycle()
    await restoreBackup(file)
    expect(await localDb.rules.count()).toBe(1)
    expect(rentDatingOn()).toBe(true)
    expect(await needsFirstRun()).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('takes no preference that is not on the list', async () => {
    const file = await cycle()
    await restoreBackup({ ...file, prefs: { ...file.prefs, 'plainsum:onboarded': '0', 'some-other-key': 'x' } })
    expect(localStorage.getItem('plainsum:onboarded')).toBe('1')
    expect(localStorage.getItem('some-other-key')).toBeNull()
  })

  it('takes no rule that is not one', async () => {
    const file = await cycle()
    await restoreBackup({ ...file, rules: [...file.rules, { nonsense: true }] })
    expect(await localDb.rules.count()).toBe(1)
  })

  it('saves what is here first, so a restore can be undone', async () => {
    await seed()
    const file = parseBackup(JSON.stringify(await buildBackup()))
    await db.transactions.add(tx({ id: 77, uid: 'made-later' }))
    await restoreBackup(file)
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]).transactions.map((t: Transaction) => t.uid)).toContain('made-later')
    expect(await db.transactions.where('uid').equals('made-later').count()).toBe(0)
  })

  it('has a linked bank read again the days the backup does not hold', async () => {
    const file = await cycle()
    localStorage.setItem('plainsum:bankCoveredTo', '1800000000')
    localStorage.setItem('plainsum:bankReadTo', '1800000000')
    await restoreBackup(file)
    expect(localStorage.getItem('plainsum:bankCoveredTo')).toBeNull()
    expect(localStorage.getItem('plainsum:bankReadTo')).toBeNull()
  })

  it('stops a bank run in flight from writing into the restored ledger', async () => {
    const file = await cycle()
    const before = currentLedgerGeneration()
    await restoreBackup(file)
    expect(currentLedgerGeneration()).toBe(before + 1)
  })

  it('leaves the ledger as it was if the write fails', async () => {
    await seed()
    const file = parseBackup(JSON.stringify(await buildBackup()))
    await db.transactions.add(tx({ id: 77, uid: 'made-later' }))
    const before = await db.transactions.toArray()
    vi.spyOn(db.accounts, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(restoreBackup(file)).rejects.toThrow()
    expect(await db.transactions.toArray()).toEqual(before)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('a backup this app wrote', () => {
  it('comes back whole from its own text: the phone holds no other copy', async () => {
    await seedIfEmpty()
    await loadSampleData()
    const before = { c: await db.categories.toArray(), t: await db.transactions.toArray(), a: await db.accounts.toArray() }
    expect(before.t.length).toBeGreaterThan(0)
    const read = parseBackup(JSON.stringify(await buildBackup()))
    await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
    await restoreBackup(read)
    expect(await db.categories.toArray()).toEqual(before.c)
    expect(await db.transactions.toArray()).toEqual(before.t)
    expect(await db.accounts.toArray()).toEqual(before.a)
  })

  it('restores even with a row that lost its stamps, and every row then has them', async () => {
    await seed()
    await db.transactions.add({ ...tx({ id: 11, uid: 'old' }), createdAt: undefined, updatedAt: Number.NaN } as unknown as Transaction)
    await db.categories.add({ ...cat({ id: 6, uid: 'cat-6', name: 'Fun' }), updatedAt: undefined } as unknown as Category)
    await restoreBackup(parseBackup(JSON.stringify(await buildBackup())))
    expect(await db.transactions.get(11)).toMatchObject({ uid: 'old', createdAt: 0, updatedAt: 0 })
    expect(await db.categories.get(6)).toMatchObject({ uid: 'cat-6', updatedAt: 0 })
    expect(await db.transactions.count()).toBe(3)
  })

  it('refuses a stamp no version of it could have written, and leaves the ledger alone', async () => {
    await seed()
    const before = await db.transactions.toArray()
    const file = await buildBackup()
    const text = JSON.stringify({ ...file, transactions: [{ ...file.transactions[0], createdAt: 'yesterday' }, ...file.transactions.slice(1)] })
    expect(() => parseBackup(text)).toThrow(/not a backup from this app, or it is damaged/)
    expect(await db.transactions.toArray()).toEqual(before)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('restoreBackup that fails', () => {
  it('carries on with backups, as the ledger is still here', async () => {
    await seed()
    vi.resetModules()
    const [fresh, auto, data] = await Promise.all([import('../../lib/backup'), import('../../lib/autoBackup'), import('../../db/db')])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    auto.startAutoBackup()
    const file = fresh.parseBackup(JSON.stringify(await fresh.buildBackup()))
    vi.spyOn(data.db.accounts, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(fresh.restoreBackup(file)).rejects.toThrow()
    written.length = 0
    await vi.advanceTimersByTimeAsync(20_000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    expect(written).toHaveLength(1)
    auto.stopAutoBackup()
  })
})

describe('planRestore', () => {
  it('counts what is here and what the backup holds, removed rows aside', async () => {
    await seed()
    const file = parseBackup(JSON.stringify(await buildBackup()))
    await db.transactions.add(tx({ id: 77, uid: 'made-later' }))
    expect(await planRestore(file)).toMatchObject({
      mode: 'replace',
      backup: { transactions: 1, categories: 1, accounts: 1 },
      current: { transactions: 2, categories: 1, accounts: 1 },
    })
  })

  it('does not ask a cloud that is not there', async () => {
    await expect(planRestore(parseBackup(JSON.stringify(await buildBackup())))).resolves.toBeTruthy()
  })
})
