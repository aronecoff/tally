/**
 * The savings plan's words, exactly as each screen says them. The figures are
 * invented (a 3,000 budget, an 800 goal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as copy from './copy'
import {
  budgetFitNote, budgetRefusal, budgetsTooMuch, goalTail, lockedBudgetLine, partsText, planArmLock, planAverage, planCounting,
  planGoalNote, planInside, planLine, planLiveNote, planOverNote, planPartial, planPendingLines, planSaveLines,
} from './copy'
import type { Fit, SavingsPlan, ScoreMonth } from './savingsPlan'

const fit = (assigned: number, cap = 3000): Fit => ({ cap, assigned, unassigned: Math.max(0, cap - assigned), over: Math.max(0, assigned - cap) })
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-11', pending: null, updatedAt: 1, ...extra })
/** A scoreboard as Home's line reads it: `months` whole months, `inside` of them inside the budget. */
const score = (saved: number | null, gap: number | null, months = saved == null ? 0 : 3, inside = 0) => ({
  goal: 800, saved, gap, inside, counted: Array.from({ length: months }, (): ScoreMonth => ({ month: '2031-08', income: 0, spending: 0, purchases: 0 })),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2031-11-12T12:00:00'))
})
afterEach(() => vi.useRealTimers())

describe('how far the average is from the goal', () => {
  it('above, on and short of the goal', () => {
    expect(goalTail(60)).toBe('$60 above goal')
    expect(goalTail(0)).toBe('on goal')
    expect(goalTail(0.004)).toBe('on goal')
    expect(goalTail(-50)).toBe('$50 short of goal')
    expect(goalTail(-100.17)).toBe('$100.17 short of goal')
  })
})

describe("Home's line", () => {
  it('each state, with its tail', () => {
    expect(planLine(score(860, 60), 'December')).toEqual({ text: 'Saved $860 a month on average · $60 above goal', head: 'Saved $860 a month on average', tail: '$60 above goal', over: false })
    expect(planLine(score(800, 0), 'December')).toEqual({ text: 'Saved $800 a month on average · on goal', head: 'Saved $800 a month on average', tail: 'on goal', over: false })
    expect(planLine(score(750, -50, 3, 2), 'December')).toEqual({ text: 'Saved $750 a month on average · $50 short of goal', head: 'Saved $750 a month on average', tail: '$50 short of goal', over: false })
    expect(planLine(score(0, -800), 'December')).toEqual({ text: 'Saved $0 a month on average · $800 short of goal', head: 'Saved $0 a month on average', tail: '$800 short of goal', over: false })
    expect(planLine(score(-120, -920), 'December')).toEqual({ text: 'Overspent $120 a month on average · $920 short of goal', head: 'Overspent $120 a month on average', tail: '$920 short of goal', over: true })
    expect(planLine(score(null, null), 'December')).toEqual({ text: 'Goal $800 saved a month · counting from December', head: 'Goal $800 saved a month', tail: 'counting from December', over: false })
  })

  it('short of the goal with spending inside the budget every month, it says that: pay, not spending, left the gap', () => {
    expect(planLine(score(700, -100, 2, 2), 'December')).toMatchObject({ text: 'Saved $700 a month on average · inside the budget every month', over: false })
    expect(planLine(score(700, -100, 1, 1), 'December').tail).toBe('inside the budget every month')
    // One month over, or an average below zero: how far from the goal, as before.
    expect(planLine(score(700, -100, 2, 1), 'December').tail).toBe('$100 short of goal')
    expect(planLine(score(-120, -920, 2, 2), 'December')).toMatchObject({ tail: '$920 short of goal', over: true })
    // At or above the goal, the goal is what it says.
    expect(planLine(score(860, 60, 2, 2), 'December').tail).toBe('$60 above goal')
  })

  it('the row for budgets that do not fit', () => {
    expect(copy.BUDGETS_TOO_MUCH).toBe('Category budgets add up to too much')
    expect(budgetsTooMuch(350, 3000)).toEqual([{ fig: '$350' }, ' more than your ', { fig: '$3,000' }, ' budget'])
    expect(partsText(budgetsTooMuch(350, 3000))).toBe('$350 more than your $3,000 budget')
  })
})

describe('Categories and Budget', () => {
  it("the line above the lists", () => {
    expect(partsText(lockedBudgetLine(fit(3000)))).toBe('Your budget is locked at $3,000 a month. All of it is assigned.')
    expect(partsText(lockedBudgetLine(fit(2750)))).toBe('Your budget is locked at $3,000 a month. $250 is unassigned.')
    expect(partsText(lockedBudgetLine(fit(3350)))).toBe('Your budget is locked at $3,000 a month. Category budgets add up to $350 more. Lower one to fit.')
    expect(lockedBudgetLine(fit(2750))).toEqual(['Your budget is locked at ', { fig: '$3,000' }, ' a month. ', { fig: '$250' }, ' is unassigned.'])
  })

  it("Budget's note", () => {
    expect(budgetFitNote(fit(3350))).toBe('Category budgets add up to $350 more than this budget')
    expect(budgetFitNote(fit(2750))).toBe('$250 of this budget is unassigned')
    expect(budgetFitNote(fit(3000))).toBeNull()
  })

  it('a refused budget edit says why and what to do', () => {
    expect(budgetRefusal('Dining', fit(2750), 200)).toBe(
      'Your budget is locked at $3,000 a month, so Dining can be $450 at most. Lower another category first to go higher.',
    )
    expect(budgetRefusal('Dining', fit(3000), 200)).toBe('Your budget is locked at $3,000 a month and all of it is assigned. Lower another category first.')
    expect(budgetRefusal('Dining', fit(3350), 200)).toBe('Category budgets already add up to $350 more than your locked $3,000 budget. Lower one first.')
  })
})

describe('Insights', () => {
  it('the header', () => {
    expect(copy.PLAN_TITLE).toBe('Savings plan')
    expect(planGoalNote(800)).toBe('goal $800 a month')
  })

  it('the average row', () => {
    expect(planAverage(860, 60, 3)).toEqual({ name: 'Saved a month, on average', fig: '$860', tone: 'pos', sub: '3 whole months · $60 above goal' })
    expect(planAverage(800, 0, 2)).toEqual({ name: 'Saved a month, on average', fig: '$800', tone: 'pos', sub: '2 whole months · on goal' })
    expect(planAverage(750, -50, 3)).toEqual({ name: 'Saved a month, on average', fig: '$750', tone: '', sub: '3 whole months · $50 short of goal' })
    expect(planAverage(-120, -920, 1)).toEqual({ name: 'Overspent a month, on average', fig: '$120', tone: 'over', sub: '1 whole month · $920 short of goal' })
  })

  it('the inside-the-budget sentence', () => {
    expect(planInside(2, 3, 'December')).toBe('Spending was inside the budget in 2 of 3 months.')
    expect(planInside(1, 1, 'December')).toBe('Spending was inside the budget in December.')
    expect(planInside(0, 1, 'December')).toBe('Spending went over the budget in December.')
    expect(planInside(0, 0, 'December')).toBeNull()
  })

  it('the partial sentence', () => {
    expect(planPartial(0)).toBeNull()
    expect(planPartial(1)).toBe('1 month has partial data.')
    expect(planPartial(2)).toBe('2 months have partial data.')
  })

  it('the live month, and before any month is counted', () => {
    expect(planLiveNote('November')).toBe('November is not counted until it ends.')
    expect(planCounting(true, 'November', 'November')).toBe('November is the first month counted. The average shows when it ends.')
    expect(planCounting(false, 'November', 'December')).toBe('Counting starts with December, the first whole month. The average shows when it ends.')
  })
})

describe('Settings', () => {
  it('the labels and notes', () => {
    expect(copy.PLAN_GOAL_FIELD).toBe('Save each month')
    expect(copy.PLAN_CAP_FIELD).toBe('Monthly budget')
    expect(copy.PLAN_LOCK).toBe('Lock the budget')
    expect(copy.PLAN_OFF_NOTE).toBe('Off. Turn the lock on and Home counts spending against this budget, and category budgets can only add up to it.')
    expect(copy.PLAN_LOCKED_NOTE).toBe('Locked. Tightening applies now. Loosening starts on the 1st of next month.')
    expect(planOverNote(350)).toBe('Category budgets add up to $350 more than this budget. Lower them in Categories.')
    expect(planArmLock(3000, 800)).toBe(
      'Tap again to lock the budget at $3,000 a month with a goal of $800. Turning it off again waits for the 1st of next month.',
    )
    expect(copy.PLAN_BOTH).toBe('Enter both amounts first.')
    expect(copy.PLAN_ABOVE_ZERO).toBe('Enter an amount above $0.')
    expect(copy.PLAN_NOT_A_NUMBER).toBe('Not a number.')
    expect(copy.PLAN_CANCEL).toBe('Cancel this change')
    expect(copy.PLAN_SAVE).toBe('Save')
    expect(copy.PLAN_SAVE_AGAIN).toBe('Tap again to save')
    expect(copy.PLAN_STAYS_LOCKED).toBe('Your savings plan stays locked as it is.')
  })

  it('what a save while locked will do', () => {
    expect(planSaveLines(plan(), plan({ cap: 2800 }), '2031-11-12')).toEqual(['The budget drops to $2,800 now. Raising it again waits for the 1st of next month.'])
    expect(planSaveLines(plan(), plan({ goal: 900 }), '2031-11-12')).toEqual(['The goal rises to $900 now. Lowering it again waits for the 1st of next month.'])
    expect(planSaveLines(plan(), plan({ pending: { from: '2031-12', cap: 3500 } }), '2031-11-12')).toEqual(['The budget rises to $3,500 on Dec 1.'])
    expect(planSaveLines(plan(), plan({ pending: { from: '2031-12', goal: 700 } }), '2031-11-12')).toEqual(['The goal drops to $700 on Dec 1.'])
    expect(planSaveLines(plan(), plan({ cap: 2800, pending: { from: '2031-12', goal: 700 } }), '2031-11-12')).toEqual([
      'The budget drops to $2,800 now. Raising it again waits for the 1st of next month.',
      'The goal drops to $700 on Dec 1.',
    ])
    expect(planSaveLines(plan(), plan(), '2031-11-12')).toEqual([])
  })

  it('a save over a waiting change names the one it replaces or cancels', () => {
    const waiting = plan({ cap: 2700, pending: { from: '2031-12', cap: 3200, goal: 700 } })
    expect(planSaveLines(waiting, plan({ cap: 2700, pending: { from: '2031-12', cap: 3000, goal: 700 } }), '2031-11-12')).toEqual([
      'The budget rises to $3,000 on Dec 1, not $3,200.',
    ])
    expect(planSaveLines(waiting, plan({ cap: 2600, pending: { from: '2031-12', goal: 700 } }), '2031-11-12')).toEqual([
      'The budget drops to $2,600 now, and the raise to $3,200 is cancelled. Raising it again waits for the 1st of next month.',
    ])
    expect(planSaveLines(waiting, plan({ cap: 2700, goal: 900, pending: { from: '2031-12', cap: 3200 } }), '2031-11-12')).toEqual([
      'The goal rises to $900 now, and the drop to $700 is cancelled. Lowering it again waits for the 1st of next month.',
    ])
    expect(planSaveLines(waiting, plan({ cap: 2700, pending: { from: '2031-12', cap: 3200, goal: 650 } }), '2031-11-12')).toEqual([
      'The goal drops to $650 on Dec 1, not $700.',
    ])
  })

  it('the pending lines, with the year when it is another one', () => {
    expect(planPendingLines({ from: '2031-12', cap: 3500, goal: 700, locked: false }, '2031-11-12')).toEqual([
      'The budget rises to $3,500 on Dec 1.',
      'The goal drops to $700 on Dec 1.',
      'The lock turns off on Dec 1.',
    ])
    expect(planPendingLines({ from: '2032-01', locked: false }, '2031-12-31')).toEqual(['The lock turns off on Jan 1, 2032.'])
    expect(planPendingLines(null, '2031-12-31')).toEqual([])
  })
})

describe('the words as a whole', () => {
  it('never say limit, and hold no em dash', () => {
    const said = [
      ...(Object.values(copy).filter((v) => typeof v === 'string') as string[]),
      planLine(score(-120, -920), 'December').text,
      planLine(score(null, null), 'December').text,
      planLine(score(700, -100, 2, 2), 'December').text,
      partsText(budgetsTooMuch(350, 3000)),
      ...[fit(3000), fit(2750), fit(3350)].flatMap((f) => [partsText(lockedBudgetLine(f)), budgetFitNote(f) ?? '', budgetRefusal('Dining', f, 200)]),
      planGoalNote(800), planAverage(-120, -920, 1).sub, planAverage(-120, -920, 1).name, planInside(2, 3, 'x') ?? '', planInside(0, 1, 'x') ?? '',
      planPartial(2) ?? '', planLiveNote('x'), planCounting(true, 'x', 'y'), planCounting(false, 'x', 'y'), planOverNote(350), planArmLock(3000, 800),
      ...planPendingLines({ from: '2031-12', cap: 3500, goal: 700, locked: false }, '2031-11-12'),
      ...planSaveLines(plan(), plan({ cap: 2800, goal: 900 }), '2031-11-12'),
      ...planSaveLines(plan({ pending: { from: '2031-12', cap: 3200, goal: 700 } }), plan({ cap: 2800, goal: 900 }), '2031-11-12'),
      ...planSaveLines(plan({ pending: { from: '2031-12', cap: 3200, goal: 700 } }), plan({ pending: { from: '2031-12', cap: 3100, goal: 650 } }), '2031-11-12'),
    ]
    expect(said.length).toBeGreaterThan(30)
    for (const line of said) expect(line).not.toMatch(/limit|—/i)
  })
})
