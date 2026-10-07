/**
 * The Edge Function guesses an account's tier from its balance when the name
 * says nothing, so a card at $0 read as cash (its refund became income) and an
 * overdrawn checking read as credit (its payroll became a refund). The app reads
 * the account's name and keeps a card a card, so the same feed gives the same
 * rows whatever the balance did.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedTx } from './bankRules'
import type { SyncedAccount } from './brokerage'

const h = vi.hoisted(() => ({ feed: [] as unknown[], accounts: [] as unknown[] }))

vi.mock('../db/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async (_fn: string, opts: { body: { action: string } }) =>
        opts.body.action === 'transactions'
          ? { data: { ok: true, transactions: h.feed }, error: null }
          : { data: { ok: true, accounts: h.accounts }, error: null }),
    },
  },
}))

import { syncBankTransactions, syncBanks } from './banks'
import { db } from '../db/db'

const DAY = 86400
const T0 = Math.floor(Date.now() / 1000) - 20 * DAY

const acct = (id: string, name: string, tier: string, balance: number): SyncedAccount => ({
  sourceAccountId: `bank.test:${id}`, institution: 'Test Bank', name, tier: tier as SyncedAccount['tier'], balance, currency: 'USD',
})
const tx = (acctId: string, name: string, tier: string, id: string, day: number, amount: number, description: string): SyncedTx => ({
  sourceTxId: `bank.test:${acctId}:${id}`, account: `Test Bank ${name}`, tier, posted: T0 + day * DAY, amount,
  description, payee: description, memo: '', mcc: null,
})

const rows = async () =>
  (await db.transactions.toArray())
    .filter((t) => !t.deleted)
    .map((t) => [t.uid, t.type, t.amount, t.categoryId])
    .sort()

beforeEach(async () => {
  await db.categories.clear()
  await db.transactions.clear()
  await db.accounts.clear()
  await db.categories.bulkAdd([
    { id: 1, name: 'Shopping', icon: 'bag', color: '#fff', kind: 'expense', monthlyBudget: 400, sortOrder: 0, updatedAt: 0 },
    { id: 2, name: 'Salary', icon: 'briefcase', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 1, updatedAt: 0 },
    { id: 3, name: 'Other income', icon: 'plus', color: '#fff', kind: 'income', monthlyBudget: 0, sortOrder: 2, updatedAt: 0 },
    { id: 4, name: 'Other', icon: 'box', color: '#fff', kind: 'expense', monthlyBudget: 0, sortOrder: 3, updatedAt: 0 },
  ])
})

async function syncAt(accounts: SyncedAccount[], feed: SyncedTx[]) {
  h.accounts = accounts
  h.feed = feed
  await syncBanks()
  await syncBankTransactions()
}

describe('a card whose balance reads $0 or in your favour', () => {
  const GOLD = 'Test Bank Gold Card (0001)'
  const feed = (tier: string) => [
    tx('gold', GOLD, tier, 'buy', 0, -120, 'NORDSTROM #12'),
    tx('gold', GOLD, tier, 'back', 2, 84.5, 'NORDSTROM #12'),
    tx('gold', GOLD, tier, 'pay', 4, 1500, 'Payment Thank You-Mobile'),
  ]

  it('gives the same rows at −$842.10, $0.00 and +$84.50', async () => {
    const seen: unknown[] = []
    for (const [tier, bal] of [['credit', -842.1], ['cash', 0], ['cash', 84.5]] as const) {
      await syncAt([acct('gold', GOLD, tier, bal)], feed(tier))
      seen.push(await rows())
      expect((await db.accounts.toArray())[0].type).toBe('credit')
    }
    expect(seen[0]).toEqual([
      ['sf:bank.test:gold:back', 'expense', -84.5, 1],
      ['sf:bank.test:gold:buy', 'expense', 120, 1],
    ])
    expect(seen[1]).toEqual(seen[0])
    expect(seen[2]).toEqual(seen[0])
  })

  it('a card the name does not identify stays a card once seen as one', async () => {
    const NAME = 'Mystery Rewards (1111)'
    const f = (tier: string) => [tx('m', NAME, tier, 'buy', 0, -120, 'NORDSTROM #12'), tx('m', NAME, tier, 'back', 2, 84.5, 'NORDSTROM #12')]
    await syncAt([acct('m', NAME, 'credit', -200)], f('credit'))
    const first = await rows()
    await syncAt([acct('m', NAME, 'cash', 0)], f('cash'))
    expect(await rows()).toEqual(first)
    expect((await db.accounts.toArray())[0].type).toBe('credit')
  })
})

describe('an account the name does not identify, overdrawn once', () => {
  const NAME = 'Spending Account (4242)'

  it('keeps its payroll as income, overdrawn and after', async () => {
    const f = (tier: string) => [
      tx('sp', NAME, tier, 'old', -30, -20, 'CORNER STORE'),
      tx('sp', NAME, tier, 'pay', 0, 2500, 'ACME PAYROLL'),
    ]
    await syncAt([acct('sp', NAME, 'credit', -35.5)], f('credit'))
    expect(await rows()).toEqual([
      ['sf:bank.test:sp:old', 'expense', 20, 1],
      ['sf:bank.test:sp:pay', 'income', 2500, 2],
    ])
    await syncAt([acct('sp', NAME, 'cash', 1200)], f('cash'))
    expect(await rows()).toEqual([
      ['sf:bank.test:sp:old', 'expense', 20, 1],
      ['sf:bank.test:sp:pay', 'income', 2500, 2],
    ])
    const [a] = await db.accounts.toArray()
    expect(a.type).toBe('cash')
    expect(a.balance).toBe(1200)
  })

  it('with no rows that say what it is, goes back to cash once the balance is positive', async () => {
    const f = (tier: string) => [
      tx('sp', NAME, tier, 'old', -30, -20, 'CORNER STORE'),
      tx('sp', NAME, tier, 'in', 0, 500, 'ACME CORP'),
    ]
    await syncAt([acct('sp', NAME, 'credit', -35.5)], f('credit'))
    expect((await db.accounts.toArray())[0].type).toBe('credit')
    await syncAt([acct('sp', NAME, 'cash', 1200)], f('cash'))
    const [a] = await db.accounts.toArray()
    expect(a.type).toBe('cash')
    expect(a.balance).toBe(1200)
    expect(await rows()).toEqual([
      ['sf:bank.test:sp:in', 'income', 500, 3],
      ['sf:bank.test:sp:old', 'expense', 20, 1],
    ])
  })

  it('a card paid off and now in your favour stays a card', async () => {
    const CARD = 'Mystery Rewards (1111)'
    const f = (tier: string) => [
      tx('m', CARD, tier, 'buy', 0, -120, 'BIG STORE #12'),
      tx('m', CARD, tier, 'pay', 2, 1500, 'AUTOPAY PAYMENT - THANK YOU'),
      tx('m', CARD, tier, 'back', 4, 61.25, 'BIG STORE #12'),
    ]
    await syncAt([acct('m', CARD, 'credit', -200)], f('credit'))
    const first = await rows()
    expect(first).toEqual([
      ['sf:bank.test:m:back', 'expense', -61.25, 1],
      ['sf:bank.test:m:buy', 'expense', 120, 1],
    ])
    await syncAt([acct('m', CARD, 'cash', 61.25)], f('cash'))
    expect(await rows()).toEqual(first)
    const [a] = await db.accounts.toArray()
    expect(a.type).toBe('credit')
    expect(a.balance).toBe(-61.25)
  })

  it('found to be a bank account by its rows, it moves to cash at once, balance and all', async () => {
    // The balance sync ran first and saw only a negative balance.
    h.accounts = [acct('sp', NAME, 'credit', -35.5)]
    await syncBanks()
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'credit', balance: 35.5 })
    h.feed = [tx('sp', NAME, 'credit', 'old', -30, -20, 'CORNER STORE'), tx('sp', NAME, 'credit', 'pay', 0, 2500, 'ACME PAYROLL')]
    await syncBankTransactions()
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'cash', balance: -35.5, rowsSay: 'cash' })
    // And the next balance sync keeps it there.
    await syncBanks()
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'cash', balance: -35.5 })
  })
})

describe('an overdrawn checking account', () => {
  const CKG = 'TEST CLIENT CKG PLUS (0002)'
  it('keeps payroll, Zelle and interest as income', async () => {
    await syncAt([acct('ckg', CKG, 'credit', -35.5)], [
      // An older row, so the rows below sit clear of the feed's oldest days.
      tx('ckg', CKG, 'credit', 'old', -30, -20, 'CORNER STORE'),
      tx('ckg', CKG, 'credit', 'pay', 0, 2500, 'ACME PAYROLL'),
      tx('ckg', CKG, 'credit', 'zelle', 1, 60, 'ZELLE FROM JOHN'),
      tx('ckg', CKG, 'credit', 'int', 2, 0.01, 'INTEREST PAYMENT'),
    ])
    expect(await rows()).toEqual([
      ['sf:bank.test:ckg:int', 'income', 0.01, 3],
      ['sf:bank.test:ckg:old', 'expense', 20, 1],
      ['sf:bank.test:ckg:pay', 'income', 2500, 2],
      ['sf:bank.test:ckg:zelle', 'income', 60, 3],
    ])
    expect((await db.accounts.toArray())[0].type).toBe('cash')
  })
})

// The first sync on a fresh or wiped device fetches accounts and transactions
// side by side, so no account is stored yet; an account can also be skipped
// (no balance) or tombstoned. The row's own account label still decides.
describe('rows whose account is not stored', () => {
  it("a $0 card's refund still offsets spending", async () => {
    h.feed = [
      tx('gold', 'Test Bank Gold Card (0001)', 'cash', 'old', -30, -20, 'NORDSTROM #12'),
      tx('gold', 'Test Bank Gold Card (0001)', 'cash', 'back', 2, 84.5, 'NORDSTROM #12'),
    ]
    expect(await db.accounts.count()).toBe(0)
    await syncBankTransactions()
    expect(await rows()).toEqual([
      ['sf:bank.test:gold:back', 'expense', -84.5, 1],
      ['sf:bank.test:gold:old', 'expense', 20, 1],
    ])
  })

  it("an overdrawn checking's payroll stays income", async () => {
    const CKG = 'TEST CLIENT CKG PLUS (0002)'
    h.feed = [
      tx('ckg', CKG, 'credit', 'old', -30, -20, 'CORNER STORE'),
      tx('ckg', CKG, 'credit', 'pay', 0, 2500, 'ACME PAYROLL'),
    ]
    await syncBankTransactions()
    expect(await rows()).toEqual([
      ['sf:bank.test:ckg:old', 'expense', 20, 1],
      ['sf:bank.test:ckg:pay', 'income', 2500, 2],
    ])
  })

  it("reads the account's own name when the Edge Function sends it, not the institution's words", async () => {
    const LABEL = 'Test Investments Rewards Visa (1234)'
    h.feed = [
      { ...tx('rv', 'x', 'cash', 'old', -30, -20, 'NORDSTROM #12'), account: LABEL, accountName: 'Rewards Visa (1234)' },
      { ...tx('rv', 'x', 'cash', 'back', 2, 84.5, 'NORDSTROM #12'), account: LABEL, accountName: 'Rewards Visa (1234)' },
    ]
    await syncBankTransactions()
    expect(await rows()).toEqual([
      ['sf:bank.test:rv:back', 'expense', -84.5, 1],
      ['sf:bank.test:rv:old', 'expense', 20, 1],
    ])
  })

  it('a tombstoned account is read by its label too', async () => {
    await db.accounts.add({
      name: 'Test Bank Gold Card (0001)', institution: 'Test Bank', type: 'cash', balance: 0, liveSync: true,
      source: 'simplefin', sourceAccountId: 'bank.test:gold', lastUpdated: 0, sortOrder: 0, deleted: true, updatedAt: 0,
    })
    h.feed = [
      tx('gold', 'Test Bank Gold Card (0001)', 'cash', 'old', -30, -20, 'NORDSTROM #12'),
      tx('gold', 'Test Bank Gold Card (0001)', 'cash', 'back', 2, 84.5, 'NORDSTROM #12'),
    ]
    await syncBankTransactions()
    expect(await rows()).toEqual([
      ['sf:bank.test:gold:back', 'expense', -84.5, 1],
      ['sf:bank.test:gold:old', 'expense', 20, 1],
    ])
  })
})

describe('a type the user set by hand on a live account', () => {
  const RW = 'Everyday Rewards (9999)'
  // The credit sits past the feed's oldest days, where a bank-account row no rule names is held.
  const feed = () => [tx('rw', RW, 'cash', 'buy', 1, -40, 'NORDSTROM #12'), tx('rw', RW, 'cash', 'back', 10, 25, 'NORDSTROM #12')]

  it("decides how the account's rows are read, and holds through the balance sync and what the rows say", async () => {
    await syncAt([acct('rw', RW, 'cash', 420)], feed())
    // Read as a bank account: the merchant's credit is income.
    expect(await rows()).toEqual([
      ['sf:bank.test:rw:back', 'income', 25, 3],
      ['sf:bank.test:rw:buy', 'expense', 40, 1],
    ])
    const a = (await db.accounts.toArray())[0]
    await db.accounts.update(a.id!, { type: 'credit', updatedAt: Date.now() })
    // A payroll credit says 'bank account'; the user said card.
    await syncAt([acct('rw', RW, 'cash', 435)], [...feed(), tx('rw', RW, 'cash', 'pay', 12, 100, 'ACME PAYROLL')])
    expect((await db.accounts.toArray())[0]).toMatchObject({ type: 'credit', balance: 435 })
    const read = await rows()
    expect(read).toContainEqual(['sf:bank.test:rw:back', 'expense', -25, 1])
    expect(read).toContainEqual(['sf:bank.test:rw:buy', 'expense', 40, 1])
  })

  it('a renamed account is still matched to its rows by the bank\'s own name', async () => {
    await syncAt([acct('rw', RW, 'credit', -300)], [])
    const a = (await db.accounts.toArray())[0]
    await db.accounts.update(a.id!, { name: 'Rewards card', updatedAt: Date.now() })
    // A row that names its account only by the label (no account id in it).
    h.feed = [{ ...tx('zz', RW, 'cash', 'back', 2, 25, 'NORDSTROM #12'), sourceTxId: 'other:back' }]
    await syncBankTransactions()
    expect(await rows()).toEqual([['sf:other:back', 'expense', -25, 1]])
  })
})
