/** A chosen file, read by what is in it. Banks and figures are invented; the layouts are real. */
import { describe, expect, it } from 'vitest'
import { readTable } from './csv'
import { decodeText, ImportFileError, readImportFile, readSign } from './importFile'

const blob = (text: string) => new Blob([text])
const bytes = (...b: number[]) => new Uint8Array(b).buffer

describe('decodeText', () => {
  it('reads UTF-8, and drops the mark at the front', () => {
    expect(decodeText(new TextEncoder().encode('﻿Date,Café').buffer as ArrayBuffer)).toBe('Date,Café')
  })

  it('falls back to Windows-1252 when the bytes are not UTF-8', () => {
    expect(decodeText(bytes(0x43, 0x61, 0x66, 0xe9))).toBe('Café')
  })

  it('reads UTF-16, as Excel saves it', () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00))).toBe('AB')
  })
})

describe('readTable', () => {
  it('finds the header under a bank summary', () => {
    const t = readTable(`Description,,Summary Amt.
Beginning balance as of 10/01/2026,,"1,000.00"
Total credits,,"3,200.00"

Date,Description,Amount,Running Bal.
10/03/2026,Corner Market,-54.20,"945.80"
`)
    expect(t.headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.'])
    expect(t.rows).toEqual([['10/03/2026', 'Corner Market', '-54.20', '945.80']])
    expect(t.cols).toMatchObject({ date: 0, note: 1, amount: 2, inflow: -1 })
  })

  it('keeps the first row of a file with no header', () => {
    const t = readTable(`"11/03/2026","-4.50","*","","HARBOR COFFEE"
"11/02/2026","3200.00","*","","ACME PAYROLL"
`)
    expect(t.rows).toHaveLength(2)
    expect(t.headers).toEqual(['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5'])
    expect(t.cols).toMatchObject({ date: 0, amount: 1, note: 4 })
  })

  it('never takes a row of data for a header, whatever its words say', () => {
    const t = readTable('11/03/2026,DEBIT CARD,-4.50,POSTED DATE\n11/04/2026,CORNER MARKET,-1.00,POSTED DATE\n')
    expect(t.rows).toHaveLength(2)
    expect(t.headers[0]).toBe('Column 1')
  })

  it('picks a column for money out and one for money in', () => {
    const t = readTable('Status,Date,Description,Debit,Credit\nCleared,11/03/2026,Corner Market,54.20,\n')
    expect(t.cols).toMatchObject({ date: 1, note: 2, amount: 3, inflow: 4 })
  })

  it('reads Withdrawals and Deposits the same way', () => {
    expect(readTable('Date,Payee,Withdrawals,Deposits\n11/03/2026,Corner Market,54.20,\n').cols).toMatchObject({ amount: 2, inflow: 3 })
  })

  it('takes a named Amount over a Debit or Credit beside it', () => {
    expect(readTable('Date,Description,Amount,Debit,Credit\n').cols).toMatchObject({ amount: 2, inflow: -1 })
  })

  it.each([
    ['Amount Debit', 'Amount Credit'],
    ['Debit Amount', 'Credit Amount'],
    ['Withdrawal Amount', 'Deposit Amount'],
    ['Money Out', 'Money In'],
    ['Paid Out', 'Paid In'],
    ['Amount Out', 'Amount In'],
    ['Outflow', 'Inflow'],
  ])('reads %s and %s as two columns of money, whatever else they say', (out, into) => {
    const t = readTable(`Date,Description,${out},${into}\n11/03/2026,Corner Market,54.20,\n`)
    expect(t.cols).toMatchObject({ date: 0, note: 1, amount: 2, inflow: 3 })
  })

  it.each([
    ['after the pair', 'Date,Description,Debit Amount,Credit Amount,Balance Amount', { amount: 2, inflow: 3 }],
    ['before the pair', 'Date,Description,Balance Amount,Debit Amount,Credit Amount', { amount: 3, inflow: 4 }],
    ['before a plain Amount', 'Date,Description,Balance Amount,Amount', { amount: 3, inflow: -1 }],
    ['called a running total', 'Date,Description,Running Total,Amount', { amount: 3, inflow: -1 }],
    ['of available credit', 'Date,Description,Available Credit,Debit,Credit', { amount: 3, inflow: 4 }],
  ])('never takes a running balance for money: %s', (_, header, cols) => {
    expect(readTable(`${header}\n`).cols).toMatchObject(cols)
  })

  it('reads an Amount in a currency as one signed column, not as money in', () => {
    expect(readTable('Date,Description,Amount in USD\n').cols).toMatchObject({ amount: 2, inflow: -1 })
    expect(readTable('Date,Description,Debit,Amount in USD\n').cols).toMatchObject({ amount: 3, inflow: -1 })
  })

  it('finds the money out wherever it sits', () => {
    expect(readTable('Date,Description,Amount Credit,Amount Debit\n').cols).toMatchObject({ amount: 3, inflow: 2 })
  })

  it('takes an Amount that names no direction over two that do', () => {
    expect(readTable('Date,Description,Amount,Debit Amount,Credit Amount\n').cols).toMatchObject({ amount: 2, inflow: -1 })
  })

  it('does not make one column both sides of a file', () => {
    expect(readTable('Date,Description,Debit/Credit\n11/03/2026,Corner Market,-54.20\n').cols).toMatchObject({ amount: 2, inflow: -1 })
    expect(readTable('Date,Description,Debit/Credit Amount\n11/03/2026,Corner Market,-54.20\n').cols).toMatchObject({ amount: 2, inflow: -1 })
  })

  it('reads one side alone as a single column, and leaves the rest to the person', () => {
    expect(readTable('Date,Description,Debit Amount\n11/03/2026,Corner Market,54.20\n').cols).toMatchObject({ amount: 2, inflow: -1 })
  })

  it('takes no card number for a column of money', () => {
    expect(readTable('Date,Credit Card No.,Description,Amount\n11/03/2026,4000,Corner Market,-1.00\n').cols).toMatchObject({ amount: 3, inflow: -1 })
    expect(readTable('Transaction Date,Post Date,Card No.,Description,Category,Debit,Credit\n').cols).toMatchObject({ date: 0, note: 3, amount: 5, inflow: 6 })
  })

  it('leaves the first row as the header when it cannot tell', () => {
    const t = readTable('When,What,How much\n11/03/2026,Corner Market,-1.00\n')
    expect(t.headers).toEqual(['When', 'What', 'How much'])
    expect(t.rows).toHaveLength(1)
  })
})

describe('the column a row\u2019s words are in', () => {
  it('takes Description over the Details of a Chase checking file', () => {
    const t = readTable('Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,10/03/2026,CORNER MARKET,-54.20,DEBIT_CARD,945.80,,\n')
    expect(t.cols).toMatchObject({ date: 1, note: 2, amount: 3 })
  })

  it('takes Name over the Transaction of a US Bank file, and reads its Memo beside it', () => {
    const t = readTable('Date,Transaction,Name,Memo,Amount\n2026-10-03,DEBIT,CORNER MARKET,Download from the bank,-54.20\n')
    expect(t.cols).toMatchObject({ date: 0, note: 2, memo: 3, amount: 4 })
  })

  it('passes over an id, a type and a number, however they are written', () => {
    const labels = [
      'Transaction ID', 'TransactionId', 'Transaction_ID', 'Merchant ID', 'Transaction Type', 'Transaction Number',
      'Transaction No.', 'Transaction Num', 'Transaction #', 'Transaction Reference', 'Transaction Code', 'Transaction Status',
    ]
    for (const header of labels) expect(readTable(`Date,${header},Amount\n`).cols.note, header).toBe(-1)
  })

  it('takes no person, account or category for what a row was', () => {
    const labels = ['Member Name', 'Account Name', 'Merchant Category', 'Cardholder Name', 'Card Holder Name', 'Customer Name', 'Name on Card']
    for (const header of labels) expect(readTable(`Date,${header},Amount\n`).cols.note, header).toBe(-1)
  })

  it('leaves the words a label would have taken to the right column', () => {
    expect(readTable('Transaction ID,Date,Details,Amount\n1234567890,10/03/2026,CORNER MARKET,-54.20\n').cols.note).toBe(2)
  })

  it('goes down the list in order, whichever column comes first', () => {
    expect(readTable('Date,Transaction,Details,Memo,Name,Merchant,Description,Amount\n').cols.note).toBe(6)
    expect(readTable('Date,Transaction,Details,Memo,Name,Merchant,Amount\n').cols.note).toBe(5)
    expect(readTable('Date,Transaction,Details,Memo,Name,Amount\n').cols.note).toBe(4)
    expect(readTable('Date,Transaction,Details,Memo,Amount\n').cols.note).toBe(3)
    expect(readTable('Date,Transaction,Details,Amount\n').cols.note).toBe(2)
    expect(readTable('Date,Transaction,Amount\n').cols.note).toBe(1)
  })

  it('reads no memo beside itself', () => {
    expect(readTable('Date,Memo,Amount\n').cols).toMatchObject({ note: 1, memo: -1 })
  })
})

describe('readSign', () => {
  it('reads a bank file, mostly money going out', () => {
    expect(readSign([-5, -6, -7, 3200], ['a', 'b', 'c', 'd'])).toEqual({ sign: 'negative-expense', proven: true })
  })

  it('calls no file a card for its plain figures alone, and leaves it to the person', () => {
    expect(readSign([5, 6, 7, -2], ['a', 'b', 'c', 'd'])).toEqual({ sign: 'negative-expense', proven: false })
  })

  it('lets a card\u2019s own payment line settle it, whichever way it runs', () => {
    expect(readSign([-5, -6, 500], ['a', 'b', 'PAYMENT THANK YOU'])).toEqual({ sign: 'card-negative', proven: true, note: 'line' })
    expect(readSign([5, 6, -500], ['a', 'b', 'Payment - Thank You'])).toEqual({ sign: 'card-positive', proven: true, note: 'line' })
    expect(readSign([5, 6, -500], ['a', 'b', 'THANK YOU FOR YOUR PAYMENT'])).toEqual({ sign: 'card-positive', proven: true, note: 'line' })
  })

  it('takes no shop\u2019s thanks for a card being paid', () => {
    expect(readSign([-5, -6, -7, 500], ['a', 'b', 'c', 'THANK YOU DELI'])).toEqual({ sign: 'negative-expense', proven: true })
    expect(readSign([-5, -6, -7, 500], ['a', 'b', 'c', 'PAYPAL THANK YOU GIFTS'])).toEqual({ sign: 'negative-expense', proven: true })
  })

  it('takes a card column as a card, whose charges are most of its rows', () => {
    expect(readSign([5, 6, 7, -2], ['a', 'b', 'c', 'd'], ['Date', 'Card Member'])).toEqual({ sign: 'card-positive', proven: true, note: 'column' })
    expect(readSign([-5, -6, -7, 2], ['a', 'b', 'c', 'd'], ['Date', 'Card No.'])).toEqual({ sign: 'card-negative', proven: true, note: 'column' })
    expect(readSign([5, -6], ['a', 'b'], ['Date', 'Cardholder'])).toEqual({ sign: 'card-positive', proven: false })
  })

  it('takes a debit card\u2019s column as a bank account\u2019s', () => {
    expect(readSign([-5, -6, -7, 2], ['a', 'b', 'c', 'd'], ['Date', 'Debit Card No.'])).toEqual({ sign: 'negative-expense', proven: true })
  })

  it('says bank when there is nothing to go on', () => {
    expect(readSign([], [])).toEqual({ sign: 'negative-expense', proven: true })
    expect(readSign([null, 0], ['a', 'b'])).toEqual({ sign: 'negative-expense', proven: true })
  })
})

describe('readImportFile', () => {
  it('reads OFX by what is in it, whatever the file is called', async () => {
    const file = await readImportFile(
      blob('<OFX><FI><ORG>Test Bank</FI><CCSTMTRS><CCACCTFROM><ACCTID>4000000000005678</CCACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-12.00<FITID>C-1<NAME>CORNER MARKET</STMTTRN></CCSTMTRS></OFX>'),
    )
    expect(file).toMatchObject({
      format: 'ofx',
      sign: 'card-negative',
      rows: [['2026-11-03', '-12.00', 'CORNER MARKET', '']],
      ids: ['4000000000005678|C-1'],
      cards: [true],
      account: 'Test Bank ··5678',
    })
  })

  it('never carries a whole account number into a label', async () => {
    const file = await readImportFile(blob('<OFX><STMTRS><BANKACCTFROM><ACCTID>1234567890</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-1<FITID>1</STMTTRN></STMTRS></OFX>'))
    expect(file.account).toBe('Account ··7890')
    expect(file.title).toBe('Account ··7890')
  })

  it('gives no one label to two accounts', async () => {
    const file = await readImportFile(
      blob(`<OFX><STMTRS><BANKACCTFROM><ACCTID>111</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-1<FITID>1</STMTTRN></STMTRS>
      <STMTRS><BANKACCTFROM><ACCTID>222</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-1<FITID>1</STMTTRN></STMTRS></OFX>`),
    )
    expect(file.account).toBe('')
    expect(file.title).toBe('2 statements')
    expect(new Set(file.ids).size).toBe(2)
  })

  it('says so when a statement has no rows', async () => {
    await expect(readImportFile(blob('<OFX><STMTRS></STMTRS></OFX>'))).rejects.toThrow(ImportFileError)
  })

  it('reads a CSV, and says so when it has nothing in it', async () => {
    expect(await readImportFile(blob('Date,Description,Amount\n11/03/2026,Corner Market,-1.00\n'))).toMatchObject({ format: 'csv', sign: 'negative-expense' })
    await expect(readImportFile(blob('just some text'))).rejects.toThrow(/no rows/)
  })

  it('asks nothing about signs when two columns say which way each row runs', async () => {
    const file = await readImportFile(blob('Date,Description,Debit,Credit\n11/03/2026,Corner Market,5.00,\n11/04/2026,Harbor Coffee,6.00,\n'))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
    const mostlyIn = await readImportFile(blob('Date,Description,Debit,Credit\n11/03/2026,Payroll,,3200.00\n11/04/2026,Payroll,,3200.00\n'))
    expect(mostlyIn).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('reads a savings file as a bank account, and asks', async () => {
    const file = await readImportFile(
      blob('Date,Description,Amount\n10/01/2026,DEPOSIT,500.00\n10/15/2026,DEPOSIT,500.00\n10/31/2026,INTEREST PAID,3.10\n09/30/2026,INTEREST PAID,3.05\n10/20/2026,WITHDRAWAL,-100.00\n'),
    )
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('reads a window of mostly paydays the same way', async () => {
    const file = await readImportFile(blob('Date,Description,Amount\n10/01/2026,ACME PAYROLL,3200.00\n10/15/2026,ACME PAYROLL,3200.00\n10/29/2026,ACME PAYROLL,3200.00\n10/20/2026,CORNER MARKET,-54.20\n'))
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: false })
  })

  it('reads a card by its column for card members, with charges positive', async () => {
    const file = await readImportFile(blob('Date,Description,Card Member,Account #,Amount\n10/03/2026,CORNER MARKET,A TEST,-11111,54.20\n10/04/2026,HARBOR COFFEE,A TEST,-11111,6.00\n'))
    expect(file).toMatchObject({ sign: 'card-positive', signProven: true })
  })

  it('reads a card with Debit and Credit columns by its Card No. column', async () => {
    const file = await readImportFile(blob('Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n2026-10-03,2026-10-04,1234,CORNER MARKET,Merchandise,54.20,\n'))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
  })

  it('reads a card with Debit and Credit columns by its payment line', async () => {
    const file = await readImportFile(blob('Status,Date,Description,Debit,Credit\nCleared,10/03/2026,CORNER MARKET,54.20,\nCleared,10/05/2026,TARGET,,-20.00\nCleared,10/06/2026,"ONLINE PAYMENT, THANK YOU",,-300.00\n'))
    expect(file).toMatchObject({ sign: 'card-negative', signProven: true })
  })

  it('knows this app’s own export, which says what each row is', async () => {
    const file = await readImportFile(blob('\uFEFFDate,Description,Amount,Type,Category,Account,Status\n2026-11-03,Corner Market,12.00,Refund,,,Posted\n2026-11-02,Payroll,3200.00,Income,,,Posted\n2026-11-01,Metro Fare,-2.75,Other,,,Posted\n'))
    expect(file.kinds).toEqual(['refund', 'income', undefined])
    expect(file).toMatchObject({ sign: 'negative-expense', signProven: true })
  })

  it('refuses a file too large to read here', async () => {
    const big = { size: 26 * 1024 * 1024 } as Blob
    await expect(readImportFile(big)).rejects.toThrow(/too large/)
  })
})
