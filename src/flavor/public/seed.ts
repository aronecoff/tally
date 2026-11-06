import { db, type Category } from '../../db/db'
import { listBackups } from '../../lib/backup'
import { builtInKey, isFixedCategory } from '../../lib/categorize'

type SeedCategory = Omit<Category, 'id' | 'updatedAt'>

/** The personal defaults' names, icons, colours and order, with no one's budgets. */
const DEFAULTS: SeedCategory[] = [
  // Expenses
  { name: 'Groceries', icon: 'cart', color: '#4ade80', kind: 'expense', monthlyBudget: 0, sortOrder: 0 },
  { name: 'Dining', icon: 'utensils', color: '#fb7185', kind: 'expense', monthlyBudget: 0, sortOrder: 1 },
  { name: 'Rent', icon: 'home', color: '#60a5fa', kind: 'expense', monthlyBudget: 0, sortOrder: 2 },
  { name: 'Transport', icon: 'car', color: '#fbbf24', kind: 'expense', monthlyBudget: 0, sortOrder: 3 },
  { name: 'Subscriptions', icon: 'repeat', color: '#a78bfa', kind: 'expense', monthlyBudget: 0, sortOrder: 4 },
  { name: 'Health', icon: 'heart', color: '#f472b6', kind: 'expense', monthlyBudget: 0, sortOrder: 5 },
  { name: 'Shopping', icon: 'bag', color: '#38bdf8', kind: 'expense', monthlyBudget: 0, sortOrder: 6 },
  { name: 'Fun', icon: 'sparkles', color: '#fb923c', kind: 'expense', monthlyBudget: 0, sortOrder: 7 },
  { name: 'Other', icon: 'box', color: '#94a3b8', kind: 'expense', monthlyBudget: 0, sortOrder: 8 },
  // Income
  { name: 'Salary', icon: 'briefcase', color: '#34d399', kind: 'income', monthlyBudget: 0, sortOrder: 9 },
  { name: 'Freelance', icon: 'receipt', color: '#2dd4bf', kind: 'income', monthlyBudget: 0, sortOrder: 10 },
  { name: 'Other income', icon: 'plus-circle', color: '#a3e635', kind: 'income', monthlyBudget: 0, sortOrder: 11 },
]

/** The default set as rows to add. */
export function defaultCategories(): Category[] {
  const now = Date.now()
  return DEFAULTS.map((c) => ({ ...c, key: builtInKey(c.name), fixed: isFixedCategory(c.name), updatedAt: now }))
}

/**
 * A device with no categories starts from the defaults, unless it has backups:
 * then its storage was lost, not new, and FirstRun offers them first. A fresh
 * install has no backups, and Erase removes them.
 */
export async function seedIfEmpty(): Promise<void> {
  if ((await db.categories.count()) > 0) return
  if ((await listBackups()).length > 0) return
  await seedDefaults()
}

/** The defaults, on a device that has no categories. */
export async function seedDefaults(): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    if ((await db.categories.count()) > 0) return
    await db.categories.bulkAdd(defaultCategories())
  })
}
