/**
 * Month-end spend projection — the one place the pace math lives.
 * Home and Budget both project from it, so the two screens can never drift.
 *
 * Rules (each one exists because the naive version misled):
 * - No extrapolation before 20% of the month has passed: projecting from day 1
 *   (rent lands on the 1st) forecast 30x the bill.
 * - Fixed monthly bills (rent, subscriptions, health) NEVER extrapolate — the
 *   month-end truth is the bill itself: what's been paid, or the budgeted
 *   amount if it hasn't landed yet. Only flexible spend runs at daily pace.
 * - Extrapolations round to whole dollars; display them with {approx} so they
 *   don't fake cent precision.
 */
import { isFixedCategory } from './categorize'

export const PROJECT_MIN_FRACTION = 0.2

export interface CategorySpend {
  name: string
  spent: number
  budget: number
}

export interface Projector {
  /** False early in the month, when a pace forecast would be meaningless. */
  canProject: boolean
  /** Raw pace extrapolation (whole dollars). Identity before the threshold. */
  extrapolate: (spent: number) => number
  /** Expected month-end for one category (fixed bills don't extrapolate). */
  forCategory: (name: string, spent: number, budget: number) => number
  /** Expected month-end total: known fixed bills + paced flexible remainder.
   *  `totalSpend` may exceed the categorized rows (e.g. uncategorized spend) —
   *  the excess is treated as flexible. */
  monthEnd: (cats: CategorySpend[], totalSpend: number) => number
}

export function paceProjector(dayOfMonth: number, daysInMonth: number): Projector {
  const frac = daysInMonth > 0 ? dayOfMonth / daysInMonth : 1
  const canProject = frac >= PROJECT_MIN_FRACTION
  const extrapolate = (spent: number) => (canProject ? Math.round(spent / frac) : spent)
  return {
    canProject,
    extrapolate,
    forCategory: (name, spent, budget) =>
      isFixedCategory(name) ? Math.max(spent, budget) : extrapolate(spent),
    monthEnd: (cats, totalSpend) => {
      let fixedSpent = 0
      let fixedKnown = 0
      for (const c of cats) {
        if (!isFixedCategory(c.name)) continue
        fixedSpent += c.spent
        fixedKnown += Math.max(c.spent, c.budget)
      }
      return fixedKnown + extrapolate(totalSpend - fixedSpent)
    },
  }
}
