/**
 * Has this month's pay landed? The one place Home, Budget and Insights decide
 * whether the live month is still before payday, so the three can never
 * disagree.
 *
 * Before payday a month has only spent, and reading it as 'Overspent' (in red,
 * equal to the whole month's spending) said every month that something was
 * wrong. That used to key on income being exactly $0, so a small credit before
 * payday (interest on the 7th, a cashback) switched it off and the red figure
 * came back for the days until pay arrived.
 *
 * Pay has landed when either:
 *  - an income row sits in the salary category this month (by its built-in
 *    key, so a renamed Salary still counts; by name for rows from before keys);
 *  - or this month's income is at least PAY_SHARE of last month's, for pay
 *    filed somewhere else. With no income last month to compare, any income
 *    counts, as it did before.
 * A month that has not spent more than it took in is never waiting: its net is
 * a real 'Saved'. Callers ask only for the live month; a finished month that
 * earned nothing really did spend more than it took in.
 */
import { shiftMonth } from './dates'
import { isSalaryCategory } from './categorize'

/** This share of last month's income landed means pay has. */
export const PAY_SHARE = 0.25

/** The fields awaitingPay reads (a Transaction has them all). */
export interface PayRow {
  date: string
  amount: number
  type: string
  categoryId: number | null
  deleted?: boolean
}

interface PayCategory {
  id?: number
  name: string
  kind: string
  key?: string
  deleted?: boolean
}

/**
 * True while `month` has spent more than it took in and its pay has not landed.
 * `rows` are the month's rows; `history` any rows that include last month's.
 */
export function awaitingPay(
  month: string,
  rows: readonly PayRow[],
  history: readonly PayRow[],
  categories: readonly PayCategory[],
): boolean {
  const salary = new Set<number>()
  for (const c of categories) if (c.id != null && !c.deleted && isSalaryCategory(c)) salary.add(c.id)

  // Whole cents, as every screen sums them.
  let incomeC = 0
  let spendC = 0
  let paid = false
  for (const t of rows) {
    if (t.deleted || !t.date.startsWith(month)) continue
    const c = Math.round(t.amount * 100)
    if (t.type === 'income') {
      incomeC += c
      if (c > 0 && t.categoryId != null && salary.has(t.categoryId)) paid = true
    } else {
      spendC += c
    }
  }
  if (spendC <= incomeC || paid) return false
  if (incomeC === 0) return true

  const last = shiftMonth(month, -1)
  let lastC = 0
  for (const t of history) {
    if (!t.deleted && t.type === 'income' && t.date.startsWith(last)) lastC += Math.round(t.amount * 100)
  }
  return lastC > 0 && incomeC < PAY_SHARE * lastC
}
