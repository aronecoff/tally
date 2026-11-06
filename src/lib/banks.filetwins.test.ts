/**
 * A statement imported before a bank was linked, then the bank's copy of the same
 * money. It must count once, and a ledger with no imported rows must not notice.
 * Values are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed, errors: [] }, error: null })),
    },
  },
}))

import { syncBankTransactions } from './banks'
import { importRows, stageRows } from './csvImport'
import { db } from '../db/db'

const CARD = 'Test Card Co Gold (2222)'
const sec = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000
const row = (id: string, day: string, amount: number, payee: string, p: Partial<SyncedTx> = {}): SyncedTx => ({
  sourceTxId: `bank.test:2222:${id}`, account: CARD, tier: 'credit', posted: sec(day), amount, payee, description: payee, memo: '', mcc: null, ...p,
})
const COLS = { date: 0, note: 1, amount: 2 }
const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)
const importFile = async (rows: string[][]) => importRows(stageRows(rows, COLS, 'card-negative', await db.categories.toArray()).rows)

// Recent days, inside the window a bank sync reads.
const day = (ago: number) => new Date(Date.now() - ago * 86400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  h.feed = []
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.add({ id: 1, name: 'Dining', key: 'dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 0, updatedAt: 0 })
})

describe('a file, then a bank', () => {
  it('counts the same money once, as the bank’s row', async () => {
    await importFile([[day(5), 'HARBOR COFFEE SF', '-4.50']])
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    expect((await live()).map((t) => t.uid)).toEqual(['sf:bank.test:2222:1'])
  })

  it('keeps the file\u2019s copy where Activity offers it back, in case it was another charge', async () => {
    await importFile([[day(5), 'HARBOR COFFEE SF', '-4.50']])
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    const file = (await db.transactions.toArray()).find((t) => t.uid?.startsWith('file:'))
    expect(file).toMatchObject({ deleted: true, manual: true })
    expect(file?.retired).toBeFalsy()
  })

  it('finds a charge the bank dated a day off, by the merchant', async () => {
    await importFile([[day(5), 'HARBOR COFFEE SF', '-4.50']])
    h.feed = [row('1', day(4), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    expect(await live()).toHaveLength(1)
  })

  it('keeps both when only the amount matches on another day', async () => {
    await importFile([[day(5), 'CORNER MARKET', '-4.50']])
    h.feed = [row('1', day(4), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    expect(await live()).toHaveLength(2)
  })

  it('keeps the file’s rows the bank’s window does not reach', async () => {
    await importFile([[day(200), 'OLD CAFE', '-9.00'], [day(5), 'HARBOR COFFEE', '-4.50']])
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    expect((await live()).map((t) => t.note).sort()).toEqual(['Harbor Coffee', 'OLD CAFE'])
  })

  it('leaves the file’s copy alone once the bank’s row is in, on later syncs', async () => {
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    await importFile([[day(30), 'HARBOR COFFEE', '-4.50']]) // another charge of that size
    await syncBankTransactions()
    expect(await live()).toHaveLength(2)
  })

  it('stays out when the file comes in again afterwards', async () => {
    const file = [[day(5), 'HARBOR COFFEE SF', '-4.50']]
    await importFile(file)
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    await importFile(file)
    expect(await live()).toHaveLength(1)
  })
})

describe('a ledger with no imported rows', () => {
  it('reconciles as it always has', async () => {
    await db.transactions.add({ date: day(5), amount: 4.5, type: 'expense', categoryId: 1, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1 })
    h.feed = [row('1', day(5), -4.5, 'Harbor Coffee')]
    await syncBankTransactions()
    expect(await live()).toHaveLength(2) // a hand-typed row was never the bank's to retire
  })
})
