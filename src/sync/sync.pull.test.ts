/**
 * The device-sync pull against a cloud that behaves like PostgREST: every
 * response is cut at a row cap with no error, an upsert overwrites by id, and a
 * select can fail on its own.
 *
 * - B20: a cloud past the cap must still come down whole.
 * - B21: syncNow says whether this run pulled.
 * - B24: a live and a tombstoned cloud category of one name adopt at most one
 *   seeded row, and the live one wins.
 * - B25: a default renamed in the cloud does not come back from a fresh seed.
 * - B52: a row filed under a category another device deleted moves to Other.
 * - B91: one pull is one IndexedDB write transaction.
 * - B02: a pending charge this device retired stays waiting for its return
 *   until another device brings it back.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Res = { data: Row[] | null; error: unknown; count?: number | null }

const h = vi.hoisted(() => {
  const state = {
    tables: { categories: new Map<string, Row>(), transactions: new Map<string, Row>() } as Record<string, Map<string, Row>>,
    maxRows: 1000,
    fail: null as null | ((table: string) => boolean),
    session: { user: { id: 'u1', email: 'owner@example.com' } } as null | { user: { id: string; email: string } },
    upserts: [] as { table: string; rows: Row[] }[],
    selects: [] as string[],
    beforeSelect: null as null | ((table: string) => Promise<void>),
  }
  interface Q extends PromiseLike<Res> {
    order(c: string): Q
    gt(c: string, v: string): Q
    limit(n: number): Q
    range(a: number, b: number): Q
  }
  const query = (table: string): Q => {
    let sorted = false
    let after: string | null = null
    let lim = Infinity
    let from = 0
    let to = Infinity
    const run = async (): Promise<Res> => {
      state.selects.push(table)
      if (state.beforeSelect) await state.beforeSelect(table)
      if (state.fail?.(table)) return { data: null, error: { message: 'TypeError: Load failed' } }
      // A table the cloud does not have (accounts, before its migration).
      if (!state.tables[table]) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
      // Heap order unless ordered: an upserted row moves to the end.
      let rows = [...state.tables[table].values()]
      if (sorted) rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      if (after != null) rows = rows.filter((r) => String(r.id) > after!)
      rows = rows.slice(from, Math.min(to + 1, rows.length)).slice(0, lim).slice(0, state.maxRows)
      return { data: rows.map((r) => ({ ...r })), error: null }
    }
    const q: Q = {
      order: () => ((sorted = true), q),
      gt: (_c, v) => ((after = v), q),
      limit: (n) => ((lim = n), q),
      range: (a, b) => ((from = a), (to = b), q),
      then: (ok, bad) => run().then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: (table: string) => ({
      select: () => query(table),
      upsert: async (input: Row | Row[]) => {
        const rows = Array.isArray(input) ? input : [input]
        state.upserts.push({ table, rows })
        for (const r of rows) {
          state.tables[table].delete(String(r.id))
          state.tables[table].set(String(r.id), { ...r })
        }
        return { error: null }
      },
    }),
  }
  return { state, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => false) }))

import { syncNow } from './sync'
import { seedIfEmpty } from '../db/seed'
import { db } from '../db/db'

let rwTransactions = 0
db.use({
  stack: 'dbcore',
  name: 'count-rw',
  create: (down) => ({
    ...down,
    transaction: (stores, mode, opts) => {
      if (mode === 'readwrite') rwTransactions++
      return down.transaction(stores, mode, opts)
    },
  }),
})

const iso = (ms: number) => new Date(ms).toISOString()
const cloudTx = (id: string, p: Row = {}): Row => ({
  id, user_id: 'u1', date: '2026-09-10', amount: 10, type: 'expense', category_id: null, account: 'Test Card', note: 'CORNER STORE',
  manual: false, pending: false, deleted: false, created_at: iso(1000), updated_at: iso(1000), ...p,
})
const cloudCat = (id: string, name: string, p: Row = {}): Row => ({
  id, user_id: 'u1', name, icon: 'box', color: '#fff', kind: 'expense', monthly_budget: 100, sort_order: 0, deleted: false,
  updated_at: iso(1000), ...p,
})
const put = (table: string, rows: Row[]) => rows.forEach((r) => h.state.tables[table].set(String(r.id), r))
const cloud = (table: string, id: string) => h.state.tables[table].get(id)
const liveCloudCats = () => [...h.state.tables.categories.values()].filter((r) => !r.deleted)

const DEFAULT_NAMES = ['Groceries', 'Dining', 'Rent', 'Transport', 'Subscriptions', 'Health', 'Shopping', 'Fun', 'Other', 'Salary', 'Freelance', 'Other income']
const kindOf = (n: string) => (['Salary', 'Freelance', 'Other income'].includes(n) ? 'income' : 'expense')

const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(async () => {
  h.state.tables.categories.clear()
  h.state.tables.transactions.clear()
  h.state.maxRows = 1000
  h.state.fail = null
  h.state.session = { user: { id: 'u1', email: 'owner@example.com' } }
  h.state.upserts = []
  h.state.selects = []
  h.state.beforeSelect = null
  await db.categories.clear()
  await db.transactions.clear()
  rwTransactions = 0
})
afterEach(settle)

describe('B20: the pull reads past the row cap', () => {
  for (const cap of [1000, 500]) {
    it(`a fresh device gets all 1,042 rows when each answer stops at ${cap}`, async () => {
      const rows = Array.from({ length: 1040 }, (_, i) => cloudTx(`sf:r${String(i).padStart(4, '0')}`))
      put('transactions', rows)
      // The edited rows sit at the end of the heap, past the cap.
      put('transactions', [
        cloudTx('sf:a-corner', { manual: true, note: 'CORNER CAFE', updated_at: iso(5000) }),
        cloudTx('sf:a-big', { manual: true, deleted: true, amount: 640, updated_at: iso(5000) }),
      ])
      h.state.maxRows = cap
      await syncNow()
      expect(await db.transactions.count()).toBe(1042)
      expect(await db.transactions.where('uid').equals('sf:a-corner').first()).toMatchObject({ manual: true })
      expect(cloud('transactions', 'sf:a-big')).toMatchObject({ manual: true, deleted: true })
    })
  }
})

describe('B21: syncNow reports whether this run pulled', () => {
  it('ok when the pull landed, failed when a read failed, skipped when signed out', async () => {
    expect(await syncNow()).toBe('ok')
    h.state.fail = (t) => t === 'transactions'
    expect(await syncNow()).toBe('failed')
    h.state.fail = null
    h.state.session = null
    expect(await syncNow()).toBe('skipped')
  })
})

describe('B24: a live and a tombstoned cloud category of one name', () => {
  for (const order of ['live first', 'dead first']) {
    it(`the live cloud row keeps its spending (${order})`, async () => {
      await db.categories.add({ name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 600, sortOrder: 0, seeded: true, updatedAt: 9000 })
      const live = cloudCat('LIVE', 'Groceries', { monthly_budget: 450 })
      const dead = cloudCat('DEAD', 'Groceries', { deleted: true })
      put('categories', order === 'live first' ? [live, dead] : [dead, live])
      put('transactions', [cloudTx('t1', { category_id: 'LIVE' })])
      await syncNow()
      const cats = (await db.categories.toArray()).filter((c) => c.name === 'Groceries' && !c.deleted)
      expect(cats).toHaveLength(1)
      expect(cats[0]).toMatchObject({ uid: 'LIVE', monthlyBudget: 450 })
      const t1 = await db.transactions.where('uid').equals('t1').first()
      expect(t1?.categoryId).toBe(cats[0].id)
      expect(cloud('transactions', 't1')).toMatchObject({ category_id: 'LIVE' })
    })
  }

  it('a default deleted in the cloud stays deleted on a fresh device', async () => {
    await db.categories.add({ name: 'Fun', icon: 'sparkles', color: '#fff', kind: 'expense', monthlyBudget: 150, sortOrder: 0, seeded: true, updatedAt: 9000 })
    put('categories', [cloudCat('c-dining', 'Dining'), cloudCat('c-fun', 'Fun', { deleted: true })])
    await syncNow()
    expect((await db.categories.toArray()).filter((c) => c.name === 'Fun' && !c.deleted)).toHaveLength(0)
    expect(liveCloudCats().map((r) => r.name)).toEqual(['Dining'])
  })
})

describe('B25: a fresh device signing in to an account with a renamed default', () => {
  const seedSignedOut = async () => {
    const session = h.state.session
    h.state.session = null
    await seedIfEmpty()
    h.state.session = session
  }
  const accountCats = () =>
    DEFAULT_NAMES.map((n, i) =>
      cloudCat(`c${i}`, n === 'Fun' ? 'Entertainment' : n, { kind: kindOf(n), monthly_budget: n === 'Fun' ? 150 : 0 }),
    )

  it('does not bring the old name back, here or in the cloud', async () => {
    await seedSignedOut()
    expect(await db.categories.count()).toBe(12)
    put('categories', accountCats())
    await syncNow()
    expect(liveCloudCats()).toHaveLength(12)
    expect(liveCloudCats().some((r) => r.name === 'Fun')).toBe(false)
    const local = (await db.categories.toArray()).filter((c) => !c.deleted)
    expect(local).toHaveLength(12)
    expect(local.some((c) => c.name === 'Fun')).toBe(false)
  })

  it('a new account (empty cloud) keeps and uploads the defaults', async () => {
    await seedSignedOut()
    await syncNow()
    expect(liveCloudCats()).toHaveLength(12)
  })

  it('a default used while signed out is kept', async () => {
    await seedSignedOut()
    const fun = (await db.categories.toArray()).find((c) => c.name === 'Fun')!
    await db.transactions.add({ date: '2026-09-01', amount: 20, type: 'expense', categoryId: fun.id!, account: '', note: 'MOVIE', createdAt: 1, updatedAt: 1 })
    put('categories', accountCats())
    await syncNow()
    expect((await db.categories.toArray()).filter((c) => c.name === 'Fun' && !c.deleted)).toHaveLength(1)
  })

  it('a device that could not check the cloud at boot seeds after the pull finds it empty', async () => {
    expect(await db.categories.count()).toBe(0)
    await syncNow()
    expect(await db.categories.count()).toBe(12)
    expect(liveCloudCats()).toHaveLength(12)
  })
})

describe('B52: a category deleted on another device', () => {
  it('moves this device\'s rows in it to Other, here and in the cloud', async () => {
    const funId = await db.categories.add({ uid: 'c-fun', name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 150, sortOrder: 0, updatedAt: 1000 })
    await db.categories.add({ uid: 'c-oth', name: 'Other', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 1000 })
    await db.transactions.add({ uid: 't-show', date: '2026-09-12', amount: 64, type: 'expense', categoryId: funId, account: '', note: 'TICKETS', manual: true, createdAt: 1, updatedAt: 8000 })
    put('categories', [cloudCat('c-fun', 'Fun', { deleted: true, updated_at: iso(5000) }), cloudCat('c-oth', 'Other')])
    await syncNow()
    const t = await db.transactions.where('uid').equals('t-show').first()
    const other = (await db.categories.toArray()).find((c) => c.uid === 'c-oth')!
    expect(t?.categoryId).toBe(other.id)
    expect(cloud('transactions', 't-show')).toMatchObject({ category_id: 'c-oth' })
  })
})

describe('B91: one pull, one write', () => {
  it('299 new rows land in a single IndexedDB write transaction', async () => {
    put('transactions', Array.from({ length: 299 }, (_, i) => cloudTx(`sf:n${i}`)))
    rwTransactions = 0
    await syncNow()
    expect(await db.transactions.count()).toBe(299)
    expect(rwTransactions).toBeLessThanOrEqual(2)
  })
})

describe('B02: a pinned pending charge this device retired (banks.ts)', () => {
  const retired = { uid: 'sf:hold', date: '2026-09-10', amount: 50, type: 'expense' as const, categoryId: null, account: 'Test Card',
    note: 'FLORIST', manual: true, pending: false, deleted: true, retiredPin: true, createdAt: 1000, updatedAt: 2000 }

  it('stays marked when another device also retired it', async () => {
    await db.transactions.add({ ...retired })
    put('transactions', [cloudTx('sf:hold', { manual: true, deleted: true, amount: 50, note: 'FLORIST', updated_at: iso(3000) })])
    await syncNow()
    expect(await db.transactions.where('uid').equals('sf:hold').first()).toMatchObject({ deleted: true, retiredPin: true })
  })

  it('is settled once another device brings it back', async () => {
    await db.transactions.add({ ...retired })
    put('transactions', [cloudTx('sf:hold', { manual: true, deleted: false, amount: 52, note: 'FLORIST', updated_at: iso(3000) })])
    await syncNow()
    expect(await db.transactions.where('uid').equals('sf:hold').first()).toMatchObject({ deleted: false, retiredPin: false })
  })

  it('the mark goes to the cloud as its own column, so every device can bring the charge back', async () => {
    await db.transactions.add({ ...retired })
    await syncNow()
    expect(cloud('transactions', 'sf:hold')).toBeDefined()
    expect(Object.keys(cloud('transactions', 'sf:hold')!)).not.toContain('retiredPin')
    expect(cloud('transactions', 'sf:hold')).toMatchObject({ retired_pin: true })
  })
})
