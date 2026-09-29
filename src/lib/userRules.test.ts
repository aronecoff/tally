// @vitest-environment jsdom
/**
 * The user's own categorization rules, merged with the built-ins by priority.
 * Every merchant here is invented: personal rules never appear in this repo.
 *
 * Built-in expense priorities: Rent 10, Groceries 20, Dining 30, Transport 40,
 * Subscriptions 50, Rogue 60, Health 70, Shopping 80, Fun 90, Apple 100,
 * Pay-in-4 110, card bill 180, Zelle/ATM 190. Income: 10, 20, 30.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { categorize, guessCategoryName } from './categorize'
import { clearUserRules, getUserRules, setUserRules, userRulesReady, type UserRuleRow } from './userRules'

const CACHE_KEY = 'tally:merchantRules:v1'
const rule = (over: Partial<UserRuleRow> & { pattern: string; category: string; priority: number }): UserRuleRow => ({
  flags: 'i',
  kind: 'expense',
  ...over,
})

afterEach(() => {
  clearUserRules()
  localStorage.clear()
})

describe('compiling user rules', () => {
  it('skips an invalid pattern and keeps the rest', () => {
    setUserRules([
      rule({ pattern: '(unclosed', category: 'Dining', priority: 35 }),
      rule({ pattern: 'zorblatt', category: 'Dining', priority: 35 }),
    ])
    expect(getUserRules()).toHaveLength(1)
    expect(guessCategoryName('ZORBLATT NOODLE HOUSE', 'expense')).toBe('Dining')
  })

  it('strips the stateful g and y flags, so the same text matches every time', () => {
    setUserRules([rule({ pattern: 'zorblatt', flags: 'gyi', category: 'Dining', priority: 35 })])
    expect(getUserRules()[0].match.flags).toBe('i')
    for (let i = 0; i < 3; i++) expect(guessCategoryName('ZORBLATT NOODLE HOUSE', 'expense')).toBe('Dining')
  })

  it('skips rows with an unknown kind or no category', () => {
    setUserRules([
      rule({ pattern: 'zorblatt', category: 'Dining', priority: 35, kind: 'transfer' }),
      rule({ pattern: 'zorblatt', category: ' ', priority: 35 }),
    ])
    expect(getUserRules()).toHaveLength(0)
    expect(guessCategoryName('ZORBLATT NOODLE HOUSE', 'expense')).toBeNull()
  })
})

describe('priority merge with the built-in rules', () => {
  it('a priority-5 rule wins before every built-in', () => {
    // Without the rule the Groceries built-in (20) files it.
    expect(guessCategoryName('ACME PROPERTIES SAFEWAY PLAZA', 'expense')).toBe('Groceries')
    setUserRules([rule({ pattern: 'acme ?properties', category: 'Rent', priority: 5 })])
    expect(guessCategoryName('ACME PROPERTIES SAFEWAY PLAZA', 'expense')).toBe('Rent')
    expect(guessCategoryName('AcmeProperties LLC', 'expense')).toBe('Rent')
  })

  it('a priority-35 rule sits between Dining and Transport', () => {
    setUserRules([rule({ pattern: 'zorblatt', category: 'Dining', priority: 35 })])
    expect(guessCategoryName('ZORBLATT', 'expense')).toBe('Dining')
    // Groceries (20) still comes first...
    expect(guessCategoryName('ZORBLATT SAFEWAY', 'expense')).toBe('Groceries')
    // ...but the rule beats Transport (40), which alone would take "parking".
    expect(guessCategoryName('ZORBLATT PARKING', 'expense')).toBe('Dining')
  })

  it('on a tie the user rule wins', () => {
    setUserRules([rule({ pattern: 'whole ?foods', category: 'Shopping', priority: 20 })])
    expect(guessCategoryName('WHOLE FOODS MARKET', 'expense')).toBe('Shopping')
  })

  it('an income rule never applies to an expense', () => {
    setUserRules([rule({ pattern: 'acme ?payout', category: 'Freelance', kind: 'income', priority: 5 })])
    expect(guessCategoryName('ACME PAYOUT', 'expense')).toBeNull()
    expect(guessCategoryName('ACME PAYOUT', 'income')).toBe('Freelance')
    // A hand-typed note (no kind) tries expense rules first, then income.
    expect(guessCategoryName('ACME PAYOUT')).toBe('Freelance')
    // Income rules merge by priority too: 5 beats the built-in Salary (20).
    expect(guessCategoryName('ACME PAYOUT PAYROLL', 'income')).toBe('Freelance')
  })

  it('the MCC still decides first for an expense', () => {
    setUserRules([rule({ pattern: 'zorblatt', category: 'Dining', priority: 35 })])
    expect(categorize({ description: 'ZORBLATT', mcc: '5411', kind: 'expense' })).toBe('Groceries')
    expect(categorize({ description: 'ZORBLATT', mcc: null, kind: 'expense' })).toBe('Dining')
  })

  it('clearUserRules restores the built-ins alone', () => {
    setUserRules([rule({ pattern: 'zorblatt', category: 'Dining', priority: 35 })])
    expect(userRulesReady()).toBe(true)
    clearUserRules()
    expect(userRulesReady()).toBe(false)
    expect(getUserRules()).toHaveLength(0)
    expect(guessCategoryName('ZORBLATT', 'expense')).toBeNull()
    expect(guessCategoryName('ZORBLATT PARKING', 'expense')).toBe('Transport')
    expect(localStorage.getItem(CACHE_KEY)).toBeNull()
  })
})

describe('the device cache', () => {
  it('round-trips through localStorage into a fresh load', async () => {
    setUserRules([rule({ pattern: 'zorblatt', category: 'Dining', priority: 35 })])
    expect(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]')).toHaveLength(1)

    vi.resetModules()
    const fresh = await import('./userRules')
    const freshCategorize = await import('./categorize')
    expect(fresh.userRulesReady()).toBe(true)
    expect(fresh.getUserRules().map((r) => [r.category, r.priority])).toEqual([['Dining', 35]])
    expect(freshCategorize.guessCategoryName('ZORBLATT PARKING', 'expense')).toBe('Dining')
  })

  it('an empty rule set from the server still counts as ready', async () => {
    setUserRules([])
    vi.resetModules()
    const fresh = await import('./userRules')
    expect(fresh.userRulesReady()).toBe(true)
    expect(fresh.getUserRules()).toHaveLength(0)
  })

  it('a corrupt cache starts empty and not ready', async () => {
    localStorage.setItem(CACHE_KEY, '{not json')
    vi.resetModules()
    const fresh = await import('./userRules')
    expect(fresh.userRulesReady()).toBe(false)
    expect(fresh.getUserRules()).toHaveLength(0)
  })
})
