import { db, type Transaction } from '../db/db'

/**
 * One row of money, one row in the ledger, wherever it came from. A bank row is
 * known by its id (`sf:`), and a row from a file by the same kind of id, built
 * from the file (`file:`). Rows that carry neither, or that a bank and a file
 * word differently, are told apart by what they say.
 */

/** Every row a file brought in. The id comes from the file, so it holds on every device. */
export const FILE_UID = 'file:'

/** Days apart that two rows of one amount can still be one charge. */
const TWIN_DAYS = 3

export const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000

/** Words a bank adds to any charge's description, which say nothing of the merchant. */
const NOTE_FILLER = new Set([
  'pos', 'purchase', 'debit', 'credit', 'card', 'pending', 'ach', 'the', 'and', 'payment', 'www', 'com', 'net', 'inc',
  'llc', 'ref', 'online', 'recurring', 'visa', 'mastercard', 'auth', 'authorization', 'preauth', 'checkcard', 'check',
  'transaction', 'trans', 'des', 'web', 'ppd', 'ccd', 'paypal', 'tst', 'store', 'san', 'francisco', 'new', 'york',
])
/** The merchant words of a description: its first two of 3+ letters, filler left out
 *  (the place names banks append would match two different shops in one city). */
export function noteWords(note: string | undefined): Set<string> {
  const words = (note ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && /[a-z]/.test(w) && !NOTE_FILLER.has(w))
  return new Set(words.slice(0, 2))
}

type Worded = Pick<Transaction, 'date' | 'amount' | 'type' | 'note'>

/** The same day, the same money and the same words. */
export const rowKey = (t: Worded) => `${t.date}|${t.amount}|${t.type}|${t.note.trim().toLowerCase()}`

const moneyKey = (t: Pick<Transaction, 'amount' | 'type'>) => `${t.type}|${t.amount}`

/** The day a row happened: rent dating moves `date`, and keeps this beside it. */
const dayOf = (t: Pick<Transaction, 'date' | 'posted'>) => t.posted ?? t.date

/** Sure enough to act on with no one asked: the same day, or a word of the merchant in common. */
export function sureTwin(a: Pick<Transaction, 'note'>, b: Pick<Transaction, 'note'>, gap: number): boolean {
  if (gap === 0) return true
  const words = noteWords(a.note)
  return [...noteWords(b.note)].some((w) => words.has(w))
}

/** Takes rows out of a pool, closest day first, so each is only ever matched once. */
function twinPool(rows: Transaction[]) {
  const byMoney = new Map<string, Transaction[]>()
  for (const t of rows) {
    const k = moneyKey(t)
    const list = byMoney.get(k)
    if (list) list.push(t)
    else byMoney.set(k, [t])
  }
  return (row: Worded & Pick<Transaction, 'posted'>, sureOnly: boolean) => {
    const list = byMoney.get(moneyKey(row))
    let best: Transaction | undefined
    let bestGap = Infinity
    for (const t of list ?? []) {
      const gap = dayGap(dayOf(t), dayOf(row))
      if (gap <= TWIN_DAYS && gap < bestGap && (!sureOnly || sureTwin(t, row, gap))) {
        best = t
        bestGap = gap
      }
    }
    if (best) list!.splice(list!.indexOf(best), 1)
    return best
  }
}

export interface Identified extends Worded {
  uid: string
  posted?: string
  account?: string
}

/** Two files that name their accounts, and not the same one: alike, but not one row. */
const otherAccount = (row: Identified, held: Transaction) =>
  row.uid.startsWith(FILE_UID) && !!held.uid?.startsWith(FILE_UID) && !!row.account && !!held.account && row.account !== held.account

export interface LedgerMatch<T> {
  /** Not in the ledger. */
  fresh: T[]
  /** In the ledger already, by id or by what they say. */
  here: T[]
  /** Removed from the ledger by hand or by a bank, so they stay out. */
  removed: T[]
  /** Rows the same in money and day as a live ledger row, and not that row. */
  twins: Map<T, Transaction>
}

/**
 * Where each incoming row stands against the ledger. Rows are matched one for
 * one: two coffees on the same day are two rows, so both come in, and bringing
 * the same file in again adds nothing. A twin is only a question for someone who
 * will see it, so with no one to ask, `sureOnly` keeps to the ones that are sure.
 */
export function matchLedger<T extends Identified>(
  incoming: readonly T[],
  ledger: readonly Transaction[],
  { sureOnly = false }: { sureOnly?: boolean } = {},
): LedgerMatch<T> {
  const byUid = new Map<string, Transaction>()
  for (const t of ledger) if (t.uid) byUid.set(t.uid, t)
  const out: LedgerMatch<T> = { fresh: [], here: [], removed: [], twins: new Map() }

  const taken = new Set<Transaction>()
  const unknown: T[] = []
  for (const row of incoming) {
    const held = byUid.get(row.uid)
    if (!held) {
      unknown.push(row)
      continue
    }
    taken.add(held)
    ;(held.deleted ? out.removed : out.here).push(row)
  }

  const live = ledger.filter((t) => !t.deleted && !taken.has(t))
  const byKey = new Map<string, Transaction[]>()
  for (const t of live) {
    const k = rowKey(t)
    const list = byKey.get(k)
    if (list) list.push(t)
    else byKey.set(k, [t])
  }
  const worded: T[] = []
  for (const row of unknown) {
    const list = byKey.get(rowKey(row)) ?? []
    const at = list.findLastIndex((t) => !otherAccount(row, t))
    if (at < 0) {
      worded.push(row)
      continue
    }
    taken.add(list.splice(at, 1)[0])
    out.here.push(row)
  }

  const take = twinPool(live.filter((t) => !taken.has(t)))
  for (const row of worded) {
    const twin = take(row, sureOnly)
    if (twin) out.twins.set(row, twin)
    out.fresh.push(row)
  }
  // Last, so a removed row never takes a twin from a new one.
  for (const row of out.removed) {
    const twin = take(row, sureOnly)
    if (twin) out.twins.set(row, twin)
  }
  return out
}

/**
 * New bank rows meet what a file brought in earlier. The bank's copy stands, and
 * the file's goes, so a statement imported before a bank was linked does not
 * count twice. Nothing here runs unless a file was imported. No one is asked, so
 * it has to be sure (`sureTwin`). A row a person edited hands its edits on. The
 * file's row stays in Activity's Removed, so a wrong match can be put back.
 */
export async function retireFileTwins(incoming: Transaction[], now: number): Promise<void> {
  const fileRows = await db.transactions.where('uid').startsWith(FILE_UID).filter((t) => !t.deleted).toArray()
  if (fileRows.length === 0) return
  const take = twinPool(fileRows)
  for (const row of incoming) {
    if (row.pending) continue
    const twin = take(row, true)
    if (!twin) continue
    if (twin.manual) Object.assign(row, { categoryId: twin.categoryId, note: twin.note, manual: true })
    await db.transactions.update(twin.id!, { deleted: true, manual: true, updatedAt: now })
  }
}
