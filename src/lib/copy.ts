/**
 * Shared row state and status copy, so Home and Budget say the same thing about
 * the same category. This file composes figures that already exist; it adds
 * no new maths. The state thresholds are a verbatim copy of Dashboard's.
 */
import { dayLabel } from './dates'
import { money } from './format'
import type { Fit, PendingChange, SavingsPlan, Score } from './savingsPlan'

// ---- Glossary: one word per figure, on every tab --------------------------
export const INCOME = 'Income'
export const SPENDING = 'Spending'
export const SAVED = 'Saved'
export const OVERSPENT = 'Overspent'
/** The current month before any income has landed: not 'Overspent'. */
export const NO_INCOME_YET = 'No income yet'
/** The current month before its pay has landed, with a small credit in already
 *  (interest, a cashback): not 'Overspent', and not 'No income yet' beside it. */
export const NO_PAY_YET = 'No pay yet'
/** The before-payday word (lib/payday.awaitingPay decides when it shows). */
export const beforePayday = (income: number) => (income > 0 ? NO_PAY_YET : NO_INCOME_YET)
/** Always 'budget', never 'limit'. */
export const BUDGET = 'budget'
export const NO_BUDGET = 'No budget'
export const BY_MONTH_END = 'by month-end'
/** The only destructive verb. */
export const DELETE = 'Delete'

export const GLOSSARY = {
  income: INCOME,
  spending: SPENDING,
  saved: SAVED,
  overspent: OVERSPENT,
  budget: BUDGET,
  noBudget: NO_BUDGET,
  byMonthEnd: BY_MONTH_END,
  delete: DELETE,
} as const

// ---- Row state ------------------------------------------------------------
export type RowState = 'ok' | 'near' | 'pace' | 'over' | 'none'

export interface RowStateInput {
  spent: number
  limit: number
  projected: number
  /** Fixed monthly bill (rent, subscriptions, health): landing at budget is expected, not 'near'. */
  fixed?: boolean
  /** Only the live month can be 'pace' (past months never extrapolate). */
  isCurrent: boolean
}

/** Budget row state. VERBATIM from Dashboard's stateOf(): do not tune here. */
export function rowState({ spent, limit, projected, fixed = false, isCurrent }: RowStateInput): RowState {
  if (limit <= 0) return 'none'
  if (spent > limit) return 'over'
  if (isCurrent && projected > limit) return 'pace'
  // "close" warns you're approaching a cap mid-month; a fixed bill landing
  // at its budgeted amount is the expected outcome, not a warning.
  if (!fixed && spent >= limit * 0.85) return 'near'
  return 'ok'
}

// ---- Status line ----------------------------------------------------------
/** muted = text-3; near/over = the state text tokens. */
export type StatusTone = 'muted' | 'near' | 'over'

export interface BudgetStatusInput {
  name: string
  spent: number
  limit: number
  projected: number
  canProject: boolean
  state: RowState
  isUncategorized: boolean
  txnCount: number
  pendingCount: number
  fixed: boolean
}

const cents = (n: number) => Math.round(n * 100)

/** The one status line for a budget row, shared by Home and Budget. */
export function budgetStatus(s: BudgetStatusInput): { text: string; tone: StatusTone } {
  if (s.isUncategorized) {
    const posted = s.txnCount - s.pendingCount
    // Pending charges are never routed into categorizing: a pin on a pending row can double-count once it posts.
    if (posted > 0) return { text: `${posted} to categorize`, tone: 'muted' }
    return { text: `${s.pendingCount} pending · categorize once posted`, tone: 'muted' }
  }
  if (s.state === 'none') {
    return { text: `${NO_BUDGET} · ${s.txnCount} ${s.txnCount === 1 ? 'transaction' : 'transactions'}`, tone: 'muted' }
  }
  // Refunds bigger than the purchases: the whole budget is left, and what came
  // back is said, instead of '$1,326 left' of a $1,150 budget.
  if (s.spent < 0) return { text: `${money(s.limit, { trim: true })} left · ${money(-s.spent)} back`, tone: 'muted' }
  if (s.state === 'over') return { text: `${money(s.spent - s.limit)} over`, tone: 'over' }
  if (s.state === 'pace' && s.canProject) {
    return { text: `~${money(s.projected, { approx: true })} ${BY_MONTH_END}`, tone: 'near' }
  }
  if (s.state === 'near') return { text: `Only ${money(s.limit - s.spent)} left`, tone: 'near' }
  if (s.fixed && cents(s.spent) === cents(s.limit)) return { text: 'Paid', tone: 'muted' }
  return { text: `${money(s.limit - s.spent, { trim: true })} left`, tone: 'muted' }
}

// ---- Savings plan ----------------------------------------------------------
// Every word the plan says, as functions of figures that already exist
// (lib/savingsPlan.ts), so a screen composes nothing and two screens that show
// one figure say the same thing about it.

/** A line with figures in it: a screen draws each `fig` as a figure. */
export type Part = string | { fig: string }
/** The same line as plain words. */
export const partsText = (parts: readonly Part[]): string => parts.map((p) => (typeof p === 'string' ? p : p.fig)).join('')

/** Exact to the cent, with '.00' dropped. */
const amt = (n: number) => money(n, { trim: true })

/** How far the average is from the goal. Home's line and Insights' row both end with it. */
export function goalTail(gap: number): string {
  const c = cents(gap)
  if (c === 0) return 'on goal'
  return c > 0 ? `${amt(gap)} above goal` : `${amt(-gap)} short of goal`
}

/**
 * Home's one line about the plan: the average over whole months and how far it
 * is from the goal. `over` only when the average is below zero: short of the
 * goal but above zero is the ordinary state of a month with fewer deposits.
 * Then, if spending stayed inside the budget in every month counted, the line
 * says that instead of the gap: what was asked was done, and the hero above
 * says On track. Insights keeps the gap beside the same count.
 * `text` is the whole line, `head` and `tail` its two sides of the dot, so a
 * screen can keep each side whole where the line has to wrap.
 */
export function planLine(
  s: Pick<Score, 'goal' | 'saved' | 'gap' | 'inside' | 'counted'>,
  fromMonth: string,
): { text: string; head: string; tail: string; over: boolean } {
  const line = (head: string, tail: string, over: boolean) => ({ text: `${head} · ${tail}`, head, tail, over })
  if (s.saved == null || s.gap == null) return line(`Goal ${amt(s.goal)} saved a month`, `counting from ${fromMonth}`, false)
  const over = cents(s.saved) < 0
  const keptToBudget = !over && cents(s.gap) < 0 && s.inside === s.counted.length
  return line(`${over ? OVERSPENT : SAVED} ${amt(Math.abs(s.saved))} a month on average`, keptToBudget ? 'inside the budget every month' : goalTail(s.gap), over)
}

/** Home's row while category budgets add up to more than the locked budget. */
export const BUDGETS_TOO_MUCH = 'Category budgets add up to too much'
export const budgetsTooMuch = (over: number, cap: number): Part[] => [{ fig: amt(over) }, ' more than your ', { fig: amt(cap) }, ' budget']

/** Categories' line above the lists, while a budget is locked. */
export function lockedBudgetLine(fit: Fit): Part[] {
  const head: Part[] = ['Your budget is locked at ', { fig: amt(fit.cap) }, ' a month. ']
  if (fit.over > 0) return [...head, 'Category budgets add up to ', { fig: amt(fit.over) }, ' more. Lower one to fit.']
  if (fit.unassigned > 0) return [...head, { fig: amt(fit.unassigned) }, ' is unassigned.']
  return [...head, 'All of it is assigned.']
}

/** Budget's note under the hero. No full stop, as the note beside it has none. */
export function budgetFitNote(fit: Fit): string | null {
  if (fit.over > 0) return `Category budgets add up to ${amt(fit.over)} more than this budget`
  if (fit.unassigned > 0) return `${amt(fit.unassigned)} of this budget is unassigned`
  return null
}

/**
 * A refused budget edit, for Categories and for Tell Tally's preview, Apply and
 * Undo: why, and what to do. `current` is the category's budget now, so the most
 * it can be is that plus what is unassigned.
 */
export function budgetRefusal(name: string, fit: Fit, current: number): string {
  if (fit.over > 0) return `Category budgets already add up to ${amt(fit.over)} more than your locked ${amt(fit.cap)} budget. Lower one first.`
  if (fit.unassigned <= 0) return `Your budget is locked at ${amt(fit.cap)} a month and all of it is assigned. Lower another category first.`
  const most = (cents(current) + cents(fit.unassigned)) / 100
  return `Your budget is locked at ${amt(fit.cap)} a month, so ${name} can be ${amt(most)} at most. Lower another category first to go higher.`
}

// Insights' section.
export const PLAN_TITLE = 'Savings plan'
export const planGoalNote = (goal: number): string => `goal ${amt(goal)} a month`

/** The average row. Green at or above the goal, red only below zero. */
export function planAverage(saved: number, gap: number, months: number): { name: string; fig: string; tone: 'pos' | 'over' | ''; sub: string } {
  const over = cents(saved) < 0
  return {
    name: `${over ? OVERSPENT : SAVED} a month, on average`,
    fig: amt(Math.abs(saved)),
    tone: over ? 'over' : cents(gap) >= 0 ? 'pos' : '',
    sub: `${months} whole ${months === 1 ? 'month' : 'months'} · ${goalTail(gap)}`,
  }
}

/** Did spending stay inside the budget? The part a person controls, whatever pay did. */
export function planInside(inside: number, months: number, monthName: string): string | null {
  if (months <= 0) return null
  if (months === 1) return inside === 1 ? `Spending was inside the budget in ${monthName}.` : `Spending went over the budget in ${monthName}.`
  return `Spending was inside the budget in ${inside} of ${months} months.`
}

export const planPartial = (months: number): string | null =>
  months <= 0 ? null : months === 1 ? '1 month has partial data.' : `${months} months have partial data.`

export const planLiveNote = (monthName: string): string => `${monthName} is not counted until it ends.`

/** Before any whole month is counted. */
export const planCounting = (liveCounts: boolean, liveName: string, sinceName: string): string =>
  liveCounts
    ? `${liveName} is the first month counted. The average shows when it ends.`
    : `Counting starts with ${sinceName}, the first whole month. The average shows when it ends.`

// Settings' group.
export const PLAN_GOAL_FIELD = 'Save each month'
export const PLAN_CAP_FIELD = 'Monthly budget'
export const PLAN_LOCK = 'Lock the budget'
export const PLAN_OFF_NOTE = 'Off. Turn the lock on and Home counts spending against this budget, and category budgets can only add up to it.'
/** How the lock works, short: the lines for a pending change and for each first tap give the amounts and dates. */
export const PLAN_LOCKED_NOTE = 'Locked. Tightening applies now. Loosening starts on the 1st of next month.'
export const planOverNote = (over: number): string => `Category budgets add up to ${amt(over)} more than this budget. Lower them in Categories.`
/** After the first tap on the lock: both amounts, because a slip here takes a month to fix. */
export const planArmLock = (cap: number, goal: number): string =>
  `Tap again to lock the budget at ${amt(cap)} a month with a goal of ${amt(goal)}. Turning it off again waits for the 1st of next month.`
export const PLAN_BOTH = 'Enter both amounts first.'
export const PLAN_ABOVE_ZERO = 'Enter an amount above $0.'
export const PLAN_NOT_A_NUMBER = 'Not a number.'
export const PLAN_NO_CANCEL = 'There is no change to cancel.'
export const PLAN_CANCEL = 'Cancel this change'
export const PLAN_SAVE = 'Save'
export const PLAN_SAVE_AGAIN = 'Tap again to save'
/** Said on a restore that replaces the ledger while a plan is locked. */
export const PLAN_STAYS_LOCKED = 'Your savings plan stays locked as it is.'

/** "Dec 1", or "Jan 1, 2032" when that is another year than today's. */
const firstOf = (month: string, today: string) => dayLabel(`${month}-01`, Number(today.slice(0, 4)))

/**
 * What is waiting, one line for each field, for as long as it is pending. With
 * `was`, the change it takes the place of, a line says what it replaces.
 */
export function planPendingLines(pending: PendingChange | null, today: string, was?: PendingChange | null): string[] {
  if (!pending) return []
  const day = firstOf(pending.from, today)
  const not = (old: number | undefined) => (old === undefined ? '' : `, not ${amt(old)}`)
  const lines: string[] = []
  if (pending.cap !== undefined) lines.push(`The budget rises to ${amt(pending.cap)} on ${day}${not(was?.cap)}.`)
  if (pending.goal !== undefined) lines.push(`The goal drops to ${amt(pending.goal)} on ${day}${not(was?.goal)}.`)
  if (pending.locked === false) lines.push(`The lock turns off on ${day}.`)
  return lines
}

/**
 * What a save while locked will do, from the plan before and the plan a dry run
 * of the change gave. What applies now comes first, then what waits, and each
 * line names the waiting change it cancels or replaces, so the first tap shows
 * all the second will do.
 */
export function planSaveLines(before: SavingsPlan, after: SavingsPlan, today: string): string[] {
  const lines: string[] = []
  const was = before.pending
  const will = after.pending
  const cancelled = (what: string, old: number | undefined, now: number | undefined) =>
    old !== undefined && now === undefined ? `, and the ${what} to ${amt(old)} is cancelled` : ''
  if (cents(after.cap) < cents(before.cap))
    lines.push(`The budget drops to ${amt(after.cap)} now${cancelled('raise', was?.cap, will?.cap)}. Raising it again waits for the 1st of next month.`)
  if (cents(after.goal) > cents(before.goal))
    lines.push(`The goal rises to ${amt(after.goal)} now${cancelled('drop', was?.goal, will?.goal)}. Lowering it again waits for the 1st of next month.`)
  if (will) {
    const fresh: PendingChange = { from: will.from }
    if (will.cap !== undefined && will.cap !== was?.cap) fresh.cap = will.cap
    if (will.goal !== undefined && will.goal !== was?.goal) fresh.goal = will.goal
    if (will.locked === false && was?.locked !== false) fresh.locked = false
    lines.push(...planPendingLines(fresh, today, was))
  }
  return lines
}
