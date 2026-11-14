import { db, type Account, type Category, type Transaction } from '../../db/db'
import { currentMonth, shiftMonth, todayISO } from '../../lib/dates'
import { getPlan } from '../../lib/planCache'
import { capInForce } from '../../lib/savingsPlan'

/**
 * A made-up ledger to look around in, and what App Review sees: four months of
 * rows with budgets, accounts and insights to go with them. Every merchant and
 * figure is invented. Rows carry a `sample:` uid, so removing them finds exactly
 * these and nothing the user added beside them.
 */
const PREFIX = 'sample:'
/** Which budgets the sample set, so removing it leaves any the user changed. */
const BUDGETS_KEY = 'plainsum:sampleBudgets'

const BUDGETS: Record<string, number> = {
  groceries: 520,
  dining: 240,
  rent: 1850,
  transport: 140,
  subscriptions: 48,
  health: 90,
  shopping: 200,
  fun: 150,
}

const CHECKING = 'Sample Bank Checking'
const CARD = 'Sample Card Rewards'

interface Line {
  day: number
  key: string
  note: string
  amount: number
  /** The same every month: a bill or pay, not spending that moves. */
  fixed?: boolean
}

/** One month, in day order. Days stop at 28 so every month has them all. */
const MONTH: Line[] = [
  { day: 1, key: 'rent', note: 'Elm Street Rent', amount: 1850, fixed: true },
  { day: 1, key: 'salary', note: 'Bluebird Works Payroll', amount: 2850, fixed: true },
  { day: 2, key: 'groceries', note: 'Corner Market', amount: 86.42 },
  { day: 3, key: 'dining', note: 'Harbor Coffee', amount: 14.5 },
  { day: 4, key: 'subscriptions', note: 'Streamly', amount: 12.99, fixed: true },
  { day: 5, key: 'transport', note: 'City Transit Pass', amount: 38, fixed: true },
  { day: 6, key: 'dining', note: 'Maple Street Kitchen', amount: 46.8 },
  { day: 8, key: 'groceries', note: 'Greenleaf Grocers', amount: 112.37 },
  { day: 9, key: 'shopping', note: 'Lantern Books', amount: 64.25 },
  { day: 10, key: 'fun', note: 'Paper Moon Cinema', amount: 32 },
  { day: 11, key: 'health', note: 'Oakline Pharmacy', amount: 28.4 },
  { day: 12, key: 'subscriptions', note: 'Northside Gym', amount: 34, fixed: true },
  { day: 13, key: 'transport', note: 'Ridewell', amount: 22.75 },
  { day: 14, key: 'dining', note: 'Little Fig Bistro', amount: 58.1 },
  { day: 15, key: 'salary', note: 'Bluebird Works Payroll', amount: 2850, fixed: true },
  { day: 16, key: 'groceries', note: 'Corner Market', amount: 94.18 },
  { day: 18, key: 'shopping', note: 'Marlow Goods', amount: 88.9 },
  { day: 19, key: 'fun', note: 'Tidepool Arcade', amount: 41.5 },
  { day: 21, key: 'dining', note: 'Harbor Coffee', amount: 23.6 },
  { day: 22, key: 'groceries', note: 'Greenleaf Grocers', amount: 101.66 },
  { day: 24, key: 'transport', note: 'Ridewell', amount: 41.2 },
  { day: 25, key: 'dining', note: 'Maple Street Kitchen', amount: 39.75 },
  { day: 27, key: 'groceries', note: 'Corner Market', amount: 73.05 },
  { day: 28, key: 'shopping', note: 'Marlow Goods', amount: 47.3 },
]

/** The months before this one, nearest first: how far each one's spending moved. */
const PAST = [0.94, 1.07, 1.02]

/** This month always shows at least this many rows, even on the 1st. */
const MIN_THIS_MONTH = 10

const ACCOUNTS: Pick<Account, 'institution' | 'name' | 'type' | 'balance'>[] = [
  { institution: 'Sample Bank', name: 'Checking', type: 'cash', balance: 4218.36 },
  { institution: 'Sample Bank', name: 'Savings', type: 'cash', balance: 12500 },
  { institution: 'Sample Card', name: 'Rewards', type: 'credit', balance: 642.18 },
  { institution: 'Sample Brokerage', name: 'Index Fund', type: 'brokerage', balance: 18940.55 },
  { institution: 'Sample Brokerage', name: 'Retirement', type: 'retirement', balance: 41207.1 },
]

const pad = (n: number) => String(n).padStart(2, '0')
const cents = (n: number) => Math.round(n * 100) / 100
const paysFrom = (l: Line) => (l.fixed ? CHECKING : CARD)

function rowsFor(categories: Category[], now: number): Transaction[] {
  const idOf = new Map(categories.filter((c) => c.key && !c.deleted).map((c) => [c.key!, c.id!]))
  const row = (month: string, day: number, l: Line, amount: number, n: number): Transaction => ({
    uid: `${PREFIX}${month}:${n}`,
    date: `${month}-${pad(day)}`,
    amount,
    type: l.key === 'salary' ? 'income' : 'expense',
    categoryId: idOf.get(l.key) ?? null,
    account: paysFrom(l),
    note: l.note,
    createdAt: now,
    updatedAt: now,
  })

  const rows: Transaction[] = []
  PAST.forEach((by, i) => {
    const month = shiftMonth(currentMonth(), -(i + 1))
    MONTH.forEach((l, n) => rows.push(row(month, l.day, l, l.fixed ? l.amount : cents(l.amount * by), n)))
  })

  // This month is squeezed into the days it has had, so nothing is dated ahead of
  // today, and even the 1st has something to show.
  const month = currentMonth()
  const today = Number(todayISO().slice(8, 10))
  const dayOf = (d: number) => Math.max(1, Math.ceil((d * Math.min(today, 28)) / 28))
  const keep = Math.max(MIN_THIS_MONTH, Math.ceil((MONTH.length * today) / 28))
  MONTH.slice(0, keep).forEach((l, n) => rows.push(row(month, dayOf(l.day), l, l.amount, n)))
  // So any day of the month shows the rest of the app: a refund, a row with no
  // category, and one big dinner that puts Dining over its budget.
  const extras: Line[] = [
    { day: 9, key: 'shopping', note: 'Lantern Books Refund', amount: -18.4 },
    { day: 7, key: 'none', note: 'Ledgerline Supply', amount: 27.35 },
    { day: 8, key: 'dining', note: 'Little Fig Bistro', amount: 180 },
  ]
  extras.forEach((l, i) => rows.push(row(month, dayOf(l.day), l, l.amount, MONTH.length + i)))
  return rows
}

function readBudgets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BUDGETS_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function writeBudgets(set: Record<string, number> | null): void {
  try {
    if (set) localStorage.setItem(BUDGETS_KEY, JSON.stringify(set))
    else localStorage.removeItem(BUDGETS_KEY)
  } catch {
    /* storage blocked: the budgets stay when the sample goes */
  }
}

export async function hasSampleData(): Promise<boolean> {
  return (await db.accounts.where('uid').startsWith(PREFIX).count()) > 0
}

/**
 * Add the sample ledger. Budgets the user already set stay theirs. While a
 * savings plan is locked, category budgets are how its budget is split, so the
 * sample sets none at all and records none: removing it later zeroes none.
 */
export async function loadSampleData(): Promise<void> {
  const now = Date.now()
  const locked = capInForce(getPlan(), todayISO()) != null
  await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
    if (await hasSampleData()) return
    const categories = await db.categories.toArray()
    const set: Record<string, number> = {}
    for (const c of categories) {
      const budget = c.key ? BUDGETS[c.key] : undefined
      if (locked || c.id == null || c.deleted || !budget || c.monthlyBudget > 0) continue
      await db.categories.update(c.id, { monthlyBudget: budget, updatedAt: now })
      set[c.key!] = budget
    }
    writeBudgets(set)
    const order = (await db.accounts.toArray()).reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1
    await db.accounts.bulkAdd(
      ACCOUNTS.map((a, i) => ({
        ...a,
        uid: `${PREFIX}account:${i}`,
        liveSync: false,
        lastUpdated: now,
        updatedAt: now,
        sortOrder: order + i,
      })),
    )
    await db.transactions.bulkAdd(rowsFor(categories, now))
  })
}

/** Take the sample away. Anything the user added or changed beside it stays. */
export async function removeSampleData(): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', db.categories, db.transactions, db.accounts, async () => {
    await db.transactions.where('uid').startsWith(PREFIX).delete()
    await db.accounts.where('uid').startsWith(PREFIX).delete()
    const set = readBudgets()
    for (const c of await db.categories.toArray()) {
      if (c.id != null && c.key && set[c.key] === c.monthlyBudget) {
        await db.categories.update(c.id, { monthlyBudget: 0, updatedAt: now })
      }
    }
  })
  writeBudgets(null)
}
