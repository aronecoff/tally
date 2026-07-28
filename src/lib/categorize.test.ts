import { describe, expect, it } from 'vitest'
import { guessCategoryName, isFixedCategory } from './categorize'

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

  it('keeps expense text out of income categories', () => {
    // "paypal" contains "pay" — must not become Salary/Freelance.
    const guess = guessCategoryName('paypal coffee shop', 'expense')
    expect(guess === 'Salary' || guess === 'Freelance').toBe(false)
  })

  it('returns null when nothing matches', () => {
    expect(guessCategoryName('zzqx 9921')).toBeNull()
  })
})
