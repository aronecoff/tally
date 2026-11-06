// @vitest-environment jsdom
/**
 * Restore in the personal app, where the ledger's home is the cloud: it may only
 * ever add what is missing. Every figure, id and merchant here is invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ result: 'ok', calls: 0, session: false }))
vi.mock('../db/supabase', () => ({ supabase: null }))
vi.mock('../sync/sync', () => ({
  syncNow: async () => {
    sync.calls++
    return sync.result
  },
  hasCloudSession: () => sync.session,
  currentLedgerGeneration: () => 0,
}))

import { db, type Account, type Category, type Transaction } from '../db/db'
import { defaultCategories } from '../db/seed'
import { BackupError, buildBackup, mergeBackup, parseBackup, planRestore, restoreBackup, type BackupFile } from './backup'
import { replaceLedger, restoreMode } from './backupPolicy'

const cat = (over: Partial<Category> = {}): Category => ({
  id: 1, uid: 'cat-1', name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1, ...over,
})
const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 1, uid: 'tx-1', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: 1, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1, deleted: false, ...over,
})
const acct = (over: Partial<Account> = {}): Account => ({
  id: 1, uid: 'acct-1', name: 'Rainy Day', institution: 'Test Bank', type: 'cash', balance: 10, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1, ...over,
})
const file = (over: Partial<BackupFile> = {}): BackupFile => ({
  format: 'tally-backup', v: 1, exportedAt: '2026-11-01T12:00:00.000Z', app: '1.0 (1)', categories: [], transactions: [], accounts: [], rules: [], prefs: {}, ...over,
})
const text = (over: Partial<BackupFile> = {}) => JSON.stringify(file(over))
/** A row with some fields gone, as a hand-edited or an old file has it. */
function without<T extends object>(row: T, ...keys: (keyof T)[]): T {
  const copy: Partial<T> = { ...row }
  for (const key of keys) delete copy[key]
  return copy as T
}

beforeEach(async () => {
  sync.result = 'ok'
  sync.calls = 0
  sync.session = false
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
})

afterEach(() => {
  vi.restoreAllMocks()
})

const snapshot = async () => ({
  categories: await db.categories.toArray(),
  transactions: await db.transactions.toArray(),
  accounts: await db.accounts.toArray(),
})

describe('parseBackup', () => {
  const damaged = /not a backup from this app, or it is damaged/

  it('reads a good file', () => {
    expect(parseBackup(text({ categories: [cat()], transactions: [tx()], accounts: [acct()] })).transactions).toHaveLength(1)
  })

  it('refuses what is not JSON, and what is not ours', () => {
    expect(() => parseBackup('Date,Amount')).toThrow(damaged)
    expect(() => parseBackup('null')).toThrow(damaged)
    expect(() => parseBackup(text({ format: 'plainsum-backup' }))).toThrow(damaged)
  })

  it('refuses a backup from a newer version, and says why', () => {
    expect(() => parseBackup(text({ v: 2 }))).toThrow(/newer version/)
  })

  it('refuses the whole file for one damaged row', () => {
    for (const bad of [
      { transactions: [tx({ amount: Number.NaN })] },
      { transactions: [tx({ date: '11/03/2026' })] },
      { transactions: [tx({ type: 'other' as Transaction['type'] })] },
      { transactions: [tx({ uid: undefined })] },
      { categories: [cat({ kind: 'x' as Category['kind'] })] },
      { accounts: [acct({ type: 'x' as Account['type'] })] },
      { transactions: [tx(), tx({ uid: 'tx-2' })] },
    ]) {
      expect(() => parseBackup(text(bad))).toThrow(damaged)
    }
    expect(() => parseBackup(JSON.stringify({ ...file(), transactions: 'none' }))).toThrow(BackupError)
  })

  it('refuses the whole file for a stamp the sync cannot read, on any kind of row', () => {
    const word = 'yesterday' as unknown as number
    const past = 1e20 // a number, and past the last day a Date can hold
    for (const bad of [
      { transactions: [tx(), tx({ id: 2, uid: 'tx-2', createdAt: word })] },
      { transactions: [tx({ createdAt: past })] },
      { transactions: [tx({ updatedAt: word })] },
      { transactions: [tx({ updatedAt: past })] },
      { categories: [cat({ updatedAt: word })] },
      { categories: [cat({ updatedAt: past })] },
      { accounts: [acct({ updatedAt: word })] },
      { accounts: [acct({ updatedAt: past })] },
      { accounts: [acct({ lastUpdated: word })] },
      { accounts: [acct({ lastUpdated: past })] },
    ]) {
      expect(() => parseBackup(text(bad))).toThrow(damaged)
    }
  })

  it('stamps a row that has no stamp at all, older than anything, so the sync can send it', () => {
    const read = parseBackup(text({ categories: [without(cat(), 'updatedAt')], transactions: [without(tx(), 'createdAt', 'updatedAt')] }))
    expect(read.transactions[0]).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(read.categories[0]).toMatchObject({ updatedAt: 0 })
  })

  it('reads a stamp lost on the way to the file as no stamp: JSON writes NaN as null', () => {
    const read = parseBackup(text({ categories: [cat({ updatedAt: Number.NaN })], transactions: [tx({ createdAt: Number.NaN, updatedAt: Number.NaN })] }))
    expect(read.transactions[0]).toMatchObject({ createdAt: 0, updatedAt: 0 })
    expect(read.categories[0]).toMatchObject({ updatedAt: 0 })
  })

  it('keeps every stamp a row does have', () => {
    const read = parseBackup(text({ categories: [cat({ updatedAt: 7 })], transactions: [tx({ createdAt: 5, updatedAt: 6 })], accounts: [acct({ updatedAt: 8, lastUpdated: 9 })] }))
    expect(read.transactions[0]).toMatchObject({ createdAt: 5, updatedAt: 6 })
    expect(read.categories[0]).toMatchObject({ updatedAt: 7 })
    expect(read.accounts[0]).toMatchObject({ updatedAt: 8, lastUpdated: 9 })
  })

  it('fills in what an older file left out', () => {
    const { rules, prefs, ...rest } = file()
    void rules
    void prefs
    expect(parseBackup(JSON.stringify(rest))).toMatchObject({ rules: [], prefs: {} })
  })
})

describe('a backup this app wrote', () => {
  const emptyLedger = () => Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])

  it('comes back whole from its own text', async () => {
    await db.categories.bulkAdd(defaultCategories())
    const dining = (await db.categories.toArray())[0].id!
    await db.transactions.bulkAdd([tx({ id: undefined, categoryId: dining }), tx({ id: undefined, uid: 'tx-2', date: '2026-10-05', note: 'Corner Market', amount: 12, categoryId: null })])
    await db.accounts.add(acct({ id: undefined }))
    const before = await snapshot()
    const read = parseBackup(JSON.stringify(await buildBackup()))
    await emptyLedger()
    await expect(restoreBackup(read)).resolves.toMatchObject({ transactions: 2, accounts: 1 })
    const after = await snapshot()
    // A merge hands out its own ids, and files each row under the category of that name.
    const noIds = <T extends object>(rows: T[], ...keys: (keyof T)[]) => rows.map((r) => without(r, ...keys))
    expect(noIds(after.transactions, 'id', 'categoryId')).toEqual(noIds(before.transactions, 'id', 'categoryId'))
    expect(noIds(after.categories, 'id', 'seeded')).toEqual(noIds(before.categories, 'id', 'seeded'))
    expect(noIds(after.accounts, 'id')).toEqual(noIds(before.accounts, 'id'))
  })

  it('restores even with a row that lost its stamps, and every row then has them', async () => {
    const lost = { ...tx({ uid: 'tx-old', id: undefined }), createdAt: undefined, updatedAt: Number.NaN } as unknown as Transaction
    await db.transactions.bulkAdd([tx({ id: undefined }), lost])
    await db.categories.add({ ...cat({ id: undefined }), updatedAt: undefined } as unknown as Category)
    const read = parseBackup(JSON.stringify(await buildBackup()))
    await emptyLedger()
    await restoreBackup(read)
    const { transactions, categories } = await snapshot()
    expect(transactions).toHaveLength(2)
    expect(transactions.every((t) => Number.isFinite(t.createdAt) && Number.isFinite(t.updatedAt))).toBe(true)
    expect(categories.every((c) => Number.isFinite(c.updatedAt))).toBe(true)
  })
})

describe('buildBackup', () => {
  it('holds every row verbatim, with no rules and no preferences in the personal app', async () => {
    await db.categories.add(cat())
    await db.transactions.add(tx({ posted: '2026-10-02', deleted: true }))
    await db.accounts.add(acct({ rowsSay: 'cash' }))
    const backup = await buildBackup()
    expect(backup).toMatchObject({ format: 'tally-backup', v: 1, rules: [], prefs: {} })
    expect(backup.transactions[0]).toMatchObject({ id: 1, uid: 'tx-1', posted: '2026-10-02', deleted: true })
    expect(backup.accounts[0].rowsSay).toBe('cash')
    expect(parseBackup(JSON.stringify(backup)).categories).toHaveLength(1)
  })
})

describe('the personal app cannot replace', () => {
  it('has only the merge', async () => {
    expect(restoreMode).toBe('merge')
    await expect(replaceLedger(file())).rejects.toThrow()
  })

  it('never clears a table', async () => {
    await db.transactions.add(tx({ uid: 'here' }))
    const clear = vi.spyOn(db.transactions, 'clear')
    const bulkPut = vi.spyOn(db.transactions, 'bulkPut')
    const del = vi.spyOn(db.transactions, 'delete')
    expect(await restoreBackup(file({ transactions: [tx({ id: 9, uid: 'gone', date: '2026-01-01' })] }))).toMatchObject({ transactions: 1 })
    expect(clear).not.toHaveBeenCalled()
    expect(bulkPut).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })
})

describe('planRestore', () => {
  it('brings the ledger up to date first, so the numbers are the cloud’s too', async () => {
    await planRestore(file())
    expect(sync.calls).toBe(1)
  })

  it('stops when the cloud cannot be read, and nothing changes', async () => {
    sync.result = 'failed'
    await db.transactions.add(tx())
    const before = await snapshot()
    await expect(planRestore(file({ transactions: [tx({ id: 9, uid: 'x', date: '2026-01-01' })] }))).rejects.toThrow(/Could not reach the cloud/)
    expect(await snapshot()).toEqual(before)
  })

  it('goes on when signed out, because there is no cloud to read', async () => {
    sync.result = 'skipped'
    await expect(planRestore(file())).resolves.toMatchObject({ mode: 'merge' })
  })

  it('stops when signed in and the sync was only skipped, as it is offline', async () => {
    sync.result = 'skipped'
    sync.session = true
    await expect(planRestore(file())).rejects.toThrow(BackupError)
    await expect(planRestore(file())).rejects.toThrow(/Could not reach the cloud/)
  })

  it('counts a row left out for its look-alike, and no removed row beside it', async () => {
    await db.transactions.bulkAdd([
      tx({ uid: 'sf:bank:acct:1', note: 'BANK WORDS' }),
      tx({ id: 2, uid: 'sf:bank:acct:2', note: 'BANK WORDS TOO' }),
      tx({ id: 3, uid: 'tx-gone', deleted: true }),
    ])
    const plan = await planRestore(file({ transactions: [tx({ id: 7, uid: 'tx-new', note: 'Other words' }), tx({ id: 8, uid: 'tx-gone' })] }))
    expect(plan).toMatchObject({ removed: 1, alike: 1, add: { transactions: 0 } })
  })

  it('changes nothing, and says what a restore would do', async () => {
    await db.categories.add(cat())
    await db.transactions.bulkAdd([
      tx(),
      tx({ id: 2, uid: 'tx-gone', deleted: true, date: '2026-10-05' }),
      tx({ id: 3, uid: 'sf:bank:acct:1', date: '2026-08-10', amount: 9, note: 'BANK WORDS' }),
    ])
    const before = await snapshot()
    const plan = await planRestore(
      file({
        categories: [cat(), cat({ id: 2, uid: 'cat-new', name: 'Pets' })],
        transactions: [
          tx(),
          tx({ id: 2, uid: 'tx-gone', date: '2026-10-05' }),
          tx({ id: 3, uid: 'tx-new', date: '2026-09-01', categoryId: 2 }),
          tx({ id: 4, uid: 'tx-old-removed', date: '2026-09-02', deleted: true }),
          tx({ id: 5, uid: 'tx-alike', date: '2026-08-10', amount: 9, note: 'SQ *COFFEE' }),
        ],
        accounts: [acct()],
      }),
    )
    expect(plan).toEqual({
      mode: 'merge',
      backup: { transactions: 4, categories: 2, accounts: 1 },
      current: { transactions: 2, categories: 1, accounts: 0 },
      add: { transactions: 1, categories: 1, accounts: 1 },
      here: 1,
      removed: 1,
      alike: 1,
    })
    expect(await snapshot()).toEqual(before)
  })
})

describe('mergeBackup', () => {
  it('leaves every row here exactly as it is, in value and in stamp', async () => {
    await db.categories.add(cat({ monthlyBudget: 250, updatedAt: 500 }))
    await db.transactions.add(tx({ amount: 9, note: 'Edited since', manual: true, updatedAt: 500 }))
    await db.accounts.add(acct({ balance: 77, updatedAt: 500 }))
    const before = await snapshot()
    await mergeBackup(file({ categories: [cat()], transactions: [tx()], accounts: [acct()] }))
    expect(await snapshot()).toEqual(before)
  })

  it('adds a missing row with its id and stamps, so a newer row in the cloud still wins', async () => {
    await db.categories.add(cat())
    await mergeBackup(file({ categories: [cat()], transactions: [tx({ id: 40, uid: 'sf:bank:acct:7', updatedAt: 123, createdAt: 45 })] }))
    const [row] = await db.transactions.toArray()
    expect(row).toMatchObject({ uid: 'sf:bank:acct:7', updatedAt: 123, createdAt: 45 })
    expect(row.id).not.toBe(40)
  })

  it('keeps a removed row removed, and never applies a backup’s removal', async () => {
    await db.transactions.bulkAdd([tx({ uid: 'stays-removed', deleted: true }), tx({ id: 2, uid: 'stays-live', date: '2026-10-09' })])
    const before = await snapshot()
    await mergeBackup(file({ transactions: [tx({ uid: 'stays-removed' }), tx({ id: 2, uid: 'stays-live', date: '2026-10-09', deleted: true })] }))
    expect(await snapshot()).toEqual(before)
  })

  it('does not double a row under another id, or one worded another way', async () => {
    await db.transactions.add(tx({ uid: 'sf:bank:acct:1' }))
    const added = await mergeBackup(
      file({ transactions: [tx({ id: 5, uid: 'typed-in' }), tx({ id: 6, uid: 'sf:bank:acct:2', date: '2026-10-04', note: 'SQ *COFFEE' })] }),
    )
    expect(added.transactions).toBe(1)
    expect(await db.transactions.count()).toBe(2)
  })

  it('brings back a row that only shares an amount with one nearby, as no one can be asked', async () => {
    await db.transactions.add(tx({ uid: 'sf:bank:acct:1', date: '2026-10-05', note: 'Corner Market' }))
    expect((await mergeBackup(file({ transactions: [tx({ id: 5, uid: 'lost' })] }))).transactions).toBe(1)
  })

  it('files a row under the category of that name here, whatever its id', async () => {
    await db.categories.bulkAdd([cat({ id: 7, uid: 'other-1', name: 'Fun' }), cat({ id: 8, uid: 'other-2', name: 'dining ' })])
    await mergeBackup(file({ categories: [cat({ id: 1 })], transactions: [tx({ categoryId: 1 })] }))
    expect((await db.transactions.toArray())[0].categoryId).toBe(8)
    expect(await db.categories.count()).toBe(2)
  })

  it('brings a missing category back, and files its rows under it', async () => {
    await db.categories.add(cat({ id: 7, uid: 'other', name: 'Fun' }))
    await mergeBackup(file({ categories: [cat({ id: 1 })], transactions: [tx({ categoryId: 1 })] }))
    const back = (await db.categories.toArray()).find((c) => c.uid === 'cat-1')!
    expect(back.id).not.toBe(1)
    expect((await db.transactions.toArray())[0].categoryId).toBe(back.id)
  })

  it('never brings back a category removed here, and leaves its rows unfiled', async () => {
    await db.categories.add(cat({ deleted: true, monthlyBudget: 0 }))
    await mergeBackup(file({ categories: [cat()], transactions: [tx({ categoryId: 1 })] }))
    expect((await db.categories.toArray()).filter((c) => !c.deleted)).toEqual([])
    expect((await db.transactions.toArray())[0].categoryId).toBeNull()
  })

  it('leaves a row unfiled when its category is not in the file', async () => {
    await mergeBackup(file({ transactions: [tx({ categoryId: 99 })] }))
    expect((await db.transactions.toArray())[0].categoryId).toBeNull()
  })

  it('adds a missing account, and no second copy of one here', async () => {
    await db.accounts.bulkAdd([
      acct({ id: 1, uid: 'same-uid' }),
      acct({ id: 2, uid: 'a2', name: 'Linked', source: 'simplefin', sourceAccountId: 'conn:1' }),
      acct({ id: 3, uid: 'a3', name: 'Typed In' }),
      acct({ id: 4, uid: 'removed', name: 'Old', deleted: true }),
    ])
    const added = await mergeBackup(
      file({
        accounts: [
          acct({ id: 1, uid: 'same-uid' }),
          acct({ id: 2, uid: 'b2', name: 'Linked again', source: 'simplefin', sourceAccountId: 'conn:1' }),
          acct({ id: 3, uid: 'b3', name: 'typed in' }),
          acct({ id: 4, uid: 'removed', name: 'Old' }),
          acct({ id: 5, uid: 'b5', name: 'Brand New' }),
          acct({ id: 6, uid: 'b6', name: 'Gone In File', deleted: true }),
        ],
      }),
    )
    expect(added.accounts).toBe(1)
    expect((await db.accounts.toArray()).map((a) => a.name)).toEqual(['Rainy Day', 'Linked', 'Typed In', 'Old', 'Brand New'])
  })

  it('adds nothing the second time', async () => {
    const backup = file({ categories: [cat()], transactions: [tx()], accounts: [acct()] })
    await mergeBackup(backup)
    const before = await snapshot()
    expect(await mergeBackup(backup)).toEqual({ transactions: 0, categories: 0, accounts: 0 })
    expect(await snapshot()).toEqual(before)
  })

  it('rolls everything back if a row cannot be written', async () => {
    await db.categories.add(cat({ id: 7, uid: 'other', name: 'Fun' }))
    const before = await snapshot()
    vi.spyOn(db.accounts, 'bulkAdd').mockRejectedValueOnce(new Error('disk full'))
    await expect(mergeBackup(file({ categories: [cat({ id: 1 })], transactions: [tx()], accounts: [acct()] }))).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })
})
