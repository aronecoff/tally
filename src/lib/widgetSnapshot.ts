import Dexie from 'dexie'
import { moneyParts, toCents } from './format'
import { homeHero, homeLabel } from './homeFigures'
import { homeNow } from './homeNow'
import { hasNative, native } from './native'

/**
 * What the home-screen and lock-screen widgets show, handed to the app around the
 * page (ios/WidgetData/WidgetSnapshot.swift). The app cannot work out a figure and
 * must not: every number and every word about money here is Home's own, already
 * formatted. Totals only, because a lock-screen widget shows on a locked phone.
 *
 * In a browser and in the Mac app there is no widget, so this does nothing.
 */
export interface WidgetSnapshot {
  v: 1
  /** When these figures were read from the ledger. */
  asOf: number
  /** The month they belong to. A widget still showing it next month shows no figure. */
  month: string
  hasBudget: boolean
  budget: number
  spent: number
  /** Below zero when over. */
  left: number
  over: boolean
  state: 'ok' | 'pace' | 'over'
  /** Home's hero, word for word: label, state, figure and unit, caption. */
  label: string
  stateWord: string
  whole: string
  cents: string
  unit: string
  budgetLine: string
  /** Empty when Home shows no forecast. */
  forecast: string
  /** How far along the rail, 0 to 1, and where the pace tick sits. */
  rail: number
  pace: number
}

/** Home's hero as it stands now, from the same rows Home reads. */
export async function buildWidgetSnapshot(): Promise<WidgetSnapshot> {
  const { month, dayOfMonth, daysInMonth, d } = await homeNow()
  const hero = homeHero(d, dayOfMonth, daysInMonth)
  const { whole, cents } = moneyParts(hero.value)
  return {
    v: 1,
    asOf: Date.now(),
    month,
    hasBudget: hero.hasBudget,
    budget: d.totalBudget,
    spent: d.spend,
    left: (toCents(d.totalBudget) - toCents(d.spend)) / 100,
    over: hero.overBudget,
    state: hero.budgetState,
    label: homeLabel(month, dayOfMonth, daysInMonth),
    stateWord: hero.stateWord,
    whole,
    cents,
    unit: hero.unit,
    budgetLine: hero.budgetLine,
    forecast: hero.forecast ?? '',
    // A month of refunds runs below zero. Home's rail stops at the start, and so does this.
    rail: Math.max(0, hero.budgetPct / 100),
    pace: hero.pacePct / 100,
  }
}

/** Long enough for a sync's writes to land as one, short enough to beat leaving the app. */
const QUIET_MS = 1500

let started = false
let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined
let queue: Promise<void> = Promise.resolve()
let published: string | null = null

async function publish(always: boolean): Promise<void> {
  try {
    const snapshot = await buildWidgetSnapshot()
    if (stopped) return
    // The same figures at a later minute are not news while the page is only syncing.
    const digest = JSON.stringify({ ...snapshot, asOf: 0 })
    if (!always && digest === published) return
    await native('widget.publish', snapshot as unknown as Record<string, unknown>)
    published = digest
  } catch {
    /* an app from before widgets, or nowhere to write: the next change tries again */
  }
}

/** One at a time, so a newer snapshot is never overtaken by an older one. */
function enqueue(always: boolean): void {
  clearTimeout(timer)
  timer = undefined
  queue = queue.then(() => publish(always))
}

function mark(): void {
  if (stopped) return
  clearTimeout(timer)
  timer = setTimeout(() => enqueue(false), QUIET_MS)
}

/**
 * The start point, once, after the first paint has what it needs. Opening the app
 * always publishes, because the widget's time says when the figures were last read.
 * Leaving it publishes only what changed, as an app in the background pays for each
 * widget reload out of a daily allowance.
 */
export function startWidgetSnapshot(): void {
  if (started || !hasNative()) return
  started = true
  Dexie.on('storagemutated', mark)
  document.addEventListener('visibilitychange', () => enqueue(document.visibilityState === 'visible'))
  enqueue(true)
}

/** Nothing more goes out until the page reloads: the ledger is being erased. */
export function stopWidgetSnapshot(): void {
  stopped = true
  clearTimeout(timer)
  timer = undefined
}

/** The erase failed, so the ledger is still here: carry on. */
export function resumeWidgetSnapshot(): void {
  stopped = false
  if (started) mark()
}
