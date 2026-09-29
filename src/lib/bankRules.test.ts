/**
 * Card credits: a payment to the card is money movement, a merchant giving
 * money back is a refund. Every card credit used to be skipped, so refunds never
 * reached Tally and card spending read high by each one. The guard that matters
 * most runs the other way: a payment must never be read as a refund, because
 * that would erase a month of spending. Descriptors below are the issuers'
 * public wording; accounts and amounts are made up.
 */
import { describe, expect, it } from 'vitest'
import { CARD_CREDIT_NOT_REFUND_RE, classifyBankTx, detectPendingTransferIds, detectTransferIds, rentDate, type SyncedTx } from './bankRules'

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

describe('rent paid early', () => {
  it('the last week of a month counts on the 1st of the next', () => {
    expect(rentDate('2026-09-28')).toBe('2026-10-01')
    expect(rentDate('2026-09-24')).toBe('2026-10-01') // 30-day month: the 24th starts the last week
    expect(rentDate('2026-07-31')).toBe('2026-08-01')
    expect(rentDate('2026-08-25')).toBe('2026-09-01') // 31-day month: the 25th starts it
    expect(rentDate('2026-02-22')).toBe('2026-03-01')
    expect(rentDate('2026-12-29')).toBe('2027-01-01')
  })

  it('anything earlier stays where it was paid', () => {
    expect(rentDate('2026-09-23')).toBe('2026-09-23')
    expect(rentDate('2026-08-24')).toBe('2026-08-24')
    expect(rentDate('2026-10-01')).toBe('2026-10-01')
    expect(rentDate('2026-10-15')).toBe('2026-10-15')
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
