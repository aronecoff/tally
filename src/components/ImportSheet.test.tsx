// @vitest-environment jsdom
/**
 * Importing in the personal app, beside the bank rows. A file must not double what
 * the bank already brought. The figures and merchants are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db } from '../db/db'
import { Accounts } from './Accounts'
import { ImportSheet } from './ImportSheet'

const sheet = () => document.querySelector<HTMLElement>('.sheet')!

function choose(text: string) {
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([text], 'export.csv')] } })
}

const HEAD = 'Date,Description,Amount\n'
const bankRow = (uid: string, note: string, date = '2026-10-03', amount = 4.5) =>
  db.transactions.add({ uid, date, amount, type: 'expense', categoryId: null, account: 'Test Bank Card', note, createdAt: 1, updatedAt: 1 })

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  await Promise.all([db.categories.clear(), db.transactions.clear(), db.accounts.clear()])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('in Accounts', () => {
  it('is in the Connections list here too', async () => {
    render(<Accounts active />)
    fireEvent.click(await screen.findByRole('button', { name: /Import a file/ }))
    await waitFor(() => expect(document.querySelector('.sheet[data-sheet="import"]')).not.toBeNull())
  })
})

describe('beside bank rows', () => {
  it('counts a row the bank already has, word for word, as here', async () => {
    await bankRow('sf:bank:acct:1', 'Harbor Coffee')
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/03/2026,HARBOR COFFEE,-4.50\n10/04/2026,Corner Market,-20.00\n`)
    await screen.findByText('1 row already here.')
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('starts a row unticked when a bank row has its money and day, and says which', async () => {
    await bankRow('sf:bank:acct:1', 'Harbor Coffee')
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/04/2026,SQ *HARBOR CFE SF,-4.50\n10/05/2026,Corner Market,-20.00\n`)
    const row = await screen.findByRole('checkbox', { name: /SQ \*HARBOR CFE/ })
    expect(row.getAttribute('aria-checked')).toBe('false')
    expect(row.textContent).toContain('Looks like Harbor Coffee on Oct 3')
    expect(screen.getAllByRole('checkbox')[0]).toBe(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 transaction' }))
    await screen.findByText(/^Imported 1 transaction/)
    expect(sheet().textContent).toContain('Left out 1 row.')
    expect(await db.transactions.count()).toBe(2)
  })

  it('lets a person bring it in all the same', async () => {
    await bankRow('sf:bank:acct:1', 'Harbor Coffee')
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/04/2026,SQ *HARBOR CFE SF,-4.50\n`)
    fireEvent.click(await screen.findByRole('checkbox', { name: /SQ \*HARBOR CFE/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 transaction' }))
    await screen.findByText(/^Imported 1 transaction/)
    expect(await db.transactions.count()).toBe(2)
  })

  it('never touches the bank’s row', async () => {
    const id = await bankRow('sf:bank:acct:1', 'Harbor Coffee')
    const before = await db.transactions.get(id)
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/03/2026,Harbor Coffee,-4.50\n10/09/2026,Corner Market,-20.00\n`)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 transaction' }))
    await screen.findByText(/^Imported 1 transaction/)
    expect(await db.transactions.get(id)).toEqual(before)
  })
})

describe('a file with money out and money in in two columns', () => {
  const rows = '10/03/2026,LINDEN BOOKS,31.00,\n10/04/2026,RIVER TAQUERIA,14.75,\n10/05/2026,ACME CORP PAYROLL,,1200.00\n'
  const money = () => screen.getByLabelText<HTMLSelectElement>(/^Money in/)
  const saved = async () =>
    (await db.transactions.toArray()).map((t) => [t.note, t.type, t.amount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const READ_RIGHT = [
    ['ACME CORP PAYROLL', 'income', 1200],
    ['LINDEN BOOKS', 'expense', 31],
    ['RIVER TAQUERIA', 'expense', 14.75],
  ]

  it.each([
    ['Amount Debit', 'Amount Credit'],
    ['Debit Amount', 'Credit Amount'],
    ['Withdrawal Amount', 'Deposit Amount'],
    ['Money Out', 'Money In'],
  ])('reads %s and %s the right way round, with nothing left out', async (out, into) => {
    render(<ImportSheet onClose={() => {}} />)
    choose(`Date,Description,${out},${into}\n${rows}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 3 transactions' }))
    await screen.findByText(/^Imported 3 transactions/)
    expect(await saved()).toEqual(READ_RIGHT)
  })

  it('always offers Money in, set to None when the file has one column', async () => {
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/03/2026,Corner Market,-20.00\n`)
    await screen.findByRole('button', { name: 'Import 1 transaction' })
    expect(money().selectedOptions[0].text).toBe('None')
  })

  it('lets a person pick the two columns of a file it cannot read, and says which is which', async () => {
    render(<ImportSheet onClose={() => {}} />)
    choose(`Date,Description,Went,Came\n${rows}`)
    await screen.findByText('Choose the date and amount columns to see the rows.')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '2' } })
    fireEvent.change(money(), { target: { value: '3' } })
    expect(screen.getByLabelText<HTMLSelectElement>(/^Money out/).value).toBe('2')
    fireEvent.click(await screen.findByRole('button', { name: 'Import 3 transactions' }))
    await screen.findByText(/^Imported 3 transactions/)
    expect(await saved()).toEqual(READ_RIGHT)
  })

  it('drops the warning about positive figures once the columns settle it', async () => {
    const warning = /Most of these figures are positive/
    render(<ImportSheet onClose={() => {}} />)
    choose(`Date,Description,Amount,Other\n10/03/2026,LINDEN BOOKS,31.00,\n10/04/2026,RIVER TAQUERIA,14.75,\n10/05/2026,ACME CORP PAYROLL,,1200.00\n`)
    await screen.findByText(warning)
    fireEvent.change(money(), { target: { value: '3' } })
    await waitFor(() => expect(screen.queryByText(warning)).toBeNull())
  })

  it('says rows of the last import read differently once a person picks Money in', async () => {
    render(<ImportSheet onClose={() => {}} />)
    const file = `Date,Description,Amount,Other\n${rows}`
    choose(file)
    fireEvent.click(await screen.findByRole('radio', { name: 'Bank account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 transactions' }))
    await screen.findByText(/^Imported 2 transactions/)
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(file)
    await screen.findByText('2 rows already here.')
    fireEvent.change(money(), { target: { value: '3' } })
    await screen.findByText(/2 rows from your last import read differently now/)
  })
})

describe('what an import will write', () => {
  const lines = () => [...document.querySelectorAll('.import-sum-line')].map((l) => l.textContent)

  it('counts only the rows it will bring in, beside what the bank already has', async () => {
    await bankRow('sf:bank:acct:1', 'Harbor Coffee')
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}10/04/2026,SQ *HARBOR CFE SF,-4.50\n10/05/2026,Corner Market,-20.00\n10/06/2026,Acme Payroll,1800.00\n`)
    await screen.findByRole('button', { name: 'Import 2 transactions' })
    expect(document.querySelector('.sheet-actions .import-sum-head')?.textContent).toBe('This import adds2 rows')
    expect(lines()).toEqual(['Money in$1,800.00', 'Money out$20.00', 'Largest money inAcme Payroll$1,800.00', 'Largest money outCorner Market$20.00'])
    fireEvent.click(await screen.findByRole('checkbox', { name: /SQ \*HARBOR CFE/ }))
    expect(lines()[1]).toBe('Money out$24.50')
  })
})
