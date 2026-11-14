// @vitest-environment jsdom
/**
 * The savings plan's group in Tally's Settings. The cloud is a fake that keeps
 * one row for the account, as the table does. The amounts are invented: a 3,000
 * budget and an 800 goal.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

type Row = Record<string, unknown>

const h = vi.hoisted(() => {
  const state = {
    session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
    row: null as Row | null,
    readError: null as unknown,
    upsertError: null as unknown,
    upserts: [] as Row[],
    email: 'someone@example.com' as string | null,
  }
  const answer = () => (state.row ? [state.row] : [])
  const client = {
    auth: { getSession: async () => ({ data: { session: state.session } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ limit: async () => (state.readError ? { data: null, error: state.readError } : { data: answer(), error: null }) }),
      }),
      upsert: (row: Row) => ({
        select: async () => {
          state.upserts.push(row)
          if (state.upsertError) return { data: null, error: state.upsertError }
          state.row = row
          return { data: answer(), error: null }
        },
      }),
    }),
  }
  return { state, client }
})

vi.mock('../db/supabase', () => ({ supabase: h.client }))
vi.mock('../sync/sync', async (real) => ({
  ...(await real<typeof import('../sync/sync')>()),
  subscribeSync: (listener: (snap: { email: string | null; status: string; lastSyncedAt: null; error: null }) => void) => {
    listener({ email: h.state.email, status: 'idle', lastSyncedAt: null, error: null })
    return () => {}
  },
}))

import { db } from '../db/db'
import { DOUBLE_TAP_MS } from '../lib/useArmed'
import type { SavingsPlan } from '../lib/savingsPlan'
import type { Account as AccountSheet } from './Account'

const NOW = '2031-11-12T12:00:00'
const at = (iso: string) => new Date(iso).getTime()
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-11', pending: null, updatedAt: at('2031-11-01T09:00:00'), ...extra })
const cloudRow = (p: SavingsPlan): Row => ({ goal: p.goal, cap: p.cap, locked: p.locked, since: p.since, pending: p.pending, updated_at: new Date(p.updatedAt).toISOString() })

let Account: typeof AccountSheet
let cache: typeof import('../lib/planCache')

/** A fresh launch, so what the store remembers of the table starts over. */
async function launch() {
  vi.resetModules()
  cache = await import('../lib/planCache')
  Account = (await import('./Account')).Account
}

const open = () =>
  render(<Account onClose={() => {}} pref="system" setPref={() => {}} onCategories={() => {}} onBankConnections={() => {}} onImport={() => {}} onBackups={() => {}} />)
const sheet = () => document.querySelector('.sheet') as HTMLElement
const group = () => [...sheet().querySelectorAll('[data-plan]')] as HTMLElement[]
const said = () => [...sheet().querySelectorAll('[data-plan] > p')].map((p) => p.textContent)
const errors = () => [...sheet().querySelectorAll('[data-plan] > p.sheet-err')].map((p) => p.textContent)
const goal = () => screen.getByLabelText('Save each month') as HTMLInputElement
const budget = () => screen.getByLabelText('Monthly budget') as HTMLInputElement
const lock = () => screen.getByRole('switch', { name: 'Lock the budget' })
const typeIn = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } })
/** Past the double-tap window, so the next tap is a confirmation. */
const wait = () => act(async () => void vi.advanceTimersByTime(DOUBLE_TAP_MS + 50))
const shown = () => screen.findByText('Savings plan')
const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date(NOW))
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  Object.assign(h.state, { session: { user: { id: 'user-1' } }, row: null, readError: null, upsertError: null, upserts: [], email: 'someone@example.com' })
  localStorage.clear()
  await db.categories.clear()
  await launch()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('where there is no plan to show', () => {
  it('shows no group signed out, with nothing kept on the device', async () => {
    h.state.session = null
    h.state.email = null
    open()
    await settled()
    expect(group()).toEqual([])
    expect(sheet().textContent).not.toContain('Savings plan')
  })

  it('shows no group while the cloud has no such table, though the account is signed in', async () => {
    h.state.readError = { code: 'PGRST205', message: "Could not find the table 'public.savings_plan' in the schema cache" }
    open()
    await settled()
    expect(group()).toEqual([])
  })
})

describe('with no plan yet', () => {
  it('shows empty fields, the switch off and the Off note', async () => {
    open()
    await shown()
    expect([goal().value, budget().value]).toEqual(['', ''])
    expect(lock().getAttribute('aria-checked')).toBe('false')
    expect(said()).toEqual(['Off. Turn the lock on and Home counts spending against this budget, and category budgets can only add up to it.'])
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('takes two taps to lock, and the line after the first names both amounts', async () => {
    open()
    await shown()
    typeIn(goal(), '800')
    typeIn(budget(), '$3,000')
    fireEvent.click(lock())
    expect(said()).toContain('Tap again to lock the budget at $3,000 a month with a goal of $800. Turning it off again waits for the 1st of next month.')
    expect(h.state.upserts).toEqual([])
    await wait()
    fireEvent.click(lock())
    await waitFor(() => expect(lock().getAttribute('aria-checked')).toBe('true'))
    // One change: both amounts and the lock.
    expect(h.state.upserts).toEqual([
      { user_id: 'user-1', goal: 800, cap: 3000, locked: true, since: '2031-12', pending: null, past_caps: [], updated_at: expect.any(String) },
    ])
    expect(said()).toEqual(['Locked. Tightening applies now. Loosening starts on the 1st of next month.'])
    await waitFor(() => expect([goal().value, budget().value]).toEqual(['$800', '$3,000']))
  })

  it('after the first tap on the lock, Save is not offered: the second tap sends both typed amounts', async () => {
    open()
    await shown()
    typeIn(goal(), '900')
    typeIn(budget(), '3000')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    fireEvent.click(lock())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await wait()
    fireEvent.click(lock())
    await waitFor(() => expect(lock().getAttribute('aria-checked')).toBe('true'))
    expect(h.state.upserts[0]).toMatchObject({ goal: 900, cap: 3000, locked: true })
  })

  it('a screen reader hears the first tap: the switch is described by a live note that says what the second tap will do', async () => {
    open()
    await shown()
    typeIn(goal(), '800')
    typeIn(budget(), '3000')
    fireEvent.click(lock())
    const note = document.getElementById(lock().getAttribute('aria-describedby') ?? '')
    expect(note?.getAttribute('role')).toBe('status')
    expect(note?.textContent).toBe('Tap again to lock the budget at $3,000 a month with a goal of $800. Turning it off again waits for the 1st of next month.')
  })

  it('a screen reader hears what is wrong: errors are alerts', async () => {
    open()
    await shown()
    typeIn(budget(), '3000')
    fireEvent.click(lock())
    expect(screen.getByRole('alert').textContent).toBe('Enter both amounts first.')
  })

  it('a double tap does not lock', async () => {
    open()
    await shown()
    typeIn(goal(), '800')
    typeIn(budget(), '3000')
    fireEvent.click(lock())
    fireEvent.click(lock())
    await settled()
    expect(h.state.upserts).toEqual([])
    expect(lock().getAttribute('aria-checked')).toBe('false')
  })

  it('with an amount missing it says so and arms nothing', async () => {
    open()
    await shown()
    typeIn(budget(), '3000')
    fireEvent.click(lock())
    expect(errors()).toEqual(['Enter both amounts first.'])
    await wait()
    fireEvent.click(lock())
    await settled()
    expect(h.state.upserts).toEqual([])
  })

  it('what is not a number says so', async () => {
    open()
    await shown()
    typeIn(goal(), 'lots')
    typeIn(budget(), '3000')
    fireEvent.click(lock())
    expect(errors()).toEqual(['Not a number.'])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(errors()).toEqual(['Not a number.'])
    expect(h.state.upserts).toEqual([])
  })

  it('Save with the lock off is one tap, and keeps the amounts without locking', async () => {
    open()
    await shown()
    typeIn(goal(), '800')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.state.upserts).toHaveLength(1))
    expect(h.state.upserts[0]).toMatchObject({ goal: 800, cap: 0, locked: false, since: null })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    await waitFor(() => expect(goal().value).toBe('$800'))
  })
})

describe('with a locked plan', () => {
  beforeEach(() => {
    h.state.row = cloudRow(plan())
    cache.setPlan(plan())
  })

  it('shows the amounts, the switch on and the Locked note, and no Save until a field differs', async () => {
    open()
    await shown()
    expect([goal().value, budget().value]).toEqual(['$800', '$3,000'])
    expect(lock().getAttribute('aria-checked')).toBe('true')
    expect(said()).toEqual(['Locked. Tightening applies now. Loosening starts on the 1st of next month.'])
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    typeIn(budget(), '3000.00')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    typeIn(budget(), '2800')
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('Save takes two taps, says what the second will do, and sends only the field that changed', async () => {
    cache.setPlan(plan({ pending: { from: '2031-12', goal: 700 } }))
    h.state.row = cloudRow(plan({ pending: { from: '2031-12', goal: 700 } }))
    open()
    await shown()
    typeIn(budget(), '2800')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(said()).toContain('The budget drops to $2,800 now. Raising it again waits for the 1st of next month.')
    expect(screen.getByRole('button', { name: 'Tap again to save' })).toBeTruthy()
    expect(h.state.upserts).toEqual([])
    await wait()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(h.state.upserts).toHaveLength(1))
    // The goal was not sent, so its pending change is untouched.
    expect(h.state.upserts[0]).toMatchObject({ cap: 2800, goal: 800, pending: { from: '2031-12', goal: 700 } })
    await waitFor(() => expect(budget().value).toBe('$2,800'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /save/i })).toBeNull())
  })

  it.each([
    ['a higher goal', () => typeIn(goal(), '900'), 'The goal rises to $900 now. Lowering it again waits for the 1st of next month.'],
    ['a higher budget', () => typeIn(budget(), '3500'), 'The budget rises to $3,500 on Dec 1.'],
    ['a lower goal', () => typeIn(goal(), '700'), 'The goal drops to $700 on Dec 1.'],
  ])('before the second tap it says what %s will do', async (_what, change, line) => {
    open()
    await shown()
    change()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(said()).toContain(line)
    expect(h.state.upserts).toEqual([])
  })

  it('with both fields changed there is a line for each, said in the live note in place of how the lock works', async () => {
    open()
    await shown()
    typeIn(budget(), '3500')
    typeIn(goal(), '900')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('status').textContent).toBe('The goal rises to $900 now. Lowering it again waits for the 1st of next month. The budget rises to $3,500 on Dec 1.')
    expect(said()).not.toContain('Locked. Tightening applies now. Loosening starts on the 1st of next month.')
  })

  it('a higher budget becomes pending with its date, and Cancel takes it back', async () => {
    open()
    await shown()
    typeIn(budget(), '3500')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await wait()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(said()).toContain('The budget rises to $3,500 on Dec 1.'))
    // Still the budget in force.
    expect(budget().value).toBe('$3,000')
    expect(cache.getPlan()).toMatchObject({ cap: 3000, pending: { from: '2031-12', cap: 3500 } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this change' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel this change' })).toBeNull())
    expect(said()).not.toContain('The budget rises to $3,500 on Dec 1.')
    expect(cache.getPlan()?.pending).toBeNull()
  })

  it('one tap asks for the lock off, which waits and can be cancelled', async () => {
    open()
    await shown()
    fireEvent.click(lock())
    await waitFor(() => expect(said()).toContain('The lock turns off on Dec 1.'))
    expect(lock().getAttribute('aria-checked')).toBe('true')
    expect(h.state.upserts[0]).toMatchObject({ locked: true, pending: { from: '2031-12', locked: false } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this change' }))
    await waitFor(() => expect(cache.getPlan()?.pending).toBeNull())
  })

  it('while a save over a waiting change is armed, the one note says what the second tap does, and the waiting lines step aside', async () => {
    const waiting = plan({ cap: 2700, pending: { from: '2031-12', cap: 3200, goal: 700 } })
    cache.setPlan(waiting)
    h.state.row = cloudRow(waiting)
    open()
    await shown()
    const LOCKED = 'Locked. Tightening applies now. Loosening starts on the 1st of next month.'
    expect(said()).toEqual([LOCKED, 'The budget rises to $3,200 on Dec 1.', 'The goal drops to $700 on Dec 1.'])
    typeIn(budget(), '3000')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(said()).toEqual(['The budget rises to $3,000 on Dec 1, not $3,200.'])
    expect(screen.queryByRole('button', { name: 'Cancel this change' })).toBeNull()
    // Typing again disarms: the waiting lines are back until the next first tap.
    typeIn(budget(), '2600')
    expect(said()).toEqual([LOCKED, 'The budget rises to $3,200 on Dec 1.', 'The goal drops to $700 on Dec 1.'])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(said()).toEqual(['The budget drops to $2,600 now, and the raise to $3,200 is cancelled. Raising it again waits for the 1st of next month.'])
    await wait()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(cache.getPlan()).toMatchObject({ cap: 2600, pending: { from: '2031-12', goal: 700 } }))
    await waitFor(() => expect(said()).toEqual([LOCKED, 'The goal drops to $700 on Dec 1.']))
    expect(screen.getByRole('button', { name: 'Cancel this change' })).toBeTruthy()
  })

  it('shows every pending line', async () => {
    cache.setPlan(plan({ pending: { from: '2032-01', cap: 3500, goal: 700, locked: false } }))
    h.state.row = cloudRow(plan({ pending: { from: '2032-01', cap: 3500, goal: 700, locked: false } }))
    vi.setSystemTime(new Date('2031-12-30T12:00:00'))
    open()
    await shown()
    expect(said()).toEqual([
      'Locked. Tightening applies now. Loosening starts on the 1st of next month.',
      'The budget rises to $3,500 on Jan 1, 2032.',
      'The goal drops to $700 on Jan 1, 2032.',
      'The lock turns off on Jan 1, 2032.',
    ])
  })

  it('an amount too large to keep is not a number, and nothing is armed or sent', async () => {
    open()
    await shown()
    typeIn(goal(), '1e307')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(errors()).toEqual(['Not a number.'])
    expect(screen.queryByRole('button', { name: 'Tap again to save' })).toBeNull()
    expect(sheet().textContent).not.toContain('∞')
    expect(h.state.upserts).toEqual([])
  })

  it('zero is refused before anything is sent', async () => {
    open()
    await shown()
    typeIn(budget(), '0')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(errors()).toEqual(['Enter an amount above $0.'])
    expect(screen.queryByRole('button', { name: 'Tap again to save' })).toBeNull()
    expect(h.state.upserts).toEqual([])
  })

  it("the store's own errors show as they are", async () => {
    open()
    await shown()
    typeIn(budget(), '2800')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await wait()
    h.state.upsertError = { message: 'boom' }
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(errors()).toEqual(['Could not save the plan. Try again.']))
    // What was typed is still there for another try.
    expect(budget().value).toBe('2800')
  })

  it('says when category budgets add up to more than the budget', async () => {
    await db.categories.bulkAdd([
      { id: 1, name: 'Groceries', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 2000, sortOrder: 0, updatedAt: 0 },
      { id: 2, name: 'Dining', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 1350, sortOrder: 1, updatedAt: 0 },
    ])
    open()
    await shown()
    await waitFor(() => expect(said()).toContain('Category budgets add up to $350 more than this budget. Lower them in Categories.'))
  })

  it('the session ended elsewhere: the group still shows from the kept plan, and a save says to sign in', async () => {
    h.state.session = null
    h.state.email = null
    open()
    await shown()
    expect(lock().getAttribute('aria-checked')).toBe('true')
    typeIn(budget(), '2800')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await wait()
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to save' }))
    await waitFor(() => expect(errors()).toEqual(['Sign in to change the plan.']))
    expect(cache.getPlan()).toEqual(plan())
  })

  it('a plan changed on another device is taken in when the group opens', async () => {
    h.state.row = cloudRow(plan({ cap: 2500, updatedAt: at(NOW) }))
    open()
    await shown()
    await waitFor(() => expect(budget().value).toBe('$2,500'))
  })
})

describe('with the lock off and amounts kept', () => {
  it('shows them, the switch off and the Off note', async () => {
    const offPlan = plan({ locked: false, since: null })
    h.state.row = cloudRow(offPlan)
    cache.setPlan(offPlan)
    open()
    await shown()
    expect([goal().value, budget().value]).toEqual(['$800', '$3,000'])
    expect(lock().getAttribute('aria-checked')).toBe('false')
    expect(said()[0]).toMatch(/^Off\./)
  })
})
