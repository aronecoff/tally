// @vitest-environment jsdom
/**
 * The plan's store in the public app: the device holds the only copy, and no
 * account is involved. Imported by the path shared code uses, so this also
 * shows the swap answering. The amounts are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSavingsPlan, getPlan, setPlan } from '../../lib/planCache'
import { loadSavingsPlan, planCanSave, saveSavingsPlan } from '../../lib/planStore'
import type { SavingsPlan } from '../../lib/savingsPlan'

const KEY = 'tally:savingsPlan:v1'
const NOW = '2031-04-10T12:00:00'
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as SavingsPlan | null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  localStorage.clear()
  clearSavingsPlan()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearSavingsPlan()
  localStorage.clear()
})

describe('the plan on this device', () => {
  it('needs no account: it can always be read and changed', async () => {
    await expect(loadSavingsPlan()).resolves.toBe(true)
    await expect(planCanSave()).resolves.toBe(true)
  })

  it('a save lands in memory and in storage, stamped now', async () => {
    await expect(saveSavingsPlan({ goal: 800, cap: 3000, locked: true })).resolves.toEqual({ ok: true })
    const want = { goal: 800, cap: 3000, locked: true, since: '2031-05', pending: null, updatedAt: new Date(NOW).getTime() }
    expect(getPlan()).toEqual(want)
    expect(stored()).toEqual(want)
  })

  it('loading leaves the plan the device holds as it is', async () => {
    await saveSavingsPlan({ goal: 800, cap: 3000, locked: true })
    const held = getPlan()
    await loadSavingsPlan()
    expect(getPlan()).toBe(held)
  })

  it('the rules are the same: a loosening waits, and a refusal comes back with its line', async () => {
    await saveSavingsPlan({ goal: 800, cap: 3000, locked: true })
    await expect(saveSavingsPlan({ cap: 3500 })).resolves.toEqual({ ok: true })
    expect(getPlan()).toMatchObject({ cap: 3000, pending: { from: '2031-05', cap: 3500 } })
    await expect(saveSavingsPlan({ cap: 0 })).resolves.toEqual({ ok: false, message: 'Enter an amount above $0.' })
    await expect(saveSavingsPlan({ cancel: true })).resolves.toEqual({ ok: true })
    expect(getPlan()?.pending).toBeNull()
  })

  it('an amount too large to keep is refused: the lock it would have lost stays, after a launch too', async () => {
    await saveSavingsPlan({ goal: 800, cap: 3000, locked: true })
    await expect(saveSavingsPlan({ goal: 1e307 })).resolves.toEqual({ ok: false, message: 'Enter an amount above $0.' })
    expect(getPlan()).toMatchObject({ goal: 800, cap: 3000, locked: true })
    vi.resetModules()
    const relaunched = await import('../../lib/planCache')
    expect(relaunched.getPlan()).toMatchObject({ goal: 800, cap: 3000, locked: true })
  })

  it("uses the clock's date: a change whose month has come is folded in first", async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-03', pending: { from: '2031-04', cap: 3500 }, updatedAt: 1 })
    await expect(saveSavingsPlan({ goal: 900 })).resolves.toEqual({ ok: true })
    expect(stored()).toMatchObject({ cap: 3500, goal: 900, pending: null })
  })

  it('writes through the same rule as the account: a change that came into force today stays waiting in what is kept', async () => {
    setPlan({ goal: 800, cap: 3000, locked: true, since: '2031-10', pending: { from: '2031-12', cap: 3500 }, updatedAt: 1 })
    await expect(saveSavingsPlan({ goal: 900 }, '2031-12-01')).resolves.toEqual({ ok: true })
    expect(stored()).toMatchObject({ cap: 3000, goal: 900, pending: { from: '2031-12', cap: 3500 } })
  })

  it('blocked storage is reported, and the plan stays what the device still holds', async () => {
    await saveSavingsPlan({ goal: 800, cap: 3000, locked: true })
    const held = getPlan()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await expect(saveSavingsPlan({ cap: 2800 })).resolves.toEqual({ ok: false, message: 'Could not save the plan on this device.' })
    expect(getPlan()).toEqual(held)
  })
})
