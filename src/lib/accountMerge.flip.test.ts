/**
 * Flip sign: a bank that reports a balance the other way round. The figure is
 * negated before anything reads it, and turning the setting on or off moves the
 * stored row at once. Values are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { db } from '../db/db'
import { applySyncedAccounts, setFlipSign, type SyncedAccount } from './accountMerge'

const card = (balance: number | null, p: Partial<SyncedAccount> = {}): SyncedAccount => ({
  sourceAccountId: 'bank.test:card1', institution: 'Test Bank', name: 'Everyday Visa (4444)', tier: 'credit', balance, currency: 'USD', ...p,
})
const only = async () => {
  const rows = await db.accounts.toArray()
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeEach(async () => {
  await db.accounts.clear()
})

describe('flip sign', () => {
  it('reads a card its bank reports at a positive figure as owed, now and at every sync', async () => {
    await applySyncedAccounts([card(120)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: -120 })

    await setFlipSign((await only()).id!, true)
    expect(await only()).toMatchObject({ flipSign: true, type: 'credit', balance: 120, sourceSaid: { balance: -120 } })

    await applySyncedAccounts([card(150)], 'simplefin')
    expect(await only()).toMatchObject({ flipSign: true, type: 'credit', balance: 150, sourceSaid: { balance: -150 } })
  })

  it('goes back the way it came', async () => {
    await applySyncedAccounts([card(120)], 'simplefin')
    const id = (await only()).id!
    await setFlipSign(id, true)
    await setFlipSign(id, false)
    const a = await only()
    expect(a).toMatchObject({ balance: -120, sourceSaid: { balance: 120 } })
    expect(a.flipSign).toBeUndefined()

    await applySyncedAccounts([card(130)], 'simplefin')
    expect(await only()).toMatchObject({ balance: -130 })
  })

  it('setting it twice flips once', async () => {
    await applySyncedAccounts([card(120)], 'simplefin')
    const id = (await only()).id!
    await setFlipSign(id, true)
    const stamped = (await only()).updatedAt
    await setFlipSign(id, true)
    expect(await only()).toMatchObject({ balance: 120, updatedAt: stamped })
  })

  it('never stores a negative zero', async () => {
    await applySyncedAccounts([card(0)], 'simplefin')
    await setFlipSign((await only()).id!, true)
    expect(Object.is((await only()).balance, -0)).toBe(false)
    await applySyncedAccounts([card(0)], 'simplefin')
    expect(Object.is((await only()).balance, -0)).toBe(false)
  })

  it('keeps a balance the bank could not give as it was', async () => {
    await applySyncedAccounts([card(120)], 'simplefin')
    await setFlipSign((await only()).id!, true)
    await applySyncedAccounts([card(null)], 'simplefin')
    expect(await only()).toMatchObject({ balance: 120 })
  })

  it('reads a type set by hand the same way as before', async () => {
    await applySyncedAccounts([card(120, { name: 'Everyday (4444)', tier: 'cash' })], 'simplefin')
    const a = await only()
    expect(a).toMatchObject({ type: 'cash', balance: 120 })
    await db.accounts.update(a.id!, { type: 'credit', updatedAt: Date.now() })
    await setFlipSign(a.id!, true)
    expect(await only()).toMatchObject({ type: 'credit', balance: -120 })

    await applySyncedAccounts([card(150, { name: 'Everyday (4444)', tier: 'cash' })], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: -150 })
  })

  it('gives a row with no connector record one, so the setting has somewhere to travel', async () => {
    await db.accounts.add({
      institution: 'Test Bank', name: 'Everyday Visa (4444)', type: 'credit', balance: -120, liveSync: true,
      source: 'simplefin', sourceAccountId: 'bank.test:card1', lastUpdated: 1, sortOrder: 0, updatedAt: 1,
    })
    await setFlipSign((await only()).id!, true)
    expect(await only()).toMatchObject({
      balance: 120,
      sourceSaid: { institution: 'Test Bank', name: 'Everyday Visa (4444)', type: 'credit', balance: -120 },
    })
  })

  it('leaves every other account alone', async () => {
    await applySyncedAccounts([card(120), card(300, { sourceAccountId: 'bank.test:card2', name: 'Travel Visa (5555)' })], 'simplefin')
    const [first] = await db.accounts.toArray()
    await setFlipSign(first.id!, true)
    await applySyncedAccounts([card(120), card(300, { sourceAccountId: 'bank.test:card2', name: 'Travel Visa (5555)' })], 'simplefin')
    const rows = await db.accounts.toArray()
    expect(rows.map((a) => a.balance)).toEqual([120, -300])
  })

  it('does nothing without it: a sync reads the bank as it always did', async () => {
    await applySyncedAccounts([card(-120)], 'simplefin')
    await applySyncedAccounts([card(-130)], 'simplefin')
    const a = await only()
    expect(a).toMatchObject({ type: 'credit', balance: 130, sourceSaid: { balance: -130 } })
    expect('flipSign' in a).toBe(false)
  })
})
