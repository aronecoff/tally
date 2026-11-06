/**
 * A backup edited by hand, then synced. The push turns every row's stamps into dates, so
 * one stamp it could not read threw for the whole push: nothing went up, and all anyone
 * saw was "Sync paused". The rows and figures are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Res = { data: never[]; error: null }
  const nothing: PromiseLike<Res> & { order: () => typeof nothing; limit: () => typeof nothing; gt: () => typeof nothing } = {
    order: () => nothing,
    limit: () => nothing,
    gt: () => nothing,
    then: (ok, bad) => Promise.resolve({ data: [], error: null } as Res).then(ok, bad),
  }
  return { nothing, upserts: {} as Record<string, Record<string, unknown>[]> }
})

vi.mock('../db/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }) },
    from: (table: string) => ({
      select: () => h.nothing,
      upsert: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        ;(h.upserts[table] ??= []).push(...[rows].flat())
        return { error: null }
      },
    }),
  },
}))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

import { db } from '../db/db'
import { mergeBackup, parseBackup } from '../lib/backup'
import { subscribeSync, syncNow, type SyncSnapshot } from './sync'

const EPOCH = new Date(0).toISOString()

const edited = JSON.stringify({
  format: 'tally-backup',
  v: 1,
  exportedAt: '2026-11-01T12:00:00.000Z',
  app: '1.0 (1)',
  categories: [{ id: 1, uid: 'cat-1', name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0 }],
  transactions: [{ id: 1, uid: 'tx-1', date: '2026-10-03', amount: 4.5, type: 'expense', categoryId: 1, account: '', note: 'Harbor Coffee' }],
  accounts: [{ id: 1, uid: 'acct-1', name: 'Rainy Day', institution: 'Test Bank', type: 'cash', balance: 10, liveSync: false, sortOrder: 0 }],
  rules: [],
  prefs: {},
})

let state: SyncSnapshot
subscribeSync((s) => (state = s))

beforeEach(async () => {
  for (const table of Object.keys(h.upserts)) delete h.upserts[table]
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
})

describe('a backup with a row that has no stamps, restored and synced', () => {
  it('goes up whole, with stamps older than anything in the cloud', async () => {
    await mergeBackup(parseBackup(edited))
    await syncNow()
    expect(state.status).toBe('synced')
    expect(h.upserts.transactions).toEqual([expect.objectContaining({ id: 'tx-1', created_at: EPOCH, updated_at: EPOCH })])
    expect(h.upserts.categories).toEqual([expect.objectContaining({ id: 'cat-1', updated_at: EPOCH })])
    expect(h.upserts.accounts).toContainEqual(expect.objectContaining({ id: 'acct-1', updated_at: EPOCH }))
  })
})
