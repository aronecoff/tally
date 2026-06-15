import { type Category } from '../db/db'
import { guessCategoryName } from './categorize'
import { todayISO } from './dates'

export interface ParsedEntry {
  type: 'expense' | 'income'
  amount: number
  note: string
  categoryId: number | null
  date: string
}

const INCOME = /\b(paid|salary|income|deposit|refund|bonus|reimburse|payday|got\s+paid)\b/i
const FILLER = /\b(for|on|at|spent|of|the|a|an|to|=|\$)\b/gi

/**
 * Parse a plain-English entry like "lunch 14", "$54 at whole foods", or
 * "got paid 3200" into a transaction. Returns null if no amount is found.
 *
 * This is the day-one parser (instant, offline, free). It's the single seam to
 * swap for a Claude-powered parser later — same signature, async.
 */
export function parseEntry(text: string, categories: Category[]): ParsedEntry | null {
  const raw = text.trim()
  if (!raw) return null

  const m = raw.match(/\$?\d+(?:,\d{3})*(?:\.\d{1,2})?/)
  if (!m) return null
  const amount = Math.abs(parseFloat(m[0].replace(/[$,]/g, '')))
  if (!amount || Number.isNaN(amount)) return null

  const income = INCOME.test(raw)
  const type: 'expense' | 'income' = income ? 'income' : 'expense'
  const kinds = categories.filter((c) => c.kind === type && !c.deleted)

  let categoryId: number | null = null
  const guess = guessCategoryName(raw)
  if (income) {
    categoryId =
      (guess ? kinds.find((c) => c.name === guess) : undefined)?.id ??
      kinds.find((c) => /salary|income/i.test(c.name))?.id ??
      null
  } else if (guess) {
    categoryId = kinds.find((c) => c.name === guess)?.id ?? null
  }

  let note = raw.replace(m[0], ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
  if (!note) note = income ? 'Income' : categories.find((c) => c.id === categoryId)?.name ?? 'Spend'
  note = note.charAt(0).toUpperCase() + note.slice(1)

  return { type, amount, note, categoryId, date: todayISO() }
}
