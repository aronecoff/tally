import { describe, expect, it } from 'vitest'
import { flexibleSpend, isLump, oneOffRows, paceProjector, type OneOffRow } from './projection'
import { rowState } from './copy'

/** An invented expense row (positive = a purchase, negative = a refund). */
const row = (date: string, amount: number, note: string): OneOffRow => ({ date, amount, type: 'expense', note })
const sumOf = (rows: Iterable<OneOffRow>) => [...rows].reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100

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

  describe('the last day of the month', () => {
    it('reports what was spent: an unpaid fixed budget is no longer coming', () => {
      const p = paceProjector(30, 30)
      const cats = [
        { name: 'Rent', spent: 1000, budget: 1000 },
        { name: 'Subscriptions', spent: 40, budget: 100 },
        { name: 'Health', spent: 0, budget: 50 },
        { name: 'Dining', spent: 200, budget: 300 },
      ]
      expect(p.monthEnd(cats, 1240)).toBe(1240)
      expect(p.forCategory('Subscriptions', 40, 100)).toBe(40)
    })

    it('the day before, an unpaid fixed bill still counts at its budget', () => {
      const p = paceProjector(29, 30)
      expect(p.monthEnd([{ name: 'Health', spent: 0, budget: 50 }], 290)).toBe(50 + Math.round(290 / (29 / 30)))
    })
  })

  describe('one-off lumps count once', () => {
    it('a single flexible row of $500 or more is not paced', () => {
      const p = paceProjector(22, 30)
      const cats = [
        { name: 'Rent', spent: 2875, budget: 2875 },
        { name: 'Other', spent: 1234.56 + 100, budget: 0, lump: 1234.56 },
        { name: 'Dining', spent: 220, budget: 300 },
      ]
      const total = 2875 + 1234.56 + 100 + 220
      // round(2875 + 1234.56 + 320 / (22/30)) = round(4545.92): the lump once, the forecast in whole dollars.
      expect(p.monthEnd(cats, total)).toBe(4546)
      expect(p.forCategory('Other', 1334.56, 0, { lump: 1234.56 })).toBe(Math.round(1234.56 + 100 / (22 / 30)))
    })

    it('a large refund is not paced negative; a fixed bill is never counted twice', () => {
      const p = paceProjector(15, 30)
      expect(p.monthEnd([{ name: 'Shopping', spent: -600 + 100, budget: 400, lump: -600 }], -500)).toBe(-600 + 200)
      expect(p.monthEnd([{ name: 'Rent', spent: 2400, budget: 2400, lump: 2400 }], 2400)).toBe(2400)
      expect(isLump(500)).toBe(true)
      expect(isLump(-600)).toBe(true)
      expect(isLump(499.99)).toBe(false)
    })

    it('uncategorized lumps count once too', () => {
      const p = paceProjector(15, 30)
      expect(p.monthEnd([], 900, 800)).toBe(800 + 200)
    })
  })

  describe('a fixed flag that survives a rename', () => {
    it('a renamed rent still projects as a known bill', () => {
      const p = paceProjector(7, 31)
      expect(p.forCategory('Housing', 2400, 2400, { fixed: true })).toBe(2400)
      expect(p.monthEnd([{ name: 'Housing', spent: 2400, budget: 2400, fixed: true }], 2400)).toBe(2400)
      // Without the flag the name decides, as before.
      expect(p.forCategory('Housing', 2400, 2400)).toBe(Math.round(2400 / (7 / 31)))
    })
  })

  describe('refunds count once', () => {
    // Day 7 of 30: two $40 purchases and a $212.60 refund of last month's order.
    const p = paceProjector(7, 30)
    const sep = [row('2026-09-01', -212.60, 'BIG STORE'), row('2026-09-02', 40, 'BIG STORE'), row('2026-09-05', 40, 'CORNER SHOP')]

    it('a refund lowers the forecast by its own amount, to the dollar', () => {
      const once = oneOffRows(sep, [], '2026-09')
      expect([...once].map((t) => t.amount)).toEqual([-212.60])
      const withRefund = p.forCategory('Shopping', 80 - 212.60, 400, { lump: sumOf(once) })
      const without = p.forCategory('Shopping', 80, 400)
      expect(without).toBe(Math.round(80 / (7 / 30)))
      // round(−212.60 + 342.86) = 130. The old pacing read −132.60 / (7/30) ≈ −$568 for the month.
      expect(withRefund).toBe(130)
      expect(Math.abs(without - withRefund - 212.6)).toBeLessThan(1)
    })

    it('the month-end total takes it once too, small refunds included', () => {
      const once = oneOffRows([...sep, row('2026-09-03', -6.25, 'BIG STORE')], [], '2026-09')
      expect(sumOf(once)).toBe(-218.85)
      const cats = [{ name: 'Shopping', spent: 80 - 218.85, budget: 400, lump: sumOf(once) }]
      // round(−218.85 + 80 / (7/30)) = round(124.01)
      expect(p.monthEnd(cats, 80 - 218.85)).toBe(124)
    })
  })

  describe('a monthly bill counts once', () => {
    // A car payment on the 1st of every month, in a flexible category.
    const history = [
      row('2026-07-01', 318.40, 'ACME MOTORS #12'),
      row('2026-08-01', 318.40, 'ACME MOTORS #34'),
      row('2026-08-14', 9.5, 'CITY PARKING'),
    ]
    const sep = [row('2026-09-01', 318.40, 'ACME MOTORS #56'), row('2026-09-04', 11.60, 'CITY PARKING')]

    it('on day 7 the bill is taken at face value and only the rest is paced', () => {
      const once = oneOffRows(sep, history, '2026-09')
      expect([...once].map((t) => t.note)).toEqual(['ACME MOTORS #56'])
      const p = paceProjector(7, 30)
      const lump = sumOf(once)
      // round(318.40 + 11.60 / (7/30)) = round(368.11), not round(330 / (7/30)) = 1,414.
      expect(p.forCategory('Transport', 330, 600, { lump })).toBe(368)
      expect(p.monthEnd([{ name: 'Transport', spent: 330, budget: 600, lump }], 330)).toBe(368)
    })

    it('needs the same merchant at about the same amount in two of the last three months', () => {
      // Seen in one earlier month only, on another day of the month.
      expect(oneOffRows(sep, [row('2026-08-12', 318.40, 'ACME MOTORS')], '2026-09').size).toBe(0)
      // A different amount each month is not the same bill.
      const drift = [row('2026-07-01', 120, 'ACME MOTORS'), row('2026-08-01', 180, 'ACME MOTORS')]
      expect(oneOffRows(sep, drift, '2026-09').size).toBe(0)
      // Within a quarter of the amount it is.
      const close = [row('2026-07-01', 300, 'ACME MOTORS'), row('2026-08-01', 340, 'ACME MOTORS')]
      expect(oneOffRows(sep, close, '2026-09').size).toBe(1)
      // Rows older than three months, or in the month itself, are not history.
      const stale = [row('2026-04-01', 318.40, 'ACME MOTORS'), row('2026-05-01', 318.40, 'ACME MOTORS'), row('2026-09-01', 318.40, 'ACME MOTORS')]
      expect(oneOffRows(sep, stale, '2026-09').size).toBe(0)
    })

    it('or in one earlier month, on about the same day of the month', () => {
      // A bank history that starts last month: the 1st both times.
      expect(oneOffRows(sep, [row('2026-08-01', 318.40, 'ACME MOTORS')], '2026-09').size).toBe(1)
      expect(oneOffRows(sep, [row('2026-08-04', 318.40, 'ACME MOTORS')], '2026-09').size).toBe(1)
      expect(oneOffRows(sep, [row('2026-08-05', 318.40, 'ACME MOTORS')], '2026-09').size).toBe(0)
      // Billed at the end of the month, whatever its length.
      const late = [row('2026-09-30', 60, 'CITY POWER')]
      expect(oneOffRows(late, [row('2026-08-31', 55, 'CITY POWER')], '2026-09').size).toBe(1)
      // Same day, different amount: not the same bill.
      expect(oneOffRows(sep, [row('2026-08-01', 120, 'ACME MOTORS')], '2026-09').size).toBe(0)
    })

    it('a merchant charged several times a month is everyday spending, not a bill', () => {
      const coffee = [
        row('2026-07-02', 5.75, 'CORNER CAFE'), row('2026-07-09', 5.75, 'CORNER CAFE'),
        row('2026-08-03', 5.75, 'CORNER CAFE'), row('2026-08-10', 5.75, 'CORNER CAFE'),
      ]
      expect(oneOffRows([row('2026-09-02', 5.75, 'CORNER CAFE')], coffee, '2026-09').size).toBe(0)
    })

    it('only one charge a month is the bill; a second one is paced', () => {
      const twice = [...sep, row('2026-09-05', 318.40, 'ACME MOTORS #56')]
      const once = oneOffRows(twice, history, '2026-09')
      expect([...once].map((t) => t.date)).toEqual(['2026-09-01'])
    })

    it('income, deleted rows and refunds in the history are not charges', () => {
      const noise: OneOffRow[] = [
        { ...row('2026-07-01', 318.40, 'ACME MOTORS'), type: 'income' },
        { ...row('2026-08-01', 318.40, 'ACME MOTORS'), deleted: true },
        row('2026-08-02', -318.40, 'ACME MOTORS'),
      ]
      expect(oneOffRows(sep, noise, '2026-09').size).toBe(0)
    })

    it('a row of $500 or more is still a one-off, with or without history', () => {
      const once = oneOffRows([row('2026-09-03', 1234.56, 'BIG STORE'), row('2026-09-04', -600, 'BIG STORE')], [], '2026-09')
      expect(sumOf(once)).toBe(634.56)
    })
  })

  describe('a forecast rounds as a whole, and is exact when nothing is left to forecast', () => {
    // A monthly bill with cents (the 1st of the two months before) in a $400 flexible budget.
    const history = [row('2026-07-01', 87.35, 'ACME MOTORS'), row('2026-08-01', 87.35, 'ACME MOTORS')]
    const sep = [row('2026-09-01', 87.35, 'ACME MOTORS'), row('2026-09-12', 312.55, 'FUEL STOP')]
    const spent = 399.9 // $0.10 under budget at month-end
    const lump = sumOf(oneOffRows(sep, history, '2026-09'))

    it('on the last day a budget that finished under it is not likely to go over', () => {
      expect(lump).toBe(87.35)
      const p = paceProjector(30, 30)
      // Before: 87.35 + round(312.55) = 400.35, over a $400 budget that was not spent.
      const projected = p.forCategory('Transport', spent, 400, { lump })
      expect(projected).toBe(spent)
      expect(rowState({ spent, limit: 400, projected, isCurrent: true })).not.toBe('pace')
      expect(p.monthEnd([{ name: 'Transport', spent, budget: 400, lump }], spent)).toBe(spent)
      expect(p.flexEnd(spent, lump)).toBe(spent)
    })

    it('mid-month the whole forecast is whole dollars, one-offs included', () => {
      const p = paceProjector(13, 30)
      const projected = p.forCategory('Transport', spent, 400, { lump })
      expect(Number.isInteger(projected)).toBe(true)
      expect(projected).toBe(Math.round(87.35 + 312.55 / (13 / 30)))
      expect(Number.isInteger(p.monthEnd([{ name: 'Rent', spent: 1234.56, budget: 1234.56 }, { name: 'Transport', spent, budget: 400, lump }], 1234.56 + spent))).toBe(true)
    })

    it('a month made only of one-offs forecasts what is in, to the cent', () => {
      const p = paceProjector(13, 30)
      // Nothing paced: rounding $87.35 up or down would only move it across a cents budget.
      expect(p.forCategory('Transport', 87.35, 87.4, { lump: 87.35 })).toBe(87.35)
      expect(rowState({ spent: 87.35, limit: 87.4, projected: p.forCategory('Transport', 87.35, 87.4, { lump: 87.35 }), isCurrent: true })).not.toBe('pace')
      // An unpaid fixed bill still counts at its budget.
      expect(p.monthEnd([{ name: 'Rent', spent: 0, budget: 1500 }, { name: 'Transport', spent: 87.35, budget: 400, lump: 87.35 }], 87.35)).toBe(1587.35)
    })

    it('too early to pace, a category is exactly what was spent (no float residue)', () => {
      const p = paceProjector(3, 31)
      // 50.34 + (307.41 − 50.34) is 307.4100000000001 in floating point: 'pace' at exactly the budget.
      const projected = p.forCategory('Dining', 307.41, 307.41, { lump: 50.34 })
      expect(projected).toBe(307.41)
      expect(rowState({ spent: 307.41, limit: 307.41, projected, isCurrent: true })).not.toBe('pace')
    })
  })

  describe('flexibleSpend', () => {
    it('is the spend outside fixed bills (uncategorized counts as flexible)', () => {
      expect(flexibleSpend([{ name: 'Rent', spent: 2400, budget: 2400 }, { name: 'Shopping', spent: 101.92, budget: 1150 }], 2501.92)).toBeCloseTo(101.92, 6)
      expect(flexibleSpend([{ name: 'Housing', spent: 2400, budget: 0, fixed: true }], 2550)).toBe(150)
    })
  })
})

