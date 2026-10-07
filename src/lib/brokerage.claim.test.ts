/**
 * A connector account claims a hand-typed row only when that row is a shell
 * (no figure yet, 'No balance yet') or is plainly the same account (the same
 * name). A typed account with a balance used to be taken over by any new
 * connector account at the same institution and tier: a typed 401(k) became a
 * newly linked IRA, and the typed balance left net worth with nothing to
 * restore. Values are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { applySyncedAccounts, type SyncedAccount } from './brokerage'
import { db, type Account } from '../db/db'

const typed = (p: Partial<Account>): Account =>
  ({ institution: 'Northgate', name: '401(k)', type: 'retirement', balance: 85000, liveSync: false, lastUpdated: 1, sortOrder: 0, updatedAt: 1, ...p }) as Account
const linked = (p: Partial<SyncedAccount>): SyncedAccount => ({
  sourceAccountId: 'st-77', institution: 'Northgate Securities', name: 'Roth IRA', tier: 'retirement', balance: 12000, currency: 'USD', ...p,
})
const shown = async () => (await db.accounts.toArray()).filter((a) => !a.deleted && !a.archived)
const netWorth = async () => (await shown()).reduce((s, a) => s + (a.type === 'credit' ? -a.balance : a.balance), 0)

beforeEach(async () => {
  await db.accounts.clear()
})

describe('a connector account and the hand-typed rows at its institution', () => {
  it('a typed 401(k) with a balance stays beside a newly linked IRA at the same firm', async () => {
    await db.accounts.add(typed({}))
    await applySyncedAccounts([linked({})], 'snaptrade')
    const rows = await shown()
    expect(rows.map((a) => [a.name, a.balance, a.liveSync]).sort()).toEqual([
      ['401(k)', 85000, false],
      ['Roth IRA', 12000, true],
    ])
    expect(await netWorth()).toBe(97000)
  })

  it('a typed certificate of deposit stays beside a newly opened savings account at the same bank', async () => {
    await db.accounts.add(typed({ institution: 'Test Bank', name: 'Certificate of Deposit', type: 'cash', balance: 10000 }))
    await applySyncedAccounts([linked({ sourceAccountId: 'tb:1', institution: 'Test Bank', name: 'Everyday Savings', tier: 'cash', balance: 250 })], 'simplefin')
    expect(await shown()).toHaveLength(2)
    expect(await netWorth()).toBe(10250)
  })

  it('a $0 shell is still claimed, whatever its name', async () => {
    await db.accounts.add(typed({ name: 'Retirement', balance: 0 }))
    await applySyncedAccounts([linked({})], 'snaptrade')
    expect((await shown()).map((a) => [a.name, a.balance, a.liveSync, a.sourceAccountId])).toEqual([['Roth IRA', 12000, true, 'st-77']])
  })

  it('a typed row of the same name is the same account: its live balance replaces the typed one', async () => {
    await db.accounts.add(typed({ name: 'Roth IRA', balance: 11800 }))
    await applySyncedAccounts([linked({ name: 'Northgate Securities Roth IRA' })], 'snaptrade')
    expect((await shown()).map((a) => [a.name, a.balance, a.liveSync])).toEqual([['Roth IRA', 12000, true]])
  })

  it('a $0 shell of the same name is claimed before a $0 shell of another name', async () => {
    await db.accounts.add(typed({ name: 'Brokerage', type: 'retirement', balance: 0, sortOrder: 0 }))
    await db.accounts.add(typed({ name: 'Roth IRA', balance: 0, sortOrder: 1 }))
    await applySyncedAccounts([linked({})], 'snaptrade')
    const rows = await shown()
    expect(rows.find((a) => a.liveSync)?.sortOrder).toBe(1)
    expect(rows.find((a) => !a.liveSync)).toMatchObject({ name: 'Brokerage', balance: 0 })
  })
})
