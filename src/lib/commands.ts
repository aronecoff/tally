import type { Category, Transaction, TxType } from '../db/db'
import { dateMovedMark, rentRefile } from './bankRules'
import { isFixed, isRentCategory } from './categorize'
import { dayLabel, todayISO } from './dates'
import { money } from './format'
import { isRefund } from './ledger'
import { cleanMerchant } from './merchants'
import { getUserRules, type UserRule } from './userRules'

/**
 * The command bar: a few fixed phrasings for the edits that otherwise mean
 * editing rows one by one. No AI and nothing to pay for: it parses, looks up
 * and proposes, and nothing is written until the plan is applied
 * (commandRun.ts).
 *
 *   move <what> to <day or month>      move rent to Oct 1 · count rent in October
 *   file <merchant> under <category>   file Amazon under Shopping (new ones follow)
 *   set <category> budget to <amount>  set Dining budget to 600
 *   hide <what>                        hide the $40 charge · hide all Robinhood $25
 *   unhide <what>                      unhide the $40 charge
 *   forget <merchant>                  forget Amazon (the rule "file" saved)
 *
 * <what> is any mix of merchant words, an amount, a day and a month. Without
 * "all" it is the most recent match; the preview names exactly which rows change.
 */

export const EXAMPLES = ['move rent to Oct 1', 'file Amazon under Shopping', 'set Dining budget to 600', 'hide the $40 charge']

const HELP = 'Tally did not understand that.'
/** A command is one short line. Longer input is refused before any pattern runs on it. */
export const MAX_COMMAND = 200
/**
 * Every rule Tell Tally saves has this priority: under the user's own rules
 * (5 and up) and every built-in (10 and up). Rules that tie are tried newest
 * first (merchantRules.ts), so the latest instruction wins, as it did for the
 * rows it filed.
 */
export const TELL_PRIORITY = 4

export interface Query {
  /** Merchant (or category) words, lower case, filler dropped. May be empty. */
  text: string
  /** The words as typed (lower case, punctuation kept), with the day, amount and month taken out. */
  label: string
  amount?: number
  /** 'in': only money back (a refund or income), from "refund" or a plus sign. */
  sign?: 'in'
  /** YYYY-MM-DD */
  date?: string
  /** YYYY-MM: 'in September', 'last month'. */
  month?: string
  /** "all" / "every": every match instead of the most recent one. */
  all: boolean
  /**
   * Other readings of the same words, tried in order when this one finds
   * nothing: a bare number kept in the name ('Pay in 4'), a month word kept in
   * the name ('hotel august'), or a month word inside the words taken as the
   * month ('september amazon').
   */
  alt?: Alt[]
}

/** One other reading: the words, and the amount or month it changes (a key set to undefined clears it). */
export interface Alt {
  text: string
  label: string
  amount?: number
  month?: string
}

export type Command =
  | { kind: 'move'; query: Query; to: string }
  | { kind: 'file'; query: Query; category: Category }
  | { kind: 'budget'; category: Category; amount: number }
  | { kind: 'hide'; query: Query }
  | { kind: 'unhide'; query: Query }
  | { kind: 'forget'; label: string; text: string }

export type Parsed = { ok: true; command: Command } | { ok: false; message: string }

// ---- Days ------------------------------------------------------------------
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const ORD = '(?:st|nd|rd|th)?'
/** A year after a day, with or without a comma. Only 20xx: 'Sep 1, 2400' is a day and an amount. */
const YEAR = '(?:(?:\\s*,\\s*|\\s+)(20\\d{2}))?'
const pad = (n: number) => String(n).padStart(2, '0')
const monthOf = (word: string) =>
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(word.slice(0, 3))
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
const DAY_MS = 86400000

function day(y: number, m: number, d: number): string | null {
  if (m < 0 || m > 11 || d < 1 || d > daysIn(y, m)) return null
  return `${y}-${pad(m + 1)}-${pad(d)}`
}

function shiftDay(iso: string, delta: number): string {
  const t = new Date(Date.parse(iso) + delta * DAY_MS)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/**
 * How a day given without a year is read.
 * 'nearest' (a move target): the one nearest the anchor.
 * 'recent' (which rows to find): the latest one up to two weeks ahead, since
 * rows are past days, except rent paid early, dated the 1st it pays for. The
 * nearest rule read a day six months back as next year.
 */
type Mode = 'nearest' | 'recent'
const AHEAD_DAYS = 14
interface DayCtx {
  today: string
  /** The day a year-less day is read near: today, or the day a move starts from. */
  anchor: string
  mode: Mode
}

function yearless(m: number, d: number, ctx: DayCtx): string | null {
  const ty = Number(ctx.anchor.slice(0, 4))
  const years = [ty - 1, ty, ty + 1]
  if (ctx.mode === 'recent') {
    const limit = shiftDay(ctx.anchor, AHEAD_DAYS)
    let latest: string | null = null
    for (const y of years) {
      const iso = day(y, m, d)
      if (iso && iso <= limit && (!latest || iso > latest)) latest = iso
    }
    if (latest) return latest
  }
  const t = Date.parse(ctx.anchor)
  let best: string | null = null
  for (const y of years) {
    const iso = day(y, m, d)
    if (iso && (!best || Math.abs(Date.parse(iso) - t) < Math.abs(Date.parse(best) - t))) best = iso
  }
  return best
}

function fullYear(y: string | undefined): number | null {
  if (!y) return null
  return y.length === 2 ? 2000 + Number(y) : Number(y)
}

/** Day patterns, tried in order; each returns the day, or null for one that does not exist. */
const DAYS: [RegExp, (m: RegExpExecArray, ctx: DayCtx) => string | null][] = [
  [/\b(today)\b/, (_m, ctx) => ctx.today],
  [/\b(yesterday)\b/, (_m, ctx) => shiftDay(ctx.today, -1)],
  [/\b(tomorrow)\b/, (_m, ctx) => shiftDay(ctx.today, 1)],
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => day(Number(m[1]), Number(m[2]) - 1, Number(m[3]))],
  [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/, (m, ctx) => {
    const y = fullYear(m[3])
    return y != null ? day(y, Number(m[1]) - 1, Number(m[2])) : yearless(Number(m[1]) - 1, Number(m[2]), ctx)
  }],
  [new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}${YEAR}\\b`), (m, ctx) => {
    const y = fullYear(m[3])
    return y != null ? day(y, monthOf(m[1]), Number(m[2])) : yearless(monthOf(m[1]), Number(m[2]), ctx)
  }],
  [new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}${YEAR}\\b`), (m, ctx) => {
    const y = fullYear(m[3])
    return y != null ? day(y, monthOf(m[2]), Number(m[1])) : yearless(monthOf(m[2]), Number(m[1]), ctx)
  }],
]

/**
 * A day named somewhere inside the words, with the text that named it (and a
 * possessive after it: "Sep 30's"). iso is null when the words name a day that
 * does not exist ('Sep 31'), so the caller can say so instead of reading the
 * number as an amount.
 */
function findDay(s: string, ctx: DayCtx): { iso: string | null; text: string } | null {
  let missing: { iso: null; text: string } | null = null
  for (const [re, read] of DAYS) {
    const m = re.exec(s)
    if (!m) continue
    const iso = read(m, ctx)
    if (!iso) {
      missing ??= { iso: null, text: m[0] }
      continue
    }
    const poss = /^['’]s\b/.exec(s.slice(m.index + m[0].length))
    return { iso, text: m[0] + (poss ? poss[0] : '') }
  }
  return missing
}

/**
 * A whole phrase that names a day: 'Oct 1', '10/1', 'October 1st', 'tomorrow'.
 * A month on its own ('October', 'next month') means its 1st. A day without a
 * year is read near `anchor`: the day a move starts from, when one was named.
 */
export function parseDay(phrase: string, today: string, anchor = today): string | null {
  const s = phrase.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(the|on|in|into|to|for)\s+/, '')
  const ctx: DayCtx = { today, anchor, mode: 'nearest' }
  const rel = /^(next|this|last) month$/.exec(s)
  if (rel) {
    const [y, m] = today.split('-').map(Number)
    const i = y * 12 + (m - 1) + (rel[1] === 'next' ? 1 : rel[1] === 'last' ? -1 : 0)
    return day(Math.floor(i / 12), i % 12, 1)
  }
  const month = new RegExp(`^${MONTH}(?:\\s+(\\d{4}))?$`).exec(s)
  if (month) {
    const y = fullYear(month[2])
    return y != null ? day(y, monthOf(month[1]), 1) : yearless(monthOf(month[1]), 1, ctx)
  }
  const found = findDay(s, ctx)
  // The whole phrase must be the day, not a day inside other words.
  return found?.iso && found.text.trim() === s ? found.iso : null
}

const POSS = "(?:['’]s)?"
/** 'this month', 'last month's': always a month. */
const MONTH_REL = new RegExp(`\\s(?:(?:in|for|from|during)\\s+)?(this|last)\\s+month${POSS}(?=\\s)`)
/**
 * A month by its name, only where it cannot be part of a merchant's name:
 * after in/for/from/during, before a year, or as the last word ('hide all
 * amazon september'). Anywhere else it is read as words first: 'June's Pizza',
 * 'Mar Vista Cafe', 'August Hall', 'May Wah Market'.
 */
const MONTH_NAMED: RegExp[] = [
  new RegExp(`\\s(?:in|for|from|during)\\s+${MONTH}(?:\\s+(20\\d{2}))?${POSS}(?=\\s)`),
  new RegExp(`\\s()${MONTH}\\s+(20\\d{2})${POSS}(?=\\s)`),
  new RegExp(`\\s()${MONTH}()${POSS}(?=\\s*$)`),
]
/** A month word anywhere else: words first, the month only as another reading. */
const MONTH_WORD = new RegExp(`\\s${MONTH}${POSS}(?=\\s)`)

interface MonthRead {
  ym: string
  text: string
  /** The month was named by a word with no year, which a merchant's name may also hold. */
  word: boolean
}

/** Without a year a month is the latest one, up to next month. */
function monthIndex(name: string, year: string | undefined, today: string): string {
  const [ty, tm] = today.split('-').map(Number)
  const now = ty * 12 + tm - 1
  let i = (year ? Number(year) : ty) * 12 + monthOf(name)
  if (!year && i > now + 1) i -= 12
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`
}

/** A month named inside the words, where it can only be a month. */
function findMonth(s: string, today: string): MonthRead | null {
  const rel = MONTH_REL.exec(s)
  if (rel) {
    const [ty, tm] = today.split('-').map(Number)
    const i = ty * 12 + tm - 1 - (rel[1] === 'last' ? 1 : 0)
    return { ym: `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`, text: rel[0], word: false }
  }
  for (const re of MONTH_NAMED) {
    const m = re.exec(s)
    if (!m) continue
    // The first pattern captures (month, year); the others an empty group first.
    const [name, year] = m[1] ? [m[1], m[2]] : [m[2], m[3]]
    return { ym: monthIndex(name, year || undefined, today), text: m[0], word: !year }
  }
  return null
}

/** A month word inside a name ('June's Pizza'): the month only if the name finds nothing. */
function findMonthWord(s: string, today: string): MonthRead | null {
  const m = MONTH_WORD.exec(s)
  return m ? { ym: monthIndex(m[1], undefined, today), text: m[0], word: true } : null
}

// ---- Queries and categories ------------------------------------------------
const FILLER = new Set([
  'the', 'my', 'that', 'this', 'a', 'an', 'all', 'every', 'each', 'of', 'from', 'on', 'at', 'for', 'one', 'ones',
  'payment', 'payments', 'charge', 'charges', 'transaction', 'transactions', 'purchase', 'purchases',
  'transfer', 'transfers', 'bill', 'bills', 'latest', 'newest', 'recent', 'most',
])

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()
/** The words that identify something: normalized, filler dropped. */
const keyWords = (s: string) => norm(s).split(' ').filter((w) => w && !FILLER.has(w)).join(' ')
const titleCase = (s: string) => s.replace(/(^|\s)([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
const collapse = (s: string) => s.replace(/[$+]/g, ' ').replace(/\s+/g, ' ').trim()
/** "refund" in the words: money back. Global, for replace() only (test() on a /g regex is stateful). */
const REFUND_WORD = /\brefund(?:s|ed)?\b/g
const hasRefundWord = (s: string) => /\brefund(?:s|ed)?\b/.test(s)

/**
 * Merchant words, an amount, a day and a month, from the "what" part of a
 * command. Null when it names nothing; { error } when it names a day that does
 * not exist.
 */
export function parseQuery(raw: string, today: string): Query | { error: string } | null {
  let s = ` ${raw.toLowerCase()} `
  const all = /\s(all|every|each)\s/.test(s)
  s = s.replace(/\s(?:all|every|each)(?=\s)/g, ' ')
  const found = findDay(s, { today, anchor: today, mode: 'recent' })
  if (found && !found.iso) return { error: `There is no ${titleCase(found.text.trim())}.` }
  if (found) s = s.replace(found.text, ' ')
  // A month where only a month can be ('in September', 'amazon september') is
  // the month, with its word kept as another reading ('hotel august'). A month
  // word anywhere else is part of the name ('August Hall'), with the month as
  // the other reading ('september amazon').
  const month = found ? null : findMonth(s, today)
  const inName = found || month ? null : findMonthWord(s, today)
  let other: { s: string; month: string | undefined } | null = null
  if (month) {
    if (month.word) other = { s, month: undefined }
    s = s.replace(month.text, ' ')
  } else if (inName) {
    other = { s: s.replace(inName.text, ' '), month: inName.ym }
  }
  // Money back: "refund", or a plus in front of the amount (not one ending a name: 'Disney+').
  const sign = hasRefundWord(s) || /\s\+\s?\$?\s?\d/.test(s) ? 'in' : undefined
  // '$40' is always an amount. A bare number is too ('hide apple 12.99'), but
  // the words are kept with it as well, for a name like 'Pay in 4'.
  const dollar = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(s)
  const bare = dollar ? null : /(?:\s|\+)(\d[\d,]*(?:\.\d{1,2})?)(?=\s)/.exec(s)
  const cash = dollar ?? bare
  const amount = cash ? Number(cash[1].replace(/,/g, '')) : undefined
  const kept = s
  if (cash) {
    s = s.replace(cash[0], ' ')
    if (other) other.s = other.s.replace(cash[0], ' ')
  }
  // 'the latest amazon', 'last venmo': the most recent is what is picked anyway.
  const lead = /^\s*(?:the\s+)?(?:last|latest|newest|most\s+recent)\s+(?=\S)/
  s = s.replace(lead, ' ')
  const words = (x: string) => keyWords(sign ? x.replace(REFUND_WORD, ' ') : x)
  const text = words(s)
  if (!text && !amount && !found) return null
  const reading = (x: string) => ({ text: words(x.replace(lead, ' ')), label: collapse(x.replace(lead, ' ')) })
  const alt: Alt[] = []
  if (other) alt.push({ ...reading(other.s), month: other.month })
  if (bare) alt.push({ ...reading(kept), amount: undefined })
  const differs = (a: Alt) => a.text !== text || ('month' in a && a.month !== month?.ym)
  return {
    text,
    label: collapse(s),
    amount: amount || undefined,
    sign,
    date: found?.iso ?? undefined,
    month: month?.ym,
    all,
    alt: alt.some(differs) ? alt.filter(differs) : undefined,
  }
}

/** A category by name: exact, then singular or plural, then a unique prefix. */
export function findCategory(name: string, categories: readonly Category[], kind?: TxType): Category | null {
  const want = norm(name).replace(/ category$/, '')
  if (!want) return null
  const live = categories.filter((c) => !c.deleted && (!kind || c.kind === kind))
  // 'groceries' and 'grocery', 'subscriptions' and 'subscription'.
  const one = (s: string) => s.replace(/ies$/, 'y').replace(/s$/, '')
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
/** '600 a month', '600/mo', '600 monthly'. */
const PER = '(?:\\s*(?:a|per|/|each)\\s*(?:month|mo)|\\s+monthly)?'
const SET = '(?:set|change|make|update)'
/** Verbs that change a budget: they need the new amount ('to 900'), since 'by 100' is not one. */
const REL = '(?:raise|increase|lower|cut|reduce|bump|drop)'
const BUDGET: RegExp[] = [
  new RegExp(`^${SET}\\s+(?:the\\s+|my\\s+)?budget\\s+(?:for|on)\\s+(.+?)\\s+(?:to|at|=|is)\\s*${AMOUNT}${PER}$`),
  new RegExp(`^${SET}\\s+(?:the\\s+|my\\s+)?(.+?)\\s+budget\\s+(?:to\\s+|at\\s+|=\\s*|is\\s+)?${AMOUNT}${PER}$`),
  new RegExp(`^${REL}\\s+(?:the\\s+|my\\s+)?budget\\s+(?:for|on)\\s+(.+?)\\s+(?:to|=)\\s*${AMOUNT}${PER}$`),
  new RegExp(`^${REL}\\s+(?:the\\s+|my\\s+)?(.+?)\\s+budget\\s+(?:to\\s+|=\\s*)${AMOUNT}${PER}$`),
  new RegExp(`^budget\\s+(?:for\\s+)?(.+?)\\s+(?:to\\s+|at\\s+|=\\s*|is\\s+)?${AMOUNT}${PER}$`),
]
/** 'raise Dining budget by 100' or 'bump Dining budget 100': a change, not the new amount. */
const BUDGET_BY = new RegExp(`^(${REL.slice(3, -1)})\\s+(?:the\\s+|my\\s+)?(?:budget\\s+(?:for|on)\\s+(.+?)|(.+?)\\s+budget)\\s+(?:by\\s+)?${AMOUNT}${PER}$`)
/** 'Dining budget 600', tried only after the verbs so 'hide …' is never read as a budget. */
const BARE_BUDGET = new RegExp(`^(?:the\\s+|my\\s+)?(.+?)\\s+budget\\s+(?:to\\s+|at\\s+|=\\s*|is\\s+)?${AMOUNT}${PER}$`)

const MOVE_VERB = /^(move|count|put|shift|push)\s+(.+)$/
const FILE_VERB = /^(file|categori[sz]e|recategori[sz]e|mark)\s+(.+)$/
const HIDE_VERB = /^(hide|delete|remove|drop|ignore|exclude)\s+(.+)$/
const UNHIDE_VERB = /^(unhide|restore|undelete|unremove|bring back)\s+(.+)$/
/** Taking back a rule "file" saved. Tried before hide, so 'delete the Amazon rule' is not a hide. */
const FORGET: RegExp[] = [
  /^(?:forget|unfile|stop filing)\s+(?:the\s+|my\s+)?(?:rules?\s+(?:for\s+)?)?(.+?)(?:\s+rules?)?$/,
  /^(?:delete|remove|drop|clear)\s+(?:the\s+|my\s+)?rules?\s+(?:for\s+)?(.+)$/,
  /^(?:delete|remove|drop|clear)\s+(?:the\s+|my\s+)?(.+?)\s+rules?$/,
]
const WHICH = 'Say which charges: a merchant, an amount or a date.'

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
const isError = (q: Query | { error: string } | null): q is { error: string } => !!q && 'error' in q

export function parseCommand(input: string, categories: readonly Category[], today: string): Parsed {
  const raw = input.trim()
  // Before any pattern: splitting a long line is quadratic, and it froze the sheet.
  if (raw.length > MAX_COMMAND) return fail('That is too long. Keep it to one short line.')
  const s = raw.replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLowerCase()
  if (!s) return fail(HELP)

  const live = categories.filter((c) => !c.deleted)
  const names = (kind?: TxType) => live.filter((c) => !kind || c.kind === kind).map((c) => c.name).join(', ')
  const budget = (name: string, amount: string): Parsed => {
    const bare = name.trim().replace(new RegExp(`^${SET}\\b\\s*`), '').replace(/^(?:the|my)\b\s*/, '').trim()
    if (!bare) return fail('Which category? Budgets are set per category, like: set Dining budget to 600.')
    const category = findCategory(bare, categories, 'expense')
    if (!category) return fail(`There is no spending category called "${bare}". Yours: ${names('expense')}.`)
    return ok({ kind: 'budget', category, amount: Number(amount.replace(/,/g, '')) })
  }
  for (const re of BUDGET) {
    const m = re.exec(s)
    if (m) return budget(m[1], m[2])
  }
  const by = BUDGET_BY.exec(s)
  if (by) {
    const name = (by[2] ?? by[3]).trim()
    const c = findCategory(name, categories, 'expense')
    const now = c ? ` ${c.name} is ${money(c.monthlyBudget || 0, { trim: true })} now.` : ''
    return fail(`Say the new amount, like: ${by[1]} ${c?.name ?? name} budget to 900.${now}`)
  }

  for (const re of FORGET) {
    const m = re.exec(s)
    if (!m) continue
    const label = collapse(m[1].replace(/\s+(?:under|as|in|into)\s+.+$/, ''))
    const text = keyWords(label)
    return text ? ok({ kind: 'forget', label, text }) : fail('Say which merchant: forget Amazon.')
  }

  const hide = HIDE_VERB.exec(s) ?? UNHIDE_VERB.exec(s)
  if (hide) {
    const query = parseQuery(hide[2], today)
    if (isError(query)) return fail(query.error)
    if (!query) return fail('Say which one: a merchant, an amount or a date.')
    return ok({ kind: HIDE_VERB.test(s) ? 'hide' : 'unhide', query })
  }

  const file = FILE_VERB.exec(s)
  const move = file ? null : MOVE_VERB.exec(s)
  const rest = file?.[2] ?? move?.[2]
  if (rest == null) {
    const bare = BARE_BUDGET.exec(s)
    if (bare) return budget(bare[1], bare[2])
    if (/\bbudget\b/.test(s)) {
      if (/-\s*\$?\s*\d/.test(s)) return fail('A budget cannot be negative.')
      return fail('Give the amount as a number, like: set Dining budget to 600.')
    }
    return fail(HELP)
  }
  const preps = file ? ['under', 'as', 'in', 'into', 'to'] : ['to', 'in', 'into', 'on', 'toward', 'towards', 'for', 'under', 'as']
  const tried = splits(rest, preps)
  for (const { head, tail } of tried) {
    const query = parseQuery(head, today)
    if (isError(query)) return fail(query.error)
    if (!query) continue
    // A day without a year goes near the day the row is moved from.
    const to = file ? null : parseDay(tail, today, query.date ?? today)
    if (to) return ok({ kind: 'move', query, to })
    const category = findCategory(tail, categories)
    if (category) return ok({ kind: 'file', query, category })
  }
  if (!file) return fail('Say where it goes: a day like Oct 1, a month, or a category.')
  // Say which part is missing: the charges, or a category that exists.
  if (new RegExp(`^(?:${preps.join('|')})\\s`).test(rest)) return fail(WHICH)
  const last = tried[0]
  if (!last) return fail('Name the category to file it under.')
  if (!parseQuery(last.head, today)) return fail(WHICH)
  return fail(`There is no category called "${last.tail}". Yours: ${names()}.`)
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

/** A saved rule "forget" takes back, as stored, so Undo can put it back. */
export interface ForgetRule {
  pattern: string
  flags: string
  category: string
  kind: TxType
  priority: number
  /**
   * The server's stamp, read when the rule is deleted (a plan has none). Undo
   * writes it back: rules that tie on priority are tried newest first, so a
   * fresh stamp put an older, broader rule ahead of the one that beat it.
   */
  updated_at?: string
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
      forget?: ForgetRule[]
      /** Matches left alone because they are still pending. */
      pending?: number
      /** Lines the preview shows under the rows, in order. */
      notes?: string[]
    }
  | { ok: false; message: string }

export interface PlanOptions {
  /** Today (YYYY-MM-DD). A day in another year shows its year. */
  today?: string
  /** False when a rule cannot be saved (signed out): none is planned or promised. */
  rules?: boolean
  /** The user's saved rules: for "forget", and to name a rule a new one takes over from. */
  userRules?: readonly UserRule[]
}

/** How a row reads in a preview, in two parts so the amount never ellipsizes. */
export function rowParts(t: Transaction): { name: string; amount: string } {
  const back = isRefund(t) || t.type === 'income'
  return { name: cleanMerchant(t.note || '') || 'Transaction', amount: `${back ? '+' : ''}${money(Math.abs(t.amount))}` }
}

/** 'Landlord LLC $2,400.00' or 'Amazon +$24.50'. */
export function rowLabel(t: Transaction): string {
  const { name, amount } = rowParts(t)
  return `${name} ${amount}`
}

/** The hide example, made from a real row so it always finds something. */
export function hideExample(t: Transaction | undefined): string {
  if (!t) return EXAMPLES[3]
  const name = cleanMerchant(t.note || '')
  return `hide ${name ? `${name} ` : ''}${money(Math.abs(t.amount), { trim: true })}`
}

const cents = (n: number) => Math.round(Math.abs(n) * 100)
const moneyBack = (t: Transaction) => isRefund(t) || t.type === 'income'

function matching(q: Query, txns: readonly Transaction[], categories: readonly Category[], removed = false) {
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
  // Removed rows are the ones a hand Delete or a hide pinned; a bank's own
  // tombstones (transfers, a pending row replaced by its posted copy, a pinned
  // pending row it retired: `retired`) stay out, or unhide counted them twice.
  const live = (t: Transaction) => (removed ? !!t.deleted && !!t.manual && !t.retired : !t.deleted)
  const base = txns.filter(
    (t) =>
      live(t) &&
      inText(t) &&
      (!q.sign || moneyBack(t)) &&
      (q.amount == null || cents(t.amount) === cents(q.amount)) &&
      (!q.month || t.date.startsWith(q.month)),
  )
  let rows = q.date ? base.filter((t) => t.date === q.date) : base
  // A remembered date is often a day or two off the bank's: fall back to ±3
  // days, but only to find a named merchant or amount. A day on its own means
  // that day, never the week around it.
  let widened = false
  if (q.date && rows.length === 0 && (q.text || q.amount != null)) {
    const d = Date.parse(q.date)
    rows = base.filter((t) => Math.abs(Date.parse(t.date) - d) <= 3 * DAY_MS)
    widened = rows.length > 0
  }
  return { rows, words: rows.filter(byWords), widened }
}

const newestFirst = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || (b.id ?? 0) - (a.id ?? 0)
/** Nearest to a day first; on a tie, the newer. */
const nearestTo = (iso: string) => {
  const d = Date.parse(iso)
  return (a: Transaction, b: Transaction) => Math.abs(Date.parse(a.date) - d) - Math.abs(Date.parse(b.date) - d) || newestFirst(a, b)
}

// ---- Rules -----------------------------------------------------------------
/** Words dropped from either end of a rule when the words as typed match nothing. */
const RULE_LEAD = new Set(['the', 'my', 'that', 'this', 'those', 'these', 'a', 'an'])
const RULE_TRAIL = new Set([
  'charge', 'charges', 'payment', 'payments', 'purchase', 'purchases', 'transaction', 'transactions',
  'transfer', 'transfers', 'bill', 'bills', 'one', 'ones',
])
/** One of these alone would catch many merchants. */
const GENERIC = new Set(['com', 'net', 'org', 'www', 'inc', 'llc', 'co', 'one', 'pay', 'payment', 'bill', 'card', 'bank', 'online', 'store', 'shop', 'pos', 'debit', 'us', 'the'])
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whole words in order, any punctuation or none between them: 'pay.gov', 'Chick-fil-A', 'AMERICANEXPRESS'. */
const BOUND_START = '(?:^|[^a-z0-9])'
const BOUND_END = '(?![a-z0-9])'
const SEP = '[^a-z0-9]*'
const boundPattern = (tokens: string[], joint = SEP) => `${BOUND_START}${tokens.map(esc).join(joint)}${BOUND_END}`
/** Between key words, the short filler words matching() skips ('bread in box' for 'Bread in a Box'). */
const FILLER_JOINT = `(?:[^a-z0-9]+(?:a|an|the|of|on|at|for|my|and|&))*${SEP}`

/** The rule's words as a person reads them: '(?:^|[^a-z0-9])pay[^a-z0-9]*gov(?![a-z0-9])' → 'pay gov'. */
export function ruleWords(pattern: string): string {
  const inner = pattern.startsWith(BOUND_START) && pattern.endsWith(BOUND_END) ? pattern.slice(BOUND_START.length, -BOUND_END.length) : pattern
  return inner.split(FILLER_JOINT).join(' ').split(SEP).join(' ').split(' ?').join(' ').replace(/\\(.)/g, '$1').trim()
}

type BuiltRule = { pattern: string; rows: Transaction[]; shown: string } | { refuse: string }

/**
 * The rule for a standing "file": built from the words as typed, bounded to
 * whole words, most specific first: the words as typed, then without trailing
 * nouns ('charges'), then without leading determiners ('the'). The first that
 * matches a row is the rule, and those rows are exactly what the preview
 * files. Null when nothing matches; { refuse } when the words are too short or
 * too common to pick out one merchant.
 */
function buildRule(label: string, pool: readonly Transaction[], exactOnly: boolean): BuiltRule | null {
  const t0 = norm(label).split(' ').filter(Boolean)
  if (!t0.length) return null
  const trail = (t: string[]) => {
    let x = t
    while (x.length > 1 && RULE_TRAIL.has(x[x.length - 1])) x = x.slice(0, -1)
    return x
  }
  const lead = (t: string[]) => {
    let x = t
    while (x.length > 1 && RULE_LEAD.has(x[0])) x = x.slice(1)
    return x
  }
  const tries: { pattern: string; tokens: string[] }[] = []
  for (const t of exactOnly ? [t0] : [t0, trail(t0), lead(t0), lead(trail(t0))]) {
    if (!tries.some((x) => x.tokens.join(' ') === t.join(' '))) tries.push({ pattern: boundPattern(t), tokens: t })
  }
  const keys = t0.filter((w) => !FILLER.has(w))
  if (!exactOnly && keys.length > 1) tries.push({ pattern: boundPattern(keys, FILLER_JOINT), tokens: keys })
  for (const { pattern, tokens } of tries) {
    const re = new RegExp(pattern, 'i')
    const rows = pool.filter((t) => re.test(t.note || '') || re.test(cleanMerchant(t.note || '')))
    if (!rows.length) continue
    const letters = tokens.join('').replace(/[^a-z]/g, '')
    if (letters.length < 3 || (tokens.length === 1 && GENERIC.has(tokens[0]))) return { refuse: tokens.join(' ') }
    return { pattern, rows, shown: tokens === t0 ? label : tokens.join(' ') }
  }
  return null
}

// ---- Words for titles ------------------------------------------------------
const SHOW_LEAD = new Set(['the', 'my', 'that', 'this', 'those', 'these', 'a', 'an'])
const SHOW_TRAIL = new Set(['charge', 'charges', 'payment', 'payments', 'purchase', 'purchases', 'transaction', 'transactions', 'transfer', 'transfers'])
/**
 * The merchant as the user named it: 'pay.gov' → 'Pay.gov', 'the amazon
 * charges' → 'Amazon'. "refund" stays only when it is part of the name (a rule
 * was built from the words exactly as typed: 'ATM Fee Refund').
 */
function shownName(q: Query, keepRefund: boolean): string {
  if (!q.text) return ''
  const w = (q.sign && !keepRefund ? q.label.replace(REFUND_WORD, ' ') : q.label).split(' ').filter(Boolean)
  while (w.length && SHOW_LEAD.has(norm(w[0]))) w.shift()
  while (w.length && SHOW_TRAIL.has(norm(w[w.length - 1]))) w.pop()
  return titleCase(w.join(' ') || q.text)
}
/** What the rows are: charges, refunds, deposits, or transactions for a mix. */
const nounFor = (rows: readonly Transaction[], kind: TxType) =>
  kind === 'income' ? 'deposits' : rows.every(isRefund) ? 'refunds' : rows.some(isRefund) ? 'transactions' : 'charges'

export function planCommand(cmd: Command, txns: readonly Transaction[], categories: readonly Category[], opts: PlanOptions = {}): Plan {
  const today = opts.today ?? todayISO()
  const year = Number(today.slice(0, 4))
  const dayOf = (iso: string) => dayLabel(iso, year)
  const monthName = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', ...(y !== year ? { year: 'numeric' } : {}) })
  }
  const canRule = opts.rules !== false
  const userRules = opts.userRules ?? getUserRules()

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

  if (cmd.kind === 'forget') {
    if (!canRule) return { ok: false, message: 'Sign in to change your rules.' }
    // Only the rules Tell Tally saved; the user's own rules are theirs to edit.
    const mine = userRules.filter((r) => r.priority <= TELL_PRIORITY)
    const named = matching({ text: cmd.text, label: cmd.label, all: true }, txns, categories).words
    const hits = mine.filter((r) => r.match.test(cmd.label) || r.match.test(cmd.text) || named.some((t) => r.match.test(t.note || '')))
    if (hits.length === 0) return { ok: false, message: `There is no Tell Tally rule for "${cmd.label}".` }
    const name = titleCase(cmd.label)
    return {
      ok: true,
      title: hits.length === 1 ? `Stop filing ${name} under ${hits[0].category}` : `Forget ${hits.length} rules for ${name}`,
      rows: [],
      others: 0,
      forget: hits.map((r) => ({ pattern: r.pattern, flags: r.match.flags, category: r.category, kind: r.kind, priority: r.priority })),
      notes: [
        ...(hits.length > 1 ? hits.map((r) => `"${ruleWords(r.pattern)}" under ${r.category}`) : []),
        'Charges already filed stay where they are. New ones go back to the usual guess.',
      ],
    }
  }

  let q = cmd.query
  const removed = cmd.kind === 'unhide'
  let found = matching(q, txns, categories, removed)
  // Another reading when this one finds nothing: 'Pay in 4' (a bare number in
  // the name), 'hotel august' (a month word in the name), 'september amazon'.
  for (const a of found.rows.length === 0 ? (q.alt ?? []) : []) {
    const again: Query = { ...q, ...a, alt: undefined }
    if (!again.text && again.amount == null && !again.date) continue
    const second = matching(again, txns, categories, removed)
    if (second.rows.length) {
      q = again
      found = second
      break
    }
  }
  if (found.rows.length === 0) {
    if (q.date && !q.text && q.amount == null) return { ok: false, message: `Nothing on ${dayOf(q.date)}.` }
    const what = [q.text, q.amount != null ? money(q.amount) : '', q.date ? dayOf(q.date) : '', q.month ? monthName(q.month) : '']
    return { ok: false, message: `Nothing matches "${what.filter(Boolean).join(' ')}".` }
  }
  // "all" never acts on the days around the one named: name the day instead.
  if (found.widened && q.all) {
    const near = [...found.rows].sort(nearestTo(q.date!))[0]
    return { ok: false, message: `Nothing on ${dayOf(q.date!)}. The nearest is ${dayOf(near.date)}; say that day.` }
  }

  // Pending charges are left alone, as the sort queue leaves them: the bank
  // retires a pending row when it posts, and an edit reaches the posted row
  // only by a guess (banks.ts). A set the words name ("all", a day, a month)
  // skips them. Without one, the most recent match is the one meant, pending
  // or not, and a pending one is said rather than skipped: reaching past it
  // took an older month's charge (September's rent, moved onto Oct 1 beside
  // October's own still-pending rent, so October counted rent twice).
  const named = q.all || !!q.date || !!q.month
  const pending = found.rows.filter((t) => t.pending).length
  const settled = pending ? found.rows.filter((t) => !t.pending) : found.rows
  const stillPending: Plan = {
    ok: false,
    message: pending === 1 ? 'That charge is still pending. Try again once it posts.' : 'Those charges are still pending. Try again once they post.',
  }
  /** The most recent match has not posted: say which, and how to pick an older one. */
  const newestPending = (t: Transaction, total: number): Plan =>
    total > 1
      ? { ok: false, message: `The most recent, ${rowLabel(t)} on ${dayOf(t.date)}, is still pending. Try again once it posts, or add a day to pick an older one.` }
      : stillPending
  const notes: string[] = []
  /** Pending matches a named set left out, for the preview to say. */
  let skipped = 0
  const finish = (p: Extract<Plan, { ok: true }>): Plan => ({
    ...p,
    ...(skipped ? { pending: skipped } : {}),
    ...(notes.length ? { notes } : {}),
  })

  const order = found.widened ? nearestTo(q.date!) : newestFirst
  type Choice = { picked: Transaction[]; one: Transaction | null; others: number }
  /**
   * The rows a hide or unhide acts on: a named set's posted rows, or else the
   * most recent match, which must have posted.
   */
  const choose = (): Choice | { fail: Plan } => {
    if (named) {
      if (settled.length === 0) return { fail: stillPending }
      skipped = pending
      return pick(settled)
    }
    const sorted = [...found.rows].sort(order)
    if (sorted[0].pending) return { fail: newestPending(sorted[0], sorted.length) }
    return { picked: [sorted[0]], one: sorted[0], others: sorted.length - 1 }
  }
  const pick = (pool: readonly Transaction[]) => {
    const sorted = [...pool].sort(order)
    const picked = q.all ? sorted : sorted.slice(0, 1)
    return { picked, one: picked.length === 1 ? picked[0] : null, others: sorted.length - picked.length }
  }
  /** Says which one was picked when others matched too. */
  const pickNote = (total: number) => {
    if (found.widened) {
      notes.push(`Nothing on ${dayOf(q.date!)}; this is the nearest${total > 1 ? ` of ${total}. Say its day to pick another` : ''}.`)
    } else if (total > 1) {
      notes.push(`The most recent of ${total}. Add ${q.amount != null ? 'a day or a month' : 'an amount, a day or a month'} to pick another, or say "all".`)
    }
  }

  if (cmd.kind === 'file') {
    const cat = cmd.category
    const sameKind = found.rows.filter((t) => t.type === cat.kind)
    if (sameKind.length === 0) {
      return { ok: false, message: `Those are ${cat.kind === 'income' ? 'spending' : 'income'}; ${cat.name} is an ${cat.kind} category.` }
    }
    // An amount or a day names one charge, as it does for move and hide.
    const narrowed = q.amount != null || !!q.date
    // A merchant named with no amount, day or month is a standing instruction:
    // save a rule so new charges follow. Words matched only as a category name
    // are not a merchant, so no rule for those.
    const standing = !!q.text && !narrowed && !q.month && found.words.length > 0
    let scope = sameKind
    let rule: RulePlan | undefined
    let ruleShown = ''
    if (standing && canRule) {
      const pool = txns.filter((t) => !t.deleted && t.type === cat.kind)
      // "refund" in the words: a rule only when it is part of the name ('ATM Fee Refund').
      const built = buildRule(q.label, pool, !!q.sign)
      if (built && 'refuse' in built) {
        notes.push(`No rule saved: "${built.refuse}" is too short or too common to pick out one merchant, so new charges are not filed by it.`)
      } else if (built) {
        rule = { pattern: built.pattern, category: cat.name, kind: cat.kind, priority: TELL_PRIORITY }
        ruleShown = built.shown
        // Exactly what the rule catches, plus rows matched only by a category name.
        const words = new Set(found.words)
        const inRule = new Set(built.rows)
        scope = [...built.rows, ...sameKind.filter((t) => !words.has(t) && !inRule.has(t))]
      } else {
        notes.push('No rule saved: these charges do not share a name the rule could follow.')
      }
    } else if (standing) {
      notes.push('Sign in to have new charges from this merchant follow too.')
    }
    let rows: Transaction[]
    let others: number
    if (narrowed && !named) {
      // An amount alone names the most recent such charge, as in move and hide:
      // never an older month's one past it.
      const sorted = [...scope].sort(order)
      const t = sorted[0]
      if (t.categoryId === cat.id) return { ok: false, message: `${rowLabel(t)} on ${dayOf(t.date)} is already under ${cat.name}.` }
      if (t.pending) return newestPending(t, sorted.length)
      rows = [t]
      others = sorted.length - 1
    } else {
      skipped = pending
      const pool = scope.filter((t) => !t.pending && t.categoryId !== cat.id).sort(newestFirst)
      ;({ picked: rows, others } = narrowed ? pick(pool) : { picked: pool, others: 0 })
    }
    const noun = nounFor(rows.length ? rows : scope, cat.kind)
    const names = new Set(rows.map((t) => cleanMerchant(t.note || '')))
    const who = shownName(q, !!rule) || (names.size === 1 ? [...names][0] : '')
    if (rows.length === 0 && !rule) {
      // A saved rule still files a pending charge when it posts; without one, wait.
      if (scope.some((t) => t.pending && t.categoryId !== cat.id)) return stillPending
      if (standing && !canRule) {
        return { ok: false, message: `Already filed under ${cat.name}. Sign in to have new ${who} ${cat.kind === 'income' ? 'deposits' : 'charges'} follow it.` }
      }
      return { ok: false, message: `Already filed under ${cat.name}.` }
    }
    const tail = `under ${cat.name}${rule ? ', and new ones too' : ''}`
    const when = q.date ? (rows.every((t) => t.date === rows[0].date) ? ` from ${dayOf(rows[0].date)}` : ` near ${dayOf(q.date)}`) : ''
    const title =
      rows.length === 0
        ? `New ${who} ${cat.kind === 'income' ? 'deposits' : 'charges'} will go under ${cat.name}`
        : rows.length === 1
          ? `File ${rowLabel(rows[0])} from ${dayOf(rows[0].date)} ${tail}`
          : `File ${rows.length} ${who ? `${who} ${noun}` : noun === 'charges' ? 'transactions' : noun}${when} ${tail}`
    if (rule) {
      notes.unshift(`New ${cat.kind === 'income' ? 'deposits' : 'charges'} matching "${ruleShown}" will go under ${cat.name} too.`)
      // A newer Tell Tally rule wins a tie, and every user rule sits after it.
      const over = userRules.filter(
        (r) => r.kind === cat.kind && r.category.toLowerCase() !== cat.name.toLowerCase() && scope.some((t) => r.match.test(t.note || '')),
      )
      if (over.length) notes.push(`This takes over from your rule that files them under ${[...new Set(over.map((r) => r.category))].join(', ')}.`)
    }
    // Moving a fixed bill (Rent) out of its category changes that budget's month.
    const catOf = new Map(categories.map((c) => [c.id, c]))
    const fixed = rows.filter((t) => {
      const c = t.categoryId != null ? catOf.get(t.categoryId) : undefined
      return !!c && isFixed(c)
    })
    if (fixed.length) {
      const from = [...new Set(fixed.map((t) => catOf.get(t.categoryId!)!.name))].join(' and ')
      notes.push(`Includes ${from}: ${fixed.slice(0, 2).map(rowLabel).join(', ')}${fixed.length > 2 ? ` and ${fixed.length - 2} more` : ''}.`)
    }
    if (narrowed && rows.length === 1) pickNote(others + 1)
    // A bank payment filed into Rent counts on the 1st it pays for, as the bank
    // sync would have dated it; filed out of Rent, on the day the bank posted it
    // (bankRules.rentRefile). The old date rides in `before`, so Undo puts it back.
    const wasRent = (t: Transaction) => {
      const c = t.categoryId != null ? catOf.get(t.categoryId) : undefined
      return !!c && isRentCategory(c)
    }
    return finish({
      ok: true,
      title,
      rows: rows.map((t) => {
        const move = rentRefile(t, wasRent(t), isRentCategory(cat))
        // Filing lifts a hand clear (Transaction.uncategorized); Undo puts it back.
        const lift = t.uncategorized ? { uncategorized: true } : {}
        const before = { categoryId: t.categoryId, manual: t.manual, ...lift }
        const after = { categoryId: cat.id!, manual: true, ...(t.uncategorized ? { uncategorized: false } : {}) }
        // The re-file's date is the app's own move (Transaction.dateMoved),
        // unless it puts back the bank's day.
        const mark = move ? dateMovedMark(move.date, move.posted ?? t.posted) : false
        return move
          ? {
              t,
              before: { ...before, date: t.date, posted: t.posted, dateMoved: t.dateMoved },
              after: { ...after, ...move, dateMoved: mark },
              to: `${cat.name} · ${dayOf(move.date)}`,
            }
          : { t, before, after, to: cat.name }
      }),
      others,
      rule,
    })
  }

  if (cmd.kind === 'unhide') {
    const c = choose()
    if ('fail' in c) return c.fail
    const { picked, one, others } = c
    if (one) pickNote(others + 1)
    return finish({
      ok: true,
      title: one ? `Unhide ${rowLabel(one)} from ${dayOf(one.date)}` : `Unhide ${picked.length} transactions`,
      rows: picked.map((t) => ({ t, before: { deleted: true }, after: { deleted: false }, to: 'Back' })),
      others,
    })
  }

  /**
   * A refund for the picked charge (or the charge for a picked refund): the
   * same amount, the other sign, the refund on or after the charge within 90
   * days. With merchant words both already matched them; with only an amount,
   * the cleaned names must agree too.
   */
  const twinOf = (one: Transaction): Transaction | undefined => {
    const back = isRefund(one)
    const name = cleanMerchant(one.note || '')
    const fits = (charge: Transaction, refund: Transaction) =>
      refund.date >= charge.date && Date.parse(refund.date) - Date.parse(charge.date) <= 90 * DAY_MS
    return settled
      .filter(
        (t) =>
          t !== one &&
          t.type === 'expense' &&
          one.type === 'expense' &&
          isRefund(t) !== back &&
          cents(t.amount) === cents(one.amount) &&
          (!!q.text || cleanMerchant(t.note || '') === name) &&
          (back ? fits(t, one) : fits(one, t)),
      )
      .sort(nearestTo(one.date))[0]
  }
  // An amount with no sign and no day: a refunded purchase is the pair.
  const pairs = q.amount != null && !q.sign && !q.date && !q.all

  if (cmd.kind === 'hide') {
    const c = choose()
    if ('fail' in c) return c.fail
    const { picked, one, others } = c
    const twin = one && pairs ? twinOf(one) : undefined
    const rows = twin ? [one!, twin].sort((a, b) => Number(isRefund(a)) - Number(isRefund(b))) : picked
    const left = twin ? others - 1 : others
    let title = one ? `Hide ${rowLabel(one)} from ${dayOf(one.date)}` : `Hide ${picked.length} transactions`
    if (twin) {
      const [charge, refund] = rows
      // Hiding one leg alone moves spending by its amount; the pair moves it by nothing.
      title = `Hide ${rowLabel(charge)} (${dayOf(charge.date)}) and its refund +${money(Math.abs(refund.amount))} (${dayOf(refund.date)})`
      if (left > 0) notes.push(`${left} other ${left === 1 ? 'match is' : 'matches are'} left alone. Add a day to pick another, or say "all".`)
    } else if (one) {
      pickNote(others + 1)
    }
    notes.push('Hidden rows leave every total. Bring one back from Activity › Removed, or say "unhide".')
    return finish({
      ok: true,
      title,
      rows: rows.map((t) => ({ t, before: { deleted: !!t.deleted, manual: t.manual }, after: { deleted: true, manual: true }, to: 'Hidden' })),
      others: left,
    })
  }

  const to = cmd.to
  // With "all", a day or a month, the rows were named: skip any already there,
  // and any still pending. Otherwise the most recent match is the one meant,
  // pending or not. If it is already there, or still pending, say so: reaching
  // past it took an older month's charge (September's rent) and counted it
  // twice in the month it moved to.
  let picked: Transaction[]
  let others: number
  if (named) {
    const away = found.rows.filter((t) => t.date !== to)
    if (away.length === 0) return { ok: false, message: `Already on ${dayOf(to)}.` }
    const pool = away.filter((t) => !t.pending)
    if (pool.length === 0) return stillPending
    skipped = away.length - pool.length
    ;({ picked, others } = pick(pool))
  } else {
    let sorted = [...found.rows].sort(order)
    // An amount with no sign means the charge, not its refund.
    if (pairs) {
      const charge = sorted.find((t) => !isRefund(t))
      if (charge) sorted = [charge, ...sorted.filter((t) => t !== charge)]
    }
    const t = sorted[0]
    if (t.date === to) return { ok: false, message: `${rowLabel(t)} is already on ${dayOf(to)}.` }
    if (t.pending) return newestPending(t, sorted.length)
    picked = [t]
    others = sorted.length - 1
  }
  const one = picked.length === 1 ? picked[0] : null
  if (one) {
    pickNote(others + 1)
    const twin = pairs ? twinOf(one) : undefined
    if (twin && isRefund(twin)) notes.push(`Its refund +${money(Math.abs(twin.amount))} on ${dayOf(twin.date)} stays where it is.`)
    // The same charge already in the month it moves to (pending or not) would
    // count twice there: the same amount and sign, from the same merchant or
    // in the same category.
    const month = to.slice(0, 7)
    const name = cleanMerchant(one.note || '')
    const twice = txns.find(
      (t) =>
        t.id !== one.id &&
        !t.deleted &&
        t.type === one.type &&
        t.date.startsWith(month) &&
        cents(t.amount) === cents(one.amount) &&
        isRefund(t) === isRefund(one) &&
        (cleanMerchant(t.note || '') === name || (t.categoryId != null && t.categoryId === one.categoryId)),
    )
    if (twice) notes.push(`${monthName(month)} already has ${rowLabel(twice)} on ${dayOf(twice.date)}${twice.pending ? ' (pending)' : ''}.`)
  }
  return finish({
    ok: true,
    title: one ? `Move ${rowLabel(one)} from ${dayOf(one.date)} to ${dayOf(to)}` : `Move ${picked.length} transactions to ${dayOf(to)}`,
    // Marked as the user's move (Transaction.dateMoved), so the bank never
    // re-dates it; Undo takes the mark back with the date.
    rows: picked.map((t) => ({
      t,
      before: { date: t.date, manual: t.manual, dateMoved: t.dateMoved },
      after: { date: to, manual: true, dateMoved: dateMovedMark(to, t.posted) },
      to: dayOf(to),
    })),
    others,
  })
}
