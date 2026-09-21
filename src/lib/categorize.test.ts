import { describe, expect, it } from 'vitest'
import { categorize, guessCategoryName, isFixedCategory } from './categorize'

describe('isFixedCategory', () => {
  it('matches the fixed set case-insensitively', () => {
    expect(isFixedCategory('Rent')).toBe(true)
    expect(isFixedCategory('rent')).toBe(true)
    expect(isFixedCategory('Subscriptions')).toBe(true)
    expect(isFixedCategory('Health')).toBe(true)
    expect(isFixedCategory('Groceries')).toBe(false)
    expect(isFixedCategory('Dining')).toBe(false)
  })
})

describe('guessCategoryName', () => {
  it('maps common merchants to their categories', () => {
    expect(guessCategoryName("trader joe's")).toBe('Groceries')
    expect(guessCategoryName('netflix')).toBe('Subscriptions')
    expect(guessCategoryName('uber ride downtown')).toBe('Transport')
  })

  it('does not let a bank\u2019s \u201cPaid Early\u201d tag turn interest into Salary', () => {
    // Some banks append "Paid Early" to deposits, so a bare \\bpaid\\b in the
    // Salary rule captured interest and insurance reimbursements as wages.
    expect(guessCategoryName('Deposit Interest Paid', 'income')).toBe('Other income')
    expect(guessCategoryName('Acme Insurance Claim Payment Paid Early', 'income')).not.toBe('Salary')
    // Real payroll still lands in Salary on its own keyword.
    expect(guessCategoryName('Acme Corp Payroll Paid Early', 'income')).toBe('Salary')
  })

  it('files an annual membership under Subscriptions, not Health', () => {
    // The bank sends the merchant as one word; the normalized payee has a space.
    expect(guessCategoryName('ANNUALMEMBERSHIP INC')).toBe('Subscriptions')
    expect(guessCategoryName('Annual Membership')).toBe('Subscriptions')
    // Must not be pulled into Health by the 'fitness' keyword that follows it.
    expect(categorize({ payee: 'Annual Membership', description: 'ANNUALMEMBERSHIP INC', kind: 'expense' })).toBe('Subscriptions')
  })

  it('keeps expense text out of income categories', () => {
    // "paypal" contains "pay" — must not become Salary/Freelance.
    const guess = guessCategoryName('paypal coffee shop', 'expense')
    expect(guess === 'Salary' || guess === 'Freelance').toBe(false)
  })

  it('returns null when nothing matches', () => {
    expect(guessCategoryName('zzqx 9921')).toBeNull()
  })
})
