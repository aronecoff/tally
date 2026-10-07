/**
 * B02: Tell Tally leaves pending charges alone. A pin on a pending charge was
 * never carried to the row the bank posts later, so it was counted twice (or a
 * hidden one came back). The sort queue already leaves them out; so does this.
 */
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../db/db'
import { parseCommand, planCommand } from './commands'

const TODAY = '2026-10-04'
const cat = (id: number, name: string): Category => ({
  id, name, kind: 'expense', monthlyBudget: 0, icon: 'tag', color: '#fff', sortOrder: id, updatedAt: 0,
})
const CATS: Category[] = [cat(1, 'Shopping'), cat(2, 'Gifts')]
const tx = (id: number, date: string, amount: number, note: string, p: Partial<Transaction> = {}): Transaction => ({
  id, date, amount, note, type: 'expense', categoryId: null, account: 'Test Card', createdAt: 0, updatedAt: 0, ...p,
})
const TXNS: Transaction[] = [
  tx(1, '2026-10-01', 21.37, 'PLONK MARKET', { pending: true }),
  tx(2, '2026-09-20', 21.37, 'PLONK MARKET'),
  tx(3, '2026-10-02', 40, 'Zappo Vending', { pending: true }),
]
// Planned on TODAY, never the real clock: a day in another year than today's is
// written with its year, so the messages below changed from the first day of 2027.
const plan = (s: string) => {
  const p = parseCommand(s, CATS, TODAY)
  if (!p.ok) throw new Error(p.message)
  return planCommand(p.command, TXNS, CATS, { today: TODAY })
}

describe('pending charges in Tell Tally', () => {
  it('the most recent match is pending: it says so, and never reaches past it to an older one', () => {
    // Reaching past it took last month's charge of the same amount (B06: September's rent).
    expect(plan('hide plonk market $21.37')).toEqual({
      ok: false,
      message: 'The most recent, Plonk Market $21.37 on Oct 1, is still pending. Try again once it posts, or add a day to pick an older one.',
    })
  })

  it('file with an amount names the most recent too: a pending one is said, not skipped', () => {
    expect(plan('file plonk market $21.37 under Gifts')).toMatchObject({ ok: false, message: expect.stringMatching(/^The most recent, Plonk Market \$21\.37 on Oct 1, is still pending/) })
  })

  it('a day picks the posted one; "all" takes the posted ones and says one is pending', () => {
    const day = plan('hide plonk market $21.37 sep 20')
    if (!day.ok) throw new Error(day.message)
    expect(day.rows.map((r) => r.t.id)).toEqual([2])
    const all = plan('hide all plonk market')
    if (!all.ok) throw new Error(all.message)
    expect(all.rows.map((r) => r.t.id)).toEqual([2])
    expect(all.pending).toBe(1)
  })

  it('only pending matches: it says to try again once it posts', () => {
    for (const ask of ['hide zappo vending', 'move zappo vending to Oct 1', 'file zappo vending $40 under Gifts']) {
      const p = plan(ask)
      expect(p.ok, ask).toBe(false)
      expect(!p.ok && p.message).toBe('That charge is still pending. Try again once it posts.')
    }
  })

  it('file still saves the rule, so the charge is filed when it posts', () => {
    const p = plan('file zappo vending under Gifts')
    if (!p.ok) throw new Error(p.message)
    expect(p.rows).toEqual([])
    expect(p.rule).toMatchObject({ category: 'Gifts' })
    expect(p.pending).toBe(1)
  })

  it('file all of a merchant changes only the posted ones', () => {
    const p = plan('file plonk market under Gifts')
    if (!p.ok) throw new Error(p.message)
    expect(p.rows.map((r) => r.t.id)).toEqual([2])
    expect(p.pending).toBe(1)
  })
})
