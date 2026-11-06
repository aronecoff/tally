/** Reading a file's rows into the ledger. Values are invented. */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db, type Category, type Transaction } from '../db/db'
import { importRows, lastImport, stageRows, undoImport, type SignMode } from './csvImport'
import { readImportFile } from './importFile'
import { matchLedger } from './rowMatch'

const COLS = { date: 0, note: 1, amount: 2 }
const cats: Category[] = [
  { id: 1, name: 'Groceries', key: 'groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Salary', key: 'salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
]

beforeEach(async () => {
  await db.transactions.clear()
})

describe('stageRows', () => {
  it('reads negatives as spending and the rest as money in', () => {
    const rows = [
      ['2026-06-03', 'Corner Market', '-54.20'],
      ['06/01/2026', 'Payroll', '3,200.00'],
    ]
    expect(stageRows(rows, COLS, 'negative-expense', cats).rows).toMatchObject([
      { date: '2026-06-03', amount: 54.2, type: 'expense', note: 'Corner Market' },
      { date: '2026-06-01', amount: 3200, type: 'income', note: 'Payroll' },
    ])
  })

  it('reads a plain figure as spending on a card file', () => {
    const { rows } = stageRows([['2026-06-03', 'Corner Market', '54.20']], COLS, 'card-positive', cats)
    expect(rows).toMatchObject([{ amount: 54.2, type: 'expense' }])
  })

  it('reports a row with no date, no amount or a zero, and says which', () => {
    const rows = [
      ['not a date', 'A', '-1.00'],
      ['2026-06-03', 'B', ''],
      ['2026-06-03', 'C', '0.00'],
      ['2026-06-03', 'D', 'n/a'],
    ]
    const staged = stageRows(rows, COLS, 'negative-expense', cats)
    expect(staged.rows).toEqual([])
    expect(staged.leftOut).toMatchObject([
      { line: 0, why: 'date', date: 'not a date', note: 'A' },
      { line: 1, why: 'amount', amount: '', note: 'B' },
      { line: 2, why: 'zero', note: 'C' },
      { line: 3, why: 'amount', amount: 'n/a', note: 'D' },
    ])
  })

  it('accounts for every row of a file', () => {
    const rows = [
      ['2026-06-03', 'A', '-1.00'],
      ['2026-13-40', 'B', '-2.00'],
      ['2026-06-05', 'C', '-3.00'],
    ]
    const staged = stageRows(rows, COLS, 'negative-expense', cats)
    expect(staged.rows.map((r) => r.line)).toEqual([0, 2])
    expect(staged.leftOut.map((r) => r.line)).toEqual([1])
  })

  it('never stages a date the calendar does not have, whichever way it reads', () => {
    const rows = [
      ['13/40/2026', 'A', '-1.00'],
      ['02/30/2026', 'B', '-2.00'],
    ]
    for (const order of ['month-first', 'day-first'] as const) {
      expect(stageRows(rows, COLS, 'negative-expense', cats, { order }).rows).toEqual([])
    }
  })

  it('reads a day-first file by the order it is given', () => {
    const rows = [['03/11/2026', 'Corner Market', '-5.00']]
    expect(stageRows(rows, COLS, 'negative-expense', cats, { order: 'day-first' }).rows[0].date).toBe('2026-11-03')
    expect(stageRows(rows, COLS, 'negative-expense', cats, { order: 'month-first' }).rows[0].date).toBe('2026-03-11')
  })

  it('needs a date and an amount column, and not a description', () => {
    const row = [['2026-06-03', 'Corner Market', '-54.20']]
    expect(stageRows(row, { ...COLS, date: -1 }, 'negative-expense', cats)).toEqual({ rows: [], leftOut: [] })
    expect(stageRows(row, { ...COLS, amount: -1 }, 'negative-expense', cats)).toEqual({ rows: [], leftOut: [] })
    expect(stageRows(row, { ...COLS, note: -1 }, 'negative-expense', cats).rows).toMatchObject([{ note: '' }])
  })

  it('never files spending under an income category', () => {
    const { rows } = stageRows([['2026-06-03', 'Payroll', '-20.00']], COLS, 'negative-expense', cats)
    expect(rows[0].categoryId).not.toBe(2)
  })
})

describe('a card file', () => {
  const stage = (note: string, amount: string, mode: SignMode) => stageRows([['2026-06-03', note, amount]], COLS, mode, cats).rows[0]

  it('reads money back from a merchant as a refund, not income, whichever way the file runs', () => {
    expect(stage('Corner Market', '12.00', 'card-negative')).toMatchObject({ type: 'expense', amount: -12, movement: false })
    expect(stage('Corner Market', '-12.00', 'card-positive')).toMatchObject({ type: 'expense', amount: -12, movement: false })
  })

  it('reads a charge as spending, whichever way the file runs', () => {
    expect(stage('Corner Market', '-12.00', 'card-negative')).toMatchObject({ type: 'expense', amount: 12 })
    expect(stage('Corner Market', '12.00', 'card-positive')).toMatchObject({ type: 'expense', amount: 12 })
  })

  it('never takes the issuer crediting the card for a refund', () => {
    expect(stage('CASH BACK REWARD', '25.00', 'card-negative').movement).toBe(true)
    expect(stage('AUTOMATIC PAYMENT', '500.00', 'card-negative').movement).toBe(true)
  })

  it('files a refund with the merchant, so it comes off that category', () => {
    expect(stage('WHOLE FOODS', '12.00', 'card-negative').categoryId).toBe(1)
  })

  it('reads a bank row money-in as income, and a merchant refund to a debit card as a refund', () => {
    expect(stage('Corner Market', '12.00', 'negative-expense')).toMatchObject({ type: 'income', amount: 12 })
    expect(stage('WHOLE FOODS REFUND', '12.00', 'negative-expense')).toMatchObject({ type: 'expense', amount: -12 })
  })

  it('leaves a figure the statement says is a card alone in a bank file beside it', () => {
    const rows = [
      ['2026-06-03', 'Corner Market', '12.00'],
      ['2026-06-03', 'Corner Market', '12.00'],
    ]
    const staged = stageRows(rows, COLS, 'card-positive', cats, { cards: [true, false] }).rows
    expect(staged).toMatchObject([{ type: 'expense', amount: 12 }, { type: 'income', amount: 12 }])
  })
})

describe('a file with a column for money out and one for money in', () => {
  const SPLIT = { date: 0, note: 1, amount: 2, inflow: 3 }

  it('reads each row by the column it is in, and ignores which way the file runs', () => {
    const rows = [
      ['2026-06-03', 'Corner Market', '12.00', ''],
      ['2026-06-04', 'Payroll', '', '3200.00'],
      ['2026-06-05', 'Harbor Coffee', '-6.00', '0.00'],
    ]
    expect(stageRows(rows, SPLIT, 'negative-expense', cats).rows).toMatchObject([
      { type: 'expense', amount: 12 },
      { type: 'income', amount: 3200 },
      { type: 'expense', amount: 6 },
    ])
    expect(stageRows(rows, SPLIT, 'card-positive', cats).rows[0]).toMatchObject({ type: 'expense', amount: 12 })
  })

  it('reads a single column when the two named are the same one', () => {
    const rows = [['2026-06-03', 'Corner Market', '-12.00'], ['2026-06-04', 'Payroll', '3200.00']]
    expect(stageRows(rows, { date: 0, note: 1, amount: 2, inflow: 2 }, 'negative-expense', cats).rows).toMatchObject([
      { type: 'expense', amount: 12 },
      { type: 'income', amount: 3200 },
    ])
  })

  it('leaves out a row with neither, and says so', () => {
    const { leftOut } = stageRows([['2026-06-03', 'Note only', '', '']], SPLIT, 'negative-expense', cats)
    expect(leftOut).toMatchObject([{ why: 'amount', note: 'Note only' }])
  })

  it('does not take one bad cell for a zero', () => {
    expect(stageRows([['2026-06-03', 'Corner Market', 'n/a', '5.00']], SPLIT, 'negative-expense', cats).leftOut).toMatchObject([{ why: 'amount' }])
  })
})

describe('rows that start unticked', () => {
  const movement = (note: string, amount: string, mode: SignMode) =>
    stageRows([['2026-06-03', note, amount]], COLS, mode, cats).rows[0].movement

  it('marks a card payment, whichever sign the file gives it', () => {
    expect(movement('PAYMENT THANK YOU', '500.00', 'negative-expense')).toBe(true)
    expect(movement('PAYMENT THANK YOU', '500.00', 'card-positive')).toBe(true)
    expect(movement('MOBILE PAYMENT - THANK YOU', '-500.00', 'card-positive')).toBe(true)
  })

  it('marks a transfer and a card bill paid from checking', () => {
    expect(movement('TRANSFER TO SAVINGS', '-200.00', 'negative-expense')).toBe(true)
    expect(movement('CHASE CREDIT CRD AUTOPAY', '-300.00', 'negative-expense')).toBe(true)
  })

  it('keeps a bill paid by autopay as spending, on a bank file and on a card file', () => {
    expect(movement('GEICO AUTOPAY', '-45.00', 'negative-expense')).toBe(false)
    expect(movement('GEICO AUTOPAY', '45.00', 'card-positive')).toBe(false)
  })

  it('keeps an everyday purchase and a pay check', () => {
    expect(movement('Corner Market', '-54.20', 'negative-expense')).toBe(false)
    expect(movement('Payroll', '3200.00', 'negative-expense')).toBe(false)
  })

  it('does not take a deposit on a bank file for a card being paid', () => {
    expect(movement('ACME CORP ACH CREDIT', '3200.00', 'negative-expense')).toBe(false)
    expect(movement('ONLINE PAYMENT FROM CLIENT', '150.00', 'negative-expense')).toBe(false)
  })

  it('reads a payment channel as the card being paid on a card file', () => {
    expect(movement('ONLINE PAYMENT', '-500.00', 'card-positive')).toBe(true)
  })
})

describe('importRows', () => {
  const stage = (rows: string[][]) => stageRows(rows, COLS, 'negative-expense', cats).rows
  const staged = stage([
    ['2026-06-03', 'Corner Market', '-54.20'],
    ['2026-06-04', 'Harbor Coffee', '-6.00'],
  ])
  const twoFares = stage([
    ['2026-06-05', 'Metro Fare', '-2.75'],
    ['2026-06-05', 'Metro Fare', '-2.75'],
  ])

  it('adds the rows', async () => {
    expect(await importRows(staged)).toMatchObject({ imported: 2, skipped: 0 })
    expect(await db.transactions.count()).toBe(2)
  })

  it('stores a transaction and nothing about the file', async () => {
    await importRows(staged)
    const [row] = await db.transactions.toArray()
    expect(row).not.toHaveProperty('line')
    expect(row).not.toHaveProperty('movement')
  })

  it('skips what is already here, so an overlapping statement is safe', async () => {
    await importRows(staged)
    expect(await importRows(staged)).toMatchObject({ imported: 0, skipped: 2 })
    expect(await db.transactions.count()).toBe(2)
  })

  it('keeps two identical rows in one file, because they are two payments', async () => {
    expect(await importRows(twoFares)).toMatchObject({ imported: 2, skipped: 0 })
    expect(await db.transactions.count()).toBe(2)
  })

  it('adds nothing when that same file comes in again', async () => {
    await importRows(twoFares)
    expect(await importRows(twoFares)).toMatchObject({ imported: 0, skipped: 2 })
    expect(await db.transactions.count()).toBe(2)
  })

  it('skips only as many as the ledger holds', async () => {
    await importRows(twoFares.slice(0, 1))
    expect(await importRows(twoFares)).toMatchObject({ imported: 1, skipped: 1 })
    expect(await db.transactions.count()).toBe(2)
  })

  it('adds the third fare from a longer statement', async () => {
    await importRows(twoFares)
    const three = stage(Array.from({ length: 3 }, () => ['2026-06-05', 'Metro Fare', '-2.75']))
    expect(await importRows(three)).toMatchObject({ imported: 1, skipped: 2 })
    expect(await db.transactions.count()).toBe(3)
  })

  it('keeps a removed row out when the file comes in again, as a bank row stays hidden', async () => {
    await importRows(twoFares)
    const [first] = await db.transactions.toArray()
    await db.transactions.update(first.id!, { deleted: true })
    expect(await importRows(twoFares)).toMatchObject({ imported: 0, skipped: 2 })
    expect(await db.transactions.filter((t) => !t.deleted).count()).toBe(1)
  })

  it('does not bring a row in twice after its words were edited', async () => {
    await importRows(staged)
    const [first] = await db.transactions.toArray()
    await db.transactions.update(first.id!, { note: 'Groceries for the week', manual: true })
    expect(await importRows(staged)).toMatchObject({ imported: 0, skipped: 2 })
  })

  it('skips a row typed in by hand that says the same', async () => {
    await db.transactions.add({ date: '2026-06-04', amount: 6, type: 'expense', categoryId: null, account: '', note: 'harbor coffee', createdAt: 1, updatedAt: 1 })
    expect(await importRows(staged)).toMatchObject({ imported: 1, skipped: 1 })
  })

  it('gives the same row the same id on every device, so a sync sees one row', async () => {
    await importRows(staged)
    const first = (await db.transactions.toArray()).map((t) => t.uid).sort()
    await db.transactions.clear()
    await importRows(stage([['2026-06-04', 'HARBOR COFFEE', '-6.00'], ['2026-06-03', 'corner market', '-54.20']]))
    expect((await db.transactions.toArray()).map((t) => t.uid).sort()).toEqual(first)
    expect(first.every((uid) => uid?.startsWith('file:'))).toBe(true)
  })

  it('stores the day a rent row posted beside the 1st it counts on', async () => {
    const rent: Category = { id: 3, name: 'Rent', key: 'rent', icon: 'home', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 }
    const rows = stageRows([['2026-05-28', 'RENT PAYMENT APT 4', '-1200.00']], COLS, 'negative-expense', [...cats, rent]).rows
    expect(rows).toMatchObject([{ date: '2026-06-01', posted: '2026-05-28', categoryId: 3 }])
    await importRows(rows)
    expect((await db.transactions.toArray())[0]).toMatchObject({ date: '2026-06-01', posted: '2026-05-28' })
  })
})

describe('a bank\u2019s own layout', () => {
  const read = async (text: string) => {
    const file = await readImportFile(new Blob([text]))
    return stageRows(file.rows, file.cols, file.sign, cats).rows
  }

  it('reads a Chase checking file by its Description, so a payment and a transfer start unticked', async () => {
    const rows = await read(`Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/03/2026,"TRADER JOES #123",-54.20,DEBIT_CARD,945.80,,
DEBIT,10/05/2026,"TEST BANK CREDIT CRD AUTOPAY",-300.00,ACH_DEBIT,645.80,,
DEBIT,10/06/2026,"ONLINE TRANSFER TO SAVINGS",-200.00,ACCT_XFER,445.80,,
CREDIT,10/07/2026,"ACME PAYROLL",3200.00,ACH_CREDIT,3645.80,,
`)
    expect(rows.map((r) => [r.note, r.movement])).toEqual([
      ['TRADER JOES #123', false],
      ['TEST BANK CREDIT CRD AUTOPAY', true],
      ['ONLINE TRANSFER TO SAVINGS', true],
      ['ACME PAYROLL', false],
    ])
    expect(rows[0].categoryId).toBe(1)
  })

  it('reads a US Bank file by its Name, and a payment that only its Memo names', async () => {
    const rows = await read(`Date,Transaction,Name,Memo,Amount
2026-10-03,DEBIT,TRADER JOES #123,Download from the bank,-54.20
2026-10-05,DEBIT,WEB AUTHORIZED PMT CARD SERVICES,Download from the bank. CREDIT CARD PAYMENT,-300.00
2026-10-07,CREDIT,ACME PAYROLL,Download from the bank,3200.00
`)
    expect(rows.map((r) => [r.note, r.movement])).toEqual([
      ['TRADER JOES #123', false],
      ['WEB AUTHORIZED PMT CARD SERVICES', true],
      ['ACME PAYROLL', false],
    ])
  })

  it('never takes a Transaction ID for what a row was', async () => {
    const rows = await read('Transaction ID,Date,Payee,Amount\n1234567890,10/03/2026,Corner Market,-54.20\n')
    expect(rows[0].note).toBe('Corner Market')
  })

  it('reads a merchant\u2019s credit on a Debit and Credit card file as a refund', async () => {
    const rows = await read('Status,Date,Description,Debit,Credit\nCleared,10/03/2026,TARGET,54.20,\nCleared,10/05/2026,TARGET,,-20.00\nCleared,10/06/2026,"ONLINE PAYMENT, THANK YOU",,-300.00\n')
    expect(rows.map((r) => [r.amount, r.type, r.movement])).toEqual([[54.2, 'expense', false], [-20, 'expense', false], [300, 'income', true]])
  })
})

describe('a bank id used twice', () => {
  const ofx = (rows: [string, string][]) => {
    const ids = rows.map(() => '123|SAME')
    return stageRows(rows.map(([day, amount]) => [day, 'Corner Market', amount]), COLS, 'negative-expense', cats, { ids }).rows
  }

  it('is one row when its day and money match', async () => {
    await importRows(ofx([['2026-06-03', '-54.20']]))
    expect(await importRows(ofx([['2026-06-03', '-54.20']]))).toMatchObject({ imported: 0, skipped: 1 })
  })

  it('is a new row when they do not, because the bank has used it over again', async () => {
    await importRows(ofx([['2026-06-03', '-54.20']]))
    expect(await importRows(ofx([['2026-06-20', '-9.00']]))).toMatchObject({ imported: 1 })
    expect(await db.transactions.count()).toBe(2)
  })
})

describe('the same row in two accounts\u2019 files', () => {
  const statement = (account: string) => stageRows([['2026-06-03', 'MONTHLY FEE', '-5.00']], COLS, 'negative-expense', cats, { ids: [`${account}|1`], account }).rows

  it('is shown as a look-alike, for someone to decide', async () => {
    await importRows(statement('Test Bank ··1111'))
    const { fresh, here, twins } = matchLedger(statement('Test Bank ··2222'), await db.transactions.toArray())
    expect(here).toEqual([])
    expect(fresh).toHaveLength(1)
    expect(twins.get(fresh[0])?.account).toBe('Test Bank ··1111')
  })

  it('is one row when both files are the same account', async () => {
    await importRows(statement('Test Bank ··1111'))
    expect(matchLedger(statement('Test Bank ··1111'), await db.transactions.toArray()).here).toHaveLength(1)
  })
})

describe('correcting an import', () => {
  const FILE = [
    ['2026-06-03', 'Corner Market', '54.20'],
    ['2026-06-04', 'Harbor Coffee', '6.00'],
  ]
  const asBank = () => stageRows(FILE, COLS, 'negative-expense', cats).rows
  const asCard = () => stageRows(FILE, COLS, 'card-positive', cats).rows
  const live = async () => (await db.transactions.toArray()).filter((t) => !t.deleted)

  it('finds the newest import, and only a file\u2019s rows', async () => {
    const hand: Transaction = { uid: 'x', date: '2026-06-01', amount: 1, type: 'expense', categoryId: null, account: '', note: 'x', createdAt: 9e12, updatedAt: 1 }
    await db.transactions.add(hand)
    expect(lastImport(await db.transactions.toArray())).toBeNull()
    const { at } = await importRows(asBank())
    expect(lastImport(await db.transactions.toArray())).toEqual({ at, rows: 2 })
  })

  it('takes out that import and nothing else, and goes back to the one before', async () => {
    await db.transactions.add({ uid: 'sf:bank:acct:1', date: '2026-06-03', amount: 54.2, type: 'expense', categoryId: null, account: 'Test Bank', note: 'Bank row', createdAt: 1, updatedAt: 1 })
    await db.transactions.add({ date: '2026-06-03', amount: 2, type: 'expense', categoryId: null, account: '', note: 'By hand', createdAt: 1, updatedAt: 1 })
    const first = await importRows(stageRows([['2026-05-01', 'Older Row', '-1.00']], COLS, 'negative-expense', cats).rows)
    await new Promise((r) => setTimeout(r, 2))
    const { at } = await importRows(asBank())
    expect(await undoImport(at)).toBe(2)
    expect((await live()).map((t) => t.note).sort()).toEqual(['Bank row', 'By hand', 'Older Row'])
    expect(lastImport(await db.transactions.toArray())).toEqual({ at: first.at, rows: 1 })
  })

  it('leaves a tombstone newer than the row, so the cloud and other devices hear', async () => {
    const { at } = await importRows(asBank())
    await db.transactions.toCollection().modify({ updatedAt: 1 })
    await undoImport(at)
    const [row] = await db.transactions.toArray()
    expect(row.deleted).toBe(true)
    expect(row.updatedAt).toBeGreaterThan(1)
  })

  it('tells the sync about what it takes out and what it brings back', async () => {
    const heard = vi.fn()
    db.transactions.hook('updating', heard)
    const { at } = await importRows(asBank())
    await undoImport(at)
    expect(heard).toHaveBeenCalledTimes(2)
    await importRows(asCard(), { bringBack: true })
    expect(heard).toHaveBeenCalledTimes(4)
    db.transactions.hook('updating').unsubscribe(heard)
  })

  it('keeps rows out on a plain re-import, whatever they read as now', async () => {
    const { at } = await importRows(asBank())
    await undoImport(at)
    expect(await importRows(asCard())).toMatchObject({ imported: 0, skipped: 2 })
    expect(await live()).toEqual([])
  })

  it('brings rows back as the file reads now, in their old places, as a new import', async () => {
    const { at } = await importRows(asBank())
    const [before] = await db.transactions.toArray()
    await undoImport(at)
    await new Promise((r) => setTimeout(r, 2))
    const again = await importRows(asCard(), { bringBack: true })
    expect(again).toMatchObject({ imported: 2, skipped: 0 })
    expect(await db.transactions.count()).toBe(2)
    const rows = await live()
    expect(rows.map((t) => [t.note, t.type, t.amount])).toEqual([['Corner Market', 'expense', 54.2], ['Harbor Coffee', 'expense', 6]])
    expect(rows[0]).toMatchObject({ id: before.id, uid: before.uid, deleted: false, createdAt: again.at, updatedAt: again.at })
    expect(lastImport(await db.transactions.toArray())).toEqual({ at: again.at, rows: 2 })
  })

  it('forgets what a person did to the row when it comes back, as a new reading', async () => {
    await importRows(asBank())
    const [first] = await db.transactions.toArray()
    await db.transactions.update(first.id!, { deleted: true, manual: true, uncategorized: true })
    await importRows(asCard(), { bringBack: true })
    const row = await db.transactions.get(first.id!)
    expect(row?.deleted).toBe(false)
    expect(row?.manual).toBeUndefined()
    expect(row?.uncategorized).toBeUndefined()
  })

  it('does not bring back a row removed since the preview unless asked', async () => {
    await importRows(asBank())
    const [first] = await db.transactions.toArray()
    const staged = asBank()
    await db.transactions.update(first.id!, { deleted: true, updatedAt: 2 })
    expect(await importRows(staged)).toMatchObject({ imported: 0 })
    expect(await live()).toHaveLength(1)
  })

  it('shows a removed row\u2019s look-alike, once a new row has had first pick', async () => {
    const { at } = await importRows(stageRows([['2026-06-03', 'Corner Market', '-54.20']], COLS, 'negative-expense', cats).rows)
    await undoImport(at)
    await db.transactions.add({ uid: 'sf:bank:acct:1', date: '2026-06-03', amount: 54.2, type: 'expense', categoryId: null, account: 'Test Bank', note: 'Bank words', createdAt: 1, updatedAt: 1 })
    const staged = stageRows([['2026-06-03', 'Other Words', '-54.20'], ['2026-06-03', 'Corner Market', '-54.20']], COLS, 'negative-expense', cats).rows
    const { fresh, removed, twins } = matchLedger(staged, await db.transactions.toArray())
    expect(twins.get(fresh[0])?.note).toBe('Bank words')
    expect(twins.has(removed[0])).toBe(false)
    expect(matchLedger(staged.slice(1), await db.transactions.toArray()).twins.size).toBe(1)
  })
})
