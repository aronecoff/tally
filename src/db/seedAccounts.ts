import { db, type Account, type AccountType } from './db'

type SeedAccount = { name: string; institution: string; type: AccountType }

// Aron's real accounts (from reference_financial_accounts). Seeded as manual
// shells with $0 — he fills balances; live connectors attach later.
const DEFAULTS: SeedAccount[] = [
  // Cash
  { name: 'Checking', institution: 'Citizens', type: 'cash' },
  { name: 'Savings', institution: 'Citizens', type: 'cash' },
  { name: 'Checking', institution: 'Chase', type: 'cash' },
  { name: 'Savings (HYSA)', institution: 'Amex', type: 'cash' },
  // Credit
  { name: 'Credit Card', institution: 'Chase', type: 'credit' },
  { name: 'Credit Card', institution: 'Amex', type: 'credit' },
  { name: 'Gold Card', institution: 'Robinhood', type: 'credit' },
  // Brokerage
  { name: 'Brokerage (margin)', institution: 'Robinhood', type: 'brokerage' },
  { name: 'Brokerage', institution: 'Webull', type: 'brokerage' },
  // Retirement
  { name: '401(k)', institution: 'Schwab', type: 'retirement' },
]

export async function seedAccountsIfEmpty(): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const count = await db.accounts.count()
    if (count > 0) return
    const now = Date.now()
    await db.accounts.bulkAdd(
      DEFAULTS.map((a, i) => ({
        ...a,
        balance: 0,
        liveSync: false,
        lastUpdated: now,
        sortOrder: i,
        updatedAt: now,
      })) as Account[],
    )
  })
}
