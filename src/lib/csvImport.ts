import { db, type Category, type Transaction } from '../db/db'
import { classifyBankTx, rentDate, type SyncedTx } from './bankRules'
import { categorize, findCategoryFor, isRentCategory } from './categorize'
import { isBalanceLine, isMarked, isOwnMoney, isWide, parseAmount, parseDate, rowFigure, saysRefund, saysWay, undoesSpending, type DateOrder, type Way } from './csv'
import { fingerprint } from './fingerprint'
import { toCents } from './format'
import { FILE_UID, matchLedger, type Identified } from './rowMatch'

/** Which column holds what. -1 is none. */
export interface ImportColumns {
  date: number
  amount: number
  note: number
  /** A second column of money, for a file that splits money out and money in. */
  inflow?: number
  /** More words about the row, read beside the note. */
  memo?: number
  /** What an app or a brokerage calls a row: its words, for a row whose note says nothing. */
  action?: number
  /** A column that says which way each row ran, for a file of plain figures. */
  direction?: number
  /** Which way a plain figure runs, for a file whose one column of money says. */
  way?: Way
  /** A plus or a CR on a figure means money in, beside plain figures that do not have one. */
  marked?: boolean
  /** A person has said a plus or a CR on a figure means nothing here. */
  noMarks?: boolean
  /** The sign each column of a pair writes its own side's money with. */
  sides?: { out: 1 | -1; in: 1 | -1 }
  /** How many cells a row of this table can fill. A row with more has had its cells moved. */
  width?: number
}

/**
 * Which way a file's figures run. A bank account's negatives are spending and its
 * positives income. On a card, money coming back is a refund or a payment, and
 * card exports differ on whether a charge reads as a negative or a plain figure.
 */
export type SignMode = 'negative-expense' | 'card-negative' | 'card-positive'

/** What a row of money is. A refund is spending coming back, so it offsets its category. */
export type RowKind = 'expense' | 'income' | 'refund'

export interface StagedRow extends Identified {
  /** The row's place in the file. It stays the same as the columns and settings change. */
  line: number
  amount: number
  type: 'expense' | 'income'
  categoryId: number | null
  /** The account's label, where the file says. */
  account?: string
  /** Its words say money moved between accounts, so it starts unticked. */
  movement: boolean
}

/** A row of the file that will not be imported, and the cells that say why. */
export interface LeftOutRow {
  line: number
  why: 'date' | 'amount' | 'zero' | 'way' | 'wide'
  date: string
  amount: string
  note: string
}

export interface StagedFile {
  rows: StagedRow[]
  leftOut: LeftOutRow[]
}

export interface StageOptions {
  order?: DateOrder
  /** The bank's own id for each row, where the file has one. */
  ids?: string[]
  /** Which rows are a card's, where the file says. It beats `mode`. */
  cards?: boolean[]
  /** What each row is, where the file says. It beats reading its words. */
  kinds?: (RowKind | undefined)[]
  /** Which rows are a card being paid, where the file says. They start unticked, whatever their words. */
  paid?: boolean[]
  account?: string
}

const NO_IDS: ReadonlySet<string> = new Set()

/** A note that only says it has nothing to say. */
const NO_NOTE = /^no description$/i

/** What a bank's site stamps on a row's memo when it is downloaded. It names the bank, and says nothing of the row. */
const DOWNLOAD_STAMP = /^download(?:ed)? from \S+/i

/**
 * A file's rows as transactions, and the ones that cannot be, so nothing goes
 * missing unsaid. Each row is read by the rules a bank row gets, because the same
 * money must not read two ways: a payment is not spending, a card's credit is a
 * refund, and rent dates the same.
 */
export function stageRows(
  rows: string[][],
  cols: ImportColumns,
  mode: SignMode,
  categories: Category[],
  { order = 'month-first', ids, cards, kinds, paid, account }: StageOptions = {},
): StagedFile {
  const out: StagedFile = { rows: [], leftOut: [] }
  if (cols.date < 0 || cols.amount < 0) return out
  const sided = saysWay(cols)
  const cell = (r: string[], at: number | undefined) => (at != null && at >= 0 ? (r[at] ?? '').trim() : '')
  const expenseCategory = (t: SyncedTx) => findCategoryFor(categorize({ description: t.description, memo: t.memo, kind: 'expense' }), 'expense', categories)
  const repeats = new Map<string, number>()

  rows.forEach((r, line) => {
    const rawDate = cell(r, cols.date)
    const rawAmount = cell(r, cols.amount)
    const rawInflow = cell(r, cols.inflow)
    const action = cell(r, cols.action)
    const written = cell(r, cols.note).replace(NO_NOTE, '')
    const memo = cell(r, cols.memo).replace(DOWNLOAD_STAMP, '').trim() || (written ? '' : action)
    const note = written || memo
    if (isWide(r, cols)) {
      out.leftOut.push({ line, why: 'wide', date: rawDate, amount: rawAmount || rawInflow, note })
      return
    }
    const day = parseDate(rawDate, order)
    const amt = rowFigure(r, cols)
    if (!day || amt == null || amt === 0) {
      const way = (cols.direction ?? -1) >= 0 && amt == null && parseAmount(rawAmount) != null
      const why = !day ? 'date' : way ? 'way' : amt == null ? 'amount' : 'zero'
      out.leftOut.push({ line, why, date: rawDate, amount: rawAmount || rawInflow, note })
      return
    }

    const tier = (cards?.[line] ?? mode !== 'negative-expense') ? 'credit' : 'cash'
    // As the bank would send it: money out is negative. A file that says which way a row ran already has it so,
    // and a figure marked as money in stays that on a card that lists its charges as plain figures.
    const signed = mode === 'card-positive' && tier === 'credit' && !sided && !(cols.marked && isMarked(rawAmount)) ? -amt : amt
    const bankRow: SyncedTx = { sourceTxId: String(line), account: '', tier, posted: 0, amount: signed, description: note, payee: '', memo, mcc: null }
    const told = kinds?.[line] ?? (signed > 0 && (undoesSpending(r, cols) || saysRefund(action)) ? 'refund' : undefined)
    const verdict = told
      ? { kind: told }
      : classifyBankTx(bankRow, NO_IDS, NO_IDS, (t) => {
          const c = expenseCategory(t)
          return c ? (c.key ?? c.name) : null
        })
    const movement = verdict.kind === 'skip' || !!paid?.[line] || (!told && (isBalanceLine(note) || isOwnMoney(action)))
    // Ticked in spite of its words, a transfer or a payment counts by its sign.
    const kind = verdict.kind === 'skip' || movement ? (signed < 0 ? 'expense' : 'income') : verdict.kind
    const type = kind === 'income' ? 'income' : 'expense'
    const cents = Math.round(Math.abs(amt) * 100) / 100

    const name = categorize({ description: note, memo, kind: type })
    const category = findCategoryFor(type === 'income' && !name ? 'Other income' : name, type, categories)
    const date = category && kind === 'expense' && isRentCategory(category) ? rentDate(day) : day

    // The file's id, or what the row says. A second row saying the same is its own
    // row, in the same place in the count each time the file comes in. The bank's id
    // goes with its day and money, because some banks use an id over again.
    const id = ids?.[line]
    const base = id ? `ofx:${fingerprint(`${id}|${day}|${cents}`)}` : `csv:${fingerprint(`${day}|${cents}|${note.toLowerCase()}`)}`
    const seen = repeats.get(base) ?? 0
    repeats.set(base, seen + 1)

    out.rows.push({
      uid: `${FILE_UID}${base}:${seen}`,
      line,
      date,
      ...(date !== day ? { posted: day } : {}),
      amount: kind === 'refund' ? -cents : cents,
      type,
      note,
      categoryId: category?.id ?? null,
      ...(account ? { account } : {}),
      movement,
    })
  })
  return out
}

/** Which of an import's figures a row goes to: money in, money out, or spending coming back. */
export type RowEffect = 'in' | 'out' | 'refund'

type LedgerFigure = Pick<Transaction, 'amount' | 'type' | 'note'>

export const rowEffect = ({ amount, type }: Pick<LedgerFigure, 'amount' | 'type'>): RowEffect =>
  type === 'income' ? 'in' : amount < 0 ? 'refund' : 'out'

/** The biggest row on one side of an import: the first of them, on a tie. */
export interface LargestRow {
  note: string
  amount: number
}

/** What an import writes, in the figures a person can check it by. */
export interface ImportSummary {
  rows: number
  moneyIn: number
  moneyOut: number
  refunds: number
  largestIn?: LargestRow
  largestOut?: LargestRow
}

/**
 * The one account of what rows come to, read from the amount and type they carry into
 * the ledger. Give it the rows chosen for `importRows`, which writes those and no others,
 * so it cannot say one thing while the import writes another. Added up in cents, as money is.
 */
export function summarizeImport(rows: readonly LedgerFigure[]): ImportSummary {
  const cents: Record<RowEffect, number> = { in: 0, out: 0, refund: 0 }
  const largest: Partial<Record<RowEffect, LargestRow>> = {}
  for (const row of rows) {
    const effect = rowEffect(row)
    const amount = Math.abs(row.amount)
    cents[effect] += toCents(amount)
    if (amount > (largest[effect]?.amount ?? 0)) largest[effect] = { note: row.note, amount }
  }
  return { rows: rows.length, moneyIn: cents.in / 100, moneyOut: cents.out / 100, refunds: cents.refund / 100, largestIn: largest.in, largestOut: largest.out }
}

const ledgerRow = ({ uid, date, posted, amount, type, note, categoryId, account }: StagedRow, now: number): Transaction => ({
  uid, date, ...(posted ? { posted } : {}), amount, type, note, categoryId, account: account ?? '', createdAt: now, updatedAt: now,
})

/**
 * Add the `chosen` rows the ledger does not have, read again inside the write so a
 * sync that landed since the preview cannot double a row. The whole file is matched,
 * as the preview matched it: a row already here has to hold on to its ledger row, or
 * the same words on a row beside it would take that row and never come in. A row
 * carries an id made from the file, as a bank row carries the bank's, so the same file
 * on another device gives the same row, and a row since removed stays removed. With
 * `bringBack`, a person has asked for those too: each takes its old place, so every
 * device hears it is back, and reads as the file does now. `skipped` is how many chosen
 * rows the write found here already. `at` is the import's stamp (`undoImport`).
 */
export async function importRows(
  staged: StagedRow[],
  { chosen = staged, bringBack = false }: { chosen?: readonly StagedRow[]; bringBack?: boolean } = {},
): Promise<{ imported: number; skipped: number; at: number }> {
  const now = Date.now()
  const wanted = new Set(chosen)
  return db.transaction('rw', db.transactions, async () => {
    const ledger = await db.transactions.toArray()
    const { fresh, removed } = matchLedger(staged, ledger)
    const rows = fresh.filter((r) => wanted.has(r)).map((r) => ledgerRow(r, now))
    if (rows.length) await db.transactions.bulkAdd(rows)
    const places = new Map(ledger.map((t) => [t.uid, t.id]))
    const back = bringBack ? removed.filter((r) => wanted.has(r)).map((r) => ({ ...ledgerRow(r, now), id: places.get(r.uid), deleted: false })) : []
    if (back.length) await db.transactions.bulkPut(back)
    const imported = rows.length + back.length
    return { imported, skipped: wanted.size - imported, at: now }
  })
}

export interface ImportBatch {
  /** The stamp its rows share. */
  at: number
  rows: number
}

/** The newest import still in the ledger. A file's rows share `createdAt`, on every device. */
export function lastImport(ledger: readonly Transaction[]): ImportBatch | null {
  let batch: ImportBatch | null = null
  for (const t of ledger) {
    if (t.deleted || !t.uid?.startsWith(FILE_UID)) continue
    if (!batch || t.createdAt > batch.at) batch = { at: t.createdAt, rows: 1 }
    else if (t.createdAt === batch.at) batch.rows++
  }
  return batch
}

/**
 * Take one import back out, for a file read the wrong way. Nothing else is touched:
 * only a file's rows carry its stamp. A tombstone is what tells the cloud and other
 * devices, and importing the file again can bring these rows back (`importRows`).
 */
export async function undoImport(at: number): Promise<number> {
  const now = Date.now()
  return db.transactions
    .where('uid')
    .startsWith(FILE_UID)
    .filter((t) => !t.deleted && t.createdAt === at)
    .modify({ deleted: true, updatedAt: now })
}
