import { db, type Category, type Transaction } from '../db/db'
import { brand } from './brand'
import { EXPORT_HEADERS } from './csv'
import { todayISO } from './dates'
import { saveFile } from './share'

/** A spreadsheet runs a cell starting with these as a formula, and bank text is not ours. */
const textCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)

const field = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** Spending as a negative and money in as a positive, as a bank's own export reads. */
const signedAmount = (t: Transaction) => (t.type === 'income' ? t.amount : -t.amount).toFixed(2)

const typeOf = (t: Transaction) => (t.type === 'income' ? 'Income' : t.amount < 0 ? 'Refund' : 'Expense')

/** Tells a spreadsheet the file is UTF-8, so an accented merchant reads as written. */
const BOM = String.fromCharCode(0xfeff)

/** The ledger as a CSV, newest first. */
export function transactionsCsv(rows: readonly Transaction[], categories: readonly Category[]): string {
  const names = new Map(categories.map((c) => [c.id, c.name]))
  const live = rows
    .filter((t) => !t.deleted)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0))
  const lines = live.map((t) =>
    [
      t.date,
      textCell(t.note),
      signedAmount(t),
      typeOf(t),
      textCell((t.categoryId != null ? names.get(t.categoryId) : undefined) ?? ''),
      textCell(t.account),
      t.pending ? 'Pending' : 'Posted',
    ]
      .map(field)
      .join(','),
  )
  return `${BOM}${[EXPORT_HEADERS.join(','), ...lines].join('\r\n')}\r\n`
}

/** Hand every live transaction over as a CSV. Resolves how many went, or null if none did. */
export async function exportTransactions(): Promise<number | null> {
  const [rows, categories] = await Promise.all([db.transactions.toArray(), db.categories.toArray()])
  const count = rows.filter((t) => !t.deleted).length
  if (count === 0) return 0
  const sent = await saveFile({
    filename: `${brand.fileStem}-transactions-${todayISO()}.csv`,
    mime: 'text/csv',
    text: transactionsCsv(rows, categories),
  })
  return sent ? count : null
}
