/**
 * B11: the `retired` mark (a pinned pending row the bank retired, banks.ts)
 * reaches other devices, so none of them offers the row back as Removed. A
 * cloud without the column yet still syncs everything else, and a device
 * infers the mark from a pending row of its own that comes back deleted and
 * posted (a hand Delete leaves pending as it was).
 *
 * The push remembers a missing column for the session (module state), so each
 * test loads a fresh sync module, as a new session: one that ran earlier, as
 * under --sequence.shuffle, never decides what this one's push sends.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state = {
    tables: { categories: new Map<string, Row>(), transactions: new Map<string, Row>() } as Record<string, Map<string, Row>>,
    /** Columns the cloud's transactions table does not have. */
    missing: new Set<string>(),
  }
  const query = (table: string) => {
    let after: string | null = null
    const q = {
      order: () => q,
      gt: (_c: string, v: string) => ((after = v), q),
      limit: () => q,
      then: (ok: (r: { data: Row[] | null; error: unknown }) => unknown, bad?: (e: unknown) => unknown) => {
        // A table the cloud does not have (accounts, before its migration).
        if (!state.tables[table]) return Promise.resolve({ data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }).then(ok, bad)
        let rows = [...state.tables[table].values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        if (after != null) rows = rows.filter((r) => String(r.id) > after!)
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(ok, bad)
      },
    }
    return q
  }
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table: string) => ({
      select: () => query(table),
      upsert: async (input: Row | Row[]) => {
        const rows = Array.isArray(input) ? input : [input]
        if (table === 'transactions') {
          for (const c of state.missing) {
            // PostgREST refuses an upsert that names a column the table does not have.
            if (rows.some((r) => c in r)) return { error: { code: 'PGRST204', message: `Could not find the '${c}' column of 'transactions' in the schema cache` } }
          }
        }
        for (const r of rows) state.tables[table].set(String(r.id), { ...r })
        return { error: null }
      },
    }),
  }
  return { state, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

import type { Transaction } from '../db/db'

let syncNow: typeof import('./sync').syncNow
let db: typeof import('../db/db').db

const iso = (ms: number) => new Date(ms).toISOString()
const cloudTx = (id: string, p: Row = {}): Row => ({
  id, user_id: 'u1', date: '2026-09-10', amount: 133, type: 'expense', category_id: null, account: 'Test Card', note: 'PLONK MARKET',
  manual: true, pending: false, deleted: false, created_at: iso(1000), updated_at: iso(1000), ...p,
})
const local = (uid: string, p: Partial<Transaction> = {}): Transaction => ({
  uid, date: '2026-09-10', amount: 133, type: 'expense', categoryId: null, account: 'Test Card', note: 'PLONK MARKET',
  manual: true, pending: false, deleted: false, createdAt: 1000, updatedAt: 2000, ...p,
})
const byUid = (uid: string) => db.transactions.where('uid').equals(uid).first()
let status = ''

beforeEach(async () => {
  vi.resetModules()
  const sync = await import('./sync')
  ;({ db } = await import('../db/db'))
  syncNow = sync.syncNow
  sync.subscribeSync((s) => (status = s.status))
  h.state.missing.clear()
  h.state.tables.categories.clear()
  h.state.tables.transactions.clear()
  await db.categories.clear()
  await db.transactions.clear()
})

describe('the retired mark across devices', () => {
  it('is sent to the cloud, and a newer cloud row brings it to this device', async () => {
    await db.transactions.add(local('sf:hold', { deleted: true, retired: true }))
    expect(await syncNow()).toBe('ok')
    expect(h.state.tables.transactions.get('sf:hold')).toMatchObject({ deleted: true, retired: true })

    await db.transactions.add(local('sf:other', { pending: true, updatedAt: 1500 }))
    h.state.tables.transactions.set('sf:other', cloudTx('sf:other', { deleted: true, retired: true, updated_at: iso(3000) }))
    await syncNow()
    expect(await byUid('sf:other')).toMatchObject({ deleted: true, retired: true })
  })

  it('a cloud without the column: the push goes without it, and everything else still syncs', async () => {
    h.state.missing.add('retired')
    await db.transactions.add(local('sf:hold', { deleted: true, retired: true, uncategorized: true }))
    expect(await syncNow()).toBe('ok')
    expect(status).toBe('synced')
    const sent = h.state.tables.transactions.get('sf:hold')!
    expect(sent).toMatchObject({ deleted: true, uncategorized: true })
    expect('retired' in sent).toBe(false)
    // This device keeps its mark.
    expect(await byUid('sf:hold')).toMatchObject({ retired: true })
  })

  it('a cloud without the column: a pending row of ours that comes back pinned, deleted and posted was retired', async () => {
    h.state.missing.add('retired')
    await db.transactions.add(local('sf:hold', { pending: true, updatedAt: 1500 }))
    await db.transactions.add(local('sf:gone', { pending: false, updatedAt: 1500 }))
    h.state.tables.transactions.set('sf:hold', cloudTx('sf:hold', { deleted: true, pending: false, updated_at: iso(3000) }))
    // A hand Delete of a posted row (control): not retired.
    h.state.tables.transactions.set('sf:gone', cloudTx('sf:gone', { deleted: true, pending: false, updated_at: iso(3000) }))
    await syncNow()
    expect(await byUid('sf:hold')).toMatchObject({ deleted: true, retired: true })
    expect(await byUid('sf:gone')).toMatchObject({ deleted: true, retired: false })
  })
})

describe('the retired-pin mark across devices', () => {
  // A pinned pending charge the bank left out of one answer, with no posted
  // row found (banks.ts). Kept on one device only, the other devices held a
  // tombstone they could never bring back when the bank listed it again.
  it('is sent to the cloud, and a newer cloud row brings it to this device', async () => {
    await db.transactions.add(local('sf:hold', { deleted: true, retired: true, retiredPin: true }))
    expect(await syncNow()).toBe('ok')
    expect(h.state.tables.transactions.get('sf:hold')).toMatchObject({ deleted: true, retired: true, retired_pin: true })

    await db.transactions.add(local('sf:other', { pending: true, updatedAt: 1500 }))
    h.state.tables.transactions.set('sf:other', cloudTx('sf:other', { deleted: true, retired: true, retired_pin: true, updated_at: iso(3000) }))
    await syncNow()
    expect(await byUid('sf:other')).toMatchObject({ deleted: true, retired: true, retiredPin: true })
  })

  it('brought back on another device: the cloud row clears it here', async () => {
    await db.transactions.add(local('sf:hold', { deleted: true, retired: true, retiredPin: true, updatedAt: 1500 }))
    h.state.tables.transactions.set('sf:hold', cloudTx('sf:hold', { deleted: false, retired: false, retired_pin: false, pending: true, updated_at: iso(3000) }))
    await syncNow()
    expect(await byUid('sf:hold')).toMatchObject({ deleted: false, retired: false, retiredPin: false })
  })

  it('a cloud without the column: the push goes without it, and this device keeps its mark', async () => {
    h.state.missing.add('retired_pin')
    await db.transactions.add(local('sf:hold', { deleted: true, retired: true, retiredPin: true }))
    expect(await syncNow()).toBe('ok')
    expect(status).toBe('synced')
    const sent = h.state.tables.transactions.get('sf:hold')!
    expect(sent).toMatchObject({ deleted: true, retired: true })
    expect('retired_pin' in sent).toBe(false)
    expect(await byUid('sf:hold')).toMatchObject({ retiredPin: true })
  })
})
