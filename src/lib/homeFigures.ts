import type { Category, Transaction } from '../db/db'
import { isFixed } from './categorize'
import { BY_MONTH_END } from './copy'
import { monthShortLabel, shiftDayISO, shiftMonth } from './dates'
import { money, toCents } from './format'
import { awaitingPay } from './payday'
import { BILL_MONTHS, flexibleSpend, oneOffRows, paceProjector } from './projection'
import { budgetsTotal } from './savingsPlan'

/**
 * The figures behind Home, in one place, so anything else that shows them shows
 * Home's own: the widget (widgetSnapshot.ts) reads these and works nothing out.
 */
export type HomeRow = {
  id: number | null
  name: string
  icon: string
  spent: number
  budget: number
  projected: number
  fixed: boolean
  txnCount: number
  pendingCount: number
}

export interface HomeInput {
  /** The month's rows. Undefined while they load. */
  monthTxns: Transaction[] | undefined
  /** Rows from homeHistoryFrom() on. Undefined while they load. */
  recentTxns: Transaction[] | undefined
  month: string
  cats: Category[]
  daysInMonth: number
  dayOfMonth: number
  /**
   * The savings plan's budget while it is locked (savingsPlan.capInForce). The
   * month is then measured against it, and category budgets are only how it is
   * split. Absent or null: against what the category budgets add up to.
   */
  cap?: number | null
}

const EMPTY: Transaction[] = []

/** Where a date sits in its month. */
export function homeDays(today: string): { dayOfMonth: number; daysInMonth: number } {
  const [yy, mm, dd] = today.split('-').map(Number)
  return { dayOfMonth: dd, daysInMonth: new Date(yy, mm, 0).getDate() }
}

/** How far back recurring bills look. */
export const homeBillsSince = (today: string): string => shiftDayISO(today, -100)

// Recurring bills look back 100 days. The forecast's bill history (oneOffRows)
// needs the BILL_MONTHS whole months before this one, exactly as Budget
// queries them: after about the 9th, 100 days stops short of the first of
// them, and Home took a bill Budget counted once at daily pace.
export function homeHistoryFrom(today: string): string {
  const since = homeBillsSince(today)
  const billsFrom = `${shiftMonth(today.slice(0, 7), -BILL_MONTHS)}-01`
  return billsFrom < since ? billsFrom : since
}

export function homeFigures({ monthTxns, recentTxns, month, cats, daysInMonth, dayOfMonth, cap }: HomeInput) {
  // Summed in whole cents and divided once, so a category that is exactly
  // its budget (or exactly refunded to zero) is exactly that, never
  // '$0.00 over' or '−$0.00' from float residue.
  let incomeC = 0
  let spendC = 0
  const byCatC = new Map<number | null, number>()
  // One-off rows count once, never at daily pace: big rows, refunds and
  // monthly bills (projection.oneOffRows, from the last few months' rows).
  const lumpByCatC = new Map<number | null, number>()
  const once = oneOffRows(monthTxns ?? EMPTY, recentTxns ?? EMPTY, month)
  const countByCat = new Map<number | null, number>()
  const pendingByCat = new Map<number | null, number>()
  const dailyC = new Array(daysInMonth).fill(0)
  for (const t of monthTxns ?? EMPTY) {
    if (t.deleted) continue
    const c = toCents(t.amount)
    if (t.type === 'income') {
      incomeC += c
    } else {
      spendC += c
      byCatC.set(t.categoryId, (byCatC.get(t.categoryId) ?? 0) + c)
      if (once.has(t)) lumpByCatC.set(t.categoryId, (lumpByCatC.get(t.categoryId) ?? 0) + c)
      countByCat.set(t.categoryId, (countByCat.get(t.categoryId) ?? 0) + 1)
      if (t.pending) pendingByCat.set(t.categoryId, (pendingByCat.get(t.categoryId) ?? 0) + 1)
      const day = Number(t.date.slice(8, 10))
      if (day >= 1 && day <= daysInMonth) dailyC[day - 1] += c
    }
  }
  const income = incomeC / 100
  const spend = spendC / 100
  const spentIn = (id: number | null) => (byCatC.get(id) ?? 0) / 100
  const lumpIn = (id: number | null) => (lumpByCatC.get(id) ?? 0) / 100
  const daily = dailyC.map((c: number) => c / 100)
  // All pace math lives in lib/projection.ts (shared with the Budget tab).
  const p = paceProjector(dayOfMonth, daysInMonth)
  const divisor = dayOfMonth > 0 ? dayOfMonth : daysInMonth

  const expenseCats = cats.filter((c) => c.kind === 'expense' && !c.deleted)
  const catSpends = expenseCats.map((c) => ({
    name: c.name,
    spent: spentIn(c.id!),
    budget: c.monthlyBudget || 0,
    fixed: isFixed(c),
    lump: lumpIn(c.id!),
  }))
  const rows: HomeRow[] = expenseCats
    .map((c) => {
      const spent = spentIn(c.id!)
      const budget = c.monthlyBudget || 0
      const fixed = isFixed(c)
      return {
        id: c.id!,
        name: c.name,
        icon: c.icon,
        spent,
        budget,
        projected: p.forCategory(c.name, spent, budget, { fixed, lump: lumpIn(c.id!) }),
        fixed,
        txnCount: countByCat.get(c.id!) ?? 0,
        pendingCount: pendingByCat.get(c.id!) ?? 0,
      }
    })
    // A category with no budget stays while it has rows this month, a net
    // refund included: dropped, the rows no longer added up to Spending.
    .filter((r) => r.budget > 0 || r.spent !== 0 || r.txnCount > 0)
  const uncat = spentIn(null)
  const uncatLump = lumpIn(null)
  // Uncategorized is listed whenever rows sit in it, even when a refund
  // there outweighs the purchases: the purchases still need a category, and
  // this row is Home's way into the sort queue.
  if (uncat !== 0 || (countByCat.get(null) ?? 0) > 0) {
    rows.push({
      id: null,
      name: 'Uncategorized',
      icon: 'tag',
      spent: uncat,
      budget: 0,
      projected: p.forCategory('Uncategorized', uncat, 0, { fixed: false, lump: uncatLump }),
      fixed: false,
      txnCount: countByCat.get(null) ?? 0,
      pendingCount: pendingByCat.get(null) ?? 0,
    })
  }
  rows.sort((a, b) => b.spent - a.spent)

  const totalBudget = cap ?? budgetsTotal(expenseCats)
  const maxDaily = Math.max(1, ...daily)
  // The one-offs outside fixed bills: what the projection takes once.
  const flexLumpC = catSpends.reduce((s, c) => (c.fixed ? s : s + toCents(c.lump)), toCents(uncatLump))
  return {
    income,
    spend,
    net: (incomeC - spendC) / 100,
    daily,
    maxDaily,
    rows,
    totalBudget,
    projectedTotal: p.monthEnd(catSpends, spend, uncatLump),
    canProject: p.canProject,
    // Flexible spending at its daily pace: rent on the 1st made this read
    // ~$913 a day, and a refund or a monthly bill is not a day's spending.
    avgPerDay: Math.round((flexibleSpend(catSpends, spend) - flexLumpC / 100) / divisor),
    // Before payday (lib/payday.ts, shared with Budget and Insights).
    awaitingIncome: awaitingPay(month, monthTxns ?? EMPTY, recentTxns ?? EMPTY, cats),
  }
}

export type HomeFigures = ReturnType<typeof homeFigures>

export const homeLabel = (month: string, dayOfMonth: number, daysInMonth: number): string =>
  `${monthShortLabel(month)} · day ${dayOfMonth} of ${daysInMonth}`

/**
 * The hero's answer to one question: am I inside my budget? `value` and `unit` are
 * what the figure says, `budgetLine` and `forecast` what the caption under it says.
 */
export function homeHero(d: HomeFigures, dayOfMonth: number, daysInMonth: number) {
  const overBudget = d.totalBudget > 0 && d.spend > d.totalBudget
  const overPaceBudget = d.totalBudget > 0 && !overBudget && d.canProject && d.projectedTotal > d.totalBudget
  return {
    overBudget,
    overPaceBudget,
    hasBudget: d.totalBudget > 0,
    budgetPct: d.totalBudget > 0 ? Math.min(100, (d.spend / d.totalBudget) * 100) : 0,
    budgetState: overBudget ? 'over' : overPaceBudget ? 'pace' : 'ok',
    pacePct: daysInMonth > 0 ? (dayOfMonth / daysInMonth) * 100 : 0,
    stateWord: overBudget ? 'Over budget' : overPaceBudget ? 'Likely to go over' : 'On track',
    value: overBudget ? d.spend - d.totalBudget : d.totalBudget - d.spend,
    unit: overBudget ? 'over' : 'left',
    budgetLine: `of ${money(d.totalBudget, { trim: true })} budget`,
    forecast: d.canProject && !overBudget ? `~${money(d.projectedTotal, { approx: true })} ${BY_MONTH_END}` : null,
  } as const
}
