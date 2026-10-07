/**
 * A transfer's far leg ('DEPOSIT') once its partner has slid out of the bank's
 * window. The pair was matched while both legs were in the feed; the day the
 * debit aged out, the deposit used to be added as income and stayed for good.
 * Rows in the oldest few days of the feed that no rule can name are held, and
 * a real row stored earlier in that zone is neither re-read nor tombstoned.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed }, error: null })),
    },
  },
}))

import { syncBankTransactions } from './banks'
import { db } from '../db/db'

const CHK = 'Test Bank Checking (3333)'
const SAV = 'Test Bank Savings (4444)'
const CARD = 'Test Bank Rewards Visa (1111)'
const DAY = 86400
const BASE = Math.floor(Date.now() / 1000) - 200 * DAY

const row = (id: string, account: string, day: number, amount: number, description: string): SyncedTx => ({
  sourceTxId: id, account, tier: account === CARD ? 'credit' : 'cash', posted: BASE + day * DAY + 12 * 3600, amount,
  description, payee: description, memo: '', mcc: null,
})

const ALL: SyncedTx[] = [
  row('out', CHK, 0, -2500, 'ONLINE TRANSFER TO SAV'),
  row('in', SAV, 2, 2500, 'DEPOSIT'),
  row('mobile', CHK, 1, 300, 'MOBILE DEPOSIT'),
  // Everyday card spending every other day, so the window's oldest row tracks its start.
  ...Array.from({ length: 101 }, (_, i) => row(`buy${i}`, CARD, -100 + 2 * i, -12, 'CORNER CAFE')),
]
const windowFor = (today: number) => ALL.filter((t) => t.posted >= BASE + (today - 90) * DAY && t.posted <= BASE + today * DAY + DAY)

const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)

beforeEach(async () => {
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
  ])
})

describe('a transfer leg whose partner has aged out', () => {
  it('is never added as income, synced daily across the age-out', async () => {
    for (let today = 60; today <= 100; today++) {
      h.feed = windowFor(today)
      await syncBankTransactions()
      const rows = await live()
      expect(rows.find((t) => t.uid === 'sf:in'), `day ${today}`).toBeUndefined()
      // The real deposit stored while it was clear of the edge stays.
      expect(rows.find((t) => t.uid === 'sf:mobile'), `day ${today}`).toMatchObject({ type: 'income', amount: 300 })
    }
  })
})
