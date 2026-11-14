// @vitest-environment jsdom
/**
 * Home with a savings plan, with the clock pinned. The amounts are invented:
 * a 3,000 budget and an 800 goal.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Home } from './Home'
import { db, type Category, type Transaction } from '../db/db'
import { setPlan } from '../lib/planCache'
import type { SavingsPlan } from '../lib/savingsPlan'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})
let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})
const pay = (date: string, amount: number) => txn(date, amount, 9, { type: 'income' })
const plan = (extra: Partial<SavingsPlan> = {}): SavingsPlan => ({ goal: 800, cap: 3000, locked: true, since: '2031-04', pending: null, updatedAt: 1, ...extra })

// Category budgets add up to exactly 3,000.
const FIT = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 1000), cat(9, 'Salary', 0, { kind: 'income' })]
// And to 3,350: an edit from an old copy of the app, or a restore.
const OVER = [cat(1, 'Groceries', 2000), cat(2, 'Dining', 1350), cat(9, 'Salary', 0, { kind: 'income' })]

const onMore = vi.fn()

async function renderHome(now: string, txns: Transaction[], categories: Category[] = FIT) {
  vi.setSystemTime(new Date(now))
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Home categories={categories} onEdit={() => {}} onMore={onMore} active />)
  await waitFor(() => expect(view.container.querySelector('.home-hero')).not.toBeNull())
  return view.container
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  onMore.mockClear()
  localStorage.clear()
})
afterEach(async () => {
  cleanup()
  setPlan(null)
  vi.useRealTimers()
  await db.transactions.clear()
})

describe("Home's hero with a locked plan", () => {
  const APRIL = [txn('2031-04-02', 1900, 1), txn('2031-04-05', 1200, 2), pay('2031-04-10', 3400)]

  it('measures the month against the plan, not what the categories add up to', async () => {
    setPlan(plan())
    const root = await renderHome('2031-04-20T12:00:00', APRIL, OVER)
    const hero = root.querySelector('.home-hero')!
    expect(hero.querySelector('.hero-state')?.textContent).toBe('Over budget')
    expect(hero.querySelector('.hero-fig')?.textContent).toBe('$100.00 over')
    expect(hero.querySelector('.hero-caption')?.textContent).toBe('of $3,000 budget')
  })

  it('with the lock off, or no plan, it is what the categories add up to', async () => {
    setPlan(plan({ locked: false, since: null }))
    const root = await renderHome('2031-04-20T12:00:00', APRIL, OVER)
    expect(root.querySelector('.hero-fig')?.textContent).toBe('$250.00 left')
    expect(root.querySelector('.hero-caption')?.textContent).toMatch(/^of \$3,350 budget/)
    cleanup()
    setPlan(null)
    const again = await renderHome('2031-04-20T12:00:00', APRIL, OVER)
    expect(again.querySelector('.hero-caption')?.textContent).toMatch(/^of \$3,350 budget/)
  })

  it('a pending raise takes over on the 1st, with the screen left open', async () => {
    setPlan(plan({ pending: { from: '2031-05', cap: 3600 } }))
    const root = await renderHome('2031-04-30T23:59:00', APRIL, OVER)
    expect(root.querySelector('.hero-caption')?.textContent).toBe('of $3,000 budget')
    vi.setSystemTime(new Date('2031-05-01T00:00:30'))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(root.querySelector('.hero-label')?.textContent).toContain('May'))
    await waitFor(() => expect(root.querySelector('.hero-caption')?.textContent).toMatch(/^of \$3,600 budget/))
  })
})

/** A whole month that took in 4,000 and spent `spend`, inside both category budgets. */
const whole = (m: string, spend: number, income = 4000) => [txn(`${m}-03`, spend - 500, 1), txn(`${m}-08`, 500, 2), ...(income ? [pay(`${m}-15`, income)] : [])]
const line = (root: HTMLElement) => root.querySelector('.home-plan')
const lineSoon = async (root: HTMLElement) => {
  await waitFor(() => expect(line(root)).not.toBeNull())
  return line(root)!
}

describe("Home's line about the plan", () => {
  // Locked from April. Today is in July, and July has been paid.
  const JULY = [txn('2031-07-02', 400, 1), pay('2031-07-05', 4000)]
  const months = (spend: number) => [...whole('2031-04', spend), ...whole('2031-05', spend), ...whole('2031-06', spend), ...JULY]

  it.each([
    ['above the goal', 3140, 9000, 'Saved $860 a month on average · $60 above goal', false],
    ['on the goal', 3200, 9000, 'Saved $800 a month on average · on goal', false],
    ['short of the goal, with spending over the budget', 3250, 3200, 'Saved $750 a month on average · $50 short of goal', false],
    ['short of the goal, with spending inside the budget every month', 3250, 9000, 'Saved $750 a month on average · inside the budget every month', false],
    ['below zero', 4120, 9000, 'Overspent $120 a month on average · $920 short of goal', true],
  ])('%s', async (_what, spend, cap, text, red) => {
    setPlan(plan({ cap }))
    const el = await lineSoon(await renderHome('2031-07-10T12:00:00', months(spend)))
    expect(el.textContent).toBe(text)
    expect(el.className).toBe(red ? 'home-plan num over' : 'home-plan num')
  })

  it('an ordinary month on two paydays, spent exactly to the budget, does not read as short of the goal beside On track', async () => {
    // Paid 1,700 every other Friday; a 2,600 budget and a 1,000 goal. September had two paydays, October three.
    const fortnightly = ['2031-09-05', '2031-09-19', '2031-10-03', '2031-10-17', '2031-10-31', '2031-11-14'].map((d) => pay(d, 1700))
    const spent = [...['2031-09', '2031-10'].flatMap((m) => [txn(`${m}-04`, 2100, 1), txn(`${m}-09`, 500, 2)]), txn('2031-11-02', 100, 1)]
    setPlan(plan({ goal: 1000, cap: 2600, since: '2031-09' }))
    const root = await renderHome('2031-11-03T12:00:00', [...fortnightly.filter((t) => t.date < '2031-11-01'), ...spent])
    const el = await lineSoon(root)
    // With October's third payday the average is (800 + 2,500) / 2 = 1,650. Without it, September alone is short.
    expect(el.textContent).toBe('Saved $1,650 a month on average · $650 above goal')
    cleanup()
    const sept = await renderHome('2031-10-03T12:00:00', [...fortnightly.filter((t) => t.date < '2031-10-01'), ...spent.filter((t) => t.date < '2031-10-01')])
    expect((await lineSoon(sept)).textContent).toBe('Saved $800 a month on average · inside the budget every month')
  })

  it('is the last thing in the hero, under the net', async () => {
    setPlan(plan({ cap: 9000 }))
    const root = await renderHome('2031-07-10T12:00:00', months(3140))
    const el = await lineSoon(root)
    expect(root.querySelector('.cf-flows')?.lastElementChild).toBe(el)
    expect(el.previousElementSibling?.className).toBe('home-net')
  })

  it('keeps what follows the dot together, so a narrow phone breaks the line at the dot', async () => {
    setPlan(plan({ cap: 9000 }))
    const el = await lineSoon(await renderHome('2031-07-10T12:00:00', months(4120)))
    expect([...el.querySelectorAll('.home-plan-tail')].map((t) => t.textContent)).toEqual(['$920 short of goal'])
    expect(el.textContent).toBe('Overspent $120 a month on average · $920 short of goal')
  })

  it('before any whole month, it names the goal and when counting starts', async () => {
    setPlan(plan({ since: '2031-08' }))
    const root = await renderHome('2031-07-10T12:00:00', months(3140))
    expect((await lineSoon(root)).textContent).toBe('Goal $800 saved a month · counting from August')
    cleanup()
    setPlan(plan({ since: '2032-01' }))
    expect((await lineSoon(await renderHome('2031-12-10T12:00:00', [pay('2031-12-05', 4000)]))).textContent).toBe('Goal $800 saved a month · counting from Jan 2032')
  })

  it('is drawn in a month with no activity yet', async () => {
    setPlan(plan({ cap: 9000 }))
    const root = await renderHome('2031-07-01T08:00:00', [...whole('2031-04', 3140), ...whole('2031-05', 3140), ...whole('2031-06', 3140)])
    expect(root.querySelector('.home-net')).toBeNull()
    expect((await lineSoon(root)).textContent).toBe('Saved $860 a month on average · $60 above goal')
  })

  it('is not drawn with no plan, or with the lock off', async () => {
    const root = await renderHome('2031-07-10T12:00:00', months(3140))
    await new Promise((r) => setTimeout(r, 30))
    expect(line(root)).toBeNull()
    cleanup()
    setPlan(plan({ locked: false, since: null }))
    const off = await renderHome('2031-07-10T12:00:00', months(3140))
    await new Promise((r) => setTimeout(r, 30))
    expect(line(off)).toBeNull()
  })

  it('never shows a figure from rows that have not loaded, and does not hold Home on its skeleton for them', async () => {
    setPlan(plan({ cap: 9000 }))
    vi.setSystemTime(new Date('2031-07-10T12:00:00'))
    await db.transactions.clear()
    await db.transactions.bulkAdd(months(3140))
    // Every text the line ever had, and whether the hero was up before the line was.
    const texts: string[] = []
    let heroFirst = false
    const view = render(<Home categories={FIT} onEdit={() => {}} onMore={onMore} active />)
    const watch = new MutationObserver(() => {
      const el = view.container.querySelector('.home-plan')
      if (el) texts.push(el.textContent ?? '')
      else if (view.container.querySelector('.home-hero')) heroFirst = true
    })
    watch.observe(view.container, { childList: true, subtree: true, characterData: true })
    await waitFor(() => expect(view.container.querySelector('.home-plan')).not.toBeNull())
    watch.disconnect()
    expect(heroFirst).toBe(true)
    expect(new Set(texts)).toEqual(new Set(['Saved $860 a month on average · $60 above goal']))
  })

  it('before payday the net still says so, and the line is about whole months only', async () => {
    setPlan(plan({ cap: 9000 }))
    // July has only spent: 1,998.75 out and nothing in.
    const rows = [...whole('2031-04', 3140), ...whole('2031-05', 3140), ...whole('2031-06', 3140), txn('2031-07-01', 1937.25, 1), txn('2031-07-02', 61.5, 2)]
    const root = await renderHome('2031-07-04T12:00:00', rows)
    expect(root.querySelector('.home-net')?.textContent).toBe('No income yet')
    const el = await lineSoon(root)
    expect(el.textContent).toBe('Saved $860 a month on average · $60 above goal')
    expect(el.className).toBe('home-plan num')
    expect(root.textContent).not.toContain('Overspent')
  })

  it('a row dated in the live month, or ahead of it, is not in the average', async () => {
    setPlan(plan({ cap: 9000 }))
    const root = await renderHome('2031-07-10T12:00:00', [...months(3140), txn('2031-08-01', 2000, 1)])
    expect((await lineSoon(root)).textContent).toBe('Saved $860 a month on average · $60 above goal')
  })
})

describe('category budgets that add up to more than the plan', () => {
  const tooMuch = (root: HTMLElement) => [...root.querySelectorAll('.home-list .traj-name')].find((n) => n.textContent === 'Category budgets add up to too much')?.closest('li') ?? null
  const allGood = (root: HTMLElement) => root.querySelector('.allgood')

  it('over the plan while inside every category budget: Home says over, says why, and does not say all is on track', async () => {
    setPlan(plan())
    // Budgets 2,000 and 1,350 against a 3,000 plan; spent 1,900 and 1,300.
    const root = await renderHome('2031-04-20T12:00:00', [txn('2031-04-02', 1900, 1), txn('2031-04-05', 1300, 2), pay('2031-04-10', 4000)], OVER)
    expect(root.querySelector('.hero-state')?.textContent).toBe('Over budget')
    const row = tooMuch(root)!
    expect(row.querySelector('.traj-meta')?.textContent).toBe('$350 more than your $3,000 budget')
    expect([...row.querySelectorAll('.traj-meta strong.num')].map((n) => n.textContent)).toEqual(['$350', '$3,000'])
    expect(row.querySelector('button.traj-row.home-row.row-press')).not.toBeNull()
    expect(allGood(root)).toBeNull()
    expect(root.textContent).not.toContain('All budgets on track')
    fireEvent.click(row.querySelector('button')!)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('with spending well under the plan the row still shows, and the all-clear does not', async () => {
    setPlan(plan())
    const root = await renderHome('2031-04-20T12:00:00', [txn('2031-04-02', 200, 1), pay('2031-04-10', 4000)], OVER)
    expect(root.querySelector('.hero-state')?.textContent).toBe('On track')
    expect(tooMuch(root)).not.toBeNull()
    expect(allGood(root)).toBeNull()
  })

  it('comes after the income row and before the category rows', async () => {
    setPlan(plan())
    const root = await renderHome('2031-04-20T12:00:00', [txn('2031-04-02', 2100, 1), txn('2031-04-05', 1300, 2), pay('2031-04-10', 2900)], OVER)
    const list = [...root.querySelectorAll('.home-list')][0]
    expect([...list.querySelectorAll('.traj-name')].map((n) => n.textContent)).toEqual(['Budgets exceed income', 'Category budgets add up to too much', 'Groceries'])
    // The income row measures the plan's budget too, as the hero does.
    expect(list.querySelector('.traj-meta')?.textContent).toBe('$3,000 budgeted · $2,900.00 income so far')
  })

  it('budgets equal to the plan and nothing over: no such row, and the all-clear shows as before', async () => {
    setPlan(plan())
    const root = await renderHome('2031-04-20T12:00:00', [txn('2031-04-02', 200, 1), pay('2031-04-10', 4000)], FIT)
    expect(tooMuch(root)).toBeNull()
    expect(allGood(root)?.textContent).toContain('All budgets on track. Nothing needs you.')
  })

  it('with no plan, the same budgets raise no such row', async () => {
    const root = await renderHome('2031-04-20T12:00:00', [txn('2031-04-02', 200, 1), pay('2031-04-10', 4000)], OVER)
    expect(tooMuch(root)).toBeNull()
    expect(allGood(root)?.textContent).toContain('All budgets on track. Nothing needs you.')
  })
})
