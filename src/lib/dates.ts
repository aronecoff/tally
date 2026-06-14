/** Local YYYY-MM-DD (avoids the UTC off-by-one that toISOString() causes). */
export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local current month, YYYY-MM. */
export function currentMonth(): string {
  return todayISO().slice(0, 7)
}

/** "June 2026" from "2026-06". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/** Shift a YYYY-MM month by N months (negative = back). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** True if a YYYY-MM-DD date falls within a YYYY-MM month. */
export function inMonth(dateISO: string, month: string): boolean {
  return dateISO.startsWith(month)
}

/** "Jun 3" — short label for a transaction row. */
export function dayLabel(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
