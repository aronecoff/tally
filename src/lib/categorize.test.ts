import { describe, expect, it } from 'vitest'
import { builtInKey, categorize, findCategoryFor, guessCategoryName, isFixed, isFixedCategory, isRentCategory } from './categorize'

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

describe('the built-in Rent rule', () => {
  const exp = (description: string, mcc: string | null = null) => categorize({ description, mcc, kind: 'expense' })

  it('car rentals are Transport, not Rent', () => {
    for (const d of ['ENTERPRISE RENT-A-CAR', 'HERTZ RENT-A-CAR', 'AVIS RENT A CAR', 'BUDGET RENT A CAR', 'SIXT RENT A CAR', 'ALAMO RENT A CAR', 'NATIONAL CAR RENTAL']) {
      expect(exp(d)).toBe('Transport')
    }
    expect(exp('ENTERPRISE RENT-A-CAR', '7512')).toBe('Transport')
    expect(exp('SOME AGENCY', '7513')).toBe('Transport')
    expect(exp('SOME AGENCY', '3405')).toBe('Transport') // car-rental MCC range 3351-3441
  })

  it('Alamo Drafthouse is a cinema, not a car rental', () => {
    expect(exp('ALAMO RENT A CAR')).toBe('Transport')
    expect(exp('ALAMO DRAFTHOUSE CINEMA')).toBe('Fun')
    expect(exp('ALAMO DRAFTHOUSE NEW MISSION')).not.toBe('Transport')
  })

  it('clothing and furniture rental are Shopping; listings and car leases are not Rent', () => {
    expect(exp('RENT THE RUNWAY')).toBe('Shopping')
    expect(exp('RENT-A-CENTER')).toBe('Shopping')
    expect(exp('APARTMENTS.COM')).not.toBe('Rent')
    expect(exp('TESLA LEASING')).not.toBe('Rent')
    expect(exp('TOYOTA LEASING PMT')).not.toBe('Rent')
  })

  it('real rent still files as Rent', () => {
    for (const d of ['BILT RENT', 'ACME PROPERTY MGMT', 'PAYLEASE MY LANDLORD', 'AVALON APARTMENTS', 'PARKMERCED APARTMENTS', 'OAK LEASING OFFICE', 'RENT PAYMENT']) {
      expect(exp(d)).toBe('Rent')
    }
  })
})

describe('built-in categories survive a rename', () => {
  const cats = [
    { id: 1, name: 'Housing', key: 'rent', kind: 'expense' as const },
    { id: 2, name: 'Software', key: 'subscriptions', kind: 'expense' as const },
    { id: 3, name: 'Coffee', kind: 'expense' as const },
    { id: 4, name: 'Groceries', kind: 'expense' as const },
    { id: 5, name: 'Other income', key: 'other income', kind: 'income' as const },
  ]

  it('builtInKey names the seeded set only', () => {
    expect(builtInKey('Rent')).toBe('rent')
    expect(builtInKey(' Other income ')).toBe('other income')
    expect(builtInKey('Housing')).toBeUndefined()
  })

  it('fixed follows the flag, then the key, then the name', () => {
    expect(isFixed(cats[0])).toBe(true)
    expect(isFixed(cats[1])).toBe(true)
    expect(isFixed(cats[2])).toBe(false)
    expect(isFixed({ name: 'Rent' })).toBe(true)
    expect(isFixed({ name: 'Housing', key: 'rent', fixed: false })).toBe(false)
    expect(isFixed({ name: 'Gym', fixed: true })).toBe(true)
  })

  it('a rule result finds the renamed category by its key, then by name, kind-matched', () => {
    expect(findCategoryFor('Rent', 'expense', cats)?.id).toBe(1)
    expect(findCategoryFor('Subscriptions', 'expense', cats)?.id).toBe(2)
    expect(findCategoryFor('groceries', 'expense', cats)?.id).toBe(4)
    expect(findCategoryFor('Other income', 'expense', cats)).toBeUndefined()
    expect(findCategoryFor('Other income', 'income', cats)?.id).toBe(5)
    expect(findCategoryFor(null, 'expense', cats)).toBeUndefined()
  })

  it('rent is the category keyed rent, or named Rent when it has no key', () => {
    expect(isRentCategory(cats[0])).toBe(true)
    expect(isRentCategory({ name: 'Rent' })).toBe(true)
    expect(isRentCategory({ name: 'Rent', key: 'other' })).toBe(false)
    expect(isRentCategory(cats[2])).toBe(false)
  })
})
