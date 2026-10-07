// @vitest-environment jsdom
/**
 * Home's money lines with the clock pinned. Values are invented.
 *  - Before any income lands, the month is not 'Overspent' (nothing needs you
 *    and a red figure equal to the whole month's spending said the opposite).
 *  - The per-day pace leaves bills out (rent made it read ~$913 a day).
 *  - A budget whose refunds outweigh its purchases stays listed.
 *  - Recurring never names a future day as the last charge.
 *  - A renamed Rent is still a fixed bill.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Home } from './Home'
import { Dashboard } from './Dashboard'
import { db, type Category, type Transaction } from '../db/db'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Shop ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})

const CATS = [cat(1, 'Rent', 2400), cat(2, 'Shopping', 1150), cat(3, 'Dining', 300), cat(9, 'Salary', 0, { kind: 'income' })]

async function renderHome(now: string, txns: Transaction[], categories: Category[] = CATS) {
  vi.setSystemTime(new Date(now))
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Home categories={categories} onEdit={() => {}} onMore={() => {}} active />)
  await waitFor(() => expect(view.container.querySelector('.home-hero')).not.toBeNull())
  return view.container
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    localStorage.setItem('tally-home-detail', '1')
  } catch {
    /* storage blocked */
  }
})
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

describe('Home before payday', () => {
  const OCT = [txn('2026-10-01', 2400, 1), txn('2026-10-01', 70, 2), txn('2026-10-02', 31.92, 3)]

  it('says no income yet instead of a red Overspent', async () => {
    const root = await renderHome('2026-10-04T12:00:00', OCT)
    expect(root.querySelector('.home-net')?.textContent).toBe('No income yet')
    expect(root.querySelector('.home-net .over')).toBeNull()
    expect(root.textContent).not.toContain('Overspent')
  })

  it('with no budgets the hero reads the same way, with what was spent', async () => {
    const root = await renderHome('2026-10-04T12:00:00', OCT, CATS.map((c) => ({ ...c, monthlyBudget: 0 })))
    const hero = root.querySelector('.home-hero')!
    expect(hero.querySelector('.hero-state')?.textContent).toBe('No income yet')
    expect(hero.querySelector('.hero-state')?.classList.contains('over')).toBe(false)
    expect(hero.querySelector('.hero-fig')?.textContent).toBe('$2,501.92')
  })

  it('once income lands, the net is back', async () => {
    const root = await renderHome('2026-10-04T12:00:00', [...OCT, txn('2026-10-03', 1000, 9, { type: 'income' })])
    expect(root.querySelector('.home-net-label')?.textContent).toBe('Overspent so far')
  })
})

describe('Home before payday, with interest already in', () => {
  // September paid twice; October has spent and earned only interest so far.
  const cats = [...CATS, cat(10, 'Other income', 0, { kind: 'income' })]
  const SEP_PAY = [txn('2026-09-10', 3000, 9, { type: 'income' }), txn('2026-09-25', 3000, 9, { type: 'income' })]
  const OCT = [txn('2026-10-01', 2400, 1), txn('2026-10-03', 120, 2), txn('2026-10-06', 12.4, 10, { type: 'income', note: 'INTEREST PAYMENT' })]

  it('is not Overspent and raises no income alarm', async () => {
    const root = await renderHome('2026-10-08T12:00:00', [...SEP_PAY, ...OCT], cats)
    expect(root.querySelector('.home-net')?.textContent).toBe('No pay yet')
    expect(root.querySelector('.home-net .over')).toBeNull()
    expect(root.textContent).not.toContain('Overspent')
    expect(root.textContent).not.toContain('Budgets exceed income')
    expect(root.querySelector('.cf-bar-fill.out.over')).toBeNull()
  })

  it('with no budgets the hero waits too, with what was spent', async () => {
    const root = await renderHome('2026-10-08T12:00:00', [...SEP_PAY, ...OCT], cats.map((c) => ({ ...c, monthlyBudget: 0 })))
    const hero = root.querySelector('.home-hero')!
    expect(hero.querySelector('.hero-state')?.textContent).toBe('No pay yet')
    expect(hero.querySelector('.hero-state')?.classList.contains('over')).toBe(false)
    expect(hero.querySelector('.hero-fig')?.textContent).toBe('$2,520.00')
  })

  it('once pay lands under Salary, the net and the alarm are back', async () => {
    const root = await renderHome('2026-10-10T12:00:00', [...SEP_PAY, ...OCT, txn('2026-10-10', 1000, 9, { type: 'income' })], cats)
    expect(root.querySelector('.home-net-label')?.textContent).toBe('Overspent so far')
    expect(root.textContent).toContain('Budgets exceed income')
  })
})

describe('Day by day', () => {
  it('paces flexible spending only', async () => {
    const root = await renderHome('2026-10-04T12:00:00', [txn('2026-10-01', 2400, 1), txn('2026-10-01', 70, 2), txn('2026-10-02', 31.92, 3)])
    // (70 + 31.92) / 4 days ≈ $25, not (2,501.92 / 4) ≈ $625.
    expect(root.querySelector('.daily')?.closest('section')?.querySelector('.sect-note')?.textContent).toBe('~$25/day excl. bills')
  })
})

describe('Home budgets', () => {
  it('a budget whose refunds outweigh its purchases stays listed, with what came back', async () => {
    const root = await renderHome('2026-09-03T12:00:00', [
      txn('2026-09-01', 2400, 1),
      txn('2026-09-02', 50, 2),
      txn('2026-09-02', -226, 2, { note: 'Shop refund' }),
    ])
    const names = [...root.querySelectorAll('.home-brow .traj-name')].map((n) => n.textContent)
    expect(names).toContain('Shopping')
    const row = [...root.querySelectorAll('.home-brow')].find((r) => r.querySelector('.traj-name')?.textContent === 'Shopping')!
    expect(row.querySelector('.traj-meta')?.textContent).toBe('$1,150 left · $176.00 back')
  })
})

describe('Recurring', () => {
  it('never names a future day as the last charge', async () => {
    const rent = (date: string) => txn(date, 2400, 1, { note: 'ACME PROPERTY MGMT' })
    const root = await renderHome('2026-09-30T12:00:00', [rent('2026-07-01'), rent('2026-08-01'), rent('2026-09-01'), rent('2026-10-01')])
    const bill = [...root.querySelectorAll('.bill-row')].find((r) => r.textContent?.includes('Acme'))
    expect(bill?.querySelector('.bill-sub')?.textContent).toBe('Rent · last Sep 1')
  })
})

describe('One-offs in the forecast', () => {
  // A car payment on the 1st of every month, under a flexible budget.
  const cats = [...CATS, cat(4, 'Transport', 600)]
  const car = (date: string) => txn(date, 318.4, 4, { note: 'ACME MOTORS' })

  it('one earlier month on the same day is enough (a short bank history)', async () => {
    const root = await renderHome(
      '2026-10-07T12:00:00',
      [car('2026-09-01'), car('2026-10-01'), txn('2026-10-04', 11.6, 4, { note: 'CITY PARKING' })],
      cats,
    )
    const flagged = [...root.querySelectorAll('.home-row .traj-name')].map((n) => n.textContent)
    expect(flagged).not.toContain('Transport')
  })

  it('a monthly bill counts once: Transport is not flagged on day 7', async () => {
    const root = await renderHome(
      '2026-10-07T12:00:00',
      [car('2026-08-01'), car('2026-09-01'), car('2026-10-01'), txn('2026-10-04', 11.6, 4, { note: 'CITY PARKING' })],
      cats,
    )
    const flagged = [...root.querySelectorAll('.home-row .traj-name')].map((n) => n.textContent)
    expect(flagged).not.toContain('Transport')
    // round(318.40 + 11.60 / (7/31)) = 370, not round(330 / (7/31)) = 1,461.
    const row = [...root.querySelectorAll('.home-brow')].find((r) => r.querySelector('.traj-name')?.textContent === 'Transport')!
    expect(row.querySelector('.traj-meta')).toBeNull()
  })

  it('a charge seen in only one earlier month, on another day, is still paced', async () => {
    const root = await renderHome(
      '2026-10-07T12:00:00',
      [car('2026-09-15'), car('2026-10-01'), txn('2026-10-04', 11.6, 4, { note: 'CITY PARKING' })],
      cats,
    )
    const flagged = [...root.querySelectorAll('.home-row .traj-name')].map((n) => n.textContent)
    expect(flagged).toContain('Transport')
  })

  it('reads the same bill history as Budget, so the two forecasts agree', async () => {
    // Day 20: 100 days back is Jul 12, after this bill's July charge (the 5th).
    // July and September make it a monthly bill (two months at the amount);
    // September alone, on another day, would not.
    const cats450 = [cat(4, 'Transport', 450), cat(9, 'Salary', 0, { kind: 'income' })]
    const rows = [car('2026-07-05'), car('2026-09-18'), car('2026-10-05'), txn('2026-10-12', 60, 4, { note: 'FUEL STOP' })]
    const root = await renderHome('2026-10-20T12:00:00', rows, cats450)
    // round(318.40 + 60 / (20/31)) = 411, not round(378.40 / (20/31)) = 587.
    expect(root.querySelector('.home-hero .hero-state')?.textContent).toBe('On track')
    expect(root.querySelector('.home-hero .hero-caption')?.textContent).toBe('of $450 budget · ~$411 by month-end')
    expect([...root.querySelectorAll('.home-row .traj-name')].map((n) => n.textContent)).not.toContain('Transport')
    cleanup()
    const budget = render(<Dashboard month="2026-10" categories={cats450} active />)
    await waitFor(() => expect(budget.container.querySelector('.bud-list')).not.toBeNull())
    expect(budget.container.querySelector('.hero-caption')?.textContent).toBe('of $450 budget · ~$411 by month-end')
  })

  it('on the last day, a budget that finished just under it is not flagged', async () => {
    // A bill with cents counted once, and the rest paced at the full month:
    // 87.35 + round(312.55) read $400.35 against a $400 budget, $0.10 unspent.
    const cats400 = [cat(4, 'Transport', 400), cat(9, 'Salary', 0, { kind: 'income' })]
    const bill = (date: string) => txn(date, 87.35, 4, { note: 'ACME MOTORS' })
    const rows = [bill('2026-07-01'), bill('2026-08-01'), bill('2026-09-01'), txn('2026-09-12', 312.55, 4, { note: 'FUEL STOP' })]
    const root = await renderHome('2026-09-30T12:00:00', rows, cats400)
    expect(root.querySelector('.home-hero .hero-state')?.textContent).toBe('On track')
    expect([...root.querySelectorAll('.home-row .traj-name')].map((n) => n.textContent)).not.toContain('Transport')
    const row = [...root.querySelectorAll('.home-brow')].find((r) => r.querySelector('.traj-name')?.textContent === 'Transport')!
    expect(row.querySelector('.traj-meta')?.textContent ?? '').not.toContain('by month-end')
  })

  it("a refund counts once, and is not a day's spending", async () => {
    const root = await renderHome('2026-10-04T12:00:00', [
      txn('2026-10-01', 2400, 1),
      txn('2026-10-01', -212.6, 2, { note: 'Big Store refund' }),
      txn('2026-10-01', 70, 2),
      txn('2026-10-02', 31.92, 3),
    ])
    // (70 + 31.92) / 4 days ≈ $25: the refund no longer nets it to −$28.
    expect(root.querySelector('.daily')?.closest('section')?.querySelector('.sect-note')?.textContent).toBe('~$25/day excl. bills')
  })
})

describe('A renamed Rent', () => {
  it('is still a known bill, not paced', async () => {
    const cats = [cat(1, 'Housing', 2400, { key: 'rent', fixed: true }), cat(2, 'Shopping', 1150)]
    const root = await renderHome('2026-10-07T12:00:00', [txn('2026-10-01', 2400, 1), txn('2026-10-03', 60, 2)], cats)
    expect(root.querySelector('.home-hero .hero-state')?.textContent).toBe('On track')
  })
})
