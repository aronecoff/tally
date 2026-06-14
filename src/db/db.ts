import Dexie, { type Table } from 'dexie'

export type TxType = 'expense' | 'income'

export interface Category {
  id?: number
  name: string
  /** Icon key into the set in components/Icon.tsx (e.g. 'cart'). */
  icon: string
  color: string
  kind: TxType
  /** Recurring monthly budget. 0 = no budget set. Only meaningful for expense categories. */
  monthlyBudget: number
  sortOrder: number
  updatedAt: number
}

export interface Transaction {
  id?: number
  /** ISO date, YYYY-MM-DD (local). */
  date: string
  /** Always stored positive; `type` carries the direction. */
  amount: number
  type: TxType
  categoryId: number | null
  account: string
  note: string
  createdAt: number
  updatedAt: number
}

/**
 * Local-first store. Everything lives in IndexedDB via Dexie.
 *
 * Sync note: every row carries `updatedAt`. When we add Supabase sync later,
 * this becomes the conflict-resolution key (last-write-wins per row) and we add
 * a `version(2)` migration with `remoteId` / `deletedAt` columns — no table
 * rewrites needed. Keep all reads/writes going through this module so the sync
 * layer has a single seam to hook into.
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
  }
}

export const db = new TallyDB()
