// @vitest-environment jsdom
/** Handing the ledger over as a CSV. The figures and merchants are invented. */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db, type Category, type Transaction } from '../db/db'
import { parseCsv } from './csv'
import { exportTransactions, transactionsCsv } from './exportCsv'

const cats: Category[] = [{ id: 1, name: 'Dining, out', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 }]
const tx = (over: Partial<Transaction>): Transaction => ({
  id: 1, uid: 'a', date: '2026-11-03', amount: 4.5, type: 'expense', note: 'Harbor Coffee', categoryId: 1, account: 'Test Bank ··1234', createdAt: 1, updatedAt: 1, ...over,
})

describe('transactionsCsv', () => {
  it('reads back through the importer’s own parser', () => {
    const { headers, rows } = parseCsv(transactionsCsv([tx({})], cats).slice(1))
    expect(headers).toEqual(['Date', 'Description', 'Amount', 'Type', 'Category', 'Account', 'Status'])
    expect(rows).toEqual([['2026-11-03', 'Harbor Coffee', '-4.50', 'Expense', 'Dining, out', 'Test Bank ··1234', 'Posted']])
  })

  it('signs money the way a bank’s export does', () => {
    const rows = parseCsv(transactionsCsv([tx({ id: 3, type: 'income', amount: 3200, categoryId: null }), tx({ id: 2, amount: -12, date: '2026-11-02' }), tx({ id: 1, date: '2026-11-01' })], cats).slice(1)).rows
    expect(rows.map((r) => [r[2], r[3]])).toEqual([['3200.00', 'Income'], ['12.00', 'Refund'], ['-4.50', 'Expense']])
  })

  it('leaves out removed rows, and says which are pending', () => {
    const rows = parseCsv(transactionsCsv([tx({ id: 1, deleted: true }), tx({ id: 2, pending: true })], cats).slice(1)).rows
    expect(rows).toHaveLength(1)
    expect(rows[0][6]).toBe('Pending')
  })

  it('sorts newest first, without touching the rows it was given', () => {
    const given = [tx({ id: 1, date: '2026-11-01' }), tx({ id: 2, date: '2026-11-03' })]
    expect(parseCsv(transactionsCsv(given, cats).slice(1)).rows.map((r) => r[0])).toEqual(['2026-11-03', '2026-11-01'])
  })

  it('keeps quotes, commas and line breaks in one cell', () => {
    const rows = parseCsv(transactionsCsv([tx({ note: 'Cafe "Harbor", Inc\nSF' })], cats).slice(1)).rows
    expect(rows[0][1]).toBe('Cafe "Harbor", Inc\nSF')
  })

  it('stops a spreadsheet running a bank’s text as a formula', () => {
    for (const note of ['=HYPERLINK("x")', '+1 800 555', '-5 fee', '@SUM(A1)']) {
      expect(parseCsv(transactionsCsv([tx({ note })], cats).slice(1)).rows[0][1]).toBe(`'${note}`)
    }
  })

  it('leaves the figures themselves as numbers', () => {
    expect(transactionsCsv([tx({})], cats)).toContain(',-4.50,')
  })

  it('starts with the mark that tells a spreadsheet it is UTF-8', () => {
    expect(transactionsCsv([], cats).charCodeAt(0)).toBe(0xfeff)
  })
})

describe('exportTransactions', () => {
  const created: Blob[] = []
  const clicks: string[] = []

  beforeEach(async () => {
    created.length = 0
    clicks.length = 0
    await db.transactions.clear()
    await db.categories.clear()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), 'blob:x'), revokeObjectURL: () => {} }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('says none when there is nothing to export, and hands nothing over', async () => {
    expect(await exportTransactions()).toBe(0)
    expect(created).toEqual([])
  })

  it('downloads in a browser, named for the app and the day', async () => {
    await db.transactions.add(tx({ id: undefined }))
    expect(await exportTransactions()).toBe(1)
    expect(clicks[0]).toMatch(/^tally-transactions-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(created[0].type).toBe('text/csv')
  })

  it('goes to the share sheet in the iPhone app, and leaves a closed sheet unsaid', async () => {
    const postMessage = vi.fn(async () => ({ completed: false }))
    vi.stubGlobal('webkit', { messageHandlers: { tally: { postMessage } } })
    await db.transactions.add(tx({ id: undefined }))
    expect(await exportTransactions()).toBeNull()
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ method: 'share.file' }))
    expect(clicks).toEqual([])
  })

  it('never strands the page in an older iPhone app with no way to save', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 TallyNative')
    await db.transactions.add(tx({ id: undefined }))
    await expect(exportTransactions()).rejects.toThrow('no_bridge')
    expect(clicks).toEqual([])
  })

  const WEBKIT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

  it('never strands the page in an older Mac app with no way to save', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WEBKIT)
    await db.transactions.add(tx({ id: undefined }))
    await expect(exportTransactions()).rejects.toThrow('no_bridge')
    expect(clicks).toEqual([])
  })

  it('downloads in a Mac app that says it can, and in a browser on a Mac', async () => {
    await db.transactions.add(tx({ id: undefined }))
    for (const agent of [`${WEBKIT} TallyMac`, `${WEBKIT} Version/19.0 Safari/605.1.15`, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0']) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent)
      expect(await exportTransactions(), agent).toBe(1)
    }
    expect(clicks).toHaveLength(3)
  })
})
