// @vitest-environment jsdom
/**
 * The savings plan and the session. The plan is cleared exactly when the
 * ledger it measures is erased, and never otherwise: a session that ends from
 * elsewhere leaves the ledger on this device, so it leaves the lock too. The
 * amounts are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Res = { data: Row[] | null; error: unknown; count?: number | null }
type Session = { user: { id: string; email: string } }

const h = vi.hoisted(() => {
  const state = {
    tables: { categories: new Map<string, Row>(), transactions: new Map<string, Row>() } as Record<string, Map<string, Row>>,
    /** Each account's plan row. */
    plans: {} as Record<string, Row>,
    planReads: [] as string[],
    /** The next read of a plan waits for this before it answers with what it saw when asked. */
    holdPlan: null as Promise<void> | null,
    session: null as Session | null,
    signOutError: null as null | { message: string },
    onAuth: null as null | ((event: string, session: Session | null) => void),
  }
  interface Q extends PromiseLike<Res> {
    order(): Q
    limit(): Q
    gt(c: string, v: string): Q
    eq(c: string, v: string): Q
    retry(): Q
    abortSignal(): Q
  }
  const query = (table: string, head: boolean): Q => {
    let after: string | null = null
    let who: string | null = null
    const run = async (): Promise<Res> => {
      if (table === 'savings_plan') {
        state.planReads.push(String(who))
        const seen = state.plans[String(who)]
        const hold = state.holdPlan
        state.holdPlan = null
        if (hold) await hold
        return { data: seen ? [seen] : [], error: null }
      }
      if (head) return { data: null, count: 0, error: null }
      // A table the cloud does not have (accounts, before its migration).
      if (!state.tables[table]) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } }
      const rows = [...state.tables[table].values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return { data: after == null ? rows : rows.filter((r) => String(r.id) > after!), error: null }
    }
    const q: Q = {
      order: () => q,
      limit: () => q,
      retry: () => q,
      abortSignal: () => q,
      gt: (_c, v) => ((after = v), q),
      eq: (_c, v) => ((who = v), q),
      then: (ok, bad) => run().then(ok, bad),
    }
    return q
  }
  const supabase = {
    auth: {
      storageKey: 'sb-test-auth-token',
      getSession: async () => ({ data: { session: state.session } }),
      onAuthStateChange: (cb: (event: string, session: Session | null) => void) => {
        state.onAuth = cb
        return { data: { subscription: { unsubscribe() {} } } }
      },
      signOut: async () => {
        if (state.signOutError) return { error: state.signOutError }
        state.session = null
        return { error: null }
      },
      stopAutoRefresh: async () => {},
    },
    from: (table: string) => ({
      select: (_cols?: string, o?: { head?: boolean }) => query(table, !!o?.head),
      upsert: async (input: Row | Row[]) => {
        for (const r of Array.isArray(input) ? input : [input]) state.tables[table]?.set(String(r.id), { ...r })
        return { error: null }
      },
    }),
  }
  return { state, supabase }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('./merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

import { initSync, signOutSync, syncNow } from './sync'
import { db } from '../db/db'
import { getPlan, setPlan } from '../lib/planCache'
import { loadSavingsPlan } from '../lib/planStore'
import { budgetFit, capInForce, checkBudgets, type SavingsPlan } from '../lib/savingsPlan'

const TODAY = '2031-04-10'
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 1000, ...extra })
const cloudRow = (p: SavingsPlan): Row => ({ goal: p.goal, cap: p.cap, locked: p.locked, since: p.since, pending: p.pending, updated_at: new Date(p.updatedAt).toISOString() })
const A: Session = { user: { id: 'uA', email: 'a@example.com' } }
const B: Session = { user: { id: 'uB', email: 'b@example.com' } }
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })

beforeEach(async () => {
  h.state.tables.categories.clear()
  h.state.tables.transactions.clear()
  h.state.plans = {}
  h.state.planReads = []
  h.state.holdPlan = null
  h.state.session = A
  h.state.signOutError = null
  setOnline(true)
  localStorage.clear()
  setPlan(null)
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
})
afterEach(() => settle())

describe('a session that ends with no tap here', () => {
  it('leaves the cached plan in force: the ledger is still on this device', async () => {
    initSync()
    await settle()
    setPlan(plan())
    await db.categories.add({ name: 'Bakeries', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 3000, sortOrder: 0, updatedAt: 5 })
    // Another device signed out, or the server ended the session.
    h.state.session = null
    h.state.onAuth!('SIGNED_OUT', null)
    await settle()
    expect(getPlan()).toEqual(plan())
    expect(capInForce(getPlan(), TODAY)).toBe(3000)
    // The ledger stayed, and a budget raise is still refused.
    const kept = await db.categories.where('name').equals('Bakeries').toArray()
    expect(kept).toHaveLength(1)
    expect(checkBudgets(kept, [{ id: kept[0].id!, monthlyBudget: 3100 }], capInForce(getPlan(), TODAY)).ok).toBe(false)
  })

  it('a load in flight at that moment writes nothing', async () => {
    initSync()
    await settle()
    setPlan(plan())
    h.state.plans.uA = cloudRow(plan({ cap: 9000, updatedAt: 2000 }))
    let release!: () => void
    h.state.holdPlan = new Promise<void>((r) => (release = r))
    const loading = loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.planReads).toEqual(['uA']))
    h.state.session = null
    h.state.onAuth!('SIGNED_OUT', null)
    release()
    await expect(loading).resolves.toBe(false)
    expect(getPlan()).toEqual(plan())
  })
})

describe('signing out on this device', () => {
  it('clears the plan with the ledger', async () => {
    setPlan(plan())
    expect(await signOutSync({ confirmed: true })).toEqual({ ok: true, local: false })
    expect(getPlan()).toBeNull()
    expect(localStorage.getItem('tally:savingsPlan:v1')).toBeNull()
    expect(capInForce(getPlan(), TODAY)).toBeNull()
  })

  it('clears it with the server unreachable too', async () => {
    setPlan(plan())
    h.state.signOutError = { message: 'Failed to fetch' }
    expect(await signOutSync({ confirmed: true })).toEqual({ ok: true, local: true })
    expect(getPlan()).toBeNull()
    expect(localStorage.getItem('tally:savingsPlan:v1')).toBeNull()
  })
})

describe('another account signing in on this device', () => {
  beforeEach(() => {
    // The last account's ledger and plan are still here.
    localStorage.setItem('tally:lastUserId', 'uA')
    setPlan(plan())
    h.state.session = B
  })

  it('never sees the last one\'s plan: with none of its own it has none', async () => {
    await syncNow()
    await settle()
    expect(getPlan()).toBeNull()
  })

  it('gets its own plan, even when its load landed before the wipe', async () => {
    const theirs = plan({ cap: 2200, goal: 500, updatedAt: 3000 })
    h.state.plans.uB = cloudRow(theirs)
    // App's sign-in edge loads the new account's plan a moment before the sync wipes the old ledger.
    await expect(loadSavingsPlan()).resolves.toBe(true)
    expect(getPlan()).toEqual(theirs)
    await syncNow()
    await settle()
    expect(getPlan()).toEqual(theirs)
    expect(h.state.planReads).toEqual(['uB', 'uB'])
  })

  it('a plan read for the last account that answers after the wipe is thrown away', async () => {
    h.state.plans.uA = cloudRow(plan({ cap: 9000, updatedAt: 2000 }))
    h.state.session = A
    let release!: () => void
    h.state.holdPlan = new Promise<void>((r) => (release = r))
    const loading = loadSavingsPlan()
    await vi.waitFor(() => expect(h.state.planReads).toEqual(['uA']))
    h.state.session = B
    await syncNow()
    release()
    await expect(loading).resolves.toBe(false)
    await settle()
    expect(getPlan()).toBeNull()
  })
})

describe('a budget pulled from the cloud', () => {
  it('lands though it takes the total past the locked budget, and the fit then says by how much', async () => {
    setPlan(plan())
    localStorage.setItem('tally:lastUserId', 'uA')
    const iso = (ms: number) => new Date(ms).toISOString()
    // An edit from an old copy of the app, or a device that was offline with the old budget.
    h.state.tables.categories.set('c-1', { id: 'c-1', name: 'Rent', icon: 'home', color: '#fff', kind: 'expense', monthly_budget: 2000, sort_order: 0, deleted: false, updated_at: iso(5000) })
    h.state.tables.categories.set('c-2', { id: 'c-2', name: 'Dining', icon: 'x', color: '#fff', kind: 'expense', monthly_budget: 1350, sort_order: 1, deleted: false, updated_at: iso(5000) })
    await syncNow()
    const cats = await db.categories.toArray()
    expect(cats.map((c) => c.monthlyBudget).sort()).toEqual([1350, 2000])
    expect(budgetFit(cats, capInForce(getPlan(), TODAY))).toEqual({ cap: 3000, assigned: 3350, unassigned: 0, over: 350 })
    expect(getPlan()).toEqual(plan())
  })
})
