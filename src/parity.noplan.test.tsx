// @vitest-environment jsdom
/**
 * With no savings plan in force, nothing moved. The files beside this test are
 * what each screen drew, and what the widget, the alerts and Tell Tally
 * produced, before the plan existed (src/test-parity.tsx holds the invented
 * ledger they come from). Every way of having no plan in force must give those
 * same bytes: none kept, one that will not parse, one that is unlocked, and one
 * locked in the account whose table the cloud says it does not have.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { getPlan, setPlan } from './lib/planCache'
import { loadSavingsPlan, planCanSave } from './lib/planStore'
import type { SavingsPlan } from './lib/savingsPlan'
import { captureParity, withoutPlanGroup } from './test-parity'
import homeBefore from './__parity__/tally/home.html?raw'
import budgetBefore from './__parity__/tally/budget.html?raw'

const cloud = vi.hoisted(() => {
  const state = {
    session: null as { user: { id: string } } | null,
    /** What asking for the plan's table answers. */
    plan: { data: [] as unknown, error: null as unknown },
    asked: 0,
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: async () => {
            state.asked++
            return state.plan
          },
        }),
      }),
    }),
  }
  return { state, client }
})

vi.mock('./db/supabase', () => ({ supabase: cloud.client }))

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
  cloud.state.session = null
  cloud.state.plan = { data: [], error: null }
  cloud.state.asked = 0
})

afterEach(() => {
  cleanup()
  setPlan(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Each way of having no plan in force, and whether Settings shows the plan's group then. */
const WAYS: [string, boolean, () => void | Promise<void>][] = [
  ['none was ever kept', false, () => {}],
  [
    'the kept one will not parse',
    false,
    () => {
      localStorage.setItem(KEY, '{"goal": 800, "cap"')
      reread()
      expect(getPlan()).toBeNull()
    },
  ],
  [
    // A device that holds a plan shows its group in Settings, and nothing else moves.
    'it is unlocked',
    true,
    () => {
      localStorage.setItem(KEY, JSON.stringify(unlocked))
      reread()
      expect(getPlan()).toEqual(unlocked)
    },
  ],
  [
    'one is locked in the account, and the cloud says it has no such table',
    false,
    async () => {
      cloud.state.session = { user: { id: 'user-1' } }
      cloud.state.plan = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.savings_plan' in the schema cache" } }
      await expect(loadSavingsPlan()).resolves.toBe(false)
      await expect(planCanSave()).resolves.toBe(false)
      expect(cloud.state.asked).toBe(1)
      expect(getPlan()).toBeNull()
    },
  ],
]

describe('with no savings plan in force', () => {
  it.each(WAYS)('every screen, the widget, the alerts and Tell Tally are what they were: %s', async (_way, group, arrange) => {
    await arrange()
    const got = await captureParity()
    const settings = withoutPlanGroup(got['settings.html'])
    // With nothing kept and nothing to save to, Settings has no group at all.
    expect(settings.found > 0).toBe(group)
    if (group) got['settings.html'] = settings.html
    for (const [name, text] of Object.entries(got)) await expect(text, name).toMatchFileSnapshot(`./__parity__/tally/${name}`)
  })

  it('and these pictures would show it: a locked plan does change Home and Budget', async () => {
    setPlan(locked)
    const got = await captureParity()
    expect(got['home.html']).not.toBe(homeBefore)
    expect(got['budget.html']).not.toBe(budgetBefore)
    expect(got['home.html']).toContain('of $1,500 budget')
  })
})
