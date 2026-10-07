/**
 * B90: Undo of a Tell Tally edit keeps the row pinned. A pin is one-way across
 * devices (sync.ts keeps `manual` once any device set it), so an Undo that
 * unpinned here never unpinned anywhere else, and the devices disagreed for
 * good. Undo restores the fields the edit changed and leaves the pin.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))
vi.mock('../sync/merchantRules', () => ({
  loadMerchantRules: vi.fn(async () => true),
  reloadMerchantRules: vi.fn(async () => true),
}))

import { applyPlan, undoPlan } from './commandRun'
import { parseCommand, planCommand } from './commands'
import { db, type Category } from '../db/db'

const CATS: Category[] = [
  { id: 2, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 0, updatedAt: 0 },
  { id: 3, name: 'Dining', icon: 'utensils', color: '#fff', kind: 'expense', monthlyBudget: 300, sortOrder: 1, updatedAt: 0 },
]

beforeEach(async () => {
  await db.transactions.clear()
  await db.transactions.add({ id: 1, uid: 'sf:a1', date: '2026-09-15', amount: 60, type: 'expense', categoryId: 2, account: 'Card', note: 'Amazon', createdAt: 0, updatedAt: 0 })
})

describe('Undo keeps the pin', () => {
  for (const ask of ['file amazon under dining', 'move amazon to Sep 20', 'hide amazon $60']) {
    it(ask, async () => {
      const parsed = parseCommand(ask, CATS, '2026-09-29')
      if (!parsed.ok) throw new Error(parsed.message)
      const plan = planCommand(parsed.command, await db.transactions.toArray(), CATS)
      if (!plan.ok) throw new Error(plan.message)
      await undoPlan(await applyPlan(plan))
      expect(await db.transactions.get(1)).toMatchObject({ categoryId: 2, date: '2026-09-15', deleted: false, manual: true })
    })
  }
})
