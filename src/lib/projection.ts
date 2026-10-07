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
 * - On the last day (and for past months) the month is in: a fixed budget that
 *   never landed is no longer coming, so the projection is what was spent.
 * - A single flexible row of LUMP_MIN or more (a card bill, a one-off purchase,
 *   a big refund) counts once at face value. Pacing it multiplied a one-off and
 *   turned a month that closed under budget into 'Likely to go over'.
 * - So does every refund, whatever its size: money back does not recur at a
 *   daily rate. A refund on the 1st, paced from day 7, took about 4x itself off
 *   the forecast and hid real overspending behind 'On track'.
 * - And so does a monthly bill in a flexible category (a car payment under
 *   Transport): a merchant that charged about the same once a month before.
 *   Paced from day 7, a bill on the 1st read as about four times itself by
 *   month-end, every month. oneOffRows() picks all three.
 * - A forecast rounds to whole dollars as a whole (one-offs and fixed bills
 *   included); display it with {approx} so it doesn't fake cent precision.
 *   Rounding only the paced part kept the one-offs' cents, so on the last day a
 *   budget that finished $0.30 under read as 'Likely to go over'.
 * - Where nothing is left to forecast (the month is over, too young to pace, or
 *   nothing in it is paced) the figure is exactly what was spent.
 */
import { isFixedCategory } from './categorize'
import { shiftMonth } from './dates'
import { cleanMerchant } from './merchants'

export const PROJECT_MIN_FRACTION = 0.2

/** A single row at least this large (either sign) is a one-off, never paced. */
export const LUMP_MIN = 500
export const isLump = (amount: number) => Math.abs(amount) >= LUMP_MIN

/** How many months before the viewed one a monthly bill is looked for. */
export const BILL_MONTHS = 3
/** A charge within this share of an earlier month's charge is the same bill. */
export const BILL_TOLERANCE = 0.25
/** Days either side of the same day of the month a scheduled bill lands on. */
export const BILL_DAY_SLACK = 3

/** The fields oneOffRows reads (a Transaction has them all). */
export interface OneOffRow {
  date: string
  amount: number
  type: string
  note?: string
  deleted?: boolean
}

const merchantKey = (note: string | undefined) => cleanMerchant(note || '').toLowerCase()
const sameBill = (a: number, b: number) => Math.abs(a - b) <= BILL_TOLERANCE * Math.max(a, b)
/** About the same day of the month: within the slack, or both at its end (a 30- and a 31-day month). */
const sameDay = (a: number, b: number) => Math.abs(a - b) <= BILL_DAY_SLACK || (a >= 28 && b >= 28)

/**
 * The expense rows of `month` that count once at face value instead of at
 * daily pace (each screen sums them per category as its `lump`):
 *  - a single row of LUMP_MIN or more, either sign (isLump);
 *  - every refund (a negative expense);
 *  - a monthly bill: the month's first charge from a merchant (by cleaned name)
 *    that charged once a month, never more, in the BILL_MONTHS months before
 *    `month`, at about this amount (BILL_TOLERANCE) in at least two of them,
 *    or in one of them on about the same day of the month (BILL_DAY_SLACK):
 *    a bank history that starts last month has seen a car payment on the 1st
 *    only once. A merchant seen several times in one month is everyday
 *    spending (a cafe), so it is paced as before.
 * `history` may hold any rows; only the expenses of those earlier months count.
 */
export function oneOffRows<T extends OneOffRow>(rows: readonly T[], history: readonly OneOffRow[], month: string): Set<T> {
  const from = shiftMonth(month, -BILL_MONTHS)
  // Merchant -> month -> that month's charges.
  const charges = new Map<string, Map<string, { amount: number; day: number }[]>>()
  for (const t of history) {
    if (t.deleted || t.type !== 'expense' || !(t.amount > 0)) continue
    const m = t.date.slice(0, 7)
    if (m < from || m >= month) continue
    const key = merchantKey(t.note)
    if (!key) continue
    let byMonth = charges.get(key)
    if (!byMonth) charges.set(key, (byMonth = new Map()))
    const charge = { amount: t.amount, day: Number(t.date.slice(8, 10)) }
    const list = byMonth.get(m)
    if (list) list.push(charge)
    else byMonth.set(m, [charge])
  }
  const isBill = (key: string, amount: number, day: number) => {
    const byMonth = charges.get(key)
    if (!byMonth) return false
    let matches = 0
    let onTheDay = false
    for (const list of byMonth.values()) {
      if (list.length > 1) return false
      if (!sameBill(list[0].amount, amount)) continue
      matches++
      if (sameDay(list[0].day, day)) onTheDay = true
    }
    return matches >= 2 || onTheDay
  }

  const out = new Set<T>()
  const billed = new Set<string>()
  // By date, so the month's FIRST charge of a bill is the one taken once.
  const byDate = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  for (const t of byDate) {
    if (t.deleted || t.type !== 'expense') continue
    if (t.amount < 0 || isLump(t.amount)) {
      out.add(t)
      continue
    }
    if (!(t.amount > 0)) continue
    const key = merchantKey(t.note)
    if (!key || billed.has(key) || !isBill(key, t.amount, Number(t.date.slice(8, 10)))) continue
    billed.add(key)
    out.add(t)
  }
  return out
}

export interface CategorySpend {
  name: string
  spent: number
  budget: number
  /** A fixed monthly bill (the category's flag or built-in key). Unset = decided by the name. */
  fixed?: boolean
  /** The part of `spent` made of one-off rows (oneOffRows). Ignored for fixed bills. */
  lump?: number
}

export interface Projector {
  /** False early in the month, when a pace forecast would be meaningless. */
  canProject: boolean
  /** Raw pace extrapolation (whole dollars). Identity before the threshold. */
  extrapolate: (spent: number) => number
  /** Expected month-end of flexible spend: its one-offs (`lump`) once, the rest at pace.
   *  Whole dollars while it forecasts; exactly `spent` when there is nothing to forecast. */
  flexEnd: (spent: number, lump?: number) => number
  /** Expected month-end for one category (fixed bills don't extrapolate; lumps count once). */
  forCategory: (name: string, spent: number, budget: number, opts?: { fixed?: boolean; lump?: number }) => number
  /** Expected month-end total: known fixed bills + one-off lumps + paced flexible remainder.
   *  `totalSpend` may exceed the categorized rows (e.g. uncategorized spend) —
   *  the excess is treated as flexible, its own lumps passed as `uncatLump`. */
  monthEnd: (cats: CategorySpend[], totalSpend: number, uncatLump?: number) => number
}

const fixedOf = (c: { name: string; fixed?: boolean }) => c.fixed ?? isFixedCategory(c.name)

/** Spend outside fixed bills: what a per-day pace is made of. */
export function flexibleSpend(cats: CategorySpend[], totalSpend: number): number {
  let fixedSpent = 0
  for (const c of cats) if (fixedOf(c)) fixedSpent += c.spent
  return totalSpend - fixedSpent
}

export function paceProjector(dayOfMonth: number, daysInMonth: number): Projector {
  const frac = daysInMonth > 0 ? dayOfMonth / daysInMonth : 1
  const canProject = frac >= PROJECT_MIN_FRACTION
  const extrapolate = (spent: number) => (canProject ? Math.round(spent / frac) : spent)
  // Last day (and past months, which arrive with dayOfMonth = daysInMonth).
  const monthOver = frac >= 1
  const fixedEnd = (spent: number, budget: number) => (monthOver ? spent : Math.max(spent, budget))
  /** Nothing to pace: the month is in, too young to pace, or every row is a one-off. */
  const nothingToPace = (paced: number) => monthOver || !canProject || Math.abs(paced) < 0.005
  const flexEnd = (spent: number, lump = 0) => {
    const paced = spent - lump
    if (nothingToPace(paced)) return spent
    // Rounded as a whole: lump + a rounded remainder kept the lump's cents.
    return Math.round(lump + paced / frac)
  }
  return {
    canProject,
    extrapolate,
    flexEnd,
    forCategory: (name, spent, budget, opts = {}) => {
      if (opts.fixed ?? isFixedCategory(name)) return fixedEnd(spent, budget)
      return flexEnd(spent, opts.lump)
    },
    monthEnd: (cats, totalSpend, uncatLump = 0) => {
      let fixedSpent = 0
      let fixedKnown = 0
      let lumps = uncatLump
      for (const c of cats) {
        if (fixedOf(c)) {
          fixedSpent += c.spent
          fixedKnown += fixedEnd(c.spent, c.budget)
        } else {
          lumps += c.lump ?? 0
        }
      }
      const paced = totalSpend - fixedSpent - lumps
      if (monthOver) return totalSpend
      // Unpaid fixed budgets still to come, on top of what is in (in cents, so
      // no float residue).
      if (nothingToPace(paced)) return Math.round((fixedKnown - fixedSpent + totalSpend) * 100) / 100
      return Math.round(fixedKnown + lumps + paced / frac)
    },
  }
}
