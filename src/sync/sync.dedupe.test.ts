/**
 * B05: the pull's duplicate-category self-heal. Two live categories of one
 * name used to be merged onto the most recently touched one, so renaming Fun
 * to 'Dining' tombstoned the real Dining with its budget, here and in the
 * cloud. Now a category the cloud already has is never merged or tombstoned;
 * only rows that never reached the cloud fold into an existing one. Values
 * are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const tables: Record<string, Map<string, Row>> = { categories: new Map(), transactions: new Map() }
  const page = (table: string) => {
    let after: string | null = null
    type Res = { data: Row[] | null; error: unknown }
    const q: PromiseLike<Res> & { order: () => typeof q; limit: () => typeof q; gt: (c: string, v: string) => typeof q } = {
      order: () => q,
      limit: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) =>
        Promise.resolve<Res>(
          // A table the cloud does not have (accounts, before its migration).
          !tables[table]
            ? { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
            : { data: after == null ? [...tables[table].values()].map((r) => ({ ...r })) : [], error: null },
        ).then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table: string) => ({
      select: () => page(table),
      upsert: async (input: Row | Row[]) => {
        for (const r of Array.isArray(input) ? input : [input]) tables[table].set(String(r.id), { ...r })
        return { error: null }
      },
    }),
  }
  return { tables, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

import { syncNow } from './sync'
import { db } from '../db/db'

const iso = (ms: number) => new Date(ms).toISOString()
const cloudCat = (id: string, name: string, budget: number, p: Row = {}): Row => ({
  id, user_id: 'u1', name, icon: 'tag', color: '#fff', kind: 'expense', monthly_budget: budget, sort_order: 0, deleted: false,
  updated_at: iso(1000), ...p,
})
const cloudTx = (id: string, cat: string): Row => ({
  id, user_id: 'u1', date: '2026-09-10', amount: 10, type: 'expense', category_id: cat, account: 'Card', note: 'SHOP',
  manual: false, pending: false, deleted: false, created_at: iso(1000), updated_at: iso(1000),
})
const byUid = async (uid: string) => (await db.categories.toArray()).find((c) => c.uid === uid)
const countIn = async (uid: string) => {
  const c = await byUid(uid)
  return c ? db.transactions.where('categoryId').equals(c.id!).count() : -1
}

beforeEach(async () => {
  h.tables.categories.clear()
  h.tables.transactions.clear()
  await db.categories.clear()
  await db.transactions.clear()
  // Dining $350 with 4 rows, Fun $175 with 2, both already in the cloud and here.
  for (const r of [cloudCat('c-dining', 'Dining', 350), cloudCat('c-fun', 'Fun', 175)]) h.tables.categories.set(String(r.id), r)
  for (const [id, cat] of [['t1', 'c-dining'], ['t2', 'c-dining'], ['t3', 'c-dining'], ['t4', 'c-dining'], ['t5', 'c-fun'], ['t6', 'c-fun']]) {
    h.tables.transactions.set(id, cloudTx(id, cat))
  }
  await syncNow()
})

describe('B05: two live categories of one name', () => {
  it('a rename onto a name in use never tombstones the real category or moves its spending', async () => {
    const fun = (await byUid('c-fun'))!
    await db.categories.update(fun.id!, { name: 'Dining', updatedAt: Date.now() })
    await syncNow()
    await syncNow()
    expect(await byUid('c-dining')).toMatchObject({ name: 'Dining', monthlyBudget: 350, deleted: false })
    expect(await byUid('c-fun')).toMatchObject({ name: 'Dining', monthlyBudget: 175, deleted: false })
    expect(await countIn('c-dining')).toBe(4)
    expect(await countIn('c-fun')).toBe(2)
    expect(h.tables.categories.get('c-dining')).toMatchObject({ deleted: false, monthly_budget: 350 })
    // Renaming it back leaves both as they were.
    await db.categories.update(fun.id!, { name: 'Fun', updatedAt: Date.now() })
    await syncNow()
    expect(await byUid('c-dining')).toMatchObject({ name: 'Dining', deleted: false })
    expect(await byUid('c-fun')).toMatchObject({ name: 'Fun', deleted: false })
    expect(await countIn('c-dining')).toBe(4)
  })

  it('a row that never reached the cloud folds into the one the cloud has, which keeps its budget', async () => {
    // Created here (say offline) under a name the cloud already has, with a row filed in it.
    const localId = await db.categories.add({ name: 'dining ', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 50, sortOrder: 9, updatedAt: Date.now() + 5000 })
    const t = await db.transactions.add({ date: '2026-09-11', amount: 7, type: 'expense', categoryId: localId, account: '', note: 'CAFE', createdAt: 1, updatedAt: 1 })
    await syncNow()
    expect(await db.categories.get(localId)).toBeUndefined()
    const dining = (await byUid('c-dining'))!
    expect(dining).toMatchObject({ name: 'Dining', monthlyBudget: 350, deleted: false })
    const moved = (await db.transactions.get(t))!
    expect(moved.categoryId).toBe(dining.id)
    expect(moved.updatedAt).toBeGreaterThan(1)
    expect([...h.tables.categories.values()].filter((r) => !r.deleted).map((r) => r.name).sort()).toEqual(['Dining', 'Fun'])
  })

  it('two rows that never reached the cloud keep the older one', async () => {
    const a = await db.categories.add({ name: 'Coffee', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 60, sortOrder: 9, updatedAt: 1 })
    const b = await db.categories.add({ name: 'coffee', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 10, updatedAt: Date.now() })
    await db.transactions.add({ date: '2026-09-11', amount: 4, type: 'expense', categoryId: b, account: '', note: 'BEANS', createdAt: 1, updatedAt: 1 })
    await syncNow()
    expect(await db.categories.get(b)).toBeUndefined()
    expect(await db.categories.get(a)).toMatchObject({ name: 'Coffee', monthlyBudget: 60 })
    expect(await db.transactions.where('categoryId').equals(a).count()).toBe(1)
  })
})
