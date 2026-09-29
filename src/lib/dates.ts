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

/** Header label: "September" in the current year, "Sep 2025" otherwise. */
export function monthShortLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1, 1)
  if (y === new Date().getFullYear()) return d.toLocaleDateString('en-US', { month: 'long' })
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/** Shift a YYYY-MM month by N months (negative = back). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** Shift a YYYY-MM-DD day by N days in local time (negative = back). */
export function shiftDayISO(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const t = new Date(y, m - 1, d + delta)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/** "Jun 3" — short label for a transaction row. */
export function dayLabel(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Day header: "Today", "Yesterday", "Fri, Sep 18", or "Fri, Sep 18, 2025" in another year. */
export function dayHeading(dateISO: string): string {
  const today = todayISO()
  if (dateISO === today) return 'Today'
  if (dateISO === shiftDayISO(today, -1)) return 'Yesterday'
  const [y, m, d] = dateISO.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const sameYear = y === new Date().getFullYear()
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "just now", "5m ago", "3h ago", "2d ago" from an epoch-ms timestamp. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
