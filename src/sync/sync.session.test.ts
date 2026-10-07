// @vitest-environment jsdom
/**
 * Sessions and the device's copy of the ledger.
 *
 * - B54: Sign out with the server unreachable still leaves this device.
 * - B55: signing out erases the ledger here; another account signing in on a
 *   device that still holds one never pushes it as its own.
 * - B56: a launch with categories already here never waits on the network,
 *   and an unanswered cloud check seeds nothing.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Res = { data: Row[] | null; error: unknown; count?: number | null }

const h = vi.hoisted(() => {
  const state = {
    tables: { categories: new Map<string, Row>(), transactions: new Map<string, Row>() } as Record<string, Map<string, Row>>,
    session: { user: { id: 'uA', email: 'a@example.com' } } as null | { user: { id: string; email: string } },
    upserts: [] as { table: string; rows: Row[] }[],
    runs: 0,
    holdTx: null as null | Promise<void>,
    holdUpsert: null as null | Promise<void>,
    signOutError: null as null | { message: string },
    signOuts: 0,
    count: { count: 0 as number | null, error: null as unknown },
    sessionCalls: 0,
  }
  interface Q extends PromiseLike<Res> {
    order(): Q
    limit(): Q
    gt(c: string, v: string): Q
    retry(): Q
    abortSignal(): Q
  }
  const query = (table: string, head: boolean): Q => {
    let after: string | null = null
    const run = async (): Promise<Res> => {
      if (head) return { data: null, count: state.count.count, error: state.count.error }
      // A table the cloud does not have (accounts, before its migration).
      if (!state.tables[table]) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
      if (after == null) {
        if (table === 'categories') state.runs++
        if (table === 'transactions' && state.holdTx) await state.holdTx
      }
      const rows = [...state.tables[table].values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return { data: after == null ? rows : rows.filter((r) => String(r.id) > after!), error: null }
    }
    const q: Q = {
      order: () => q,
      limit: () => q,
      retry: () => q,
      abortSignal: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) => run().then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: async () => {
        state.sessionCalls++
        return { data: { session: state.session } }
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => {
        state.signOuts++
        if (state.signOutError) return { error: state.signOutError }
        state.session = null
        return { error: null }
      },
      stopAutoRefresh: async () => {},
    },
    from: (table: string) => ({
      select: (_cols?: string, o?: { head?: boolean }) => query(table, !!o?.head),
      upsert: async (input: Row | Row[]) => {
        if (state.holdUpsert) await state.holdUpsert
        const rows = Array.isArray(input) ? input : [input]
        state.upserts.push({ table, rows })
        for (const r of rows) state.tables[table].set(String(r.id), { ...r })
        return { error: null }
      },
    }),
  }
  return { state, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

import { signOutSync, syncNow } from './sync'
import { seedIfEmpty } from '../db/seed'
import { db } from '../db/db'
import { setUserRules, userRulesReady } from '../lib/userRules'

const iso = (ms: number) => new Date(ms).toISOString()
const cloudTx = (id: string, p: Row = {}): Row => ({
  id, date: '2026-09-10', amount: 10, type: 'expense', category_id: null, account: 'Test Card', note: 'CORNER STORE',
  manual: false, pending: false, deleted: false, created_at: iso(1000), updated_at: iso(1000), ...p,
})
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })
const localTx = (uid: string) => ({ uid, date: '2026-09-01', amount: 5, type: 'expense' as const, categoryId: null, account: '', note: 'X', createdAt: 1, updatedAt: 1 })

beforeEach(async () => {
  h.state.tables.categories.clear()
  h.state.tables.transactions.clear()
  h.state.session = { user: { id: 'uA', email: 'a@example.com' } }
  h.state.upserts = []
  h.state.runs = 0
  h.state.holdTx = null
  h.state.holdUpsert = null
  h.state.signOutError = null
  h.state.signOuts = 0
  h.state.count = { count: 0, error: null }
  h.state.sessionCalls = 0
  setOnline(true)
  localStorage.clear()
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
})
afterEach(() => settle())

describe('B55: whose ledger this is', () => {
  it('another account signing in never pushes the last one\'s rows', async () => {
    localStorage.setItem('tally:lastUserId', 'uA')
    await db.transactions.add(localTx('t-A'))
    h.state.session = { user: { id: 'uB', email: 'b@example.com' } }
    h.state.tables.transactions.set('t-B', cloudTx('t-B'))
    await syncNow()
    expect((await db.transactions.toArray()).map((t) => t.uid)).toEqual(['t-B'])
    expect(h.state.upserts.flatMap((u) => u.rows).some((r) => r.id === 't-A')).toBe(false)
  })

  it('the same account signing in again keeps its unsynced edits', async () => {
    localStorage.setItem('tally:lastUserId', 'uA')
    await db.transactions.add(localTx('t-A'))
    await syncNow()
    expect(await db.transactions.where('uid').equals('t-A').count()).toBe(1)
  })

  it('a first sign-in on this device uploads the local ledger', async () => {
    await db.transactions.add(localTx('t-local'))
    await syncNow()
    expect(h.state.tables.transactions.has('t-local')).toBe(true)
  })

  it('signing out after a good push erases the ledger here, leaving only the defaults', async () => {
    await db.transactions.add(localTx('t-A'))
    await db.categories.add({ name: 'Bakeries', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 90, sortOrder: 0, updatedAt: 5 })
    const r = await signOutSync()
    expect(r).toEqual({ ok: true, local: false })
    expect(h.state.tables.transactions.has('t-A')).toBe(true)
    expect(await db.transactions.count()).toBe(0)
    const cats = await db.categories.toArray()
    expect(cats.some((c) => c.name === 'Bakeries')).toBe(false)
    expect(cats.every((c) => c.seeded)).toBe(true)
  })

  it('an account typed in by hand is named before it is erased', async () => {
    await db.accounts.add({ name: 'Jar', institution: 'Home', type: 'cash', balance: 200, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1 })
    const first = await signOutSync()
    expect(first.ok).toBe(false)
    expect(!first.ok && first.confirm).toMatch(/added by hand/)
    expect(h.state.signOuts).toBe(0)
    expect(await signOutSync({ confirmed: true })).toEqual({ ok: true, local: false })
    expect(await db.accounts.count()).toBe(0)
  })

  it('offline, it says the edits have not reached the cloud before erasing them', async () => {
    await db.transactions.add(localTx('t-A'))
    setOnline(false)
    const first = await signOutSync()
    expect(!first.ok && first.confirm).toMatch(/not reached the cloud/)
    expect(await db.transactions.count()).toBe(1)
  })
})

describe('B54: Sign out with the server unreachable', () => {
  it('drops the session on this device and clears the rules', async () => {
    localStorage.setItem('sb-test-auth-token', '{"access_token":"x"}')
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 }])
    h.state.signOutError = { message: 'Failed to fetch' }
    const r = await signOutSync({ confirmed: true })
    expect(r).toEqual({ ok: true, local: true })
    expect(localStorage.getItem('sb-test-auth-token')).toBeNull()
    expect(userRulesReady()).toBe(false)
    expect(localStorage.getItem('tally:merchantRules:v1')).toBeNull()
  })
})

describe('B56: seeding at launch', () => {
  it('a device with categories never asks the network', async () => {
    await db.categories.add({ name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 5 })
    await seedIfEmpty()
    expect(h.state.sessionCalls).toBe(0)
  })

  it('signed in with no answer from the cloud, nothing is seeded', async () => {
    h.state.count = { count: null, error: { message: 'TypeError: Load failed' } }
    await seedIfEmpty()
    expect(await db.categories.count()).toBe(0)
  })

  it('signed in to an empty account, the defaults are seeded', async () => {
    await seedIfEmpty()
    expect(await db.categories.count()).toBe(12)
  })
})
