import { db, type Category } from './db'
import { builtInKey, isFixedCategory } from '../lib/categorize'
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

/** The default set as rows to add. `seeded` marks a device-local seed (sync.ts). */
export function defaultCategories(seeded = false): Category[] {
  const now = Date.now()
  return DEFAULTS.map((c) => ({
    ...c,
    key: builtInKey(c.name),
    fixed: isFixedCategory(c.name),
    ...(seeded ? { seeded: true } : {}),
    updatedAt: now,
  }))
}

type Verdict = 'signed-out' | 'cloud-has' | 'cloud-empty' | 'unknown'
const CHECK_MS = 3000

/**
 * What the cloud says about seeding, within CHECK_MS. Offline, auth retries a
 * token refresh for about 25 s per call and postgrest retries the count with
 * backoff, and the boot skeleton waited on all of it. No answer is 'unknown'.
 */
async function cloudVerdict(): Promise<Verdict> {
  const sb = supabase!
  const check = (async (): Promise<Verdict> => {
    const { data } = await sb.auth.getSession()
    if (!data.session) return 'signed-out'
    const { count, error } = await sb
      .from('categories')
      .select('id', { count: 'exact', head: true })
      .retry(false)
      .abortSignal(AbortSignal.timeout(CHECK_MS))
    if (error || count == null) return 'unknown'
    return count > 0 ? 'cloud-has' : 'cloud-empty'
  })().catch((): Verdict => 'unknown')
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Verdict>((r) => {
    timer = setTimeout(() => r('unknown'), CHECK_MS)
  })
  try {
    return await Promise.race([check, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Populate default categories on first run only. Safe to call on every boot.
 *
 * A device that already has categories returns at once, before any network
 * call, so a signed-in launch with no connection paints straight away.
 *
 * Signed out (or a new account with an empty cloud), the defaults are seeded
 * and marked `seeded`: the first pull keeps only the ones the account adopts or
 * a transaction uses (sync.ts), so a default the account renamed does not come
 * back. Signed in with categories in the cloud, or with no answer, nothing is
 * seeded: the pull brings the account's own, and seeds if it finds none.
 *
 * The count-check and insert run inside one read-write transaction so they're
 * atomic — otherwise React StrictMode's double-invoked effect (or any two
 * concurrent callers) can both observe an empty table and seed twice.
 */
export async function seedIfEmpty(): Promise<void> {
  if ((await db.categories.count()) > 0) return
  if (supabase) {
    const verdict = await cloudVerdict()
    if (verdict === 'cloud-has' || verdict === 'unknown') return
  }
  await db.transaction('rw', db.categories, async () => {
    const count = await db.categories.count()
    if (count > 0) return
    await db.categories.bulkAdd(defaultCategories(true))
  })
}
