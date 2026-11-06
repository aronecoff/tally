// @vitest-environment jsdom
/**
 * The import sheet has to say what it did with every row of a file, and let a
 * person leave a row out. The figures and merchants are invented.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ImportSheet } from '../../components/ImportSheet'
import { db } from '../../db/db'
import { DOUBLE_TAP_MS } from '../../lib/useArmed'
import { seedIfEmpty } from './seed'

beforeEach(async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })),
  )
  localStorage.clear()
  await db.categories.clear()
  await db.transactions.clear()
  await seedIfEmpty()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sheet = () => document.querySelector<HTMLElement>('.sheet')!

function choose(text: string, name = 'export.csv') {
  const file = new File([text], name)
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
}

async function open(text: string, name?: string) {
  render(<ImportSheet onClose={() => {}} />)
  choose(text, name)
  await screen.findByRole('button', { name: /^(Import \d+ transactions?|Choose Bank account or Card above)$/ })
}

const importButton = (name: string) => screen.findByRole('button', { name })

async function runImport(name: string) {
  fireEvent.click(await importButton(name))
  await screen.findByText(/^Imported /)
}

const stored = async () => (await db.transactions.toArray()).sort((a, b) => a.date.localeCompare(b.date))
const tick = (name: RegExp) => screen.getByRole('checkbox', { name })

const HEAD = 'Date,Description,Amount\n'

describe('two identical rows', () => {
  const FILE = `${HEAD}11/01/2026,HARBOR COFFEE,-4.50\n11/01/2026,HARBOR COFFEE,-4.50\n11/02/2026,Corner Market,-20.00\n`

  it('brings both in, and does not say they were already here', async () => {
    await open(FILE)
    await runImport('Import 3 transactions')
    expect(await db.transactions.count()).toBe(3)
    expect(sheet().textContent).toContain('Imported 3 transactions.')
    expect(sheet().textContent).not.toContain('already here')
  })

  it('says so before saving when the same file comes in again, and adds nothing', async () => {
    await open(FILE)
    await runImport('Import 3 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    await screen.findByText('3 rows already here.')
    expect(sheet().textContent).toContain('There is nothing new in this file.')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(await db.transactions.count()).toBe(3)
  })
})

describe('a row that repeats, with one of the pair already here', () => {
  const FIRST = `${HEAD}10/05/2026,HARBOR COFFEE,-4.50\n10/06/2026,CORNER MARKET,-30.00\n10/07/2026,ACME PAYROLL,2000.00\n10/08/2026,MOON BOOKS,-12.00\n10/09/2026,PINE DINER,-20.00\n`
  const WHOLE = `${HEAD}10/05/2026,HARBOR COFFEE,-4.50\n10/05/2026,HARBOR COFFEE,-4.50\n10/06/2026,CORNER MARKET,-30.00\n10/07/2026,ACME PAYROLL,2000.00\n10/08/2026,MOON BOOKS,-12.00\n10/09/2026,PINE DINER,-20.00\n10/12/2026,BLUE HERON MARKET,-41.10\n`
  const FARES = `${HEAD}10/05/2026,CITY TRANSIT FARE,-2.75\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/06/2026,CORNER MARKET,-30.00\n10/07/2026,ACME PAYROLL,2000.00\n10/08/2026,MOON BOOKS,-12.00\n`
  const sum = () => document.querySelector('.import-sum')?.textContent

  it('writes what the sheet said of a later file, and offers nothing after', async () => {
    await open(FIRST)
    await runImport('Import 5 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(WHOLE)
    await importButton('Import 2 transactions')
    expect(sum()).toContain('This import adds2 rows')
    expect(sum()).toContain('Money out$45.60')
    await runImport('Import 2 transactions')
    expect(await db.transactions.count()).toBe(7)
    expect(sheet().textContent).toContain('Imported 2 transactions. Skipped 5 already here.')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(WHOLE)
    await screen.findByText('7 rows already here.')
    expect(sheet().textContent).toContain('There is nothing new in this file.')
  })

  it('writes both rows it offers when the one already here came from a bank, with no id from the file', async () => {
    await db.transactions.add({ uid: 'sf:1', date: '2026-10-05', amount: 2.75, type: 'expense', note: 'CITY TRANSIT FARE', categoryId: null, account: '', createdAt: 1, updatedAt: 1 })
    await open(`${HEAD}10/05/2026,CITY TRANSIT FARE,-2.75\n10/05/2026,CITY TRANSIT FARE,-2.75\n10/06/2026,CORNER MARKET,-30.00\n`)
    await runImport('Import 2 transactions')
    expect((await db.transactions.toArray()).map((t) => t.note).sort()).toEqual(['CITY TRANSIT FARE', 'CITY TRANSIT FARE', 'CORNER MARKET'])
    expect(sheet().textContent).toContain('Imported 2 transactions. Skipped 1 already here.')
  })

  it('brings in the fare left unticked the first time, when the file comes back', async () => {
    await open(FARES)
    fireEvent.click(screen.getAllByRole('checkbox', { name: /CITY TRANSIT FARE/ })[0])
    await runImport('Import 4 transactions')
    expect(await db.transactions.count()).toBe(4)
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(FARES)
    await runImport('Import 1 transaction')
    expect(await db.transactions.count()).toBe(5)
    expect(sheet().textContent).toContain('Imported 1 transaction. Skipped 4 already here.')
  })
})

describe('the column pickers', () => {
  const columns = () => document.querySelector<HTMLDetailsElement>('.import-columns')!
  const CHASE = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/03/2026,11/04/2026,HARBOR COFFEE,Food,Sale,-12.34,\n11/05/2026,11/06/2026,Payment Thank You-Mobile,,Payment,300.00,\n11/06/2026,11/07/2026,CORNER MARKET,Food,Sale,-54.20,\n'

  it('fold to one row on a file they read, and that row says what they read', async () => {
    await open(CHASE)
    expect(columns().open).toBe(false)
    expect(columns().querySelector('summary')?.textContent).toBe('ColumnsTransaction Date, Amount, Description')
    expect(sheet().textContent).not.toContain('reads like a card being paid')
    expect(screen.getByRole('radio', { name: 'Card' }).getAttribute('aria-checked')).toBe('true')
  })

  it('stay open once a person has picked one', async () => {
    await open(CHASE)
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '3' } })
    await waitFor(() => expect(columns().open).toBe(true))
    expect(columns().querySelector('summary')?.textContent).toBe('ColumnsTransaction Date, Amount, Category')
  })

  it('fold beside a question they cannot answer, so the rows it points at are in reach', async () => {
    await open('Date,Description,Amount,Card,Balance\n11/03/2026,HARBOR COFFEE,-12.34,1234,987.66\n11/04/2026,ACME INC,2500.00,1234,3487.66\n11/05/2026,CORNER MARKET,-54.20,1234,3433.46\n')
    expect(document.querySelector('.import-ask')).not.toBeNull()
    expect(columns().open).toBe(false)
  })

  it('stay open beside a question a column could answer', async () => {
    await open('Date,Description,Amount,Went\n11/03/2026,HARBOR COFFEE,12.34,Spent it\n11/04/2026,CORNER MARKET,54.20,Spent it\n11/06/2026,ACME INC,2500.00,Got it\n')
    expect(document.querySelector('.import-ask')).not.toBeNull()
    expect(columns().open).toBe(true)
  })

  it('fold above a file’s footer, which is only a few rows left out', async () => {
    await open(`${HEAD}11/03/2026,HARBOR COFFEE,-12.34\n11/04/2026,CORNER MARKET,-54.20\n11/05/2026,MOON BOOKS,-18.75\nIn case of errors,call us,\n`)
    await screen.findByText('Left out 1 row.')
    expect(columns().open).toBe(false)
  })

  it('stay open while most rows cannot be read, or a column has not been found', async () => {
    await open(`${HEAD}11/03/2026,HARBOR COFFEE,-12.34\nsoon,CORNER MARKET,-54.20\n`)
    expect(columns().open).toBe(true)
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose('11/03/2026,HARBOR COFFEE,-12.34,987.66\n11/04/2026,CORNER MARKET,-54.20,933.46\n')
    await screen.findByText(/more than one of them holds figures/)
    expect(columns().open).toBe(true)
  })

  it('stay open on a file with no names for its columns, where they are a guess', async () => {
    await open('11/03/2026,HARBOR COFFEE,-12.34\n11/04/2026,CORNER MARKET,-54.20\n')
    expect(columns().open).toBe(true)
  })
})

describe('dates', () => {
  it('reads a day-first file as day first, and stores days the app can show', async () => {
    await open(`${HEAD}13/10/2026,Corner Market,-1.00\n25/10/2026,Harbor Coffee,-2.00\n03/11/2026,Metro Fare,-3.00\n`)
    expect(screen.queryByRole('radiogroup', { name: 'How dates read' })).toBeNull()
    await runImport('Import 3 transactions')
    expect((await stored()).map((t) => t.date)).toEqual(['2026-10-13', '2026-10-25', '2026-11-03'])
  })

  it('does not ask about a file that settles it', async () => {
    await open(`${HEAD}10/13/2026,Corner Market,-1.00\n11/03/2026,Metro Fare,-3.00\n`)
    expect(screen.queryByRole('radiogroup', { name: 'How dates read' })).toBeNull()
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => t.date)).toEqual(['2026-10-13', '2026-11-03'])
  })

  it('asks when a file cannot settle it, and uses the answer', async () => {
    await open(`${HEAD}03/11/2026,Corner Market,-1.00\n05/11/2026,Metro Fare,-3.00\n`)
    const group = screen.getByRole('radiogroup', { name: 'How dates read' })
    expect(group.querySelector('[aria-checked=true]')?.textContent).toBe('Month first')
    expect(sheet().textContent).toContain('could be read either way')
    expect(sheet().textContent).toContain('Mar 11')
    fireEvent.click(screen.getByRole('radio', { name: 'Day first' }))
    await waitFor(() => expect(sheet().textContent).toContain('Nov 3'))
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => t.date)).toEqual(['2026-11-03', '2026-11-05'])
  })

  it('forgets the answer when the date column changes, and reads the new one', async () => {
    await open('Date,Posted,Description,Amount\n03/11/2026,10/13/2026,Corner Market,-1.00\n')
    fireEvent.click(screen.getByRole('radio', { name: 'Day first' }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '1' } })
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: 'How dates read' })).toBeNull())
    await runImport('Import 1 transaction')
    expect((await stored()).map((t) => t.date)).toEqual(['2026-10-13'])
  })

  it('shows the year on a row from another year', async () => {
    await open(`${HEAD}2021-06-15,Corner Market,-1.00\n`)
    expect(sheet().textContent).toContain('Jun 15, 2021')
  })
})

describe('rows left out', () => {
  it('shows which rows cannot be read and why, and counts them in the result', async () => {
    await open(`${HEAD}10/13/2026,Corner Market,-1.00\n13/13/2026,Harbor Coffee,-2.00\n10/14/2026,Metro Fare,n/a\n10/15/2026,Free Sample,0.00\n,Total,-3.00\n`)
    const text = sheet().textContent
    expect(text).toContain('Left out 4 rows.')
    expect(text).toContain('Could not read the date: 13/13/2026')
    expect(text).toContain('Could not read the amount: n/a')
    expect(text.match(/n\/a/g)).toHaveLength(1)
    expect(text).toContain('The amount is zero')
    expect(text).toContain('No date')
    await runImport('Import 1 transaction')
    expect(await db.transactions.count()).toBe(1)
    expect(sheet().textContent).toContain('Imported 1 transaction. Left out 4 rows.')
  })

  it('says so when no row can be read, and imports nothing', async () => {
    await open(`${HEAD}soon,Corner Market,-1.00\n`)
    expect(sheet().textContent).toContain('None of these rows could be read')
    expect(((await importButton('Import 0 transactions')) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ticks', () => {
  const CARD = `${HEAD}11/10/2026,Corner Market,-54.20\n11/12/2026,Harbor Coffee,-6.00\n11/14/2026,PAYMENT THANK YOU,500.00\n`

  it('starts a card payment unticked, near the top, and leaves it out', async () => {
    await open(CARD)
    expect(tick(/PAYMENT THANK YOU/).getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByRole('checkbox')[0].textContent).toContain('PAYMENT THANK YOU')
    expect(sheet().textContent).toContain('Payments, transfers, balances, totals and rows that look like one already here start unticked')
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => t.note)).toEqual(['Corner Market', 'Harbor Coffee'])
    expect((await stored()).every((t) => t.type === 'expense')).toBe(true)
    expect(sheet().textContent).toContain('Imported 2 transactions. Left out 1 row.')
  })

  it('brings a payment in when ticked', async () => {
    await open(CARD)
    fireEvent.click(tick(/PAYMENT THANK YOU/))
    await runImport('Import 3 transactions')
    expect(await db.transactions.count()).toBe(3)
  })

  it('leaves out any row that is unticked', async () => {
    await open(CARD)
    fireEvent.click(tick(/Corner Market/))
    await runImport('Import 1 transaction')
    expect((await stored()).map((t) => t.note)).toEqual(['Harbor Coffee'])
  })

  it('keeps a tick when the sign setting changes', async () => {
    await open(CARD)
    fireEvent.click(tick(/Corner Market/))
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    await importButton('Import 1 transaction')
    expect(tick(/Corner Market/).getAttribute('aria-checked')).toBe('false')
  })

  it('cannot import with nothing ticked', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n`)
    fireEvent.click(tick(/Corner Market/))
    expect(((await importButton('Import 0 transactions')) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reaches every row of a long file', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `11/${String(i + 13)}/2026,Shop ${i + 1},-1.00`).join('\n')
    await open(`${HEAD}${rows}\n`)
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    fireEvent.click(tick(/Shop 8/))
    await runImport('Import 7 transactions')
    expect((await stored()).map((t) => t.note)).not.toContain('Shop 8')
  })
})

describe('a statement', () => {
  const OFX = `OFXHEADER:100
DATA:OFXSGML

<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Test Bank</FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>4000000000005678</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20261103<TRNAMT>-54.20<FITID>F-1<NAME>CORNER MARKET</STMTTRN>
<STMTTRN><DTPOSTED>20261104<TRNAMT>12.00<FITID>F-2<NAME>CORNER MARKET</STMTTRN>
<STMTTRN><DTPOSTED>20261105<TRNAMT>500.00<FITID>F-3<NAME>PAYMENT THANK YOU</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`

  it('needs no columns, and says what it is', async () => {
    await open(OFX, 'statement.qfx')
    expect(sheet().textContent).toContain('Test Bank ··5678: 3 rows.')
    expect(screen.queryByLabelText('Date')).toBeNull()
    expect(sheet().textContent).not.toContain('4000000000005678')
  })

  it('reads a card: a charge, a refund that offsets it, and a payment that starts unticked', async () => {
    await open(OFX, 'statement.qfx')
    expect(tick(/PAYMENT THANK YOU/).getAttribute('aria-checked')).toBe('false')
    expect(tick(/\+\$12\.00/).textContent).toContain('Refund')
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => [t.date, t.amount, t.type, t.account])).toEqual([
      ['2026-11-03', 54.2, 'expense', 'Test Bank ··5678'],
      ['2026-11-04', -12, 'expense', 'Test Bank ··5678'],
    ])
  })

  it('brings nothing in twice when the same statement comes again', async () => {
    await open(OFX, 'statement.qfx')
    await runImport('Import 2 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(OFX, 'again.ofx')
    await screen.findByText('2 rows already here.')
    expect(tick(/PAYMENT THANK YOU/).getAttribute('aria-checked')).toBe('false')
  })

  it('knows a re-download by the bank’s ids, even with the words changed', async () => {
    await open(OFX, 'statement.qfx')
    await runImport('Import 2 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(OFX.replaceAll('CORNER MARKET', 'CORNER MKT #12'))
    await screen.findByText('2 rows already here.')
  })

  it('can read a card that runs the other way', async () => {
    await open(OFX, 'statement.qfx')
    fireEvent.click(screen.getByRole('radio', { name: 'Charges are positive' }))
    await waitFor(() => expect(tick(/\$54\.20/).textContent).toContain('Refund'))
  })

  it('reads a bank statement as money in and out, with nothing to choose', async () => {
    await open('<OFX><STMTRS><BANKACCTFROM><ACCTID>111</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>3200.00<FITID>1<NAME>ACME PAYROLL</STMTTRN></STMTRS></OFX>')
    expect(screen.queryByRole('radiogroup', { name: 'How charges read' })).toBeNull()
    expect(tick(/ACME PAYROLL/).textContent).toContain('+$3,200.00')
  })

  it('says so when it holds no rows', async () => {
    render(<ImportSheet onClose={() => {}} />)
    choose('<OFX><STMTRS></STMTRS></OFX>')
    await screen.findByText('That file has no transactions in it.')
  })
})

describe('what a file is from', () => {
  const PLAIN = `${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,Harbor Coffee,6.00\n11/14/2026,Metro Fare,2.75\n11/15/2026,Corner Market,-10.00\n`

  const ASKS = 'Most of these figures are positive.'

  it('starts plain figures as a bank account, says why, and a card can be chosen', async () => {
    await open(PLAIN)
    expect(screen.getByRole('radio', { name: 'Bank account' }).getAttribute('aria-checked')).toBe('true')
    expect(sheet().textContent).toContain(ASKS)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(screen.getByRole('radio', { name: 'Charges are positive' }).getAttribute('aria-checked')).toBe('true')
    expect(tick(/\+\$10\.00/).textContent).toContain('Refund')
    await runImport('Import 4 transactions')
    expect((await stored()).map((t) => t.amount)).toEqual([54.2, 6, 2.75, -10])
  })

  it('leaves how charges read alone on a file that settled it', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n11/12/2026,Harbor Coffee,-6.00\n`)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(screen.getByRole('radio', { name: 'Charges are negative' }).getAttribute('aria-checked')).toBe('true')
  })

  it('reads a bank file as money in and out, once a person says it is one', async () => {
    await open(PLAIN)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    await runImport('Import 4 transactions')
    expect((await stored()).map((t) => t.type)).toEqual(['income', 'income', 'income', 'expense'])
  })

  it('never turns a savings account\u2019s deposits into spending', async () => {
    await open(`${HEAD}10/01/2026,DEPOSIT,500.00\n10/15/2026,DEPOSIT,500.00\n10/31/2026,INTEREST PAID,3.10\n09/30/2026,INTEREST PAID,3.05\n10/20/2026,WITHDRAWAL,-100.00\n`)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    await runImport('Import 5 transactions')
    expect((await stored()).map((t) => [t.note, t.type, t.amount])).toEqual([
      ['INTEREST PAID', 'income', 3.05],
      ['DEPOSIT', 'income', 500],
      ['DEPOSIT', 'income', 500],
      ['WITHDRAWAL', 'expense', 100],
      ['INTEREST PAID', 'income', 3.1],
    ])
  })

  it('asks nothing of a file that settles it', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n11/12/2026,Harbor Coffee,-6.00\n`)
    expect(sheet().textContent).not.toContain(ASKS)
    cleanup()
    await open(`${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,PAYMENT THANK YOU,-60.00\n`)
    expect(sheet().textContent).not.toContain(ASKS)
    expect(screen.getByRole('radio', { name: 'Card' }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers no sign question for a file that splits money in and out', async () => {
    await open('Date,Description,Debit,Credit\n11/10/2026,Corner Market,54.20,\n11/12/2026,Payroll,,3200.00\n')
    expect(screen.getByLabelText('Money in')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'How charges read' })).toBeNull()
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => [t.amount, t.type])).toEqual([[54.2, 'expense'], [3200, 'income']])
  })
})

describe('a file that cannot settle which way its money runs', () => {
  const PLAIN = `${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,Harbor Coffee,6.00\n11/14/2026,Metro Fare,2.75\n11/15/2026,Corner Market,-10.00\n`
  const MERCURY = `Date (UTC),Description,Amount,Status,Source Account,Bank Description,Last Four Digits,Name On Card
11/03/2026,HARBOR COFFEE,-12.34,Sent,Checking,HARBOR COFFEE,1234,A Person
11/04/2026,CORNER MARKET,-54.20,Sent,Checking,CORNER MARKET,1234,A Person
11/06/2026,ACME PAYROLL,2500.00,Sent,Checking,ACME PAYROLL,,
`
  const question = () => document.querySelector<HTMLElement>('.import-ask')
  const WAIT = 'Choose Bank account or Card above'
  const held = () => screen.getByRole<HTMLButtonElement>('button', { name: WAIT })

  it('holds the import, and puts the question first, until a person answers', async () => {
    await open(PLAIN)
    expect(question()?.querySelector('[role=alert]')?.textContent).toContain('Most of these figures are positive.')
    expect(sheet().querySelector('form')?.firstElementChild).toBe(question())
    expect(question()?.textContent).toContain('Is this a bank account or a card?')
    expect(question()?.querySelector('[aria-label="What this file is from"]')).not.toBeNull()
    expect(held().disabled).toBe(true)
    fireEvent.submit(sheet().querySelector('form')!)
    expect(await db.transactions.count()).toBe(0)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import 4 transactions' }).disabled).toBe(false)
    await runImport('Import 4 transactions')
    expect((await stored()).map((t) => t.type)).toEqual(['income', 'income', 'income', 'expense'])
  })

  it('takes a choice of how charges read as an answer too', async () => {
    await open(PLAIN)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Charges are negative' }))
    await runImport('Import 4 transactions')
    expect((await stored()).map((t) => t.amount)).toEqual([-54.2, -6, -2.75, 10])
  })

  it('asks nothing once the columns settle it', async () => {
    await open(`Date,Description,Amount,Other\n10/03/2026,LINDEN BOOKS,31.00,\n10/05/2026,ACME CORP PAYROLL,,1200.00\n`)
    expect(question()).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Money in'), { target: { value: '3' } })
    await waitFor(() => expect(question()).toBeNull())
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import 2 transactions' }).disabled).toBe(false)
  })

  it('asks nothing of a file with nothing left to bring in', async () => {
    await open(PLAIN)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    await runImport('Import 4 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(PLAIN)
    await screen.findByText('4 rows already here.')
    expect(question()).toBeNull()
  })

  it('says why of a mix of both ways', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,Harbor Coffee,6.00\n11/14/2026,Metro Fare,2.75\n11/15/2026,Moon Books,18.75\n11/16/2026,Acme Return,-40.00\n11/17/2026,Daily Cash,-3.00\n11/18/2026,Settled,-300.00\n`)
    expect(question()?.textContent).toContain('These figures run both ways')
    expect(held().disabled).toBe(true)
  })

  it('asks of a bare issuer line, and starts it unticked once a person calls it a card', async () => {
    await open(`${HEAD}11/03/2026,RENT PORTAL,-1400.00\n11/04/2026,HARBOR COFFEE,-6.50\n11/05/2026,CORNER MARKET,-84.12\n11/06/2026,ELECTRONIC PAYMENT,1800.00\n`)
    expect(question()?.textContent).toContain('A line here reads like a card being paid')
    expect(tick(/ELECTRONIC PAYMENT/).textContent).toContain('+$1,800.00')
    expect(tick(/ELECTRONIC PAYMENT/).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    await waitFor(() => expect(tick(/ELECTRONIC PAYMENT/).getAttribute('aria-checked')).toBe('false'))
  })

  it('says why of a payment line the rows around it contradict', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n11/12/2026,Harbor Coffee,-6.00\n11/14/2026,Moon Books,-18.75\n11/15/2026,PAYMENT THANK YOU,-60.00\n11/16/2026,ACME PAYROLL,2500.00\n`)
    expect(question()?.textContent).toContain('A line here reads like a card being paid')
    expect(held().disabled).toBe(true)
  })

  it('asks of a bank file that names a card, and reads it either way', async () => {
    await open(MERCURY)
    expect(question()?.textContent).toContain('partly like a card')
    expect(tick(/ACME PAYROLL/).textContent).not.toContain('Refund')
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(screen.getByRole('radio', { name: 'Charges are negative' }).getAttribute('aria-checked')).toBe('true')
    expect(tick(/ACME PAYROLL/).textContent).toContain('Refund')
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    await runImport('Import 3 transactions')
    expect((await stored()).map((t) => [t.type, t.amount])).toEqual([['expense', 12.34], ['expense', 54.2], ['income', 2500]])
  })

  it('asks of a pair that names a card, where a payday would read as a refund', async () => {
    await open('Date,Description,Debit,Credit,Credit Card Payment\n11/03/2026,HARBOR COFFEE,12.34,,\n11/04/2026,CORNER MARKET,54.20,,\n11/06/2026,ACME PAYROLL,,2500.00,\n')
    expect(question()?.textContent).toContain('partly like a card')
    expect(screen.queryByRole('radiogroup', { name: 'How charges read' })).toBeNull()
  })

  it('reads the columns a person picks, and asks if they settle nothing', async () => {
    await open('Date,Description,Debit,Credit,Went\n11/03/2026,HARBOR COFFEE,12.34,,5.00\n11/04/2026,CORNER MARKET,54.20,,6.00\n11/06/2026,ACME PAYROLL,,2500.00,7.00\n')
    expect(question()).toBeNull()
    fireEvent.change(screen.getByLabelText('Money in'), { target: { value: '-1' } })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '4' } })
    await waitFor(() => expect(question()).not.toBeNull())
    expect(held().disabled).toBe(true)
  })

  it('asks about a column of figures a person picks in a file with no names for them', async () => {
    render(<ImportSheet onClose={() => {}} />)
    choose('11/03/2026,HARBOR COFFEE,12.34,,1987.66\n11/04/2026,CORNER MARKET,54.20,,1933.46\n11/06/2026,ACME PAYROLL,,2500.00,4433.46\n')
    await screen.findByText(/no names for its columns/)
    expect(screen.queryByRole('checkbox')).toBeNull()
    const amount = screen.getByLabelText<HTMLSelectElement>('Amount')
    expect([...amount.options].map((o) => o.text)).toContain('Column 5: 1987.66')
    fireEvent.change(amount, { target: { value: '4' } })
    await waitFor(() => expect(question()).not.toBeNull())
  })
})

describe('reading a card’s own file', () => {
  it('reads Apple Card with nothing to ask: a refund back, and its payment unticked', async () => {
    await open(`Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
11/03/2026,11/04/2026,HARBOR COFFEE,HARBOR COFFEE,Other,Purchase,12.34,A Person
11/04/2026,11/05/2026,CORNER MARKET,CORNER MARKET,Other,Purchase,54.20,A Person
11/05/2026,11/06/2026,TRAIL BIKE SHOP,TRAIL BIKE SHOP,Other,Purchase,230.00,A Person
11/06/2026,11/07/2026,MOON BOOKS,MOON BOOKS,Other,Purchase,18.75,A Person
11/07/2026,11/08/2026,ACME RETURN,ACME RETURN,Other,Return,-40.00,A Person
11/08/2026,11/09/2026,DAILY CASH ADJUSTMENT,DAILY CASH ADJUSTMENT,Other,Adjustment,-3.00,A Person
11/09/2026,11/10/2026,ACH DEPOSIT FROM ACCOUNT ENDING IN 1234,ACH DEPOSIT,Other,Payment,-300.00,A Person
`)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(screen.getByRole('radio', { name: 'Card' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Charges are positive' }).getAttribute('aria-checked')).toBe('true')
    expect(tick(/ACH DEPOSIT/).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }))
    expect(tick(/ACME RETURN/).textContent).toContain('Refund')
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−')
  })

  it('leaves a Payment row ticked in, once a person says the file is a bank account', async () => {
    await open(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
11/03/2026,11/03/2026,HARBOR COFFEE,Food,Sale,-12.34,
11/04/2026,11/04/2026,CORNER MARKET,Food,Sale,-54.20,
11/09/2026,11/09/2026,REF 9921 ACCT SETTLE,,Payment,30.00,
`)
    expect(tick(/REF 9921/).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    expect(tick(/REF 9921/).getAttribute('aria-checked')).toBe('true')
  })
})

describe('a read that hangs on one column', () => {
  it('says when a lone column makes every row one way, as the other half may be missing', async () => {
    await open('Date,Description,Debit,Available Credit\n11/03/2026,HARBOR COFFEE,12.34,4987.66\n11/04/2026,CORNER MARKET,54.20,4933.46\n')
    expect(sheet().textContent).toContain('Debit is the only column of money here, so every row reads as money out.')
    expect(sheet().textContent).toContain('If money also went the other way, it is not in this file.')
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−')
    expect(document.querySelector('.import-ask')).toBeNull()
    await runImport('Import 2 transactions')
    expect((await stored()).map((t) => [t.type, t.amount])).toEqual([['expense', 12.34], ['expense', 54.2]])
  })

  it('says it of a column of money in too', async () => {
    await open('Date,Description,Credit\n11/06/2026,ACME PAYROLL,2500.00\n')
    expect(sheet().textContent).toContain('Credit is the only column of money here, so every row reads as money in.')
  })

  it('says nothing of a signed column with one name', async () => {
    await open('Date,Description,Debit\n11/03/2026,HARBOR COFFEE,-12.34\n11/06/2026,ACME PAYROLL,2500.00\n')
    expect(sheet().textContent).not.toContain('only column of money')
  })

  it('stops reading a column that way when another is picked, and asks instead', async () => {
    await open('Date,Description,Debit,Went\n11/03/2026,HARBOR COFFEE,12.34,5.00\n11/04/2026,CORNER MARKET,54.20,6.00\n')
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '3' } })
    await waitFor(() => expect(sheet().textContent).not.toContain('only column of money'))
    expect(document.querySelector('.import-ask')).not.toBeNull()
  })

  const MINT = '"Date","Description","Amount","Transaction Type"\n"11/03/2026","HARBOR COFFEE","12.34","debit"\n"11/04/2026","CORNER MARKET","54.20","debit"\n"11/06/2026","ACME PAYROLL","2500.00","credit"\n'

  it('shows the column that says which way each row ran, and what it read', async () => {
    await open(MINT)
    expect(sheet().textContent).toContain('Transaction Type says which way each row ran: 2 money out, 1 money in.')
    expect(screen.getByLabelText<HTMLSelectElement>('In or out').selectedOptions[0].text).toBe('Transaction Type')
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'How charges read' })).toBeNull()
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−')
    expect(tick(/ACME PAYROLL/).textContent).toContain('+')
    await runImport('Import 3 transactions')
    expect((await stored()).map((t) => [t.type, t.amount])).toEqual([['expense', 12.34], ['expense', 54.2], ['income', 2500]])
  })

  it('lets a person turn that column off, and then asks', async () => {
    await open(MINT)
    fireEvent.change(screen.getByLabelText('In or out'), { target: { value: '-1' } })
    await waitFor(() => expect(document.querySelector('.import-ask')).not.toBeNull())
    expect(sheet().textContent).not.toContain('says which way each row ran')
  })

  it('offers no such picker to a file whose figures already say', async () => {
    await open(`Date,Description,Amount,Other\n11/10/2026,Corner Market,-54.20,x\n11/12/2026,Acme Payroll,2500.00,y\n`)
    expect(screen.queryByLabelText('In or out')).toBeNull()
  })

  it.each([
    ['a Type of a card’s words', 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/03/2026,11/04/2026,HARBOR COFFEE,Food,Sale,-12.34,\n11/05/2026,11/06/2026,Payment Thank You-Mobile,,Payment,300.00,\n11/06/2026,11/07/2026,CORNER MARKET,Food,Sale,-54.20,\n'],
    ['a Type that agrees with them', 'Date,Time,Amount,Type,Description\n2026-11-03,09:00:00,-12.34,Withdrawal,HARBOR COFFEE\n2026-11-04,09:00:00,-54.20,Withdrawal,CORNER MARKET\n2026-11-06,09:00:00,2500.00,Deposit,ACME PAYROLL\n'],
    ['a Type of what a row was', 'Date,Description,Type,Amount,Current balance,Status\n2026-11-03,HARBOR COFFEE,Debit Card,-12.34,987.66,Posted\n2026-11-06,ACME PAYROLL,Direct Deposit,2500.00,3487.66,Posted\n'],
    ['a card’s Type, with figures running its way', 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n11/03/2026,11/04/2026,HARBOR COFFEE,Harbor Coffee,Food,Purchase,12.34,A Person\n11/04/2026,11/05/2026,CORNER MARKET,Corner Market,Food,Purchase,54.20,A Person\n11/06/2026,11/07/2026,MOON BOOKS,Moon Books,Other,Credit,-18.75,A Person\n11/07/2026,11/08/2026,ACH DEPOSIT INTERNET TRANSFER,Ach,Payment,Payment,-40.00,A Person\n'],
  ])('offers no such picker beside signed figures and %s', async (_, file) => {
    await open(file)
    expect(screen.queryByLabelText('In or out')).toBeNull()
  })

  it('offers no such picker when no column is left to pick', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,Harbor Coffee,6.00\n`)
    expect(screen.queryByLabelText('In or out')).toBeNull()
  })

  it('offers the picker on plain figures it could not settle, and reads the column a person picks', async () => {
    await open('Date,Description,Amount,Went\n11/03/2026,HARBOR COFFEE,12.34,Spent it\n11/04/2026,CORNER MARKET,54.20,Spent it\n11/06/2026,ACME INC,2500.00,Got it\n')
    expect(document.querySelector('.import-ask')).not.toBeNull()
    fireEvent.change(screen.getByLabelText('In or out'), { target: { value: '3' } })
    expect((await screen.findAllByText('Could not tell which way it ran')).length).toBe(3)
    expect(document.querySelector('.import-ask')).toBeNull()
  })

  it('reads a D and C column a person picks, under a header that names neither', async () => {
    await open('Date,Description,Amount,Went\n11/03/2026,HARBOR COFFEE,12.34,D\n11/04/2026,CORNER MARKET,54.20,D\n11/06/2026,ACME INC,2500.00,C\n')
    fireEvent.change(screen.getByLabelText('In or out'), { target: { value: '3' } })
    await waitFor(() => expect(document.querySelector('.import-ask')).toBeNull())
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−$12.34')
    expect(tick(/ACME INC/).textContent).toContain('+$2,500.00')
  })

  it('says why a row is left out when its direction cannot be read', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `11/${String(i + 1).padStart(2, '0')}/2026,SHOP ${i},1${i}.00,debit`)
    await open(`Date,Description,Amount,Kind\n${rows.join('\n')}\n11/19/2026,ACME PAYROLL,2500.00,credit\n11/20/2026,MYSTERY,50.00,pending\n`)
    await screen.findByText('Could not tell which way it ran')
  })

  it('reads a column that only looks like direction words as nothing, and asks', async () => {
    await open('Date,Description,Amount,Status\n11/03/2026,HARBOR COFFEE,12.34,Credit\n11/04/2026,CORNER MARKET,54.20,Credit\n11/05/2026,MOON BOOKS,18.75,Credit\n')
    expect(document.querySelector('.import-ask')).not.toBeNull()
    expect(sheet().textContent).not.toContain('says which way each row ran')
    expect(screen.getByLabelText<HTMLSelectElement>('In or out').selectedOptions[0].text).toBe('None')
  })

  it('reads a pair the same after a person picks its columns again', async () => {
    await open('Date,Description,Debit,Credit,Other\n11/03/2026,CORNER MARKET,54.20,,x\n11/04/2026,CORNER MARKET BACK,-54.20,,x\n11/06/2026,ACME PAYROLL,,-2500.00,x\n')
    expect(tick(/CORNER MARKET BACK/).textContent).toContain('Refund')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '1' } })
    await waitFor(() => expect(tick(/ACME PAYROLL/).textContent).toContain('+$2,500.00'))
    expect(tick(/CORNER MARKET BACK/).textContent).toContain('Refund')
  })

  it('says why it left out a row whose cells moved, and shows no figure it cannot trust', async () => {
    await open('Date,Description,Amount,Balance\n11/03/2026,HARBOR COFFEE,-12.34,987.66\n11/04/2026,PIPE SHOP, 1200,-54.20,933.46\n11/06/2026,ACME PAYROLL,2500.00,3433.46\n')
    await screen.findByText('This row has more cells than the file has columns, so its figures may have moved')
    expect(sheet().querySelector('.import-rows:last-of-type')?.textContent).not.toContain('1200')
  })
})

describe('figures marked as money in', () => {
  const COMMON = `${HEAD}11/03/2026,HARBOR COFFEE,12.34\n11/04/2026,CORNER MARKET,54.20\n11/05/2026,MOON BOOKS,18.75\n11/06/2026,ACME PAYROLL,+2500.00\n11/07/2026,SIDE JOB,200.00 CR\n`
  const ONE = `${HEAD}11/03/2026,ACME INC,1200.00\n11/04/2026,SIDE JOB,160.00\n11/05/2026,SAM LEE,100.00\n11/06/2026,DANA KIM,40.00\n11/07/2026,GRAND HOTEL,+75.00\n`
  const SAYS = '2 figures are marked as money in, so the other 3 read as money out.'
  const marks = () => screen.queryByRole('radiogroup', { name: 'Figures marked + or CR' })

  it('says what the marks did, and reads them that way', async () => {
    await open(COMMON)
    expect(sheet().textContent).toContain(SAYS)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−$12.34')
    expect(tick(/ACME PAYROLL/).textContent).toContain('+$2,500.00')
    expect(marks()?.querySelector('[aria-checked=true]')?.textContent).toBe('Marks mean money in')
  })

  it('lets a person turn the marks off, asks, and reads the figures as they stand', async () => {
    await open(COMMON)
    fireEvent.click(screen.getByRole('radio', { name: 'Ignore the marks' }))
    await waitFor(() => expect(document.querySelector('.import-ask')).not.toBeNull())
    expect(sheet().textContent).not.toContain(SAYS)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    expect(tick(/HARBOR COFFEE/).textContent).toContain('+$12.34')
    await runImport('Import 5 transactions')
    expect((await stored()).map((t) => t.type)).toEqual(['income', 'income', 'income', 'income', 'income'])
  })

  it('takes the marks back when a person turns them on again, and keeps that through a change of columns', async () => {
    await open(`Date,Description,Amount,Other\n11/03/2026,HARBOR COFFEE,12.34,x\n11/04/2026,CORNER MARKET,54.20,x\n11/05/2026,ACME PAYROLL,+2500.00,x\n11/06/2026,SIDE JOB,200.00 CR,x\n`)
    fireEvent.click(screen.getByRole('radio', { name: 'Ignore the marks' }))
    await waitFor(() => expect(document.querySelector('.import-ask')).not.toBeNull())
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '3' } })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ignore the marks' }).getAttribute('aria-checked')).toBe('true'))
    expect(document.querySelector('.import-ask')).not.toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Marks mean money in' }))
    await waitFor(() => expect(document.querySelector('.import-ask')).toBeNull())
  })

  it('reads a card the marks say is a card, money back and all', async () => {
    await open(COMMON)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(tick(/ACME PAYROLL/).textContent).toContain('Refund')
    await runImport('Import 5 transactions')
    expect((await stored()).map((t) => t.amount)).toEqual([12.34, 54.2, 18.75, -2500, -200])
  })

  it('asks of one mark, shows every figure as it stands, and says nothing of marks yet', async () => {
    await open(ONE)
    expect(document.querySelector('.import-ask')).not.toBeNull()
    expect(tick(/ACME INC/).textContent).toContain('+$1,200.00')
    expect(tick(/GRAND HOTEL/).textContent).toContain('+$75.00')
    expect(sheet().textContent).not.toContain('marked as money in')
    expect(marks()).toBeNull()
  })

  it('takes a card from there with the marked figure as money back, and says so', async () => {
    await open(ONE)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(sheet().textContent).toContain('1 figure is marked as money in, so the other 4 read as money out.')
    expect(tick(/ACME INC/).textContent).toContain('−$1,200.00')
    expect(tick(/GRAND HOTEL/).textContent).toContain('Refund')
    fireEvent.click(screen.getByRole('radio', { name: 'Ignore the marks' }))
    await waitFor(() => expect(tick(/GRAND HOTEL/).textContent).toContain('−$75.00'))
  })

  it('offers a marked file the column picker, and reads a column a person picks', async () => {
    await open('Date,Description,Amount,Went\n11/03/2026,HARBOR COFFEE,12.34,D\n11/04/2026,CORNER MARKET,54.20,D\n11/05/2026,MOON BOOKS,18.75,D\n11/06/2026,ACME INC,+2500.00,C\n')
    fireEvent.change(screen.getByLabelText('In or out'), { target: { value: '3' } })
    await waitFor(() => expect(document.querySelector('.import-ask')).toBeNull())
    expect(tick(/HARBOR COFFEE/).textContent).toContain('−$12.34')
    expect(tick(/ACME INC/).textContent).toContain('+$2,500.00')
  })

  it('leaves a column that says which way each row ran in charge, and says nothing of marks', async () => {
    await open('Date,Description,Amount,Transaction Type\n11/03/2026,HARBOR COFFEE,12.34,Debit\n11/04/2026,CORNER MARKET,54.20,Debit\n11/05/2026,ACME INC,1200.00,Credit\n11/06/2026,SIDE JOB,+200.00,Credit\n')
    expect(sheet().textContent).toContain('Transaction Type says which way each row ran: 2 money out, 2 money in.')
    expect(sheet().textContent).not.toContain('marked as money in')
    expect(tick(/ACME INC/).textContent).toContain('+$1,200.00')
  })
})

describe('a read that rests on one thing', () => {
  const AMEX = 'Date,Description,Amount\n11/03/2026,HARBOR COFFEE,12.34\n11/04/2026,CORNER MARKET,54.20\n11/09/2026,ONLINE PAYMENT - THANK YOU,-300.00\n'
  const CARD_COLUMN = 'Date,Description,Card Member,Amount\n11/03/2026,HARBOR COFFEE,A PERSON,12.34\n11/04/2026,CORNER MARKET,A PERSON,54.20\n11/05/2026,MOON BOOKS,A PERSON,18.75\n11/06/2026,ACME RETURN,A PERSON,-6.00\n'
  const SMALL_CREDITS = `${HEAD}11/01/2026,RENT,-1200.00\n11/02/2026,CAR,-300.00\n11/03/2026,SAM LEE,20.00\n11/04/2026,DANA KIM,30.00\n11/05/2026,UTILITY,-800.00\n`
  const ready = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Import \d+ transactions?$/ })

  it('says a line made it a card, without stopping the import, and drops that once a person answers', async () => {
    await open(AMEX)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(sheet().textContent).toContain('A line here reads like a card being paid, so this reads as a card.')
    expect(ready().disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    expect(sheet().textContent).not.toContain('so this reads as a card')
    expect(tick(/CORNER MARKET/).textContent).toContain('+$54.20')
  })

  it('says a column made it a card', async () => {
    await open(CARD_COLUMN)
    expect(sheet().textContent).toContain('A column here reads like a card’s, so this reads as a card.')
    expect(ready().disabled).toBe(false)
  })

  it('says a Type column made it a card, on negative charges too, and a person can say otherwise', async () => {
    await open('Date,Description,Type,Amount\n11/03/2026,HARBOR COFFEE,Purchase,-6.50\n11/04/2026,CORNER MARKET,Purchase,-84.12\n11/05/2026,MOON BOOKS,Purchase,-18.75\n11/06/2026,PINE DINER,Purchase,-41.10\n11/07/2026,CITY TAX OFFICE,Refund,900.00\n11/08/2026,ACME INC,Payment,2400.00\n')
    expect(sheet().textContent).toContain('A column here reads like a card’s, so this reads as a card.')
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }))
    expect(tick(/CITY TAX OFFICE/).textContent).toContain('Refund')
    fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))
    expect(tick(/CITY TAX OFFICE/).textContent).not.toContain('Refund')
    await runImport('Import 6 transactions')
    expect((await stored()).filter((t) => t.type === 'income').map((t) => t.amount)).toEqual([900, 2400])
  })

  it('reads a plain-charges card in a bank’s words only once a person says what it is', async () => {
    await open(`${HEAD}11/03/2026,HARBOR AIRWAYS,812.00\n11/04/2026,GRAND HOTEL,640.00\n11/05/2026,ACME QB PAYROLL,45.00\n11/06/2026,AIRLINE FEE CREDIT,-200.00\n11/07/2026,HOTEL CREDIT,-100.00\n`)
    expect(document.querySelector('.import-ask')).not.toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    await runImport('Import 5 transactions')
    expect((await stored()).map((t) => t.amount)).toEqual([812, 640, 45, -200, -100])
  })

  it('says it read a bank account from nothing, without stopping the import', async () => {
    await open(SMALL_CREDITS)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(sheet().textContent).toContain('so this reads as a bank account')
    expect(ready().disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
    expect(sheet().textContent).not.toContain('so this reads as a bank account')
  })

  it('says nothing of a checking month whose rows say what they are', async () => {
    await open(`${HEAD}11/01/2026,CHECK 1042,-1850.00\n11/02/2026,ACME INC DIRECT DEP,2300.00\n11/03/2026,ATM DEPOSIT 0042,120.00\n11/04/2026,HARBOR COFFEE,-6.50\n11/05/2026,CORNER MARKET,-84.12\n`)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(sheet().textContent).not.toContain('so this reads as')
  })
})

describe('a file that says nothing strange', () => {
  it('reads a checking file with a Zelle to a friend in it as a bank account', async () => {
    await open('Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,11/03/2026,"Zelle payment to Sam Lee for thank you dinner; Conf# ab12",-35.00,QUICKPAY_DEBIT,1987.66,,\nDEBIT,11/04/2026,"CORNER MARKET",-54.20,DEBIT_CARD,1933.46,,\nCREDIT,11/06/2026,"ACME PAYROLL",2500.00,ACH_CREDIT,4433.46,,\n')
    expect(screen.getByRole('radio', { name: 'Bank account' }).getAttribute('aria-checked')).toBe('true')
    expect(tick(/ACME PAYROLL/).textContent).toContain('+$2,500.00')
    expect(tick(/Zelle/).textContent).toContain('−$35.00')
  })

  it.each([
    ['Chase checking', 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,11/03/2026,"Zelle payment to Sam Lee for thank you dinner; Conf# ab12",-35.00,QUICKPAY_DEBIT,1987.66,,\nDEBIT,11/04/2026,"CORNER MARKET",-54.20,DEBIT_CARD,1933.46,,\nCREDIT,11/06/2026,"ACME PAYROLL",2500.00,ACH_CREDIT,4433.46,,\n'],
    ['Chase card', 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n11/03/2026,11/03/2026,HARBOR COFFEE,Food,Sale,-12.34,\n11/06/2026,11/06/2026,ACME RETURN,Shopping,Return,4.00,\n'],
    ['Bank of America', 'Date,Description,Amount,Running Bal.\n11/03/2026,HARBOR COFFEE,-12.34,"1,987.66"\n11/04/2026,CORNER MARKET,-54.20,"1,933.46"\n11/06/2026,ACME PAYROLL,"2,500.00","4,433.46"\n'],
    ['Amex', 'Date,Description,Amount\n11/03/2026,HARBOR COFFEE,12.34\n11/04/2026,CORNER MARKET,54.20\n11/09/2026,ONLINE PAYMENT - THANK YOU,-300.00\n'],
  ])('asks nothing of %s', async (_, text) => {
    await open(text)
    expect(document.querySelector('.import-ask')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose Bank account or Card above' })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Import \d+ transactions?$/ }).disabled).toBe(false)
  })
})

describe('a removed row', () => {
  it('says it stays out when the file comes again', async () => {
    const FILE = `${HEAD}11/01/2026,HARBOR COFFEE,-4.50\n11/02/2026,Corner Market,-20.00\n`
    await open(FILE)
    await runImport('Import 2 transactions')
    cleanup()
    const [first] = await stored()
    await db.transactions.update(first.id!, { deleted: true })
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    await screen.findByText(/1 row removed earlier, and staying out\./)
    expect(sheet().textContent).toContain('1 row already here.')
    expect(await db.transactions.filter((t) => !t.deleted).count()).toBe(1)
  })
})

describe('a file read the wrong way', () => {
  const FILE = `${HEAD}11/10/2026,Corner Market,54.20\n11/12/2026,Harbor Coffee,6.00\n11/14/2026,Metro Fare,2.75\n`
  const amounts = async () => (await stored()).filter((t) => !t.deleted).map((t) => [t.note, t.type, t.amount])
  const RIGHT = [['Corner Market', 'expense', 54.2], ['Harbor Coffee', 'expense', 6], ['Metro Fare', 'expense', 2.75]]

  /** Two taps, with the gap a double tap does not have. */
  async function twoTaps(name: RegExp) {
    vi.useFakeTimers({ toFake: ['performance'] })
    fireEvent.click(screen.getByRole('button', { name }))
    await act(async () => {
      vi.advanceTimersByTime(DOUBLE_TAP_MS + 1)
    })
    fireEvent.click(await screen.findByRole('button', { name: /Tap again to undo/ }))
    vi.useRealTimers()
  }

  const asCard = () => fireEvent.click(screen.getByRole('radio', { name: 'Card' }))
  const asBank = () => fireEvent.click(screen.getByRole('radio', { name: 'Bank account' }))

  it('comes back out from the end of the import, to be read again', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    await twoTaps(/^Undo$/)
    await screen.findByRole('button', { name: 'Import 3 transactions' })
    expect(await amounts()).toEqual([])
    asCard()
    await runImport('Import 3 transactions')
    expect(await amounts()).toEqual(RIGHT)
    expect(await db.transactions.count()).toBe(3)
  })

  it('does nothing on a double tap', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to undo' }))
    expect((await amounts()).length).toBe(3)
  })

  it('can be undone later, before the file is chosen again', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    await screen.findByText(/3 rows · /)
    await twoTaps(/Undo last import/)
    await screen.findByText(/Removed 3 rows\./)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Undo last import/ })).toBeNull())
    choose(FILE)
    await screen.findByRole('radio', { name: 'Card' })
    asCard()
    await runImport('Import 3 transactions')
    expect(await amounts()).toEqual(RIGHT)
  })

  it('says when a file reads differently from the rows already here, and offers the way out', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    await screen.findByText('3 rows already here.')
    expect(sheet().textContent).not.toContain('reads differently')
    expect(sheet().textContent).not.toContain('read differently')
    asCard()
    await screen.findByText(/3 rows from your last import read differently now\./)
    await twoTaps(/Undo last import/)
    await runImport('Import 3 transactions')
    expect(await amounts()).toEqual(RIGHT)
  })

  it('does not question a correction, when the file comes in again read its first way', async () => {
    await open(FILE)
    asCard()
    await runImport('Import 3 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    await screen.findByText('3 rows already here.')
    expect(screen.getByRole('radio', { name: 'Bank account' }).getAttribute('aria-checked')).toBe('true')
    expect(sheet().textContent).not.toContain('from your last import')
    expect(sheet().textContent).toContain('There is nothing new in this file.')
  })

  it('offers the way out when another column gives the same money other words', async () => {
    const WIDE = 'Date,Details,Description,Amount\n11/10/2026,DEBIT,Corner Market,-54.20\n11/12/2026,DEBIT,Harbor Coffee,-6.00\n'
    await open(WIDE)
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '1' } })
    await runImport('Import 2 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(WIDE)
    await screen.findByText(/2 rows from your last import read differently now\./)
    await twoTaps(/Undo last import/)
    await runImport('Import 2 transactions')
    expect((await amounts()).map(([note]) => note)).toEqual(['Corner Market', 'Harbor Coffee'])
  })

  it('leaves a row taken out by hand alone until asked, then brings it back', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    cleanup()
    const [first] = await stored()
    await db.transactions.update(first.id!, { deleted: true, manual: true, updatedAt: 2 })
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    await screen.findByText(/1 row removed earlier, and staying out\./)
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Bring it back' }))
    asBank()
    await runImport('Import 1 transaction')
    expect((await amounts()).length).toBe(3)
    expect(sheet().textContent).toContain('Imported 1 transaction. Skipped 2 already here.')
  })

  it('counts a row left unticked when others come back', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    cleanup()
    const rows = await stored()
    await db.transactions.bulkUpdate(rows.slice(0, 2).map((t) => ({ key: t.id!, changes: { deleted: true, updatedAt: 2 } })))
    render(<ImportSheet onClose={() => {}} />)
    choose(FILE)
    fireEvent.click(await screen.findByRole('button', { name: 'Bring them back' }))
    fireEvent.click(tick(/Harbor Coffee/))
    asBank()
    await runImport('Import 1 transaction')
    expect(sheet().textContent).toContain('Imported 1 transaction. Skipped 1 already here. Left out 1 row.')
  })

  it('offers no way out for a look-alike or two in another file', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n`)
    await runImport('Import 1 transaction')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(`${HEAD}11/11/2026,ATM WITHDRAWAL,-54.20\n11/12/2026,Harbor Coffee,-6.00\n11/13/2026,Metro Fare,-2.75\n`)
    await screen.findByRole('checkbox', { name: /ATM WITHDRAWAL/ })
    expect(sheet().textContent).toContain('Looks like Corner Market')
    expect(sheet().textContent).not.toContain('from your last import')
  })

  it('says when an undo could not be done, and changes nothing', async () => {
    await open(FILE)
    asBank()
    await runImport('Import 3 transactions')
    vi.spyOn(db.transactions, 'where').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await twoTaps(/^Undo$/)
    await screen.findByText('Could not undo. Try again.')
    expect((await amounts()).length).toBe(3)
    await act(async () => {
      await new Promise((r) => setTimeout(r, DOUBLE_TAP_MS + 1))
    })
    await twoTaps(/^Undo$/)
    await screen.findByRole('button', { name: 'Import 3 transactions' })
    expect(screen.queryByText('Could not undo. Try again.')).toBeNull()
  })
})

describe('when only rows that would count twice are left', () => {
  const PAID = `${HEAD}11/10/2026,Corner Market,-54.20\n11/12/2026,ONLINE TRANSFER TO SAVINGS,-200.00\n`

  it('ends on Done, and a tick still brings a row in', async () => {
    await open(PAID)
    await runImport('Import 1 transaction')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(PAID)
    await screen.findByText('There is nothing new to import unless you tick a row.')
    expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull()
    fireEvent.click(tick(/ONLINE TRANSFER/))
    await runImport('Import 1 transaction')
    expect(await db.transactions.count()).toBe(2)
  })

  it('lets the sheet go with Escape, as there is nothing to lose', async () => {
    await open(PAID)
    await runImport('Import 1 transaction')
    cleanup()
    const closed = vi.fn()
    render(<ImportSheet onClose={closed} />)
    choose(PAID)
    await screen.findByText('There is nothing new to import unless you tick a row.')
    // The sheet hears it has nothing to lose in an effect, just after that text lands.
    await act(async () => {})
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(closed).toHaveBeenCalled())
  })

  it('leaves the disabled button when a person has unticked everything', async () => {
    await open(`${HEAD}11/10/2026,Corner Market,-54.20\n`)
    fireEvent.click(tick(/Corner Market/))
    const button = await screen.findByRole('button', { name: 'Import 0 transactions' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('this app’s own export', () => {
  const OWN = 'Date,Description,Amount,Type,Category,Account,Status\n2026-11-03,Corner Market,-54.20,Expense,,,Posted\n2026-11-04,Corner Market,12.00,Refund,,,Posted\n2026-11-05,Payroll,3200.00,Income,,,Posted\n'

  it('comes back as it went out, with no question about what it is', async () => {
    await open(OWN)
    expect(screen.queryByRole('radiogroup', { name: 'What this file is from' })).toBeNull()
    await runImport('Import 3 transactions')
    expect((await stored()).map((t) => [t.amount, t.type])).toEqual([[54.2, 'expense'], [-12, 'expense'], [3200, 'income']])
  })

  it('is already here when it comes back to the same ledger', async () => {
    await open(OWN)
    await runImport('Import 3 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(OWN)
    await screen.findByText('3 rows already here.')
  })
})

describe('what an import will write', () => {
  const CHECKING = `${HEAD}11/01/2026,ACME PAYROLL,2210.00\n11/02/2026,HARBOR COFFEE,-14.25\n11/03/2026,RENT PORTAL,-1650.00\n11/04/2026,CORNER MARKET,-61.40\n`
  const block = () => document.querySelector<HTMLElement>('.import-sum')
  const lines = () => [...block()!.querySelectorAll('.import-sum-line')].map((l) => [...l.querySelectorAll('dt, dd > span, dd.num')].map((c) => c.textContent).join(' | '))
  const head = () => block()!.querySelector('.import-sum-head')!.textContent
  const seg = (group: string, label: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: label }))
  const pick = (label: string, value: number) => {
    const select = [...document.querySelectorAll<HTMLLabelElement>('.field-line')].find((l) => l.textContent?.startsWith(label))!.querySelector('select')!
    fireEvent.change(select, { target: { value } })
  }

  it('says it above the button, in the part of the sheet that does not scroll', async () => {
    await open(CHECKING)
    expect(head()).toBe('This import adds4 rows')
    expect(lines()).toEqual(['Money in | $2,210.00', 'Money out | $1,725.65', 'Largest money in | ACME PAYROLL | $2,210.00', 'Largest money out | RENT PORTAL | $1,650.00'])
    expect(block()!.closest('.sheet-actions')).not.toBeNull()
    expect(block()!.closest('.sheet-body')).toBeNull()
    expect(block()!.nextElementSibling).toBe(await importButton('Import 4 transactions'))
  })

  it('moves with every tick, down to nothing and back', async () => {
    await open(CHECKING)
    fireEvent.click(tick(/RENT PORTAL/))
    expect(lines()).toEqual(['Money in | $2,210.00', 'Money out | $75.65', 'Largest money in | ACME PAYROLL | $2,210.00', 'Largest money out | CORNER MARKET | $61.40'])
    expect(head()).toBe('This import adds3 rows')
    for (const name of [/ACME PAYROLL/, /HARBOR COFFEE/, /CORNER MARKET/]) fireEvent.click(tick(name))
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $0.00'])
    expect(head()).toBe('This import adds0 rows')
    fireEvent.click(tick(/ACME PAYROLL/))
    expect(lines()).toEqual(['Money in | $2,210.00', 'Money out | $0.00', 'Largest money in | ACME PAYROLL | $2,210.00'])
  })

  it('gives refunds a line of their own, only when there are any, and leaves a card’s payment out until it is ticked', async () => {
    await open(`${HEAD}11/01/2026,HARBOR COFFEE,-14.25\n11/02/2026,CORNER MARKET,-61.40\n11/03/2026,ACME RETURN,20.00\n11/04/2026,PAYMENT THANK YOU,300.00\n`)
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $75.65', 'Refunds | $20.00', 'Largest money out | CORNER MARKET | $61.40'])
    fireEvent.click(tick(/ACME RETURN/))
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $75.65', 'Largest money out | CORNER MARKET | $61.40'])
    fireEvent.click(tick(/PAYMENT THANK YOU/))
    expect(lines()).toEqual(['Money in | $300.00', 'Money out | $75.65', 'Largest money in | PAYMENT THANK YOU | $300.00', 'Largest money out | CORNER MARKET | $61.40'])
  })

  it('shows a flipped file at once: pay as the largest money out', async () => {
    await open(CHECKING)
    seg('What this file is from', 'Card')
    seg('How charges read', 'Charges are positive')
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $2,210.00', 'Refunds | $1,725.65', 'Largest money out | ACME PAYROLL | $2,210.00'])
  })

  it('stands in the stop for an unproven sign, and says what the choice would do', async () => {
    await open(`${HEAD}11/01/2026,HARBOR COFFEE,14.25\n11/02/2026,CORNER MARKET,61.40\n11/03/2026,MOON BOOKS,18.75\n`)
    expect(head()).toBe('This import would add3 rows')
    expect(lines()[0]).toBe('Money in | $94.40')
    const stopped = await importButton('Choose Bank account or Card above')
    expect((stopped as HTMLButtonElement).disabled).toBe(true)
    seg('What this file is from', 'Card')
    expect(head()).toBe('This import adds3 rows')
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $94.40', 'Largest money out | CORNER MARKET | $61.40'])
    seg('What this file is from', 'Bank account')
    expect(lines()[0]).toBe('Money in | $94.40')
  })

  it('follows a change of columns, and a change of In or out', async () => {
    await open('Date,Description,Amount,Fee,Transaction Type\n11/01/2026,ACME PAYROLL,2210.00,1.00,Credit\n11/02/2026,HARBOR COFFEE,14.25,2.00,Debit\n11/03/2026,CORNER MARKET,61.40,3.00,Debit\n')
    expect(lines()).toEqual(['Money in | $2,210.00', 'Money out | $75.65', 'Largest money in | ACME PAYROLL | $2,210.00', 'Largest money out | CORNER MARKET | $61.40'])
    pick('Amount', 3)
    expect(lines()).toEqual(['Money in | $1.00', 'Money out | $5.00', 'Largest money in | ACME PAYROLL | $1.00', 'Largest money out | CORNER MARKET | $3.00'])
    pick('In or out', -1)
    expect(lines()).toEqual(['Money in | $6.00', 'Money out | $0.00', 'Largest money in | CORNER MARKET | $3.00'])
  })

  it('says exactly what the ledger then holds', async () => {
    await open(CHECKING)
    fireEvent.click(tick(/HARBOR COFFEE/))
    const shown = lines()
    await runImport('Import 3 transactions')
    const rows = await stored()
    expect(rows).toHaveLength(3)
    expect(shown[0]).toBe(`Money in | $${rows.filter((t) => t.type === 'income').reduce((n, t) => n + t.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
    expect(shown[1]).toBe(`Money out | $${rows.filter((t) => t.type === 'expense').reduce((n, t) => n + t.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
  })

  it('counts what would come back only once a person has brought it back', async () => {
    await open(CHECKING)
    await runImport('Import 4 transactions')
    cleanup()
    await db.transactions.filter((t) => t.note === 'RENT PORTAL').modify({ deleted: true })
    render(<ImportSheet onClose={() => {}} />)
    choose(`${CHECKING}11/05/2026,MOON BOOKS,-18.75\n`)
    await importButton('Import 1 transaction')
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $18.75', 'Largest money out | MOON BOOKS | $18.75'])
    fireEvent.click(await screen.findByRole('button', { name: 'Bring it back' }))
    await importButton('Import 2 transactions')
    expect(lines()[1]).toBe('Money out | $1,668.75')
  })

  it('reads an OFX file the same way', async () => {
    await open('<OFX><STMTRS><BANKACCTFROM><ACCTID>1234</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-12.00<FITID>1<NAME>CORNER MARKET</STMTTRN><STMTTRN><DTPOSTED>20261104<TRNAMT>3200.00<FITID>2<NAME>ACME PAYROLL</STMTTRN></STMTRS></OFX>', 'export.qfx')
    expect(lines()).toEqual(['Money in | $3,200.00', 'Money out | $12.00', 'Largest money in | ACME PAYROLL | $3,200.00', 'Largest money out | CORNER MARKET | $12.00'])
  })

  it('names a row with no words as the sheet does', async () => {
    await open(`${HEAD}11/01/2026,,-14.25\n`)
    expect(lines()).toEqual(['Money in | $0.00', 'Money out | $14.25', 'Largest money out | No description | $14.25'])
  })

  it('is not there when nothing would come in', async () => {
    await open(CHECKING)
    await runImport('Import 4 transactions')
    cleanup()
    render(<ImportSheet onClose={() => {}} />)
    choose(CHECKING)
    await screen.findByText('4 rows already here.')
    expect(block()).toBeNull()
  })

  it('tells a screen reader what changed, as one thing, with each figure beside its name', async () => {
    await open(CHECKING)
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('true')
    const terms = [...block()!.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.tagName])
    expect(terms).toEqual([['Money in', 'DD'], ['Money out', 'DD'], ['Largest money in', 'DD'], ['Largest money out', 'DD']])
  })
})

describe('a file the rounds of reading could not settle', () => {
  const seg = (group: string, label: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: label }))

  it('asks of a card with more money back than charges, and reads it right on Card', async () => {
    await open(`${HEAD}11/01/2026,ANNUAL MEMBERSHIP FEE,95.00\n11/02/2026,AIRLINE FEE CREDIT,-50.00\n11/03/2026,HOTEL CREDIT,-50.00\n11/04/2026,DINING CREDIT,-10.00\n`)
    expect(screen.getByRole('alert').textContent).toContain('reads like money coming back')
    seg('What this file is from', 'Card')
    expect(tick(/ANNUAL MEMBERSHIP FEE/).textContent).toContain('−$95.00')
    expect(tick(/HOTEL CREDIT/).textContent).toContain('Refund')
  })

  it('offers In or out where a column’s words run against the figures, as a stray minus makes plain figures look signed', async () => {
    await open('Date,Description,Amount,Transaction Type\n11/01/2026,CORNER MARKET,74.10,Debit\n11/02/2026,HARBOR COFFEE,-38.06,Debit\n11/03/2026,ACME INC,1800.00,Credit\n')
    const label = [...document.querySelectorAll<HTMLLabelElement>('.field-line')].find((l) => l.textContent?.startsWith('In or out'))!
    fireEvent.change(label.querySelector('select')!, { target: { value: 3 } })
    expect(tick(/CORNER MARKET/).textContent).toContain('−$74.10')
    expect(tick(/ACME INC/).textContent).toContain('+$1,800.00')
  })

  it('says a file of one direction word holds one way, and shows it so', async () => {
    await open('Date,Description,Amount,Transaction Type\n11/01/2026,CORNER MARKET,74.10,Debit\n11/02/2026,HARBOR COFFEE,38.06,Debit\n')
    expect(sheet().textContent).toContain('Transaction Type says which way each row ran: 2 money out, 0 money in. If money also went the other way, it is not in this file.')
    expect(tick(/CORNER MARKET/).textContent).toContain('−$74.10')
  })
})
