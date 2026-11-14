// @vitest-environment jsdom
/**
 * Tell Tally's budget command under a locked savings plan: refused at the
 * preview, checked again at Apply, and at Undo. The amounts are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db, type Category } from '../db/db'
import { BudgetRefused } from './budgetWrite'
import { applyPlan, undoPlan } from './commandRun'
import { parseCommand, planCommand, type Plan } from './commands'
import { setPlan } from './planCache'
import type { SavingsPlan } from './savingsPlan'

const TODAY = '2031-04-10'
const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 1, ...extra,
})
// 2,750 assigned.
const CATS = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 750), cat(9, 'Salary', 0, { kind: 'income' })]
const locked: SavingsPlan = { goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 1 }

type OkPlan = Extract<Plan, { ok: true }>
const live = () => db.categories.filter((c) => !c.deleted).toArray()
async function planFor(words: string, opts: { plan?: SavingsPlan | null } = {}): Promise<Plan> {
  const cats = await live()
  const parsed = parseCommand(words, cats, TODAY)
  if (!parsed.ok) throw new Error(parsed.message)
  return planCommand(parsed.command, [], cats, { today: TODAY, rules: false, ...opts })
}
const okPlan = async (words: string): Promise<OkPlan> => {
  const p = await planFor(words)
  if (!p.ok) throw new Error(p.message)
  return p
}
const dining = async () => (await db.categories.get(2))!

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd(CATS)
})
afterEach(() => {
  setPlan(null)
  vi.useRealTimers()
})

describe('planning a budget command', () => {
  it('is refused at the preview when it does not fit, with the line', async () => {
    setPlan(locked)
    expect(await planFor('set Dining budget to 1200')).toEqual({
      ok: false,
      message: 'Your budget is locked at $3,000 a month, so Dining can be $1,000 at most. Lower another category first to go higher.',
    })
  })

  it('plans a raise that fits, and a lower amount, as before', async () => {
    setPlan(locked)
    expect(await planFor('set Dining budget to 1000')).toMatchObject({ ok: true, title: 'Set Dining budget to $1,000', budget: { before: 750, after: 1000 } })
    expect(await planFor('set Dining budget to 600')).toMatchObject({ ok: true, title: 'Set Dining budget to $600', budget: { before: 750, after: 600 } })
  })

  it('takes the plan it is handed, and with none plans anything', async () => {
    expect(await planFor('set Dining budget to 1200', { plan: locked })).toMatchObject({ ok: false })
    setPlan(locked)
    expect(await planFor('set Dining budget to 1200', { plan: null })).toMatchObject({ ok: true })
  })

  it('a pending raise of the budget is not room yet', async () => {
    setPlan({ ...locked, pending: { from: '2031-05', cap: 3600 } })
    expect(await planFor('set Dining budget to 1200')).toMatchObject({ ok: false })
  })
})

describe('Apply', () => {
  it('is checked again: when the room went after the preview it throws the line and writes nothing', async () => {
    setPlan(locked)
    const plan = await okPlan('set Dining budget to 1000')
    await db.categories.update(1, { monthlyBudget: 2250 }) // a sync used the room
    const refused = await applyPlan(plan).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(BudgetRefused)
    expect((refused as Error).message).toBe('Your budget is locked at $3,000 a month and all of it is assigned. Lower another category first.')
    expect(await dining()).toMatchObject({ monthlyBudget: 750, updatedAt: 1 })
  })

  it('writes one that fits', async () => {
    setPlan(locked)
    await applyPlan(await okPlan('set Dining budget to 1000'))
    expect((await dining()).monthlyBudget).toBe(1000)
  })
})

describe('Undo', () => {
  it('that would go past the budget throws, writes nothing, and can be tried again', async () => {
    setPlan(locked)
    const applied = await applyPlan(await okPlan('set Dining budget to 400')) // 350 freed
    await db.categories.update(1, { monthlyBudget: 2500 }) // and used elsewhere
    const refused = await undoPlan(applied).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(BudgetRefused)
    expect((refused as Error).message).toBe('Your budget is locked at $3,000 a month, so Dining can be $500 at most. Lower another category first to go higher.')
    expect((await dining()).monthlyBudget).toBe(400)
    // Room again: the same Undo now lands.
    await db.categories.update(1, { monthlyBudget: 2000 })
    await undoPlan(applied)
    expect((await dining()).monthlyBudget).toBe(750)
  })

  it('after the budget was lowered, an undo that raises is refused too', async () => {
    setPlan(locked)
    const applied = await applyPlan(await okPlan('set Dining budget to 400'))
    setPlan({ ...locked, cap: 2500 })
    await expect(undoPlan(applied)).rejects.toBeInstanceOf(BudgetRefused)
    expect((await dining()).monthlyBudget).toBe(400)
  })
})

describe('with no plan', () => {
  it('Apply and Undo write exactly what they did: the budget and one stamp', async () => {
    const plan = await okPlan('set Dining budget to 99999')
    vi.setSystemTime(new Date(`${TODAY}T12:00:05`))
    const applied = await applyPlan(plan)
    expect(applied).toEqual({ rows: [], budget: { id: 2, before: 750 } })
    expect(await dining()).toMatchObject({ monthlyBudget: 99999, updatedAt: new Date(`${TODAY}T12:00:05`).getTime() })
    vi.setSystemTime(new Date(`${TODAY}T12:00:09`))
    await undoPlan(applied)
    expect(await dining()).toMatchObject({ monthlyBudget: 750, updatedAt: new Date(`${TODAY}T12:00:09`).getTime() })
  })
})
