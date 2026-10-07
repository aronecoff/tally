// @vitest-environment jsdom
/**
 * App-level navigation and the viewed month. Values are invented.
 *  - B29: Home is always the current month, so its rows and 'See all budgets'
 *    open Budget on the current month, whatever month Budget last showed.
 *  - B30: left open overnight into a new month, Home and the month screens move
 *    to the new month on resume, and a reload does not restore the old one.
 *  - B101: Categories' 'Budget' back control lands on Budget, also after a
 *    history Forward rewrote the entry behind it.
 *  - B103: a month step opens the new month at its top on every month screen.
 *  - B64: a month step never paints the new month's label over the old
 *    month's figures (the label and the figures change in one commit), and
 *    coming back to a month after an edit never shows its rows from before.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { db, type Category, type Transaction } from './db/db'
import App from './App'

vi.mock('./db/supabase', () => ({ supabase: null }))
vi.mock('./lib/banks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/banks')>()),
  syncAllConnectors: vi.fn(async () => {}),
}))

const cat = (id: number, name: string, monthlyBudget: number, kind: Category['kind'] = 'expense'): Category => ({
  id, name, icon: 'tag', color: '#fff', kind, monthlyBudget, sortOrder: id, updatedAt: 0,
})
let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0,
})

const CATS = [cat(1, 'Groceries', 500), cat(2, 'Dining', 100), cat(9, 'Salary', 0, 'income')]
const ROWS = [txn('2026-09-10', 300, 2), txn('2026-09-12', 120, 1), txn('2026-08-10', 40, 2), txn('2026-08-15', 900, 1)]

const label = () => document.querySelector('.app-head .ms-label')?.textContent ?? null
const heroLabel = () => document.querySelector('.home-hero .hero-label')?.textContent ?? null
const visiblePane = () => document.querySelector('section.pane:not([hidden])') as HTMLElement
const tab = (name: string) => within(document.querySelector('nav.tabbar') as HTMLElement).getByRole('button', { name })
/** A click whose update may suspend (a month change): an awaited act lets React
 *  retry the suspended render once the rows are in. */
const tap = (el: Element) =>
  act(async () => {
    fireEvent.click(el)
  })
const prevMonth = () => tap(screen.getByRole('button', { name: 'Previous month' }))

async function boot(now: string, hash = '#home') {
  vi.setSystemTime(new Date(now))
  history.replaceState(null, '', hash)
  const view = render(<App />)
  await waitFor(() => expect(visiblePane()?.getAttribute('aria-busy')).toBeNull())
  return view
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  )
  Element.prototype.scrollIntoView = vi.fn()
  sessionStorage.clear()
  localStorage.setItem('tally-home-detail', '1')
  await db.categories.bulkAdd(CATS)
  await db.transactions.bulkAdd(ROWS)
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await db.transactions.clear()
  await db.categories.clear()
})

describe('B29: Home opens Budget on the current month', () => {
  async function budgetStepsBackThenHome() {
    await boot('2026-09-22T12:00:00')
    await tap(tab('Budget'))
    await waitFor(() => expect(label()).toBe('September'))
    await prevMonth()
    await waitFor(() => expect(label()).toBe('August'))
    await waitFor(() => expect(visiblePane().querySelector('.bud-list')?.textContent).toContain('$900.00'))
    await tap(tab('Home'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('home'))
  }

  it("an attention row opens this month's row, not the month Budget last showed", async () => {
    await budgetStepsBackThenHome()
    const row = [...visiblePane().querySelectorAll<HTMLElement>('button.home-row')].find((b) => b.textContent?.includes('Dining'))
    expect(row).toBeTruthy()
    await tap(row!)
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('budget'))
    await waitFor(() => expect(label()).toBe('September'))
    await waitFor(() => expect(document.querySelector('#bud-2.open .bud-txns')?.textContent).toContain('$300.00'))
  })

  it("'See all budgets' opens this month", async () => {
    await budgetStepsBackThenHome()
    await tap(within(visiblePane()).getByText('See all budgets'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('budget'))
    await waitFor(() => expect(label()).toBe('September'))
    // September's Groceries, not August's.
    await waitFor(() => expect(visiblePane().querySelector('.bud-list')?.textContent).toContain('$120.00'))
  })
})

describe('B30: a new day while the app is open', () => {
  it('on resume after midnight into a new month, Home and Budget show the new month', async () => {
    await boot('2026-09-30T21:00:00')
    await waitFor(() => expect(heroLabel()).toBe('September · day 30 of 30'))
    await tap(tab('Budget'))
    await waitFor(() => expect(label()).toBe('September'))
    await tap(tab('Home'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('home'))

    vi.setSystemTime(new Date('2026-10-01T08:00:00'))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(heroLabel()).toBe('October · day 1 of 31'))
    await tap(tab('Budget'))
    await waitFor(() => expect(label()).toBe('October'))
  })

  it('a midnight inside a month moves Home to the new day', async () => {
    await boot('2026-09-21T23:59:00')
    await waitFor(() => expect(heroLabel()).toBe('September · day 21 of 30'))
    vi.setSystemTime(new Date('2026-09-22T00:01:00'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(heroLabel()).toBe('September · day 22 of 30'))
  })

  it('a reload after the month turned opens the new month, not the one that was current', async () => {
    const first = await boot('2026-09-30T21:00:00', '#budget')
    await waitFor(() => expect(label()).toBe('September'))
    first.unmount()
    await boot('2026-10-01T08:00:00', '#budget')
    await waitFor(() => expect(label()).toBe('October'))
  })

  it('a past month chosen on purpose still survives a reload', async () => {
    const first = await boot('2026-09-30T21:00:00', '#budget')
    await prevMonth()
    await waitFor(() => expect(label()).toBe('August'))
    first.unmount()
    await boot('2026-10-01T08:00:00', '#budget')
    await waitFor(() => expect(label()).toBe('August'))
  })
})

describe("B101: Categories' back control", () => {
  it('lands on Budget after a tab change and a history Forward', async () => {
    await boot('2026-09-22T12:00:00', '#budget')
    fireEvent.click(await screen.findByTestId('manage-categories'))
    await waitFor(() => expect(location.hash).toBe('#categories'))
    await tap(tab('Activity'))
    await waitFor(() => expect(location.hash).toBe('#activity'))
    act(() => history.forward())
    await waitFor(() => expect(location.hash).toBe('#categories'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('categories'))
    fireEvent.click(document.querySelector('.head-back') as HTMLElement)
    await waitFor(() => expect(location.hash).toBe('#budget'))
    expect(visiblePane().dataset.screen).toBe('budget')
  })

  it('still lands on Budget from a plain Edit', async () => {
    await boot('2026-09-22T12:00:00', '#budget')
    fireEvent.click(await screen.findByTestId('manage-categories'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('categories'))
    fireEvent.click(document.querySelector('.head-back') as HTMLElement)
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('budget'))
    expect(location.hash).toBe('#budget')
  })
})

describe('B103: a month step opens the new month at its top', () => {
  it('on the screen it was stepped on', async () => {
    await boot('2026-09-22T12:00:00', '#activity')
    await waitFor(() => expect(visiblePane().querySelector('.activity')).not.toBeNull())
    const pane = visiblePane()
    pane.scrollTop = 900
    await prevMonth()
    await waitFor(() => expect(label()).toBe('August'))
    expect(pane.scrollTop).toBe(0)
  })

  it('on a month screen shown later', async () => {
    await boot('2026-09-22T12:00:00', '#budget')
    await waitFor(() => expect(visiblePane().querySelector('.bud-list')).not.toBeNull())
    const budget = visiblePane()
    budget.scrollTop = 600
    await tap(tab('Activity'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('activity'))
    await prevMonth()
    await waitFor(() => expect(label()).toBe('August'))
    await tap(tab('Budget'))
    await waitFor(() => expect(visiblePane().dataset.screen).toBe('budget'))
    expect(budget.scrollTop).toBe(0)
  })
})

describe('B64: a month step changes the label and the figures together', () => {
  /** Every state the DOM passes through after the step, label beside content. */
  async function stepAndRecord(content: () => string) {
    const states: [string | null, string][] = []
    const sample = () => states.push([label(), content()])
    const mo = new MutationObserver(sample)
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    await prevMonth()
    sample()
    await waitFor(() => expect(label()).toBe('August'))
    await waitFor(() => expect(content()).toContain('$900.00'))
    mo.disconnect()
    return states
  }

  it('on Budget', async () => {
    await boot('2026-09-22T12:00:00', '#budget')
    const list = () => visiblePane().querySelector('.bud-list')?.textContent ?? ''
    await waitFor(() => expect(list()).toContain('$300.00'))
    const states = await stepAndRecord(list)
    for (const [l, text] of states) {
      // September's Dining is $300.00; August's Groceries is $900.00.
      if (l === 'August') expect(text).not.toContain('$300.00')
      if (l === 'September') expect(text).not.toContain('$900.00')
    }
  })

  it('on Activity', async () => {
    await boot('2026-09-22T12:00:00', '#activity')
    const list = () => visiblePane().querySelector('.activity')?.textContent ?? ''
    await waitFor(() => expect(list()).toContain('$300.00'))
    const states = await stepAndRecord(list)
    for (const [l, text] of states) {
      if (l === 'August') expect(text).not.toContain('$300.00')
      if (l === 'September') expect(text).not.toContain('$900.00')
    }
  })

  it('coming back to a month after an edit never shows its rows from before the edit', async () => {
    await boot('2026-09-22T12:00:00', '#budget')
    const pane = () => visiblePane().textContent ?? ''
    await waitFor(() => expect(pane()).toContain('$300.00'))
    await prevMonth()
    await waitFor(() => expect(label()).toBe('August'))
    await waitFor(() => expect(pane()).toContain('$900.00'))
    // An edit lands in August (the app's own edit, or a sync): $900 becomes $950.
    await act(async () => {
      await db.transactions.update(ROWS[3].id!, { amount: 950, updatedAt: 1 })
    })
    await waitFor(() => expect(pane()).toContain('$950.00'))
    // A glance at September, then back.
    await tap(screen.getByRole('button', { name: 'Next month' }))
    await waitFor(() => expect(label()).toBe('September'))
    await waitFor(() => expect(pane()).toContain('$300.00'))
    const states: [string | null, string][] = []
    const sample = () => states.push([label(), pane()])
    const mo = new MutationObserver(sample)
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    await prevMonth()
    sample()
    await waitFor(() => expect(label()).toBe('August'))
    await waitFor(() => expect(pane()).toContain('$950.00'))
    mo.disconnect()
    const august = states.filter(([l]) => l === 'August')
    expect(august.length).toBeGreaterThan(0)
    for (const [, text] of august) expect(text).not.toContain('$900.00')
  })
})
