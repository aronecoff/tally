// @vitest-environment jsdom
/**
 * Budget screen display. Values are invented.
 *  - B104: a month before any history read 'Income $0.00 · Saved $0.00' under
 *    a $7,500 budget rail. It now says there is no activity, as Insights does.
 *    A month whose refunds cancel its purchases is not empty: it keeps the hero.
 *  - B112: in a category's drill-down the merchant is its own part, so a
 *    narrow screen can put it on its own line under a Refund or Pending tag.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { db, type Category, type Transaction } from '../db/db'

const cat = (id: number, name: string, monthlyBudget: number, kind: Category['kind'] = 'expense'): Category => ({
  id, name, icon: 'tag', color: '#fff', kind, monthlyBudget, sortOrder: id, updatedAt: 0,
})
const CATEGORIES = [cat(1, 'Groceries', 500), cat(7, 'Shopping', 400), cat(20, 'Salary', 0, 'income')]

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `T${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})

async function renderMonth(month: string, txns: Transaction[], extra: { initialOpen?: { key: string; n: number } } = {}) {
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Dashboard month={month} categories={CATEGORIES} active {...extra} />)
  await waitFor(() => expect(view.container.querySelector('.bud-list')).not.toBeNull())
  return view.container
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T12:00:00'))
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

describe('B104: a month with nothing in it', () => {
  it('says there is no activity, with no figure, rail, caption or meta line', async () => {
    const root = await renderMonth('2026-03', [])
    const hero = root.querySelector('.bud-hero')!
    expect(hero.querySelector('.hero-state')?.textContent).toBe('No activity in March 2026.')
    expect(hero.querySelector('.hero-fig')).toBeNull()
    expect(hero.querySelector('.bud-hero-rail')).toBeNull()
    expect(hero.querySelector('.hero-caption')).toBeNull()
    expect(hero.querySelector('.bud-meta')).toBeNull()
  })

  it('a month whose refunds cancel its purchases keeps the hero, with no verdict', async () => {
    const root = await renderMonth('2026-05', [txn('2026-05-03', 60, 7), txn('2026-05-09', -60, 7, { note: 'Store refund' })])
    const hero = root.querySelector('.bud-hero')!
    expect(hero.textContent).not.toMatch(/No activity/)
    expect(hero.querySelector('.hero-fig')?.textContent).toBe('$0.00')
    expect(hero.querySelector('.bud-hero-rail')).not.toBeNull()
    expect(hero.querySelector('.hero-caption')).not.toBeNull()
    expect(hero.querySelector('.hero-state')).toBeNull()
  })

  it('the current month before anything is spent keeps its verdict', async () => {
    const root = await renderMonth('2026-10', [])
    expect(root.querySelector('.bud-hero .hero-state')?.textContent).toBe('On track')
    expect(root.querySelector('.bud-hero .hero-fig')?.textContent).toBe('$0.00')
  })
})

describe('B112: the drill-down row', () => {
  it('holds the merchant in its own part; the text still reads "Refund · …"', async () => {
    // jsdom has no scrollIntoView. Opening a row brings it into view on the next
    // frame; without this, that frame threw whenever it found a #bud-7 still on
    // screen (late in this test under load, or in the next test when shuffled).
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const rows = [txn('2026-09-05', 42.1, 7, { note: 'Big Store' }), txn('2026-09-09', -3.75, 7, { note: 'Marketplace' })]
    const root = await renderMonth('2026-09', rows, { initialOpen: { key: '7', n: 1 } })
    await waitFor(() => expect(root.querySelector('#bud-7 .bud-txns')).not.toBeNull())
    // The opened row is brought into view (and no frame is left for a later test).
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
    expect(scroll.mock.contexts[0]).toBe(root.querySelector('#bud-7'))
    const back = [...root.querySelectorAll('#bud-7 .bud-txn')].find((r) => r.textContent?.includes('Marketplace'))!
    expect(back.querySelector('.bud-txn-note')?.textContent).toBe('Refund · Marketplace')
    expect(back.querySelector('.bud-txn-note > .bud-txn-name')?.textContent).toBe('Marketplace')
    expect(back.querySelector('.bud-txn-amt')?.classList.contains('pos')).toBe(true)
  })
})
