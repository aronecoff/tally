// @vitest-environment jsdom
/**
 * Insights with the clock pinned. All values are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Analysis } from './Analysis'
import { db, type Category, type Transaction } from '../db/db'

const cat = (id: number, name: string, monthlyBudget: number, extra: Partial<Category> = {}): Category => ({
  id, name, icon: 'tag', color: '#fff', kind: 'expense', monthlyBudget, sortOrder: id, updatedAt: 0, ...extra,
})
const CATS = [cat(1, 'Rent', 2400), cat(2, 'Shopping', 1150), cat(3, 'Dining', 600), cat(4, 'Transport', 300), cat(5, 'Other', 0), cat(9, 'Salary', 0, { kind: 'income' })]

let nextId = 1
const txn = (date: string, amount: number, categoryId: number | null, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, date, amount, type: 'expense', categoryId, account: 'Card', note: `Store ${nextId}`, createdAt: 0, updatedAt: 0, ...extra,
})
/** A full month: rent on the 1st, twelve $50 dinners and a $400 purchase, paid on the 15th. */
const fullMonth = (m: string) => [
  txn(`${m}-01`, 2400, 1, { note: 'ACME PROPERTY MGMT' }),
  ...Array.from({ length: 12 }, (_, i) => txn(`${m}-${String(i + 2).padStart(2, '0')}`, 50, 3, { note: `Cafe ${i}` })),
  txn(`${m}-16`, 400, 2, { note: 'Big Store' }),
  txn(`${m}-15`, 4000, 9, { type: 'income', note: 'ACME PAYROLL' }),
]

async function renderAt(now: string, month: string, txns: Transaction[], categories: Category[] = CATS) {
  vi.setSystemTime(new Date(now))
  await db.transactions.clear()
  await db.transactions.bulkAdd(txns)
  const view = render(<Analysis month={month} categories={categories} active />)
  await waitFor(() => expect(view.container.querySelector('.analysis')).not.toBeNull())
  return view.container
}
const section = (root: HTMLElement, title: string) =>
  [...root.querySelectorAll('section')].find((s) => s.querySelector('.sect-title')?.textContent === title)

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await db.transactions.clear()
})

describe('the live month before payday', () => {
  it('is not Overspent', async () => {
    const root = await renderAt('2026-10-04T12:00:00', '2026-10', [...fullMonth('2026-09'), txn('2026-10-01', 2400, 1), txn('2026-10-02', 50, 3)])
    const state = root.querySelector('.hero-state')!
    expect(state.textContent).toBe('No income yet')
    expect(state.classList.contains('over')).toBe(false)
    expect(root.querySelector('.hero-fig')?.textContent).toBe('$2,450.00')
  })

  it('an interest credit before payday is not pay', async () => {
    const cats = [...CATS, cat(10, 'Other income', 0, { kind: 'income' })]
    const oct = [txn('2026-10-01', 2400, 1), txn('2026-10-02', 50, 3), txn('2026-10-06', 12.4, 10, { type: 'income', note: 'INTEREST PAYMENT' })]
    const root = await renderAt('2026-10-08T12:00:00', '2026-10', [...fullMonth('2026-09'), ...oct], cats)
    const state = root.querySelector('.hero-state')!
    expect(state.textContent).toBe('No pay yet')
    expect(state.classList.contains('over')).toBe(false)
    expect(root.querySelector('.hero-fig')?.textContent).toBe('$2,450.00')
    // Nor does the chart's live column draw it over its income.
    const col = [...root.querySelectorAll('.cfc-col')].find((c) => c.getAttribute('aria-label')?.startsWith('October 2026'))!
    expect(col.querySelector('.cfc-bar.out.over')).toBeNull()
    expect(col.querySelector('.cfc-xnet.over')).toBeNull()
  })
})

describe('the chart', () => {
  it('draws no column for a month that has not started', async () => {
    const root = await renderAt('2026-09-30T12:00:00', '2026-09', [...fullMonth('2026-08'), ...fullMonth('2026-09'), txn('2026-10-01', 2400, 1)])
    const labels = [...root.querySelectorAll('.cfc-col')].map((c) => c.getAttribute('aria-label') ?? '')
    expect(labels.some((l) => l.startsWith('October 2026'))).toBe(false)
    expect(labels.some((l) => l.startsWith('September 2026'))).toBe(true)
  })
})

describe('By category', () => {
  it('a category whose refunds outweigh its purchases gets no negative share; the rest add to 100', async () => {
    const sep = [txn('2026-09-01', 2400, 1), txn('2026-09-03', 300, 3), txn('2026-09-04', 50, 2), txn('2026-09-05', -226, 2)]
    const root = await renderAt('2026-10-04T12:00:00', '2026-09', sep)
    const rows = [...section(root, 'By category')!.querySelectorAll('.an-row')].map((r) => [
      r.querySelector('.an-name')?.textContent,
      r.querySelector('.an-cat-pct')?.textContent,
    ])
    expect(rows.find(([n]) => n === 'Shopping')?.[1]).toBe('')
    const pcts = rows.filter(([n]) => n !== 'Shopping').map(([, p]) => Number(String(p).replace('%', '')))
    expect(pcts.reduce((s, x) => s + x, 0)).toBe(100)
  })
})

describe('Fixed vs flexible tip', () => {
  const OCT = [txn('2026-10-01', 2400, 1), txn('2026-10-02', 50, 3), txn('2026-10-04', 50, 3), txn('2026-10-06', 50, 3), txn('2026-10-08', 50, 3)]
  const tip = (root: HTMLElement) => root.querySelector('.an-mix-note')?.textContent

  it('early in the month it is based on last month, not four days', async () => {
    const root = await renderAt('2026-10-04T12:00:00', '2026-10', [...fullMonth('2026-09'), ...OCT.slice(0, 3)])
    expect(tip(root)).toBe('Based on September, spending 20% less on flexible saves ~$200 a month, ~$2,400 a year.')
  })

  it('once the month can be paced, it is based on the pace', async () => {
    const root = await renderAt('2026-10-08T12:00:00', '2026-10', [...fullMonth('2026-09'), ...OCT])
    // $200 of flexible spend by day 8 of 31 paces to ~$775.
    expect(tip(root)).toBe('At this pace flexible ends near ~$775; 20% less saves ~$155 a month, ~$1,860 a year.')
  })

  it('a monthly bill in a flexible budget counts once in the pace', async () => {
    // A car payment on the 1st of each month, filed under Transport (flexible).
    const car = (date: string) => txn(date, 264.8, 4, { note: 'ACME MOTORS' })
    const oct = [txn('2026-10-01', 2400, 1), car('2026-10-01'), ...['02', '04', '06'].map((d) => txn(`2026-10-${d}`, 50, 3, { note: 'Corner Cafe' }))]
    const root = await renderAt('2026-10-07T12:00:00', '2026-10', [car('2026-08-01'), ...fullMonth('2026-09'), car('2026-09-01'), ...oct])
    // round(264.80 + 150 / (7/31)) = 929, not round(414.80 / (7/31)) = 1,837.
    expect(tip(root)).toBe('At this pace flexible ends near ~$929; 20% less saves ~$186 a month, ~$2,230 a year.')
  })

  it('a refund counts once in the pace', async () => {
    const oct = [txn('2026-10-01', 2400, 1), txn('2026-10-01', -120, 2, { note: 'Big Store refund' }), ...['02', '04', '06'].map((d) => txn(`2026-10-${d}`, 50, 3, { note: 'Corner Cafe' }))]
    const root = await renderAt('2026-10-07T12:00:00', '2026-10', [...fullMonth('2026-09'), ...oct])
    // round(−120 + 150 / (7/31)) = 544, not round(30 / (7/31)) = 133.
    expect(tip(root)).toBe('At this pace flexible ends near ~$544; 20% less saves ~$109 a month, ~$1,306 a year.')
  })

  it('a past month reads as before', async () => {
    const root = await renderAt('2026-10-08T12:00:00', '2026-09', fullMonth('2026-09'))
    expect(tip(root)).toBe('Spending 20% less on flexible saves ~$200 a month, ~$2,400 a year.')
  })

  it('a renamed Rent stays fixed, and the note names it', async () => {
    const cats = CATS.map((c) => (c.id === 1 ? { ...c, name: 'Housing', key: 'rent', fixed: true } : c))
    const root = await renderAt('2026-10-08T12:00:00', '2026-09', fullMonth('2026-09'), cats)
    const mix = section(root, 'Fixed vs flexible')!
    expect(mix.querySelector('.sect-note')?.textContent).toBe('housing is fixed')
    expect(mix.querySelector('.an-mix-key')?.textContent).toContain('Fixed $2,400.00')
  })
})

describe('What changed', () => {
  it('does not compare against a month the bank feed only half covers', async () => {
    const sf = (date: string, amount: number, categoryId: number, manual = false) =>
      txn(date, amount, categoryId, { uid: `sf:${nextId}`, manual })
    // June: pinned paychecks and a few pinned charges from before the feed; bank rows from the 24th on.
    const june = [
      sf('2026-06-01', 4000, 9, true), sf('2026-06-02', 120, 3, true), sf('2026-06-24', 60, 3), sf('2026-06-25', 40, 2),
      ...Array.from({ length: 10 }, (_, i) => sf(`2026-06-${26 + (i % 4)}`, 20, 3)),
    ].map((t) => (t.categoryId === 9 ? { ...t, type: 'income' as const } : t))
    const july = fullMonth('2026-07').map((t) => ({ ...t, uid: `sf:${t.id}` }))
    const root = await renderAt('2026-08-02T12:00:00', '2026-07', [...june, ...july])
    const changed = section(root, 'What changed')!
    expect(changed.querySelector('.an-head .sect-note')?.textContent).toBe('June has partial data')
    expect(changed.querySelector('.an-list')).toBeNull()
    const juneCol = [...root.querySelectorAll('.cfc-col')].find((c) => c.getAttribute('aria-label')?.startsWith('June 2026'))
    expect(juneCol?.getAttribute('aria-label')).toContain('partial data')
  })

  it('compares purchases, with refunds as their own line', async () => {
    const prev = [
      txn('2026-09-02', -200, 2, { note: 'Amazon refund' }),
      txn('2026-09-01', 84.44, 2),
      txn('2026-09-03', 250, 4),
      txn('2026-09-02', -3.33, 2, { note: 'Amazon refund' }),
      ...fullMonth('2026-09').filter((t) => t.date > '2026-09-04'),
    ]
    const root = await renderAt('2026-10-04T12:00:00', '2026-10', [...prev, txn('2026-10-02', 101.92, 2)])
    const rows = [...section(root, 'What changed')!.querySelectorAll('.an-row')]
    const names = rows.map((r) => r.querySelector('.an-name')?.textContent)
    expect(names).toEqual(['Transport', 'Refunds'])
    const refunds = rows[1]
    expect(refunds.querySelector('.an-fig')?.textContent).toBe('+$203.33')
    expect(refunds.querySelector('.an-fig')?.classList.contains('over')).toBe(false)
    expect(refunds.querySelector('.an-sub')?.textContent).toBe('$203.33 back → $0.00 back')
  })
})

describe('Repeat merchants', () => {
  it('the average is per charge, refunds aside', async () => {
    const sep = [
      ...fullMonth('2026-09'),
      txn('2026-09-05', 100, 2, { note: 'Amazon' }),
      txn('2026-09-06', 50, 2, { note: 'Amazon' }),
      txn('2026-09-07', 30, 2, { note: 'Amazon' }),
      txn('2026-09-08', -60, 2, { note: 'Amazon' }),
    ]
    const root = await renderAt('2026-10-04T12:00:00', '2026-09', sep)
    const amazon = [...section(root, 'Repeat merchants')!.querySelectorAll('.an-row')].find((r) => r.querySelector('.an-name')?.textContent === 'Amazon')!
    expect(amazon.querySelector('.an-fig')?.textContent).toBe('$120.00')
    expect(amazon.querySelector('.an-sub')?.textContent).toBe('3 charges · avg $60.00 · $60.00 refunded')
  })
})
