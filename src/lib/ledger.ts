import type { Transaction } from '../db/db'

/** One Activity day: its rows in their sorted order and the day's spend. */
export interface DayGroup {
  /** YYYY-MM-DD */
  date: string
  rows: Transaction[]
  /** The day's expense total (display only). */
  out: number
}

/**
 * Split date-sorted rows into one group per day, keeping their order. `out` is
 * a display-only sum of the day's expense amounts (pending included, as Home's
 * spend is), added in whole cents so it equals the sum of the figures shown.
 */
export function groupByDay(sorted: readonly Transaction[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const t of sorted) {
    const last = groups[groups.length - 1]
    if (last && last.date === t.date) last.rows.push(t)
    else groups.push({ date: t.date, rows: [t], out: 0 })
  }
  for (const g of groups) {
    let cents = 0
    for (const t of g.rows) if (t.type === 'expense') cents += Math.round(t.amount * 100)
    g.out = cents / 100
  }
  return groups
}
