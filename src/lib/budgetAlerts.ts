import Dexie from 'dexie'
import type { Category } from '../db/db'
import { lockStatus } from './appLock'
import { money, toCents } from './format'
import type { HomeFigures } from './homeFigures'
import { homeNow } from './homeNow'
import { hasNative, native } from './native'
import { subscribePlan } from './planCache'

/**
 * Notifications when the live month crosses 80% and 100% of a budget, and a weekly
 * reminder, sent through the app around the page (ios/Shared/BudgetAlerts.swift). The
 * figures are Home's own and every word is written here. The app only keeps the
 * settings and which alerts have gone, so each line fires once per budget per month.
 *
 * The page only runs while the app is open, so a budget alert goes out when the app
 * sees the figures, not when the money moves. The weekly reminder is scheduled, and
 * needs nothing from the page. In a browser and in the Mac app none of this exists.
 */
export interface AlertSettings {
  permission: 'unset' | 'allowed' | 'denied'
  budgets: boolean
  weekly: boolean
  /** 1 is Sunday. */
  weekday: number
  hour: number
  /** What has gone, or been passed over. */
  fired: string[]
}

type Line = 80 | 100

export interface Crossing {
  /** Which budget, so a line and the one above it can be told apart from another budget's. */
  key: string
  /** Null is the month as a whole. */
  name: string | null
  line: Line
  spent: number
  budget: number
  /** What the app remembers it by. */
  id: string
}

/** The lines a budget has reached, lowest first, compared in whole cents. */
function linesReached(spent: number, budget: number, fixed: boolean): Line[] {
  const spentC = toCents(spent)
  const budgetC = toCents(budget)
  if (budgetC <= 0) return []
  // A fixed bill landing on its budget is the expected outcome (copy.rowState), so
  // it goes from nothing straight to past both.
  if (fixed) return spentC > budgetC ? [80, 100] : []
  const lines: Line[] = []
  if (spentC * 100 >= budgetC * 80) lines.push(80)
  if (spentC >= budgetC) lines.push(100)
  return lines
}

/** Every line reached this month, the month first and then Home's order. */
export function crossings(d: Pick<HomeFigures, 'rows' | 'spend' | 'totalBudget'>, cats: Category[], month: string): Crossing[] {
  const uids = new Map(cats.map((c) => [c.id, c.uid]))
  const budgets = [
    { key: 'month', name: null, spent: d.spend, budget: d.totalBudget, fixed: false },
    // By uid where there is one: a local id changes if the ledger is pulled again.
    ...d.rows.map((r) => ({ key: uids.get(r.id ?? undefined) ?? `id${r.id}`, name: r.name, spent: r.spent, budget: r.budget, fixed: r.fixed })),
  ]
  return budgets.flatMap(({ key, name, spent, budget, fixed }) =>
    linesReached(spent, budget, fixed).map((line) => ({ key, name, line, spent, budget, id: `${key}-${month}-${line}` })),
  )
}

/** What one alert says. `quiet` is for a locked app: no name and no figure. */
export function alertWords(c: Crossing, quiet: boolean): { title: string; body: string } {
  if (quiet) return { title: `A budget reached ${c.line}%`, body: '' }
  const who = c.name ?? 'This month'
  const budget = money(c.budget, { trim: true })
  const overC = toCents(c.spent) - toCents(c.budget)
  if (overC > 0) return { title: `${who} is over budget`, body: `${money(overC / 100)} over ${budget}.` }
  if (overC === 0) return { title: `${who} reached its budget`, body: `${budget} of ${budget} spent.` }
  return { title: `${who} reached ${c.line}% of budget`, body: `${money(-overC / 100)} left of ${budget}.` }
}

/** More than this in one go reads as one alert, so a file coming in is not a row of banners. */
const MOST_AT_ONCE = 3

/** What several at once say. */
export function groupWords(news: Crossing[], quiet: boolean): { title: string; body: string } {
  const title = `${news.length} budgets reached 80% or more`
  if (quiet) return { title, body: '' }
  const names = news.slice(0, MOST_AT_ONCE).map((c) => c.name ?? 'This month')
  return { title, body: `${names.join(', ')} and ${news.length - names.length} more.` }
}

/** Null where there are no alerts: a browser, the Mac app, or an older iPhone app. */
export async function alertSettings(): Promise<AlertSettings | null> {
  if (!hasNative()) return null
  try {
    return await native<AlertSettings>('alerts.status')
  } catch {
    return null
  }
}

/**
 * Turning budget alerts on starts from what is true now: a month already over budget
 * is not news, and a dozen banners at the moment of turning them on would be no way to
 * start. Those lines go with the change, so nothing can check in between. The app asks
 * for permission the first time anything turns on, and replies with what is now true.
 */
export async function changeAlerts(change: { budgets?: boolean; weekly?: boolean; weekday?: number; hour?: number }): Promise<AlertSettings> {
  if (!change.budgets) return native<AlertSettings>('alerts.set', change)
  const { month, cats, d } = await homeNow()
  return native<AlertSettings>('alerts.set', { ...change, seen: crossings(d, cats, month).map((c) => c.id) })
}

export const openAlertPermission = (): Promise<unknown> => native('alerts.openSettings')

/** Long enough for a sync's writes to land as one, short enough to beat leaving the app. */
const QUIET_MS = 1500

let started = false
let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined
let queue: Promise<void> = Promise.resolve()

async function check(): Promise<void> {
  try {
    const settings = await native<AlertSettings>('alerts.status')
    if (!settings.budgets || settings.permission !== 'allowed') return
    const { month, cats, d } = await homeNow()
    const fired = new Set(settings.fired)
    const fresh = crossings(d, cats, month).filter((c) => !fired.has(c.id))
    if (fresh.length === 0) return
    // Past both lines at once, only the higher one is said, and the lower one goes with it.
    const highest = new Map(fresh.map((c) => [c.key, c]))
    const news = [...highest.values()]
    const quiet = (await lockStatus())?.enabled ?? true
    if (stopped) return
    if (news.length > MOST_AT_ONCE) {
      await native('alerts.post', { id: fresh[0].id, ...groupWords(news, quiet), also: fresh.map((c) => c.id) })
      return
    }
    for (const c of news) {
      await native('alerts.post', { id: c.id, ...alertWords(c, quiet), also: fresh.filter((f) => f.key === c.key).map((f) => f.id) })
    }
  } catch {
    /* an app from before alerts, or a post that failed: nothing was marked, so the next change tries again */
  }
}

/** One at a time, so two checks never see the same line as fresh. */
function enqueue(): void {
  clearTimeout(timer)
  timer = undefined
  queue = queue.then(check)
}

function mark(): void {
  if (stopped) return
  clearTimeout(timer)
  timer = setTimeout(enqueue, QUIET_MS)
}

/** The start point, once, after the first paint has what it needs. Off, each check ends at the setting. */
export function startBudgetAlerts(): void {
  if (started || !hasNative()) return
  started = true
  Dexie.on('storagemutated', mark)
  // A change to the savings plan moves the month's lines and is not a write to the ledger.
  subscribePlan(mark)
  document.addEventListener('visibilitychange', () => {
    // Back after a while it can be a new month. Leaving sends what has not gone yet.
    if (document.visibilityState === 'visible' || timer !== undefined) enqueue()
  })
  enqueue()
}

/** Nothing more goes out until the page reloads: the ledger is being erased. */
export function stopBudgetAlerts(): void {
  stopped = true
  clearTimeout(timer)
  timer = undefined
}

/** The erase failed, so the ledger is still here: carry on. */
export function resumeBudgetAlerts(): void {
  stopped = false
  if (started) mark()
}
