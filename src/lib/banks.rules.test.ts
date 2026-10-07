/**
 * The connector loop waits for the user's own categorization rules before it
 * re-files anything. A fresh device with no copy of them would otherwise file
 * those merchants by the built-in rules alone and push that over the cloud.
 * Brokerage balances refresh either way; the rate-limited bank pair waits for
 * the rules, so its 6-hour floor is not spent on balances alone.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_fn: string, opts: { body: { action: string } }) => {
    if (opts.body.action === 'transactions') return { data: { ok: true, transactions: [] }, error: null }
    return { data: { ok: true, accounts: [] }, error: null }
  }),
  loadMerchantRules: vi.fn(async () => false),
}))

vi.mock('../db/supabase', () => {
  // Signed in, with an empty cloud: the bank pair runs only after a good pull.
  const empty = {
    order: () => empty,
    limit: () => empty,
    gt: () => empty,
    then: (ok: (v: { data: never[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  }
  return {
    supabase: {
      functions: { invoke: h.invoke },
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'owner@example.com' } } } }) },
      from: () => ({ select: () => empty, upsert: async () => ({ error: null }) }),
    },
  }
})
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: h.loadMerchantRules }))

import { syncAllConnectors } from './banks'
import { clearUserRules, setUserRules } from './userRules'
import { db } from '../db/db'

const T0 = 1_700_000_000_000
const actions = () => h.invoke.mock.calls.map(([fn, opts]) => `${fn}:${opts.body.action}`)
const orphanCategory = async () => (await db.transactions.get(1))?.categoryId ?? null

beforeEach(async () => {
  vi.clearAllMocks()
  clearUserRules()
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.add({ id: 1, name: 'Groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: T0 })
  // An uncategorised row the built-in rules can file.
  await db.transactions.add({
    id: 1, date: '2026-09-10', amount: 12, type: 'expense', categoryId: null, account: 'Checking',
    note: 'SAFEWAY #1234', createdAt: T0, updatedAt: T0,
  })
})
afterEach(() => clearUserRules())

describe('runAllConnectors and the user rules', () => {
  it('with no copy of the rules: brokerages refresh, the bank pair waits, nothing is re-filed', async () => {
    h.loadMerchantRules.mockResolvedValueOnce(false)
    await syncAllConnectors({ force: true })
    // Both bank calls wait (B26), so the floor is not spent on balances alone.
    expect(actions()).not.toContain('simplefin:sync')
    expect(actions()).toContain('snaptrade:sync')
    expect(actions()).not.toContain('simplefin:transactions')
    expect(await orphanCategory()).toBeNull()
  })

  it('a cached copy is enough when the fetch fails', async () => {
    setUserRules([])
    h.loadMerchantRules.mockResolvedValueOnce(false)
    await syncAllConnectors({ force: true })
    expect(actions()).toContain('simplefin:transactions')
    expect(await orphanCategory()).toBe(1)
  })

  it('freshly loaded rules let the whole round run', async () => {
    h.loadMerchantRules.mockResolvedValueOnce(true)
    await syncAllConnectors({ force: true })
    expect(actions()).toEqual(expect.arrayContaining(['simplefin:sync', 'simplefin:transactions', 'snaptrade:sync']))
    expect(await orphanCategory()).toBe(1)
  })

  it('a loader that throws counts as not loaded', async () => {
    h.loadMerchantRules.mockRejectedValueOnce(new Error('boom'))
    await syncAllConnectors({ force: true })
    expect(actions()).not.toContain('simplefin:transactions')
    expect(await orphanCategory()).toBeNull()
  })
})
