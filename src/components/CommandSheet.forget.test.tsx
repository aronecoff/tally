// @vitest-environment jsdom
/**
 * Tell Tally "forget" in the sheet when the server stops partway: it says how
 * many rules went, keeps Undo for them, and keeps the words so Preview can try
 * the rest. Invented merchants and stamps only.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: number }
  const s = {
    rows: [] as Row[],
    nextId: 10,
    /** The Nth delete (counted from the start of the test) is refused, as postgrest refuses: { error }. */
    refuseDelete: 0,
    deletes: 0,
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
    from: () => ({
      select: (cols: string) => {
        const filters: ((r: Row) => boolean)[] = []
        const q = {
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          lte: (c: string, v: number) => (filters.push((r) => Number(r[c]) <= v), q),
          limit: async () => ({
            data: s.rows.filter((r) => filters.every((f) => f(r))).map((r) => Object.fromEntries(cols.split(',').map((k) => [k, r[k]]))),
            error: null,
          }),
        }
        return q
      },
      insert: (row: Record<string, unknown>) => {
        s.rows.push({ user_id: 'u1', updated_at: '2031-09-09T09:09:09.000001+00:00', ...row, id: s.nextId++ })
        return { then: <T,>(ok: (v: unknown) => T) => Promise.resolve({ error: null }).then(ok) }
      },
      delete: () => ({
        eq: async (_c: string, id: number) => {
          if (++s.deletes === s.refuseDelete) return { error: { message: 'Failed to fetch' } }
          s.rows = s.rows.filter((r) => r.id !== id)
          return { error: null }
        },
      }),
    }),
  }
  return { s, client }
})

vi.mock('../db/supabase', () => ({ supabase: h.client }))
vi.mock('../sync/merchantRules', () => ({ loadMerchantRules: vi.fn(async () => true), reloadMerchantRules: vi.fn(async () => true) }))

import { CommandSheet } from './CommandSheet'
import { db, type Category } from '../db/db'
import { clearUserRules, setUserRules } from '../lib/userRules'

const CATS: Category[] = [
  { id: 2, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 5, name: 'Subscriptions', icon: 'repeat', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
]
const BROAD = '(?:^|[^a-z0-9])zentrix(?![a-z0-9])'
const NARROW = '(?:^|[^a-z0-9])zentrix[^a-z0-9]*plus(?![a-z0-9])'
const RULES = [
  { id: 1, user_id: 'u1', pattern: BROAD, flags: 'i', category: 'Shopping', kind: 'expense', priority: 4, updated_at: '2031-02-03T04:00:00.123456+00:00' },
  { id: 2, user_id: 'u1', pattern: NARROW, flags: 'i', category: 'Subscriptions', kind: 'expense', priority: 4, updated_at: '2031-02-03T04:00:01.123456+00:00' },
]

const input = () => screen.getByLabelText('Command') as HTMLInputElement
const settle = () => vi.advanceTimersByTime(500)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date(2031, 1, 10, 12, 0, 0))
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })))
  h.s.rows = RULES.map((r) => ({ ...r }))
  h.s.nextId = 10
  h.s.refuseDelete = 0
  h.s.deletes = 0
  // As the loader leaves them: by priority, the newer first on a tie.
  setUserRules([RULES[1], RULES[0]])
  await db.transactions.clear()
  await db.categories.clear()
  await db.categories.bulkAdd(CATS)
  await db.transactions.bulkAdd([
    { id: 1, date: '2031-02-01', amount: 41.5, type: 'expense', categoryId: 2, account: 'Card', note: 'ZENTRIX STORE 0042', createdAt: 0, updatedAt: 0 },
    { id: 2, date: '2031-02-02', amount: 9.25, type: 'expense', categoryId: 5, account: 'Card', note: 'ZENTRIX PLUS 7781', createdAt: 0, updatedAt: 0 },
  ])
})
afterEach(() => {
  cleanup()
  clearUserRules()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function previewForget() {
  render(<CommandSheet categories={CATS} onClose={() => {}} />)
  fireEvent.change(input(), { target: { value: 'forget zentrix' } })
  fireEvent.click(screen.getByText('Preview'))
  await screen.findByText('Forget 2 rules for Zentrix')
  settle()
}

describe('Tell Tally forget', () => {
  it('all rules gone: Done, and Undo puts them back', async () => {
    await previewForget()
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Done')
    expect(h.s.rows).toEqual([])
    settle()
    fireEvent.click(screen.getByText('Undo'))
    await screen.findByText('Undone')
    expect(h.s.rows.map((r) => [r.pattern, r.updated_at])).toEqual(RULES.map((r) => [r.pattern, r.updated_at]))
  })

  it('stopped partway: says how many went, offers Undo, and keeps the words to try again', async () => {
    await previewForget()
    h.s.refuseDelete = 2
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Forgot 1 of 2 rules')
    expect(screen.queryByText('Done')).toBeNull()
    expect(screen.queryByText('Could not save. Try again.')).toBeNull()
    expect(screen.getByText(/could not be removed/)).toBeTruthy()
    expect(h.s.rows).toHaveLength(1)
    // The words stay, so Preview plans the rule still left.
    expect(input().value).toBe('forget zentrix')
    expect(screen.getByText('Preview')).toBeTruthy()

    settle()
    fireEvent.click(screen.getByRole('button', { name: 'Undo: Forgot 1 of 2 rules' }))
    await screen.findByText('Undone')
    expect(h.s.rows).toHaveLength(2)
    expect(h.s.rows.map((r) => r.updated_at).sort()).toEqual(RULES.map((r) => r.updated_at))
  })

  it('nothing gone: the usual error, and no Undo', async () => {
    await previewForget()
    h.s.refuseDelete = 1
    fireEvent.click(screen.getByText('Apply'))
    await screen.findByText('Could not save. Try again.')
    expect(h.s.rows).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull()
  })
})
