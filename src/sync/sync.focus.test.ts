// @vitest-environment jsdom
/**
 * B53: a window focus is one sync, and a call during the pull rides along.
 * (Its own file: initSync registers listeners and hooks for the whole module.)
 *
 * Runs are counted, never timed. Every run asks for the session the moment it
 * begins (inside syncNow, or inside the finished run's finally for a queued
 * one) and ends on 'synced' here, so "every run begun has ended" is a fact the
 * test can wait for. Each test loads a fresh sync module: one test's initSync
 * (its Dexie hooks and their 600 ms debounce) never reaches the next.
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
    /** Upserts waiting on holdUpsert: the push is under way. */
    held: 0,
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
        if (state.holdUpsert) {
          state.held++
          await state.holdUpsert
        }
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

let sync: typeof import('./sync')
let db: typeof import('../db/db').db

/** Runs that have ended ('synced' or 'error', entered from another status). */
let ended = 0
/** Session reads that began no run (initSync asks once for itself). */
let notRuns = 0
const began = () => h.state.sessionCalls - notRuns
/** Every run begun so far has ended (and its finally has run: the check that
 *  passes after polling runs on a timer, after the run's last microtask). */
const idle = () => vi.waitFor(() => expect(ended).toBe(began()))

const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })

beforeEach(async () => {
  vi.resetModules()
  sync = await import('./sync')
  ;({ db } = await import('../db/db'))
  ended = 0
  notRuns = 0
  let last = ''
  sync.subscribeSync((s) => {
    if ((s.status === 'synced' || s.status === 'error') && s.status !== last) ended++
    last = s.status
  })
  h.state.tables.categories.clear()
  h.state.tables.transactions.clear()
  h.state.session = { user: { id: 'uA', email: 'a@example.com' } }
  h.state.upserts = []
  h.state.runs = 0
  h.state.held = 0
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
// Nothing a test began may run on into the next one's state.
afterEach(() => idle())

describe('B53: one sync per focus', () => {
  it('a focus and the app\'s own focus refresh make one run', async () => {
    const before = h.state.sessionCalls
    sync.initSync()
    notRuns = h.state.sessionCalls - before
    // The sync initSync starts for the session it finds.
    await vi.waitFor(() => expect(ended).toBe(1))
    expect(began()).toBe(1)
    h.state.runs = 0
    window.dispatchEvent(new Event('focus'))
    await sync.syncNow() // what App's focus handler does (through syncAllConnectors)
    // Any run the focus began, or one queued behind it, has begun by now.
    expect(began()).toBe(2)
    await idle()
    expect(h.state.runs).toBe(1)
  })

  it('a call during the pull rides along; one during the push queues one more', async () => {
    let release!: () => void
    h.state.holdTx = new Promise<void>((r) => (release = r))
    const first = sync.syncNow()
    // The pull is under way: categories read, transactions held.
    await vi.waitFor(() => expect(h.state.runs).toBe(1))
    void sync.syncNow()
    h.state.holdTx = null
    release()
    await first
    expect(began()).toBe(1)
    await idle()
    expect(h.state.runs).toBe(1)

    await db.categories.add({ uid: 'c1', name: 'Fun', icon: 'x', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 5 })
    let releasePush!: () => void
    h.state.holdUpsert = new Promise<void>((r) => (releasePush = r))
    const second = sync.syncNow()
    // The push is under way (an upsert is held), not merely the pull: a fixed
    // wait here let the call below land mid-pull under load, where it rides along.
    await vi.waitFor(() => expect(h.state.held).toBe(1))
    expect(h.state.runs).toBe(2)
    void sync.syncNow()
    h.state.holdUpsert = null
    releasePush()
    await second
    // The queued run began in the finished run's finally.
    expect(began()).toBe(3)
    await idle()
    expect(h.state.runs).toBe(3)
  })
})

