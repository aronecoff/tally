/**
 * B11: a pinned pending row the bank retires (it posted under a new id, or the
 * hold was dropped) keeps its pin, so its tombstone read exactly like the
 * user's Delete. Activity › Removed and "unhide" offered it back, and restoring
 * it counted the charge twice beside its posted row. Every retired row is now
 * marked `retired` (synced), successor or not.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'

const h = vi.hoisted(() => ({ feed: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({ data: { ok: true, transactions: h.feed }, error: null })),
    },
  },
}))

import { syncBankTransactions } from './banks'
import { db, type Transaction } from '../db/db'
import { parseCommand, planCommand } from './commands'

const CARD = 'Test Bank Rewards Visa (5555)'
const DAY = 86400
const NOW = Math.floor(Date.now() / 1000)
const TODAY = new Date().toISOString().slice(0, 10)

const row = (id: string, amount: number, payee: string, posted: number, p: Partial<SyncedTx> = {}): SyncedTx => ({
  sourceTxId: `bank.test:card:${id}`, account: CARD, tier: 'credit', posted, amount, payee, description: payee, memo: '', mcc: null, ...p,
})
const COFFEE = row('coffee', -5, 'CORNER CAFE', NOW - 9 * DAY)
const byUid = (uid: string) => db.transactions.where('uid').equals(`sf:bank.test:card:${uid}`).first()
/** What Activity › Removed lists (TransactionList.isRemoved). */
const removedRows = async () => (await db.transactions.toArray()).filter((t) => !!t.deleted && !!t.manual && !t.retired)
const spend = async () =>
  Math.round((await db.transactions.toArray()).filter((t) => !t.deleted && t.type === 'expense').reduce((s, t) => s + t.amount, 0) * 100) / 100

async function pendingThenPost(edit: Partial<Transaction>, post: SyncedTx | null) {
  h.feed = [COFFEE, row('hold', -133, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
  await syncBankTransactions()
  const t = (await byUid('hold'))!
  await db.transactions.update(t.id!, { ...edit, manual: true, updatedAt: Date.now() })
  await new Promise((r) => setTimeout(r, 5))
  h.feed = post ? [COFFEE, post] : [COFFEE]
  await syncBankTransactions()
}

const unhide = async (ask: string) => {
  const cats = await db.categories.toArray()
  const p = parseCommand(ask, cats, TODAY)
  if (!p.ok) throw new Error(p.message)
  return planCommand(p.command, await db.transactions.toArray(), cats, { today: TODAY })
}

beforeEach(async () => {
  await db.categories.clear()
  await db.transactions.clear()
  await db.categories.bulkAdd([{ id: 3, name: 'Gifts', icon: 'gift', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 }])
})

describe('a pinned pending row the bank retires is never offered back as Removed', () => {
  it('filed by hand, then posted under a new id: marked retired; Removed is empty and unhide finds nothing', async () => {
    await pendingThenPost({ categoryId: 3 }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect(await byUid('hold')).toMatchObject({ deleted: true, manual: true, retired: true })
    expect(await removedRows()).toEqual([])
    expect(await unhide('unhide plonk market $133')).toMatchObject({ ok: false })
    expect(await spend()).toBe(138)
  })

  it('hidden by hand, then posted: only the posted row (which took the hide) is offered back', async () => {
    await pendingThenPost({ deleted: true }, row('post', -133, 'PLONK MARKET #12', NOW - 1 * DAY))
    expect((await removedRows()).map((t) => t.uid)).toEqual(['sf:bank.test:card:post'])
    const p = await unhide('unhide plonk market $133')
    expect(p.ok && p.rows.map((r) => r.t.uid)).toEqual(['sf:bank.test:card:post'])
  })

  it('a dropped hold: retired too, and back unmarked if the bank lists it again', async () => {
    await pendingThenPost({ categoryId: 3 }, null)
    expect(await byUid('hold')).toMatchObject({ deleted: true, retired: true })
    expect(await removedRows()).toEqual([])
    h.feed = [COFFEE, row('hold', -133, 'PLONK MARKET', NOW - 3 * DAY, { pending: true })]
    await syncBankTransactions()
    expect(await byUid('hold')).toMatchObject({ deleted: false, retired: false, categoryId: 3 })
  })

  it('a hand Delete of a posted row is still offered back (control)', async () => {
    h.feed = [COFFEE]
    await syncBankTransactions()
    const t = (await byUid('coffee'))!
    await db.transactions.update(t.id!, { deleted: true, manual: true, updatedAt: Date.now() })
    expect((await removedRows()).map((x) => x.uid)).toEqual(['sf:bank.test:card:coffee'])
  })
})

describe('a pinned pending charge the bank left out of one answer, on another device', () => {
  /** Device A: the hold is filed by hand, then the bank leaves it out of one answer. */
  async function retiredOnA() {
    h.feed = [COFFEE, row('hold', -64, 'PLONK MARKET', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    const t = (await byUid('hold'))!
    await db.transactions.update(t.id!, { categoryId: 3, manual: true, updatedAt: Date.now() })
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE]
    await syncBankTransactions()
  }
  const relistThenPost = async () => {
    h.feed = [COFFEE, row('hold', -64, 'PLONK MARKET', NOW - 2 * DAY, { pending: true })]
    await syncBankTransactions()
    const mid = await byUid('hold')
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE, row('post', -64, 'PLONK MARKET #12', NOW - 1 * DAY)]
    await syncBankTransactions()
    return mid
  }

  it('device B holds the mark as synced (retired_pin): listed again, the hold comes back, and its posted row takes the edits', async () => {
    await retiredOnA()
    expect(await byUid('hold')).toMatchObject({ deleted: true, retired: true, retiredPin: true })
    const mid = await relistThenPost()
    expect(mid).toMatchObject({ deleted: false, categoryId: 3, pending: true })
    expect(await byUid('post')).toMatchObject({ deleted: false, categoryId: 3, manual: true })
    expect(await spend()).toBe(69)
  })

  it('without the mark (a cloud without the column): the hold stays retired, is never flipped back to pending, and its posted row counts', async () => {
    await retiredOnA()
    const t = (await byUid('hold'))!
    await db.transactions.update(t.id!, { retiredPin: undefined })
    const mid = await relistThenPost()
    expect(mid).toMatchObject({ deleted: true, retired: true, pending: false })
    expect(await byUid('post')).toMatchObject({ deleted: false })
    expect(await spend()).toBe(69)
  })

  it('a row left from the old flip (retired, deleted, pending again) is not read as a hide when it posts', async () => {
    await retiredOnA()
    const t = (await byUid('hold'))!
    await db.transactions.update(t.id!, { retiredPin: undefined, pending: true })
    await new Promise((r) => setTimeout(r, 5))
    h.feed = [COFFEE, row('post', -64, 'PLONK MARKET #12', NOW - 1 * DAY)]
    await syncBankTransactions()
    expect(await byUid('post')).toMatchObject({ deleted: false, categoryId: 3 })
    expect(await spend()).toBe(69)
  })
})
