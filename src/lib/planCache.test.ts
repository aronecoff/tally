// @vitest-environment jsdom
/**
 * The plan's in-memory copy and its cache: read once at load so the first paint
 * and an offline launch already have it. The amounts are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SavingsPlan } from './savingsPlan'

const KEY = 'tally:savingsPlan:v1'
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 5, ...extra })

/** The module as a fresh launch loads it, reading whatever storage holds. */
async function launch() {
  vi.resetModules()
  return import('./planCache')
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the cached plan', () => {
  it('is read from storage at load', async () => {
    localStorage.setItem(KEY, JSON.stringify(plan()))
    const cache = await launch()
    expect(cache.getPlan()).toEqual(plan())
  })

  it('is no plan when there is none', async () => {
    const cache = await launch()
    expect(cache.getPlan()).toBeNull()
  })

  it.each([['text that will not parse', '{not json'], ['something that is not a plan', JSON.stringify({ goal: 'x' })]])(
    '%s reads as no plan and is removed',
    async (_what, stored) => {
      localStorage.setItem(KEY, stored)
      const cache = await launch()
      expect(cache.getPlan()).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    },
  )

  it('setPlan keeps it in memory and in storage, and tells whoever is listening', async () => {
    const cache = await launch()
    const heard = vi.fn()
    const stop = cache.subscribePlan(heard)
    expect(cache.setPlan(plan())).toBe(true)
    expect(cache.getPlan()).toEqual(plan())
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(plan())
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    cache.setPlan(plan({ cap: 2800 }))
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('the same plan again is not news: the copy stays the same object', async () => {
    const cache = await launch()
    cache.setPlan(plan({ pending: { from: '2031-05', cap: 3500, goal: 700 } }))
    const held = cache.getPlan()
    const heard = vi.fn()
    cache.subscribePlan(heard)
    cache.setPlan(plan({ pending: { goal: 700, cap: 3500, from: '2031-05' } }))
    expect(cache.getPlan()).toBe(held)
    expect(heard).not.toHaveBeenCalled()
  })

  it('setPlan(null) removes it', async () => {
    localStorage.setItem(KEY, JSON.stringify(plan()))
    const cache = await launch()
    expect(cache.setPlan(null)).toBe(true)
    expect(cache.getPlan()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('blocked storage is reported, and the copy in memory still holds for this session', async () => {
    const cache = await launch()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(cache.setPlan(plan())).toBe(false)
    expect(cache.getPlan()).toEqual(plan())
  })

  it('clearing it forgets it and moves the epoch on', async () => {
    localStorage.setItem(KEY, JSON.stringify(plan()))
    const cache = await launch()
    const before = cache.planEpoch()
    const heard = vi.fn()
    cache.subscribePlan(heard)
    cache.clearSavingsPlan()
    expect(cache.getPlan()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(cache.planEpoch()).toBe(before + 1)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a change made in another tab refreshes this one', async () => {
    const cache = await launch()
    const heard = vi.fn()
    cache.subscribePlan(heard)
    localStorage.setItem(KEY, JSON.stringify(plan({ cap: 2800 })))
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
    expect(cache.getPlan()).toEqual(plan({ cap: 2800 }))
    expect(heard).toHaveBeenCalledTimes(1)
    // Another key is not ours.
    localStorage.setItem(KEY, JSON.stringify(plan({ cap: 2600 })))
    window.dispatchEvent(new StorageEvent('storage', { key: 'tally-theme' }))
    expect(cache.getPlan()).toEqual(plan({ cap: 2800 }))
  })
})

describe('useSavingsPlan', () => {
  it('is the plan as it stands today, and takes a pending change in at midnight with no reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-04-30T23:59:30'))
    localStorage.setItem(KEY, JSON.stringify(plan({ pending: { from: '2031-05', cap: 3500 } })))
    const cache = await launch()
    const { result } = renderHook(() => cache.useSavingsPlan())
    expect(result.current).toMatchObject({ cap: 3000, pending: { from: '2031-05', cap: 3500 } })
    const before = result.current
    // The same day again hands back the same object.
    act(() => window.dispatchEvent(new Event('focus')))
    expect(result.current).toBe(before)
    vi.setSystemTime(new Date('2031-05-01T00:00:20'))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(result.current).toMatchObject({ cap: 3500, pending: null })
  })

  it('follows a plan set while the screen is open', async () => {
    const cache = await launch()
    const { result } = renderHook(() => cache.useSavingsPlan())
    expect(result.current).toBeNull()
    act(() => void cache.setPlan(plan()))
    expect(result.current).toEqual(plan())
  })
})

describe('useCapInForce', () => {
  it('is capInForce for today: null with no plan or the lock off, the cap while locked, a pending raise from the 1st', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-04-30T23:59:30'))
    const cache = await launch()
    const { result } = renderHook(() => cache.useCapInForce())
    expect(result.current).toBeNull()
    act(() => void cache.setPlan(plan({ locked: false, since: null })))
    expect(result.current).toBeNull()
    act(() => void cache.setPlan(plan({ pending: { from: '2031-05', cap: 3500 } })))
    expect(result.current).toBe(3000)
    vi.setSystemTime(new Date('2031-05-01T00:00:20'))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(result.current).toBe(3500)
  })
})
