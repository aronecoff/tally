/**
 * Shared row state and status copy, so Home and Budget say the same thing about
 * the same category. This file composes figures that already exist; it adds
 * no new maths. The state thresholds are a verbatim copy of Dashboard's.
 */
import { money } from './format'

// ---- Glossary: one word per figure, on every tab --------------------------
export const INCOME = 'Income'
export const SPENDING = 'Spending'
export const SAVED = 'Saved'
export const OVERSPENT = 'Overspent'
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
  if (s.state === 'over') return { text: `${money(s.spent - s.limit)} over`, tone: 'over' }
  if (s.state === 'pace' && s.canProject) {
    return { text: `~${money(s.projected, { approx: true })} ${BY_MONTH_END}`, tone: 'near' }
  }
  if (s.state === 'near') return { text: `Only ${money(s.limit - s.spent)} left`, tone: 'near' }
  if (s.fixed && cents(s.spent) === cents(s.limit)) return { text: 'Paid', tone: 'muted' }
  return { text: `${money(s.limit - s.spent, { trim: true })} left`, tone: 'muted' }
}
