import type { Category, Transaction, TxType } from '../db/db'
import { dayLabel } from './dates'
import { money } from './format'
import { isRefund } from './ledger'
import { cleanMerchant } from './merchants'

/**
 * The command bar: a few fixed phrasings for the edits that otherwise mean
 * editing rows one by one. No AI and nothing to pay for: it parses, looks up
 * and proposes, and nothing is written until the plan is applied
 * (commandRun.ts).
 *
 *   move <what> to <day or month>      move rent to Oct 1 · count rent in October
 *   file <merchant> under <category>   file Amazon under Shopping (new ones follow)
 *   set <category> budget to <amount>  set Dining budget to 600
 *   hide <what>                        hide Venmo $40 · hide all Robinhood $25
 *
 * <what> is any mix of merchant words, an amount and a date. Without "all" it
 * is the most recent match; the preview names exactly which rows change.
 */

export const EXAMPLES = ['move rent to Oct 1', 'file Amazon under Shopping', 'set Dining budget to 600', 'hide Venmo $40']

const HELP = `Try: ${EXAMPLES.join(' · ')}`

export interface Query {
  /** Merchant (or category) words, lower case. May be empty. */
  text: string
  amount?: number
  /** YYYY-MM-DD */
  date?: string
  /** "all" / "every": every match instead of the most recent one. */
  all: boolean
}

export type Command =
  | { kind: 'move'; query: Query; to: string }
  | { kind: 'file'; query: Query; category: Category }
  | { kind: 'budget'; category: Category; amount: number }
  | { kind: 'hide'; query: Query }

export type Parsed = { ok: true; command: Command } | { ok: false; message: string }

// ---- Days ------------------------------------------------------------------
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const ORD = '(?:st|nd|rd|th)?'
const pad = (n: number) => String(n).padStart(2, '0')
const monthOf = (word: string) =>
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(word.slice(0, 3))
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

function day(y: number, m: number, d: number): string | null {
  if (m < 0 || m > 11 || d < 1 || d > daysIn(y, m)) return null
  return `${y}-${pad(m + 1)}-${pad(d)}`
}

/** A day given without a year means the one nearest to today. */
function nearest(m: number, d: number, today: string): string | null {
  const ty = Number(today.slice(0, 4))
  const t = Date.parse(today)
  let best: string | null = null
  for (const y of [ty - 1, ty, ty + 1]) {
    const iso = day(y, m, d)
    if (iso && (!best || Math.abs(Date.parse(iso) - t) < Math.abs(Date.parse(best) - t))) best = iso
  }
  return best
}

function shiftDay(iso: string, delta: number): string {
  const t = new Date(Date.parse(iso) + delta * 86400000)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

function fullYear(y: string | undefined): number | null {
  if (!y) return null
  return y.length === 2 ? 2000 + Number(y) : Number(y)
}

/** Day patterns, tried in order; each returns the day or null. */
const DAYS: [RegExp, (m: RegExpExecArray, today: string) => string | null][] = [
  [/\b(today)\b/, (_m, today) => today],
  [/\b(yesterday)\b/, (_m, today) => shiftDay(today, -1)],
  [/\b(tomorrow)\b/, (_m, today) => shiftDay(today, 1)],
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => day(Number(m[1]), Number(m[2]) - 1, Number(m[3]))],
  [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/, (m, today) => {
    const y = fullYear(m[3])
    return y != null ? day(y, Number(m[1]) - 1, Number(m[2])) : nearest(Number(m[1]) - 1, Number(m[2]), today)
  }],
  [new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}(?:\\s+(\\d{4}))?\\b`), (m, today) => {
    const y = fullYear(m[3])
    return y != null ? day(y, monthOf(m[1]), Number(m[2])) : nearest(monthOf(m[1]), Number(m[2]), today)
  }],
  [new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}(?:\\s+(\\d{4}))?\\b`), (m, today) => {
    const y = fullYear(m[3])
    return y != null ? day(y, monthOf(m[2]), Number(m[1])) : nearest(monthOf(m[2]), Number(m[1]), today)
  }],
]

/** A day named somewhere inside the words, with the text that named it. */
function findDay(s: string, today: string): { iso: string; text: string } | null {
  for (const [re, read] of DAYS) {
    const m = re.exec(s)
    if (!m) continue
    const iso = read(m, today)
    if (iso) return { iso, text: m[0] }
  }
  return null
}

/**
 * A whole phrase that names a day: 'Oct 1', '10/1', 'October 1st', 'tomorrow'.
 * A month on its own ('October', 'next month') means its 1st.
 */
export function parseDay(phrase: string, today: string): string | null {
  const s = phrase.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(the|on|in|into|to|for)\s+/, '')
  const rel = /^(next|this|last) month$/.exec(s)
  if (rel) {
    const [y, m] = today.split('-').map(Number)
    const i = y * 12 + (m - 1) + (rel[1] === 'next' ? 1 : rel[1] === 'last' ? -1 : 0)
    return day(Math.floor(i / 12), i % 12, 1)
  }
  const month = new RegExp(`^${MONTH}(?:\\s+(\\d{4}))?$`).exec(s)
  if (month) {
    const y = fullYear(month[2])
    return y != null ? day(y, monthOf(month[1]), 1) : nearest(monthOf(month[1]), 1, today)
  }
  const found = findDay(s, today)
  // The whole phrase must be the day, not a day inside other words.
  return found && found.text.trim() === s ? found.iso : null
}

// ---- Queries and categories ------------------------------------------------
const FILLER = new Set([
  'the', 'my', 'that', 'this', 'a', 'an', 'all', 'every', 'each', 'of', 'from', 'on', 'at', 'for', 'one', 'ones',
  'payment', 'payments', 'charge', 'charges', 'transaction', 'transactions', 'purchase', 'purchases',
  'transfer', 'transfers', 'bill', 'bills',
])

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()
/** The words that identify something: normalized, filler dropped. */
const keyWords = (s: string) => norm(s).split(' ').filter((w) => w && !FILLER.has(w)).join(' ')
const titleCase = (s: string) => s.replace(/(^|\s)([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())

/** Merchant words, an amount and a date, from the "what" part of a command. */
export function parseQuery(raw: string, today: string): Query | null {
  let s = ` ${raw.toLowerCase()} `
  const all = /\s(all|every|each)\s/.test(s)
  const found = findDay(s, today)
  if (found) s = s.replace(found.text, ' ')
  const cash = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(s) ?? /\s(\d[\d,]*(?:\.\d{1,2})?)(?=\s)/.exec(s)
  const amount = cash ? Number(cash[1].replace(/,/g, '')) : undefined
  if (cash) s = s.replace(cash[0], ' ')
  const text = keyWords(s)
  if (!text && !amount && !found) return null
  return { text, amount: amount || undefined, date: found?.iso, all }
}

/** A category by name: exact, then singular or plural, then a unique prefix. */
export function findCategory(name: string, categories: readonly Category[], kind?: TxType): Category | null {
  const want = norm(name).replace(/ category$/, '')
  if (!want) return null
  const live = categories.filter((c) => !c.deleted && (!kind || c.kind === kind))
  const one = (s: string) => s.replace(/s$/, '')
  return (
    live.find((c) => norm(c.name) === want) ??
    live.find((c) => one(norm(c.name)) === one(want)) ??
    (() => {
      const pre = live.filter((c) => norm(c.name).startsWith(want))
      return want.length >= 3 && pre.length === 1 ? pre[0] : null
    })()
  )
}

// ---- Parsing ---------------------------------------------------------------
const AMOUNT = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d{1,2})?)'
const BUDGET: RegExp[] = [
  new RegExp(`^(?:set|change|make|update)\\s+(?:the\\s+|my\\s+)?budget\\s+(?:for|on)\\s+(.+?)\\s+(?:to|at|=)\\s*${AMOUNT}$`),
  new RegExp(`^(?:set|change|make|update)\\s+(?:the\\s+|my\\s+)?(.+?)\\s+budget\\s+(?:to\\s+|at\\s+|=\\s*)?${AMOUNT}$`),
  new RegExp(`^budget\\s+(?:for\\s+)?(.+?)\\s+(?:to\\s+|at\\s+|=\\s*)?${AMOUNT}$`),
]
/** 'Dining budget 600', tried only after the verbs so 'hide …' is never read as a budget. */
const BARE_BUDGET = new RegExp(`^(?:the\\s+|my\\s+)?(.+?)\\s+budget\\s+(?:to\\s+|at\\s+|=\\s*|is\\s+)?${AMOUNT}$`)

const MOVE_VERB = /^(move|count|put|shift|push)\s+(.+)$/
const FILE_VERB = /^(file|categori[sz]e|recategori[sz]e|mark)\s+(.+)$/
const HIDE_VERB = /^(hide|delete|remove|drop|ignore|exclude)\s+(.+)$/

/** Every way to split "<what> <prep> <where>", last preposition first. */
function splits(rest: string, preps: string[]): { head: string; tail: string }[] {
  const out: { head: string; tail: string }[] = []
  const re = new RegExp(`\\s(${preps.join('|')})\\s`, 'g')
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    out.unshift({ head: rest.slice(0, m.index), tail: rest.slice(m.index + m[0].length) })
    re.lastIndex = m.index + 1 // allow overlapping candidates ("to in")
  }
  return out
}

const ok = (command: Command): Parsed => ({ ok: true, command })
const fail = (message: string): Parsed => ({ ok: false, message })

export function parseCommand(input: string, categories: readonly Category[], today: string): Parsed {
  const s = input.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLowerCase()
  if (!s) return fail(HELP)

  const budget = (m: RegExpExecArray): Parsed => {
    const category = findCategory(m[1], categories, 'expense')
    if (!category) return fail(`There is no spending category called "${m[1].trim()}".`)
    return ok({ kind: 'budget', category, amount: Number(m[2].replace(/,/g, '')) })
  }
  for (const re of BUDGET) {
    const m = re.exec(s)
    if (m) return budget(m)
  }

  const hide = HIDE_VERB.exec(s)
  if (hide) {
    const query = parseQuery(hide[2], today)
    return query ? ok({ kind: 'hide', query }) : fail('Say which one: a merchant, an amount or a date.')
  }

  const file = FILE_VERB.exec(s)
  const move = file ? null : MOVE_VERB.exec(s)
  const rest = file?.[2] ?? move?.[2]
  if (rest == null) {
    const bare = BARE_BUDGET.exec(s)
    return bare ? budget(bare) : fail(HELP)
  }
  const preps = file ? ['under', 'as', 'in', 'into', 'to'] : ['to', 'in', 'into', 'on', 'toward', 'towards', 'for', 'under', 'as']
  for (const { head, tail } of splits(rest, preps)) {
    const query = parseQuery(head, today)
    if (!query) continue
    const to = file ? null : parseDay(tail, today)
    if (to) return ok({ kind: 'move', query, to })
    const category = findCategory(tail, categories)
    if (category) return ok({ kind: 'file', query, category })
  }
  return fail(file ? 'Name the category to file it under.' : 'Say where it goes: a day like Oct 1, a month, or a category.')
}

// ---- Planning --------------------------------------------------------------
export interface RowChange {
  t: Transaction
  before: Partial<Transaction>
  after: Partial<Transaction>
  /** The new value as the preview shows it: 'Oct 1', 'Shopping', 'Hidden'. */
  to: string
}

/** A saved categorization rule (public.merchant_rules) so new charges follow. */
export interface RulePlan {
  pattern: string
  category: string
  kind: TxType
  priority: number
}

export type Plan =
  | {
      ok: true
      title: string
      rows: RowChange[]
      /** Other matches not picked (without "all", only the most recent changes). */
      others: number
      budget?: { category: Category; before: number; after: number }
      rule?: RulePlan
    }
  | { ok: false; message: string }

/** How a row reads in a preview: 'Landlord LLC $2,400.00' or 'Amazon +$24.50'. */
export function rowLabel(t: Transaction): string {
  const name = cleanMerchant(t.note || '') || 'Transaction'
  const back = isRefund(t) || t.type === 'income'
  return `${name} ${back ? '+' : ''}${money(Math.abs(t.amount))}`
}

function matching(q: Query, txns: readonly Transaction[], categories: readonly Category[]) {
  const catName = new Map(categories.map((c) => [c.id, norm(c.name)]))
  const needle = q.text
  const squash = (s: string) => s.replace(/ /g, '')
  const byWords = (t: Transaction) => {
    if (!needle) return false
    // The note loses the same filler words the ask did ('Bread in a Box').
    const hay = ` ${keyWords(t.note || '')} ${keyWords(cleanMerchant(t.note || ''))} `
    // Whole words ('rent' is not 'rental'); a multi-word ask also matches when
    // the bank runs the words together ('american express' in 'Americanexpress').
    return hay.includes(` ${needle} `) || (needle.includes(' ') && squash(hay).includes(squash(needle)))
  }
  const byCategory = (t: Transaction) => !!needle && t.categoryId != null && catName.get(t.categoryId) === needle
  const inText = (t: Transaction) => !needle || byWords(t) || byCategory(t)
  const cents = (n: number) => Math.round(Math.abs(n) * 100)
  const base = txns.filter((t) => !t.deleted && inText(t) && (q.amount == null || cents(t.amount) === cents(q.amount)))
  let rows = q.date ? base.filter((t) => t.date === q.date) : base
  // A remembered date is often a day or two off the bank's: fall back to ±3 days.
  if (q.date && rows.length === 0) {
    const d = Date.parse(q.date)
    rows = base.filter((t) => Math.abs(Date.parse(t.date) - d) <= 3 * 86400000)
  }
  return { rows, byWords: rows.some(byWords) }
}

const newestFirst = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0)
const describe = (q: Query) => [q.text, q.amount != null ? money(q.amount) : '', q.date ? dayLabel(q.date) : ''].filter(Boolean).join(' ')

export function planCommand(cmd: Command, txns: readonly Transaction[], categories: readonly Category[]): Plan {
  if (cmd.kind === 'budget') {
    const before = cmd.category.monthlyBudget || 0
    if (before === cmd.amount) return { ok: false, message: `${cmd.category.name} is already ${money(before, { trim: true })}.` }
    return {
      ok: true,
      title: `Set ${cmd.category.name} budget to ${money(cmd.amount, { trim: true })}`,
      rows: [],
      others: 0,
      budget: { category: cmd.category, before, after: cmd.amount },
    }
  }

  const found = matching(cmd.query, txns, categories)
  if (found.rows.length === 0) return { ok: false, message: `Nothing matches "${describe(cmd.query)}".` }

  if (cmd.kind === 'file') {
    const cat = cmd.category
    const sameKind = found.rows.filter((t) => t.type === cat.kind)
    if (sameKind.length === 0) {
      return { ok: false, message: `Those are ${cat.kind === 'income' ? 'spending' : 'income'}; ${cat.name} is an ${cat.kind} category.` }
    }
    const rows = sameKind.filter((t) => t.categoryId !== cat.id).sort(newestFirst)
    // A merchant named with no amount or date is a standing instruction: save a
    // rule so new charges follow. Words matched only as a category name are not
    // a merchant, so no rule for those.
    const standing = !!cmd.query.text && cmd.query.amount == null && !cmd.query.date && found.byWords
    const words = cmd.query.text.split(' ')
    const rule: RulePlan | undefined = standing
      ? {
          pattern: words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ?'),
          category: cat.name,
          kind: cat.kind,
          // Under every built-in rule (10+), and longer names win over shorter.
          priority: Math.max(1, 5 - words.length),
        }
      : undefined
    if (rows.length === 0 && !rule) return { ok: false, message: `Already filed under ${cat.name}.` }
    const who = cmd.query.text ? titleCase(cmd.query.text) : cleanMerchant(rows[0]?.note || sameKind[0].note || '')
    const title =
      rows.length === 0
        ? `New ${who} charges will go under ${cat.name}`
        : `File ${rows.length === 1 ? `${who} ${money(Math.abs(rows[0].amount))}` : `${rows.length} ${who} charges`} under ${cat.name}${rule ? ', and new ones too' : ''}`
    return {
      ok: true,
      title,
      rows: rows.map((t) => ({ t, before: { categoryId: t.categoryId, manual: t.manual }, after: { categoryId: cat.id!, manual: true }, to: cat.name })),
      others: 0,
      rule,
    }
  }

  const pick = (pool: Transaction[]) => {
    const sorted = [...pool].sort(newestFirst)
    const picked = cmd.query.all ? sorted : sorted.slice(0, 1)
    return { picked, one: picked.length === 1 ? picked[0] : null, others: sorted.length - picked.length }
  }

  if (cmd.kind === 'hide') {
    const { picked, one, others } = pick(found.rows)
    return {
      ok: true,
      title: one ? `Hide ${rowLabel(one)} from ${dayLabel(one.date)}` : `Hide ${picked.length} transactions`,
      rows: picked.map((t) => ({ t, before: { deleted: !!t.deleted, manual: t.manual }, after: { deleted: true, manual: true }, to: 'Hidden' })),
      others,
    }
  }

  const to = cmd.to
  const pool = found.rows.filter((t) => t.date !== to)
  if (pool.length === 0) return { ok: false, message: `Already on ${dayLabel(to)}.` }
  const { picked, one, others } = pick(pool)
  return {
    ok: true,
    title: one ? `Move ${rowLabel(one)} from ${dayLabel(one.date)} to ${dayLabel(to)}` : `Move ${picked.length} transactions to ${dayLabel(to)}`,
    rows: picked.map((t) => ({ t, before: { date: t.date, manual: t.manual }, after: { date: to, manual: true }, to: dayLabel(to) })),
    others,
  }
}
