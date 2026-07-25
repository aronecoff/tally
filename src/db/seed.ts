import { db, type Category } from './db'
import { supabase } from './supabase'

type SeedCategory = Omit<Category, 'id' | 'updatedAt'>

const DEFAULTS: SeedCategory[] = [
  // Expenses
  { name: 'Groceries', icon: 'cart', color: '#4ade80', kind: 'expense', monthlyBudget: 600, sortOrder: 0 },
  { name: 'Dining', icon: 'utensils', color: '#fb7185', kind: 'expense', monthlyBudget: 300, sortOrder: 1 },
  { name: 'Rent', icon: 'home', color: '#60a5fa', kind: 'expense', monthlyBudget: 0, sortOrder: 2 },
  { name: 'Transport', icon: 'car', color: '#fbbf24', kind: 'expense', monthlyBudget: 150, sortOrder: 3 },
  { name: 'Subscriptions', icon: 'repeat', color: '#a78bfa', kind: 'expense', monthlyBudget: 50, sortOrder: 4 },
  { name: 'Health', icon: 'heart', color: '#f472b6', kind: 'expense', monthlyBudget: 100, sortOrder: 5 },
  { name: 'Shopping', icon: 'bag', color: '#38bdf8', kind: 'expense', monthlyBudget: 200, sortOrder: 6 },
  { name: 'Fun', icon: 'sparkles', color: '#fb923c', kind: 'expense', monthlyBudget: 150, sortOrder: 7 },
  { name: 'Other', icon: 'box', color: '#94a3b8', kind: 'expense', monthlyBudget: 0, sortOrder: 8 },
  // Income
  { name: 'Salary', icon: 'briefcase', color: '#34d399', kind: 'income', monthlyBudget: 0, sortOrder: 9 },
  { name: 'Freelance', icon: 'receipt', color: '#2dd4bf', kind: 'income', monthlyBudget: 0, sortOrder: 10 },
  { name: 'Other income', icon: 'plus-circle', color: '#a3e635', kind: 'income', monthlyBudget: 0, sortOrder: 11 },
]

/**
 * Populate default categories on first run only. Safe to call on every boot.
 *
 * The count-check and insert run inside one read-write transaction so they're
 * atomic — otherwise React StrictMode's double-invoked effect (or any two
 * concurrent callers) can both observe an empty table and seed twice.
 */
export async function seedIfEmpty(): Promise<void> {
  // When signed in, don't seed if the cloud already has categories — the pull
  // will bring them. Seeding here would create a duplicate set that gets pushed
  // alongside the cloud's. Only a genuinely new account (empty cloud) seeds.
  if (supabase) {
    try {
      const { data } = await supabase.auth.getSession()
      if (data.session) {
        const { count } = await supabase.from('categories').select('id', { count: 'exact', head: true })
        if ((count ?? 0) > 0) return
      }
    } catch {
      /* offline or auth hiccup — fall through to the local count check */
    }
  }
  await db.transaction('rw', db.categories, async () => {
    const count = await db.categories.count()
    if (count > 0) return
    const now = Date.now()
    await db.categories.bulkAdd(DEFAULTS.map((c) => ({ ...c, updatedAt: now })))
  })
}
