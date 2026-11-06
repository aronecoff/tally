// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadMerchantRules, reloadMerchantRules } from '../../sync/merchantRules'
import { clearUserRules, getUserRules, userRulesReady } from '../../lib/userRules'
import { localDb } from './localDb'

const rule = (pattern: string, priority: number, updated_at: string) => ({
  pattern, flags: 'i', category: 'Fun', kind: 'expense', priority, updated_at,
})

beforeEach(async () => {
  clearUserRules()
  await localDb.rules.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('loadMerchantRules', () => {
  it('an empty store is a real answer: ready, with no rules', async () => {
    expect(userRulesReady()).toBe(false)
    await expect(loadMerchantRules()).resolves.toBe(true)
    expect(userRulesReady()).toBe(true)
    expect(getUserRules()).toEqual([])
  })

  it('orders by priority, then newest stamp, then newest id', async () => {
    await localDb.rules.bulkAdd([
      rule('older', 4, '2031-02-01T00:00:00.000Z'),
      rule('newer', 4, '2031-02-02T00:00:00.000Z'),
      rule('after', 9, '2031-02-03T00:00:00.000Z'),
      rule('tie-first-id', 4, '2031-02-02T00:00:00.000Z'),
    ])
    await loadMerchantRules()
    expect(getUserRules().map((r) => r.pattern)).toEqual(['tie-first-id', 'newer', 'older', 'after'])
  })

  it('caches the rules for a synchronous boot', async () => {
    await localDb.rules.add(rule('zentrix', 4, '2031-02-01T00:00:00.000Z'))
    await loadMerchantRules()
    expect(JSON.parse(localStorage.getItem('tally:merchantRules:v1')!)).toEqual([
      { pattern: 'zentrix', flags: 'i', category: 'Fun', kind: 'expense', priority: 4 },
    ])
  })

  it('a load overtaken by a later one leaves the later answer standing', async () => {
    await localDb.rules.add(rule('first', 4, '2031-02-01T00:00:00.000Z'))
    const early = loadMerchantRules()
    await localDb.rules.add(rule('second', 4, '2031-02-02T00:00:00.000Z'))
    await Promise.all([early, reloadMerchantRules()])
    expect(getUserRules().map((r) => r.pattern)).toEqual(['second', 'first'])
  })

  it('a failed read keeps what is in memory and says so', async () => {
    await localDb.rules.add(rule('zentrix', 4, '2031-02-01T00:00:00.000Z'))
    await loadMerchantRules()
    vi.spyOn(localDb.rules, 'toArray').mockRejectedValueOnce(new Error('read failed'))
    await expect(loadMerchantRules()).resolves.toBe(false)
    expect(getUserRules().map((r) => r.pattern)).toEqual(['zentrix'])
  })
})
