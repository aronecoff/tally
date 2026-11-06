import { CARD_CREDIT_NOT_REFUND_RE, tierFromRows } from './bankRules'
import { EXPORT_HEADERS, isBalanceLine, isTypeHeader, isWide, readTable, rowFigure, saysWay } from './csv'
import type { ImportColumns, RowKind, SignMode } from './csvImport'
import { isOfx, parseOfx } from './ofx'

const MAX_BYTES = 25 * 1024 * 1024

/** A chosen file, ready to stage. A CSV and an OFX file end up the same shape. */
export interface ImportFile {
  format: 'csv' | 'ofx'
  headers: string[]
  rows: string[][]
  /** Which column is which: read from the headers, and the person can change it. */
  cols: ImportColumns
  sign: SignMode
  /** False when nothing settles `sign`, so the person has to look. */
  signProven: boolean
  /** The bank's own id for each row, where the file has one. */
  ids?: string[]
  /** Which rows are a card's, where the file says. */
  cards?: boolean[]
  /** What each row is, where the file says, as this app's own export does. */
  kinds?: (RowKind | undefined)[]
  /** Which rows, on a card, are it being paid, as the file words or types them. */
  paid?: boolean[]
  /** The account's label for the ledger, where the file says. */
  account?: string
  /** What an OFX file holds, to say above its rows. */
  title?: string
}

/** Why a file cannot be read, in words for the sheet. */
export class ImportFileError extends Error {}

/**
 * Bytes to text. Banks still write Windows-1252, and read as UTF-8 that turns
 * every accented merchant into replacement marks. A file that is not valid UTF-8
 * is taken as 1252, which never fails.
 */
export function decodeText(bytes: ArrayBuffer): string {
  const head = new Uint8Array(bytes.slice(0, 2))
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** A short, safe hint at an account: the last four, and never the whole number. */
const lastFour = (account: string) => account.replace(/\s/g, '').slice(-4)

function fromOfx(text: string): ImportFile {
  const { org, statements } = parseOfx(text)
  const filled = statements.filter((s) => s.rows.length > 0)
  if (filled.length === 0) throw new ImportFileError('That file has no transactions in it.')
  const first = filled[0]
  const one = filled.length === 1
  const label = one && first.account ? `${org || (first.card ? 'Card' : 'Account')} ··${lastFour(first.account)}` : ''
  return {
    format: 'ofx',
    headers: ['Date', 'Amount', 'Description', 'Memo'],
    rows: filled.flatMap((s) => s.rows.map((r) => [r.date, r.amount, r.name, r.memo])),
    cols: { date: 0, amount: 1, note: 2, memo: 3 },
    sign: filled.some((s) => s.card) ? 'card-negative' : 'negative-expense',
    signProven: true,
    ids: filled.flatMap((s) => s.rows.map((r) => (r.id ? `${s.account}|${r.id}` : ''))),
    cards: filled.flatMap((s) => s.rows.map(() => s.card)),
    account: label,
    title: one ? label || (first.card ? 'A card statement' : 'A bank statement') : `${filled.length} statements`,
  }
}

/** How an issuer's line says a payment came in. */
const CHANNEL = String.raw`(?:auto(?:matic|pay)?|online|mobile|internet|electronic|web|phone|ach)`
const PAYMENT = String.raw`(?:payment|pymt|pmt|autopay)`

/**
 * A card's own line for being paid, and nothing but that line: PAYMENT THANK YOU,
 * AUTOMATIC PAYMENT - THANK, THANK YOU FOR YOUR PAYMENT. A row of anyone else's words
 * can hold the same ones, as a Zelle's memo or a shop's name does.
 */
const CARD_PAID = new RegExp(
  String.raw`^(?:${CHANNEL}\W+){0,2}${PAYMENT}(?:\W+received)?\W+thank(?:\s*y(?:ou?)?)?\b(?:\W+${CHANNEL})?[\W\d]*$` +
    String.raw`|^thank\s*you\W+for\W+(?:your\W+)?(?:${CHANNEL}\W+)?${PAYMENT}\b[\W\d]*$`,
  'i',
)

/**
 * A card's line with no thanks in it: BA ELECTRONIC PAYMENT, Payment Received. A bank
 * writes the same words for a bill it paid, and a payer for a deposit, so one of these
 * proves nothing: it only asks, against the rest of a file and only where all of it
 * fits a card. The spellings are remembered from statements, not read from real exports.
 */
const BARE_PAID = new RegExp(
  String.raw`^(?:(?:ba|capital one)\W+)?(?:electronic|online|mobile|internet|automatic|autopay)\W+${PAYMENT}[\W\d]*$` +
    String.raw`|^payment\W+received[\W\d]*$|^directpay\W+full\W+balance[\W\d]*$`,
  'i',
)

/** A column for a card's number or holder. A debit card's sits on a bank account. */
const isCardHeader = (h: string) => /\bcard\b|cardholder|cardmember|\bmember name\b/i.test(h) && !/debit/i.test(h)

/** Columns a bank account has and a card does not. A balance that runs down the rows is one. */
const BANK_HEADER = /\bbank\b|\bbal(?:ance)?\b|source account|\bpayer\b|\biban\b|sort code|routing/i

/** Apple Card's columns. Any file can have them, so they name a card and prove none. */
const isCardExport = (headers: string[]) =>
  headers.some((h) => /^amount \(?usd\)?$/i.test(h)) && headers.some((h) => /^(purchased by|clearing date)$/i.test(h))

const APPLE_TYPE = /^(purchase|payment|return|refund|credit|debit|adjustment|fee|interest|installment)$/i
const CHARGE_TYPE = /^(purchase|sale)$/i
const PAID_TYPE = /^payment$/i
const BACK_TYPE = /^(payment|return|refund|credit)$/i
const CARD_TYPE = /^(purchase|sale|payment|return|refund|adjustment|fee|interest|installment)$/i

/**
 * A Type column in a card's words, filled on most of its rows and most of them its
 * charges. Debit, Credit and Other are any account's words, PayPal's says Payment on
 * every row, a bank's says Deposit, and one Return beside them proves nothing.
 */
function saysCard(types: string[]): boolean {
  const said = types.filter(Boolean)
  return said.length > 0 && said.length * 2 >= types.length && said.every((t) => CARD_TYPE.test(t)) && said.filter((t) => CHARGE_TYPE.test(t)).length * 2 >= said.length
}

/** How far a file's figures must lean one way to say which way a card's charges read. */
const LEAN = 0.7

/** What a plain-charges card calls money coming back. A bank's money out rarely reads so, and a credit card or a credit union is only a name. */
const BACK_WORDS = /\b(?:credit|return|refund|reversal)\b(?!\s+(?:card|crd|union))/i

/** How many typical charges a credit must come to before a card could not have given it back. */
const LARGE = 3

/** Fewer rows than this are too few to stop for on their mix alone: a window of a checking account can look like anything. */
const SHORT = 5

/** Money in that a charge never reads like. Beside these, tierFromRows knows pay and deposits by channel. */
const MONEY_IN = /^deposit\b|^interest (?:paid|earned)\b|\bearnings\b|\bdividends?\b/i

interface SignRow {
  a: number
  note: string
  type: string
}

const share = (rows: SignRow[], test: (r: SignRow) => boolean) => (rows.length > 0 ? rows.filter(test).length / rows.length : 0)

/**
 * Rows as Apple Card writes them: its own words on most of them, its purchases as plain
 * figures whatever else a month holds, and money back the other way. A month with no
 * purchase in it is all money back.
 */
function writesApple(rows: SignRow[]): boolean {
  const said = rows.filter((r) => r.type)
  const telling = said.filter((r) => CHARGE_TYPE.test(r.type) || BACK_TYPE.test(r.type))
  const applesWay = (r: SignRow) => (CHARGE_TYPE.test(r.type) ? r.a > 0 : r.a < 0)
  const figures = said.some((r) => CHARGE_TYPE.test(r.type)) ? share(telling, applesWay) >= LEAN : rows.every((r) => r.a < 0)
  return said.length > 0 && said.length * 2 >= rows.length && said.every((r) => APPLE_TYPE.test(r.type)) && figures
}

const median = (figures: number[]) => [...figures].sort((a, b) => a - b)[Math.floor(figures.length / 2)] ?? 0

/** Whether a row's words say money came into a bank account. */
function saysBank(rows: SignRow[]): boolean {
  const feed = rows.map((r) => ({ sourceTxId: '', account: '', tier: '', posted: 0, amount: r.a, description: r.note, payee: '', memo: '', mcc: null }))
  return tierFromRows(feed) === 'cash' || rows.some((r) => r.a > 0 && MONEY_IN.test(r.note))
}

const total = (rows: SignRow[]) => rows.reduce((sum, r) => sum + r.a, 0)

/**
 * Whether a bank's words sit on most of the money that came in. One such row among
 * others could be a charge: a card's charges are its plain figures, and a shop can be
 * called anything.
 */
function bankHoldsMoneyIn(rows: SignRow[]): boolean {
  const coming = rows.filter((r) => r.a > 0)
  return total(coming.filter((r) => saysBank([r]))) * 2 >= total(coming)
}

/**
 * Whether rows read as a card's, given which way its charges run. Most of a card's
 * rows are charges. Pay lands on a bank account. And a card gives back what it
 * charged, so a credit far above a typical charge is money coming in, however large
 * one charge is, unless it matches a charge or its words say the card was paid.
 * Against plain charges a large row says nothing: it is a payment.
 */
function fitsCard(charge: 1 | -1, rows: SignRow[]): boolean {
  const charges = rows.filter((r) => r.a * charge > 0)
  const back = rows.filter((r) => r.a * charge < 0)
  if (charges.length < back.length || saysBank(rows)) return false
  if (charge > 0) return true
  const typical = median(charges.map((r) => -r.a))
  return !back.some((r) => r.a > typical * LARGE && !CARD_CREDIT_NOT_REFUND_RE.test(r.note) && !charges.some((c) => c.a === -r.a))
}

/** The bare issuer lines that run against most of the rows around them, as a payment would against a card's charges. */
function bareLines(rows: SignRow[]): SignRow[] {
  const rest = rows.filter((r) => !BARE_PAID.test(r.note))
  return rows.filter((r) => BARE_PAID.test(r.note) && share(rest, (other) => other.a * r.a < 0) >= LEAN)
}

/** What is left in doubt when a sign is not proven: a card's evidence the rows contradict, a mix of both ways, or money out in a card's words for money back. */
export type SignDoubt = 'mixed' | 'payment' | 'card' | 'back'

/** What a proven read rests on, where that is one thing a file could have by chance: a person should be able to see it. */
export type SignNote = 'line' | 'column' | 'lean'

export interface SignRead {
  sign: SignMode
  proven: boolean
  /** Unset when most of the figures are plain and nothing says more. */
  doubt?: SignDoubt
  note?: SignNote
}

/**
 * Which way a file's figures run, best evidence first, and each only where the rest of
 * the file agrees. No list of rules settles every file, so these only say when to stop
 * and ask: what makes a wrong read hard to miss is the sheet stating what an import will
 * write, above its button (`summarizeImport`).
 *
 * Money back written as negatives in a Credit column, beside plain figures in a Debit
 * column, is Citi's way with a card, whatever those rows say, unless a running balance
 * or pay says it is a bank's. Apple's own Type words on its figures say Apple Card. A
 * Type column in a card's words says which rows are charges, though a shop's own sales
 * read like plain charges, so on that side it needs a card's own line to back it. That
 * line says it alone too: its sign is the opposite of a charge's. A column for a card
 * only names one, and Mercury's bank files have that too. A running balance beside any
 * of these is a bank's, so that file is asked about. Every row going out reads the same
 * either way, so nothing is.
 *
 * A card's bare line proves nothing, but it does ask, where the rest of a file fits a
 * card. Anything else is a bank account, as long as it looks like one: mostly money out,
 * or money in that is mostly in a bank's words. Mostly plain figures can be a savings
 * account or a run of paydays, so the person is asked. So they are of money out that
 * mostly calls itself a credit or a return, with no balance beside it: a plain-charges
 * card's money back. Rows split evenly can be a card with many credits, so those ask
 * too, unless a running balance says otherwise or the file is too short to stop for.
 * With fewer rows in than out only an income or refund is at stake, so that reads as a
 * bank, and says so unless a bank's words sit on most of what came in.
 *
 * That leaves a known limit. A card with negative charges and no column of its own, in a
 * month with a return and no payment, is a checking month to every test here: the same
 * words and the same figures. It reads as a bank, and that one return counts as income.
 * It shows under Money in, above the button, and Card is one tap.
 */
export function readSign(amounts: (number | null)[], notes: string[], headers: string[] = [], types: string[] = [], creditsNegative = false): SignRead {
  const rows = amounts.flatMap((a, i) => (a ? [{ a, note: notes[i] ?? '', type: types[i] ?? '' }] : []))
  const plain = share(rows, (r) => r.a > 0)
  const bankHeader = headers.some((h) => BANK_HEADER.test(h))
  const bankColumns = plain > 0 && bankHeader
  const asCard = (charge: 1 | -1, lines: SignRow[], doubt: SignDoubt, note?: SignNote): SignRead => {
    const paid = new Set(lines)
    if (!bankColumns && lines.every((r) => r.a * charge < 0) && fitsCard(charge, rows.filter((r) => !paid.has(r)))) {
      return { sign: charge > 0 ? 'card-positive' : 'card-negative', proven: true, note: plain > 0 ? note : undefined }
    }
    return plain === 0 ? { sign: 'negative-expense', proven: true } : { sign: 'negative-expense', proven: false, doubt }
  }

  if (creditsNegative && !bankHeader && !saysBank(rows)) return { sign: 'card-negative', proven: true }
  if (isCardExport(headers) && !bankColumns && writesApple(rows)) return { sign: 'card-positive', proven: true }
  const lines = rows.filter((r) => CARD_PAID.test(r.note))
  if (saysCard(rows.map((r) => r.type))) {
    const up = share(rows.filter((r) => CHARGE_TYPE.test(r.type)), (r) => r.a > 0)
    if (up >= LEAN && !lines.some((r) => r.a < 0)) return { sign: 'negative-expense', proven: false, doubt: 'card' }
    const back = rows.filter((r) => BACK_TYPE.test(r.type) || CARD_PAID.test(r.note))
    // A card's own line beside negative charges is a second proof, and most months of a Chase file have one.
    return asCard(up >= LEAN ? 1 : -1, back, 'card', up >= LEAN ? 'line' : lines.length > 0 ? undefined : 'column')
  }
  if (lines.length > 0) return asCard(lines[0].a > 0 ? -1 : 1, lines, 'payment', 'line')
  if (isCardExport(headers) || headers.some(isCardHeader)) {
    const charge = plain >= 0.5 ? 1 : -1
    if (!fitsCard(charge, rows) || bankColumns) return { sign: 'negative-expense', proven: false, doubt: 'card' }
    const proven = plain >= LEAN || plain <= 1 - LEAN
    return { sign: charge > 0 ? 'card-positive' : 'card-negative', proven, note: proven && plain > 0 ? 'column' : undefined }
  }
  const bare = bareLines(rows)
  if (bare.length > 0 && asCard(bare[0].a > 0 ? -1 : 1, bare, 'payment').proven) return { sign: 'negative-expense', proven: false, doubt: 'payment' }
  if (plain >= LEAN) return { sign: 'negative-expense', proven: false }
  if (!bankHeader && share(rows.filter((r) => r.a < 0), (r) => BACK_WORDS.test(r.note)) >= 0.5) return { sign: 'negative-expense', proven: false, doubt: 'back' }
  if (plain <= 1 - LEAN) return { sign: 'negative-expense', proven: true }
  if (bankColumns && saysBank(rows)) return { sign: 'negative-expense', proven: true }
  const worded = bankHoldsMoneyIn(rows)
  if (worded && plain < 0.5 && share(rows.filter((r) => r.a > 0), (r) => saysBank([r])) >= 0.5) return { sign: 'negative-expense', proven: true }
  if (!worded && plain >= 0.5 && !bankColumns && rows.length >= SHORT) return { sign: 'negative-expense', proven: false, doubt: 'mixed' }
  return { sign: 'negative-expense', proven: true, note: 'lean' }
}

const typeCells = (headers: string[], rows: string[][]) => {
  const at = headers.findIndex(isTypeHeader)
  return at >= 0 ? rows.map((r) => (r[at] ?? '').trim()) : []
}

/**
 * What a table says about which way its money runs, through the columns as they
 * stand. A file that says which way each row ran has only a card's or a bank's left
 * to read. `plain` is whether most figures are plain, which is how such a file's
 * charges read if it turns out to be a card.
 */
export function readTableSign({ headers, rows }: Pick<ImportFile, 'headers' | 'rows'>, cols: ImportColumns): SignRead & { plain: boolean } {
  const notes = rows.map((r) => (r[cols.note] ?? '').trim())
  // A balance moves no money and a row with moved cells has no figure to trust: neither says which way money runs.
  const figures = rows.map((r, i) => (isBalanceLine(notes[i]) || isWide(r, cols) ? null : rowFigure(r, cols)))
  const read = readSign(figures, notes, headers, typeCells(headers, rows), cols.sides?.out === 1 && cols.sides.in === -1)
  const plain = read.doubt === 'back' || figures.filter((a) => a && a > 0).length * 2 >= figures.filter(Boolean).length
  const sided = saysWay(cols)
  if (!sided || read.doubt === 'payment' || read.doubt === 'card') return { ...read, plain }
  if (read.sign === 'negative-expense') return { sign: read.sign, proven: true, plain }
  return { sign: 'card-negative', proven: true, note: read.note, plain }
}

const KINDS: Record<string, RowKind> = { Expense: 'expense', Income: 'income', Refund: 'refund' }

function fromCsv(text: string): ImportFile {
  const table = readTable(text)
  if (table.headers.length < 2 && table.rows.length > 0) throw new ImportFileError('Could not find the columns in that file. Choose a CSV, OFX or QFX export.')
  if (table.headers.length < 2 || table.rows.length === 0) throw new ImportFileError('That file has no rows to read. Choose a CSV, OFX or QFX export.')
  const { cols } = table
  // This app's own export says what each row is, and a refund has no sign of its own.
  if (table.headers.join() === EXPORT_HEADERS.join()) {
    const type = EXPORT_HEADERS.indexOf('Type')
    return { format: 'csv', headers: table.headers, rows: table.rows, cols: { ...cols, action: -1 }, sign: 'negative-expense', signProven: true, kinds: table.rows.map((r) => KINDS[r[type]]) }
  }
  const read = readTableSign(table, cols)
  const types = typeCells(table.headers, table.rows)
  const lines = table.rows.map((r) => CARD_PAID.test((r[cols.note] ?? '').trim()) || BARE_PAID.test((r[cols.note] ?? '').trim()))
  const paid = lines.map((line, i) => line || PAID_TYPE.test(types[i] ?? ''))
  return { format: 'csv', headers: table.headers, rows: table.rows, cols, sign: read.sign, signProven: read.proven, paid: paid.some(Boolean) ? paid : undefined }
}

/** A file from the picker, read by what is in it and not by its name. */
export async function readImportFile(file: Blob): Promise<ImportFile> {
  if (file.size > MAX_BYTES) throw new ImportFileError('That file is too large to read here.')
  const text = decodeText(await file.arrayBuffer())
  return isOfx(text) ? fromOfx(text) : fromCsv(text)
}
