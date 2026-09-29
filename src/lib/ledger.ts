import type { Transaction } from '../db/db'

/**
 * A merchant refund: an expense with a NEGATIVE amount. Totals need nothing
 * special (adding it takes it off that category's spending); screens show it as
 * money back, '+$12.50', with a Refund tag.
 */
export const isRefund = (t: Pick<Transaction, 'type' | 'amount'>) => t.type === 'expense' && t.amount < 0

/**
 * One row per uid. Two local rows sharing a uid are ONE cloud row stored twice
 * (a bank sync and a pull adding it at once), so the copy that carries the most
 * intent survives: a manual pin first, then the newest write, then the oldest
 * row. Callers delete the copies outright; a tombstone pushed under the shared
 * uid would delete the real row in the cloud.
 */
export function oneRowPerUid(rows: readonly Transaction[]): { byUid: Map<string, Transaction>; copies: Transaction[] } {
  const byUid = new Map<string, Transaction>()
  const copies: Transaction[] = []
  const better = (a: Transaction, b: Transaction) =>
    Number(!!a.manual) - Number(!!b.manual) || a.updatedAt - b.updatedAt || (b.id ?? 0) - (a.id ?? 0)
  for (const t of rows) {
    if (!t.uid) continue
    const prev = byUid.get(t.uid)
    if (!prev) byUid.set(t.uid, t)
    else if (better(t, prev) > 0) { byUid.set(t.uid, t); copies.push(prev) }
    else copies.push(t)
  }
  return { byUid, copies }
}

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
 * spend is; a refund, being negative, comes off it), added in whole cents so it
 * equals the sum of the figures shown.
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
