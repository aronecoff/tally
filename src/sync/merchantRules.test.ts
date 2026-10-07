// @vitest-environment jsdom
/**
 * The merchant-rules loader: what it asks the server, what it keeps when it
 * cannot ask, and the order the loaded rules apply in. Fake rules only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    enabled: true,
    session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
    result: { data: [] as unknown, error: null as unknown },
  }
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(async () => state.result),
  }
  const client = {
    auth: { getSession: vi.fn(async () => ({ data: { session: state.session } })) },
    from: vi.fn(() => query),
  }
  return { state, query, client }
})

vi.mock('../db/supabase', () => ({
  get supabase() {
    return h.state.enabled ? h.client : null
  },
}))

import { loadMerchantRules } from './merchantRules'
import { guessCategoryName } from '../lib/categorize'
import { clearUserRules, getUserRules, setUserRules, userRulesReady } from '../lib/userRules'

const CACHE_KEY = 'tally:merchantRules:v1'
const cached = () => JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as unknown[] | null
const setOnline = (on: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => on })

beforeEach(() => {
  vi.clearAllMocks()
  h.state.enabled = true
  h.state.session = { user: { id: 'user-1' } }
  h.state.result = { data: [], error: null }
  setOnline(true)
})
afterEach(() => {
  clearUserRules()
  localStorage.clear()
})

describe('loadMerchantRules', () => {
  it("asks for the user's rows by priority, applies them and caches them", async () => {
    // Returned out of order on purpose: the merge sorts by priority itself.
    h.state.result = {
      data: [
        { pattern: 'zorblatt', flags: 'i', category: 'Shopping', kind: 'expense', priority: 85 },
        { pattern: 'zorblatt', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 },
      ],
      error: null,
    }
    await expect(loadMerchantRules()).resolves.toBe(true)
    expect(h.client.from).toHaveBeenCalledWith('merchant_rules')
    expect(h.query.select).toHaveBeenCalledWith('id,pattern,flags,category,kind,priority,updated_at')
    expect(h.query.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(h.query.order).toHaveBeenCalledWith('priority')
    expect(userRulesReady()).toBe(true)
    expect(cached()).toHaveLength(2)
    // The lower priority wins whatever order the rows arrived in.
    expect(guessCategoryName('ZORBLATT', 'expense')).toBe('Dining')
    // And a built-in between them (Transport, 40) is ordered correctly too.
    expect(guessCategoryName('ZORBLATT PARKING', 'expense')).toBe('Dining')
  })

  it('B10: rules that tie are tried newest first, whatever order the server sent them in', async () => {
    const older = { id: 1, pattern: 'zorblatt', flags: 'i', category: 'Shopping', kind: 'expense', priority: 4, updated_at: '2026-09-01T00:00:00Z' }
    const newer = { id: 2, pattern: 'zorblatt prime', flags: 'i', category: 'Fun', kind: 'expense', priority: 4, updated_at: '2026-09-20T00:00:00Z' }
    for (const data of [[older, newer], [newer, older]]) {
      h.state.result = { data, error: null }
      await expect(loadMerchantRules()).resolves.toBe(true)
      expect(guessCategoryName('ZORBLATT PRIME', 'expense')).toBe('Fun')
    }
    // Retargeting the older rule makes it the newest: it wins from then on.
    h.state.result = { data: [{ ...older, updated_at: '2026-09-25T00:00:00Z' }, newer], error: null }
    await loadMerchantRules()
    expect(guessCategoryName('ZORBLATT PRIME', 'expense')).toBe('Shopping')
  })

  it('offline: asks nothing, returns false and keeps the cached rules', async () => {
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 }])
    setOnline(false)
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(h.client.from).not.toHaveBeenCalled()
    expect(userRulesReady()).toBe(true)
    expect(cached()).toHaveLength(1)
    expect(guessCategoryName('ZORBLATT', 'expense')).toBe('Dining')
  })

  it('a failed query (a missing table, a network error) keeps the cache', async () => {
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 }])
    h.state.result = { data: null, error: { message: 'relation "public.merchant_rules" does not exist' } }
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(getUserRules()).toHaveLength(1)
    expect(cached()).toHaveLength(1)
  })

  it('a thrown request is a failure, not a crash', async () => {
    h.query.order.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(userRulesReady()).toBe(false)
  })

  it('a fresh device with no cache stays not ready until the rows arrive', async () => {
    h.state.result = { data: null, error: { message: 'timeout' } }
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(userRulesReady()).toBe(false)
    expect(cached()).toBeNull()
  })

  it('an empty result is a real answer: ready, with no rules', async () => {
    await expect(loadMerchantRules()).resolves.toBe(true)
    expect(userRulesReady()).toBe(true)
    expect(cached()).toEqual([])
  })

  it('signed out: returns false without querying and leaves the cache alone', async () => {
    setUserRules([{ pattern: 'zorblatt', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 }])
    h.state.session = null
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(h.client.from).not.toHaveBeenCalled()
    expect(cached()).toHaveLength(1)
  })

  it('no backend at all (local-only build): nothing personal to wait for', async () => {
    h.state.enabled = false
    await expect(loadMerchantRules()).resolves.toBe(true)
    expect(userRulesReady()).toBe(true)
    expect(getUserRules()).toHaveLength(0)
  })

  it('overlapping callers share one request', async () => {
    const [a, b] = await Promise.all([loadMerchantRules(), loadMerchantRules()])
    expect([a, b]).toEqual([true, true])
    expect(h.query.order).toHaveBeenCalledTimes(1)
  })
})
