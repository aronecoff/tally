/**
 * The command bar's fixed phrasings. Parsing never touches data; planning only
 * reads it, and every plan names exactly the rows it would change.
 */
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../db/db'
import { parseCommand, parseDay, planCommand, type Command } from './commands'

const TODAY = '2026-09-29'

const cat = (id: number, name: string, kind: Category['kind'] = 'expense', monthlyBudget = 0): Category => ({
  id, name, kind, monthlyBudget, icon: 'tag', color: '#fff', sortOrder: id, updatedAt: 0,
})
const CATS: Category[] = [cat(1, 'Rent', 'expense', 2400), cat(2, 'Shopping'), cat(3, 'Dining', 'expense', 300), cat(4, 'Other'), cat(5, 'Salary', 'income')]

const tx = (id: number, date: string, amount: number, note: string, p: Partial<Transaction> = {}): Transaction => ({
  id, date, amount, note, type: 'expense', categoryId: null, account: 'Test Bank Checking (1111)', createdAt: 0, updatedAt: 0, ...p,
})
const TXNS: Transaction[] = [
  tx(1, '2026-09-01', 2400, 'Landlord LLC', { categoryId: 1, manual: true }),
  tx(2, '2026-09-28', 2400, 'Landlord LLC', { categoryId: 1 }),
  tx(3, '2026-09-15', 60, 'AMAZON MKTPL*AB12CD', { categoryId: 2 }),
  tx(4, '2026-09-20', -24.5, 'Amazon', { categoryId: 2 }),
  tx(5, '2026-09-21', 25, 'Robinhood'),
  tx(6, '2026-09-22', 25, 'Robinhood'),
  tx(8, '2026-09-12', 40, 'Venmo', { categoryId: 4 }),
  tx(9, '2026-09-24', 3000, 'Acme Payroll', { type: 'income', categoryId: 5 }),
  tx(10, '2026-08-30', 50, 'Bread in a Box'),
  tx(11, '2026-09-02', 99, 'Gone Store', { deleted: true }),
]

const parse = (s: string) => parseCommand(s, CATS, TODAY)
const command = (s: string): Command => {
  const p = parse(s)
  if (!p.ok) throw new Error(p.message)
  return p.command
}
const plan = (s: string) => planCommand(command(s), TXNS, CATS)

describe('days', () => {
  it('reads the usual ways of naming a day, nearest to today when the year is left off', () => {
    expect(parseDay('Oct 1', TODAY)).toBe('2026-10-01')
    expect(parseDay('october 1st', TODAY)).toBe('2026-10-01')
    expect(parseDay('1 oct', TODAY)).toBe('2026-10-01')
    expect(parseDay('10/1', TODAY)).toBe('2026-10-01')
    expect(parseDay('10/1/27', TODAY)).toBe('2027-10-01')
    expect(parseDay('2026-10-01', TODAY)).toBe('2026-10-01')
    expect(parseDay('tomorrow', TODAY)).toBe('2026-09-30')
    expect(parseDay('January 5', TODAY)).toBe('2027-01-05') // four months ahead beats eight back
    expect(parseDay('July 4', TODAY)).toBe('2026-07-04')
  })

  it('a month alone means its 1st', () => {
    expect(parseDay('October', TODAY)).toBe('2026-10-01')
    expect(parseDay('next month', TODAY)).toBe('2026-10-01')
    expect(parseDay('last month', TODAY)).toBe('2026-08-01')
  })

  it('is not fooled by days that do not exist or by other words', () => {
    expect(parseDay('feb 30', TODAY)).toBeNull()
    expect(parseDay('oct 1 please', TODAY)).toBeNull()
    expect(parseDay('shopping', TODAY)).toBeNull()
  })
})

describe('parsing', () => {
  it('move: what, then a day or a month', () => {
    expect(command('move rent to Oct 1')).toMatchObject({ kind: 'move', query: { text: 'rent', all: false }, to: '2026-10-01' })
    expect(command('count the rent in October.')).toMatchObject({ kind: 'move', query: { text: 'rent' }, to: '2026-10-01' })
    // A merchant with a preposition in its name still splits at the right one.
    expect(command('move Bread in a Box to 10/1')).toMatchObject({ kind: 'move', query: { text: 'bread in box' }, to: '2026-10-01' })
  })

  it('file: a merchant and a category, and "move … to <category>" is filing', () => {
    expect(command('file Corner Florist under shopping')).toMatchObject({ kind: 'file', query: { text: 'corner florist' }, category: { id: 2 } })
    expect(command('move amazon to dining')).toMatchObject({ kind: 'file', category: { id: 3 } })
    expect(command('put venmo in other')).toMatchObject({ kind: 'file', category: { id: 4 } })
    // A unique prefix is enough ('din' → Dining).
    expect(command('categorize amazon as din')).toMatchObject({ kind: 'file', category: { id: 3 } })
  })

  it('budget: four phrasings, spending categories only', () => {
    for (const s of ['set dining budget to 600', 'set budget for dining to $600', 'dining budget 600', 'budget dining 600']) {
      expect(command(s)).toMatchObject({ kind: 'budget', category: { id: 3 }, amount: 600 })
    }
    expect(command('set shopping budget to $1,200.50')).toMatchObject({ amount: 1200.5 })
    expect(parse('set gifts budget to 50')).toEqual({ ok: false, message: 'There is no spending category called "gifts".' })
    expect(parse('set salary budget to 50').ok).toBe(false)
  })

  it('hide: merchant words, an amount and a date in any mix', () => {
    expect(command('hide robinhood $25 sep 21')).toMatchObject({ kind: 'hide', query: { text: 'robinhood', amount: 25, date: '2026-09-21' } })
    expect(command('hide the $2,000 transfer')).toMatchObject({ kind: 'hide', query: { text: '', amount: 2000 } })
    expect(command('delete all venmo')).toMatchObject({ kind: 'hide', query: { text: 'venmo', all: true } })
  })

  it('anything else gets the examples, and a half-said command says what is missing', () => {
    expect(parse('hello').ok).toBe(false)
    expect(parse('hello')).toMatchObject({ message: expect.stringMatching(/^Try: move rent to Oct 1/) })
    expect(parse('move rent')).toMatchObject({ ok: false, message: expect.stringMatching(/where it goes/) })
    expect(parse('file amazon under gifts')).toMatchObject({ ok: false, message: expect.stringMatching(/category/) })
    expect(parse('hide the')).toMatchObject({ ok: false, message: expect.stringMatching(/Say which one/) })
  })
})

describe('planning', () => {
  it('move takes the most recent match not already there, and says how many others matched', () => {
    const p = plan('move rent to Oct 1')
    expect(p).toMatchObject({ ok: true, title: 'Move Landlord LLC $2,400.00 from Sep 28 to Oct 1', others: 1 })
    if (!p.ok) return
    expect(p.rows.map((r) => [r.t.id, r.before, r.after, r.to])).toEqual([
      [2, { date: '2026-09-28', manual: undefined }, { date: '2026-10-01', manual: true }, 'Oct 1'],
    ])
    expect(plan('move all rent to Oct 1')).toMatchObject({ ok: true, title: 'Move 2 transactions to Oct 1', others: 0 })
  })

  it('hide: amount and date narrow it; a date a few days off still finds it', () => {
    expect(plan('hide robinhood $25 sep 21')).toMatchObject({ ok: true, title: 'Hide Robinhood $25.00 from Sep 21', others: 0 })
    // No charge on Sep 24 itself: ±3 days finds Sep 21 and Sep 22, the newer first.
    const near = plan('hide robinhood $25 sep 24')
    expect(near).toMatchObject({ ok: true, others: 1 })
    if (near.ok) expect(near.rows.map((r) => [r.t.id, r.after, r.to])).toEqual([[6, { deleted: true, manual: true }, 'Hidden']])
    expect(plan('hide all robinhood')).toMatchObject({ ok: true, title: 'Hide 2 transactions' })
    expect(plan('hide gone store')).toEqual({ ok: false, message: 'Nothing matches "gone store".' })
  })

  it('file a merchant: every charge refiled, and a rule so new ones follow', () => {
    const p = plan('file amazon under dining')
    expect(p).toMatchObject({
      ok: true,
      title: 'File 2 Amazon charges under Dining, and new ones too',
      rule: { pattern: 'amazon', category: 'Dining', kind: 'expense', priority: 4 },
    })
    if (p.ok) expect(p.rows.map((r) => [r.t.id, r.after, r.to])).toEqual([[4, { categoryId: 3, manual: true }, 'Dining'], [3, { categoryId: 3, manual: true }, 'Dining']])
    // Already filed there: nothing to refile, but the rule still helps new charges.
    expect(plan('file amazon under shopping')).toMatchObject({ ok: true, title: 'New Amazon charges will go under Shopping', rows: [] })
    // Longer names get a stronger rule (lower number wins).
    expect(plan('file bread in a box under dining')).toMatchObject({ rule: { pattern: 'bread ?in ?box', priority: 2 } })
  })

  it('file one charge (an amount or a date given): no rule', () => {
    const p = plan('file amazon $60 under dining')
    expect(p).toMatchObject({ ok: true, title: 'File Amazon $60.00 under Dining', rule: undefined })
  })

  it('words that only matched a category name are not a merchant: no rule', () => {
    expect(plan('file rent under other')).toMatchObject({ ok: true, title: 'File 2 Rent charges under Other', rule: undefined })
  })

  it('will not file income under a spending category', () => {
    expect(plan('file acme payroll under dining')).toEqual({ ok: false, message: 'Those are income; Dining is an expense category.' })
  })

  it('budget: before and after, and says so when nothing would change', () => {
    expect(plan('set dining budget to 600')).toMatchObject({ ok: true, title: 'Set Dining budget to $600', budget: { before: 300, after: 600 } })
    expect(plan('set dining budget to 300')).toEqual({ ok: false, message: 'Dining is already $300.' })
  })

  it('a refund reads as money back in a preview', () => {
    const p = plan('hide amazon $24.50')
    expect(p).toMatchObject({ ok: true, title: 'Hide Amazon +$24.50 from Sep 20' })
  })
})
