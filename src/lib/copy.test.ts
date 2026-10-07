import { describe, expect, it } from 'vitest'
import { beforePayday, budgetStatus, GLOSSARY, NO_INCOME_YET, NO_PAY_YET, rowState, type BudgetStatusInput } from './copy'

describe('rowState (verbatim Dashboard thresholds)', () => {
  const base = { spent: 0, limit: 500, projected: 0, isCurrent: true }

  it('none when there is no budget', () => {
    expect(rowState({ ...base, limit: 0, spent: 120 })).toBe('none')
    expect(rowState({ ...base, limit: -1 })).toBe('none')
  })

  it('over once spent passes the budget', () => {
    expect(rowState({ ...base, spent: 500.01, projected: 900 })).toBe('over')
    expect(rowState({ ...base, spent: 600, isCurrent: false })).toBe('over')
  })

  it('pace only in the live month, when the projection passes the budget', () => {
    expect(rowState({ ...base, spent: 300, projected: 520 })).toBe('pace')
    expect(rowState({ ...base, spent: 300, projected: 520, isCurrent: false })).toBe('ok')
  })

  it('near at 85% of the budget, except for fixed bills', () => {
    expect(rowState({ ...base, spent: 425, projected: 480 })).toBe('near')
    expect(rowState({ ...base, spent: 424.99, projected: 480 })).toBe('ok')
    expect(rowState({ ...base, spent: 500, projected: 500, fixed: true })).toBe('ok')
    expect(rowState({ ...base, spent: 500, projected: 500 })).toBe('near')
  })

  it('ok otherwise', () => {
    expect(rowState({ ...base, spent: 100, projected: 300 })).toBe('ok')
  })
})

describe('budgetStatus', () => {
  const s = (o: Partial<BudgetStatusInput>): BudgetStatusInput => ({
    name: 'Dining',
    spent: 0,
    limit: 500,
    projected: 0,
    canProject: true,
    state: 'ok',
    isUncategorized: false,
    txnCount: 3,
    pendingCount: 0,
    fixed: false,
    ...o,
  })

  it('ok: what is left, trimmed when whole', () => {
    expect(budgetStatus(s({ spent: 150, state: 'ok' }))).toEqual({ text: '$350 left', tone: 'muted' })
    expect(budgetStatus(s({ spent: 150.5, state: 'ok' }))).toEqual({ text: '$349.50 left', tone: 'muted' })
  })

  it('fixed and exactly paid: Paid', () => {
    expect(budgetStatus(s({ name: 'Rent', spent: 2875, limit: 2875, state: 'ok', fixed: true }))).toEqual({
      text: 'Paid',
      tone: 'muted',
    })
    // A fixed bill not yet paid in full still reads what is left.
    expect(budgetStatus(s({ name: 'Rent', spent: 0, limit: 2875, state: 'ok', fixed: true })).text).toBe('$2,875 left')
  })

  it('near: Only $X left, exact', () => {
    expect(budgetStatus(s({ spent: 450, state: 'near' }))).toEqual({ text: 'Only $50.00 left', tone: 'near' })
  })

  it('pace: ~$X by month-end in whole dollars', () => {
    expect(budgetStatus(s({ spent: 300, projected: 612.4, state: 'pace' }))).toEqual({
      text: '~$612 by month-end',
      tone: 'near',
    })
  })

  it('over: $X over, exact', () => {
    expect(budgetStatus(s({ spent: 1742.58, limit: 400, state: 'over' }))).toEqual({
      text: '$1,342.58 over',
      tone: 'over',
    })
  })

  it('named with no budget: No budget · n transaction(s)', () => {
    expect(budgetStatus(s({ limit: 0, spent: 12, state: 'none', txnCount: 1 })).text).toBe('No budget · 1 transaction')
    expect(budgetStatus(s({ limit: 0, spent: 40, state: 'none', txnCount: 4 })).text).toBe('No budget · 4 transactions')
  })

  it('refunds bigger than the purchases: the budget is left, and what came back is said', () => {
    expect(budgetStatus(s({ spent: -176, limit: 1150, state: 'ok' }))).toEqual({ text: '$1,150 left · $176.00 back', tone: 'muted' })
    // A category with no budget keeps its own line.
    expect(budgetStatus(s({ spent: -12, limit: 0, state: 'none', txnCount: 2 })).text).toBe('No budget · 2 transactions')
  })

  it('uncategorized with posted charges: n to categorize (pending excluded)', () => {
    expect(
      budgetStatus(s({ name: 'Uncategorized', limit: 0, state: 'none', isUncategorized: true, txnCount: 6, pendingCount: 2 })),
    ).toEqual({ text: '4 to categorize', tone: 'muted' })
  })

  it('uncategorized with every charge pending: categorize once posted', () => {
    expect(
      budgetStatus(s({ name: 'Uncategorized', limit: 0, state: 'none', isUncategorized: true, txnCount: 4, pendingCount: 4 })),
    ).toEqual({ text: '4 pending · categorize once posted', tone: 'muted' })
  })
})

describe('glossary', () => {
  it('one word per figure', () => {
    expect(GLOSSARY).toMatchObject({
      income: 'Income',
      spending: 'Spending',
      saved: 'Saved',
      overspent: 'Overspent',
      budget: 'budget',
      noBudget: 'No budget',
      delete: 'Delete',
    })
    expect(NO_INCOME_YET).toBe('No income yet')
    expect(NO_PAY_YET).toBe('No pay yet')
    // With a credit already in, 'Income $12.40 · No income yet' contradicted itself.
    expect(beforePayday(0)).toBe(NO_INCOME_YET)
    expect(beforePayday(12.4)).toBe(NO_PAY_YET)
  })
})
