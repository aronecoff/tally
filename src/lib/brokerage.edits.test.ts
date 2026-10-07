/**
 * What the user sets on a live (connector-fed) account in the account sheet
 * survives the next balance sync. The sync used to write the connector's
 * institution, name and type over every linked row, so a rename was undone at
 * the next refresh, and a card the bank reports at a positive figure could not
 * be kept as Credit: it went back to Cash, and net worth was off by twice its
 * balance. Values are invented.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase', () => ({ supabase: null }))

import { applySyncedAccounts, type SyncedAccount } from './brokerage'
import { db, type Account } from '../db/db'

const bank = (balance: number, p: Partial<SyncedAccount> = {}): SyncedAccount => ({
  sourceAccountId: 'bank.test:acct9', institution: 'Test Bank', name: 'Everyday Rewards (9999)', tier: balance < 0 ? 'credit' : 'cash', balance, currency: 'USD', ...p,
})
const only = async () => {
  const rows = await db.accounts.toArray()
  expect(rows).toHaveLength(1)
  return rows[0]
}
const netWorth = (a: Account) => (a.type === 'credit' ? -a.balance : a.balance)
/** The patch the account sheet writes (AccountSheet.save): only what changed, stamped. */
const sheetSave = async (patch: Partial<Account>) => {
  const a = await only()
  await db.accounts.update(a.id!, { ...patch, updatedAt: Date.now() })
}

beforeEach(async () => {
  await db.accounts.clear()
})

describe('a live account the user edited by hand', () => {
  it('a card the bank reports at a positive figure, set to Credit and renamed, stays so with the right sign across two syncs', async () => {
    await applySyncedAccounts([bank(420)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'cash', balance: 420 })
    await sheetSave({ type: 'credit', name: 'Rewards card' })

    await applySyncedAccounts([bank(435)], 'simplefin')
    let a = await only()
    expect(a).toMatchObject({ type: 'credit', name: 'Rewards card', balance: 435, institution: 'Test Bank' })
    expect(netWorth(a)).toBe(-435)

    await applySyncedAccounts([bank(450)], 'simplefin')
    a = await only()
    expect(a).toMatchObject({ type: 'credit', name: 'Rewards card', balance: 450 })
    expect(netWorth(a)).toBe(-450)
  })

  it('paid down to zero and charged again, it is still owed (the sign the user kept is remembered)', async () => {
    await applySyncedAccounts([bank(420)], 'simplefin')
    await sheetSave({ type: 'credit' })
    await applySyncedAccounts([bank(0)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 0 })
    await applySyncedAccounts([bank(60)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 60 })
  })

  it('a card opened at $0 (read as cash) and set to Credit is owed once the bank shows it owing', async () => {
    await applySyncedAccounts([bank(0)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'cash', balance: 0 })
    await sheetSave({ type: 'credit' })
    await applySyncedAccounts([bank(-50)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 50 })
    await applySyncedAccounts([bank(-80)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 80 })
    // Paid past zero: in credit, not owed.
    await applySyncedAccounts([bank(10)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: -10 })
  })

  it('an overdrawn checking the bank reads as a card, set to Cash and below zero, stays below zero', async () => {
    await applySyncedAccounts([bank(-100, { name: 'Everyday (1111)' })], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 100 })
    await sheetSave({ type: 'cash', balance: -100 })
    await applySyncedAccounts([bank(-80, { name: 'Everyday (1111)' })], 'simplefin')
    expect(await only()).toMatchObject({ type: 'cash', balance: -80 })
  })

  it('a renamed institution and name stay; a name the user never touched still follows the bank', async () => {
    await applySyncedAccounts([bank(1000, { name: 'Premier Checking (1111)' })], 'simplefin')
    await sheetSave({ institution: 'My Bank' })
    await applySyncedAccounts([bank(1010, { name: 'Everyday Checking (1111)' })], 'simplefin')
    expect(await only()).toMatchObject({ institution: 'My Bank', name: 'Everyday Checking (1111)', balance: 1010, type: 'cash' })
    await sheetSave({ name: 'Everyday' })
    await applySyncedAccounts([bank(1020, { name: 'Everyday Checking (1111)' })], 'simplefin')
    expect(await only()).toMatchObject({ institution: 'My Bank', name: 'Everyday', balance: 1020 })
  })

  it('a brokerage account renamed by hand keeps its name (SnapTrade)', async () => {
    const st = (balance: number): SyncedAccount => ({ sourceAccountId: 'st-1', institution: 'Northgate Securities', name: 'Individual', tier: 'brokerage', balance, currency: 'USD' })
    await applySyncedAccounts([st(5000)], 'snaptrade')
    await sheetSave({ name: 'Long-term' })
    await applySyncedAccounts([st(5100)], 'snaptrade')
    expect(await only()).toMatchObject({ name: 'Long-term', type: 'brokerage', balance: 5100 })
  })

  it('a removed account keeps the user edits while its balance stays current', async () => {
    await applySyncedAccounts([bank(420)], 'simplefin')
    await sheetSave({ type: 'credit', name: 'Rewards card' })
    await sheetSave({ deleted: true })
    await applySyncedAccounts([bank(435)], 'simplefin')
    expect(await only()).toMatchObject({ deleted: true, type: 'credit', name: 'Rewards card', balance: 435 })
  })

  it('nothing edited: the connector decides, as before', async () => {
    await applySyncedAccounts([bank(-300)], 'simplefin')
    expect(await only()).toMatchObject({ type: 'credit', balance: 300 })
    await applySyncedAccounts([bank(250)], 'simplefin')
    // A positive balance with nothing else to go on is a bank account in the black (bankRules.effectiveTier).
    expect(await only()).toMatchObject({ type: 'cash', balance: 250 })
  })
})
