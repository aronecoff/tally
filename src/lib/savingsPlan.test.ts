/**
 * The savings plan's rules: what a plan is, what is in force on a day, whether
 * budgets fit, how a change is taken, and the scoreboard. Every amount is
 * invented (a 3,000 budget, an 800 goal).
 */
import { describe, expect, it } from 'vitest'
import type { Category } from '../db/db'
import {
  budgetFit, budgetsTotal, capInForce, changePlan, checkBudgets, planOn, planToSave, readPlan, scoreboard,
  type PlanChange, type SavingsPlan, type ScoreRow,
} from './savingsPlan'

const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({
  goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 5, ...extra,
})
const off = (extra: Partial<SavingsPlan> = {}) => plan({ locked: false, since: null, ...extra })

const cat = (id: number, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name: `Cat ${id}`, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})

describe('readPlan', () => {
  it('accepts a whole plan and ignores keys it does not know', () => {
    expect(readPlan({ ...plan(), extra: 1 })).toEqual(plan())
    expect(readPlan(off())).toEqual(off())
  })

  it('rounds amounts to cents', () => {
    expect(readPlan({ ...plan(), goal: 800.004, cap: 2999.996 })).toMatchObject({ goal: 800, cap: 3000 })
  })

  it.each([
    ['nothing', null],
    ['text', 'plan'],
    ['a locked plan with no month', { ...plan(), since: null }],
    ['a locked plan with no goal', { ...plan(), goal: 0 }],
    ['a locked plan with no budget', { ...plan(), cap: 0 }],
    ['a negative amount', { ...off(), cap: -1 }],
    ['an amount that is not a number', { ...off(), goal: NaN }],
    ['an amount as text', { ...off(), goal: '800' }],
    ['an amount too large for its cents to count exactly', { ...plan(), goal: 1e15 }],
    ['a month that is not one', { ...plan(), since: '2031-13' }],
    ['a lock that is not yes or no', { ...plan(), locked: 'yes' }],
  ])('rejects %s', (_what, raw) => {
    expect(readPlan(raw)).toBeNull()
  })

  it.each([
    ['no month', { cap: 3500 }],
    ['a month that is not one', { from: '2031-5', cap: 3500 }],
    ['a month and nothing asked for', { from: '2031-05' }],
    ['a budget as text', { from: '2031-05', cap: '3500' }],
    ['the lock turned on', { from: '2031-05', locked: true }],
    ['a list', [1, 2]],
    ['text', 'soon'],
  ])('a damaged pending change (%s) is lost and the lock stays', (_what, pending) => {
    expect(readPlan({ ...plan(), pending })).toEqual(plan())
  })

  it('keeps the budgets earlier months had, in month order, and drops an entry that is not well formed', () => {
    const raw = { ...plan(), pastCaps: [{ until: '2031-08', cap: 3200 }, { until: '2031-06', cap: 3000.004 }, { until: '2031-13', cap: 1 }, { until: '2031-09', cap: -1 }, 'x'] }
    expect(readPlan(raw)?.pastCaps).toEqual([{ until: '2031-06', cap: 3000 }, { until: '2031-08', cap: 3200 }])
    expect(readPlan({ ...plan(), pastCaps: 'soon' })).toEqual(plan())
    expect(readPlan({ ...off(), pastCaps: [{ until: '2031-06', cap: 3000 }] })).toEqual(off())
  })

  it('a pending change with one good field and one bad keeps the good one', () => {
    expect(readPlan({ ...plan(), pending: { from: '2031-05', cap: 'x', goal: 700.004 } })?.pending).toEqual({ from: '2031-05', goal: 700 })
    expect(readPlan({ ...plan(), pending: { from: '2031-05', cap: 3500, locked: false, more: 1 } })?.pending).toEqual({ from: '2031-05', cap: 3500, locked: false })
  })
})

describe('planOn', () => {
  it('no plan stays no plan, and a plan with nothing pending is the same object', () => {
    expect(planOn(null, '2031-04-10')).toBeNull()
    const p = plan()
    expect(planOn(p, '2031-04-10')).toBe(p)
  })

  it('a pending change is not in force on the last day of the month, and is on the 1st', () => {
    const p = plan({ pending: { from: '2031-05', cap: 3500, goal: 700 } })
    expect(planOn(p, '2031-04-30')).toBe(p)
    expect(planOn(p, '2031-05-01')).toEqual(plan({ cap: 3500, goal: 700, pastCaps: [{ until: '2031-05', cap: 3000 }] }))
  })

  it('a raise landing keeps the budget the months before it had, oldest first', () => {
    const first = planOn(plan({ pending: { from: '2031-05', cap: 3500 } }), '2031-05-01')!
    expect(first.pastCaps).toEqual([{ until: '2031-05', cap: 3000 }])
    const second = planOn({ ...first, cap: 3200, pending: { from: '2031-08', cap: 3600 } }, '2031-08-01')!
    expect(second).toMatchObject({ cap: 3600, pastCaps: [{ until: '2031-05', cap: 3000 }, { until: '2031-08', cap: 3200 }] })
  })

  it('keeps nothing for a raise that lands on the first month counted, or for a lower goal alone', () => {
    // Locked mid-April, counting from May: no month before May is counted.
    expect(planOn(plan({ since: '2031-05', pending: { from: '2031-05', cap: 3500 } }), '2031-05-01')).not.toHaveProperty('pastCaps')
    expect(planOn(plan({ pending: { from: '2031-05', goal: 700 } }), '2031-05-01')).not.toHaveProperty('pastCaps')
  })

  it('an unlock landing forgets the budgets months had, with the month it counted from', () => {
    const p = plan({ pastCaps: [{ until: '2031-05', cap: 2800 }], pending: { from: '2031-06', locked: false } })
    expect(planOn(p, '2031-06-01')).toEqual(off())
  })

  it('across a year end', () => {
    const p = plan({ since: '2031-12', pending: { from: '2032-01', cap: 3500 } })
    expect(planOn(p, '2031-12-31')?.cap).toBe(3000)
    expect(planOn(p, '2032-01-01')?.cap).toBe(3500)
  })

  it('an unlock landing clears the month it counted from', () => {
    const p = plan({ pending: { from: '2031-05', locked: false } })
    expect(planOn(p, '2031-05-01')).toEqual(off())
  })

  it('folding twice gives the same plan', () => {
    const once = planOn(plan({ pending: { from: '2031-05', cap: 3500 } }), '2031-06-02')
    expect(planOn(once, '2031-06-02')).toBe(once)
  })
})

describe('capInForce', () => {
  it('is nothing with no plan and with the lock off', () => {
    expect(capInForce(null, '2031-04-10')).toBeNull()
    expect(capInForce(off(), '2031-04-10')).toBeNull()
  })

  it('is the budget when locked', () => {
    expect(capInForce(plan(), '2031-04-10')).toBe(3000)
  })

  it('a pending raise is not the budget until the 1st, and is on the 1st with no write', () => {
    const p = plan({ pending: { from: '2031-05', cap: 3500 } })
    expect(capInForce(p, '2031-04-30')).toBe(3000)
    expect(capInForce(p, '2031-05-01')).toBe(3500)
    expect(p.cap).toBe(3000)
  })

  it('a pending unlock takes the budget out of force on the 1st', () => {
    expect(capInForce(plan({ pending: { from: '2031-05', locked: false } }), '2031-05-01')).toBeNull()
  })
})

describe('changePlan', () => {
  const ok = (p: SavingsPlan | null, change: PlanChange, today = '2031-04-10') => {
    const r = changePlan(p, change, today)
    if (!r.ok) throw new Error(r.message)
    return r.plan
  }
  const refused = (p: SavingsPlan | null, change: PlanChange, today = '2031-04-10') => {
    const r = changePlan(p, change, today)
    return r.ok ? null : r.message
  }

  it('with no plan, or the lock off, every field applies at once', () => {
    expect(ok(null, { goal: 800, cap: 3000 })).toMatchObject({ goal: 800, cap: 3000, locked: false, since: null, pending: null })
    expect(ok(off(), { cap: 5000, goal: 100 })).toMatchObject({ goal: 100, cap: 5000, locked: false, pending: null })
    expect(ok(off(), { cap: 0 })).toMatchObject({ cap: 0 })
  })

  it('the lock on the 1st counts this month, and on the 2nd counts the next', () => {
    expect(ok(off(), { locked: true }, '2031-04-01')).toMatchObject({ locked: true, since: '2031-04', pending: null })
    expect(ok(off(), { locked: true }, '2031-04-02')).toMatchObject({ locked: true, since: '2031-05' })
    expect(ok(null, { goal: 800, cap: 3000, locked: true }, '2031-12-31')).toMatchObject({ locked: true, since: '2032-01' })
  })

  it('locking with an amount missing is refused', () => {
    expect(refused(null, { locked: true })).toBe('Enter both amounts first.')
    expect(refused(off({ goal: 0 }), { locked: true })).toBe('Enter both amounts first.')
    expect(refused(off(), { cap: 0, locked: true })).toBe('Enter both amounts first.')
  })

  it('locked: a lower budget applies at once', () => {
    expect(ok(plan(), { cap: 2800 })).toEqual(plan({ cap: 2800 }))
  })

  it('locked: a higher budget waits for the 1st of next month', () => {
    expect(ok(plan(), { cap: 3500 })).toEqual(plan({ pending: { from: '2031-05', cap: 3500 } }))
  })

  it('locked: a higher goal applies at once', () => {
    expect(ok(plan(), { goal: 900 })).toEqual(plan({ goal: 900 }))
  })

  it('locked: a lower goal waits', () => {
    expect(ok(plan(), { goal: 700 })).toEqual(plan({ pending: { from: '2031-05', goal: 700 } }))
  })

  it('locked: the lock off waits', () => {
    expect(ok(plan(), { locked: false })).toEqual(plan({ pending: { from: '2031-05', locked: false } }))
  })

  it('locked: the same value as now, or the lock on, changes nothing', () => {
    expect(ok(plan(), { cap: 3000, goal: 800, locked: true })).toEqual(plan())
    const waiting = plan({ pending: { from: '2031-05', cap: 3500 } })
    expect(ok(waiting, { cap: 3000 })).toEqual(waiting)
  })

  it('locked: an amount of zero or less is refused', () => {
    expect(refused(plan(), { cap: 0 })).toBe('Enter an amount above $0.')
    expect(refused(plan(), { goal: -5 })).toBe('Enter an amount above $0.')
    expect(refused(plan(), { cap: Infinity })).toBe('Enter an amount above $0.')
  })

  it('an amount that is not a number is refused, locked or not', () => {
    expect(refused(off(), { cap: NaN })).toBe('Enter an amount above $0.')
    expect(refused(off(), { goal: -1 })).toBe('Enter an amount above $0.')
  })

  it('cancel takes back whatever is pending', () => {
    expect(ok(plan({ pending: { from: '2031-05', cap: 3500, goal: 700, locked: false } }), { cancel: true })).toEqual(plan())
    expect(refused(null, { cancel: true })).toBe('There is no change to cancel.')
  })

  it('on Dec 31 a loosening is dated next January', () => {
    expect(ok(plan({ since: '2031-10' }), { cap: 3500 }, '2031-12-31').pending).toEqual({ from: '2032-01', cap: 3500 })
  })

  it('two loosenings in one month share a date, and the latest for a field wins', () => {
    const first = ok(plan(), { cap: 3500 }, '2031-04-03')
    const second = ok(first, { goal: 700 }, '2031-04-28')
    expect(second.pending).toEqual({ from: '2031-05', cap: 3500, goal: 700 })
    expect(ok(second, { cap: 3200 }, '2031-04-29').pending).toEqual({ from: '2031-05', cap: 3200, goal: 700 })
  })

  it('a lower budget after a pending raise leaves nothing pending, not a month alone', () => {
    const raised = ok(plan(), { cap: 3500 })
    expect(ok(raised, { cap: 2800 })).toEqual(plan({ cap: 2800 }))
    const lowered = ok(plan(), { goal: 700 })
    expect(ok(lowered, { goal: 900 })).toEqual(plan({ goal: 900 }))
  })

  it('a tightening keeps the other field pending', () => {
    const both = plan({ pending: { from: '2031-05', cap: 3500, goal: 700 } })
    expect(ok(both, { cap: 2800 })).toEqual(plan({ cap: 2800, pending: { from: '2031-05', goal: 700 } }))
  })

  it('amounts come back rounded to cents', () => {
    expect(ok(off(), { cap: 3000.005, goal: 799.999 })).toMatchObject({ cap: 3000.01, goal: 800 })
    expect(ok(plan(), { cap: 3500.004 }).pending).toEqual({ from: '2031-05', cap: 3500 })
  })

  it('keeps the stamp it was given: the store sets the new one', () => {
    expect(ok(plan({ updatedAt: 77 }), { cap: 2800 }).updatedAt).toBe(77)
  })

  it('an amount too large to keep is refused, locked or not, so nothing it returns is lost on the way to storage', () => {
    expect(refused(plan(), { goal: 1e307 })).toBe('Enter an amount above $0.')
    expect(refused(plan(), { cap: 1e15 })).toBe('Enter an amount above $0.')
    expect(refused(off(), { cap: 1e307, goal: 800, locked: true })).toBe('Enter an amount above $0.')
    // The largest amount whose cents still count exactly is kept.
    expect(ok(plan(), { goal: 90_000_000_000_000 }).goal).toBe(90_000_000_000_000)
  })

  const CHANGES: PlanChange[] = [
    { cap: 2800 }, { cap: 3500 }, { goal: 900 }, { goal: 700 }, { locked: false }, { locked: true }, { cap: 3000 }, { cancel: true },
    { cap: 3500, goal: 700, locked: false }, { cap: 2800.005, goal: 900.001 }, { goal: 1e307 }, { cap: 1e15 }, { goal: 90_000_000_000_000 },
  ]

  it('turning the lock on starts with no earlier budgets, and a change while locked keeps them', () => {
    const past = { pastCaps: [{ until: '2031-03', cap: 2800 }] }
    expect(ok(plan(past), { cap: 2900 })).toEqual(plan({ ...past, cap: 2900 }))
    expect(ok(off(past), { locked: true }, '2031-04-01')).not.toHaveProperty('pastCaps')
    expect(ok(off(past), { cap: 2900 })).not.toHaveProperty('pastCaps')
  })

  it('round trip: whatever it returns reads back unchanged, one request after another', () => {
    const landed = planOn(plan({ since: '2031-02', pending: { from: '2031-04', cap: 3500 } }), '2031-04-10')
    for (const start of [null, off(), plan(), plan({ pending: { from: '2031-05', cap: 3500 } }), landed]) {
      for (const a of CHANGES) {
        const first = changePlan(start, a, '2031-04-10')
        if (!first.ok) continue
        expect(readPlan(JSON.parse(JSON.stringify(first.plan)))).toEqual(first.plan)
        for (const b of CHANGES) {
          const second = changePlan(first.plan, b, '2031-04-20')
          if (second.ok) expect(readPlan(JSON.parse(JSON.stringify(second.plan)))).toEqual(second.plan)
        }
      }
    }
  })
})

describe('planToSave', () => {
  // Two devices a day apart around midnight on the last day of a month: one
  // already on the 1st, one still on the 30th. Nothing it writes may be in force
  // early on the one still behind.
  const WEST = '2031-11-30'
  const EAST = '2031-12-01'
  const save = (stored: SavingsPlan | null, change: PlanChange, today: string) => {
    const r = planToSave(stored, change, today)
    if (!r.ok) throw new Error(r.message)
    return r.plan
  }
  const raise = save(plan({ since: '2031-10' }), { cap: 3500 }, WEST)
  const unlock = save(plan({ since: '2031-10' }), { locked: false }, WEST)

  it('a raise asked on the 30th and a save on the 1st: the device still on the 30th keeps the old budget and sees the raise waiting', () => {
    const written = save(raise, { goal: 900 }, EAST)
    expect(capInForce(written, WEST)).toBe(3000)
    expect(planOn(written, WEST)).toMatchObject({ cap: 3000, goal: 900, pending: { from: '2031-12', cap: 3500 } })
    expect(capInForce(written, EAST)).toBe(3500)
    expect(planOn(written, EAST)).toMatchObject({ cap: 3500, goal: 900, pending: null, pastCaps: [{ until: '2031-12', cap: 3000 }] })
  })

  it('an unlock asked on the 30th and a save on the 1st: the device still on the 30th stays locked', () => {
    const written = save(unlock, { goal: 900 }, EAST)
    expect(capInForce(written, WEST)).toBe(3000)
    expect(planOn(written, WEST)?.pending).toEqual({ from: '2031-12', locked: false })
    expect(capInForce(written, EAST)).toBeNull()
  })

  it('a tightening on the 1st reaches the device still on the 30th as far as it goes below what it had', () => {
    // Under the old budget: in force everywhere at once.
    expect(capInForce(save(raise, { cap: 2500 }, EAST), WEST)).toBe(2500)
    // Between the old budget and the raise: the raise is only smaller.
    const between = save(raise, { cap: 3200 }, EAST)
    expect(planOn(between, WEST)).toMatchObject({ cap: 3000, pending: { from: '2031-12', cap: 3200 } })
    expect(capInForce(between, EAST)).toBe(3200)
  })

  it('on the 1st and the 2nd, the device that saves reads exactly what the change made of the plan in force', () => {
    const starts = [
      raise, unlock,
      save(plan({ since: '2031-10' }), { goal: 700 }, WEST),
      save(plan({ since: '2031-10' }), { cap: 3500, goal: 700, locked: false }, WEST),
      save(plan({ since: '2031-12' }), { cap: 3500 }, WEST),
    ]
    const changes: PlanChange[] = [{ cap: 2500 }, { cap: 3200 }, { cap: 3500 }, { goal: 900 }, { goal: 750 }, { cancel: true }, { cap: 3200, goal: 900 }]
    for (const today of [EAST, '2031-12-02']) {
      for (const stored of starts) {
        for (const change of changes) {
          const asked = changePlan(planOn(stored, today), change, today)
          if (!asked.ok) continue
          const written = save(stored, change, today)
          expect(planOn(written, today)).toEqual(asked.plan)
          expect(readPlan(JSON.parse(JSON.stringify(written)))).toEqual(written)
          // And never looser on the device still on the 30th than the plan it held,
          // unless the save asked for a new loosening (the next test).
          if (asked.plan.pending) continue
          const west = planOn(written, WEST)!
          const held = planOn(stored, WEST)!
          expect(west.locked).toBe(true)
          expect(west.cap).toBeLessThanOrEqual(held.cap)
          expect(west.goal).toBeGreaterThanOrEqual(held.goal)
        }
      }
    }
  })

  it('from the 3rd, when no date on earth is still in the month before, a save folds the change in as before', () => {
    expect(planToSave(raise, { goal: 900 }, '2031-12-03')).toEqual(changePlan(planOn(raise, '2031-12-03'), { goal: 900 }, '2031-12-03'))
    expect(save(raise, { goal: 900 }, '2031-12-03').pending).toBeNull()
  })

  it('a new loosening on the 1st takes the waiting place for next month', () => {
    const written = save(raise, { goal: 700 }, EAST)
    expect(written).toMatchObject({ cap: 3500, goal: 800, pending: { from: '2032-01', goal: 700 } })
  })

  it('a lock turned on again over an unlock that came in today starts afresh, so it is folded in at once', () => {
    const relock = { goal: 800, cap: 2800, locked: true }
    expect(planToSave(unlock, relock, EAST)).toEqual(changePlan(planOn(unlock, EAST), relock, EAST))
    expect(save(unlock, relock, EAST)).toMatchObject({ locked: true, since: '2031-12', cap: 2800, pending: null })
  })

  it('before anything has landed it is changePlan', () => {
    for (const change of [{ cap: 2500 }, { cap: 4000 }, { goal: 900 }, { cancel: true }] as PlanChange[]) {
      expect(planToSave(raise, change, WEST)).toEqual(changePlan(raise, change, WEST))
    }
    expect(planToSave(null, { goal: 800, cap: 3000, locked: true }, EAST)).toEqual(changePlan(null, { goal: 800, cap: 3000, locked: true }, EAST))
  })
})

describe('budgetsTotal', () => {
  it('leaves out income and deleted categories', () => {
    expect(budgetsTotal([cat(1, 100), cat(2, 50, { kind: 'income' }), cat(3, 25, { deleted: true })])).toBe(100)
  })

  it('9.99 and 20.00 make 29.99 exactly', () => {
    expect(budgetsTotal([cat(1, 9.99), cat(2, 20)])).toBe(29.99)
  })
})

describe('budgetFit', () => {
  const cats = [cat(1, 2000), cat(2, 750.25)]

  it('is nothing with no budget in force', () => {
    expect(budgetFit(cats, null)).toBeNull()
  })

  it('equal, under and over, to the cent', () => {
    expect(budgetFit(cats, 2750.25)).toEqual({ cap: 2750.25, assigned: 2750.25, unassigned: 0, over: 0 })
    expect(budgetFit(cats, 3000)).toEqual({ cap: 3000, assigned: 2750.25, unassigned: 249.75, over: 0 })
    expect(budgetFit(cats, 2750.24)).toEqual({ cap: 2750.24, assigned: 2750.25, unassigned: 0, over: 0.01 })
  })
})

describe('checkBudgets', () => {
  const cats = [cat(1, 2000, { name: 'Rent' }), cat(2, 750, { name: 'Dining' }), cat(9, 0, { kind: 'income', name: 'Salary' })]
  const to = (id: number, monthlyBudget: number) => [{ id, monthlyBudget }]

  it('with no budget in force anything passes', () => {
    expect(checkBudgets(cats, to(2, 1e9), null)).toEqual({ ok: true })
  })

  it('a raise into the room passes, and so does one to exactly the budget', () => {
    expect(checkBudgets(cats, to(2, 900), 3000)).toEqual({ ok: true })
    expect(checkBudgets(cats, to(2, 1000), 3000)).toEqual({ ok: true })
  })

  it('one cent past it is refused, and the line says the most it can be', () => {
    expect(checkBudgets(cats, to(2, 1000.01), 3000)).toEqual({
      ok: false,
      message: 'Your budget is locked at $3,000 a month, so Dining can be $1,000 at most. Lower another category first to go higher.',
    })
  })

  it('with all of it assigned, the line says so', () => {
    expect(checkBudgets(cats, to(2, 800), 2750)).toEqual({
      ok: false,
      message: 'Your budget is locked at $2,750 a month and all of it is assigned. Lower another category first.',
    })
  })

  it('already over: a lower amount passes though still over, and a higher one is refused', () => {
    expect(checkBudgets(cats, to(2, 700), 2500)).toEqual({ ok: true })
    expect(checkBudgets(cats, to(2, 751), 2500)).toEqual({
      ok: false,
      message: 'Category budgets already add up to $250 more than your locked $2,500 budget. Lower one first.',
    })
  })

  it('two changes that net to no more pass', () => {
    expect(checkBudgets(cats, [{ id: 1, monthlyBudget: 1900 }, { id: 2, monthlyBudget: 850 }], 2750)).toEqual({ ok: true })
  })

  it('an income category and a deleted one do not count', () => {
    expect(checkBudgets(cats, to(9, 5000), 2750)).toEqual({ ok: true })
    expect(checkBudgets([...cats, cat(4, 0, { deleted: true })], to(4, 5000), 2750)).toEqual({ ok: true })
  })

  it('a new category can take only what is unassigned', () => {
    const more = [...cats, cat(5, 0, { name: 'Pets' })]
    expect(checkBudgets(more, to(5, 250), 3000)).toEqual({ ok: true })
    expect(checkBudgets(more, to(5, 251), 3000)).toMatchObject({ ok: false, message: expect.stringContaining('so Pets can be $250 at most') })
  })

  it('odd amounts: a huge one is refused and a negative one counts as none', () => {
    expect(checkBudgets(cats, to(2, 1e9), 3000).ok).toBe(false)
    expect(checkBudgets(cats, to(2, Infinity), 3000).ok).toBe(false)
    expect(checkBudgets(cats, to(2, -5), 3000)).toEqual({ ok: true })
  })
})

describe('scoreboard', () => {
  let n = 0
  const row = (date: string, amount: number, type = 'expense', extra: Partial<ScoreRow> = {}): ScoreRow => ({ date, amount, type, ...extra, ...{ id: n++ } })
  // The lock counts from April. Today is in July, so April, May and June are whole.
  const p = plan({ since: '2031-04' })
  const rows = [
    row('2031-03-20', 999), // before the lock counts
    row('2031-04-01', 2000), row('2031-04-15', 500), row('2031-04-28', 3400, 'income'),
    row('2031-05-03', 3000), row('2031-05-20', 100.5), row('2031-05-25', 3400, 'income'),
    row('2031-06-02', 2600), row('2031-06-09', -100), row('2031-06-11', 77, 'expense', { deleted: true }), row('2031-06-28', 3400, 'income'),
    row('2031-07-01', 2000), // the live month
    row('2031-08-01', 1200), // dated ahead
  ]

  it('is nothing without a locked plan', () => {
    expect(scoreboard(null, rows, '2031-07-10')).toBeNull()
    expect(scoreboard(off(), rows, '2031-07-10')).toBeNull()
    expect(scoreboard(plan({ pending: { from: '2031-07', locked: false } }), rows, '2031-07-10')).toBeNull()
  })

  it('counts whole months from the first one to last month, oldest first', () => {
    const s = scoreboard(p, rows, '2031-07-10')!
    expect(s.counted).toEqual([
      { month: '2031-04', income: 3400, spending: 2500, purchases: 2 },
      { month: '2031-05', income: 3400, spending: 3100.5, purchases: 2 },
      { month: '2031-06', income: 3400, spending: 2500, purchases: 1 },
    ])
    expect(s).toMatchObject({ goal: 800, cap: 3000, since: '2031-04', liveCounts: true })
  })

  it('the average is income minus spending per month, to the cent, set against the goal', () => {
    const s = scoreboard(p, rows, '2031-07-10')!
    // 900 + 299.50 + 900 = 2,099.50 over 3 months
    expect(s.saved).toBe(699.83)
    expect(s.gap).toBe(-100.17)
  })

  it('the live month and a row dated ahead are never counted', () => {
    const s = scoreboard(p, rows, '2031-07-31')!
    expect(s.counted.map((m) => m.month)).toEqual(['2031-04', '2031-05', '2031-06'])
    expect(scoreboard(p, rows, '2031-06-30')!.counted.map((m) => m.month)).toEqual(['2031-04', '2031-05'])
  })

  it('a refund comes off spending and is not a purchase; a deleted row is not there', () => {
    const june = scoreboard(p, rows, '2031-07-10')!.counted[2]
    expect(june).toEqual({ month: '2031-06', income: 3400, spending: 2500, purchases: 1 })
  })

  it('a month with no rows is listed with zeros and counts in the average', () => {
    const s = scoreboard(p, [row('2031-04-10', 400), row('2031-04-12', 1000, 'income')], '2031-06-05')!
    expect(s.counted).toEqual([
      { month: '2031-04', income: 1000, spending: 400, purchases: 1 },
      { month: '2031-05', income: 0, spending: 0, purchases: 0 },
    ])
    expect(s.saved).toBe(300)
  })

  it('a negative average', () => {
    const s = scoreboard(p, [row('2031-04-10', 4000), row('2031-04-12', 1000, 'income')], '2031-05-05')!
    expect(s.saved).toBe(-3000)
    expect(s.gap).toBe(-3800)
  })

  it('with nothing counted yet there is no average', () => {
    expect(scoreboard(p, rows, '2031-04-20')).toMatchObject({ counted: [], saved: null, gap: null, inside: 0, liveCounts: true })
  })

  it('while the month the lock was turned on in is still running, it will not count', () => {
    expect(scoreboard(plan({ since: '2031-05' }), rows, '2031-04-20')).toMatchObject({ counted: [], saved: null, liveCounts: false })
  })

  describe('inside the budget', () => {
    const month = (spent: number[], income = 0) => [...spent.map((a) => row('2031-04-10', a)), ...(income ? [row('2031-04-20', income, 'income')] : [])]

    it('a month that spent exactly the budget is inside, and one cent more is not', () => {
      expect(scoreboard(p, month([2999.99, 0.01]), '2031-05-02')!.inside).toBe(1)
      expect(scoreboard(p, month([3000, 0.01]), '2031-05-02')!.inside).toBe(0)
    })

    it('a refund that brings spending back under the budget makes it inside', () => {
      expect(scoreboard(p, month([3100, -150]), '2031-05-02')!.inside).toBe(1)
    })

    it('income plays no part', () => {
      expect(scoreboard(p, month([2000]), '2031-05-02')!.inside).toBe(1)
      expect(scoreboard(p, month([3500], 9000), '2031-05-02')!.inside).toBe(0)
    })

    it('follows the budget in force today', () => {
      expect(scoreboard(plan({ cap: 3600 }), month([3500]), '2031-05-02')!.inside).toBe(1)
      expect(scoreboard(plan({ cap: 3400 }), month([3500]), '2031-05-02')!.inside).toBe(0)
    })

    it('a raise never reaches back: a month that went over stays over once the raise lands', () => {
      const raised = plan({ since: '2031-04', pending: { from: '2031-06', cap: 3600 } })
      const rows = [...month([3500]), row('2031-06-10', 3500)]
      expect(scoreboard(raised, rows, '2031-05-31')!.inside).toBe(0)
      // On the 1st the raise is in force. April went over the 3,000 it had; an empty May is inside.
      expect(scoreboard(raised, rows, '2031-06-01')).toMatchObject({ cap: 3600, inside: 1 })
      // June spent 3,500 inside the 3,600 it had.
      expect(scoreboard(raised, rows, '2031-07-02')).toMatchObject({ cap: 3600, inside: 2 })
      // And so it stays once a save has written the landed plan.
      const written = readPlan(JSON.parse(JSON.stringify(changePlan(planOn(raised, '2031-07-02'), { goal: 900 }, '2031-07-02'))).plan)
      expect(scoreboard(written, rows, '2031-07-02')).toMatchObject({ cap: 3600, inside: 2 })
    })

    it('counts the months that did, out of the three', () => {
      expect(scoreboard(p, rows, '2031-07-10')!.inside).toBe(2)
    })
  })
})
