/**
 * The command bar's fixed phrasings. Parsing never touches data; planning only
 * reads it, and every plan names exactly the rows it would change.
 */
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../db/db'
import { parseCommand, parseDay, parseQuery, planCommand, rowParts, type Command } from './commands'

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
const plan = (s: string) => planCommand(command(s), TXNS, CATS, { today: TODAY })

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
    expect(parse('set gifts budget to 50')).toEqual({ ok: false, message: 'There is no spending category called "gifts". Yours: Rent, Shopping, Dining, Other.' })
    expect(parse('set salary budget to 50').ok).toBe(false)
  })

  it('hide: merchant words, an amount and a date in any mix', () => {
    expect(command('hide robinhood $25 sep 21')).toMatchObject({ kind: 'hide', query: { text: 'robinhood', amount: 25, date: '2026-09-21' } })
    expect(command('hide the $2,000 transfer')).toMatchObject({ kind: 'hide', query: { text: '', amount: 2000 } })
    expect(command('delete all venmo')).toMatchObject({ kind: 'hide', query: { text: 'venmo', all: true } })
  })

  it('anything else gets a short line (the sheet shows the examples), and a half-said command says what is missing', () => {
    expect(parse('hello').ok).toBe(false)
    expect(parse('hello')).toMatchObject({ message: 'Tally did not understand that.' })
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
      [2, { date: '2026-09-28', manual: undefined, dateMoved: undefined }, { date: '2026-10-01', manual: true, dateMoved: true }, 'Oct 1'],
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
    // A charge and a refund: "transactions", not "charges" (B48).
    expect(p).toMatchObject({
      ok: true,
      title: 'File 2 Amazon transactions under Dining, and new ones too',
      rule: { pattern: '(?:^|[^a-z0-9])amazon(?![a-z0-9])', category: 'Dining', kind: 'expense', priority: 4 },
    })
    if (p.ok) expect(p.rows.map((r) => [r.t.id, r.after, r.to])).toEqual([[4, { categoryId: 3, manual: true }, 'Dining'], [3, { categoryId: 3, manual: true }, 'Dining']])
    // Already filed there: nothing to refile, but the rule still helps new charges.
    expect(plan('file amazon under shopping')).toMatchObject({ ok: true, title: 'New Amazon charges will go under Shopping', rows: [] })
    // The rule keeps the merchant's own words, so it matches it (B09); every
    // Tell Tally rule has one priority and the newest wins a tie (B10).
    const box = plan('file bread in a box under dining')
    expect(box).toMatchObject({ rule: { priority: 4 } })
    expect(box.ok && new RegExp(box.rule!.pattern, 'i').test('Bread in a Box')).toBe(true)
  })

  it('file one charge (an amount or a date given): no rule', () => {
    const p = plan('file amazon $60 under dining')
    expect(p).toMatchObject({ ok: true, title: 'File Amazon Mktpl $60.00 from Sep 15 under Dining', rule: undefined })
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

describe('filing a bank payment as Rent', () => {
  const zelle = tx(20, '2026-09-27', 2400, 'Zelle to J Quince', { uid: 'sf:z1' })
  // Planned on TODAY, never the real clock: a day in another year than today's
  // is written with its year, so these failed from the first day of 2027.
  it('moves it to the 1st it pays for, says so, and keeps the old date for Undo', () => {
    const p = planCommand(command('file zelle to j quince under rent'), [zelle], CATS, { today: TODAY })
    if (!p.ok) throw new Error(p.message)
    expect(p.rows[0].after).toEqual({ categoryId: 1, manual: true, date: '2026-10-01', posted: '2026-09-27', dateMoved: true })
    expect(p.rows[0].before).toEqual({ categoryId: null, manual: undefined, date: '2026-09-27', posted: undefined, dateMoved: undefined })
    expect(p.rows[0].to).toBe('Rent · Oct 1')
  })
  it("filed out of Rent, the bank's day put back is not a move", () => {
    const rent = tx(24, '2026-10-01', 2400, 'Zelle to J Quince', { uid: 'sf:z4', categoryId: 1, posted: '2026-09-27', dateMoved: true })
    const p = planCommand(command('file zelle to j quince under shopping'), [rent], CATS, { today: TODAY })
    if (!p.ok) throw new Error(p.message)
    expect(p.rows[0].after).toMatchObject({ date: '2026-09-27', dateMoved: false })
    expect(p.rows[0].before).toMatchObject({ date: '2026-10-01', posted: '2026-09-27', dateMoved: true })
  })
  it('a hand-typed row, a refund, or a payment before the 20th keeps its date', () => {
    const typed = tx(21, '2026-09-27', 2400, 'Zelle to J Quince')
    const back = tx(22, '2026-09-27', -2400, 'Zelle to J Quince', { uid: 'sf:z2' })
    const early = tx(23, '2026-09-12', 2400, 'Zelle to J Quince', { uid: 'sf:z3' })
    for (const t of [typed, back, early]) {
      const p = planCommand(command('file zelle to j quince under rent'), [t], CATS, { today: TODAY })
      if (!p.ok) throw new Error(p.message)
      expect(p.rows[0].after).toEqual({ categoryId: 1, manual: true })
      expect(p.rows[0].to).toBe('Rent')
    }
  })
})

// ---- Fixes from the Oct 4 hunt (B01 … B86). Invented rows only. ------------
const run = (s: string, txns: Transaction[], today = TODAY, cats = CATS, opts: Parameters<typeof planCommand>[3] = {}) => {
  const parsed = parseCommand(s, cats, today)
  if (!parsed.ok) return parsed
  return planCommand(parsed.command, txns, cats, { today, ...opts })
}
const ids = (p: ReturnType<typeof run>) => (p.ok ? p.rows.map((r) => r.t.id) : p.message)

describe('B01: a day with nothing on it', () => {
  const WEEK = [
    tx(201, '2026-09-22', 12, 'Corner Deli'),
    tx(202, '2026-09-24', 3000, 'Acme Payroll', { type: 'income', categoryId: 5 }),
    tx(203, '2026-09-24', 30, 'Kettle Shop'),
    tx(204, '2026-09-26', 31, 'Kettle Shop'),
    tx(205, '2026-09-27', 32, 'Kettle Shop'),
    tx(206, '2026-09-28', 9, 'Corner Deli'),
    tx(207, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(208, '2026-10-01', 15, 'Corner Deli'),
  ]
  it('a bare day means that day: nothing is taken from the days around it', () => {
    for (const s of ['hide all transactions on sep 25', 'hide sep 25', 'move all sep 25 to oct 2', 'file oct 3 under other']) {
      const p = run(s, WEEK)
      expect(p.ok, s).toBe(false)
      expect(!p.ok && p.message, s).toMatch(/^Nothing on (Sep 25|Oct 3)\./)
    }
  })
  it('"all" never acts on a ±3-day window', () => {
    expect(run('hide all kettle shop sep 25', WEEK)).toMatchObject({ ok: false, message: expect.stringMatching(/^Nothing on Sep 25\b.*Sep 26/) })
  })
  it('one row: the nearest day wins, the newer on a tie, and the preview says so', () => {
    const p = run('hide kettle shop sep 25', WEEK)
    expect(ids(p)).toEqual([204])
    expect(p.ok && p.notes?.join(' ')).toMatch(/Nothing on Sep 25/)
  })
})

describe('B06: move takes the most recent and never reaches past it', () => {
  const RENTS = [
    tx(301, '2026-08-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(302, '2026-09-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(303, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1 }),
  ]
  const T = '2026-10-04'
  it('the newest is already there: it says so, amounts included', () => {
    for (const s of ['move rent to Oct 1', 'move rent to October', 'count rent in October', 'move rent $2,400 to Oct 1', 'move landlord llc 2400 to oct 1']) {
      expect(run(s, RENTS, T), s).toEqual({ ok: false, message: 'Landlord LLC $2,400.00 is already on Oct 1.' })
    }
  })
  it('a named day still moves that row, and a day a few off finds the one not there yet', () => {
    expect(ids(run('move rent sep 1 to oct 1', RENTS, T))).toEqual([302])
    const two = [tx(311, '2026-09-28', 2400, 'Landlord LLC', { categoryId: 1 }), tx(312, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1 })]
    expect(ids(run('move rent sep 29 to oct 1', two, T))).toEqual([311])
  })
  it('a move into a month that already has the same charge says so', () => {
    const p = run('move rent to Sep 1', RENTS, T)
    expect(ids(p)).toEqual([303])
    expect(p.ok && p.notes?.join(' ')).toMatch(/September already has Landlord LLC \$2,400\.00 on Sep 1/)
  })

  // Rent paid in September's last week is dated Oct 1 and still pending: the
  // case the rent-early rule exists for. Skipping the pending row moved
  // September's rent onto Oct 1 again.
  const EARLY = [
    tx(321, '2026-08-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(322, '2026-09-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(323, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1, pending: true }),
  ]
  it('the newest still pending: never reaches past it to September', () => {
    for (const s of ['move rent to Oct 1', 'move rent to October', 'count rent in October', 'move rent $2,400 to Oct 1', 'move landlord llc to oct 1']) {
      expect(run(s, EARLY, '2026-09-30'), s).toEqual({ ok: false, message: 'Landlord LLC $2,400.00 is already on Oct 1.' })
    }
    expect(run('move rent to Oct 2', EARLY, '2026-09-30')).toEqual({
      ok: false,
      message: 'The most recent, Landlord LLC $2,400.00 on Oct 1, is still pending. Try again once it posts, or add a day to pick an older one.',
    })
    expect(run('hide rent', EARLY, '2026-09-30')).toMatchObject({ ok: false, message: expect.stringMatching(/^The most recent, Landlord LLC \$2,400\.00 on Oct 1, is still pending/) })
  })
  it('a named day still moves it, and the pending rent in the month it moves to is named', () => {
    const p = run('move rent sep 1 to oct 1', EARLY, '2026-09-30')
    expect(ids(p)).toEqual([322])
    expect(p.ok && p.notes?.join(' ')).toMatch(/October already has Landlord LLC \$2,400\.00 on Oct 1 \(pending\)/)
  })
})

describe('B45: a charge and its refund', () => {
  const PAIR = [
    tx(451, '2026-09-22', 111.11, 'Kettle Shop'),
    tx(452, '2026-09-25', -111.11, 'Kettle Shop'),
    tx(453, '2026-09-10', 18, 'Kettle Shop'),
  ]
  const spent = (rows: Transaction[], gone: (number | undefined)[]) => rows.filter((t) => !gone.includes(t.id)).reduce((n, t) => n + t.amount, 0)
  it('an amount with no sign hides the pair, so spending does not change', () => {
    const p = run('hide kettle shop $111.11', PAIR)
    expect(ids(p)).toEqual([451, 452])
    expect(p.ok && p.title).toBe('Hide Kettle Shop $111.11 (Sep 22) and its refund +$111.11 (Sep 25)')
    expect(spent(PAIR, [451, 452])).toBe(spent(PAIR, []))
  })
  it('"refund" or a plus picks the refund; a day picks the charge', () => {
    expect(ids(run('hide kettle shop refund $111.11', PAIR))).toEqual([452])
    expect(ids(run('hide kettle shop +$111.11', PAIR))).toEqual([452])
    expect(ids(run('hide kettle shop $111.11 sep 22', PAIR))).toEqual([451])
  })
  it('a plus inside a name is not a sign', () => {
    expect(parseQuery('disney+ $13.99', TODAY)).toMatchObject({ text: 'disney', amount: 13.99, sign: undefined })
    expect(parseQuery('kettle shop +$111.11', TODAY)).toMatchObject({ sign: 'in' })
  })
  it('move takes the charge, not its refund, and names the refund', () => {
    const p = run('move kettle shop $111.11 to oct 1', PAIR)
    expect(ids(p)).toEqual([451])
    expect(p.ok && p.notes?.join(' ')).toMatch(/refund/)
  })
  it('an amount with a day already named: the hint does not ask for an amount', () => {
    const p = run('hide kettle shop', PAIR)
    expect(p.ok && p.notes?.join(' ')).toMatch(/Add an amount, a day or a month/)
    const q = run('hide kettle shop $18', [...PAIR, tx(454, '2026-08-10', 18, 'Kettle Shop')])
    expect(q.ok && q.notes?.join(' ')).toMatch(/Add a day or a month/)
  })
})

describe('B46: an amount or a day names one charge, for file too', () => {
  const TWO = [tx(461, '2026-09-15', 60, 'AMAZON MKTPL*AB12CD', { categoryId: 2 }), tx(462, '2026-08-15', 60, 'AMAZON MKTPL*ZZ99YY', { categoryId: 2 })]
  it('picks the most recent, and "all" still takes every one', () => {
    expect(run('file amazon $60 under dining', TWO)).toMatchObject({ ok: true, others: 1, rows: [{ t: { id: 461 } }] })
    expect(ids(run('file all amazon $60 under dining', TWO))).toEqual([461, 462])
    expect(run('file amazon under dining', TWO)).toMatchObject({ ok: true, rows: [{ t: { id: 461 } }, { t: { id: 462 } }], rule: { category: 'Dining' } })
  })
  it('the most recent already there: it says so, and never reaches past it to an older one', () => {
    const moved = [{ ...TWO[0], categoryId: 3 }, TWO[1]]
    expect(run('file amazon $60 under dining', moved)).toEqual({ ok: false, message: 'Amazon Mktpl $60.00 on Sep 15 is already under Dining.' })
  })
})

describe('B47: a day without a year', () => {
  it('a day about six months back is this year, not next', () => {
    expect(ids(run('hide rentals co 4/12', [tx(471, '2026-04-12', 1800, 'Rentals Co')], '2026-10-20'))).toEqual([471])
  })
  it('the 1st a rent paid early is filed on is this year', () => {
    expect(parseQuery('rent 10/1', '2026-09-28')).toMatchObject({ date: '2026-10-01' })
  })
  it('a move target takes the year of the day it moves from', () => {
    const p = parseCommand('move rentals co 4/12 to 4/14', CATS, '2026-10-20')
    expect(p).toMatchObject({ ok: true, command: { kind: 'move', to: '2026-04-14' } })
  })
  it('a day in another year shows its year', () => {
    const p = run('move rent to April 1', [tx(472, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1 })], '2026-10-04')
    expect(p.ok && p.title).toMatch(/to Apr 1, 2027$/)
  })
})

describe('B48: titles say what the rows are', () => {
  const MIX = [
    tx(481, '2026-10-01', 2400, 'Landlord LLC', { categoryId: 1 }),
    tx(482, '2026-10-01', 15, 'Corner Deli'),
    tx(483, '2026-10-01', 30, 'Hill Books'),
    tx(484, '2026-09-20', 30, 'Gadget Hut'),
    tx(485, '2026-09-20', -24.5, 'Amazon', { categoryId: 2 }),
    tx(486, '2026-09-21', 4, 'Gizmo Refund', { type: 'income' }),
    tx(487, '2026-09-22', 5, 'Gizmo Refund', { type: 'income' }),
    tx(488, '2026-09-23', 60, 'AMAZON MKTPL*AB12CD'),
    tx(489, '2026-09-23', 12, 'Amazon.com'),
  ]
  it('a day or an amount across merchants: "transactions", not one merchant, and Rent is called out', () => {
    const p = run('file all oct 1 under other', MIX)
    expect(p.ok && p.title).toBe('File 3 transactions from Oct 1 under Other')
    expect(p.ok && p.notes?.join(' ')).toMatch(/Includes Rent: Landlord LLC \$2,400\.00/)
    expect(run('file all $30 under other', MIX)).toMatchObject({ ok: true, title: 'File 2 transactions under Other' })
  })
  it('one refund keeps its plus; income rows are deposits; a merchant name stays', () => {
    expect(run('file amazon $24.50 under dining', MIX)).toMatchObject({ ok: true, title: 'File Amazon +$24.50 from Sep 20 under Dining' })
    expect(run('file gizmo refund under salary', MIX)).toMatchObject({ ok: true, title: 'File 2 Gizmo Refund deposits under Salary, and new ones too' })
    expect(run('file amazon under other', MIX)).toMatchObject({ ok: true, title: expect.stringMatching(/^File 3 Amazon (charges|transactions) under Other/) })
  })
})

describe('B50: months, possessives and "latest"', () => {
  const ROWS = [
    tx(501, '2026-08-05', 10, 'Amazon'),
    tx(502, '2026-09-05', 11, 'Amazon'),
    tx(503, '2026-09-25', 12, 'Amazon'),
    tx(504, '2026-10-02', 13, 'Amazon'),
    tx(505, '2026-09-30', 0.42, 'Interest Paid', { type: 'income' }),
  ]
  const T = '2026-10-04'
  it('in <month>, this month and last month scope "all"', () => {
    expect(ids(run('hide all amazon in september', ROWS, T))).toEqual([503, 502])
    expect(ids(run('hide all amazon this month', ROWS, T))).toEqual([504])
    expect(ids(run('hide all amazon last month', ROWS, T))).toEqual([503, 502])
    expect(parseQuery('amazon in april', T)).toMatchObject({ text: 'amazon', month: '2026-04' })
    expect(parseQuery('amazon in sep 2026', T)).toMatchObject({ text: 'amazon', month: '2026-09', amount: undefined })
  })
  it("a possessive day and 'latest' read as meant", () => {
    expect(ids(run("hide sep 30's interest", ROWS, T))).toEqual([505])
    expect(ids(run('hide sep 30’s interest', ROWS, T))).toEqual([505])
    expect(ids(run('hide latest amazon', ROWS, T))).toEqual([504])
  })
  it('a month-scoped file saves no rule, and "count rent in October" is still a move', () => {
    expect(run('file all amazon in september under shopping', ROWS, T)).toMatchObject({ ok: true, rule: undefined })
    expect(parseCommand('count rent in october', CATS, T)).toMatchObject({ ok: true, command: { kind: 'move', to: '2026-10-01' } })
  })

  const NAMES = [
    tx(511, '2026-09-10', 20, "JUNE'S PIZZA"),
    tx(512, '2026-08-10', 21, "JUNE'S PIZZA"),
    tx(513, '2026-09-12', 9, 'MAR VISTA CAFE'),
    tx(514, '2026-07-02', 9, 'MAR VISTA CAFE'),
    tx(515, '2026-09-20', 15, 'AUGUST HALL'),
    tx(516, '2026-09-21', 7, 'MAY WAH MARKET'),
    tx(517, '2026-09-03', 140, 'HOTEL AUGUST'),
  ]
  it('a month word inside a merchant name is the name', () => {
    expect(parseQuery("june's pizza", T)).toMatchObject({ text: 'june s pizza', month: undefined })
    expect(run("file june's pizza under dining", NAMES, T)).toMatchObject({ ok: true, rows: [{ t: { id: 511 } }, { t: { id: 512 } }] })
    const rule = run("file june's pizza under dining", NAMES, T)
    expect(rule.ok && rule.rule && new RegExp(rule.rule.pattern, 'i').test("JUNE'S PIZZA #4")).toBe(true)
    expect(ids(run('hide mar vista cafe', NAMES, T))).toEqual([513])
    expect(ids(run('hide all mar vista cafe', NAMES, T))).toEqual([513, 514])
    expect(run('file august hall under shopping', NAMES, T)).toMatchObject({ ok: true, rows: [{ t: { id: 515 } }], rule: { category: 'Shopping' } })
    expect(ids(run('hide may wah market', NAMES, T))).toEqual([516])
  })
  it('a month word last, or after "in", is the month; the name when the month finds nothing', () => {
    expect(ids(run('hide all amazon september', ROWS, T))).toEqual([503, 502])
    expect(ids(run('hide hotel august', NAMES, T))).toEqual([517])
    expect(ids(run('hide all september amazon', ROWS, T))).toEqual([503, 502])
  })
})

describe('B82: bare numbers', () => {
  it('a number in a merchant name is not an amount', () => {
    const rows = [tx(821, '2026-09-17', 7.46, 'PayPal Pay in 4'), tx(822, '2026-09-18', 4, 'Corner Deli')]
    expect(ids(run('file pay in 4 under shopping', rows))).toEqual([821])
  })
  it('a year after a comma is the year; an amount after a comma is still an amount', () => {
    expect(parseQuery('apple sep 23, 2026', TODAY)).toMatchObject({ text: 'apple', date: '2026-09-23', amount: undefined })
    expect(parseQuery('landlord sep 1, 2400', TODAY)).toMatchObject({ text: 'landlord', date: '2026-09-01', amount: 2400 })
    expect(parseQuery('$1,200.50', TODAY)).toMatchObject({ amount: 1200.5 })
  })
  it('a day that does not exist is said so', () => {
    expect(parse('hide apple sep 31')).toEqual({ ok: false, message: 'There is no Sep 31.' })
  })
})

describe('B83: signed out, no rule is promised', () => {
  it('the title and plan drop the rule, and say why', () => {
    const p = planCommand(command('file amazon under dining'), TXNS, CATS, { today: TODAY, rules: false })
    expect(p).toMatchObject({ ok: true, title: 'File 2 Amazon transactions under Dining', rule: undefined })
    expect(p.ok && p.notes?.join(' ')).toMatch(/Sign in to have new charges/)
    expect(planCommand(command('file amazon under shopping'), TXNS, CATS, { today: TODAY, rules: false })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Already filed under Shopping\. Sign in/),
    })
  })
})

describe('B84 · B85: long input and the fallback', () => {
  it('a very long line is refused at once', () => {
    const t0 = performance.now()
    expect(parse('move ' + 'a to '.repeat(4000) + 'x').ok).toBe(false)
    expect(parse('move rent to oct 1' + '.'.repeat(20000) + 'x').ok).toBe(false)
    expect(performance.now() - t0).toBeLessThan(200)
  })
  it('words it does not understand get a short line, not the examples again', () => {
    expect(parse('please do the thing with my money')).toEqual({ ok: false, message: 'Tally did not understand that.' })
  })
})

describe('B86: errors point at the part that is wrong', () => {
  const C = [...CATS, cat(6, 'Groceries')]
  const p = (s: string) => parseCommand(s, C, TODAY)
  it('file: an unknown category is named, with the real ones; a missing merchant is asked for', () => {
    expect(p('file amazon under travel')).toEqual({ ok: false, message: 'There is no category called "travel". Yours: Rent, Shopping, Dining, Other, Salary, Groceries.' })
    expect(p('file .* under other')).toMatchObject({ ok: false, message: expect.stringMatching(/^Say which charges/) })
    expect(p('file under other')).toMatchObject({ ok: false, message: expect.stringMatching(/^Say which charges/) })
    expect(p('file amazon under grocery')).toMatchObject({ ok: true, command: { category: { id: 6 } } })
    expect(p('set grocery budget to 500')).toMatchObject({ ok: true, command: { kind: 'budget', category: { id: 6 }, amount: 500 } })
  })
  it('budget: more verbs, "is", "a month", and clear words for the rest', () => {
    expect(p('raise dining budget to 900')).toMatchObject({ ok: true, command: { kind: 'budget', category: { id: 3 }, amount: 900 } })
    expect(p('lower the dining budget to 250')).toMatchObject({ ok: true, command: { amount: 250 } })
    expect(p('budget for dining is 600')).toMatchObject({ ok: true, command: { amount: 600 } })
    expect(p('set dining budget to 600 a month')).toMatchObject({ ok: true, command: { amount: 600 } })
    expect(p('raise dining budget by 100')).toMatchObject({ ok: false, message: expect.stringMatching(/^Say the new amount/) })
    expect(p('bump dining budget 100')).toMatchObject({ ok: false, message: expect.stringMatching(/^Say the new amount/) })
    expect(p('drop venmo $40')).toMatchObject({ ok: true, command: { kind: 'hide' } })
    expect(p('set budget to 7500')).toMatchObject({ ok: false, message: expect.stringMatching(/^Which category\?/) })
    expect(p('set dining budget to -600')).toEqual({ ok: false, message: 'A budget cannot be negative.' })
    expect(p('set dining budget to six hundred')).toMatchObject({ ok: false, message: expect.stringMatching(/^Give the amount as a number/) })
    expect(p('set gifts budget to 50')).toMatchObject({ ok: false, message: expect.stringMatching(/^There is no spending category called "gifts"\. Yours: Rent, Shopping, Dining, Other, Groceries\.$/) })
  })
})

describe('B09: a saved rule catches its own merchant and no other', () => {
  const R = [
    tx(901, '2026-09-10', 44, 'FEES.GOV ONLINE'),
    tx(902, '2026-09-11', 12, 'CHICK-FIL-A #01234'),
    tx(903, '2026-09-12', 30, 'Bread in a Box'),
    tx(904, '2026-09-13', 3, 'INTEREST ON DEPOSIT', { type: 'income' }),
    tx(905, '2026-09-14', 14.99, 'AMAZON PRIME*AB12CD'),
    tx(906, '2026-09-14', 40, 'PRIMEROSE SPORTS BAR'),
    tx(907, '2026-09-15', 2.99, 'GOOGLE *Google One'),
    tx(908, '2026-09-15', 13.99, 'GOOGLE *YouTube Premium'),
    tx(909, '2026-09-16', 9, 'CAPITAL ONE AUTOPAY'),
    tx(910, '2026-09-16', 80, 'CAPITAL GRILLE'),
    tx(911, '2026-09-17', 20, 'LA BOULANGERIE'),
    tx(912, '2026-09-17', 25, 'BARNES & NOBLE'),
    tx(913, '2026-09-18', 55, 'BLAST FITNESS'),
    tx(914, '2026-09-19', 4, 'The Last Bookstore'),
    tx(915, '2026-09-19', 3, 'LASTPASS.COM'),
    tx(916, '2026-09-20', 19, 'BILL.COM PAYABLES'),
    tx(917, '2026-09-21', 33, 'AMAZON.COM'),
    tx(918, '2026-09-21', 21, 'AMAZON MKTPL*ZZ12'),
  ]
  const ruleOf = (s: string) => {
    const p = run(s, R)
    if (!p.ok) throw new Error(p.message)
    return p
  }
  const catches = (s: string, note: string) => {
    const p = ruleOf(s)
    if (!p.rule) throw new Error(`no rule for ${s}`)
    return new RegExp(p.rule.pattern, 'i').test(note)
  }
  it('the rule matches the merchant it was made for', () => {
    expect(catches('file fees.gov under other', 'FEES.GOV ONLINE')).toBe(true)
    expect(catches('file chick-fil-a under dining', 'CHICK-FIL-A #01234')).toBe(true)
    expect(catches('file bread in a box under dining', 'Bread in a Box')).toBe(true)
    expect(catches('file interest on deposit under salary', 'INTEREST ON DEPOSIT')).toBe(true)
  })
  it('and not other merchants that share a word or a few letters', () => {
    expect(catches('file prime under shopping', 'PRIMEROSE SPORTS BAR')).toBe(false)
    expect(catches('file google one under shopping', 'GOOGLE *YouTube Premium')).toBe(false)
    expect(catches('file capital one under other', 'CAPITAL GRILLE')).toBe(false)
    expect(catches('file the last under other', 'LASTPASS.COM')).toBe(false)
    expect(catches('file the last under other', 'BLAST FITNESS')).toBe(false)
    expect(catches('file bill.com under other', 'AMAZON.COM')).toBe(false)
    expect(catches('file bill.com under other', 'LASTPASS.COM')).toBe(false)
  })
  it('the preview lists exactly what the rule catches', () => {
    expect(ids(ruleOf('file google one under shopping'))).toEqual([907])
    expect(ids(ruleOf('file capital one under other'))).toEqual([909])
  })
  it('too short or only symbols: rows are filed, no rule, and it says why', () => {
    for (const s of ['file la under other', 'file & under other']) {
      const p = ruleOf(s)
      expect(p.rule, s).toBeUndefined()
      expect(p.rows.length, s).toBe(1)
      expect(p.title, s).not.toMatch(/new ones too/)
      expect(p.notes?.join(' '), s).toMatch(/No rule saved/)
    }
  })
  it('filler around the name is dropped from the rule; an already-filed merchant still gets one', () => {
    const p = ruleOf('file the amazon charges under dining')
    expect(new RegExp(p.rule!.pattern, 'i').test('AMAZON MKTPL*ZZ12')).toBe(true)
    expect(new RegExp(p.rule!.pattern, 'i').test('PRIMEROSE SPORTS BAR')).toBe(false)
    expect(plan('file amazon under shopping')).toMatchObject({ ok: true, rows: [], rule: { category: 'Shopping' } })
  })
})

describe('B10: Tell Tally rules, newest first, and forgetting one', () => {
  it('every Tell Tally rule has the same priority, so the newest wins a tie', () => {
    const R = [tx(1001, '2026-09-10', 14.99, 'AMAZON PRIME*AB12CD'), tx(1002, '2026-09-11', 9, 'Bread in a Box')]
    expect(run('file amazon prime under dining', R)).toMatchObject({ rule: { priority: 4 } })
    expect(run('file amazon under dining', R)).toMatchObject({ rule: { priority: 4 } })
    expect(run('file bread in a box under dining', R)).toMatchObject({ rule: { priority: 4 } })
  })
  it('forget / stop filing / delete the rule: a forget command, never a hide', () => {
    for (const s of ['forget acmefm', 'stop filing acmefm', 'unfile acmefm', 'delete rule acmefm', 'remove the acmefm rule', 'delete the rule for acmefm']) {
      expect(parse(s), s).toMatchObject({ ok: true, command: { kind: 'forget', text: 'acmefm' } })
    }
    expect(parse('delete acmefm')).toMatchObject({ ok: true, command: { kind: 'hide' } })
  })
  it('forget plans to remove only Tell Tally rules (priority 4 and under)', () => {
    const userRules = [
      { match: /(?:^|[^a-z0-9])acmefm(?![a-z0-9])/i, pattern: '(?:^|[^a-z0-9])acmefm(?![a-z0-9])', category: 'Fun', kind: 'expense' as const, priority: 4 },
      { match: /acmefm/i, pattern: 'acmefm', category: 'Other', kind: 'expense' as const, priority: 35 },
    ]
    const p = planCommand(command('forget acmefm'), [], CATS, { today: TODAY, userRules })
    expect(p).toMatchObject({ ok: true, forget: [{ pattern: '(?:^|[^a-z0-9])acmefm(?![a-z0-9])', category: 'Fun' }] })
    expect(planCommand(command('forget acmefm'), [], CATS, { today: TODAY, userRules: userRules.slice(1) })).toMatchObject({ ok: false })
    expect(planCommand(command('forget acmefm'), [], CATS, { today: TODAY, userRules, rules: false })).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in/) })
  })
})

describe('B11: unhide', () => {
  const ROWS = [
    tx(1101, '2026-09-10', 30, 'Gadget Hut', { deleted: true, manual: true }),
    tx(1102, '2026-09-11', 30, 'Gadget Hut', { deleted: true }),
    tx(1103, '2026-09-12', 30, 'Gadget Hut'),
  ]
  it('finds rows removed by hand or by Tell Tally, never the bank\'s own tombstones', () => {
    const p = run('unhide gadget hut $30', ROWS)
    expect(ids(p)).toEqual([1101])
    expect(p.ok && p.rows[0].after).toEqual({ deleted: false })
    expect(run('restore all gadget hut', ROWS)).toMatchObject({ ok: true, rows: [{ t: { id: 1101 } }] })
  })
  it('a hide preview says where the row can be brought back', () => {
    const p = run('hide gadget hut', ROWS)
    expect(p.ok && p.notes?.join(' ')).toMatch(/Removed/)
  })
})

describe('B49: preview row parts', () => {
  it('name and amount come apart so the amount never ellipsizes', () => {
    expect(rowParts(tx(1, '2026-09-01', -24.5, 'Amazon'))).toEqual({ name: 'Amazon', amount: '+$24.50' })
    expect(rowParts(tx(1, '2026-09-01', 2400, 'Landlord LLC'))).toEqual({ name: 'Landlord LLC', amount: '$2,400.00' })
  })
})
