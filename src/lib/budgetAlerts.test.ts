// @vitest-environment jsdom
/** What crosses a line, what is said, and when it goes. The figures are invented. */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { alertWords, crossings, groupWords, type AlertSettings, type Crossing } from './budgetAlerts'
import { budgetStatus, rowState } from './copy'
import { todayISO } from './dates'
import { homeFigures, type HomeRow } from './homeFigures'

const row = (over: Partial<HomeRow> & { spent: number; budget: number }): HomeRow => ({
  id: 1, name: 'Dining', icon: 'tag', projected: over.spent, fixed: false, txnCount: 1, pendingCount: 0, ...over,
})

const figures = (rows: HomeRow[], spend = 0, totalBudget = 0) => ({ rows, spend, totalBudget })

const lines = (spent: number, budget: number, fixed = false) =>
  crossings(figures([row({ spent, budget, fixed })]), [], '2026-11').map((c) => c.line)

describe('Which lines a budget has reached', () => {
  it('reaches 80% at 80% and not a cent before', () => {
    expect(lines(79.99, 100)).toEqual([])
    expect(lines(80, 100)).toEqual([80])
    expect(lines(99.99, 100)).toEqual([80])
  })

  it('compares in whole cents, so float residue cannot move a line', () => {
    expect(lines(0.3 - 0.1, 0.2)).toEqual([80, 100]) // 0.19999999999999998
    expect(lines(0.1 + 0.2, 0.3, true)).toEqual([]) // 0.30000000000000004, on its budget and not past it
    expect(lines(23.99, 30)).toEqual([])
    expect(lines(24, 30)).toEqual([80])
  })

  it('reaches 100% at the budget, not only past it', () => {
    expect(lines(100, 100)).toEqual([80, 100])
    expect(lines(150, 100)).toEqual([80, 100])
  })

  it('a fixed bill landing on its budget reaches nothing, and past it reaches both', () => {
    expect(lines(90, 100, true)).toEqual([])
    expect(lines(100, 100, true)).toEqual([])
    expect(lines(100.01, 100, true)).toEqual([80, 100])
  })

  it('no budget has no lines, Uncategorized included', () => {
    expect(lines(50, 0)).toEqual([])
    expect(crossings(figures([row({ id: null, name: 'Uncategorized', spent: 50, budget: 0 })]), [], '2026-11')).toEqual([])
  })

  it('a month of refunds reaches nothing', () => {
    expect(lines(-40, 100)).toEqual([])
  })

  it('counts the month as a whole, first, by Home\'s spending and budget', () => {
    const all = crossings(figures([row({ spent: 90, budget: 100 })], 170, 200), [], '2026-11')
    expect(all.map((c) => [c.key, c.line])).toEqual([['month', 80], ['id1', 80]])
    expect(all[0]).toMatchObject({ name: null, spent: 170, budget: 200, id: 'month-2026-11-80' })
  })

  it('has no month line without a budget', () => {
    expect(crossings(figures([], 500, 0), [], '2026-11')).toEqual([])
  })

  it('knows a category by its uid where it has one', () => {
    const cats = [{ id: 1, uid: 'c-1', name: 'Dining', icon: 'tag', color: '#fff', kind: 'expense' as const, monthlyBudget: 100, sortOrder: 0, updatedAt: 1 }]
    expect(crossings(figures([row({ spent: 85, budget: 100 })]), cats, '2026-11')[0].id).toBe('c-1-2026-11-80')
  })
})

describe('What an alert says', () => {
  const at = (spent: number, budget: number, line: 80 | 100, name: string | null = 'Dining'): Crossing => ({ key: 'k', name, line, spent, budget, id: 'x' })

  it('says what is left at 80%', () => {
    expect(alertWords(at(161.5, 200, 80), false)).toEqual({ title: 'Dining reached 80% of budget', body: '$38.50 left of $200.' })
  })

  it('says it reached the budget when it is exactly there', () => {
    expect(alertWords(at(200, 200, 100), false)).toEqual({ title: 'Dining reached its budget', body: '$200 of $200 spent.' })
  })

  it('says how far over when it is over', () => {
    expect(alertWords(at(212.5, 200, 100), false)).toEqual({ title: 'Dining is over budget', body: '$12.50 over $200.' })
  })

  it('calls the month this month', () => {
    expect(alertWords(at(1700, 2000, 80, null), false)).toEqual({ title: 'This month reached 80% of budget', body: '$300.00 left of $2,000.' })
    expect(alertWords(at(2000.5, 2000, 100, null), false).title).toBe('This month is over budget')
  })

  it('names nothing and shows no figure with the lock on', () => {
    expect(alertWords(at(212.5, 200, 100), true)).toEqual({ title: 'A budget reached 100%', body: '' })
    expect(alertWords(at(1700, 2000, 80, null), true)).toEqual({ title: 'A budget reached 80%', body: '' })
  })

  it('agrees with the row it describes, to the cent', () => {
    const state = rowState({ spent: 212.5, limit: 200, projected: 212.5, isCurrent: true })
    const status = budgetStatus({ name: 'Dining', spent: 212.5, limit: 200, projected: 212.5, canProject: true, state, isUncategorized: false, txnCount: 1, pendingCount: 0, fixed: false })
    expect(alertWords(at(212.5, 200, 100), false).body.startsWith(status.text)).toBe(true)
  })

  it('takes several as one, naming three', () => {
    const many = ['Dining', 'Fun', null, 'Travel', 'Pets'].map((name) => at(90, 100, 80, name))
    expect(groupWords(many, false)).toEqual({ title: '5 budgets reached 80% or more', body: 'Dining, Fun, This month and 2 more.' })
    expect(groupWords(many, true)).toEqual({ title: '5 budgets reached 80% or more', body: '' })
  })
})

// ---- Against an app that answers as ios/Shared/BudgetAlerts.swift does -------------

const posted: { id: string; title: string; body: string }[] = []
const asked: string[] = []
let settings: AlertSettings
let lockOn: boolean | null
let failing = false

async function postMessage({ method, args }: { method: string; args: { id: string; title: string; body: string; also?: string[]; budgets?: boolean; seen?: string[] } }) {
  asked.push(method)
  if (method === 'alerts.status') return { ...settings, fired: [...settings.fired] }
  if (method === 'lock.status') {
    if (lockOn === null) throw new Error('unavailable')
    return { enabled: lockOn, available: true, biometry: 'faceID', after: 60 }
  }
  if (method === 'alerts.set') {
    settings.fired.push(...(args.seen ?? []))
    if (args.budgets != null) settings.budgets = args.budgets
    return { ...settings }
  }
  if (method === 'alerts.post') {
    if (failing) throw new Error('unavailable')
    if (!settings.budgets || settings.fired.includes(args.id)) return { posted: false }
    settings.fired = [...new Set([...settings.fired, args.id, ...(args.also ?? [])])]
    posted.push({ id: args.id, title: args.title, body: args.body })
    return { posted: true }
  }
  throw new Error('unavailable')
}

const addCategory = (id: number, name: string, monthlyBudget: number, fixed = false) =>
  db.categories.add({ id, uid: `c${id}`, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, fixed, updatedAt: 1 })

const spend = (categoryId: number, amount: number) =>
  db.transactions.add({ date: todayISO(), amount, type: 'expense', categoryId, account: '', note: 'Harbor Coffee', createdAt: 1, updatedAt: 1 })

const loaded: { stopBudgetAlerts: () => void }[] = []

/** A fresh module each time: it starts once per page. */
const load = async () => {
  vi.resetModules()
  const module = await import('./budgetAlerts')
  loaded.push(module)
  return module
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(1500)
  // The read itself is IndexedDB and the bridge, which real time carries.
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 30))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

let visibility: DocumentVisibilityState = 'visible'
const goTo = (state: DocumentVisibilityState) => {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

const month = () => todayISO().slice(0, 7)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  posted.length = 0
  asked.length = 0
  failing = false
  lockOn = false
  visibility = 'visible'
  settings = { permission: 'allowed', budgets: true, weekly: false, weekday: 1, hour: 18, fired: [] }
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
  await addCategory(1, 'Dining', 100)
})

afterEach(async () => {
  // Each load added page-wide listeners, which a stopped module ignores.
  for (const m of loaded.splice(0)) m.stopBudgetAlerts()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('When an alert goes', () => {
  it('does nothing without the app around the page, not even listen', async () => {
    vi.unstubAllGlobals()
    const listen = vi.spyOn(document, 'addEventListener')
    const { startBudgetAlerts, alertSettings } = await load()
    startBudgetAlerts()
    await spend(1, 90)
    await settle()
    expect(asked).toEqual([])
    expect(listen).not.toHaveBeenCalledWith('visibilitychange', expect.anything())
    expect(await alertSettings()).toBeNull()
  })

  it('sends nothing while the setting is off, however far past a line', async () => {
    settings.budgets = false
    ;(await load()).startBudgetAlerts()
    await settle()
    await spend(1, 500)
    await settle()
    expect(posted).toEqual([])
    expect(asked).not.toContain('alerts.post')
  })

  it('sends nothing without permission, and marks nothing', async () => {
    settings.permission = 'denied'
    ;(await load()).startBudgetAlerts()
    await spend(1, 90)
    await settle()
    expect(asked).not.toContain('alerts.post')
    expect(settings.fired).toEqual([])
  })

  it('an app from before alerts is left alone', async () => {
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage: () => Promise.reject(new Error('unavailable')) } } })
    const { startBudgetAlerts, alertSettings } = await load()
    startBudgetAlerts()
    await spend(1, 90)
    await settle()
    expect(await alertSettings()).toBeNull()
  })

  it('goes after a change in the ledger, with Home\'s figures', async () => {
    ;(await load()).startBudgetAlerts()
    await settle()
    expect(posted).toEqual([])
    await spend(1, 85)
    await settle()
    // The month is the category here, so both have reached 80%.
    expect(posted).toEqual([
      { id: `month-${month()}-80`, title: 'This month reached 80% of budget', body: '$15.00 left of $100.' },
      { id: `c1-${month()}-80`, title: 'Dining reached 80% of budget', body: '$15.00 left of $100.' },
    ])
  })

  it('counts a burst of writes once', async () => {
    ;(await load()).startBudgetAlerts()
    await settle()
    asked.length = 0
    await spend(1, 10)
    await spend(1, 10)
    await settle()
    expect(asked.filter((m) => m === 'alerts.status')).toHaveLength(1)
  })

  it('each line fires once, whatever else happens this month', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    expect(posted).toHaveLength(1)
    await spend(1, 5)
    await settle()
    goTo('hidden')
    goTo('visible')
    await settle()
    expect(posted).toHaveLength(1)
    // A new page, as after a reload: the record is the app's, so it holds.
    ;(await load()).startBudgetAlerts()
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('says each line in turn', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    await spend(1, 20)
    await settle()
    expect(posted.map((p) => p.title)).toEqual(['Dining reached 80% of budget', 'Dining is over budget'])
  })

  it('past both at once says the higher, and the lower never follows', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    const big = await spend(1, 120)
    await settle()
    expect(posted.map((p) => p.title)).toEqual(['Dining is over budget'])
    await db.transactions.update(big, { amount: 85 }) // a correction brings it back under
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('a refund that drops below a line does not arm it again', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    const back = await spend(1, -30)
    await settle()
    await db.transactions.delete(back)
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('a fixed bill landing on its budget says nothing, and past it says so once', async () => {
    await addCategory(2, 'Rent', 1000, true)
    await addCategory(3, 'Rest', 9000)
    ;(await load()).startBudgetAlerts()
    await spend(2, 1000)
    await settle()
    expect(posted).toEqual([])
    await spend(2, 25)
    await settle()
    expect(posted.map((p) => p.title)).toEqual(['Rent is over budget'])
  })

  it('leaves out names and figures with the lock on', async () => {
    await addCategory(2, 'Rest', 900)
    lockOn = true
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    expect(posted).toEqual([{ id: `c1-${month()}-80`, title: 'A budget reached 80%', body: '' }])
  })

  it('says less, not more, if it cannot tell whether the lock is on', async () => {
    await addCategory(2, 'Rest', 900)
    lockOn = null
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    expect(posted[0].title).toBe('A budget reached 80%')
  })

  it('takes more than three at once as one alert, and marks them all', async () => {
    await addCategory(2, 'Fun', 100)
    await addCategory(3, 'Pets', 100)
    await addCategory(4, 'Travel', 100)
    await addCategory(5, 'Rest', 9000)
    ;(await load()).startBudgetAlerts()
    await Promise.all([1, 2, 3, 4].map((c) => spend(c, 80 + c)))
    await settle()
    expect(posted).toHaveLength(1)
    expect(posted[0].title).toBe('4 budgets reached 80% or more')
    expect(settings.fired).toHaveLength(4)
    await spend(1, 1)
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('three at once are each said', async () => {
    await addCategory(2, 'Fun', 100)
    await addCategory(3, 'Pets', 100)
    await addCategory(5, 'Rest', 9000)
    ;(await load()).startBudgetAlerts()
    await Promise.all([1, 2, 3].map((c) => spend(c, 80 + c)))
    await settle()
    expect(posted).toHaveLength(3)
  })

  it('a post that failed goes at the next change', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    failing = true
    await spend(1, 85)
    await settle()
    expect(posted).toEqual([])
    failing = false
    await spend(1, 1)
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('leaving sends what has not gone yet, without waiting for the quiet', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    await settle()
    await spend(1, 85)
    goTo('hidden')
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 30))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(posted).toHaveLength(1)
  })

  it('leaving with nothing waiting checks nothing', async () => {
    ;(await load()).startBudgetAlerts()
    await settle()
    asked.length = 0
    goTo('hidden')
    await settle()
    expect(asked).toEqual([])
  })

  it('coming back looks again, as it can be a new month', async () => {
    ;(await load()).startBudgetAlerts()
    await settle()
    goTo('hidden')
    await settle()
    asked.length = 0
    goTo('visible')
    await settle()
    expect(asked).toContain('alerts.status')
  })

  it('a new month starts every line again', async () => {
    await addCategory(2, 'Rest', 900)
    settings.fired = ['c1-2026-01-80', 'c1-2026-01-100']
    ;(await load()).startBudgetAlerts()
    await spend(1, 85)
    await settle()
    expect(posted.map((p) => p.id)).toEqual([`c1-${month()}-80`])
  })

  it('reads the live month, not last month\'s rows', async () => {
    await addCategory(2, 'Rest', 900)
    await db.transactions.add({ date: '2020-01-15', amount: 500, type: 'expense', categoryId: 1, account: '', note: 'x', createdAt: 1, updatedAt: 1 })
    ;(await load()).startBudgetAlerts()
    await settle()
    expect(posted).toEqual([])
  })

  it('starts once', async () => {
    await addCategory(2, 'Rest', 900)
    await spend(1, 85)
    const { startBudgetAlerts } = await load()
    startBudgetAlerts()
    startBudgetAlerts()
    await settle()
    expect(asked.filter((m) => m === 'alerts.status')).toHaveLength(1)
  })

  it('sends nothing once stopped, and catches up if the ledger stayed', async () => {
    await addCategory(2, 'Rest', 900)
    const { startBudgetAlerts, stopBudgetAlerts, resumeBudgetAlerts } = await load()
    startBudgetAlerts()
    await settle()
    stopBudgetAlerts()
    await spend(1, 85)
    await settle()
    goTo('hidden')
    goTo('visible')
    await settle()
    expect(posted).toEqual([])
    resumeBudgetAlerts()
    await settle()
    expect(posted).toHaveLength(1)
  })
})

describe('With a locked savings plan', () => {
  // The copy the freshly loaded module reads.
  const lock = async (cap: number) => (await import('./planCache')).setPlan({ goal: 20, cap, locked: true, since: '2031-01', pending: null, updatedAt: 1 })
  afterEach(async () => void (await import('./planCache')).setPlan(null))

  it("the month's lines are at 80% and 100% of the plan's budget, not of what the categories add up to", async () => {
    await addCategory(2, 'Rest', 900) // category budgets add up to 1,000
    ;(await load()).startBudgetAlerts()
    await lock(200)
    await spend(2, 159)
    await settle()
    expect(posted).toEqual([])
    await spend(2, 1)
    await settle()
    expect(posted).toEqual([{ id: `month-${month()}-80`, title: 'This month reached 80% of budget', body: '$40.00 left of $200.' }])
    await spend(2, 41)
    await settle()
    expect(posted.at(-1)).toEqual({ id: `month-${month()}-100`, title: 'This month is over budget', body: '$1.00 over $200.' })
  })

  it('locking in a month already past the budget says so once, with no write to the ledger', async () => {
    await addCategory(2, 'Rest', 900)
    ;(await load()).startBudgetAlerts()
    await spend(2, 300)
    await settle()
    expect(posted).toEqual([])
    await lock(200)
    await settle()
    expect(posted).toEqual([{ id: `month-${month()}-100`, title: 'This month is over budget', body: '$100.00 over $200.' }])
    await settle()
    expect(posted).toHaveLength(1)
  })

  it("a month whose line has already gone sends nothing more when a lock lands", async () => {
    await addCategory(2, 'Rest', 900)
    settings.fired = [`month-${month()}-80`, `month-${month()}-100`]
    ;(await load()).startBudgetAlerts()
    await spend(2, 300)
    await settle()
    await lock(200)
    await settle()
    expect(posted).toEqual([])
  })
})

describe('Turning alerts on', () => {
  it('starts from what is true now: lines already passed are not news', async () => {
    await addCategory(2, 'Fun', 100)
    await addCategory(3, 'Rest', 9000)
    settings.budgets = false
    const { startBudgetAlerts, changeAlerts } = await load()
    startBudgetAlerts()
    await spend(1, 130)
    await settle()
    await changeAlerts({ budgets: true })
    await settle()
    expect(posted).toEqual([])
    expect(settings.fired).toEqual([`c1-${month()}-80`, `c1-${month()}-100`])
    await spend(1, 5) // Dining goes on past lines it had already passed
    await settle()
    expect(posted).toEqual([])
    await spend(2, 85) // Fun crosses one for real
    await settle()
    expect(posted.map((p) => p.title)).toEqual(['Fun reached 80% of budget'])
  })

  it('turning off sends no lines with it', async () => {
    await spend(1, 90)
    const { changeAlerts } = await load()
    await changeAlerts({ budgets: false })
    expect(settings.fired).toEqual([])
  })

  it('a change to the reminder reads no ledger and marks nothing', async () => {
    await spend(1, 90)
    const { changeAlerts } = await load()
    await changeAlerts({ weekly: true, weekday: 3 })
    expect(settings.fired).toEqual([])
  })
})

describe('Home\'s figures', () => {
  it('a pending charge counts, as it does on Home', () => {
    const d = homeFigures({
      monthTxns: [{ id: 1, date: '2026-11-05', amount: 85, type: 'expense', categoryId: 1, account: '', note: 'x', pending: true, createdAt: 1, updatedAt: 1 }],
      recentTxns: [],
      month: '2026-11',
      cats: [{ id: 1, name: 'Dining', icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget: 100, sortOrder: 0, updatedAt: 1 }],
      daysInMonth: 30,
      dayOfMonth: 5,
    })
    expect(crossings(d, [], '2026-11').map((c) => c.id)).toEqual(['month-2026-11-80', 'id1-2026-11-80'])
  })
})
