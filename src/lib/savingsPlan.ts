/**
 * The savings plan: a goal to save each month, a budget for the month, and a
 * lock on that budget. This file holds its rules and nothing else: no storage,
 * no cloud, no React. Every screen, the command bar, the widget and the alerts
 * take their answer from the functions here, so they cannot disagree.
 *
 * While the plan is locked the month is measured against the plan's own budget
 * (capInForce), never against what the category budgets add up to, and category
 * budgets may not add up to more than it (checkBudgets). Category budgets are
 * only how that budget is split.
 *
 * The lock is a commitment device, not security. Tightening applies at once.
 * Loosening (a higher budget, a lower goal, the lock off) is a request that
 * comes into force on the 1st of the next month, and nothing has to run that
 * day: every reader goes through planOn().
 */
import type { Category } from '../db/db'
import { PLAN_ABOVE_ZERO, PLAN_BOTH, PLAN_NO_CANCEL, budgetRefusal } from './copy'
import { shiftMonth } from './dates'
import { toCents } from './format'

/** A loosening asked for while locked. */
export interface PendingChange {
  /** YYYY-MM. In force from the 1st of this month. */
  from: string
  cap?: number
  goal?: number
  locked?: false
}

/** The budget the counted months before `until` had, kept when a raise landed. */
export interface PastCap {
  /** YYYY-MM: the month the raise landed. */
  until: string
  cap: number
}

export interface SavingsPlan {
  /** What to save each month, in dollars to the cent. */
  goal: number
  /** What may be spent each month, in dollars to the cent. */
  cap: number
  locked: boolean
  /** YYYY-MM: the first month the average counts. Null while the lock is off. */
  since: string | null
  /** A loosening asked for while locked. Null when there is none. */
  pending: PendingChange | null
  /** ms. Last write wins. */
  updatedAt: number
  /**
   * The budgets counted months had before a raise landed, oldest first, so a
   * raise never reaches back to turn a month that went over into one that was
   * inside (scoreboard). Absent while there are none, and always while unlocked.
   */
  pastCaps?: PastCap[]
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v)
/**
 * An amount the plan can hold: a number whose cents count exactly. Larger ones
 * (1e307 rounds to Infinity cents) would not survive storage, and a plan that
 * does not read back is no plan, so every reader and writer asks here.
 */
export const isPlanAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(toCents(v))
const toDollars = (n: number) => toCents(n) / 100

/**
 * A pending change as stored, or null. It can never make a row "not a plan": a
 * field that is not well formed is dropped, and one left asking for nothing is
 * no change at all. So a damaged loosening is lost and the lock stays.
 */
function readPending(raw: unknown): PendingChange | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (!isMonth(p.from)) return null
  const out: PendingChange = { from: p.from }
  if (isPlanAmount(p.cap) && p.cap > 0) out.cap = toDollars(p.cap)
  if (isPlanAmount(p.goal) && p.goal > 0) out.goal = toDollars(p.goal)
  if (p.locked === false) out.locked = false
  return out.cap === undefined && out.goal === undefined && out.locked === undefined ? null : out
}

/** The budgets earlier months had, in month order. An entry that is not well formed is dropped. */
function readPastCaps(raw: unknown): PastCap[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is PastCap => !!p && typeof p === 'object' && isMonth(p.until) && isPlanAmount(p.cap) && p.cap > 0)
    .map((p) => ({ until: p.until, cap: toDollars(p.cap) }))
    .sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0))
}

/**
 * The one validator: for the cached copy, a cloud row (once its stamp is in ms)
 * and a backup's value. Anything that is not a whole plan is no plan.
 */
export function readPlan(raw: unknown): SavingsPlan | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isPlanAmount(r.goal) || r.goal < 0 || !isPlanAmount(r.cap) || r.cap < 0) return null
  if (typeof r.locked !== 'boolean') return null
  if (r.since != null && !isMonth(r.since)) return null
  const goal = toDollars(r.goal)
  const cap = toDollars(r.cap)
  const since = r.since ?? null
  // A locked plan is a whole one: both amounts, and a month to count from.
  if (r.locked && !(goal > 0 && cap > 0 && since)) return null
  const pastCaps = r.locked ? readPastCaps(r.pastCaps) : []
  return {
    goal,
    cap,
    locked: r.locked,
    since,
    pending: r.locked ? readPending(r.pending) : null,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0,
    ...(pastCaps.length ? { pastCaps } : {}),
  }
}

/**
 * The plan as it stands on a day: a pending change is folded in once its month
 * has come. This is how a change "takes effect on the 1st" with no timer and no
 * server job. The stored row is tidied by whichever save comes next.
 */
export function planOn(plan: SavingsPlan | null, today: string): SavingsPlan | null {
  if (!plan?.pending || today.slice(0, 7) < plan.pending.from) return plan
  const { from, cap, goal, locked } = plan.pending
  const { pastCaps, ...rest } = plan
  if (locked === false) return { ...rest, cap: cap ?? plan.cap, goal: goal ?? plan.goal, locked: false, since: null, pending: null }
  // The counted months before a raise keep the budget they had.
  const kept = cap !== undefined && plan.since != null && from > plan.since ? [...(pastCaps ?? []), { until: from, cap: plan.cap }] : pastCaps
  return { ...rest, cap: cap ?? plan.cap, goal: goal ?? plan.goal, pending: null, ...(kept ? { pastCaps: kept } : {}) }
}

/**
 * The budget the month `today` is in is measured against, or null: measure
 * against what the category budgets add up to, as with no plan.
 */
export function capInForce(plan: SavingsPlan | null, today: string): number | null {
  const now = planOn(plan, today)
  return now?.locked ? now.cap : null
}

// ---- Whether budgets fit ----------------------------------------------------
type BudgetCategory = Pick<Category, 'id' | 'name' | 'kind' | 'monthlyBudget' | 'deleted'>

const counts = (c: BudgetCategory) => c.kind === 'expense' && !c.deleted
const budgetCents = (n: number) => (Number.isNaN(n) ? 0 : Math.max(0, toCents(n || 0)))

/** What the live expense categories' budgets add up to, summed in whole cents. */
export function budgetsTotal(categories: readonly BudgetCategory[]): number {
  return categories.reduce((s, c) => (counts(c) ? s + toCents(c.monthlyBudget || 0) : s), 0) / 100
}

export interface Fit {
  cap: number
  /** What the category budgets add up to. */
  assigned: number
  /** The part of the budget no category holds. */
  unassigned: number
  /** How far the category budgets run past the budget. At most one of these two is above zero. */
  over: number
}

/** How the category budgets sit against the budget. Null when none is in force. */
export function budgetFit(categories: readonly BudgetCategory[], cap: number | null): Fit | null {
  if (cap == null) return null
  const capC = toCents(cap)
  const assignedC = toCents(budgetsTotal(categories))
  return { cap, assigned: assignedC / 100, unassigned: Math.max(0, capC - assignedC) / 100, over: Math.max(0, assignedC - capC) / 100 }
}

/**
 * May these budgets be written? `changes` are whole new amounts by category id.
 * The total afterwards must be at most the budget, or at most the total before:
 * when budgets are already over (a restore, an old copy of the app), every edit
 * that lowers the total is allowed, so the way back is never blocked.
 */
export function checkBudgets(
  categories: readonly BudgetCategory[],
  changes: readonly { id: number; monthlyBudget: number }[],
  cap: number | null,
): { ok: true } | { ok: false; message: string } {
  if (cap == null) return { ok: true }
  const asked = new Map(changes.map((c) => [c.id, budgetCents(c.monthlyBudget)]))
  const live = categories.filter(counts)
  const now = (c: BudgetCategory) => toCents(c.monthlyBudget || 0)
  const next = (c: BudgetCategory) => (c.id != null && asked.has(c.id) ? asked.get(c.id)! : now(c))
  const beforeC = live.reduce((s, c) => s + now(c), 0)
  const afterC = live.reduce((s, c) => s + next(c), 0)
  if (afterC <= toCents(cap) || afterC <= beforeC) return { ok: true }
  // The first budget being raised is the one the line is about, with every
  // other change taken as asked, so "at most" is what would in fact fit.
  const raised = live.find((c) => next(c) > now(c))!
  const others = live.map((c) => (c === raised ? c : { ...c, monthlyBudget: next(c) / 100 }))
  return { ok: false, message: budgetRefusal(raised.name, budgetFit(others, cap)!, raised.monthlyBudget || 0) }
}

// ---- Changing the plan --------------------------------------------------------
export type PlanChange = { goal?: number; cap?: number; locked?: boolean } | { cancel: true }

/**
 * What a change makes of the plan. `plan` is the copy of record, already through
 * planOn(). Unlocked, every field applies at once. Locked, a tightening applies
 * at once and a loosening becomes the pending change, dated the 1st of the month
 * after `today`. Each field has at most one request waiting, the latest
 * instruction for a field wins, and one cancel takes back whatever is pending.
 *
 * The plan handed back can always be read again (readPlan): amounts are rounded
 * to cents, and a pending change left asking for nothing is null.
 */
export function changePlan(
  plan: SavingsPlan | null,
  change: PlanChange,
  today: string,
): { ok: true; plan: SavingsPlan } | { ok: false; message: string } {
  const refuse = (message: string) => ({ ok: false as const, message })
  if ('cancel' in change) return plan ? { ok: true, plan: { ...plan, pending: null } } : refuse(PLAN_NO_CANCEL)

  const month = today.slice(0, 7)
  const next: SavingsPlan = plan ? { ...plan } : { goal: 0, cap: 0, locked: false, since: null, pending: null, updatedAt: 0 }
  for (const v of [change.goal, change.cap]) if (v !== undefined && !(isPlanAmount(v) && v >= 0)) return refuse(PLAN_ABOVE_ZERO)
  const goal = change.goal === undefined ? undefined : toDollars(change.goal)
  const cap = change.cap === undefined ? undefined : toDollars(change.cap)

  if (!next.locked) {
    if (goal !== undefined) next.goal = goal
    if (cap !== undefined) next.cap = cap
    next.pending = null
    next.since = null
    delete next.pastCaps
    if (change.locked) {
      if (!(next.goal > 0 && next.cap > 0)) return refuse(PLAN_BOTH)
      next.locked = true
      // Turned on after the 1st, the month is already partly spent under no
      // plan: counting starts with the next one. The budget holds at once.
      next.since = today.slice(8) === '01' ? month : shiftMonth(month, 1)
    }
    return { ok: true, plan: next }
  }

  if ((goal !== undefined && goal <= 0) || (cap !== undefined && cap <= 0)) return refuse(PLAN_ABOVE_ZERO)
  const waiting: PendingChange = { ...(next.pending ?? {}), from: shiftMonth(month, 1) }
  // A request already dated later (this device's clock is behind the one that asked) keeps its date.
  if (next.pending && next.pending.from > waiting.from) waiting.from = next.pending.from
  if (cap !== undefined && cap < next.cap) {
    next.cap = cap
    delete waiting.cap
  } else if (cap !== undefined && cap > next.cap) {
    waiting.cap = cap
  }
  if (goal !== undefined && goal > next.goal) {
    next.goal = goal
    delete waiting.goal
  } else if (goal !== undefined && goal < next.goal) {
    waiting.goal = goal
  }
  if (change.locked === false) waiting.locked = false
  next.pending = waiting.cap === undefined && waiting.goal === undefined && waiting.locked === undefined ? null : waiting
  return { ok: true, plan: next }
}

/**
 * What a save writes: `change` taken on the stored plan as it stands on `today`
 * (changePlan). A pending change comes into force at midnight on the 1st by
 * each device's own date, and local dates on earth can be up to two days apart.
 * So on the 1st and the 2nd, a change that has come into force here may not
 * have on another device yet, and folding it into the row would put it in force
 * there early. Those two days the row keeps it waiting: each amount holds the
 * stricter of what it was and what it now is, and the looser one waits for the
 * month that has come here. Every device then reads the plan right on its own
 * date, and this one reads exactly what changePlan made.
 *
 * Folded in at once all the same: a new loosening, which needs the waiting
 * place for next month, and a lock turned on again over an unlock that came in
 * today, which starts counting afresh. Either can put the change that came in
 * today in force up to a day early on a device still on the day before.
 */
export function planToSave(
  stored: SavingsPlan | null,
  change: PlanChange,
  today: string,
): { ok: true; plan: SavingsPlan } | { ok: false; message: string } {
  const now = planOn(stored, today)
  const next = changePlan(now, change, today)
  const came = stored?.pending
  if (!next.ok || !stored || !came || came.from !== today.slice(0, 7) || today.slice(8) > '02') return next
  const n = next.plan
  if (n.pending || (n.locked && !now!.locked)) return next
  const waiting: PendingChange = { from: came.from }
  const cap = Math.min(stored.cap, n.cap)
  const goal = Math.max(stored.goal, n.goal)
  if (n.cap > cap) waiting.cap = n.cap
  if (n.goal < goal) waiting.goal = n.goal
  if (!n.locked) waiting.locked = false
  const has = waiting.cap !== undefined || waiting.goal !== undefined || waiting.locked !== undefined
  const plan: SavingsPlan = { ...n, cap, goal, locked: true, since: stored.since, pending: has ? waiting : null }
  // A raise still waiting adds the budget the months before it had when it lands (planOn), so the row keeps the list from before.
  const pastCaps = waiting.cap !== undefined ? stored.pastCaps : n.pastCaps
  delete plan.pastCaps
  if (pastCaps?.length) plan.pastCaps = pastCaps
  return { ok: true, plan }
}

// ---- The scoreboard -----------------------------------------------------------
/** The fields the scoreboard reads (a Transaction has them all). */
export interface ScoreRow {
  date: string
  amount: number
  type: string
  deleted?: boolean
}

/** One whole month, as its rows say. */
export interface ScoreMonth {
  /** YYYY-MM */
  month: string
  income: number
  /** Expense rows, net of refunds. */
  spending: number
  /** Expense rows with an amount above zero. A refund is not a purchase. */
  purchases: number
}

export interface Score {
  goal: number
  cap: number
  since: string
  /** The whole months counted, oldest first: `since` up to last month. Empty until the first one ends. */
  counted: ScoreMonth[]
  /** Income minus spending per counted month, on average, to the cent. Null while none is counted. */
  saved: number | null
  /** saved minus goal. Null while none is counted. */
  gap: number | null
  /** How many counted months kept spending at or under the budget they had (see scoreboard). */
  inside: number
  /** The month today is in is at or after `since`, so it will count once it ends. */
  liveCounts: boolean
}

/**
 * The average of income minus spending per whole month since the lock began,
 * set against the goal. Rows are counted as every screen counts them: a refund
 * comes off spending, a pending charge counts, a row belongs to the month it is
 * dated. The live month is never among the months counted, so nothing here can
 * read a month before payday as a failure, and no paycheck, pay cadence or
 * expected income enters anywhere.
 */
export function scoreboard(plan: SavingsPlan | null, rows: readonly ScoreRow[], today: string): Score | null {
  const now = planOn(plan, today)
  if (!now?.locked || !now.since) return null
  const live = today.slice(0, 7)
  const sums = new Map<string, { incomeC: number; spendC: number; purchases: number }>()
  for (let m = now.since; m < live; m = shiftMonth(m, 1)) sums.set(m, { incomeC: 0, spendC: 0, purchases: 0 })
  for (const t of rows) {
    if (t.deleted) continue
    const sum = sums.get(t.date.slice(0, 7))
    if (!sum) continue
    const c = toCents(t.amount)
    if (t.type === 'income') sum.incomeC += c
    else {
      sum.spendC += c
      if (t.amount > 0) sum.purchases++
    }
  }
  // A month is judged against the budget in force today, unless a raise has
  // landed since: then it keeps the budget it had. A raise never reaches back.
  const capC = (month: string) => toCents(now.pastCaps?.find((p) => month < p.until)?.cap ?? now.cap)
  let totalC = 0
  let inside = 0
  const counted: ScoreMonth[] = []
  for (const [month, s] of sums) {
    totalC += s.incomeC - s.spendC
    if (s.spendC <= capC(month)) inside++
    counted.push({ month, income: s.incomeC / 100, spending: s.spendC / 100, purchases: s.purchases })
  }
  const savedC = counted.length ? Math.round(totalC / counted.length) : null
  return {
    goal: now.goal,
    cap: now.cap,
    since: now.since,
    counted,
    saved: savedC == null ? null : savedC / 100,
    gap: savedC == null ? null : (savedC - toCents(now.goal)) / 100,
    inside,
    liveCounts: live >= now.since,
  }
}
