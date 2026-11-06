/** One row of money, one row in the ledger. The figures and merchants are invented. */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db, type Transaction } from '../db/db'
import { matchLedger, retireFileTwins, type Identified } from './rowMatch'

const row = (over: Partial<Identified> = {}): Identified => ({ uid: 'file:csv:a:0', date: '2026-11-03', amount: 4.5, type: 'expense', note: 'Harbor Coffee', ...over })

let id = 0
const held = (over: Partial<Transaction> = {}): Transaction => ({
  id: ++id, uid: `sf:${id}`, date: '2026-11-03', amount: 4.5, type: 'expense', note: 'Harbor Coffee', categoryId: null, account: '', createdAt: 1, updatedAt: 1, ...over,
})

describe('matchLedger', () => {
  it('finds a row by its id, however its words were edited', () => {
    const m = matchLedger([row()], [held({ uid: 'file:csv:a:0', note: 'Coffee with Sam' })])
    expect(m.here).toHaveLength(1)
    expect(m.fresh).toEqual([])
  })

  it('keeps a removed row out', () => {
    const m = matchLedger([row()], [held({ uid: 'file:csv:a:0', deleted: true })])
    expect(m.removed).toHaveLength(1)
    expect(m.fresh).toEqual([])
  })

  it('finds a bank row that says the same, in any case', () => {
    const m = matchLedger([row({ note: 'HARBOR COFFEE ' })], [held({ uid: 'sf:bank:acct:1' })])
    expect(m.here).toHaveLength(1)
  })

  it('matches one for one', () => {
    const m = matchLedger([row({ uid: 'a' }), row({ uid: 'b' })], [held()])
    expect(m.here).toHaveLength(1)
    expect(m.fresh).toHaveLength(1)
  })

  it('does not spend a ledger row on a second match', () => {
    const ledger = [held({ uid: 'a' })]
    const m = matchLedger([row({ uid: 'a' }), row({ uid: 'b', note: 'Harbor Coffee' })], ledger)
    expect(m.here).toHaveLength(1)
    expect(m.twins.size).toBe(0)
    expect(m.fresh).toHaveLength(1)
  })

  it('flags a row worded another way, with the same money within days, as a twin', () => {
    const incoming = row({ note: 'SQ *HARBOR COFFEE SF CA', date: '2026-11-04' })
    const bank = held({ date: '2026-11-03' })
    const m = matchLedger([incoming], [bank])
    expect(m.fresh).toEqual([incoming])
    expect(m.twins.get(incoming)).toBe(bank)
  })

  it('goes by the day a rent row posted, not the 1st it counts on', () => {
    const incoming = row({ date: '2026-11-01', posted: '2026-10-28', amount: 1200, note: 'RENT' })
    const bank = held({ date: '2026-11-01', posted: '2026-10-29', amount: 1200, note: 'LANDLORD LLC' })
    expect(matchLedger([incoming], [bank]).twins.size).toBe(1)
  })

  it('sees no twin past three days, in another direction or for another amount', () => {
    const incoming = row({ note: 'Other' })
    expect(matchLedger([incoming], [held({ date: '2026-11-07' })]).twins.size).toBe(0)
    expect(matchLedger([incoming], [held({ type: 'income' })]).twins.size).toBe(0)
    expect(matchLedger([incoming], [held({ amount: 4.51 })]).twins.size).toBe(0)
    expect(matchLedger([incoming], [held({ deleted: true })]).twins.size).toBe(0)
  })

  it('tells a refund from a charge of the same size', () => {
    expect(matchLedger([row({ amount: -4.5, note: 'Other' })], [held()]).twins.size).toBe(0)
  })

  it('pairs each twin with the closest day, and only once', () => {
    const near = held({ date: '2026-11-03', note: 'Near' })
    const far = held({ date: '2026-11-01', note: 'Far' })
    const [a, b] = [row({ uid: 'a', note: 'X' }), row({ uid: 'b', note: 'Y' })]
    const m = matchLedger([a, b], [far, near])
    expect(m.twins.get(a)).toBe(near)
    expect(m.twins.get(b)).toBe(far)
  })
})

describe('retireFileTwins', () => {
  const add = (over: Partial<Transaction>) =>
    db.transactions.add({ date: '2026-11-03', amount: 4.5, type: 'expense', note: 'HARBOR COFFEE', categoryId: 1, account: '', createdAt: 1, updatedAt: 1, ...over })
  const bank = (over: Partial<Transaction> = {}): Transaction => ({
    uid: 'sf:bank:acct:9', date: '2026-11-03', amount: 4.5, type: 'expense', note: 'Harbor Coffee Co', categoryId: 7, account: 'Bank Card', createdAt: 2, updatedAt: 2, ...over,
  })

  beforeEach(async () => {
    await db.transactions.clear()
  })

  const live = () => db.transactions.filter((t) => !t.deleted).count()

  it('steps a file row aside for the bank’s copy of the same day', async () => {
    await add({ uid: 'file:csv:a:0' })
    await retireFileTwins([bank()], 9)
    expect(await live()).toBe(0)
    const [gone] = await db.transactions.toArray()
    expect(gone).toMatchObject({ deleted: true, updatedAt: 9 })
    expect(gone.retired).toBeUndefined() // Activity's Removed still offers it
  })

  it('needs a word of the merchant when the days differ', async () => {
    await add({ uid: 'file:csv:a:0', date: '2026-11-02' })
    await retireFileTwins([bank({ note: 'ACME STORES' })], 9)
    expect(await live()).toBe(1)
    await retireFileTwins([bank()], 9)
    expect(await live()).toBe(0)
  })

  it('leaves everything but a file row alone', async () => {
    await add({ uid: 'sf:bank:acct:1' })
    await add({ uid: 'b11e1b2c-0000-4000-8000-000000000000' })
    await retireFileTwins([bank()], 9)
    expect(await live()).toBe(2)
  })

  it('does not wait for a hold, which may never post', async () => {
    await add({ uid: 'file:csv:a:0' })
    await retireFileTwins([bank({ pending: true })], 9)
    expect(await live()).toBe(1)
  })

  it('takes one file row for one bank row', async () => {
    await add({ uid: 'file:csv:a:0' })
    await add({ uid: 'file:csv:a:1' })
    await retireFileTwins([bank()], 9)
    expect(await live()).toBe(1)
  })

  it('hands a person’s edits to the bank’s row', async () => {
    await add({ uid: 'file:csv:a:0', manual: true, categoryId: 3, note: 'Coffee with Sam' })
    const row = bank()
    await retireFileTwins([row], 9)
    expect(row).toMatchObject({ categoryId: 3, note: 'Coffee with Sam', manual: true })
  })

  it('leaves the bank’s filing when no one edited the file row', async () => {
    await add({ uid: 'file:csv:a:0', categoryId: 3 })
    const row = bank()
    await retireFileTwins([row], 9)
    expect(row).toMatchObject({ categoryId: 7 })
    expect(row.manual).toBeUndefined()
  })
})
