// @vitest-environment jsdom
/**
 * "forget" and its Undo, end to end: real Tell Tally commands write to a small
 * in-memory merchant_rules table, and the real loader (merchantRules.ts) and
 * categorizer read it back, so the order rules apply in is the app's own.
 * Invented merchants and stamps only.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: number }
  type Kind = 'select' | 'delete' | 'insert' | 'update'
  const s = {
    rows: [] as Row[],
    nextId: 1,
    tick: 0,
    /** The Nth call of a kind (counted from the start of the test) is refused, as postgrest refuses: { error }. */
    refuse: { select: 0, delete: 0, insert: 0, update: 0 } as Record<Kind, number>,
    seen: { select: 0, delete: 0, insert: 0, update: 0 } as Record<Kind, number>,
  }
  // Microseconds and an offset, as PostgREST writes a timestamptz.
  const stamp = () => {
    const n = s.tick++
    return `2031-02-03T04:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.123456+00:00`
  }
  const refused = (k: Kind) => (++s.seen[k] === s.refuse[k] ? { message: 'Failed to fetch' } : null)
  const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

  function select(cols: string) {
    const filters: ((r: Row) => boolean)[] = []
    let cap = Infinity
    let by = ''
    const run = async () => {
      const error = refused('select')
      if (error) return { data: null, error }
      let out = s.rows.filter((r) => filters.every((f) => f(r)))
      if (by) out = out.slice().sort((a, b) => Number(a[by]) - Number(b[by]))
      const keep = cols.split(',')
      return { data: out.slice(0, cap).map((r) => Object.fromEntries(keep.map((k) => [k, r[k]]))), error: null }
    }
    const q = {
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      lte: (c: string, v: number) => (filters.push((r) => Number(r[c]) <= v), q),
      order: (c: string) => ((by = c), q),
      limit: (n: number) => ((cap = n), q),
      then: <T>(ok: (v: unknown) => T, bad?: (e: unknown) => T) => run().then(ok, bad),
    }
    return q
  }

  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from: () => ({
      select,
      insert: (row: Record<string, unknown>) => {
        const error = refused('insert')
        let id = 0
        // A key left out takes the column default; the touch trigger runs on update only.
        if (!error) s.rows.push({ user_id: 'u1', flags: 'i', updated_at: stamp(), ...defined(row), id: (id = s.nextId++) })
        const res = { data: error ? null : { id }, error }
        return {
          select: () => ({ single: async () => res }),
          then: <T>(ok: (v: unknown) => T, bad?: (e: unknown) => T) => Promise.resolve({ error }).then(ok, bad),
        }
      },
      update: (fields: Record<string, unknown>) => ({
        eq: async (_c: string, id: number) => {
          const error = refused('update')
          if (!error) s.rows = s.rows.map((r) => (r.id === id ? { ...r, ...fields, updated_at: stamp() } : r))
          return { error }
        },
      }),
      delete: () => ({
        eq: async (_c: string, id: number) => {
          const error = refused('delete')
          if (!error) s.rows = s.rows.filter((r) => r.id !== id)
          return { error }
        },
      }),
    }),
  }
  return { s, client }
})

vi.mock('../db/supabase', () => ({ supabase: h.client }))

import { applyPlan, undoPlan } from './commandRun'
import { parseCommand, planCommand } from './commands'
import { guessCategoryName } from './categorize'
import { clearUserRules } from './userRules'
import { loadMerchantRules } from '../sync/merchantRules'
import { db, type Category } from '../db/db'

const CATS: Category[] = [
  { id: 2, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 5, name: 'Subscriptions', icon: 'repeat', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
  { id: 6, name: 'Fun', icon: 'star', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 },
]
const TODAY = '2031-02-10'

async function planOf(words: string) {
  const parsed = parseCommand(words, CATS, TODAY)
  if (!parsed.ok) throw new Error(parsed.message)
  const plan = planCommand(parsed.command, await db.transactions.toArray(), CATS, { today: TODAY })
  if (!plan.ok) throw new Error(plan.message)
  return plan
}

/** Rule A ("zentrix", older) and rule B ("zentrix plus", newer): both catch Zentrix Plus, and the newer wins the tie. */
async function twoOverlappingRules() {
  await applyPlan(await planOf('file zentrix under shopping'))
  await applyPlan(await planOf('file zentrix plus under subscriptions'))
  expect(h.s.rows.map((r) => [r.category, r.priority])).toEqual([
    ['Shopping', 4],
    ['Subscriptions', 4],
  ])
}

const guess = (note: string) => guessCategoryName(note, 'expense')
/** Each stored rule as Undo must bring it back: pattern, category and stamp. */
const stored = () =>
  h.s.rows
    .map((r) => ({ pattern: r.pattern, flags: r.flags, category: r.category, kind: r.kind, priority: r.priority, updated_at: r.updated_at }))
    .sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)))

beforeEach(async () => {
  h.s.rows = []
  h.s.nextId = 1
  h.s.tick = 0
  h.s.refuse = { select: 0, delete: 0, insert: 0, update: 0 }
  h.s.seen = { select: 0, delete: 0, insert: 0, update: 0 }
  clearUserRules()
  await db.transactions.clear()
  await db.transactions.bulkAdd([
    { id: 1, date: '2031-02-01', amount: 41.5, type: 'expense', categoryId: null, account: 'Card', note: 'ZENTRIX STORE 0042', createdAt: 0, updatedAt: 0 },
    { id: 2, date: '2031-02-02', amount: 9.25, type: 'expense', categoryId: null, account: 'Card', note: 'ZENTRIX PLUS 7781', createdAt: 0, updatedAt: 0 },
  ])
  await loadMerchantRules()
})
afterEach(() => {
  clearUserRules()
})

describe('forget, then Undo, with two overlapping Tell Tally rules', () => {
  it('Undo brings both rules back in their old order, so the newer one still wins', async () => {
    await twoOverlappingRules()
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
    const before = stored()

    const plan = await planOf('forget zentrix')
    expect(plan.forget).toHaveLength(2)
    const applied = await applyPlan(plan)
    expect(h.s.rows).toEqual([])
    expect(applied.title).toBeUndefined()
    expect(guess('ZENTRIX PLUS 7781')).not.toBe('Subscriptions')

    await undoPlan(applied)
    // Each rule is back exactly as stored, its stamp included: a fresh stamp
    // made the older, broader rule the newest, and it took Zentrix Plus.
    expect(stored()).toEqual(before)
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
    // Oldest first, so the ids rise with age as they did.
    const [older, newer] = [...h.s.rows].sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    expect(older.id).toBeLessThan(newer.id)
    expect(applied.forgot).toEqual([])
  })

  it('a rule saved after the forget stays newest: Undo does not stamp the old ones newer', async () => {
    await twoOverlappingRules()
    const applied = await applyPlan(await planOf('forget zentrix'))
    // Saved after the two forgotten, and before the Undo.
    await applyPlan(await planOf('file zentrix plus under fun'))
    await undoPlan(applied)
    expect(h.s.rows).toHaveLength(3)
    // The newest instruction still wins Zentrix Plus, and the broad rule keeps the rest.
    expect(guess('ZENTRIX PLUS 7781')).toBe('Fun')
    expect(guess('ZENTRIX STORE 0042')).toBe('Shopping')
  })
})

describe('a rule stored twice', () => {
  it('each row goes once, and Undo puts back two, not four', async () => {
    await applyPlan(await planOf('file zentrix under shopping'))
    h.s.rows.push({ ...h.s.rows[0], id: h.s.nextId++, updated_at: '2031-02-03T04:30:00.123456+00:00' })
    await loadMerchantRules()
    const before = stored()
    const plan = await planOf('forget zentrix')
    expect(plan.forget).toHaveLength(2)
    const applied = await applyPlan(plan)
    expect(h.s.rows).toEqual([])
    expect(applied.forgot).toHaveLength(2)
    await undoPlan(applied)
    expect(stored()).toEqual(before)
  })
})

describe('a forget the server stops partway', () => {
  it('reports what it did and keeps Undo for the rules that went', async () => {
    await twoOverlappingRules()
    const before = stored()
    const plan = await planOf('forget zentrix')
    // The second delete of this Apply is refused.
    h.s.refuse.delete = h.s.seen.delete + 2
    const applied = await applyPlan(plan)
    expect(h.s.rows).toHaveLength(1)
    expect(applied.forgot).toHaveLength(1)
    expect(applied.title).toBe('Forgot 1 of 2 rules')
    expect(applied.note).toMatch(/could not be removed/)

    await undoPlan(applied)
    expect(stored()).toEqual(before)
    expect(guess('ZENTRIX PLUS 7781')).toBe('Subscriptions')
  })

  it('a lookup that fails is an error before anything is deleted', async () => {
    await twoOverlappingRules()
    const plan = await planOf('forget zentrix')
    // The second lookup of this Apply is refused.
    h.s.refuse.select = h.s.seen.select + 2
    await expect(applyPlan(plan)).rejects.toThrow()
    expect(h.s.rows).toHaveLength(2)
  })

  it('a first delete that fails is an error, and nothing is gone', async () => {
    await twoOverlappingRules()
    const plan = await planOf('forget zentrix')
    h.s.refuse.delete = h.s.seen.delete + 1
    await expect(applyPlan(plan)).rejects.toThrow()
    expect(h.s.rows).toHaveLength(2)
  })
})
