import Dexie, { type Table } from 'dexie'
import { builtInKey, isFixedCategory } from '../lib/categorize'

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
  /** The seeded category this row started as ('rent', 'other income'). Kept
   *  through renames; unset for categories the user adds. */
  key?: string
  /** A fixed monthly bill: projected at its budget, never paced. Unset = by key. */
  fixed?: boolean
  /** Soft-delete tombstone so deletions propagate through sync. */
  deleted?: boolean
  /** Local only, never synced: a default seeded on this device that no cloud
   *  row has claimed yet and the user has not edited. The first pull keeps it
   *  only if the account adopts it or a transaction uses it (sync.ts). */
  seeded?: boolean
  updatedAt: number
}

export interface Transaction {
  id?: number
  uid?: string
  /** ISO date, YYYY-MM-DD (local). */
  date: string
  /** Positive; `type` carries the direction. The one exception is a merchant
   *  refund: an expense with a NEGATIVE amount, which offsets its category. */
  amount: number
  type: TxType
  categoryId: number | null
  account: string
  note: string
  /** User-edited (recategorized / redated) — bank re-syncs must not overwrite it. */
  manual?: boolean
  /** Local only, never synced: the day the bank posted this row, kept when the
   *  stored date is another one (rent paid early is dated the 1st it pays for,
   *  bankRules.rentDate), and on every pending row from the start. Moving the
   *  row out of Rent puts that day back (bankRules.rentRedate). On a pending
   *  row it follows the bank's day, and so does the date of a pinned one the
   *  user never moved, so a pinned pending row whose date differs from it was
   *  moved (by the user, another device or a re-file into Rent), and the move
   *  goes with it when it posts under a new id (banks.ts). The bank sync fills
   *  it on every device it runs on. */
  posted?: string
  /** Local only, never synced: the date was set here, by the user (the sheet,
   *  Tell Tally) or by a re-file into Rent, to a day other than the bank's own
   *  (`posted`). The bank never re-dates such a pending row, and the date goes
   *  with it when it posts under a new id, even when the bank later gives the
   *  hold that same day (banks.ts). The bank's own day put back clears it. */
  dateMoved?: boolean
  /** Local only, never synced: the bank's own words for a pending row, so a
   *  note the user typed on it goes with it when it posts under a new id
   *  (banks.ts), and the bank's words never do. While the note is still these
   *  words, it follows the bank's (a 'Debit' stand-in gives way to the
   *  merchant's name when the row posts under the same id). */
  bankNote?: string
  /** Authorised but not yet posted by the bank. Counts toward spend, shown as pending. */
  pending?: boolean
  /** The user cleared the category on purpose: the self-heal must not re-file it. */
  uncategorized?: boolean
  /** Synced (column `retired_pin`): a pinned pending charge retired because
   *  the bank stopped listing it (banks.ts), not hidden by the user, with no
   *  posted row found for it. If the bank lists it again under the same id, it
   *  comes back with the user's edits, on whichever device sees that first.
   *  Kept on one device only, every other device had a tombstone it could not
   *  bring back. A cloud without the column keeps it on the device. */
  retiredPin?: boolean
  /** Synced (column `retired`): a pinned pending row the bank retired when it
   *  posted under a new id or the hold was dropped (banks.ts). Its tombstone is
   *  the bank's, not the user's Delete, so it is never offered back as Removed:
   *  restoring it counted the charge twice beside its posted row. */
  retired?: boolean
  deleted?: boolean
  createdAt: number
  updatedAt: number
}

/** Net-worth tiers, top (most liquid) to bottom. `credit` is a liability. */
export type AccountType = 'cash' | 'credit' | 'brokerage' | 'retirement' | 'benefit'

export interface Account {
  id?: number
  uid?: string
  name: string
  institution: string
  type: AccountType
  /** Manual balance. Assets positive; for `credit`, the amount OWED (positive). */
  balance: number
  /** false = manual entry; true = fed by a live connector (later). */
  liveSync: boolean
  /** Provider account id when live-synced (dedup/re-sync key). */
  sourceAccountId?: string
  /** Which connector feeds this row when live: 'snaptrade' | 'teller'. Undefined = manual. Scopes orphan reconciliation per provider. */
  source?: string
  lastUpdated: number
  sortOrder: number
  archived?: boolean
  deleted?: boolean
  /** Local only: what a bank account's own rows say it is (bankRules.tierFromRows),
   *  remembered for when its name and balance cannot tell (banks.ts). */
  rowsSay?: 'cash' | 'credit'
  /** Synced (column `source_said`): what the connector last said about a live
   *  account. An institution, name or type that differs from it was set by the
   *  user (lib/accountEdits.ts), and the next sync leaves it as it is. */
  sourceSaid?: SourceSaid
  updatedAt: number
}

/** A connector's own view of an account (Account.sourceSaid). */
export interface SourceSaid {
  institution: string
  /** The name as stored (brokerage.cleanName), mask included. */
  name: string
  /** The tier the connector's rules gave it (bankRules.effectiveTier for a bank). */
  type: AccountType
  /** The provider's own signed figure: an owed card reads negative, unless
   *  that bank reports cards the other way (the user sets Credit by hand). */
  balance: number
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
  accounts!: Table<Account, number>

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
    // v3: accounts (net-worth / tiering). Manual now, connector-fed later.
    this.version(3).stores({
      categories: '++id, uid, name, kind, sortOrder',
      transactions: '++id, uid, date, type, categoryId',
      accounts: '++id, uid, type, sortOrder',
    })
    // v4: categories carry their built-in key and a fixed flag, so a rename no
    // longer switches off fixed-bill projection or rent dating. updatedAt is
    // left alone: a backfill stamped now would out-vote the cloud everywhere.
    this.version(4)
      .stores({
        categories: '++id, uid, name, kind, sortOrder',
        transactions: '++id, uid, date, type, categoryId',
        accounts: '++id, uid, type, sortOrder',
      })
      .upgrade(async (tx) => {
        await tx.table('categories').toCollection().modify((c: Category) => {
          if (c.key === undefined) {
            const k = builtInKey(c.name)
            if (k) c.key = k
          }
          if (c.fixed === undefined) c.fixed = isFixedCategory(c.name)
        })
      })

    // Auto-stamp uid + deleted on every new row so component creation sites
    // don't need to know about sync.
    this.categories.hook('creating', (_pk, obj: Category) => {
      if (!obj.uid) obj.uid = newUid()
      if (obj.deleted === undefined) obj.deleted = false
    })
    // Any edit makes a seeded default the user's own, so the first pull keeps it.
    this.categories.hook('updating', (mods, _pk, obj: Category) => {
      if (obj.seeded && !Object.prototype.hasOwnProperty.call(mods, 'seeded')) return { seeded: false }
    })
    this.transactions.hook('creating', (_pk, obj: Transaction) => {
      if (!obj.uid) obj.uid = newUid()
      if (obj.deleted === undefined) obj.deleted = false
    })
    this.accounts.hook('creating', (_pk, obj: Account) => {
      if (!obj.uid) obj.uid = newUid()
      if (obj.deleted === undefined) obj.deleted = false
    })
  }
}

export const db = new TallyDB()
