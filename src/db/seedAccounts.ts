import { db, type Account, type AccountType } from './db'

type SeedAccount = { name: string; institution: string; type: AccountType }

// Starter accounts (none by default). Seeded as manual
// shells with $0; live connectors attach later.
const DEFAULTS: SeedAccount[] = [
  // Cash
  
  
  
  
  // Credit
  
  
  
  // Brokerage
  
  
  // Retirement
  
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
