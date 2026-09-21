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

  it('does not let Citizens\u2019 \u201cPaid Early\u201d tag turn interest into Salary', () => {
    // Citizens appends "Citizens Paid Early" to deposits, so a bare \\bpaid\\b in the
    // Salary rule captured interest and insurance reimbursements as wages.
    expect(guessCategoryName('Interest on Deposit - Interest Paid', 'income')).toBe('Other income')
    expect(guessCategoryName('Fetch Insurance Services Payment Citizens Paid Early', 'income')).not.toBe('Salary')
    // Real payroll still lands in Salary on its own keyword.
    expect(guessCategoryName('Karuna Adv Payroll Citizens Paid Early', 'income')).toBe('Salary')
  })

  it('files the Oura membership under Subscriptions, not Health', () => {
    // The bank sends the merchant as one word; the normalized payee has a space.
    expect(guessCategoryName('OURARING INC SAN FRANCISCO CA')).toBe('Subscriptions')
    expect(guessCategoryName('Oura Ring')).toBe('Subscriptions')
    // Must not be pulled into Health by the 'fitness' keyword that follows it.
    expect(categorize({ payee: 'Oura Ring', description: 'OURARING INC SAN FRANCISCO CA', kind: 'expense' })).toBe('Subscriptions')
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
