/**
 * A category's built-in key and fixed flag travel with it between devices, so a
 * rename on one phone does not switch off fixed-bill projection on another.
 * Until the cloud has the two columns, a push carrying them is refused; the
 * push then goes again without them instead of failing every sync.
 *
 * The push remembers the missing columns for the session (module state), so
 * each test loads a fresh sync module, as a new session: a test without the
 * columns that ran earlier (--sequence.shuffle) never strips this one's push.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  remoteCats: [] as Record<string, unknown>[],
  columns: true,
  upserts: [] as { table: string; rows: Record<string, unknown>[] }[],
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
      select: () => h.pageOf(async () => (table === 'categories' ? h.remoteCats : [])),
      upsert: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(rows) ? rows : [rows]
        if (table === 'categories' && !h.columns && list.some((r) => 'key' in r || 'fixed' in r)) {
          return { error: { code: 'PGRST204', message: "Could not find the 'fixed' column of 'categories' in the schema cache" } }
        }
        h.upserts.push({ table, rows: list })
        return { error: null }
      },
    }),
  },
}))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

let syncNow: typeof import('./sync').syncNow
let db: typeof import('../db/db').db

const remoteCat = (id: string, p: Record<string, unknown> = {}) => ({
  id, name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthly_budget: 2400, sort_order: 2, deleted: false,
  updated_at: new Date(1000).toISOString(), ...p,
})

beforeEach(async () => {
  vi.resetModules()
  ;({ syncNow } = await import('./sync'))
  ;({ db } = await import('../db/db'))
  h.remoteCats = []
  h.columns = true
  h.upserts = []
  await db.categories.clear()
  await db.transactions.clear()
})

describe('category key and fixed flag', () => {
  it('pull keeps a renamed category keyed, and backfills a key the cloud lacks', async () => {
    h.remoteCats = [remoteCat('c1', { name: 'Housing', key: 'rent', fixed: true }), remoteCat('c2', { name: 'Health', key: null, fixed: null })]
    await syncNow()
    const cats = await db.categories.toArray()
    expect(cats.find((c) => c.uid === 'c1')).toMatchObject({ name: 'Housing', key: 'rent', fixed: true })
    expect(cats.find((c) => c.uid === 'c2')).toMatchObject({ name: 'Health', key: 'health' })
  })

  it('push carries key and fixed', async () => {
    await db.categories.add({ uid: 'c1', name: 'Housing', key: 'rent', fixed: true, icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 5 })
    await syncNow()
    const sent = h.upserts.filter((u) => u.table === 'categories').flatMap((u) => u.rows)
    expect(sent[0]).toMatchObject({ id: 'c1', name: 'Housing', key: 'rent', fixed: true })
  })

  it('a cloud without the columns still gets the categories and the transactions', async () => {
    h.columns = false
    await db.categories.add({ uid: 'c1', name: 'Housing', key: 'rent', fixed: true, icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 5 })
    await db.transactions.add({ uid: 't1', date: '2026-09-01', amount: 10, type: 'expense', categoryId: null, account: '', note: 'x', createdAt: 1, updatedAt: 1 })
    await syncNow()
    const cats = h.upserts.filter((u) => u.table === 'categories').flatMap((u) => u.rows)
    expect(cats[0]).toMatchObject({ id: 'c1', name: 'Housing' })
    expect('key' in cats[0]).toBe(false)
    expect(h.upserts.some((u) => u.table === 'transactions')).toBe(true)
  })
})
