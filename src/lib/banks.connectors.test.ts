// @vitest-environment jsdom
/**
 * The connector loop around the rate-limited SimpleFIN calls.
 *
 * - B21: no bank reconcile after a failed device pull (a fresh device would push
 *   raw bank rows over the cloud's pins and hides).
 * - B26: the 6-hour floor counts only a fetch that reached SimpleFIN, and
 *   reconnecting a bank fetches its transactions too.
 * - B27: an answer that reports a connection error never archives accounts.
 * - B28: a removed bank account can be restored, and counts say what is shown.
 * - B55: balances in flight when the user signs out are not written afterwards.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Reply = { data: unknown; error: unknown }

const h = vi.hoisted(() => {
  const state = {
    session: { user: { id: 'u1', email: 'owner@example.com' } } as null | { user: { id: string; email: string } },
    cloudTx: [] as Row[],
    failTxSelect: false,
    calls: [] as string[],
    replies: {} as Record<string, () => Reply | Promise<Reply>>,
  }
  const httpError = (status: number, error: string) => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => ({ ok: false, error }) } },
  })
  const netError = () => ({ data: null, error: { message: 'Failed to send a request to the Edge Function', context: {} } })
  const page = (rows: () => Row[] | null) => {
    let after: string | null = null
    const q: PromiseLike<{ data: Row[] | null; error: unknown }> & { order: () => typeof q; limit: () => typeof q; gt: (c: string, v: string) => typeof q } = {
      order: () => q,
      limit: () => q,
      gt: (_c, v) => ((after = v), q),
      then: (ok, bad) => {
        const r = after == null ? rows() : []
        return Promise.resolve(r == null ? { data: null, error: { message: 'TypeError: Load failed' } } : { data: r, error: null }).then(ok, bad)
      },
    }
    return q
  }
  const supabase = {
    auth: { getSession: async () => ({ data: { session: state.session } }), signOut: async () => ({ error: null }) },
    from: (table: string) => ({
      select: () =>
        page(() => {
          if (table !== 'transactions') return []
          if (state.failTxSelect) return null
          return state.cloudTx
        }),
      upsert: async (input: Row | Row[]) => {
        if (table === 'transactions') {
          for (const r of Array.isArray(input) ? input : [input]) {
            state.cloudTx = [...state.cloudTx.filter((x) => x.id !== r.id), { ...r }]
          }
        }
        return { error: null }
      },
    }),
    functions: {
      invoke: async (fn: string, opts: { body: { action: string } }) => {
        const key = `${fn}:${opts.body.action}`
        state.calls.push(key)
        const r = state.replies[key]
        if (r) return r()
        if (key === 'simplefin:transactions') return { data: { ok: true, transactions: [] }, error: null }
        return { data: { ok: true, accounts: [] }, error: null }
      },
    },
  }
  return { state, supabase, httpError, netError }
})

vi.mock('../db/supabase', () => ({ supabase: h.supabase }))
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true) }))

import { connectBank, minutesUntilBankRefresh, subscribeBankWarnings, syncAllConnectors } from './banks'
import { applySyncedAccounts, restoreAccount } from './brokerage'
import { setUserRules } from './userRules'
import { db, type AccountType } from '../db/db'
import { signOutSync } from '../sync/sync'

const CARD = 'Test Card Co Rewards Card'
const NOW = Math.floor(Date.now() / 1000)
const ok = (data: unknown) => () => ({ data: { ok: true, ...(data as object) }, error: null })
const bankTx = (id: string, amount: number, payee: string) => ({
  sourceTxId: `bank.test:card:${id}`, account: CARD, tier: 'credit', posted: NOW - 86400, amount, payee, description: payee, memo: '', mcc: null,
})
const acct = (id: string, name: string, tier: AccountType, balance: number) => ({
  sourceAccountId: `bank.test:${id}`, institution: 'Test Bank', name, tier, balance, currency: 'USD',
})
const iso = (ms: number) => new Date(ms).toISOString()
const cloudRow = (id: string, p: Row) => ({
  id, date: '2026-09-10', amount: 40, type: 'expense', category_id: null, account: CARD, note: 'NORTH CAFE', manual: false,
  pending: false, deleted: false, created_at: iso(1000), updated_at: iso(5000), ...p,
})
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })
const simplefinCalls = () => h.state.calls.filter((c) => c.startsWith('simplefin:'))
const netWorth = async () =>
  (await db.accounts.toArray()).filter((a) => !a.deleted && !a.archived).reduce((s, a) => s + (a.type === 'credit' ? -a.balance : a.balance), 0)

beforeEach(async () => {
  h.state.session = { user: { id: 'u1', email: 'owner@example.com' } }
  h.state.cloudTx = []
  h.state.failTxSelect = false
  h.state.calls = []
  h.state.replies = {}
  setOnline(true)
  localStorage.clear()
  setUserRules([])
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
})
afterEach(() => new Promise((r) => setTimeout(r, 30)))

describe('B21: a failed device pull', () => {
  it('skips the bank pair, says so, and leaves the floor for the next run', async () => {
    h.state.cloudTx = [
      cloudRow('sf:bank.test:card:n1', { manual: true }),
      cloudRow('sf:bank.test:card:s1', { manual: true, deleted: true, amount: 640, note: 'SOUTH GRILL' }),
    ]
    h.state.replies['simplefin:transactions'] = ok({ transactions: [bankTx('n1', -40, 'NORTH CAFE'), bankTx('s1', -640, 'SOUTH GRILL')] })
    h.state.failTxSelect = true
    const res = await syncAllConnectors()
    expect(simplefinCalls()).toEqual([])
    expect(res.errors.join(' ')).toMatch(/Could not reach your Tally data/)
    expect(minutesUntilBankRefresh()).toBe(0)
    expect(await db.transactions.count()).toBe(0)

    // Next run, the pull lands first and the pins hold.
    h.state.failTxSelect = false
    await syncAllConnectors()
    expect(simplefinCalls()).toContain('simplefin:transactions')
    const cloud = Object.fromEntries(h.state.cloudTx.map((r) => [r.id, r]))
    expect(cloud['sf:bank.test:card:n1']).toMatchObject({ manual: true })
    expect(cloud['sf:bank.test:card:s1']).toMatchObject({ manual: true, deleted: true })
  })
})

describe('B26: the 6-hour floor', () => {
  it('offline: no bank call, no floor', async () => {
    setOnline(false)
    await syncAllConnectors()
    expect(simplefinCalls()).toEqual([])
    expect(minutesUntilBankRefresh()).toBe(0)
  })

  it('signed out: no bank call, no floor, and it says to sign in', async () => {
    h.state.session = null
    const res = await syncAllConnectors()
    expect(simplefinCalls()).toEqual([])
    expect(minutesUntilBankRefresh()).toBe(0)
    expect(res.errors).toContain('Sign in to Tally in Settings first.')
    h.state.session = { user: { id: 'u1', email: 'owner@example.com' } }
    await syncAllConnectors()
    expect(simplefinCalls()).toEqual(expect.arrayContaining(['simplefin:sync', 'simplefin:transactions']))
  })

  it('a request that never reached SimpleFIN does not count', async () => {
    h.state.replies['simplefin:sync'] = h.netError
    h.state.replies['simplefin:transactions'] = h.netError
    await syncAllConnectors()
    expect(minutesUntilBankRefresh()).toBe(0)
    expect(localStorage.getItem('tally:lastBankFetchAt')).toBeNull()
  })

  it('SimpleFIN refusing (403) counts against the floor, but is not "updated"', async () => {
    h.state.replies['simplefin:sync'] = () => h.httpError(502, 'simplefin /accounts -> 403')
    h.state.replies['simplefin:transactions'] = () => h.httpError(502, 'simplefin /accounts -> 403')
    await syncAllConnectors()
    expect(minutesUntilBankRefresh()).toBeGreaterThan(300)
    expect(localStorage.getItem('tally:lastBankFetchAt')).toBeNull()
  })

  it('reconnecting a bank fetches its transactions, even inside the floor', async () => {
    h.state.replies['simplefin:sync'] = () => h.httpError(502, 'simplefin /accounts -> 403')
    await syncAllConnectors()
    expect(minutesUntilBankRefresh()).toBeGreaterThan(300)
    h.state.calls = []
    h.state.replies['simplefin:sync'] = ok({ accounts: [acct('card', 'Rewards Card', 'credit', -500)] })
    h.state.replies['simplefin:transactions'] = ok({ transactions: [bankTx('qa1', -23.4, 'QA BISTRO')] })
    const res = await connectBank('dGVzdA==')
    expect(simplefinCalls()).toEqual(['simplefin:claim', 'simplefin:sync', 'simplefin:transactions'])
    expect(res.shown).toBe(1)
    expect(await db.transactions.where('uid').equals('sf:bank.test:card:qa1').count()).toBe(1)
    expect(Number(localStorage.getItem('tally:lastBankFetchAt'))).toBeGreaterThan(0)
  })
})

describe('B27: an answer that reports a connection error', () => {
  const both = [acct('chk', 'Checking', 'cash', 1000), acct('card', 'Rewards Card', 'credit', -250)]

  it('archives nothing, and the error is shown', async () => {
    const seen: string[][] = []
    const off = subscribeBankWarnings((w) => seen.push(w))
    h.state.replies['simplefin:sync'] = ok({ accounts: both, errors: [] })
    await syncAllConnectors({ force: true })
    expect(await netWorth()).toBe(750)
    h.state.replies['simplefin:sync'] = ok({ accounts: [both[0]], errors: ['Connection to Test Card Co may need attention'] })
    const res = await syncAllConnectors({ force: true })
    expect(await netWorth()).toBe(750)
    expect(res.warnings).toEqual(['Connection to Test Card Co may need attention'])
    expect(seen.at(-1)).toEqual(['Connection to Test Card Co may need attention'])
    off()
  })

  it('a clean answer that leaves an account out still archives it', async () => {
    h.state.replies['simplefin:sync'] = ok({ accounts: both, errors: [] })
    await syncAllConnectors({ force: true })
    h.state.replies['simplefin:sync'] = ok({ accounts: [both[0]], errors: [] })
    await syncAllConnectors({ force: true })
    expect(await netWorth()).toBe(1000)
  })
})

describe('B28: a removed bank account', () => {
  it('stays removed through a sync, keeps a fresh balance, and can be restored', async () => {
    const card = acct('card', 'Rewards Card', 'credit', -612.44)
    await applySyncedAccounts([acct('chk', 'Checking', 'cash', 1000), card], 'simplefin')
    const row = (await db.accounts.toArray()).find((a) => a.name === 'Rewards Card')!
    await db.accounts.update(row.id!, { deleted: true, updatedAt: Date.now() })
    const counts = await applySyncedAccounts([acct('chk', 'Checking', 'cash', 1000), { ...card, balance: -712.44 }], 'simplefin')
    expect(counts).toEqual({ shown: 1, removed: 1 })
    expect(await db.accounts.get(row.id!)).toMatchObject({ deleted: true, balance: 712.44 })
    await restoreAccount(row.id!)
    expect(await netWorth()).toBeCloseTo(287.56, 2)
  })
})

describe('B26: the note after connecting a bank', () => {
  it('carries the bank errors, never the brokerage ones', async () => {
    h.state.replies['snaptrade:sync'] = h.netError
    const res = await connectBank('dGVzdA==')
    expect(res).toEqual({ shown: 0, removed: 0, errors: [] })
    h.state.replies['simplefin:transactions'] = () => h.httpError(502, 'simplefin /accounts -> 500')
    expect((await connectBank('dGVzdA==')).errors).toEqual(['simplefin /accounts -> 500'])
  })
})

describe('B55: signing out while balances are in flight', () => {
  it('writes neither the brokerage nor the bank answer into the wiped device', async () => {
    let wiped!: () => void
    const done = new Promise<void>((r) => (wiped = r))
    h.state.replies['snaptrade:sync'] = async () => {
      await signOutSync({ confirmed: true })
      wiped()
      return ok({ accounts: [{ ...acct('brk', 'Brokerage', 'brokerage', 5000), institution: 'Test Brokerage' }] })()
    }
    h.state.replies['simplefin:sync'] = async () => (await done, ok({ accounts: [acct('chk', 'Checking', 'cash', 1000)] })())
    h.state.replies['simplefin:transactions'] = async () => (await done, ok({ transactions: [bankTx('t1', -12, 'CORNER CAFE')] })())
    await syncAllConnectors({ force: true })
    expect(await db.accounts.count()).toBe(0)
    expect(await db.transactions.count()).toBe(0)
    expect(localStorage.getItem('tally:lastBankFetchAt')).toBeNull()
  })
})

describe('the balance sync and the transaction sync of one run', () => {
  // An account the name cannot place, stored as a card after it was overdrawn
  // once. Its balance is back above zero, and its feed has a deposit. The two
  // fetches run side by side; the transaction sync used to read the stored
  // type before the balance sync wrote 'cash', and filed the deposit as a card
  // credit (a −$500 refund) until the next bank fetch hours later.
  it('reads the account only after its new balance landed, whichever answers first', async () => {
    await db.categories.bulkAdd([
      { id: 1, name: 'Other income', key: 'other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
      { id: 2, name: 'Other', key: 'other', icon: 'box', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
    ])
    await applySyncedAccounts([acct('ev', 'Everyday', 'credit', -40)], 'simplefin')
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'credit' })
    const label = 'Test Bank Everyday'
    const feed = [
      { sourceTxId: 'bank.test:ev:old', account: label, tier: 'cash', posted: NOW - 20 * 86400, amount: -12, payee: 'CORNER CAFE', description: 'CORNER CAFE', memo: '', mcc: null },
      { sourceTxId: 'bank.test:ev:dep', account: label, tier: 'cash', posted: NOW - 86400, amount: 500, payee: 'ACME CORP', description: 'ACME CORP', memo: '', mcc: null },
    ]
    h.state.replies['simplefin:transactions'] = ok({ transactions: feed, accounts: [label] })
    h.state.replies['simplefin:sync'] = () =>
      new Promise((r) => setTimeout(() => r({ data: { ok: true, accounts: [acct('ev', 'Everyday', 'cash', 300)], errors: [] }, error: null }), 40))
    await syncAllConnectors({ force: true })
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'cash', balance: 300 })
    const dep = await db.transactions.where('uid').equals('sf:bank.test:ev:dep').first()
    expect(dep).toMatchObject({ type: 'income', amount: 500, deleted: false })
  })
})
