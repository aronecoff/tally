/**
 * Card credits: a payment to the card is money movement, a merchant giving
 * money back is a refund. Every card credit used to be skipped, so refunds never
 * reached Tally and card spending read high by each one. The guard that matters
 * most runs the other way: a payment must never be read as a refund, because
 * that would erase a month of spending. Descriptors below are the issuers'
 * public wording; accounts and amounts are made up.
 */
import { describe, expect, it } from 'vitest'
import { CARD_CREDIT_NOT_REFUND_RE, classifyBankTx, detectTransferIds, rentDate, type SyncedTx } from './bankRules'

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
