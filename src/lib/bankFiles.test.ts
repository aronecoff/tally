/**
 * Real export layouts, read from the file to the rows a person sees. A file that
 * cannot settle which way its money runs has to say so. The layouts are real; the
 * merchants, names and figures are invented.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import type { Category } from '../db/db'
import { marksOf, parseAmount, readTable, rereadCells } from './csv'
import { stageRows, type SignMode, type StagedRow } from './csvImport'
import { ImportFileError, readImportFile, readTableSign } from './importFile'

const cats: Category[] = [
  { id: 1, name: 'Groceries', key: 'groceries', icon: 'cart', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 2, name: 'Salary', key: 'salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
]

/** A row as the sheet shows it: spending, money in, or a refund. */
const show = (r: StagedRow) =>
  `${r.amount < 0 ? 'refund ' : r.type === 'income' ? '+' : '-'}${Math.abs(r.amount).toFixed(2)}${r.movement ? ' unticked' : ''}`

async function read(text: string) {
  const file = await readImportFile(new Blob([text]))
  const { rows, leftOut } = stageRows(file.rows, file.cols, file.sign, cats, { paid: file.sign === 'negative-expense' ? undefined : file.paid })
  const { note } = file.format === 'csv' && !file.kinds ? readTableSign(file, file.cols) : { note: undefined }
  return { ...file, leftOut, note, read: Object.fromEntries(rows.map((r) => [r.note, show(r)])) }
}

/** The same file once a person has said how it reads. */
async function readAs(text: string, mode: SignMode) {
  const file = await readImportFile(new Blob([text]))
  const { rows } = stageRows(file.rows, file.cols, mode, cats, { paid: mode === 'negative-expense' ? undefined : file.paid })
  return Object.fromEntries(rows.map((r) => [r.note, show(r)]))
}

const header = (text: string) => {
  const { headers, cols } = readTable(`${text}\n`)
  const name = (at?: number) => (at != null && at >= 0 ? headers[at] : '')
  return { amount: name(cols.amount), inflow: name(cols.inflow), date: name(cols.date), note: name(cols.note) }
}

/** Bank rows as Chase writes them. */
const CHASE_HEAD = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n'
const CHASE_ROWS = `DEBIT,11/03/2026,"HARBOR COFFEE",-12.34,DEBIT_CARD,1987.66,,
DEBIT,11/04/2026,"CORNER MARKET",-54.20,DEBIT_CARD,1933.46,,
DEBIT,11/05/2026,"TRAIL BIKE SHOP",-230.00,DEBIT_CARD,1703.46,,
CREDIT,11/06/2026,"ACME PAYROLL",2500.00,ACH_CREDIT,4203.46,,
DEBIT,11/07/2026,"MOON BOOKS",-18.75,DEBIT_CARD,4184.71,,
DEBIT,11/08/2026,"PINE DINER",-41.10,DEBIT_CARD,4143.61,,
`
const chaseWith = (note: string, amount: string) => `${CHASE_HEAD}${CHASE_ROWS}${amount.startsWith('-') ? 'DEBIT' : 'CREDIT'},11/09/2026,"${note}",${amount},ACH_DEBIT,4000.00,,\n`

/** A card's rows, charges as money out. */
const CARD_ROWS = `11/03/2026,HARBOR COFFEE,-12.34
11/04/2026,CORNER MARKET,-54.20
11/05/2026,TRAIL BIKE SHOP,-230.00
11/06/2026,ACME RETURN,40.00
11/07/2026,MOON BOOKS,-18.75
`
const cardWith = (note: string, amount = '300.00') => `Date,Description,Amount\n${CARD_ROWS}11/09/2026,${note},${amount}\n`

describe('a card being paid', () => {
  it.each([
    'PAYMENT THANK YOU',
    'Payment Thank You - Web',
    'Payment Thank You-Mobile',
    'AUTOMATIC PAYMENT - THANK YOU',
    'AUTOMATIC PAYMENT - THANK',
    'ONLINE PAYMENT - THANK YOU',
    'MOBILE PAYMENT - THANK YOU',
    'INTERNET PAYMENT - THANK YOU',
    'MOBILE PYMT THANK YOU',
    'AUTOPAY PAYMENT THANK YOU',
    'PAYMENT RECEIVED - THANK YOU',
    'THANK YOU FOR YOUR PAYMENT',
  ])('takes %s for the issuer’s own line', async (note) => {
    const file = await read(cardWith(note))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('reads a Zelle to a person, whatever its memo says, as a bank file', async () => {
    const file = await read(chaseWith('Zelle payment to Sam Lee for thank you dinner; Conf# ab12', '-35.00'))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
    expect(file.read['Zelle payment to Sam Lee for thank you dinner; Conf# ab12']).toBe('-35.00')
  })

  it.each([
    ['Zelle payment from Sam Lee for thank you; Conf# ab12', '35.00'],
    ['PAY N SAVE THANK YOU CARD', '-5.00'],
    ['ZELLE PAYMENT THANK YOU', '-35.00'],
    ['VENMO PAYMENT THANK YOU', '-35.00'],
    ['CASH APP PAYMENT THANK YOU', '-35.00'],
    ['PAYPAL PAYMENT THANK YOU', '-35.00'],
    ['PAYMENT TO SAM LEE THANK YOU', '-35.00'],
    ['PAYMENT FROM SAM LEE THANK YOU', '35.00'],
    ['PAYMENT FOR THANK YOU CARDS', '-35.00'],
    ['CITY WATER PAYMENT THANK YOU', '-60.00'],
    ['ACME PAYMENT THANK YOU BONUS', '35.00'],
  ])('takes %s for no card line', async (note, amount) => {
    const file = await read(chaseWith(note, amount))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('asks when an issuer’s words sit on the same side as most of the file', async () => {
    const file = await read(chaseWith('PAYMENT THANK YOU', '-60.00'))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('asks when a paycheck sits where a card would see a refund', async () => {
    const file = await read(chaseWith('PAYMENT THANK YOU', '500.00'))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('asks when a large row with no word for it sits where a card would see a refund', async () => {
    const text = `Date,Description,Amount\n11/03/2026,HARBOR COFFEE,-12.34\n11/04/2026,CORNER MARKET,-54.20\n11/06/2026,ACME INC 4471,2500.00\n11/07/2026,PAYMENT THANK YOU,300.00\n`
    expect(await read(text)).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('asks when payment lines run both ways', async () => {
    const text = `Date,Description,Amount\n11/03/2026,HARBOR COFFEE,-12.34\n11/04/2026,CORNER MARKET,-54.20\n11/05/2026,PAYMENT THANK YOU,50.00\n11/06/2026,PAYMENT THANK YOU,-50.00\n`
    expect(await read(text)).toMatchObject({ sign: 'negative-expense', signProven: false })
  })
})

describe('a column of money beside other figures', () => {
  it('uses Amount Out and not the running Total before it', () => {
    expect(header('Date,Description,Total,Amount Out')).toMatchObject({ amount: 'Amount Out', inflow: '' })
    expect(header('Date,Description,Value,Amount In')).toMatchObject({ amount: 'Amount In', inflow: '' })
  })

  it('reads the signed figures of a lone Amount Out as they are written', async () => {
    const file = await read(`Date,Description,Total,Amount Out\n11/03/2026,HARBOR COFFEE,1987.66,-12.34\n11/06/2026,ACME PAYROLL,4203.46,2500.00\n`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })
})

describe('a lone column that says a direction', () => {
  const charges = '11/03/2026,HARBOR COFFEE,12.34,1987.66\n11/04/2026,CORNER MARKET,54.20,1933.46\n'
  const SPENT = { 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20' }

  it.each([
    'Date,Description,Debit,Available Credit',
    'Date,Description,Debit,Credit Balance',
    'Date,Description,Withdrawal,Deposit Balance',
    'Date,Description,Debit Amount,Balance',
    'Date,Description,Amount Out,Balance',
  ])('reads plain figures as money out: %s', async (head) => {
    const file = await read(`${head}\n${charges}`)
    expect(file.read).toEqual(SPENT)
    expect(file.leftOut).toEqual([])
    expect(file.signProven).toBe(true)
    expect(file.cols.way).toBe('out')
  })

  it('reads a plain lone Debit as money out', async () => {
    const file = await read('Date,Description,Debit\n11/03/2026,HARBOR COFFEE,12.34\n11/04/2026,CORNER MARKET,54.20\n')
    expect(file.read).toEqual(SPENT)
  })

  it.each(['Credit', 'Deposit', 'Money In', 'Paid In', 'Amount In'])('reads plain figures as money in: %s', async (name) => {
    const file = await read(`Date,Description,${name}\n11/06/2026,ACME PAYROLL,2500.00\n11/20/2026,ACME PAYROLL,2500.00\n`)
    expect(file.read).toEqual({ 'ACME PAYROLL': '+2500.00' })
    expect(file.signProven).toBe(true)
    expect(file.cols.way).toBe('in')
  })

  it('reads a lone Credit written with minus signs as money in, as a card writes it', async () => {
    const file = await read('Date,Description,Credit\n11/06/2026,ACME RETURN,-40.00\n11/07/2026,MOON RETURN,-18.75\n')
    expect(file.read).toEqual({ 'ACME RETURN': '+40.00', 'MOON RETURN': '+18.75' })
    expect(file.signProven).toBe(true)
  })

  it('leaves a figure with its own sign alone', async () => {
    const file = await read('Date,Description,Debit\n11/03/2026,HARBOR COFFEE,-12.34\n11/06/2026,ACME PAYROLL,2500.00\n')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
    expect(file.cols.way).toBeUndefined()
  })
})

describe('a Debit and Credit pair beside an Amount', () => {
  const PAIR = { amount: 'Debit', inflow: 'Credit' }

  it.each([['Bal Amount'], ['Bal. Amount'], ['Closing Amount'], ['Ledger Amount'], ['Outstanding Amount'], ['Remaining Amount'], ['Fee Amount'], ['Previous Amount'], ['Ending Amount'], ['Opening Amount']])(
    'takes the pair over %s',
    (amount) => {
      expect(header(`Date,Description,Debit,Credit,${amount}`)).toMatchObject(PAIR)
      expect(header(`Date,Description,${amount},Debit,Credit`)).toMatchObject(PAIR)
    },
  )

  it('takes the pair over an Amount another word makes something else', () => {
    expect(header('Date,Description,Debit,Credit,Hold Amount')).toMatchObject(PAIR)
    expect(header('Date,Description,Withdrawal,Deposit,Tax Amount')).toMatchObject({ amount: 'Withdrawal', inflow: 'Deposit' })
  })

  it.each(['Amount', 'AMOUNT', 'Transaction Amount', 'Amount (USD)', 'Amount USD', 'Amount in USD', 'Amount ($)', 'USD Amount'])('lets %s beat the pair', (amount) => {
    expect(header(`Date,Description,Debit,Credit,${amount}`)).toMatchObject({ amount, inflow: '' })
    expect(header(`Date,Description,${amount},Debit,Credit`)).toMatchObject({ amount, inflow: '' })
  })

  it.each([
    'Bal Amount', 'Closing Amount', 'Ending Amount', 'Opening Amount', 'Ledger Amount', 'Outstanding Amount', 'Remaining Amount', 'Previous Amount',
    'Fee Amount', 'Tax Amount', 'Shipping Amount', 'Handling Amount', 'Insurance Amount', 'Discount Amount', 'Tip Amount',
  ])('picks no money when %s is all there is', async (amount) => {
    expect(header(`Date,Description,${amount}`).amount).toBe('')
    const file = await read(`Date,Description,${amount}\n11/03/2026,HARBOR COFFEE,1987.66\n`)
    expect(file.read).toEqual({})
  })
})

describe('Amount Out and Amount In', () => {
  it.each([
    ['Amount Out (USD)', 'Amount In (USD)'],
    ['Amount Out USD', 'Amount In USD'],
    ['Amount (Out)', 'Amount (In)'],
    ['Out Amount', 'In Amount'],
    ['AmountOut', 'AmountIn'],
    ['Amount Out', 'Amount In'],
    ['Amount Paid', 'Amount Received'],
  ])('reads %s and %s as a pair, whichever comes first', (out, into) => {
    expect(header(`Date,Description,${out},${into},Balance`)).toMatchObject({ amount: out, inflow: into })
    expect(header(`Date,Description,${into},${out},Balance`)).toMatchObject({ amount: out, inflow: into })
  })

  it('keeps Amount in USD alone as one signed column', () => {
    expect(header('Date,Description,Amount in USD,Balance')).toMatchObject({ amount: 'Amount in USD', inflow: '' })
    expect(header('Date,Description,Amount Out,Amount in USD')).toMatchObject({ amount: 'Amount in USD', inflow: '' })
  })
})

describe('a direction column beside plain figures', () => {
  const RIGHT = { 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00' }

  it('reads Mint', async () => {
    const file = await read(`"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"
"11/03/2026","HARBOR COFFEE","HARBOR COFFEE","12.34","debit","Food","Checking","",""
"11/04/2026","CORNER MARKET","CORNER MARKET","54.20","debit","Food","Checking","",""
"11/06/2026","ACME PAYROLL","ACME PAYROLL","2500.00","credit","Pay","Checking","",""
`)
    expect(file.read).toEqual(RIGHT)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, cols: { amount: 3, direction: 4 } })
  })

  it('reads Capital One 360', async () => {
    const file = await read(`Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance
1234,HARBOR COFFEE,11/03/26,Debit,12.34,1987.66
1234,CORNER MARKET,11/04/26,Debit,54.20,1933.46
1234,ACME PAYROLL,11/06/26,Credit,2500.00,4433.46
`)
    expect(file.read).toEqual(RIGHT)
    expect(file.cols.direction).toBe(3)
  })

  it('reads Navy Federal', async () => {
    const file = await read(`Posting Date,Transaction Date,Amount,Credit Debit Indicator,type,Type Group,Reference,Instructions,Description
11/03/2026,11/03/2026,12.34,Debit,Debit Card,Purchase,123,,HARBOR COFFEE
11/04/2026,11/04/2026,54.20,Debit,Debit Card,Purchase,124,,CORNER MARKET
11/06/2026,11/06/2026,2500.00,Credit,Deposit,Deposit,125,,ACME PAYROLL
`)
    expect(file.read).toEqual(RIGHT)
    expect(file.cols.direction).toBe(3)
  })

  it.each([
    ['DR', 'CR'],
    ['Withdrawal', 'Deposit'],
    ['Outflow', 'Inflow'],
    ['DEBIT', 'CREDIT'],
  ])('reads %s and %s, in any column', async (out, into) => {
    const file = await read(`Date,Way,Description,Amount\n11/03/2026,${out},HARBOR COFFEE,12.34\n11/04/2026,${out},CORNER MARKET,54.20\n11/06/2026,${into},ACME PAYROLL,2500.00\n`)
    expect(file.read).toEqual(RIGHT)
  })

  it('leaves amounts that are already signed alone', async () => {
    const file = await read(`Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance
1234,HARBOR COFFEE,11/03/2026,Debit,-12.34,1987.66
1234,ACME PAYROLL,11/06/2026,Credit,2500.00,4433.46
`)
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })

  it('takes no direction from a column that only has one now and then', async () => {
    const file = await read(`Date,Description,Amount,Remark
11/03/2026,HARBOR COFFEE,12.34,
11/04/2026,CORNER MARKET,54.20,
11/06/2026,ACME PAYROLL,2500.00,credit
11/08/2026,PINE DINER,41.10,
`)
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file.signProven).toBe(false)
  })

  it('leaves out a row whose direction cannot be read, and says why', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `11/${String(i + 1).padStart(2, '0')}/2026,SHOP ${i},1${i}.00,debit`)
    const file = await read(`Date,Description,Amount,Kind\n${rows.join('\n')}\n11/19/2026,ACME PAYROLL,2500.00,credit\n11/20/2026,MYSTERY,50.00,pending\n`)
    expect(file.leftOut).toMatchObject([{ why: 'way', note: 'MYSTERY' }])
  })

  it('reads a file’s payment line beside its direction words', async () => {
    const file = await read(`Date,Description,Amount,Kind
11/03/2026,HARBOR COFFEE,12.34,debit
11/04/2026,ACME RETURN,4.00,credit
11/05/2026,PAYMENT THANK YOU,100.00,credit
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 4.00')
  })
})

describe('evidence of a card', () => {
  const APPLE = 'Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n'
  const apple = (note: string, type: string, amount: string) => `11/03/2026,11/04/2026,${note},${note},Other,${type},${amount},A Person\n`
  const APPLE_ROWS = [
    apple('HARBOR COFFEE', 'Purchase', '12.34'),
    apple('CORNER MARKET', 'Purchase', '54.20'),
    apple('TRAIL BIKE SHOP', 'Purchase', '230.00'),
    apple('MOON BOOKS', 'Purchase', '18.75'),
    apple('ACME RETURN', 'Return', '-40.00'),
    apple('DAILY CASH ADJUSTMENT', 'Adjustment', '-3.00'),
    apple('ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234', 'Payment', '-300.00'),
  ].join('')

  it('reads Apple Card: 4 purchases, 1 return, 1 cash adjustment and 1 payment', async () => {
    const file = await read(APPLE + APPLE_ROWS)
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
    expect(file.read['ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234']).toContain('unticked')
  })

  it('reads Apple Card by its purchases, however many payments a month has', async () => {
    const file = await read(APPLE + [apple('HARBOR COFFEE', 'Purchase', '11.25'), apple('REF 1', 'Payment', '-100.00'), apple('REF 2', 'Payment', '-100.00'), apple('REF 3', 'Payment', '-100.00')].join(''))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['HARBOR COFFEE']).toBe('-11.25')
    expect(file.read['REF 1']).toContain('unticked')
  })

  it('reads an Apple Card month of nothing but credits as a card', async () => {
    const file = await read(APPLE + [apple('REF 1', 'Payment', '-100.00'), apple('DAILY CASH ADJUSTMENT', 'Adjustment', '-3.00')].join(''))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['REF 1']).toContain('unticked')
    expect(file.read['DAILY CASH ADJUSTMENT']).toBe('refund 3.00')
  })

  it.each([
    ['Amount (USD) beside Purchased By', 'Date,Description,Amount (USD),Purchased By\n', (r: string) => `${r},A Person`],
    ['Amount (USD) beside Clearing Date', 'Date,Clearing Date,Description,Amount (USD)\n', (r: string) => { const [d, n, a] = r.split(','); return `${d},${d},${n},${a}` }],
  ])('takes %s for a card, and says what that rests on', async (_, head, row) => {
    const rows = ['11/03/2026,HARBOR COFFEE,12.34', '11/04/2026,CORNER MARKET,54.20', '11/05/2026,MOON BOOKS,18.75', '11/06/2026,ACME RETURN,-40.00']
    const file = await read(head + rows.map(row).join('\n') + '\n')
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true, note: 'column' })
    const even = await read(head + [...rows, '11/07/2026,PINE DINER,-41.10'].map(row).join('\n') + '\n')
    expect(even).toMatchObject({ sign: 'card-positive', signProven: false })
  })

  it('takes a Type column of Sale and Return for a card', async () => {
    const file = await read(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
11/03/2026,11/03/2026,HARBOR COFFEE,Food & Drink,Sale,-12.34,
11/04/2026,11/04/2026,CORNER MARKET,Groceries,Sale,-54.20,
11/06/2026,11/06/2026,ACME RETURN,Shopping,Return,40.00,
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('asks of a Type column of a Return and a Payment, with no charge in the file to go by', async () => {
    const file = await read(`Date,Description,Type,Amount
11/06/2026,ACME RETURN,Return,40.00
11/09/2026,AUTOMATIC PAYMENT - THANK,Payment,300.00
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('takes a row whose Type says Payment for a payment line, whatever its words', async () => {
    const file = await read(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
11/03/2026,11/03/2026,HARBOR COFFEE,Food & Drink,Sale,-12.34,
11/04/2026,11/04/2026,CORNER MARKET,Groceries,Sale,-54.20,
11/06/2026,11/06/2026,ACME RETURN,Shopping,Return,40.00,
11/09/2026,11/09/2026,REF 9921 ACCT SETTLE,,Payment,300.00,
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['REF 9921 ACCT SETTLE']).toBe('+300.00 unticked')
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('takes a charge Type on one side and a payment on the same side as no proof', async () => {
    const file = await read(`Date,Description,Type,Amount
11/03/2026,HARBOR COFFEE,Purchase,12.34
11/04/2026,CORNER MARKET,Purchase,54.20
11/05/2026,MOON BOOKS,Payment,300.00
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('takes no Type column of every row Payment for a card', async () => {
    const file = await read(`Date,Name,Type,Net
11/03/2026,HARBOR COFFEE,Payment,-12.34
11/04/2026,CORNER MARKET,Payment,-54.20
11/06/2026,ACME PAYROLL,Payment,2500.00
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('takes no Type column with a bank’s words in it for a card', async () => {
    const file = await read(`Date,Description,Type,Amount
11/03/2026,HARBOR COFFEE,Purchase,-12.34
11/04/2026,CORNER MARKET,Purchase,-54.20
11/06/2026,ACME PAYROLL,Deposit,2500.00
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('asks of Mercury: a card’s name beside a payday', async () => {
    const file = await read(`Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Category,GL Code,Timestamp,Original Currency
11/03/2026,HARBOR COFFEE,-12.34,Sent,Checking,HARBOR COFFEE,,,1234,A Person,Food,,11/03/2026 10:00:00,USD
11/04/2026,CORNER MARKET,-54.20,Sent,Checking,CORNER MARKET,,,1234,A Person,Food,,11/04/2026 10:00:00,USD
11/06/2026,ACME PAYROLL,2500.00,Sent,Checking,ACME PAYROLL,,,,,Income,,11/06/2026 10:00:00,USD
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('asks of Wise: a card’s number and holder beside a deposit', async () => {
    const file = await read(`TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance,Exchange From,Exchange To,Exchange Rate,Payer Name,Payee Name,Payee Account Number,Merchant,Card Last Four Digits,Card Holder Full Name,Attachment,Note,Total fees
T1,11/03/2026,-12.34,USD,HARBOR COFFEE,,1987.66,,,,,,,,1234,A Person,,,0.00
T2,11/04/2026,-54.20,USD,CORNER MARKET,,1933.46,,,,,,,,1234,A Person,,,0.00
T3,11/06/2026,20.00,USD,SAM LEE,,1953.46,,,,,,,,,,,,0.00
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['SAM LEE']).toBe('+20.00')
  })

  it('asks of a card column beside a pair, where a payday would read as a refund', async () => {
    const file = await read(`Date,Description,Debit,Credit,Credit Card Payment
11/03/2026,HARBOR COFFEE,12.34,,
11/04/2026,CORNER MARKET,54.20,,
11/06/2026,ACME PAYROLL,,2500.00,
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('keeps a card column a card when nothing beside it says otherwise', async () => {
    const file = await read(`Date,Description,Card Member,Account #,Amount
11/03/2026,HARBOR COFFEE,A PERSON,-41007,12.34
11/04/2026,CORNER MARKET,A PERSON,-41007,54.20
11/05/2026,MOON BOOKS,A PERSON,-41007,18.75
11/06/2026,ACME RETURN,A PERSON,-41007,-40.00
`)
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('reads a member name as a card column', async () => {
    const file = await read(`Status,Date,Description,Debit,Credit,Member Name
Cleared,11/03/2026,HARBOR COFFEE,12.34,,A PERSON
Cleared,11/04/2026,CORNER MARKET,54.20,,A PERSON
Cleared,11/06/2026,ACME RETURN,,-40.00,A PERSON
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('does not ask of a bank file that only has rows going out', async () => {
    const file = await read(`Date,Description,Amount,Name On Card,Running Balance
11/03/2026,HARBOR COFFEE,-12.34,A Person,1987.66
11/04/2026,CORNER MARKET,-54.20,A Person,1933.46
`)
    expect(file.signProven).toBe(true)
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
  })
})

describe('a mix of money in and money out with nothing to settle it', () => {
  const lines = (rows: [string, string][]) => `Date,Description,Amount\n${rows.map(([n, a], i) => `11/${String(i + 1).padStart(2, '0')}/2026,${n},${a}`).join('\n')}\n`

  it('asks of a card with no name on it: 4 purchases and 3 credits', async () => {
    const file = await read(lines([['HARBOR COFFEE', '12.34'], ['CORNER MARKET', '54.20'], ['TRAIL BIKE SHOP', '230.00'], ['MOON BOOKS', '18.75'], ['ACME RETURN', '-40.00'], ['DAILY CASH', '-3.00'], ['SETTLED', '-300.00']]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('does not stop a file whose money out is ahead by a little, and says what it read', async () => {
    const file = await read(lines([['RENT', '-1200.00'], ['CAR', '-300.00'], ['A', '20.00'], ['B', '30.00'], ['UTILITY', '-800.00']]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('stays a proven bank file: mostly charges and a few paychecks', async () => {
    const file = await read(lines([['A', '-12.34'], ['B', '-54.20'], ['C', '-230.00'], ['D', '-18.75'], ['ACME PAYROLL', '2500.00'], ['E', '-41.10'], ['F', '-9.50'], ['G', '-7.00'], ['ACME PAYROLL', '2500.00'], ['H', '-20.00']]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('stays a proven bank file: more rows coming in than most, each larger than what goes out', async () => {
    const file = await read(lines([['A', '-12.34'], ['B', '-54.20'], ['C', '-23.00'], ['D', '-18.75'], ['ACME PAYROLL', '2500.00'], ['SIDE GIG', '400.00'], ['ACME PAYROLL', '2500.00'], ['E', '-41.10'], ['F', '-9.50'], ['SIDE GIG', '350.00']]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })
})

describe('PayPal', () => {
  it('reads the short export by its Net', async () => {
    const file = await read(`"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Balance","Transaction ID"
"11/03/2026","10:00:00","PST","HARBOR COFFEE","Payment","Completed","USD","-12.34","0.00","-12.34","1987.66","7AB"
"11/04/2026","10:00:00","PST","CORNER MARKET","Payment","Completed","USD","-54.20","0.00","-54.20","1933.46","7AC"
"11/06/2026","10:00:00","PST","ACME PAYROLL","Payment","Completed","USD","2500.00","-30.00","2470.00","4403.46","7AD"
`)
    expect(file.headers[file.cols.amount]).toBe('Net')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2470.00' })
    expect(file.signProven).toBe(true)
  })

  it('uses Net in the full export, and never its shipping, insurance or tax', () => {
    const t = header('"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Shipping Address","Address Status","Item Title","Item ID","Shipping and Handling Amount","Insurance Amount","Sales Tax","Option 1 Name","Option 1 Value","Option 2 Name","Option 2 Value","Reference Txn ID","Invoice Number","Custom Number","Quantity","Receipt ID","Balance","Address Line 1","Country","Contact Phone Number","Subject","Note","Country Code","Balance Impact"')
    expect(t).toMatchObject({ amount: 'Net', inflow: '', date: 'Date', note: 'Name' })
  })

  it('takes Gross when there is no Net, and Net wherever it sits', () => {
    expect(header('Date,Description,Gross,Fee').amount).toBe('Gross')
    expect(header('Date,Description,Gross,Fee,Net').amount).toBe('Net')
    expect(header('Date,Description,Net,Fee,Gross').amount).toBe('Net')
  })

  it('takes a named Amount or a pair over Net', () => {
    expect(header('Date,Description,Amount,Fee,Net').amount).toBe('Amount')
    expect(header('Date,Description,Debit,Credit,Net')).toMatchObject({ amount: 'Debit', inflow: 'Credit' })
  })
})

describe('column names', () => {
  it('takes Total over Subtotal, and the word Subtotal for no money', () => {
    expect(header('Date,Description,Subtotal,Tax,Total').amount).toBe('Total')
    expect(header('Date,Description,Subtotal').amount).toBe('')
  })

  it('reads Posted Amount as money and not as a date', () => {
    expect(header('Date,Description,Posted Amount')).toMatchObject({ amount: 'Posted Amount', date: 'Date' })
    expect(header('Posted Amount,Date,Description')).toMatchObject({ amount: 'Posted Amount', date: 'Date' })
  })

  it('still reads a Value Date as a date beside a Value', () => {
    expect(header('Value Date,Description,Value,Balance')).toMatchObject({ amount: 'Value', date: 'Value Date' })
  })

  it('reads a Venmo statement by its Datetime and total, under its summary', async () => {
    const file = await read(`Account Statement - (@someone) ,,,,,,,,,,,,,,,,,,,,,
Account Activity,,,,,,,,,,,,,,,,,,,,,
,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Amount (fee),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer
,3944,2026-11-03T12:00:00,Payment,Complete,HARBOR COFFEE,Me,Friend,- $12.34,,,,0,,Venmo balance,,,,,Venmo,,
,3945,2026-11-04T12:00:00,Payment,Complete,CORNER MARKET,Me,Friend,- $54.20,,,,0,,Venmo balance,,,,,Venmo,,
,3946,2026-11-06T12:00:00,Payment,Complete,ACME PAYROLL,Friend,Me,+ $2500.00,,,,0,,Venmo balance,,,,,Venmo,,
`)
    expect(file.headers[file.cols.date]).toBe('Datetime')
    expect(file.headers[file.cols.amount]).toBe('Amount (total)')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00' })
  })

  it('takes no year-to-date fees for a date, wherever they sit', () => {
    expect(header('Year to Date Venmo Fees,Date,Description,Amount').date).toBe('Date')
  })

  it.each([
    ['Payment', 'Deposit'],
    ['Charges', 'Credits'],
    ['Charge', 'Payment'],
    ['Outflows', 'Inflows'],
    ['Spent', 'Received'],
  ])('reads %s and %s as a pair', (out, into) => {
    expect(header(`Date,Description,${out},${into},Balance`)).toMatchObject({ amount: out, inflow: into })
    expect(header(`Date,Description,${into},${out},Balance`)).toMatchObject({ amount: out, inflow: into })
  })

  it('reads a QuickBooks register', async () => {
    const file = await read(`Date,Number,Payee,Account,Memo,Payment,Deposit,Balance
11/03/2026,,HARBOR COFFEE,Meals,,12.34,,1987.66
11/06/2026,,ACME PAYROLL,Pay,,,2500.00,4487.66
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })

  it('takes a running Total for no money beside Spent and Received', async () => {
    const file = await read(`Date,Description,Spent,Received,Total
11/03/2026,HARBOR COFFEE,12.34,,-7012.34
11/06/2026,ACME PAYROLL,,2500.00,-4512.34
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })

  it('leaves a word that only names a person or a day out of the money', () => {
    expect(header('Date,Description,Amount,Received By').amount).toBe('Amount')
    expect(header('Date,Description,Received By').amount).toBe('')
    expect(header('Date,Description,Charge Type,Amount').amount).toBe('Amount')
  })

  it('reads a header written with underscores', () => {
    expect(header('transaction_date,description,amount,running_balance')).toMatchObject({ date: 'transaction_date', amount: 'amount', note: 'description' })
  })

  it('takes a Note for what a row was only when nothing better says', () => {
    expect(header('Date,Note,Amount').note).toBe('Note')
    expect(header('Date,Note,Description,Amount').note).toBe('Description')
  })
})

describe('a file with no header', () => {
  const NONE = { date: 0, amount: -1, inflow: -1 }

  it('never uses a balance: it leaves more than one figure column to the person', async () => {
    const file = await read(`11/03/2026,HARBOR COFFEE,12.34,,1987.66
11/04/2026,CORNER MARKET,54.20,,1933.46
11/06/2026,ACME PAYROLL,,2500.00,4433.46
`)
    expect(file.cols).toMatchObject(NONE)
    expect(file.read).toEqual({})
  })

  it('does the same with the balance first', async () => {
    const file = await read(`11/03/2026,HARBOR COFFEE,1987.66,-12.34
11/06/2026,ACME PAYROLL,4487.66,2500.00
`)
    expect(file.cols).toMatchObject(NONE)
  })

  it('still reads the one column of figures of a Wells Fargo file', async () => {
    const file = await read(`"11/03/2026","-12.34","*","","HARBOR COFFEE"
"11/06/2026","2500.00","*","","ACME PAYROLL"
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })
})

describe('how a cell is written', () => {
  it('reads a pound or a euro sign', () => {
    for (const [raw, n] of [['£12.34', 12.34], ['€12.34', 12.34], ['-£12.34', -12.34], ['£-12.34', -12.34], ['(€45.00)', -45], ['£1,234.56', 1234.56]] as const) {
      expect(parseAmount(raw), raw).toBe(n)
    }
  })

  it('reads CR and DR after a figure, as a statement writes them', () => {
    for (const [raw, n] of [['12.34 CR', 12.34], ['12.34 DR', -12.34], ['12.34CR', 12.34], ['12.34DR', -12.34], ['12.34 cr', 12.34], ['£12.34 DR', -12.34], ['1,234.56 Dr', -1234.56]] as const) {
      expect(parseAmount(raw), raw).toBe(n)
    }
  })

  it('reads no CR or DR with no figure', () => {
    for (const raw of ['CR', 'DR', '$ CR']) expect(parseAmount(raw), raw).toBeNull()
  })

  it('reads a UK file with a pound sign in every cell', async () => {
    const file = await read(`Date,Transaction type,Description,Paid out,Paid in,Balance
11/03/2026,POS,HARBOR COFFEE,£12.34,,£1987.66
11/06/2026,POS,ACME PAYROLL,,£2500.00,£4487.66
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
    expect(file.leftOut).toEqual([])
  })

  it('takes a lone dash in a pair for an empty cell', async () => {
    const file = await read(`Date,Description,Debit,Credit,Balance
11/03/2026,HARBOR COFFEE,12.34,-,1987.66
11/06/2026,ACME PAYROLL,-,2500.00,4487.66
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
    expect(file.leftOut).toEqual([])
  })

  it('reads a column marked CR and DR', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/03/2026,HARBOR COFFEE,12.34 DR,1987.66
11/04/2026,CORNER MARKET,54.20 DR,1933.46
11/05/2026,MOON BOOKS,18.75 DR,1914.71
11/06/2026,ACME PAYROLL,2500.00 CR,4414.71
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'MOON BOOKS': '-18.75', 'ACME PAYROLL': '+2500.00' })
    expect(file.signProven).toBe(true)
  })

  it('reads plain figures as money out when a fair share of the figures are marked as credits', async () => {
    const file = await read(`Date,Description,Amount
11/03/2026,HARBOR COFFEE,12.34
11/04/2026,CORNER MARKET,54.20
11/05/2026,ACME PAYROLL,2500.00 CR
11/06/2026,SIDE JOB,200.00 CR
`)
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00', 'SIDE JOB': '+200.00' })
  })
})

describe('what sits between the cells', () => {
  it('reads a semicolon file', async () => {
    const file = await read('Date;Description;Amount\n11/03/2026;HARBOR COFFEE;-12.34\n11/06/2026;ACME PAYROLL;2500.00\n')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })

  it('reads a tab file', async () => {
    const file = await read('Date\tDescription\tAmount\n11/03/2026\tHARBOR COFFEE\t-12.34\n11/06/2026\tACME PAYROLL\t2500.00\n')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })

  it('shows why a comma that is a decimal cannot be read, row by row', async () => {
    const file = await read('Date;Description;Amount\n11/03/2026;HARBOR COFFEE;-12,34\n')
    expect(file.leftOut).toMatchObject([{ why: 'amount', amount: '-12,34' }])
  })

  it('keeps a comma file with semicolons in its words a comma file', () => {
    expect(readTable('Date,Description,Amount\n11/03/2026,"HARBOR; COFFEE; AND; MORE",-12.34\n').headers).toEqual(['Date', 'Description', 'Amount'])
    expect(readTable('Date,Description,Amount\n11/03/2026,HARBOR; COFFEE,-12.34\n').headers).toEqual(['Date', 'Description', 'Amount'])
  })

  it.each([
    ['semicolons', 'ROSE CAFE;A;B;C;D'],
    ['tabs', 'ROSE\tCAFE\tA\tB'],
  ])('keeps a comma file a comma file past one row with more %s than it has commas', async (_, note) => {
    const file = await read(`Date,Description,Amount\n11/03/2026,HARBOR COFFEE,-6.50\n11/04/2026,${note},-20.00\n11/05/2026,CORNER MARKET,-84.12\n`)
    expect(file.read[note]).toBe('-20.00')
    expect(file.read['HARBOR COFFEE']).toBe('-6.50')
  })

  it('takes a semicolon file with a comma in every figure for a semicolon file, with or without a header', () => {
    expect(readTable('Date;Text;Amount;Balance\n11/03/2026;CAFE;-6,50;100,00\n11/04/2026;MARKET;-84,12;15,88\n').headers).toEqual(['Date', 'Text', 'Amount', 'Balance'])
    expect(readTable('11/03/2026;CAFE;-6,50\n11/04/2026;MARKET;-84,12\n').headers).toHaveLength(3)
  })

  it('finds a tab file under a summary of plain lines', () => {
    const summary = Array.from({ length: 10 }, (_, i) => `Statement line ${i}`).join('\n')
    expect(readTable(`${summary}\nDate\tDescription\tAmount\n11/03/2026\tCAFE\t-6.50\n11/04/2026\tMARKET\t-84.12\n`).headers).toEqual(['Date', 'Description', 'Amount'])
  })

  it('says it found no columns, and not that a file of rows has none', async () => {
    const error = await readImportFile(new Blob(['Date|Description|Amount\n11/03/2026|HARBOR COFFEE|-12.34\n'])).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportFileError)
    expect((error as Error).message).not.toMatch(/no rows/)
    expect((error as Error).message).toMatch(/columns/)
  })
})

describe('an ordinary file', () => {
  it('reads Chase checking with nothing to ask', async () => {
    const file = await read(CHASE_HEAD + CHASE_ROWS)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('reads a Chase card with nothing to ask', async () => {
    const file = await read(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo
11/03/2026,11/03/2026,HARBOR COFFEE,Food & Drink,Sale,-12.34,
11/04/2026,11/04/2026,CORNER MARKET,Groceries,Sale,-54.20,
11/05/2026,11/05/2026,TRAIL BIKE SHOP,Shopping,Sale,-230.00,
11/06/2026,11/06/2026,ACME RETURN,Shopping,Return,40.00,
11/09/2026,11/09/2026,AUTOMATIC PAYMENT - THANK,,Payment,300.00,
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
    expect(file.read['AUTOMATIC PAYMENT - THANK']).toBe('+300.00 unticked')
  })

  it('reads Bank of America checking, summary and all, with nothing to ask', async () => {
    const file = await read(`Description,,Summary Amt.
Beginning balance as of 11/01/2026,,"2,000.00"
Total credits,,"2,500.00"
Total debits,,"-356.39"
Ending balance as of 11/08/2026,,"4,143.61"

Date,Description,Amount,Running Bal.
11/01/2026,Beginning balance as of 11/01/2026,,"2,000.00"
11/03/2026,"HARBOR COFFEE","-12.34","1,987.66"
11/04/2026,"CORNER MARKET","-54.20","1,933.46"
11/05/2026,"TRAIL BIKE SHOP","-230.00","1,703.46"
11/06/2026,"ACME PAYROLL","2,500.00","4,203.46"
`)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('reads a Bank of America card with nothing to ask', async () => {
    const file = await read(`Posted Date,Reference Number,Payee,Address,Amount
11/03/2026,24492156,"HARBOR COFFEE","SAN FRANCISCO CA",-12.34
11/04/2026,24492157,"CORNER MARKET","SAN FRANCISCO CA",-54.20
11/06/2026,24492158,"ACME RETURN","SAN FRANCISCO CA",40.00
11/09/2026,24492159,"PAYMENT - THANK YOU","",300.00
`)
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('reads Amex with nothing to ask', async () => {
    const file = await read(`Date,Description,Amount
11/03/2026,HARBOR COFFEE,12.34
11/04/2026,CORNER MARKET,54.20
11/05/2026,TRAIL BIKE SHOP,230.00
11/06/2026,ACME RETURN,-40.00
11/09/2026,MOBILE PAYMENT - THANK YOU,-300.00
`)
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('reads Amex with a card member column and nothing to ask', async () => {
    const file = await read(`Date,Description,Card Member,Account #,Amount
11/03/2026,HARBOR COFFEE,A PERSON,-41007,12.34
11/04/2026,CORNER MARKET,A PERSON,-41007,54.20
11/09/2026,PAYMENT RECEIVED - THANK YOU,A PERSON,-41007,-300.00
`)
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
  })
})

/** Rows of a file, with a day each, under a header. */
const table = (head: string, rows: string[]) => `${head}\n${rows.map((r, i) => `11/${String(i + 1).padStart(2, '0')}/2026,${r}`).join('\n')}\n`

describe('a Type column that proves nothing', () => {
  const MONTH = ['RENT PORTAL,Debit,-1400.00', 'ACME INC,Credit,1200.00', 'HARBOR COFFEE,Debit,-6.50', 'CORNER MARKET,Debit,-84.12', 'SIDE JOB,Credit,200.00', 'MOON BOOKS,Debit,-18.75']

  it.each([
    ['RETURNED ITEM,Return,40.00'],
    ['INTEREST CORRECTION,Adjustment,2.00'],
    ['HARBOR COFFEE TWO,Sale,-5.00'],
    ['HARBOR COFFEE TWO,Purchase,-5.00'],
  ])('keeps a Debit and Credit month a bank account beside %s', async (row) => {
    const file = await read(table('Date,Description,Type,Amount', [...MONTH, row]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME INC']).toBe('+1200.00')
    expect(file.read['SIDE JOB']).toBe('+200.00')
  })

  it('keeps a month of Purchase, Credit and Fee a bank account', async () => {
    const file = await read(table('Date,Description,Type,Amount', [
      'HARBOR COFFEE,Purchase,-6.50', 'CORNER MARKET,Purchase,-84.12', 'MOON BOOKS,Purchase,-18.75', 'PINE DINER,Purchase,-41.10',
      'TRAIL BIKE SHOP,Purchase,-230.00', 'ACME INC,Credit,1200.00', 'ACME INC,Credit,1200.00', 'ATM FEE,Fee,-3.00',
    ]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it('asks of a card’s Type words beside a running balance', async () => {
    const file = await read(table('Date,Description,Type,Amount,Balance', ['HARBOR COFFEE,Sale,-12.34,987.66', 'CORNER MARKET,Sale,-54.20,933.46', 'ACME INC,Return,40.00,973.46']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('asks of plain Sale rows with nothing running back, which could be a shop’s own sales', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['ORDER 1001,Sale,120.00', 'ORDER 1002,Sale,80.00', 'ORDER 1003,Sale,45.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ORDER 1001']).toBe('+120.00')
  })

  it.each([
    ['a Refund', ['ORDER 1001,Sale,120.00', 'ORDER 1002,Sale,80.00', 'ORDER 1003,Sale,45.00', 'ORDER 1004,Sale,200.00', 'ORDER 1001 BACK,Refund,-120.00']],
    ['a Refund and a Fee', ['ORDER 1001,Sale,120.00', 'ORDER 1002,Sale,80.00', 'ORDER 1003,Sale,45.00', 'ORDER 1004,Sale,200.00', 'ORDER 1001 BACK,Refund,-120.00', 'PROCESSOR,Fee,-3.00']],
    ['a Payment', ['ORDER 1001,Sale,120.00', 'ORDER 1002,Sale,80.00', 'ORDER 1003,Sale,45.00', 'PAYOUT,Payment,-200.00']],
  ])('asks of plain Sale rows beside %s, and shows them as money in', async (_, rows) => {
    const file = await read(table('Date,Description,Type,Amount', rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ORDER 1004'] ?? file.read['ORDER 1003']).toMatch(/^\+/)
  })

  it('takes plain charges from a Type column when a card’s own line backs it', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Sale,12.34', 'CORNER MARKET,Sale,54.20', 'ACME RETURN,Return,-40.00', 'MOBILE PAYMENT - THANK YOU,Payment,-300.00']))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true, note: 'line' })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
  })

  it('takes a Type column for nothing when most of its cells are empty', async () => {
    const file = await read(table('Date,Description,Amount,Type', ['ACME INC,1200.00,', 'SIDE JOB,160.00,', 'SAM LEE,100.00,', 'DANA KIM,75.00,Sale', 'HARBOR BACK,-20.00,Refund', 'GRAND HOTEL,20.00,']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it('takes a Type column filled on half of its rows as filled', async () => {
    const file = await read(table('Date,Description,Amount,Type', ['HARBOR COFFEE,-12.34,Sale', 'CORNER MARKET,-54.20,Sale', 'MOON BOOKS,-18.75,', 'ACME RETURN,40.00,']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true, note: 'column' })
  })

  it('says a card read on negative charges rests on the Type column, wherever money came in', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Purchase,-6.50', 'CORNER MARKET,Purchase,-84.12', 'MOON BOOKS,Purchase,-18.75', 'PINE DINER,Purchase,-41.10', 'CITY TAX OFFICE,Refund,900.00', 'ACME INC,Payment,2400.00']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true, note: 'column' })
  })

  it('leaves a bank’s rows with a Type of card words and a thank you line to the figures above the button', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['CORNER MARKET,Purchase,-74.10', 'MOON BOOKS,Purchase,-38.06', 'RENT PORTAL,Purchase,-1400.00', 'ACME INC,Refund,500.00', 'HARBOR COFFEE,Purchase,-22.50', 'ONLINE PAYMENT THANK YOU,Payment,60.00']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.note).toBeUndefined()
    expect(file.read['ACME INC']).toBe('refund 500.00')
  })

  it('says nothing of a Type column with no money coming in: every row reads the same', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Sale,-12.34', 'CORNER MARKET,Sale,-54.20']))
    expect(file.note).toBeUndefined()
  })

  it('never reads a row typed Credit as a charge: plain figures ask', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Purchase,12.34', 'CORNER MARKET,Purchase,54.20', 'ACME INC,Credit,1200.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it('takes a card from a Type column only when most of its rows are charges', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Purchase,-6.50', 'BANK FEE,Fee,-3.00', 'RENT PORTAL,Fee,-1400.00', 'ACME INC,Payment,1200.00', 'SIDE JOB,Payment,200.00', 'SAVINGS RATE,Interest,2.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it('keeps reading a file by its direction words past one row that has none', async () => {
    const debits = ['SHOP 1,10.00', 'SHOP 2,11.00', 'SHOP 3,12.00', 'SHOP 4,13.00', 'SHOP 5,14.00', 'SHOP 6,15.00'].map((r) => `${r},Debit`)
    const file = await read(table('Date,Description,Amount,Transaction Type', [...debits, 'ACME INC,1200.00,Credit', 'SIDE JOB,200.00,Credit', 'HARBOR COFFEE,5.00,Purchase']))
    expect(file.cols.direction).toBe(3)
    expect(file.read['ACME INC']).toBe('+1200.00')
    expect(file.read['SHOP 1']).toBe('-10.00')
    expect(file.leftOut).toMatchObject([{ why: 'way', note: 'HARBOR COFFEE' }])
  })

  it('still reads Apple Card through a month with its Credit and Debit rows', async () => {
    const row = (note: string, type: string, amount: string) => `11/04/2026,${note},${note},Other,${type},${amount},A Person`
    const file = await read(table('Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By', [
      row('HARBOR COFFEE', 'Purchase', '12.34'), row('CORNER MARKET', 'Purchase', '54.20'), row('ACME RETURN', 'Credit', '-40.00'),
      row('DAILY CASH', 'Debit', '-3.00'), row('REF 9921 ACCT SETTLE', 'Payment', '-300.00'), row('MONTHLY FEE', 'Installment', '41.00'),
    ]))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 40.00')
    expect(file.read['REF 9921 ACCT SETTLE']).toContain('unticked')
  })
})

describe('a column that only looks like direction words', () => {
  const CHARGES = ['HARBOR COFFEE,12.34', 'CORNER MARKET,54.20', 'TRAIL BIKE SHOP,230.00', 'MOON BOOKS,18.75']
  const word = (words: string[]) => CHARGES.map((r, i) => `${r},${words[i % words.length]}`)

  it.each([
    ['Status', ['Credit']],
    ['Category', ['Deposit']],
    ['Account Type', ['Credit']],
    ['State', ['IN']],
    ['Country', ['CR']],
    ['Payment Method', ['Credit', 'Debit']],
    ['Location', ['In', 'Out']],
    ['Status', ['Debit', 'Credit']],
  ])('takes no direction from %s', async (name, words) => {
    const file = await read(table(`Date,Description,Amount,${name}`, word(words)))
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('takes no direction from the words of a row', async () => {
    const file = await read(table('Date,Merchant,Memo,Amount', ['Debit,Out,12.34', 'Debit,Out,54.20', 'Credit,In,1200.00']))
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file.signProven).toBe(false)
  })

  it.each(['Transaction Type', 'Type', 'Kind'])('reads a %s column of one word as that way, which the sheet says of a file', async (name) => {
    const debits = await read(table(`Date,Description,Amount,${name}`, word(['Debit'])))
    expect(debits.cols.direction).toBe(3)
    expect(debits.signProven).toBe(true)
    expect(debits.read['CORNER MARKET']).toBe('-54.20')
    const credits = await read(table(`Date,Description,Amount,${name}`, word(['Credit'])))
    expect(credits.read['CORNER MARKET']).toBe('+54.20')
  })

  it.each(['Type', 'Transaction Type', 'Kind'])('asks of a %s column of nothing but C and D, which can mean Check and Deposit', async (name) => {
    const file = await read(table(`Date,Description,Amount,${name}`, ['CHECK 1001,20.00,C', 'CHECK 1002,35.00,C', 'CHECK 1003,18.00,C', 'CASH IN,42.00,D', 'CHECK 1004,11.00,C']))
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file.signProven).toBe(false)
  })

  it('asks the same with a stray word among them', async () => {
    const file = await read(table('Date,Description,Amount,Type', ['CHECK 1001,20.00,C', 'CHECK 1002,35.00,C', 'CHECK 1003,18.00,C', 'CASH IN,42.00,D', 'CHECK 1004,11.00,C', 'WIRE IN,11.00,W']))
    expect(file.cols.direction ?? -1).toBe(-1)
  })

  it('keeps a Card Type column for the card it names', async () => {
    const file = await read(table('Date,Description,Amount,Card Type', word(['Credit', 'Debit'])))
    expect(file.cols.direction ?? -1).toBe(-1)
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
    expect(file.read['CORNER MARKET']).toBe('-54.20')
  })

  it('loses no row to a Status of Debit with one Pending', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => `SHOP ${i},1${i}.00,Debit`)
    const file = await read(table('Date,Description,Amount,Status', [...rows, 'ACME INC,1200.00,Pending']))
    expect(file.leftOut).toEqual([])
    expect(file.signProven).toBe(false)
  })

  it.each(['Transaction Type', 'Type', 'Credit Debit Indicator', 'CreditDebitIndicator', 'Dr/Cr', 'CR/DR', 'CdtDbtInd', 'Debit/Credit', 'Debit or Credit', 'D/C', 'Dr Cr Flag', 'Amount Type', 'Inflow/Outflow', 'Direction', 'In/Out'])(
    'reads %s as the way each row ran',
    async (name) => {
      const file = await read(table(`Date,Description,Amount,${name}`, ['HARBOR COFFEE,12.34,Debit', 'CORNER MARKET,54.20,Debit', 'ACME PAYROLL,2500.00,Credit']))
      expect(file.cols.direction).toBe(3)
      expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00' })
    },
  )

  it('reads a column of D and C under a header that names them', async () => {
    const file = await read(table('Date,Description,Amount,D/C', ['HARBOR COFFEE,12.34,D', 'CORNER MARKET,54.20,D', 'ACME PAYROLL,2500.00,C']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00' })
    expect(file.signProven).toBe(true)
  })
})

describe('an issuer’s line among rows that could be a bank', () => {
  const GIG = ['TIDEPOOL PAYOUT,410.00,1410.00', 'RIDEBOX EARNINGS,212.00,1622.00', 'DASHCART EARNINGS,188.00,1810.00', 'TILE INC,390.00,2200.00', 'CRAFTHUB INC,240.00,2440.00', 'CORNER MARKET,-54.20,2385.80', 'MOON BOOKS,-18.75,2367.05']
  const SAVINGS = ['INTEREST PAID,4.11,1004.11', 'DEPOSIT,500.00,1504.11', 'INTEREST PAID NOV,4.20,1508.31']
  const CHECKING = ['RENT PORTAL,-1400.00,600.00', 'ACME INC,1200.00,1800.00', 'HARBOR COFFEE,-6.50,1793.50', 'CORNER MARKET,-84.12,1709.38', 'MOON BOOKS,-18.75,1690.63']
  const BALANCE = 'Date,Description,Amount,Balance'

  it.each([
    ['gig checking', GIG, 'AUTOPAY PAYMENT - THANK YOU,-120.00,2247.05', 'TILE INC', '+390.00'],
    ['savings', SAVINGS, 'ONLINE PAYMENT THANK YOU,-50.00,1458.31', 'DEPOSIT', '+500.00'],
    ['checking with rent above pay', CHECKING, 'PAYMENT THANK YOU,75.00,1765.63', 'ACME INC', '+1200.00'],
  ])('asks of %s with a running balance', async (_, rows, line, note, shown) => {
    const file = await read(table(BALANCE, [...rows, line]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read[note]).toBe(shown)
  })

  it('counts a column called Running Bal. too', async () => {
    const file = await read(table('Date,Description,Amount,Running Bal.', [...GIG, 'AUTOPAY PAYMENT - THANK YOU,-120.00,2247.05']))
    expect(file.signProven).toBe(false)
  })

  it('asks of a deposit no card could have charged, with no balance in the file', async () => {
    const file = await read(table('Date,Description,Amount', ['INTEREST PAID,4.11', 'DEPOSIT,500.00', 'INTEREST PAID NOV,4.20', 'ONLINE PAYMENT THANK YOU,-50.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read.DEPOSIT).toBe('+500.00')
  })

  it('asks of pay far above a typical charge, with no balance in the file', async () => {
    const file = await read(table('Date,Description,Amount', ['RENT PORTAL,-1400.00', 'ACME INC,1200.00', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12', 'MOON BOOKS,-18.75', 'PAYMENT THANK YOU,75.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it.each([
    ['plain charges', ['HARBOR COFFEE,12.34', 'CORNER MARKET,54.20', 'ACME RETURN,-40.00', 'MOBILE PAYMENT - THANK YOU,-300.00'], 'card-positive'],
    ['negative charges', ['HARBOR COFFEE,-12.34', 'CORNER MARKET,-54.20', 'ACME RETURN,40.00', 'PAYMENT THANK YOU,300.00'], 'card-negative'],
  ])('reads a line with nothing against it as a card, and says what that rests on: %s', async (_, rows, sign) => {
    const file = await read(table('Date,Description,Amount', rows))
    expect(file).toMatchObject({ sign, signProven: true })
    expect(file.note).toBe('line')
  })
})

describe('a Card column beside a bank account’s rows', () => {
  const FILE = ['RENT PORTAL,-1400.00,1234', 'ACME INC,2500.00,1234', 'HARBOR COFFEE,-6.50,1234', 'CORNER MARKET,-84.12,1234', 'MOON BOOKS,-18.75,1234']
  const HEAD = 'Date,Description,Amount,Card'

  it('still asks when one charge is larger than the pay', async () => {
    const file = await read(table(HEAD, [...FILE, 'CAR DEALER,-5000.00,1234']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+2500.00')
  })

  it('asks when payday is below the rent', async () => {
    const file = await read(table(HEAD, ['RENT PORTAL,-1400.00,1234', 'ACME INC,1200.00,1234', 'HARBOR COFFEE,-6.50,1234', 'CORNER MARKET,-84.12,1234', 'MOON BOOKS,-18.75,1234']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('asks when a plain Balance sits beside it', async () => {
    const file = await read(table('Date,Description,Amount,Card,Balance', ['HARBOR COFFEE,-6.50,1234,993.50', 'CORNER MARKET,-84.12,1234,909.38', 'ACME INC,40.00,1234,949.38']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('asks of plain figures with nothing but a Card column beside a running balance', async () => {
    const file = await read(table('Date,Description,Amount,Card,Balance', ['ACME INC,2500.00,1234,3500.00', 'SIDE JOB,200.00,1234,3700.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+2500.00')
  })

  it('says what it read when every figure is plain and a Card column is all it has', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,12.34,1234', 'CORNER MARKET,54.20,1234']))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true, note: 'column' })
  })

  it('takes a credit the size of a charge for that charge coming back, however large', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,-12.34,1234', 'CORNER MARKET,-54.20,1234', 'MOON BOOKS,-18.75,1234', 'TRAIL BIKE SHOP,-630.00,1234', 'PINE DINER,-41.10,1234', 'TRAIL BIKE RETURN,630.00,1234']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['TRAIL BIKE RETURN']).toBe('refund 630.00')
  })

  it('says what a card read on a column alone rests on', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,12.34,1234', 'CORNER MARKET,54.20,1234', 'MOON BOOKS,18.75,1234', 'ACME RETURN,-6.00,1234']))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true, note: 'column' })
  })
})

describe('figures that run both ways with no column to settle it', () => {
  const HEAD = 'Date,Description,Amount'

  it('takes no credit a card could give for a bank’s money in: three charges and three credits', async () => {
    const file = await read(table(HEAD, ['HARBOR AIRWAYS,812.00', 'GRAND HOTEL,640.00', 'PINE DINER,120.00', 'AIRLINE FEE CREDIT,-200.00', 'HOTEL CREDIT,-100.00', 'DINING CREDIT,-10.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('reads a checking month with a bank’s words in it as a bank, with nothing to say', async () => {
    const file = await read(table(HEAD, [
      'CHECK 1042,-1850.00', 'ACME INC DIRECT DEP,2300.00', 'ATM WITHDRAWAL,-60.00', 'ATM DEPOSIT 0042,120.00', 'ZELLE TO SAM LEE,-35.00', 'ZELLE FROM DANA KIM,45.00',
      'MONTHLY SERVICE FEE,-12.00', 'INTEREST PAID,0.42', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12', 'CORNER MARKET REFUND,20.00', 'CARD AUTOPAY,-450.00',
      'CARD EPAYMENT,-300.00', 'BANK CARD PAYMENT,-210.00', 'TRAIL BIKE SHOP,-230.00', 'MOON BOOKS,-18.75',
    ]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.note).toBeUndefined()
  })

  it('reads a bank’s words as a bank when money in leads too', async () => {
    const file = await read(table(HEAD, ['ACME PAYROLL,2500.00', 'ACME PAYROLL,2500.00', 'SAM LEE,40.00', 'CORNER MARKET,-54.20', 'HARBOR COFFEE,-6.50']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('reads the same month with no such words as a bank, without stopping, and says so', async () => {
    const file = await read(table(HEAD, [
      'CHECK 1042,-1850.00', 'ACME INC,2300.00', 'CASH,-60.00', 'SIDE JOB,120.00', 'SAM LEE,-35.00', 'DANA KIM,45.00', 'SERVICE FEE,-12.00',
      'SAVINGS RATE,0.42', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12', 'CORNER MARKET BACK,20.00', 'BILL,-450.00', 'BILL TWO,-300.00', 'BILL THREE,-210.00', 'TRAIL BIKE SHOP,-230.00', 'MOON BOOKS,-18.75',
    ]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('does not stop a month with more in than out beside a running balance, and says what it read', async () => {
    const file = await read(table('Date,Description,Amount,Balance', ['TIDEPOOL,410.00,1410.00', 'TILE INC,212.00,1622.00', 'CRAFTHUB INC,188.00,1810.00', 'CORNER MARKET,-54.20,1755.80', 'MOON BOOKS,-18.75,1737.05']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('leaves Type words a card uses beside ones it does not to the figures above the button', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Sale,-12.34', 'CORNER MARKET,Sale,-54.20', 'MOON BOOKS,Sale,-18.75', 'ACME RETURN,Return,40.00', 'PINE DINER,Sale,-41.10', 'TRAIL BIKE SHOP,Credit,-5.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['ACME RETURN']).toBe('+40.00')
  })

  it('says nothing of a file that is mostly money out', async () => {
    const file = await read(table(HEAD, ['A,-12.34', 'B,-54.20', 'C,-230.00', 'D,-18.75', 'ACME INC,2500.00']))
    expect(file).toMatchObject({ signProven: true })
    expect(file.note).toBeUndefined()
  })

  it('says nothing of a pair: each row already says which way it ran', async () => {
    const file = await read(table('Date,Description,Debit,Credit', ['A,12.34,', 'B,54.20,', 'C,,20.00', 'D,8.00,', 'E,,30.00']))
    expect(file).toMatchObject({ signProven: true })
    expect(file.note).toBeUndefined()
  })
})

describe('a bank’s word in a file that could be a card with plain charges', () => {
  const HEAD = 'Date,Description,Amount'
  const AMEX = ['HARBOR AIRWAYS,812.00', 'GRAND HOTEL,640.00', 'PINE DINER,120.00', 'AIRLINE FEE CREDIT,-200.00', 'HOTEL CREDIT,-100.00']

  it.each([
    ['ACME QB PAYROLL', 2],
    ['ACME SALARY SERVICES', 2],
    ['DIRECT DEPOSIT CAFE', 2],
    ['ZELLE CAFE', 2],
    ['DEPOSIT GRAND HOTEL', 1],
    ['DIVIDEND DINER', 2],
  ])('keeps asking when the word sits on a row that could be a charge: %s', async (note, at) => {
    const rows = AMEX.map((r, i) => (i === at ? `${note},${r.split(',')[1]}` : r))
    const file = await read(table(HEAD, rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['AIRLINE FEE CREDIT']).toBe('-200.00')
  })

  it('reads the file right once a person says it is a card', async () => {
    const rows = await readAs(table(HEAD, ['HARBOR AIRWAYS,812.00', 'GRAND HOTEL,640.00', 'ACME QB PAYROLL,45.00', 'AIRLINE FEE CREDIT,-200.00', 'HOTEL CREDIT,-100.00']), 'card-positive')
    expect(rows['ACME QB PAYROLL']).toBe('-45.00')
    expect(rows['HOTEL CREDIT']).toBe('refund 100.00')
  })

  it('asks when the word sits on most of the money in, but the money out is a card’s credits', async () => {
    const file = await read(table(HEAD, ['ACME QB PAYROLL,812.00', 'GRAND HOTEL,640.00', 'PINE DINER,120.00', 'AIRLINE FEE CREDIT,-200.00', 'HOTEL CREDIT,-100.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('reads a bank but says so when the word sits on few of the rows that came in', async () => {
    const file = await read(table(HEAD, ['ACME QB PAYROLL,812.00', 'GRAND HOTEL,240.00', 'PINE DINER,120.00', 'SHOP 1,-20.00', 'SHOP 2,-20.00', 'SHOP 3,-20.00', 'SHOP 4,-20.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('reads a bank and says nothing when the word sits on most of what came in', async () => {
    const file = await read(table(HEAD, ['ACME QB PAYROLL,812.00', 'ACME QB PAYROLL,812.00', 'PINE DINER,120.00', 'SHOP 1,-20.00', 'SHOP 2,-20.00', 'SHOP 3,-20.00', 'SHOP 4,-20.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.note).toBeUndefined()
  })

  it('reads a bank but says so when money out leads and the word holds little', async () => {
    const file = await read(table(HEAD, ['ACME INC,1200.00', 'ZELLE FROM SAM LEE,45.00', 'RENT PORTAL,-1400.00', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('says nothing beside a running balance: a card has none', async () => {
    const file = await read(table(`${HEAD},Balance`, ['ACME INC,812.00,1812.00', 'SIDE JOB,640.00,2452.00', 'ZELLE FROM SAM LEE,45.00,2497.00', 'RENT PORTAL,-200.00,2297.00', 'HARBOR COFFEE,-100.00,2197.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.note).toBeUndefined()
  })
})

describe('a short file with nothing to go on', () => {
  const HEAD = 'Date,Description,Amount'

  it.each([
    ['one each way', ['ACME INC,1200.00', 'HARBOR COFFEE,-6.50']],
    ['two in, one out', ['ACME INC,1200.00', 'SIDE JOB,200.00', 'HARBOR COFFEE,-6.50']],
    ['two each way', ['ACME INC,1200.00', 'SIDE JOB,200.00', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12']],
  ])('reads as a bank and says so, without stopping: %s', async (_, rows) => {
    const file = await read(table(HEAD, rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true, note: 'lean' })
  })

  it('stops once it has five rows to read', async () => {
    const file = await read(table(HEAD, ['ACME INC,1200.00', 'SIDE JOB,200.00', 'SAM LEE,40.00', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('still asks when every figure is plain', async () => {
    expect(await read(table(HEAD, ['ACME INC,1200.00', 'SIDE JOB,200.00']))).toMatchObject({ signProven: false })
  })
})

describe('a file with every row going out', () => {
  it('asks nothing, whatever its Type words say: nothing changes with the answer', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Purchase,-6.50', 'CORNER MARKET,Purchase,-84.12', 'MOON BOOKS,Purchase,-18.75', 'CITY WATER,Payment,-60.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['CITY WATER']).toBe('-60.00')
  })
})

describe('issuer lines with no thanks in them', () => {
  const HEAD = 'Date,Description,Amount'
  const CARD = ['HARBOR COFFEE,-12.34', 'CORNER MARKET,-54.20', 'ACME RETURN,40.00', 'MOON BOOKS,-18.75']

  it.each(['BA ELECTRONIC PAYMENT', 'Payment Received', 'ELECTRONIC PAYMENT', 'CAPITAL ONE MOBILE PYMT'])('asks of %s on a card, and starts it unticked once a person says so', async (line) => {
    const text = table(HEAD, [...CARD, `${line},300.00`])
    const file = await read(text)
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read[line]).toContain('+300.00')
    const asCard = await readAs(text, 'card-negative')
    expect(asCard[line]).toContain('unticked')
    expect(asCard['ACME RETURN']).toBe('refund 40.00')
  })

  it('asks of a Discover line on plain charges, and starts it unticked once a person says so', async () => {
    const text = table(HEAD, ['HARBOR COFFEE,12.34', 'CORNER MARKET,54.20', 'MOON BOOKS,18.75', 'DIRECTPAY FULL BALANCE,-300.00'])
    expect(await read(text)).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect((await readAs(text, 'card-positive'))['DIRECTPAY FULL BALANCE']).toContain('unticked')
  })

  it('never turns a seller’s deposits into spending on one such line', async () => {
    const file = await read(table(HEAD, ['TIDEPOOL ACME,410.00', 'CRAFTHUB INC,240.00', 'TILE INC,390.00', 'FERN CRAFTS,140.00', 'ONLINE PAYMENT,-60.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['TIDEPOOL ACME']).toBe('+410.00')
    expect(file.read['ONLINE PAYMENT']).toBe('-60.00')
  })

  it('never takes pay away on one such line: it asks, and shows it as money in', async () => {
    const file = await read(table(HEAD, ['RENT PORTAL,-1400.00', 'HARBOR COFFEE,-6.50', 'CORNER MARKET,-84.12', 'MOON BOOKS,-18.75', 'ELECTRONIC PAYMENT,1800.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ELECTRONIC PAYMENT']).toBe('+1800.00')
  })

  it.each([
    ['running with the rows around it', ['HARBOR COFFEE,-12.34', 'CORNER MARKET,-54.20', 'ELECTRONIC PAYMENT,-300.00', 'ACME INC,1200.00', 'MOON BOOKS,-18.75']],
    ['beside pay', ['HARBOR COFFEE,-12.34', 'CORNER MARKET,-54.20', 'PAYMENT RECEIVED,300.00', 'ACME PAYROLL,2500.00', 'MOON BOOKS,-18.75', 'PINE DINER,-41.10']],
    ['in a short file whose other rows are split', ['ACME INC,1200.00', 'HARBOR COFFEE,-12.34', 'ELECTRONIC PAYMENT,-300.00']],
  ])('leaves a checking file alone, with nothing to ask: %s', async (_, rows) => {
    const file = await read(table(HEAD, rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('takes no such line for a card beside a running balance', async () => {
    const file = await read(table('Date,Description,Amount,Balance', ['HARBOR COFFEE,-12.34,987.66', 'CORNER MARKET,-54.20,933.46', 'MOON BOOKS,-18.75,914.71', 'PAYMENT RECEIVED,300.00,1214.71']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['PAYMENT RECEIVED']).toBe('+300.00')
  })
})

describe('a pair with a cell that runs against its column', () => {
  const HEAD = 'Date,Description,Debit,Credit,Balance'

  it('reads a negative in a Debit column of plain figures as that money coming back', async () => {
    const file = await read(table(HEAD, ['CORNER MARKET,84.12,,915.88', 'CORNER MARKET REVERSAL,-84.12,,1000.00', 'ACME PAYROLL,,2500.00,3500.00']))
    expect(file.read['CORNER MARKET']).toBe('-84.12')
    expect(file.read['CORNER MARKET REVERSAL']).toBe('refund 84.12')
  })

  it('reads a negative in a Deposit column as that money going back out', async () => {
    const file = await read(table('Date,Description,Withdrawal,Deposit,Balance', ['MOBILE DEPOSIT,,300.00,1300.00', 'DEPOSIT RETURNED,,-300.00,1000.00', 'HARBOR COFFEE,6.50,,993.50']))
    expect(file.read['MOBILE DEPOSIT']).toBe('+300.00')
    expect(file.read['DEPOSIT RETURNED']).toBe('-300.00')
  })

  it('reads a plain figure in a Debit column of negatives the other way', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,-12.34,,987.66', 'CORNER MARKET,-54.20,,933.46', 'CORNER MARKET BACK,54.20,,987.66']))
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
    expect(file.read['CORNER MARKET BACK']).toBe('refund 54.20')
  })

  it('nets a row filled on both sides', async () => {
    const file = await read(table(HEAD, ['CHECK DEPOSIT LESS CASH,100.00,500.00,1400.00', 'HARBOR COFFEE,6.50,,1393.50']))
    expect(file.read['CHECK DEPOSIT LESS CASH']).toBe('+400.00')
  })

  it('still reads a Credit column written with minus signs as money in', async () => {
    const file = await read(table('Date,Description,Debit,Credit', ['HARBOR COFFEE,12.34,', 'CORNER MARKET,54.20,', 'ACME PAYROLL,,-2500.00', 'SIDE JOB,,-40.00']))
    expect(file.read).toMatchObject({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
  })
})

describe('a dated row that only states a balance', () => {
  const HEAD = 'Date,Description,Amount,Balance'
  const MONTH = ['HARBOR COFFEE,-12.34,3987.66', 'CORNER MARKET,-54.20,3933.46', 'ACME PAYROLL,2200.00,6133.46']

  it.each(['OPENING BALANCE', 'Beginning Balance', 'BEGINNING BALANCE AS OF 11/01/2026', 'STARTING BALANCE', 'CLOSING BALANCE', 'Ending balance', 'ENDING BALANCE 11/30'])(
    'starts %s unticked, where it cannot count as income',
    async (note) => {
      const file = await read(table(HEAD, [`${note},4000.00,4000.00`, ...MONTH]))
      expect(file.read[note]).toContain('unticked')
      expect(file.read['ACME PAYROLL']).toBe('+2200.00')
    },
  )

  it.each(['TOTAL', 'Total', 'TOTALS', 'SUBTOTAL', 'SUB TOTAL', 'Sub-total', 'GRAND TOTAL', 'TOTAL:'])('starts a row named only %s unticked', async (note) => {
    const file = await read(table(HEAD, [...MONTH, `${note},-500.00,`]))
    expect(file.read[note]).toBe('-500.00 unticked')
    expect(file.read['ACME PAYROLL']).toBe('+2200.00')
  })

  it.each(['TOTAL WINE', 'TOTAL CAR CARE', 'TOTALLY COFFEE', 'SUBTOTAL BAR'])('reads %s as the row it is', async (note) => {
    const file = await read(table(HEAD, [...MONTH, `${note},-20.00,6113.46`]))
    expect(file.read[note]).toBe('-20.00')
  })

  it('keeps a balance out of what the figures say', async () => {
    const file = await read(table('Date,Description,Amount,Balance', ['OPENING BALANCE,4000.00,4000.00', 'HARBOR COFFEE,-12.34,3987.66', 'CLOSING BALANCE,3987.66,3987.66']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.note).toBeUndefined()
  })

  it.each(['BALANCE INQUIRY FEE', 'MINIMUM BALANCE FEE', 'HARBOR BALANCE CO', 'OPENING BALANCE CAFE'])('reads %s as the row it is', async (note) => {
    const file = await read(table(HEAD, [`${note},-4.00,3996.00`, ...MONTH]))
    expect(file.read[note]).toBe('-4.00')
  })
})

describe('a stray quote', () => {
  it('reads the rest of a file past a quote inside a cell', async () => {
    const file = await read(table('Date,Description,Amount', ['HARBOR COFFEE,-6.50', 'PIPE 5" FITTING,-20.00', 'CORNER MARKET,-84.12', 'ACME PAYROLL,2500.00', 'MOON BOOKS,-18.75']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-6.50', 'PIPE 5" FITTING': '-20.00', 'CORNER MARKET': '-84.12', 'ACME PAYROLL': '+2500.00', 'MOON BOOKS': '-18.75' })
    expect(file.leftOut).toEqual([])
  })

  it('reads the rest of a file past a quote that opens a cell and never closes', async () => {
    const file = await read(table('Date,Description,Amount', ['HARBOR COFFEE,-6.50', '"PIPE FITTING,-20.00', 'CORNER MARKET,-84.12']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-6.50', 'PIPE FITTING': '-20.00', 'CORNER MARKET': '-84.12' })
  })

  it('reads the rows past a stray quote when a later cell is quoted', async () => {
    const file = await read('Date,Description,Amount\n11/03/2026,HARBOR COFFEE,-6.50\n11/04/2026,"LANTERN FOODS,-54.20\n11/05/2026,TIDE GAS,-44.00\n11/06/2026,"MOON BOOKS",-18.75\n')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-6.50', 'LANTERN FOODS': '-54.20', 'TIDE GAS': '-44.00', 'MOON BOOKS': '-18.75' })
    expect(file.leftOut).toEqual([])
  })

  it('reads a stray quote on the row just before a quoted cell', async () => {
    const file = await read('Date,Description,Amount\n11/04/2026,"LANTERN FOODS,-54.20\n11/06/2026,"MOON BOOKS",-18.75\n')
    expect(file.read).toEqual({ 'LANTERN FOODS': '-54.20', 'MOON BOOKS': '-18.75' })
  })

  it('reads two stray quotes in one file', async () => {
    const file = await read('Date,Description,Amount\n11/04/2026,"LANTERN FOODS,-54.20\n11/05/2026,TIDE GAS,-44.00\n11/06/2026,"PINE DINER,-41.10\n11/07/2026,CORNER MARKET,-84.12\n11/08/2026,"MOON BOOKS",-18.75\n')
    expect(Object.keys(file.read)).toEqual(['LANTERN FOODS', 'TIDE GAS', 'PINE DINER', 'CORNER MARKET', 'MOON BOOKS'])
  })

  it('keeps a quoted cell that runs over a line and holds no row of its own', async () => {
    const file = await read('Date,Description,Amount\n11/04/2026,"LANTERN FOODS\nSUITE 4, 12 PINE ST",-54.20\n11/05/2026,TIDE GAS,-44.00\n')
    expect(file.read).toEqual({ 'LANTERN FOODS\nSUITE 4, 12 PINE ST': '-54.20', 'TIDE GAS': '-44.00' })
  })

  it('still reads a quoted cell, with its comma and its doubled quote', async () => {
    const file = await read('Date,Description,Amount\n11/03/2026,"PIPE, 5"" FITTING",-20.00\n11/04/2026, "CORNER MARKET",-84.12\n')
    expect(file.read).toEqual({ 'PIPE, 5" FITTING': '-20.00', 'CORNER MARKET': '-84.12' })
  })
})

describe('a file of plain figures that marks only its credits', () => {
  const PLAIN = ['HARBOR COFFEE,12.34', 'CORNER MARKET,54.20', 'MOON BOOKS,18.75']

  it('reads a plus as money in and the rest as money out, where a fair share of figures carry one', async () => {
    const file = await read(table('Date,Description,Amount', [...PLAIN, 'ACME PAYROLL,+2500.00', 'SIDE JOB,+200.00']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'MOON BOOKS': '-18.75', 'ACME PAYROLL': '+2500.00', 'SIDE JOB': '+200.00' })
    expect(file.signProven).toBe(true)
  })

  it('reads a plus on every row as nothing said', async () => {
    const file = await read(table('Date,Description,Amount', ['HARBOR COFFEE,+12.34', 'CORNER MARKET,+54.20']))
    expect(file.cols.way).toBeUndefined()
    expect(file.signProven).toBe(false)
  })

  it('takes a Credit column with a plus on one figure as money in all the way down', async () => {
    const file = await read(table('Date,Description,Credit', ['ACME INC,1200.00', 'SIDE JOB,+200.00', 'SAVINGS RATE,2.00']))
    expect(file.read).toEqual({ 'ACME INC': '+1200.00', 'SIDE JOB': '+200.00', 'SAVINGS RATE': '+2.00' })
  })

  it('takes a Debit column with a plus on every row as money out', async () => {
    const file = await read(table('Date,Description,Debit', ['HARBOR COFFEE,+12.34', 'CORNER MARKET,+54.20']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20' })
  })
})

describe('one figure marked among plain ones', () => {
  const DEPOSITS = ['ACME INC,1200.00', 'SIDE JOB,160.00', 'SAM LEE,100.00', 'DANA KIM,0.00']
  const HEAD = 'Date,Description,Amount'

  it.each(['+75.00', '75.00 CR', '75.00CR', '75.00 cr.'])('proves nothing about the rest, so it asks and shows them as they read: %s', async (figure) => {
    const file = await read(table(HEAD, [...DEPOSITS, `GRAND HOTEL,${figure}`]))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.cols.way).toBeUndefined()
    expect(file.read).toMatchObject({ 'ACME INC': '+1200.00', 'SIDE JOB': '+160.00', 'SAM LEE': '+100.00', 'GRAND HOTEL': '+75.00' })
  })

  it('does the same beside a Balance column', async () => {
    const rows = ['ACME INC,1200.00,2200.00', 'SIDE JOB,160.00,2360.00', 'SAM LEE,100.00,2460.00', 'GRAND HOTEL,+75.00,2535.00']
    const file = await read(table(`${HEAD},Balance`, rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1200.00')
  })

  it('still says that one figure is money back, once a person calls the file a card', async () => {
    const rows = await readAs(table(HEAD, ['GRAND HOTEL,812.00', 'PINE DINER,120.00', 'MOON BOOKS,18.75', 'HOTEL CREDIT,+200.00']), 'card-positive')
    expect(rows).toEqual({ 'GRAND HOTEL': '-812.00', 'PINE DINER': '-120.00', 'MOON BOOKS': '-18.75', 'HOTEL CREDIT': 'refund 200.00' })
  })

  it('takes a plus on every figure of a card for no credit at all', async () => {
    expect(await readAs(table(HEAD, ['PINE DINER,+120.00', 'MOON BOOKS,+18.75']), 'card-positive')).toEqual({ 'PINE DINER': '-120.00', 'MOON BOOKS': '-18.75' })
  })

  it.each(['+1200.00', '1200.00 CR'])('leaves a column that says which way each row ran in charge: %s', async (figure) => {
    const file = await read(table('Date,Description,Amount,Transaction Type', [`ACME INC,${figure},Credit`, 'SIDE JOB,200.00,Credit', 'HARBOR COFFEE,6.50,Debit', 'CORNER MARKET,84.12,Debit', 'RENT PORTAL,1400.00,Debit']))
    expect(file.cols.direction).toBe(3)
    expect(file.read).toEqual({ 'ACME INC': '+1200.00', 'SIDE JOB': '+200.00', 'HARBOR COFFEE': '-6.50', 'CORNER MARKET': '-84.12', 'RENT PORTAL': '-1400.00' })
  })

  it('reads that column beside a plus on every figure too', async () => {
    const file = await read(table('Date,Description,Amount,Transaction Type', ['ACME INC,+1200.00,Credit', 'HARBOR COFFEE,+6.50,Debit', 'CORNER MARKET,+84.12,Debit']))
    expect(file.read).toEqual({ 'ACME INC': '+1200.00', 'HARBOR COFFEE': '-6.50', 'CORNER MARKET': '-84.12' })
  })

  it('leaves that column in charge however many figures are marked', async () => {
    const file = await read(table('Date,Description,Amount,Transaction Type', ['ACME INC,+1200.00,Credit', 'SIDE JOB,+200.00,Credit', 'HARBOR COFFEE,6.50,Debit']))
    expect(file.cols).toMatchObject({ direction: 3, way: undefined })
  })

  it('stops reading marks once a person turns them off, and asks', async () => {
    const text = table(HEAD, ['ACME INC,1200.00', 'SIDE JOB,160.00', 'GRAND HOTEL,+75.00', 'PINE DINER,+20.00'])
    const file = await readImportFile(new Blob([text]))
    expect(file.cols.way).toBe('out')
    const off = rereadCells({ ...file.cols, noMarks: true }, file.headers, file.rows)
    expect(off).toMatchObject({ way: undefined, marked: false })
    expect(readTableSign(file, off)).toMatchObject({ sign: 'negative-expense', proven: false, plain: true })
    const { rows } = stageRows(file.rows, off, 'card-positive', cats)
    expect(rows.map(show)).toEqual(['-1200.00', '-160.00', '-75.00', '-20.00'])
  })

  it('counts what the marks come to, with them on or off', async () => {
    const file = await readImportFile(new Blob([table(HEAD, ['ACME INC,1200.00', 'SIDE JOB,160.00', 'GRAND HOTEL,+75.00', 'PINE DINER,+20.00', 'MOON BOOKS,0.00'])]))
    expect(marksOf(file.cols, file.rows)).toEqual({ marked: 2, rest: 2 })
    expect(marksOf({ ...file.cols, noMarks: true }, file.rows)).toEqual({ marked: 2, rest: 2 })
  })

  it.each([
    ['a figure with a minus', ['ACME INC,1200.00', 'GRAND HOTEL,+75.00', 'PINE DINER,-20.00']],
    ['a plus on every figure', ['ACME INC,+1200.00', 'GRAND HOTEL,+75.00']],
    ['no mark at all', ['ACME INC,1200.00', 'GRAND HOTEL,75.00']],
  ])('counts no marks beside %s', async (_, rows) => {
    const file = await readImportFile(new Blob([table(HEAD, rows)]))
    expect(marksOf(file.cols, file.rows)).toBeNull()
  })
})

describe('a summary above the table', () => {
  it.each([
    ['Statement Date,Total Amount\n11/30/2026,"1,234.56"\n\n'],
    ['Statement Closing Date,Total Debit Amount,Total Credit Amount\n11/30/2026,356.39,2500.00\n\n'],
  ])('takes the header with rows under it: %s', async (summary) => {
    const file = await read(`${summary}Date,Description,Amount\n11/03/2026,HARBOR COFFEE,-12.34\n11/04/2026,CORNER MARKET,-54.20\n11/06/2026,ACME PAYROLL,2500.00\n`)
    expect(file.headers).toEqual(['Date', 'Description', 'Amount'])
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'CORNER MARKET': '-54.20', 'ACME PAYROLL': '+2500.00' })
    expect(file.leftOut).toEqual([])
  })
})

describe('a row wider than its header', () => {
  const HEAD = 'Date,Description,Amount,Balance'

  it('leaves it out and says why, where a comma in the words moved its figures', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,-12.34,987.66', 'PIPE SHOP, 1200,-54.20,933.46', 'ACME PAYROLL,2500.00,3433.46']))
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-12.34', 'ACME PAYROLL': '+2500.00' })
    expect(file.leftOut).toMatchObject([{ why: 'wide', note: 'PIPE SHOP' }])
  })

  it('takes nothing from its figures: they may be anything', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,-12.34,987.66', 'PIPE SHOP, 1200,-54.20,933.46']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.note).toBeUndefined()
  })

  it('takes no empty cells at the end for width, as Chase writes every row', async () => {
    const file = await read(CHASE_HEAD + CHASE_ROWS)
    expect(file.leftOut).toEqual([])
  })

  it('takes no empty cell at the end for width on one row either', async () => {
    const file = await read(table(HEAD, ['HARBOR COFFEE,-12.34,987.66', 'CORNER MARKET,-54.20,933.46,', 'ACME PAYROLL,2500.00,3433.46']))
    expect(file.leftOut).toEqual([])
  })

  it('takes a header that is short on every row for the header’s fault', async () => {
    const file = await read(table('Date,Description,Amount', ['HARBOR COFFEE,-12.34,X', 'CORNER MARKET,-54.20,Y', 'ACME PAYROLL,2500.00,Z']))
    expect(file.leftOut).toEqual([])
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })
})

describe('Apple Card’s column names on rows that are not Apple’s', () => {
  const HEAD = 'Transaction Date,Clearing Date,Description,Type,Amount (USD)'
  const row = (note: string, type: string, amount: string) => `11/02/2026,${note},${type},${amount}`
  const CHECKING: [string, string, string][] = [
    ['CHECK 4418', 'Check', '-900.00'], ['ACME INC', 'ACH', '1800.00'], ['CORNER MARKET', 'Card', '-74.10'],
    ['MOON BOOKS', 'Card', '-22.50'], ['HARBOR COFFEE', 'Card', '-38.06'], ['PINE DINER', 'Card', '-18.00'],
  ]
  const month = (type: (word: string, i: number) => string) => table(HEAD, CHECKING.map(([n, w, a], i) => row(n, type(w, i), a)))

  it.each<[string, (word: string, i: number) => string]>([
    ['a bank’s Type words', (word) => word],
    ['Debit and Credit', (_, i) => (i === 1 ? 'Credit' : 'Debit')],
    ['an empty Type column', () => ''],
    ['one filled Type cell', (_, i) => (i === 3 ? 'Fee' : '')],
  ])('asks of a signed checking month with %s, and turns nothing around', async (_, type) => {
    const file = await read(month(type))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1800.00')
    expect(file.read['CHECK 4418']).toBe('-900.00')
  })

  it.each([
    ['Sale', 'Transaction Date,Clearing Date,Description,Type,Amount (USD)', (r: string) => r],
    ['Purchase', 'Date,Description,Type,Amount (USD),Purchased By', (r: string) => `${r},A Person`],
  ])('reads a card with negative charges and a Type of %s the way its figures run', async (word, head, end) => {
    const rows = [`CORNER MARKET,${word},-74.10`, `MOON BOOKS,${word},-22.50`, `HARBOR COFFEE,${word},-38.06`, 'MOON BOOKS RETURN,Return,22.50']
    const dated = head.includes('Clearing') ? rows.map((r) => `11/02/2026,${r}`) : rows
    const file = await read(table(head, dated.map(end)))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true, note: 'column' })
    expect(file.read['CORNER MARKET']).toBe('-74.10')
    expect(file.read['MOON BOOKS RETURN']).toBe('refund 22.50')
  })

  it('turns no bank month around on a line that runs the way a payment would, where the rows do not fit a card', async () => {
    const file = await read(table('Date,Description,Amount', ['ACME INC,1800.00', 'CORNER MARKET,-74.10', 'MOON BOOKS,-22.50', 'HARBOR COFFEE,-38.06', 'PAYMENT THANK YOU,-300.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(file.read['ACME INC']).toBe('+1800.00')
  })

  it('says what a read rests on when these columns are all there is', async () => {
    const file = await read(table('Date,Clearing Date,Description,Amount (USD)', ['11/02/2026,ACME INC,1800.00', '11/02/2026,SIDE JOB,300.00']))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true, note: 'column' })
  })

  it('takes Apple’s words with the purchases running the other way for no proof', async () => {
    const file = await read(month((_, i) => (i === 1 ? 'Payment' : 'Purchase')))
    expect(file.sign).not.toBe('card-positive')
    expect(file.read['CORNER MARKET']).toBe('-74.10')
  })

  it('asks of one Purchase cell beside money in that says Credit', async () => {
    const file = await read(table(HEAD, [row('ACME INC', 'Credit', '1800.00'), row('SIDE JOB', 'Purchase', '40.00'), row('CORNER MARKET', 'Debit', '-74.10'), row('MOON BOOKS', 'Debit', '-22.50')]))
    expect(file.signProven).toBe(false)
  })

  it('turns no checking month around on Apple’s words with no purchase in them', async () => {
    const file = await read(table(HEAD, [row('RENT PORTAL', 'Payment', '-900.00'), row('CORNER MARKET', 'Debit', '-74.10'), row('LATE FEE', 'Fee', '-22.50'), row('INTEREST PAID', 'Interest', '4.11')]))
    expect(file.sign).not.toBe('card-positive')
    expect(file.read['RENT PORTAL']).toContain('-900.00')
  })
})

describe('a figure with an unquoted comma', () => {
  const noted = (file: Awaited<ReturnType<typeof read>>, note: string) => file.read[note]

  it('reads a Balance and an Amount written so, on every row', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/13/2026,RENT PORTAL,-1,650.00,4,000.00
11/14/2026,CORNER MARKET,-74.10,3,925.90
11/15/2026,ACME INC,2,310.45,6,236.35
11/16/2026,MOON BOOKS,-38.06,6,198.29
`)
    expect(file.leftOut).toEqual([])
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
    expect(noted(file, 'CORNER MARKET')).toBe('-74.10')
    expect(noted(file, 'ACME INC')).toBe('+2310.45')
    expect(file.rows[0][3]).toBe('4,000.00')
  })

  it('reads a pair of columns written so', async () => {
    const file = await read(`Date,Description,Withdrawals,Deposits,Balance
11/13/2026,CHECK 4417,1,210.00,,5,000.00
11/14/2026,CORNER MARKET,74.10,,4,925.90
11/15/2026,ACME INC,,2,310.45,7,236.35
`)
    expect(file.read).toEqual({ 'CHECK 4417': '-1210.00', 'CORNER MARKET': '-74.10', 'ACME INC': '+2310.45' })
  })

  it('reads one where the row’s empty cells hide it', async () => {
    const file = await read(`Date,Description,Amount,Memo,Reference
11/13/2026,RENT PORTAL,-1,650.00,,
11/14/2026,CORNER MARKET,-74.10,,
11/15/2026,MOON BOOKS,-38.06,,
11/16/2026,ACME INC,2310.45,,
`)
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
  })

  it('reads one that only a few rows have', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/13/2026,RENT PORTAL,-1,650.00,4000.00
11/14/2026,CORNER MARKET,-74.10,3925.90
11/15/2026,MOON BOOKS,-38.06,3887.84
`)
    expect(file.leftOut).toEqual([])
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
  })

  it.each([
    ['$-1,650.00', '-1650.00'],
    ['-$1,650.00', '-1650.00'],
    ['($1,650.00)', '-1650.00'],
    ['1,650.00-', '-1650.00'],
  ])('reads %s', async (cell, shown) => {
    const file = await read(`Date,Description,Amount,Balance\n11/13/2026,RENT PORTAL,${cell},4000.00\n11/14/2026,CORNER MARKET,-74.10,3925.90\n11/15/2026,ACME INC,2310.45,6236.35\n`)
    expect(noted(file, 'RENT PORTAL')).toBe(shown)
  })

  it('reads whole dollars, and a million', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/13/2026,RENT PORTAL,-1,650,4000
11/14/2026,HOUSE SALE,1,234,567.89,4000
11/15/2026,CORNER MARKET,-74,3926
`)
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
    expect(noted(file, 'HOUSE SALE')).toBe('+1234567.89')
  })

  it('reads one in a file with no header', async () => {
    const file = await read('11/13/2026,-1,650.00,RENT PORTAL\n11/14/2026,-74.10,CORNER MARKET\n11/15/2026,-38.06,MOON BOOKS\n')
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
  })

  it('still leaves out a row that a comma in its words moved', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/13/2026,ACME, INC,-14.25,985.75
11/14/2026,CORNER MARKET,-74.10,911.65
11/15/2026,MOON BOOKS,-38.06,873.59
`)
    expect(file.leftOut).toMatchObject([{ why: 'wide' }])
  })

  it('keeps reading a file whose header really is short', async () => {
    const file = await read(`Date,Description,Amount
11/13/2026,HARBOR COFFEE,-14.25,985.75
11/14/2026,CORNER MARKET,-5,123.45
11/15/2026,ACME INC,2310.45,2433.90
`)
    expect(file.leftOut).toEqual([])
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-14.25', 'CORNER MARKET': '-5.00', 'ACME INC': '+2310.45' })
  })

  it('rejoins a figure in a file whose header is short, where the row runs past the others', async () => {
    const file = await read(`Date,Description,Amount
11/13/2026,HARBOR COFFEE,-14.25,985.75
11/14/2026,RENT PORTAL,-1,650.00,-664.25
11/15/2026,ACME INC,2310.45,1646.20
`)
    expect(file.leftOut).toEqual([])
    expect(noted(file, 'RENT PORTAL')).toBe('-1650.00')
  })

  it('leaves a whole figure and a balance beside it alone on a file that ends every row in a comma', async () => {
    const file = await read(`Date,Description,Amount,Balance
11/13/2026,HARBOR COFFEE,-5,123.45,
11/14/2026,CORNER MARKET,-14.25,109.20,
11/15/2026,MOON BOOKS,-3.20,106.00,
`)
    expect(noted(file, 'HARBOR COFFEE')).toBe('-5.00')
  })

  it('leaves a check number beside a whole figure alone', async () => {
    const file = await read(`Date,Description,Amount,Check Number,Reference
11/13/2026,CHECK,-150,123,
11/14/2026,CORNER MARKET,-14.25,,
11/15/2026,MOON BOOKS,-3.20,,
`)
    expect(noted(file, 'CHECK')).toBe('-150.00')
  })

  it('takes no figure apart in a file of semicolons', async () => {
    const file = await read('Date;Description;Amount;Balance\n11/13/2026;HARBOR COFFEE;-5;123.45;1;000\n11/14/2026;CORNER MARKET;-14.25;109.20\n11/15/2026;MOON BOOKS;-3.20;106.00\n')
    expect(file.rows[0]).toEqual(['11/13/2026', 'HARBOR COFFEE', '-5', '123.45', '1', '000'])
  })
})

describe('money out in a card’s words for money back', () => {
  const HEAD = 'Date,Description,Amount'
  const PERKS = ['ANNUAL MEMBERSHIP FEE,95.00', 'AIRLINE FEE CREDIT,-50.00', 'HOTEL CREDIT,-50.00', 'DINING CREDIT,-10.00']

  it('asks of a card whose money back outnumbers its charges', async () => {
    const file = await read(table(HEAD, PERKS))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
    expect(readTableSign(file, file.cols)).toMatchObject({ doubt: 'back', plain: true })
    expect(await readAs(table(HEAD, PERKS), 'card-positive')).toMatchObject({ 'ANNUAL MEMBERSHIP FEE': '-95.00', 'HOTEL CREDIT': 'refund 50.00' })
  })

  it.each(['MERCHANT RETURN', 'ORDER REFUND', 'FEE REVERSAL', 'STATEMENT CREDIT'])('counts %s among those words', async (word) => {
    const file = await read(table(HEAD, ['ANNUAL MEMBERSHIP FEE,95.00', `${word},-50.00`, `${word} 2,-50.00`, 'CORNER MARKET,-12.00']))
    expect(file.signProven).toBe(false)
  })

  it('asks of a month with nothing else in it', async () => {
    const file = await read(table(HEAD, ['HOTEL CREDIT,-50.00', 'DINING CREDIT,-10.00']))
    expect(file.signProven).toBe(false)
  })

  it('stops for nothing beside a Balance column', async () => {
    const file = await read(table(`${HEAD},Balance`, ['ANNUAL MEMBERSHIP FEE,95.00,195.00', 'AIRLINE FEE CREDIT,-50.00,145.00', 'HOTEL CREDIT,-50.00,95.00', 'DINING CREDIT,-10.00,85.00']))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it.each([
    ['a credit card being paid', ['ACME INC,1200.00', 'HARBOR BANK CREDIT CRD AUTOPAY,-300.00', 'BANK CREDIT CARD PAYMENT,-300.00', 'CORNER MARKET,-12.00']],
    ['a credit union', ['ACME INC,1200.00', 'HARBOR CREDIT UNION LOAN,-300.00', 'HARBOR CREDIT UNION VISA,-200.00', 'CORNER MARKET,-12.00']],
    ['a few of them among the rest', ['ACME INC,1200.00', 'CORNER MARKET,-12.00', 'MOON BOOKS,-18.75', 'PINE DINER,-41.10', 'ACME RETURN FEE,-5.00']],
  ])('stops for nothing at %s', async (_, rows) => {
    const file = await read(table(HEAD, rows))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })
})

describe('reading gaps', () => {
  it.each(['TOTAL CREDITS', 'TOTAL DEBITS', 'TOTAL DEPOSITS', 'TOTAL WITHDRAWALS', 'TOTAL PURCHASES', 'TOTAL PAYMENTS', 'Total Credits:'])('starts a dated %s unticked', async (note) => {
    const file = await read(table('Date,Description,Amount', ['ACME INC,1800.00', 'CORNER MARKET,-74.10', `${note},1800.00`]))
    expect(file.read[note]).toContain('unticked')
  })

  it.each(['TOTAL WINE', 'TOTAL CREDITS LLC', 'TOTAL PAYMENTS INC'])('takes %s for a shop', async (note) => {
    const file = await read(table('Date,Description,Amount', ['ACME INC,1800.00', 'CORNER MARKET,-74.10', `${note},-10.00`]))
    expect(file.read[note]).toBe('-10.00')
  })

  it('takes the words from the first column with any in it', async () => {
    const file = await read('Date,Payee,Description,Amount\n11/03/2026,HARBOR COFFEE,,-14.25\n11/04/2026,MOON BOOKS,,-38.06\n')
    expect(file.read).toEqual({ 'HARBOR COFFEE': '-14.25', 'MOON BOOKS': '-38.06' })
  })

  it('keeps a Description that is only filled now and then', async () => {
    const t = readTable('Date,Payee,Description,Amount\n11/03/2026,HARBOR,,-14.25\n11/04/2026,MOON,BOOKS AND MORE,-38.06\n')
    expect(t.headers[t.cols.note]).toBe('Description')
  })

  it.each(['Transaction Date', 'Posted Date', 'Post Date'])('takes %s over a Statement Date before it', async (name) => {
    const t = readTable(`Statement Date,${name},Description,Amount\n10/31/2026,10/13/2026,HARBOR COFFEE,-14.25\n`)
    expect(t.headers[t.cols.date]).toBe(name)
  })

  it('takes a Statement Date where there is no other', async () => {
    const t = readTable('Statement Date,Description,Amount\n10/31/2026,HARBOR COFFEE,-14.25\n')
    expect(t.cols.date).toBe(0)
  })
})

describe('a Credit column of negatives beside a Debit column of plain figures', () => {
  const HEAD = 'Status,Date,Description,Debit,Credit'
  const row = (note: string, debit: string, credit = '') => `Cleared,11/05/2026,${note},${debit},${credit}`
  const CHARGES = [row('HARBOR COFFEE', '12.34'), row('CORNER MARKET', '54.20'), row('TRAIL BIKE SHOP', '230.00'), row('MOON BOOKS', '18.75')]
  const write = (rows: string[]) => `${[HEAD, ...rows].join('\n')}\n`

  it.each(['AUTOPAY 482910044713RAUTOPAY AUTO-PMT', 'AUTOPAY', 'AUTO PAY PAYMENT', 'ONLINE PAYMENT THANK YOU'])('reads as a card, so %s is the card being paid', async (note) => {
    const file = await read(write([...CHARGES, row(note, '', '-612.40'), row('ACME RETURN', '', '-35.18')]))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.note).toBeUndefined()
    expect(file.read[note]).toBe('+612.40 unticked')
    expect(file.read['ACME RETURN']).toBe('refund 35.18')
    expect(file.read['CORNER MARKET']).toBe('-54.20')
  })

  it('reads a month with a return and no payment as a card too', async () => {
    const file = await read(write([...CHARGES, row('ACME RETURN', '', '-35.18')]))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.read['ACME RETURN']).toBe('refund 35.18')
  })

  it('has nothing to say of a month with no credit in it: every row reads the same', async () => {
    const file = await read(write(CHARGES))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    expect(file.read['HARBOR COFFEE']).toBe('-12.34')
  })

  it('keeps a pay day a bank’s, whichever way its Credit column writes it', async () => {
    const file = await read(write([...CHARGES, row('ACME PAYROLL', '', '-2500.00')]))
    expect(file.sign).toBe('negative-expense')
    expect(file.read['ACME PAYROLL']).toBe('+2500.00')
  })

  it('keeps a file with a running balance a bank’s', async () => {
    const file = await read(table('Date,Description,Debit,Credit,Balance', ['HARBOR COFFEE,12.34,,987.66', 'CORNER MARKET,54.20,,933.46', 'SIDE JOB,,-40.00,973.46']))
    expect(file.sign).toBe('negative-expense')
    expect(file.read['SIDE JOB']).toBe('+40.00')
  })

  it('takes a Credit column of plain figures for nothing of the kind', async () => {
    const file = await read(write([...CHARGES, row('SIDE JOB', '', '40.00')]))
    expect(file.sign).toBe('negative-expense')
    expect(file.read['SIDE JOB']).toBe('+40.00')
  })

  it('takes a person’s columns the same way', () => {
    const t = readTable(write([...CHARGES, row('ACME RETURN', '', '-35.18')]))
    expect(readTableSign(t, t.cols)).toMatchObject({ sign: 'card-negative', proven: true })
    const signed = rereadCells({ ...t.cols, amount: t.cols.inflow!, inflow: -1 }, t.headers, t.rows)
    expect(readTableSign(t, signed).sign).not.toBe('card-negative')
  })
})

describe('words a bank’s site stamps on every row of a download', () => {
  const HEAD = '"Date","Transaction","Name","Memo","Amount"'
  const NAMES: [string, string][] = [
    ['ELECTRONIC DEPOSIT ACME PAYROLL', '2400.00'],
    ['ELECTRONIC DEPOSIT SIDE JOB ACH CREDIT', '1800.00'],
    ['ELECTRONIC WITHDRAWAL HARBOR INSURANCE AUTOPAY', '-118.20'],
    ['ELECTRONIC WITHDRAWAL CITY WATER BILL PAY', '-40.00'],
    ['DEBIT PURCHASE CORNER DELI', '-13.50'],
  ]
  const write = (memo: (name: string) => string) =>
    `${[HEAD, ...NAMES.map(([name, figure], i) => `"2026-11-0${i + 1}","${figure.startsWith('-') ? 'DEBIT' : 'CREDIT'}","${name}","${memo(name)}","${figure}"`)].join('\n')}\n`
  const RIGHT = {
    'ELECTRONIC DEPOSIT ACME PAYROLL': '+2400.00',
    'ELECTRONIC DEPOSIT SIDE JOB ACH CREDIT': '+1800.00',
    'ELECTRONIC WITHDRAWAL HARBOR INSURANCE AUTOPAY': '-118.20',
    'ELECTRONIC WITHDRAWAL CITY WATER BILL PAY': '-40.00',
    'DEBIT PURCHASE CORNER DELI': '-13.50',
  }

  it.each([
    ['a stamp and the name again', (name: string) => `Download from usbank.com. ${name}`],
    ['the stamp alone', () => 'Download from usbank.com.'],
    ['no memo', () => ''],
  ])('takes no card for its name: %s', async (_, memo) => {
    const file = await read(write(memo))
    expect(file.read).toEqual(RIGHT)
  })

  it('still reads a memo’s own words', async () => {
    const file = await read(table('Date,Description,Memo,Amount', ['SAVINGS,Download from usbank.com. MOVE TO SAVINGS TRANSFER,-200.00', 'CORNER MARKET,Download from usbank.com.,-20.00']))
    expect(file.read).toEqual({ SAVINGS: '-200.00 unticked', 'CORNER MARKET': '-20.00' })
  })
})

describe('a row whose meaning is in its Type or Action cell', () => {
  it('keeps a Venmo cash-out out of spending, and calls it what the file does', async () => {
    const file = await read(`,ID,Datetime,Type,Status,Note,From,To,Amount (total),Destination
,1001,2026-11-03T14:22:05,Payment,Complete,pizza,A Person,Sam Lee,- $18.50,
,1002,2026-11-05T14:22:05,Payment,Complete,rent share,Dana Kim,A Person,+ $650.00,
,1003,2026-11-07T14:22:05,Standard Transfer,Complete,,A Person,A Person,- $500.00,Bay Bank
,1004,2026-11-09T14:22:05,Instant Transfer,Complete,,A Person,A Person,- $40.00,Bay Bank
`)
    expect(file.read).toEqual({ pizza: '-18.50', 'rent share': '+650.00', 'Standard Transfer': '-500.00 unticked', 'Instant Transfer': '-40.00 unticked' })
  })

  const PAYPAL = 'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net'
  const paypal = (name: string, type: string, net: string) => `11/05/2026,09:14:11,PDT,${name},${type},Completed,USD,${net},0.00,${net}`

  it('keeps PayPal’s own money out of what a month spent and earned, and reads its refunds as refunds', async () => {
    const file = await read(`${[
      PAYPAL,
      paypal('Moon Books Online', 'Express Checkout Payment', '-42.50'),
      paypal('', 'Bank Deposit to PP Account ', '42.50'),
      paypal('Sam Lee', 'General Payment', '60.00'),
      paypal('Trail Bike Shop', 'Express Checkout Payment', '-88.20'),
      paypal('', 'General Card Deposit', '88.20'),
      paypal('Moon Books Online', 'Payment Refund', '42.50'),
      paypal('', 'General Withdrawal', '-42.50'),
    ].join('\n')}\n`)
    expect(file.read).toMatchObject({
      'Bank Deposit to PP Account': '+42.50 unticked',
      'General Card Deposit': '+88.20 unticked',
      'General Withdrawal': '-42.50 unticked',
      'Sam Lee': '+60.00',
      'Trail Bike Shop': '-88.20',
    })
    const { rows } = stageRows(file.rows, file.cols, file.sign, cats)
    expect(rows.filter((r) => r.amount < 0).map((r) => r.note)).toEqual(['Moon Books Online'])
  })

  it('takes PayPal’s words for its own money whatever name sits beside them', async () => {
    const file = await read(`${[PAYPAL, paypal('Moon Books Online', 'Express Checkout Payment', '-42.50'), paypal('Bay Bank', 'General Withdrawal', '-300.00')].join('\n')}\n`)
    expect(file.read['Bay Bank']).toBe('-300.00 unticked')
  })

  it('leaves a refund going out as money out', async () => {
    const file = await read(`${[PAYPAL, paypal('Sam Lee', 'Payment Refund', '-20.00'), paypal('Dana Kim', 'General Payment', '100.00')].join('\n')}\n`)
    expect(file.read['Sam Lee']).toBe('-20.00')
  })

  it('reads a brokerage’s Action where its Description says nothing, ahead of its Type', async () => {
    const file = await read(`Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Amount ($),Settlement Date
11/02/2026,"Electronic Funds Transfer Received (Cash)",,"No Description",Cash,0,,1000.00,
11/03/2026,"DEBIT CARD PURCHASE CORNER MARKET (Cash)",,"No Description",Cash,0,,-41.20,
11/15/2026,"DIVIDEND RECEIVED ACME INDEX FUND (Cash)",ACME,"ACME INDEX FUND",Cash,0,,12.31,
`)
    expect(file.read).toEqual({
      'Electronic Funds Transfer Received (Cash)': '+1000.00 unticked',
      'DEBIT CARD PURCHASE CORNER MARKET (Cash)': '-41.20',
      'ACME INDEX FUND': '+12.31',
    })
  })

  it('leaves a filled note alone, so a Type of Debit Card never makes a biller’s autopay a card payment', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR INSURANCE AUTOPAY,Debit Card,-118.20', 'CORNER MARKET,Debit Card,-20.00', 'ACME PAYROLL,Deposit,2400.00']))
    expect(file.read).toEqual({ 'HARBOR INSURANCE AUTOPAY': '-118.20', 'CORNER MARKET': '-20.00', 'ACME PAYROLL': '+2400.00' })
  })

  it('names nothing from the Type of this app’s own export', async () => {
    const file = await read('Date,Description,Amount,Type,Category,Account,Status\n2026-11-03,,12.34,Expense,,,Cleared\n2026-11-04,,40.00,Refund,,,Cleared\n')
    const { rows } = stageRows(file.rows, file.cols, file.sign, cats, { kinds: file.kinds })
    expect(rows.map((r) => [r.note, r.amount])).toEqual([['', 12.34], ['', -40]])
  })
})

describe('what a Type column of a card’s words leaves to say', () => {
  it('has no more to say of a month where a card’s own line sits among its Sale rows', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Sale,-12.34', 'CORNER MARKET,Sale,-54.20', 'ACME RETURN,Return,40.00', 'Payment Thank You-Mobile,Payment,300.00']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
    expect(file.note).toBeUndefined()
  })

  it('says what a month with no such line rests on', async () => {
    const file = await read(table('Date,Description,Type,Amount', ['HARBOR COFFEE,Sale,-12.34', 'CORNER MARKET,Sale,-54.20', 'ACME RETURN,Return,40.00']))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true, note: 'column' })
  })
})
