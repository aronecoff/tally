import { describe, expect, it } from 'vitest'
import { paceProjector } from './projection'

describe('paceProjector', () => {
  it('does not extrapolate before 20% of the month has passed', () => {
    const p = paceProjector(3, 31) // day 3 of 31 ≈ 9.7%
    expect(p.canProject).toBe(false)
    expect(p.extrapolate(100)).toBe(100) // identity, no forecast
  })

  it('extrapolates flexible spend at the daily pace, whole dollars', () => {
    const p = paceProjector(15, 30) // exactly half the month
    expect(p.canProject).toBe(true)
    expect(p.extrapolate(200)).toBe(400)
    expect(p.extrapolate(101.5)).toBe(203) // rounded, not 203.0…
  })

  describe('fixed monthly bills never extrapolate', () => {
    const p = paceProjector(8, 31) // rent paid on the 1st, viewed on the 8th

    it('a paid bill projects to exactly what was paid', () => {
      // Old behavior: 1550 / (8/31) ≈ 6006 — "on pace to go over" nonsense.
      expect(p.forCategory('Rent', 1550, 1550)).toBe(1550)
    })

    it('an unpaid bill projects to its budgeted amount', () => {
      expect(p.forCategory('Rent', 0, 1550)).toBe(1550)
    })

    it('a partially-paid bill projects to the larger of paid/budget', () => {
      expect(p.forCategory('Subscriptions', 30, 50)).toBe(50)
      expect(p.forCategory('Subscriptions', 80, 50)).toBe(80)
    })

    it('fixed matching is case-insensitive; flexible categories still pace', () => {
      expect(p.forCategory('rent', 1550, 1550)).toBe(1550)
      expect(p.forCategory('Groceries', 100, 600)).toBe(Math.round(100 / (8 / 31)))
    })
  })

  describe('monthEnd = known fixed bills + paced flexible remainder', () => {
    it('reproduces the hand-verified July scenario', () => {
      // Day 27 of 31. Subs $50 budget unspent, Health $100 budget unspent,
      // flexible spend $108.60 → 150 + round(108.60 / (27/31)) = 150 + 125.
      const p = paceProjector(27, 31)
      const cats = [
        { name: 'Subscriptions', spent: 0, budget: 50 },
        { name: 'Health', spent: 0, budget: 100 },
        { name: 'Groceries', spent: 88.1, budget: 600 },
        { name: 'Dining', spent: 20.5, budget: 300 },
      ]
      expect(p.monthEnd(cats, 108.6)).toBe(275)
    })

    it('uncategorized spend (beyond the rows) is treated as flexible', () => {
      const p = paceProjector(15, 30)
      const cats = [{ name: 'Rent', spent: 1000, budget: 1000 }]
      // totalSpend 1200 = 1000 rent + 200 uncategorized → 1000 + 200*2
      expect(p.monthEnd(cats, 1200)).toBe(1400)
    })

    it('a paid fixed bill is not double-paced through the total', () => {
      const p = paceProjector(10, 30)
      const cats = [{ name: 'Rent', spent: 1500, budget: 1500 }]
      // All spend is the rent: flexible remainder is 0, projection is the rent.
      expect(p.monthEnd(cats, 1500)).toBe(1500)
    })

    it('past months (dayOfMonth = daysInMonth) report actuals unchanged', () => {
      const p = paceProjector(30, 30)
      expect(p.extrapolate(123.45)).toBe(123) // frac 1 → rounds only
      expect(p.monthEnd([{ name: 'Rent', spent: 1500, budget: 1500 }], 1800)).toBe(1800)
    })
  })
})
