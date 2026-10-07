/**
 * Device sync ordering. The bank overlay awaits syncNow() so the cloud's pins
 * and moved dates are in Dexie before it reconciles. A call made while a run was
 * in flight used to return at once, so that guarantee silently failed; and a row
 * the bank added mid-pull was added a second time by the pull.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  remoteTx: [] as Record<string, unknown>[],
  beforeTxSelect: null as null | (() => Promise<void>),
  // A PostgREST-style read: the pull pages by id (order, limit, gt) until an
  // empty page. Every row comes back on the first page here.
  pageOf: (rows: () => Promise<Record<string, unknown>[]>) => {
    type Res = { data: Record<string, unknown>[]; error: null }
    let after: string | null = null
    const q: PromiseLike<Res> & { order: () => typeof q; limit: () => typeof q; gt: (c: string, v: string) => typeof q } = {
      order: () => q,
      limit: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) => (after == null ? rows() : Promise.resolve([])).then((data) => ({ data, error: null })).then(ok, bad),
    }
    return q
  },
}))

vi.mock('../db/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }) },
    from: (table: string) => ({
      select: () =>
        h.pageOf(async () => {
          if (table === 'transactions' && h.beforeTxSelect) await h.beforeTxSelect()
          return table === 'transactions' ? h.remoteTx : []
        }),
      upsert: async () => ({ error: null }),
    }),
  },
}))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

import { syncNow } from './sync'
import { db, type Transaction } from '../db/db'

const remote = (id: string, p: Record<string, unknown> = {}) => ({
  id,
  date: '2026-09-10',
  amount: 12,
  type: 'expense',
  category_id: null,
  account: 'Test Bank Checking (3333)',
  note: 'CORNER STORE',
  manual: false,
  pending: false,
  deleted: false,
  created_at: new Date(1000).toISOString(),
  updated_at: new Date(1000).toISOString(),
  ...p,
})

// A queued follow-up run may still be finishing; let it land between tests.
const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(async () => {
  h.remoteTx = []
  h.beforeTxSelect = null
  await db.categories.clear()
  await db.transactions.clear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await settle()
})

describe('syncNow', () => {
  it('a call made mid-run resolves only after that run has pulled', async () => {
    let release: (() => void) | null = null
    h.remoteTx = [remote('r1')]
    h.beforeTxSelect = () => new Promise<void>((r) => (release = r))
    const first = syncNow()
    await vi.waitFor(() => expect(release).not.toBeNull())

    let secondDone = false
    const second = syncNow().then(() => (secondDone = true))
    await settle()
    expect(secondDone).toBe(false)

    h.beforeTxSelect = null
    release!()
    await second
    // By the time the caller resumes, the pulled row is in Dexie.
    expect(await db.transactions.where('uid').equals('r1').count()).toBe(1)
    await first
  })

  it('collapses a row stored twice to its pinned copy on the next pull', async () => {
    const base = { uid: 'sf:y', amount: 2400, type: 'expense' as const, categoryId: null, account: 'A', note: 'Landlord', createdAt: 0 }
    await db.transactions.bulkAdd([
      { ...base, date: '2026-03-28', updatedAt: 900 },
      { ...base, date: '2026-04-01', manual: true, updatedAt: 100 },
    ])
    await syncNow()
    const rows = await db.transactions.where('uid').equals('sf:y').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ date: '2026-04-01', manual: true })
  })

  it('adopts a row the bank added mid-pull instead of adding a second copy', async () => {
    const bankCopy: Transaction = {
      uid: 'sf:x', date: '2026-03-28', amount: 2400, type: 'expense', categoryId: null,
      account: 'Test Bank Checking (3333)', note: 'Landlord', createdAt: 1000, updatedAt: 1000,
    }
    // The cloud holds the pinned version (moved to the 1st, manual).
    h.remoteTx = [remote('r0'), remote('sf:x', { date: '2026-04-01', amount: 2400, manual: true, updated_at: new Date(2000).toISOString() })]
    // The bank lands its copy right after the pull adds r0, before it reaches sf:x.
    const realAdd = db.transactions.add.bind(db.transactions)
    const add = async (row: Transaction) => {
      const id = await realAdd(row)
      if (row.uid === 'r0') await realAdd({ ...bankCopy })
      return id
    }
    vi.spyOn(db.transactions, 'add').mockImplementation(add as unknown as typeof db.transactions.add)

    await syncNow()
    const rows = await db.transactions.where('uid').equals('sf:x').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ date: '2026-04-01', manual: true })
  })
})
