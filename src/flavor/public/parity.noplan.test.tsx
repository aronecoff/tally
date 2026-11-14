// @vitest-environment jsdom
/**
 * The public app's twin of src/parity.noplan.test.tsx, with the module swaps on:
 * with no savings plan in force, nothing moved.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { getPlan, setPlan } from '../../lib/planCache'
import type { SavingsPlan } from '../../lib/savingsPlan'
import { captureParity, withoutPlanGroup } from '../../test-parity'
import homeBefore from './__parity__/home.html?raw'
import budgetBefore from './__parity__/budget.html?raw'

const KEY = 'tally:savingsPlan:v1'
/** What another tab's write looks like to this one: the copy in memory is read again. */
const reread = () => window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
const unlocked: SavingsPlan = { goal: 800, cap: 1500, locked: false, since: null, pending: null, updatedAt: 1 }
const locked: SavingsPlan = { goal: 800, cap: 1500, locked: true, since: '2031-02', pending: null, updatedAt: 1 }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  localStorage.clear()
  setPlan(null)
})

afterEach(() => {
  cleanup()
  setPlan(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const WAYS: [string, () => void][] = [
  ['none was ever kept', () => {}],
  [
    'the kept one will not parse',
    () => {
      localStorage.setItem(KEY, '{"goal": 800, "cap"')
      reread()
      expect(getPlan()).toBeNull()
    },
  ],
  [
    'it is unlocked',
    () => {
      localStorage.setItem(KEY, JSON.stringify(unlocked))
      reread()
      expect(getPlan()).toEqual(unlocked)
    },
  ],
]

describe('with no savings plan in force', () => {
  it.each(WAYS)('every screen, the widget, the alerts and the command bar are what they were: %s', async (_way, arrange) => {
    arrange()
    const got = await captureParity()
    // The one allowed difference: the plan needs no account here, so Settings
    // always offers its group. The rest of the sheet is what it was.
    const settings = withoutPlanGroup(got['settings.html'])
    expect(settings.found).toBeGreaterThan(0)
    expect(got['settings.html']).toContain('Lock the budget')
    got['settings.html'] = settings.html
    for (const [name, text] of Object.entries(got)) await expect(text, name).toMatchFileSnapshot(`./__parity__/${name}`)
  })

  it('and these pictures would show it: a locked plan does change Home and Budget', async () => {
    setPlan(locked)
    const got = await captureParity()
    expect(got['home.html']).not.toBe(homeBefore)
    expect(got['budget.html']).not.toBe(budgetBefore)
    expect(got['home.html']).toContain('of $1,500 budget')
  })
})
