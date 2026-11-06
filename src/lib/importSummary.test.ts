/**
 * The figures above the Import button are a promise about the ledger. Here that
 * promise is tested against what `importRows` then writes, for generated files and
 * every way of reading them. Every name and figure is invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db, type Category, type Transaction } from '../db/db'
import { importRows, rowEffect, stageRows, summarizeImport, undoImport, type SignMode, type StagedRow } from './csvImport'
import { readImportFile } from './importFile'
import { matchLedger } from './rowMatch'

const cats: Category[] = [
  { id: 1, name: 'Groceries', key: 'groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Salary', key: 'salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
]

/** The same run every time, so a failure can be looked at. */
function dice(seed: number) {
  let s = seed
  const next = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, below: (n: number) => Math.floor(next() * n), pick: <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)] }
}
type Dice = ReturnType<typeof dice>

const SPENDING = ['HARBOR COFFEE', 'CORNER MARKET', 'MOON BOOKS', 'PINE DINER', 'TRAIL BIKE SHOP', 'RENT PORTAL', 'CHECK 4417', 'ATM WITHDRAWAL', 'LATE FEE']
const COMING = ['ACME PAYROLL', 'ACME DIR DEP', 'INTEREST PAID', 'SIDE JOB', 'ACME RETURN', 'ORDER REFUND', 'ZELLE FROM A PERSON', 'STATEMENT CREDIT']
const MOVING = ['PAYMENT THANK YOU', 'ONLINE PAYMENT', 'TRANSFER TO SAVINGS', 'OPENING BALANCE', 'TOTAL', 'BANK CARD PAYMENT']

interface Row {
  date: string
  note: string
  amount: number
}

function monthOf(d: Dice): Row[] {
  const length = 1 + d.below(24)
  const month = Array.from({ length }, () => {
    const roll = d.next()
    const note = roll < 0.6 ? d.pick(SPENDING) : roll < 0.85 ? d.pick(COMING) : d.pick(MOVING)
    const figure = (1 + d.below(roll < 0.6 ? 40000 : 400000)) / 100
    const sign = roll < 0.6 ? -1 : roll < 0.85 ? 1 : d.pick([1, -1])
    return { date: `10/${String(1 + d.below(28)).padStart(2, '0')}/2026`, note, amount: sign * figure }
  })
  // A fare, a toll or a coffee comes twice in a day, the same to the cent.
  return month.flatMap((row) => (d.next() < 0.25 ? [row, row] : d.next() < 0.05 ? [row, row, row] : [row]))
}

const f = (n: number) => n.toFixed(2)
const abs = (n: number) => f(Math.abs(n))
const thousands = (n: number) => `"${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"`

/** A month written the ways exports write one. */
const LAYOUTS: ((rows: Row[]) => string)[] = [
  (rows) => ['Date,Description,Amount', ...rows.map((r) => `${r.date},${r.note},${f(r.amount)}`)].join('\n'),
  (rows) => ['Date,Description,Amount', ...rows.map((r) => `${r.date},${r.note},${f(-r.amount)}`)].join('\n'),
  (rows) => ['Date,Description,Amount,Balance', ...rows.map((r) => `${r.date},${r.note},${thousands(r.amount)},${thousands(5000 + r.amount)}`)].join('\n'),
  (rows) => ['Date,Description,Amount,Balance', ...rows.map((r) => `${r.date},${r.note},${f(r.amount)},5,${String(100 + Math.round(Math.abs(r.amount)) % 900)}.00`)].join('\n'),
  (rows) => ['Date,Description,Debit,Credit', ...rows.map((r) => `${r.date},${r.note},${r.amount < 0 ? abs(r.amount) : ''},${r.amount > 0 ? abs(r.amount) : ''}`)].join('\n'),
  (rows) => ['Date,Description,Amount,Transaction Type', ...rows.map((r) => `${r.date},${r.note},${abs(r.amount)},${r.amount < 0 ? 'Debit' : 'Credit'}`)].join('\n'),
  (rows) => ['Date,Description,Amount', ...rows.map((r) => `${r.date},${r.note},${abs(r.amount)}${r.amount > 0 ? ' CR' : ''}`)].join('\n'),
  (rows) => ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo', ...rows.map((r) => `${r.date},${r.date},${r.note},Other,${r.amount < 0 ? 'Sale' : 'Return'},${f(r.amount)},`)].join('\n'),
  (rows) => ['Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By', ...rows.map((r) => `${r.date},${r.date},${r.note},${r.note},Other,${r.amount < 0 ? 'Purchase' : 'Payment'},${f(-r.amount)},A Person`)].join('\n'),
  (rows) => `<OFX><STMTRS><BANKACCTFROM><ACCTID>1234</BANKACCTFROM>${rows.map((r, i) => `<STMTTRN><DTPOSTED>202610${r.date.slice(3, 5)}<TRNAMT>${f(r.amount)}<FITID>${i}<NAME>${r.note}</STMTTRN>`).join('')}</STMTRS></OFX>`,
  (rows) => `<OFX><CCSTMTRS><CCACCTFROM><ACCTID>5678</CCACCTFROM>${rows.map((r, i) => `<STMTTRN><DTPOSTED>202610${r.date.slice(3, 5)}<TRNAMT>${f(r.amount)}<FITID>${i}<NAME>${r.note}</STMTTRN>`).join('')}</CCSTMTRS></OFX>`,
]

const MODES: SignMode[] = ['negative-expense', 'card-negative', 'card-positive']

/** What is in the ledger, added up here with nothing of the code under test. */
function fromLedger(written: Transaction[]) {
  const on = (test: (t: Transaction) => boolean) => written.filter(test)
  const total = (rows: Transaction[]) => rows.reduce((sum, t) => sum + Math.round(Math.abs(t.amount) * 100), 0) / 100
  const income = on((t) => t.type === 'income')
  const spent = on((t) => t.type === 'expense' && t.amount > 0)
  const back = on((t) => t.type === 'expense' && t.amount < 0)
  return { rows: written.length, moneyIn: total(income), moneyOut: total(spent), refunds: total(back), income, spent }
}

function expectLargest(largest: { note: string; amount: number } | undefined, side: Transaction[]) {
  if (side.length === 0) return expect(largest).toBeUndefined()
  const most = Math.max(...side.map((t) => Math.abs(t.amount)))
  expect(largest?.amount).toBe(most)
  expect(side.filter((t) => Math.abs(t.amount) === most).map((t) => t.note)).toContain(largest?.note)
}

/** How many imports had each kind of figure, so the run is known to reach them. */
const reached = { in: 0, out: 0, refunds: 0, both: 0 }

async function checkAgainstLedger(staged: StagedRow[], chosen: StagedRow[], bringBack = false) {
  const summary = summarizeImport(chosen)
  reached.in += Number(summary.moneyIn > 0)
  reached.out += Number(summary.moneyOut > 0)
  reached.refunds += Number(summary.refunds > 0)
  reached.both += Number(summary.moneyIn > 0 && summary.moneyOut > 0 && summary.refunds > 0)
  const { at, imported } = await importRows(staged, { chosen, bringBack })
  const written = (await db.transactions.toArray()).filter((t) => !t.deleted && t.createdAt === at)
  const ledger = fromLedger(written)
  expect(imported).toBe(chosen.length)
  expect(summary).toMatchObject({ rows: ledger.rows, moneyIn: ledger.moneyIn, moneyOut: ledger.moneyOut, refunds: ledger.refunds })
  expectLargest(summary.largestIn, ledger.income)
  expectLargest(summary.largestOut, ledger.spent)
  return at
}

/** The rows a person leaves ticked: mostly what the sheet starts with, and a few changed. */
const tick = (d: Dice, rows: StagedRow[]) => rows.filter((r) => (d.next() < 0.15 ? r.movement : !r.movement))

describe('the figures above the Import button', () => {
  let clock = 1_800_000_000_000

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => ++clock)
    await db.transactions.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('equal what the import writes, for every layout and way of reading it', async () => {
    const d = dice(20261106)
    let staged = 0
    for (let n = 0; n < 220; n++) {
      const month = monthOf(d)
      const write = LAYOUTS[n % LAYOUTS.length]
      const file = await readImportFile(new Blob([`${write(month)}\n`]))
      for (const mode of MODES) {
        await db.transactions.clear()
        const paid = mode === 'negative-expense' ? undefined : file.paid
        const { rows } = stageRows(file.rows, file.cols, mode, cats, { ids: file.ids, cards: file.cards, kinds: file.kinds, paid, account: file.account })
        staged += rows.length
        const chosen = tick(d, rows)
        const at = await checkAgainstLedger(rows, chosen)
        // Taken back out and brought in again with the rest, as the sheet offers.
        await undoImport(at)
        const { fresh, removed } = matchLedger(rows, await db.transactions.toArray())
        await checkAgainstLedger(rows, tick(d, [...fresh, ...removed]), true)
      }
    }
    expect(staged).toBeGreaterThan(5000)
    for (const count of Object.values(reached)) expect(count).toBeGreaterThan(100)
  }, 60_000)

  it('leave out rows already in the ledger, as the import does', async () => {
    const d = dice(7)
    for (let n = 0; n < 30; n++) {
      await db.transactions.clear()
      const file = await readImportFile(new Blob([`${LAYOUTS[0](monthOf(d))}\n`]))
      const { rows } = stageRows(file.rows, file.cols, 'negative-expense', cats)
      await importRows(rows.filter(() => d.next() < 0.5))
      const { fresh } = matchLedger(rows, await db.transactions.toArray())
      await checkAgainstLedger(rows, fresh)
    }
  })

  it('hold for a later file that repeats a row, and for the one left out of an earlier import', async () => {
    const d = dice(11)
    let repeats = 0
    for (let n = 0; n < 60; n++) {
      await db.transactions.clear()
      const month = monthOf(d)
      const file = await readImportFile(new Blob([`${LAYOUTS[0](month)}\n`]))
      const { rows } = stageRows(file.rows, file.cols, 'negative-expense', cats)
      repeats += rows.filter((r) => r.uid.endsWith(':1')).length
      // Any part of the file came in before, by this file or an earlier window of it.
      const earlier = rows.filter(() => d.next() < 0.5)
      await importRows(rows, { chosen: earlier })
      const { fresh } = matchLedger(rows, await db.transactions.toArray())
      expect(fresh).toHaveLength(rows.length - earlier.length)
      await checkAgainstLedger(rows, tick(d, fresh))
      const left = matchLedger(rows, await db.transactions.toArray()).fresh
      await checkAgainstLedger(rows, left)
      expect(matchLedger(rows, await db.transactions.toArray()).fresh).toEqual([])
    }
    expect(repeats).toBeGreaterThan(50)
  })

  it('hold where the row already here came from a bank or a person, with no id from the file', async () => {
    const file = await readImportFile(new Blob(['Date,Description,Amount\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/06/2026,CORNER MARKET,-30.00\n']))
    const { rows } = stageRows(file.rows, file.cols, 'negative-expense', cats)
    await db.transactions.add({ uid: 'sf:1', date: '2026-10-05', amount: 2.75, type: 'expense', note: 'CITY TRANSIT FARE', categoryId: null, account: '', createdAt: 1, updatedAt: 1 })
    const { fresh, here } = matchLedger(rows, await db.transactions.toArray())
    expect([fresh.length, here.length]).toEqual([2, 1])
    await checkAgainstLedger(rows, fresh)
    expect(await db.transactions.count()).toBe(3)
  })

  it('count a row the write finds already here, and write no row left unticked', async () => {
    const file = await readImportFile(new Blob(['Date,Description,Amount\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/06/2026,CORNER MARKET,-30.00\n']))
    const { rows } = stageRows(file.rows, file.cols, 'negative-expense', cats)
    expect(await importRows(rows, { chosen: [rows[1]] })).toMatchObject({ imported: 1, skipped: 0 })
    expect(await importRows(rows, { chosen: [rows[1], rows[2]] })).toMatchObject({ imported: 1, skipped: 1 })
    expect((await db.transactions.toArray()).map((t) => t.uid).sort()).toEqual([rows[1].uid, rows[2].uid].sort())
  })

  it('bring back only the removed rows a person chose', async () => {
    const file = await readImportFile(new Blob(['Date,Description,Amount\n10/05/2026,HARBOR COFFEE,-4.50\n10/06/2026,CORNER MARKET,-30.00\n']))
    const { rows } = stageRows(file.rows, file.cols, 'negative-expense', cats)
    await undoImport((await importRows(rows)).at)
    expect(await importRows(rows, { chosen: [rows[0]], bringBack: true })).toMatchObject({ imported: 1 })
    expect((await db.transactions.toArray()).filter((t) => !t.deleted).map((t) => t.note)).toEqual(['HARBOR COFFEE'])
  })

  it('say nothing of a side with no rows, and never count a row twice', () => {
    expect(summarizeImport([])).toEqual({ rows: 0, moneyIn: 0, moneyOut: 0, refunds: 0, largestIn: undefined, largestOut: undefined })
    const rows = [
      { note: 'ACME PAYROLL', amount: 2210, type: 'income' as const },
      { note: 'ACME RETURN', amount: -40, type: 'expense' as const },
      { note: 'HARBOR COFFEE', amount: 12.34, type: 'expense' as const },
      { note: 'CORNER MARKET', amount: 12.34, type: 'expense' as const },
    ]
    expect(summarizeImport(rows)).toEqual({
      rows: 4, moneyIn: 2210, moneyOut: 24.68, refunds: 40,
      largestIn: { note: 'ACME PAYROLL', amount: 2210 },
      largestOut: { note: 'HARBOR COFFEE', amount: 12.34 },
    })
    expect(rows.map(rowEffect)).toEqual(['in', 'refund', 'out', 'out'])
  })

  it('add up in cents, so a long file does not drift', () => {
    const rows = Array.from({ length: 1000 }, () => ({ note: 'HARBOR COFFEE', amount: 0.1, type: 'expense' as const }))
    expect(summarizeImport(rows).moneyOut).toBe(100)
  })
})
