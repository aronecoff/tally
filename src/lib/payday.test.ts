/**
 * Whether the live month is still waiting for its pay. All values are invented.
 * Before payday a month has only spent, and a small credit (interest on the
 * 7th) used to switch the B32 fix off: Home, Budget and Insights read
 * 'Overspent' in red, equal to the whole month's spending, until pay landed.
 */
import { describe, expect, it } from 'vitest'
import { awaitingPay, PAY_SHARE, type PayRow } from './payday'

const SALARY = { id: 9, name: 'Salary', kind: 'income' as const }
const OTHER_INCOME = { id: 10, name: 'Other income', kind: 'income' as const }
const CATS = [{ id: 1, name: 'Rent', kind: 'expense' as const }, SALARY, OTHER_INCOME]

const spend = (date: string, amount: number, categoryId: number | null = 1): PayRow => ({ date, amount, type: 'expense', categoryId })
const income = (date: string, amount: number, categoryId: number | null): PayRow => ({ date, amount, type: 'income', categoryId })

/** August: two paychecks and a little interest. */
const AUGUST = [income('2026-08-07', 20.5, 10), income('2026-08-10', 3000, 9), income('2026-08-25', 3000, 9), spend('2026-08-01', 2400)]

describe('awaitingPay', () => {
  it('no income at all, with spending: waiting', () => {
    expect(awaitingPay('2026-09', [spend('2026-09-01', 2400)], AUGUST, CATS)).toBe(true)
  })

  it('interest before payday does not count as pay', () => {
    const sep = [spend('2026-09-01', 2400), spend('2026-09-03', 120), income('2026-09-06', 12.4, 10)]
    expect(awaitingPay('2026-09', sep, AUGUST, CATS)).toBe(true)
  })

  it('pay filed under Salary has landed, however small', () => {
    const sep = [spend('2026-09-01', 2400), income('2026-09-10', 900, 9)]
    expect(awaitingPay('2026-09', sep, AUGUST, CATS)).toBe(false)
  })

  it('a renamed Salary still counts by its key', () => {
    const cats = [CATS[0], { ...SALARY, name: 'Paycheck', key: 'salary' }, OTHER_INCOME]
    const sep = [spend('2026-09-01', 2400), income('2026-09-10', 900, 9)]
    expect(awaitingPay('2026-09', sep, AUGUST, cats)).toBe(false)
  })

  it('pay filed elsewhere has landed once it is a quarter of last month', () => {
    const lastMonth = 6020.5
    const under = Math.floor(lastMonth * PAY_SHARE * 100 - 1) / 100
    const sep = (amt: number) => [spend('2026-09-01', 2400), income('2026-09-10', amt, 10)]
    expect(awaitingPay('2026-09', sep(under), AUGUST, CATS)).toBe(true)
    expect(awaitingPay('2026-09', sep(3000), AUGUST, CATS)).toBe(false)
  })

  it('with no income last month, any income counts (as before)', () => {
    const sep = [spend('2026-09-01', 2400), income('2026-09-06', 12.4, 10)]
    expect(awaitingPay('2026-09', sep, [], CATS)).toBe(false)
  })

  it('a month that has not spent more than it took in is not waiting', () => {
    expect(awaitingPay('2026-09', [income('2026-09-06', 12.4, 10), spend('2026-09-08', 10)], AUGUST, CATS)).toBe(false)
    expect(awaitingPay('2026-09', [], AUGUST, CATS)).toBe(false)
    // Refunds only: money back, nothing spent.
    expect(awaitingPay('2026-09', [spend('2026-09-02', -40)], AUGUST, CATS)).toBe(false)
  })

  it('deleted rows and rows of other months are ignored', () => {
    const sep = [spend('2026-09-01', 2400), { ...income('2026-09-10', 3000, 9), deleted: true }, income('2026-10-01', 3000, 9)]
    expect(awaitingPay('2026-09', sep, AUGUST, CATS)).toBe(true)
    // Last month is read from any history: only August's income counts.
    const history = [...AUGUST, income('2026-06-10', 90000, 10)]
    expect(awaitingPay('2026-09', [spend('2026-09-01', 2400), income('2026-09-12', 3000, 10)], history, CATS)).toBe(false)
  })
})
