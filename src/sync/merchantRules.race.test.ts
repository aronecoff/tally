// @vitest-environment jsdom
/**
 * B88: a rules load still in flight when the user signs out (or another
 * account signs in) must not write the old account's rules back afterwards.
 * Fake rules only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    session: { user: { id: 'user-A' } } as { user: { id: string } } | null,
    asked: [] as string[],
    pending: [] as { user: string; release: () => void }[],
  }
  const rowsFor = (user: string) => [{ pattern: user === 'user-A' ? 'zorblatt' : 'quexbin', flags: 'i', category: 'Dining', kind: 'expense', priority: 35 }]
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: () => {
      let user = ''
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => ((user = v), q),
        order: () => {
          state.asked.push(user)
          return new Promise((resolve) => {
            state.pending.push({ user, release: () => resolve({ data: rowsFor(user), error: null }) })
          })
        },
      }
      return q
    },
  }
  return { state, client }
})

vi.mock('../db/supabase', () => ({ supabase: h.client }))

import { loadMerchantRules, reloadMerchantRules } from './merchantRules'
import { clearUserRules, getUserRules, userRulesReady } from '../lib/userRules'

const CACHE_KEY = 'tally:merchantRules:v1'
const flush = () => new Promise((r) => setTimeout(r, 0))
const patterns = () => getUserRules().map((r) => r.match.source)

beforeEach(() => {
  h.state.session = { user: { id: 'user-A' } }
  h.state.asked = []
  h.state.pending = []
})
afterEach(() => {
  clearUserRules()
  localStorage.clear()
})

describe('a rules load across a sign-out', () => {
  it('signing out mid-load leaves no rules and no cache', async () => {
    const load = loadMerchantRules()
    await vi.waitFor(() => expect(h.state.pending).toHaveLength(1))
    h.state.session = null
    clearUserRules() // what sign-out does
    h.state.pending[0].release()
    await expect(load).resolves.toBe(false)
    expect(userRulesReady()).toBe(false)
    expect(localStorage.getItem(CACHE_KEY)).toBeNull()
  })

  it('another account signing in mid-load gets its own rules, not the old ones', async () => {
    void loadMerchantRules()
    await vi.waitFor(() => expect(h.state.pending).toHaveLength(1))
    h.state.session = null
    clearUserRules()
    h.state.session = { user: { id: 'user-B' } }
    const mine = loadMerchantRules()
    await vi.waitFor(() => expect(h.state.asked).toEqual(['user-A', 'user-B']))
    h.state.pending.forEach((p) => p.release())
    await expect(mine).resolves.toBe(true)
    await flush()
    expect(patterns()).toEqual(['quexbin'])
  })

  it('the same account asking again mid-load shares the load', async () => {
    const first = loadMerchantRules()
    await vi.waitFor(() => expect(h.state.pending).toHaveLength(1))
    const again = loadMerchantRules()
    h.state.pending[0].release()
    await expect(again).resolves.toBe(true)
    await first
    expect(h.state.asked).toEqual(['user-A'])
    expect(patterns()).toEqual(['zorblatt'])
  })

  it('a reload after a rule is saved asks again once the earlier load ends', async () => {
    void loadMerchantRules()
    await vi.waitFor(() => expect(h.state.pending).toHaveLength(1))
    const reload = reloadMerchantRules()
    h.state.pending[0].release()
    await vi.waitFor(() => expect(h.state.pending).toHaveLength(2))
    h.state.pending[1].release()
    await expect(reload).resolves.toBe(true)
    expect(h.state.asked).toEqual(['user-A', 'user-A'])
  })
})
