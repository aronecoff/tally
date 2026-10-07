/**
 * Card credits: a payment to the card is money movement, a merchant giving
 * money back is a refund. Every card credit used to be skipped, so refunds never
 * reached Tally and card spending read high by each one. The guard that matters
 * most runs the other way: a payment must never be read as a refund, because
 * that would erase a month of spending. Descriptors below are the issuers'
 * public wording; accounts and amounts are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_CREDIT_NOT_REFUND_RE, classifyBankTx, detectPendingTransferIds, detectTransferIds, effectiveTier, matchRentRefunds, rentDate,
  rentRedate, rentRefile, tierFromName, tierFromRows, type SyncedTx,
} from './bankRules'

const CARD = 'Test Bank Rewards Visa (1111)'
const CARD_2 = 'Other Issuer Gold Card (2222)'
const CHECKING = 'Test Bank Checking (3333)'
const DAY = 86400
const T0 = 1_788_000_000 // an arbitrary posted time

let n = 0
const tx = (p: Partial<SyncedTx> & Pick<SyncedTx, 'amount' | 'account'>): SyncedTx => ({
  sourceTxId: `t${++n}`,
  tier: p.account === CHECKING ? 'cash' : 'credit',
  posted: T0,
  description: '',
  payee: '',
  memo: '',
  mcc: null,
  ...p,
})

const kind = (t: SyncedTx, all: SyncedTx[] = [t]) => {
  const v = classifyBankTx(t, detectTransferIds(all))
  return v.kind === 'skip' ? `skip:${v.rule}` : v.kind
}

describe('card credits', () => {
  it('a merchant refund on a card is a refund', () => {
    expect(kind(tx({ account: CARD, amount: 24.5, payee: 'Amazon', description: 'AMAZON MKTPLACE PMTS' }))).toBe('refund')
    expect(kind(tx({ account: CARD_2, amount: 12, payee: 'Blue Bottle', description: 'BLUE BOTTLE COFFEE' }))).toBe('refund')
  })

  it("Amazon's 'PMTS' descriptor is not a payment (\\bpmt\\b stays bounded)", () => {
    expect(CARD_CREDIT_NOT_REFUND_RE.test('AMAZON MKTPLACE PMTS')).toBe(false)
    expect(CARD_CREDIT_NOT_REFUND_RE.test('AMAZON PRIME PMTS')).toBe(false)
    expect(CARD_CREDIT_NOT_REFUND_RE.test('CARD PMT')).toBe(true)
  })

  it('card payments are dropped by their own text, with no pair to lean on', () => {
    // Chase and Amex word it differently; the Amex dash form used to slip past.
    const chase = tx({ account: CARD, amount: 480.12, payee: 'Payment', description: 'Payment Thank You-Mobile' })
    const amex = tx({ account: CARD_2, amount: 250, payee: 'Payment', description: 'MOBILE PAYMENT - THANK YOU' })
    const autopay = tx({ account: CARD_2, amount: 91.4, description: 'AUTOPAY PAYMENT RECEIVED - THANK YOU' })
    for (const t of [chase, amex, autopay]) expect(kind(t)).toBe('skip:money-movement')
  })

  it('issuer credits the keyword list misses still never become refunds', () => {
    expect(kind(tx({ account: CARD, amount: 300, payee: 'Payment', description: 'INTERNET PAYMENT RECEIVED' }))).toBe('skip:card-credit')
    expect(kind(tx({ account: CARD, amount: 25, description: 'REWARDS REDEMPTION CREDIT' }))).toBe('skip:card-credit')
    expect(kind(tx({ account: CARD, amount: 50, description: 'CASH BACK REDEEMED' }))).toBe('skip:card-credit')
    expect(kind(tx({ account: CARD, amount: 60, description: 'PAY YOURSELF BACK CREDIT' }))).toBe('skip:card-credit')
  })

  it('a statement credit and a balance transfer stay money movement', () => {
    expect(kind(tx({ account: CARD, amount: 15, description: 'STATEMENT CREDIT' }))).toBe('skip:money-movement')
    expect(kind(tx({ account: CARD, amount: 900, description: 'BALANCE TRANSFER' }))).toBe('skip:money-movement')
  })

  it('a card payment pairs with its checking debit, and both sides drop', () => {
    const debit = tx({ account: CHECKING, amount: -812.33, payee: 'Test Bank', description: 'TEST BANK CREDIT CRD EPAY' })
    const credit = tx({ account: CARD, amount: 812.33, posted: T0 + DAY, payee: 'Payment', description: 'Payment Thank You-Mobile' })
    expect(kind(debit, [debit, credit])).toBe('skip:transfer-pair')
    expect(kind(credit, [debit, credit])).toBe('skip:transfer-pair')
  })

  it('card purchases stay expenses; bank rows keep their direction', () => {
    expect(kind(tx({ account: CARD, amount: -24.5, description: 'AMAZON MKTPLACE PMTS' }))).toBe('expense')
    expect(kind(tx({ account: CHECKING, amount: -60, description: 'CORNER STORE' }))).toBe('expense')
    expect(kind(tx({ account: CHECKING, amount: 1500, description: 'ACME PAYROLL' }))).toBe('income')
  })

  it('a zero row is skipped', () => {
    expect(kind(tx({ account: CHECKING, amount: 0, description: 'FEE WAIVER' }))).toBe('skip:no-amount')
  })
})

describe('a hand re-file into or out of Rent', () => {
  const pay = { uid: 'sf:z1', date: '2026-09-27', type: 'expense', amount: 2400 }

  it('into Rent: the 1st it pays for, with the posted day kept beside it', () => {
    expect(rentRedate(pay, false, true)).toBe('2026-10-01')
    expect(rentRefile(pay, false, true)).toEqual({ date: '2026-10-01', posted: '2026-09-27' })
  })

  it('out of Rent: back to the day the bank posted it', () => {
    const rent = { ...pay, date: '2026-10-01', posted: '2026-09-27' }
    expect(rentRedate(rent, true, false)).toBe('2026-09-27')
    expect(rentRefile(rent, true, false)).toEqual({ date: '2026-09-27' })
  })

  it('out of Rent, a row keeps its date when the posted day is unknown or the date is not the one Rent gave it', () => {
    expect(rentRedate({ ...pay, date: '2026-10-01' }, true, false)).toBeNull()
    // Moved by hand to another day since.
    expect(rentRedate({ ...pay, date: '2026-10-05', posted: '2026-09-27' }, true, false)).toBeNull()
    // Paid on time: the date never moved.
    expect(rentRedate({ ...pay, date: '2026-09-02', posted: '2026-09-02' }, true, false)).toBeNull()
    // A typed row, a refund, income.
    expect(rentRedate({ ...pay, uid: 'typed-1', date: '2026-10-01', posted: '2026-09-27' }, true, false)).toBeNull()
    expect(rentRedate({ ...pay, amount: -2400, date: '2026-10-01', posted: '2026-09-27' }, true, false)).toBeNull()
    expect(rentRedate({ ...pay, type: 'income', date: '2026-10-01', posted: '2026-09-27' }, true, false)).toBeNull()
    // Rent to Rent, or neither: nothing moves.
    expect(rentRedate({ ...pay, date: '2026-10-01', posted: '2026-09-27' }, true, true)).toBeNull()
    expect(rentRefile(pay, false, false)).toBeNull()
  })
})

describe('rent paid early', () => {
  it('the 20th or later counts on the 1st of the next month, whatever its length', () => {
    expect(rentDate('2026-09-28')).toBe('2026-10-01')
    expect(rentDate('2026-09-24')).toBe('2026-10-01')
    expect(rentDate('2026-09-23')).toBe('2026-10-01')
    expect(rentDate('2026-08-24')).toBe('2026-09-01')
    expect(rentDate('2026-09-20')).toBe('2026-10-01')
    expect(rentDate('2026-07-31')).toBe('2026-08-01')
    expect(rentDate('2026-08-25')).toBe('2026-09-01')
    expect(rentDate('2026-02-22')).toBe('2026-03-01')
    expect(rentDate('2026-12-29')).toBe('2027-01-01')
  })

  it('anything earlier stays where it was paid', () => {
    expect(rentDate('2026-09-19')).toBe('2026-09-19')
    expect(rentDate('2026-08-19')).toBe('2026-08-19')
    expect(rentDate('2026-10-01')).toBe('2026-10-01')
    expect(rentDate('2026-10-15')).toBe('2026-10-15')
  })

  it('a payer on the same day every month gets exactly one rent per month (leap years included)', () => {
    const bad: string[] = []
    for (let payday = 1; payday <= 31; payday++) {
      const perMonth = new Map<string, number>()
      const months: string[] = []
      for (let y = 2026; y <= 2033; y++) {
        for (let m = 1; m <= 12; m++) {
          const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
          const iso = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(payday, last)).padStart(2, '0')}`
          const filed = rentDate(iso).slice(0, 7)
          perMonth.set(filed, (perMonth.get(filed) ?? 0) + 1)
          months.push(iso.slice(0, 7))
        }
      }
      // The first and last months of the run are partial by construction.
      for (const m of months.slice(1, -1)) if (perMonth.get(m) !== 1) bad.push(`day ${payday}: ${m} has ${perMonth.get(m) ?? 0}`)
    }
    expect(bad).toEqual([])
  })
})

describe('transfer pairs inside the 5-day window', () => {
  const SAV = 'Test Bank Savings (4444)'
  const at = (id: string, account: string, amount: number, day: number, description: string, tier = 'cash'): SyncedTx => ({
    sourceTxId: id, account, tier, posted: T0 + day * DAY, amount, description, payee: description, memo: '', mcc: null,
  })
  const read = (all: SyncedTx[]) => {
    const ids = detectTransferIds(all)
    return Object.fromEntries(all.map((t) => {
      const v = classifyBankTx(t, ids)
      return [t.sourceTxId, v.kind === 'skip' ? `skip:${v.rule}` : v.kind]
    }))
  }

  it('the same monthly sweep three times: every DEPOSIT pairs', () => {
    const rows = [0, 30, 61].flatMap((d, i) => [
      at(`out${i}`, CHECKING, -500, d, 'ONLINE TRANSFER TO SAV'),
      at(`in${i}`, SAV, 500, d + 1, 'DEPOSIT'),
    ])
    const v = read(rows)
    for (let i = 0; i < 3; i++) expect(v[`in${i}`]).toBe('skip:transfer-pair')
  })

  it('a weekly Friday-to-Monday sweep pairs every week', () => {
    const rows = [0, 7, 14, 21].flatMap((d, i) => [
      at(`out${i}`, CHECKING, -250, d, 'ONLINE TRANSFER TO SAV'),
      at(`in${i}`, SAV, 250, d + 3, 'DEPOSIT'),
    ])
    const v = read(rows)
    for (let i = 0; i < 4; i++) expect(v[`in${i}`]).toBe('skip:transfer-pair')
  })

  it('an unrelated same-amount purchase elsewhere in the feed does not block the pair', () => {
    const rows = [
      at('old', CARD, -500, -60, 'BEST BUY #123', 'credit'),
      at('near', CARD, -500, 1, 'BEST BUY #456', 'credit'),
      at('out', CHECKING, -500, 0, 'ONLINE TRANSFER TO SAV'),
      at('in', SAV, 500, 1, 'DEPOSIT'),
    ]
    const v = read(rows)
    expect(v.in).toBe('skip:transfer-pair')
    // Neither card purchase is used up as a transfer leg.
    expect(v.old).toBe('expense')
    expect(v.near).toBe('expense')
  })

  it('a $40 purchase and a $40 refund never pair', () => {
    const rows = [at('buy', CARD, -40, 0, 'CORNER CAFE', 'credit'), at('back', CARD_2, 40, 1, 'CORNER CAFE', 'credit')]
    expect(detectTransferIds(rows).size).toBe(0)
  })

  it('two debits at the same distance from one DEPOSIT: no guess', () => {
    const rows = [
      at('a', CHECKING, -300, 0, 'ONLINE TRANSFER TO SAV'),
      at('b', 'Other Bank Checking (7777)', -300, 2, 'ONLINE TRANSFER TO SAV'),
      at('in', SAV, 300, 1, 'DEPOSIT'),
    ]
    expect(detectTransferIds(rows).has('in')).toBe(false)
  })
})

describe('bills paid by autopay, ACH or bill pay are spending', () => {
  const k = (account: string, amount: number, description: string, tier = account === CHECKING ? 'cash' : 'credit') =>
    kind({ sourceTxId: `x${++n}`, account, tier, posted: T0, amount, description, payee: '', memo: '', mcc: null })

  it('billers keep their charge', () => {
    for (const d of ['GEICO AUTOPAY', 'PGANDE WEB ONLINE PAYMENT', 'STATE FARM ACH DEBIT', 'SFPUC WATER BILL PAY', 'LEMONADE INS EPAY', 'COMCAST CABLE AUTOPAY']) {
      expect(k(CHECKING, -120, d)).toBe('expense')
    }
    expect(k(CARD, -85, 'TMOBILE*AUTO PAY')).toBe('expense')
    expect(k(CARD, -85, 'ATT*BILL PAYMENT')).toBe('expense')
  })

  it('payroll by ACH is income', () => {
    expect(k(CHECKING, 1500, 'ACME PAYROLL ACH CREDIT')).toBe('income')
  })

  it('card bills paid from checking are still money movement', () => {
    for (const d of ['AMEX EPAYMENT ACH PMT', 'CHASE CREDIT CRD AUTOPAY', 'CITI AUTOPAY PAYMENT', 'CAPITAL ONE ONLINE PMT']) {
      expect(k(CHECKING, -400, d)).toBe('skip:money-movement')
    }
    expect(k(CARD, 91.4, 'AUTOPAY PAYMENT RECEIVED - THANK YOU')).toBe('skip:money-movement')
  })

  it('brokerage funding by ACH that names only the broker or its clearing firm is money movement', () => {
    for (const d of ['APEX CLEARING ACH DEBIT', 'ROBINHOOD MONEY ACH DEBIT', 'ACH DEBIT ROBINHOOD', 'ROBINHOOD DEBITS']) {
      expect(k(CHECKING, -500, d)).toBe('skip:money-movement')
    }
    expect(k(CHECKING, 500, 'APEX CLEARING ACH CREDIT')).toBe('skip:money-movement')
  })

  it("a Robinhood card's bill is still spending", () => {
    for (const d of ['Robinhood Payment 123456 CCB', 'ROBINHOOD PAYMENT CCB ACH DEBIT']) {
      expect(k(CHECKING, -512.34, d)).toBe('expense')
    }
  })

  it('a card payment that reads only as autopay on checking still pairs with the card side', () => {
    const debit = tx({ account: CHECKING, amount: -812.33, description: 'ACME BANK AUTOPAY' })
    const credit = tx({ account: CARD, amount: 812.33, posted: T0 + DAY, payee: 'Payment', description: 'INTERNET PAYMENT RECEIVED' })
    expect(kind(debit, [debit, credit])).toBe('skip:transfer-pair')
    expect(kind(credit, [debit, credit])).toBe('skip:transfer-pair')
  })
})

describe('investment accounts', () => {
  const at = (account: string, tier: string, amount: number, description: string): SyncedTx => ({
    sourceTxId: `inv${++n}`, account, tier, posted: T0, amount, description, payee: '', memo: '', mcc: null,
  })
  it('buys, sells and dividends on a brokerage or retirement account are not spending or income', () => {
    const v = (t: SyncedTx) => classifyBankTx(t, new Set())
    expect(v(at('Test Broker Individual Brokerage (7777)', 'brokerage', -1500, 'BUY VTI'))).toEqual({ kind: 'skip', rule: 'investment' })
    expect(v(at('Test Broker Individual Brokerage (7777)', 'brokerage', 2000, 'SELL VTI'))).toEqual({ kind: 'skip', rule: 'investment' })
    expect(v(at('Test Broker Roth IRA (8888)', 'retirement', 12.34, 'DIVIDEND RECEIVED'))).toEqual({ kind: 'skip', rule: 'investment' })
  })
  it('an everyday account mis-tiered by its name keeps its rows', () => {
    const v = (t: SyncedTx) => classifyBankTx(t, new Set()).kind
    expect(v(at('Test Bank Total Checking (4013)', 'retirement', -60, 'CORNER STORE'))).toBe('expense')
    expect(v(at('Test Bank Rewards Visa (2457)', 'retirement', -60, 'CORNER STORE'))).toBe('expense')
  })
})

describe('tier from the account name', () => {
  it('reads the product, not the balance', () => {
    expect(tierFromName('TEST CLIENT CKG PLUS (0002)')).toBe('cash')
    expect(tierFromName('Test Bank Gold Card (0001)')).toBe('credit')
    expect(tierFromName('Test Sapphire Rewards (0003)')).toBe('credit')
    expect(tierFromName('Total Checking (4013)')).toBe('cash')
    expect(tierFromName('Rewards Visa (2457)')).toBe('credit')
    expect(tierFromName('Individual Checking')).toBe('cash')
    expect(tierFromName('Roth IRA')).toBe('retirement')
    expect(tierFromName('401(k) Plan')).toBe('retirement')
    expect(tierFromName('HSA Spending Account')).toBe('benefit')
    expect(tierFromName('Freedom Bank High Yield Savings Account')).toBe('cash')
    expect(tierFromName('Something Else (1234)')).toBeNull()
  })

  it('the name decides; otherwise a card stays a card at $0, and an unknown account follows the bank', () => {
    expect(effectiveTier('TEST CLIENT CKG PLUS (0002)', 'credit', 'cash')).toBe('cash')
    expect(effectiveTier('Mystery (1111)', 'cash', 'credit')).toBe('credit')
    expect(effectiveTier('Mystery (1111)', 'credit', 'cash')).toBe('credit')
    expect(effectiveTier('Mystery (1111)', 'cash', 'cash')).toBe('cash')
    expect(effectiveTier('Mystery (1111)', 'cash', undefined)).toBe('cash')
  })

  it('a balance that went negative once does not make an account a card for good', () => {
    // Stored as credit while it read owing; now in the black with nothing else to go on.
    expect(effectiveTier('Spending Account (4242)', 'cash', 'credit', { balance: 1200 })).toBe('cash')
    // At $0 nothing is said either way: a card paid in full stays a card.
    expect(effectiveTier('Spending Account (4242)', 'cash', 'credit', { balance: 0 })).toBe('credit')
    // Owing now is still read as a card when nothing else says otherwise.
    expect(effectiveTier('Spending Account (4242)', 'credit', 'cash', { balance: -35.5 })).toBe('credit')
  })

  it("the account's own rows decide before its balance; the name before both", () => {
    // Pay lands in a bank account, even an overdrawn one.
    expect(effectiveTier('Spending Account (4242)', 'credit', 'credit', { rows: 'cash', balance: -35.5 })).toBe('cash')
    // A card that is paid off, and now in your favour, is still a card.
    expect(effectiveTier('Mystery Rewards (1111)', 'cash', 'credit', { rows: 'credit', balance: 61.25 })).toBe('credit')
    expect(effectiveTier('Test Bank Gold Card (0001)', 'cash', 'cash', { rows: 'cash' })).toBe('credit')
  })
})

describe("what an account's own rows say", () => {
  const row = (amount: number, description: string): SyncedTx => ({
    sourceTxId: `e${++n}`, account: 'Some Bank Account (9999)', tier: 'cash', posted: T0, amount, description, payee: '', memo: '', mcc: null,
  })

  it('pay, a Zelle received or a deposit make it a bank account', () => {
    expect(tierFromRows([row(-20, 'CORNER STORE'), row(2500, 'ACME PAYROLL')])).toBe('cash')
    expect(tierFromRows([row(2500, 'DIRECT DEP ACME CORP')])).toBe('cash')
    expect(tierFromRows([row(60, 'ZELLE FROM JOHN')])).toBe('cash')
    expect(tierFromRows([row(200, 'MOBILE DEPOSIT')])).toBe('cash')
  })

  it("a payment received makes it a card; a bank account's evidence wins over it", () => {
    expect(tierFromRows([row(-120, 'BIG STORE #12'), row(1500, 'AUTOPAY PAYMENT - THANK YOU')])).toBe('credit')
    expect(tierFromRows([row(1500, 'MOBILE PAYMENT RECEIVED')])).toBe('credit')
    expect(tierFromRows([row(1500, 'PAYMENT THANK YOU'), row(2500, 'ACME PAYROLL')])).toBe('cash')
    // A person paying you through an app is not a card's bill being paid.
    expect(tierFromRows([row(40, 'VENMO PAYMENT RECEIVED')])).toBeNull()
  })

  it('debits, refunds and plain credits say nothing', () => {
    expect(tierFromRows([])).toBeNull()
    expect(tierFromRows([row(-2500, 'ACME PAYROLL'), row(-1500, 'CARD PAYMENT THANK YOU'), row(61.25, 'BIG STORE #12')])).toBeNull()
  })
})

describe('refunds to a debit card', () => {
  const shopping = () => 'Shopping'
  const at = (amount: number, description: string, account = CHECKING): SyncedTx => ({
    sourceTxId: `r${++n}`, account, tier: 'cash', posted: T0, amount, description, payee: '', memo: '', mcc: null,
  })
  const v = (t: SyncedTx, merchantOf: (t: SyncedTx) => string | null = shopping) => classifyBankTx(t, new Set(), new Set(), merchantOf).kind

  it('a merchant refund to checking offsets its category', () => {
    expect(v(at(19.95, 'AMAZON MKTPLACE REFUND'))).toBe('refund')
  })
  it('fee refunds, Zelle, interest, payroll and unknown refunds stay income', () => {
    expect(v(at(2.5, 'ATM Fee Refund'), () => null)).toBe('income')
    expect(v(at(40, 'ZELLE FROM X REFUND'), () => 'Other')).toBe('income')
    expect(v(at(0.12, 'Interest on Deposit - Interest Paid'))).toBe('income')
    expect(v(at(15, 'PAYPAL REFUND'), () => null)).toBe('income')
    expect(v(at(1500, 'ACME PAYROLL'))).toBe('income')
  })
  it('a rent refund is left to the rent matcher', () => {
    expect(v(at(2400, 'ACME PROPERTY MGMT REFUND'), () => 'Rent')).toBe('income')
  })
})

describe('Zelle into savings', () => {
  const at = (amount: number, description: string): SyncedTx => ({
    sourceTxId: `z${++n}`, account: 'Test Bank Money Market (4444)', tier: 'cash', posted: T0, amount, description, payee: '', memo: '', mcc: null,
  })
  it('money received is income; money sent out of savings is still dropped', () => {
    expect(classifyBankTx(at(120, 'Zelle from Jane Doe'), new Set())).toEqual({ kind: 'income' })
    expect(classifyBankTx(at(-900, 'Zelle to John Roe'), new Set())).toEqual({ kind: 'skip', rule: 'zelle-from-savings' })
  })
})

describe('rent refunds find the payment they reverse', () => {
  const RENT_RE = /property mgmt/i
  const isRent = (t: SyncedTx) => RENT_RE.test(`${t.payee} ${t.description}`)
  const at = (id: string, account: string, tier: string, iso: string, amount: number, description: string): SyncedTx => ({
    sourceTxId: id, account, tier, posted: Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), 12) / 1000,
    amount, description, payee: description, memo: '', mcc: null,
  })
  it('matches the latest earlier payment on the same account and payee', () => {
    const rows = [
      at('p1', CHECKING, 'cash', '2026-09-01', -2400, 'ACME PROPERTY MGMT'),
      at('p2', CHECKING, 'cash', '2026-09-26', -2400, 'ACME PROPERTY MGMT'),
      at('r', CHECKING, 'cash', '2026-09-29', 2400, 'ACME PROPERTY MGMT'),
      at('pay', CHECKING, 'cash', '2026-09-29', 2500, 'ACME PAYROLL'),
    ]
    const m = matchRentRefunds(rows, isRent)
    expect([...m]).toEqual([['r', '2026-09-26']])
  })
  it('a credit bigger than the payment, from another account, or too late is not matched', () => {
    const rows = [
      at('p', CHECKING, 'cash', '2026-07-01', -2400, 'ACME PROPERTY MGMT'),
      at('late', CHECKING, 'cash', '2026-08-20', 100, 'ACME PROPERTY MGMT'),
      at('big', CHECKING, 'cash', '2026-07-05', 4000, 'ACME PROPERTY MGMT'),
      at('other', CARD, 'credit', '2026-07-03', 50, 'ACME PROPERTY MGMT'),
    ]
    expect(matchRentRefunds(rows, isRent).size).toBe(0)
  })
})

describe('pending transfers', () => {
  // Two accounts at one bank; the uid carries the bank (as the Edge Function builds it).
  const CHK = 'Test Bank Checking (1111)'
  const MM = 'Test Bank Money Market (4444)'
  const OTHER_BANK = 'Other Bank Savings (7777)'
  const at = (bank: string, id: string, p: Omit<Partial<SyncedTx>, 'sourceTxId'> & Pick<SyncedTx, 'amount' | 'account'>): SyncedTx => ({
    sourceTxId: `${bank}:${p.account}:${id}`, tier: 'cash', posted: T0, description: '', payee: '', memo: '', mcc: null, ...p,
  })
  const read = (all: SyncedTx[]) => {
    const ids = detectTransferIds(all)
    const pend = detectPendingTransferIds(all)
    return all.map((t) => {
      const v = classifyBankTx(t, ids, pend)
      return v.kind === 'skip' ? `skip:${v.rule}` : v.kind
    })
  }

  it('both legs pending at one bank with stand-in text drop, and read again once posted', () => {
    const pair = [
      at('bank.test', 'a', { account: MM, amount: -2000, payee: 'Debit', pending: true }),
      at('bank.test', 'b', { account: CHK, amount: 2000, payee: 'Credit', pending: true }),
    ]
    expect(read(pair)).toEqual(['skip:pending-transfer', 'skip:pending-transfer'])
    // Posted, the same rows say what they are (the pending rule is out of it).
    const posted = [
      { ...pair[0], pending: false, payee: 'To Checking', description: 'TO CHECKING XXXXXX1111' },
      { ...pair[1], pending: false, payee: 'From Checking', description: 'FROM CHECKING XXXXXX4444' },
    ]
    expect(detectPendingTransferIds(posted).size).toBe(0)
    expect(read(posted).every((k) => k.startsWith('skip:'))).toBe(true)
  })

  it('a leg that already says what it is does not make the stand-ins ambiguous', () => {
    const rows = [
      at('bank.test', 'a', { account: MM, amount: -2000, payee: 'Debit', pending: true }),
      at('bank.test', 'b', { account: CHK, amount: 2000, payee: 'Credit', pending: true }),
      at('bank.test', 'c', { account: MM, amount: 2000, payee: 'Online Transfer', pending: true }),
    ]
    expect(read(rows)).toEqual(['skip:pending-transfer', 'skip:pending-transfer', 'skip:money-movement'])
  })

  it('does not guess: two banks, two candidates, or no stand-in text', () => {
    expect(read([
      at('bank.test', 'a', { account: MM, amount: -300, payee: 'Debit', pending: true }),
      at('other.test', 'b', { account: OTHER_BANK, amount: 300, payee: 'Credit', pending: true }),
    ])).toEqual(['expense', 'income'])
    expect(read([
      at('bank.test', 'a', { account: MM, amount: -300, payee: 'Debit', pending: true }),
      at('bank.test', 'b', { account: CHK, amount: -300, payee: 'Debit', pending: true }),
      at('bank.test', 'c', { account: CHK, amount: 300, payee: 'Credit', pending: true }),
    ])).toEqual(['expense', 'expense', 'income'])
    expect(read([
      at('bank.test', 'a', { account: MM, amount: -300, payee: 'CORNER STORE', pending: true }),
      at('bank.test', 'b', { account: CHK, amount: 300, payee: 'ACME PAYROLL', pending: true }),
    ])).toEqual(['expense', 'income'])
  })

  it('a pending leg drops when the posted leg names its account', () => {
    // A weekly sweep: the amount repeats, so the older pair rule cannot pick a partner.
    const sweep = (id: string, daysAgo: number, digits: string) =>
      at('other.test', id, { account: OTHER_BANK, amount: 100, posted: T0 - daysAgo * DAY, description: `Internet Transfer FROM TEST BANK Account ${digits}` })
    const pending = at('bank.test', 'a', { account: MM, amount: -100, payee: 'Other Bank', pending: true })
    expect(read([pending, sweep('b', 3, '4444'), sweep('c', 10, '4444')])).toEqual(['skip:pending-transfer', 'skip:money-movement', 'skip:money-movement'])
    // Naming some other account is not evidence.
    expect(read([pending, sweep('b', 3, '9999'), sweep('c', 10, '9999')])[0]).toBe('expense')
  })

  it('a pending repeat of a move this account already posted drops', () => {
    const history = [
      at('bank.test', 'h1', { account: CHK, amount: -25, posted: T0 - DAY, payee: 'Robinhood', description: 'ROBINHOOD DEBITS' }),
      at('bank.test', 'h2', { account: MM, amount: -75, posted: T0 - 7 * DAY, payee: 'Savings Bank Transfer', description: 'SAVINGS BANK TRANSFER' }),
    ]
    const buy = at('bank.test', 'p1', { account: CHK, amount: -25, payee: 'Robinhood', description: 'ROBINHOOD', pending: true })
    const sweep = at('bank.test', 'p2', { account: MM, amount: -75, payee: 'Savings Bank', pending: true })
    // Same payee, a new amount (a card bill paid to the same company): no history, kept.
    const bill = at('bank.test', 'p3', { account: CHK, amount: -1300, payee: 'Robinhood', description: 'ROBINHOOD', pending: true })
    expect(read([...history, buy, sweep, bill]).slice(2)).toEqual(['skip:pending-transfer', 'skip:pending-transfer', 'expense'])
  })

  it('never touches card rows or posted rows', () => {
    const card = { ...tx({ account: 'Test Bank Rewards Visa (5555)', amount: -40, payee: 'Corner Cafe', pending: true }), sourceTxId: 'bank.test:card:x' }
    const named = at('bank.test', 'y', { account: CHK, amount: 40, description: 'Online Transfer to card 5555' })
    expect(detectPendingTransferIds([card, named]).has(card.sourceTxId)).toBe(false)
    expect(read([
      at('bank.test', 'a', { account: MM, amount: -500, payee: 'Debit' }),
      at('bank.test', 'b', { account: CHK, amount: 500, payee: 'Credit' }),
    ])).toEqual(['expense', 'income'])
  })
})
