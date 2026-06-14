import Dexie, { type Table } from 'dexie'

export type TxType = 'expense' | 'income'

export interface Category {
  id?: number
  /** Global id shared across devices — the key the sync layer matches on. */
  uid?: string
  name: string
  /** Icon key into the set in components/Icon.tsx (e.g. 'cart'). */
  icon: string
  color: string
  kind: TxType
  /** Recurring monthly budget. 0 = no budget set. Only meaningful for expense categories. */
  monthlyBudget: number
  sortOrder: number
  /** Soft-delete tombstone so deletions propagate through sync. */
  deleted?: boolean
  updatedAt: number
}

export interface Transaction {
  id?: number
  uid?: string
  /** ISO date, YYYY-MM-DD (local). */
  date: string
  /** Always stored positive; `type` carries the direction. */
  amount: number
  type: TxType
  categoryId: number | null
  account: string
  note: string
  deleted?: boolean
  createdAt: number
  updatedAt: number
}

function newUid(): string {
  return crypto.randomUUID()
}

/**
 * Local-first store (IndexedDB via Dexie). Local primary keys stay numeric
 * auto-increment; cross-device identity rides on `uid` (Dexie can't change a
 * primary key on upgrade). Every row carries `updatedAt` (last-write-wins) and
 * `deleted` (tombstone) so the sync layer in src/sync has a clean seam.
 */
export class TallyDB extends Dexie {
  categories!: Table<Category, number>
  transactions!: Table<Transaction, number>

  constructor() {
    super('tally')
    this.version(1).stores({
      categories: '++id, name, kind, sortOrder',
      transactions: '++id, date, type, categoryId',
    })
    // v2: add the global `uid` index + soft-delete, backfilling existing rows.
    this.version(2)
      .stores({
        categories: '++id, uid, name, kind, sortOrder',
        transactions: '++id, uid, date, type, categoryId',
      })
      .upgrade(async (tx) => {
        await tx.table('categories').toCollection().modify((c: Category) => {
          if (!c.uid) c.uid = newUid()
          if (c.deleted === undefined) c.deleted = false
        })
        await tx.table('transactions').toCollection().modify((t: Transaction) => {
          if (!t.uid) t.uid = newUid()
          if (t.deleted === undefined) t.deleted = false
        })
      })

    // Auto-stamp uid + deleted on every new row so component creation sites
    // don't need to know about sync.
    this.categories.hook('creating', (_pk, obj: Category) => {
      if (!obj.uid) obj.uid = newUid()
      if (obj.deleted === undefined) obj.deleted = false
    })
    this.transactions.hook('creating', (_pk, obj: Transaction) => {
      if (!obj.uid) obj.uid = newUid()
      if (obj.deleted === undefined) obj.deleted = false
    })
  }
}

export const db = new TallyDB()
