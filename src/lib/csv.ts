import type { ImportColumns } from './csvImport'

export interface ParsedCsv {
  headers: string[]
  rows: string[][]
}

/** The cells of a line of text, for a look at what it holds. */
const cellsOf = (line: string, delimiter: string) => line.split(delimiter).map((c) => c.trim())

/**
 * Whether a quoted cell has rows of the file inside it: it runs over a line, a later
 * line has a day in a cell of its own, and a figure sits somewhere in it. An address
 * over two lines has none of that.
 */
function holdsRows(cell: string, delimiter: string): boolean {
  const [first, ...rest] = cell.split(/\r\n|\r|\n/).map((line) => cellsOf(line, delimiter))
  const dated = rest.some((cells) => cells.length > 1 && cells.some((c) => parseDate(c) != null))
  return dated && [first, ...rest].some((cells) => cells.some((c) => parseAmount(c) != null))
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, CRLF. A
 * quote opens a field only at its start: anywhere else it is the cell's own, as in
 * PIPE 5" FITTING, and opening there would swallow every row after it. So would one
 * that never closes, or one that closes on a later row's quote with rows caught
 * inside, so those are read again as nothing.
 */
function csvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let opened = 0

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else if (holdsRows(field, delimiter)) {
          inQuotes = false
          field = ''
          i = opened
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"' && field.trim() === '') {
      inQuotes = true
      opened = i
    } else if (c === delimiter) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (inQuotes) return csvRows(text.slice(0, opened) + text.slice(opened + 1), delimiter)
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const filled = (r: string[]) => r.some((c) => c.trim() !== '')

/** A table's columns, by number. The widest row says how many. */
const columnsOf = (rows: string[][]) => Array.from({ length: rows.reduce((most, r) => Math.max(most, r.length), 0) }, (_, i) => i)

/** The first row names the columns. */
export function parseCsv(text: string): ParsedCsv {
  const rows = csvRows(text)
  const headers = (rows.shift() ?? []).map((h) => h.trim())
  return { headers, rows: rows.filter(filled) }
}

/** The columns of this app's own export (exportCsv.ts). */
export const EXPORT_HEADERS = ['Date', 'Description', 'Amount', 'Type', 'Category', 'Account', 'Status']

export type ColumnRole = 'date' | 'amount' | 'description' | 'ignore'

/** A header's words, however it writes them: AmountOut, amount_out and Amount (Out) read alike. */
const headerWords = (h: string) =>
  h.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

/** Words beside a name that make it a label, a code or a person, and not what a row is for. */
const NOT_WORDS = /id$|\bno\b|\bnum\b|\bref|#|type|number|code|status|categor|account|member|holder|customer|card/i

const DATE_WORD = /\b(date|datetime|posted|posting)\b/
/** A date word beside these is not a day: Posted Amount is money, and Year to Date is a running count. */
const NOT_DATE = /amount|\bamt\b|balance|\bbal\b|\bfees?\b|year to date|\bytd\b/
const MONEY_WORD = /amount|\bamt\b|debit|credit|value|\btotal\b|withdraw|deposit|\bmoney (out|in)\b|\bpaid (out|in)\b|\b(out|in)flows?\b|\bcharges?\b|^spent$|^received$|\bnet\b|\bgross\b/

/** Best-effort guess of which column is which, from header names. */
export function guessColumns(headers: string[]): ColumnRole[] {
  return headers.map((h) => {
    const k = headerWords(h)
    if (DATE_WORD.test(k) && !NOT_DATE.test(k)) return 'date'
    if (MONEY_WORD.test(k)) return 'amount'
    if (/(desc|memo|name|payee|merchant|details|transaction|\bnotes?\b)/.test(k) && !NOT_WORDS.test(k)) return 'description'
    return 'ignore'
  })
}

/**
 * Which column says what a row was, best first. Banks use the lower words for other
 * things: Chase's Details and US Bank's Transaction only say DEBIT or CREDIT, and a
 * row's words decide whether it is a payment or spending.
 */
const NOTE_RANK = [/desc/i, /payee|merchant/i, /name/i, /memo/i, /detail/i, /transaction/i, /\bnotes?\b/i]

const CURRENCY = 'usd|eur|gbp|cad|aud|nzd|chf|jpy|sek|nok|dkk|mxn|inr|sgd|hkd|zar|brl|dollars?|euros?|pounds?|[$£€¥]'

/** A header that can only be a row's own signed figure. These, and an Amount naming both ways, beat a pair. */
const PLAIN_AMOUNT = new RegExp(`^(?:(?:transaction|trans\\.?|txn) )?(?:amount|amt)(?: (?:in )?(?:${CURRENCY}))?$|^(?:${CURRENCY}) (?:amount|amt)$`)

/** "Amount in" before a currency names the currency, not a direction, unless an "Amount out" mirrors it. */
const MONEY_OUT = /debit|withdraw|money out|paid out|\bamount out\b|\bout amount\b|\bamount paid\b|\boutflows?\b|\bcharges?\b|^spent$/
const MONEY_IN = new RegExp(`credit|deposit|money in|paid in|\\bamount in\\b(?! (?:${CURRENCY}))|\\bin amount\\b|\\bamount received\\b|\\binflows?\\b|^received$`)
/**
 * Words that make a column something other than this row's money: what is left,
 * what is allowed, or a part of the row. A backstop: a header has to name a row's
 * money to win, so a word missing here costs a pair nothing.
 */
const NOT_MONEY =
  /card|limit|score|\bno\b|number|balance|\bbal\b|running|cumulative|available|\bclosing\b|\bending\b|\bopening\b|\bledger\b|outstanding|remaining|previous|\bprior\b|\bafter\b|\bbefore\b|\bfees?\b|\btax|shipping|handling|insurance|discount|\btips?\b|\boption\b|\btype\b|\bcode\b|\bstatus\b|categor|\bdesc/

/** Which way a plain figure runs, in a file that says. */
export type Way = 'out' | 'in'

/** A column of what each row was, in a file's own words. */
export const isTypeHeader = (h: string): boolean => /^(?:transaction )?type$/.test(headerWords(h))

/** Whether a table's money is in two columns. A column named as both is neither. */
export const isSplit = (cols: ImportColumns): boolean => cols.inflow != null && cols.inflow >= 0 && cols.inflow !== cols.amount

const hasDirection = (cols: ImportColumns) => cols.direction != null && cols.direction >= 0

/** Whether a row's own cells say which way its money ran, so the sign of a figure has nothing left to say. */
export const saysWay = (cols: ImportColumns): boolean => isSplit(cols) || hasDirection(cols) || !!cols.way

/**
 * The columns of a named table. A file with one column for money out and one for
 * money in has both picked, because either alone would lose half its rows. "Amount"
 * alone means a signed figure, and it wins over a pair beside it. Any other Amount
 * gives way to a pair, because a pair says what each row did and "Bal Amount" could
 * be anything. "Amount Debit" and "Debit Amount" say a direction, so they are that
 * pair. "Payment" means what the column beside it makes it: money out beside a
 * Deposit, and money in beside a Charge. A statement's day is the same on every row, so
 * a row's own day goes first, and a column of words with nothing in it says nothing. A
 * brokerage's Type only says how an order settled, so its Action is what a row was.
 */
function columnsFrom(headers: string[], rows: string[][] = []): ImportColumns {
  const roles = guessColumns(headers)
  const names = headers.map(headerWords)
  const money = names.flatMap((h, i) => (roles[i] === 'amount' && !NOT_MONEY.test(h) ? [i] : []))
  const says = (way: RegExp, other: RegExp) => money.find((i) => way.test(names[i]) && !other.test(names[i]))
  const payment = names.findIndex((h) => /^payments?( amount)?$/.test(h))
  const said = says(MONEY_OUT, MONEY_IN)
  const mirrored = said === undefined ? '' : names[said].replace(/\bout\b/, 'in')
  const mirror = said === undefined || mirrored === names[said] ? undefined : money.find((i) => names[i] === mirrored)
  const saidIn = says(MONEY_IN, MONEY_OUT) ?? mirror
  const out = said ?? (saidIn !== undefined && payment >= 0 ? payment : undefined)
  const moneyIn = saidIn ?? (said !== undefined && /\bcharges?\b/.test(names[said]) && payment >= 0 ? payment : undefined)
  const candidates = money.filter((i) => i !== mirror)
  const isAmount = (i: number) => /\bamount\b|\bamt\b/.test(names[i])
  const named = candidates.find((i) => isAmount(i) && MONEY_OUT.test(names[i]) === MONEY_IN.test(names[i]))
  const plain = candidates.find((i) => PLAIN_AMOUNT.test(names[i]) || (isAmount(i) && MONEY_OUT.test(names[i]) && MONEY_IN.test(names[i])))
  const split = plain === undefined && out !== undefined && moneyIn !== undefined
  const word = (test: RegExp) => money.find((i) => test.test(names[i]))
  const figure = money.find((i) => !/\b(net|gross)\b/.test(names[i]))
  const words = (test: RegExp, skip = -1) => headers.findIndex((h, i) => i !== skip && roles[i] === 'description' && test.test(h))
  const ranked = NOTE_RANK.flatMap((test) => headers.flatMap((h, i) => (roles[i] === 'description' && test.test(h) ? [i] : [])))
  const note = ranked.find((i) => rows.some((r) => (r[i] ?? '').trim() !== '')) ?? ranked[0] ?? -1
  const rowDay = roles.findIndex((role, i) => role === 'date' && !/\bstatement\b/.test(names[i]))
  return {
    date: rowDay >= 0 ? rowDay : roles.indexOf('date'),
    amount: split ? out : (named ?? out ?? moneyIn ?? figure ?? word(/\bnet\b/) ?? word(/\bgross\b/) ?? -1),
    note,
    inflow: split ? moneyIn : -1,
    memo: words(/memo/i, note),
    action: names.includes('action') ? names.indexOf('action') : headers.findIndex(isTypeHeader),
  }
}

/** Reads a table with no header row from what its cells hold. */
function columnsFromCells(rows: string[][]): ImportColumns {
  const sample = rows.slice(0, 50)
  const share = (at: number, test: (cell: string) => boolean) => sample.filter((r) => test((r[at] ?? '').trim())).length / sample.length
  const columns = columnsOf(rows)
  const date = columns.find((i) => share(i, (c) => parseDate(c) != null) > 0.5) ?? -1
  const figure = (c: string) => parseAmount(c) != null && c.includes('.')
  // Two columns of figures may be money out and money in, or money and a balance. Only a person can say.
  const figures = columns.filter((i) => i !== date && rows.some((r) => figure((r[i] ?? '').trim())))
  const amount = figures.length === 1 && share(figures[0], figure) > 0.5 ? figures[0] : -1
  const words = (i: number) => sample.reduce((n, r) => n + (/[a-z]{3}/i.test(r[i] ?? '') ? (r[i] ?? '').length : 0), 0)
  const note = columns.filter((i) => i !== date && i !== amount).sort((a, b) => words(b) - words(a))[0]
  return { date, amount, note: note != null && words(note) > 0 ? note : -1, inflow: -1 }
}

/** How far down a file its table may start: banks put a summary above it. */
const HEADER_SEARCH = 20

const rowOfData = (r: string[]) => r.some((c) => parseDate(c) != null)

/**
 * How a mark runs through a file's lines: how many of them share one count of it, and
 * that count. The lines of a table agree on it. The words of one row can hold any
 * number, and a summary above the table holds none.
 */
function shared(lines: string[], mark: string): { lines: number; count: number } {
  const lineCounts = new Map<number, number>()
  for (const line of lines) {
    const count = line.split(mark).length - 1
    if (count > 0) lineCounts.set(count, (lineCounts.get(count) ?? 0) + 1)
  }
  const [count, most] = [...lineCounts].reduce((best, next) => (next[1] > best[1] || (next[1] === best[1] && next[0] > best[0]) ? next : best), [0, 0])
  return { lines: most, count }
}

/**
 * What a file puts between its cells. Some banks write semicolons or tabs, which read
 * by commas are one long column. The mark most lines agree on wins, then the one they
 * hold most of. A comma wins a tie: the amounts of a semicolon file can hold commas,
 * and the words of a comma file can hold anything.
 */
function delimiterOf(text: string): string {
  const lines = text.slice(0, 16384).split(/\r\n|\r|\n/).slice(0, HEADER_SEARCH).map((l) => l.replace(/"[^"]*"/g, ''))
  const [comma, semicolon, tab] = [',', ';', '\t'].map((mark) => shared(lines, mark))
  const beats = (a: typeof comma, b: typeof comma) => a.lines > b.lines || (a.lines === b.lines && a.count > b.count)
  if (beats(tab, comma) && !beats(semicolon, tab)) return '\t'
  return beats(semicolon, comma) ? ';' : ','
}

/** The words a column can use to say which way a row ran. */
const DIRECTION: Record<string, Way> = {
  debit: 'out', dbit: 'out', dr: 'out', d: 'out', withdrawal: 'out', outflow: 'out', out: 'out',
  credit: 'in', crdt: 'in', cr: 'in', c: 'in', deposit: 'in', inflow: 'in', in: 'in',
}

const OUT_MARK = 'debit|dbit|dbt|dr|d'
const IN_MARK = 'credit|crdt|cdt|cr|c'

/**
 * A header that names which way a row ran. Those words mean something else under any
 * other name: a Status of Credit is an account in good standing, a State of IN is a
 * place, and a Category of Deposit is what a row was for.
 */
const NAMES_DIRECTION = new RegExp(
  '^(?:(?:transaction|trans\\.?|tran|txn|entry|posting|amount) )?(?:type|kind|way|direction|indicator)$' +
    `|^(?:(?:${OUT_MARK})\\W*(?:or\\W+)?(?:${IN_MARK})|(?:${IN_MARK})\\W*(?:or\\W+)?(?:${OUT_MARK}))(?: ind(?:icator)?| flag| code)?$` +
    '|^(?:in(?:flow)?\\W*(?:or\\W+)?out(?:flow)?|out(?:flow)?\\W*(?:or\\W+)?in(?:flow)?)$',
)

/** Whether a header names which way a row ran, whatever its cells hold. */
const namesDirection = (h: string): boolean => NAMES_DIRECTION.test(headerWords(h))

const wayOf = (cell: string): Way | undefined => DIRECTION[cell.toLowerCase()]

/** A figure marked as money in, with a plus or a CR. */
export const isMarked = (cell: string): boolean => /^\+|cr\.?$/i.test(cell)

const isCredit = (cell: string) => /cr\.?$/i.test(cell)

const isMinus = (cell: string) => (parseAmount(cell) ?? 0) < 0

const figuresOf = (rows: string[][], at: number) => rows.map((r) => (r[at] ?? '').trim()).filter((c) => !!parseAmount(c))

/**
 * Whether a file's one column of money has no minus in it, so something else has to
 * say which way its figures ran. A plus or a CR on some of them does not say it of the rest.
 */
export function isAllPlain(cols: ImportColumns, rows: string[][]): boolean {
  if (cols.amount < 0 || isSplit(cols)) return false
  const figures = figuresOf(rows, cols.amount)
  return figures.length > 0 && !figures.some(isMinus)
}

/**
 * The figures a column marks as money in, where a mark says anything. A file of plain
 * figures can mark its credits with a CR or a plus. Beside a minus the figures carry
 * their own signs, and a plus on every row is only how the file writes a figure.
 */
function markedFigures(figures: string[]): string[] {
  const marked = figures.filter(isMarked)
  return figures.some(isMinus) || (marked.length === figures.length && !marked.some(isCredit)) ? [] : marked
}

/** How many of a column's figures it marks as money in, and how many it leaves plain, or null where a mark says nothing. */
export function marksOf(cols: ImportColumns, rows: string[][]): { marked: number; rest: number } | null {
  if (cols.amount < 0 || isSplit(cols) || hasDirection(cols)) return null
  const figures = figuresOf(rows, cols.amount)
  const marked = markedFigures(figures).length
  return marked > 0 ? { marked, rest: figures.length - marked } : null
}

/** How much of a file has to be marked before the marks say what the rest are. */
const MARKED_SHARE = 0.2

/** Whether marks are what this file does, and not chance: one mark would turn every other figure around. */
function marksCredits(figures: string[]): boolean {
  const marked = markedFigures(figures).length
  return marked >= 2 && marked >= figures.length * MARKED_SHARE
}

/**
 * A column most of whose filled cells say which way a row ran. A plain Type of C and D
 * can as well be Check and Deposit, so those two letters count only under a header that
 * names them. One word all the way down is a file with one way in it.
 */
function saysDirection(cells: string[], header: string): boolean {
  const said = cells.filter(Boolean)
  const words = said.filter(wayOf)
  const letters = /(?:type|kind)$/.test(header) && words.every((c) => c.length === 1)
  return said.length * 2 >= cells.length && words.length >= said.length * 0.8 && words.length > 0 && !letters
}

/** The column named for which way each row ran, with cells that say it. */
function wayColumn(headers: string[], rows: string[][]): number {
  const says = (i: number) => namesDirection(headers[i] ?? '') && saysDirection(rows.map((r) => (r[i] ?? '').trim()), headerWords(headers[i]))
  return columnsOf(rows).find(says) ?? -1
}

/**
 * The column that says which way each row ran, for a file whose figures are all
 * plain. Mint and Navy Federal write it so. Figures with their own signs say it
 * already, and a word beside them is only a label.
 */
const readDirection = (cols: ImportColumns, headers: string[], rows: string[][]): number => (isAllPlain(cols, rows) ? wayColumn(headers, rows) : -1)

/** Whether a column's words say other than a figure's sign, so a stray minus has only made plain figures look signed. */
export function waysClash(cols: ImportColumns, headers: string[], rows: string[][]): boolean {
  const at = wayColumn(headers, rows)
  return at >= 0 && rows.some((r) => {
    const [figure, way] = [parseAmount((r[cols.amount] ?? '').trim()), wayOf((r[at] ?? '').trim())]
    return !!figure && !!way && figure > 0 !== (way === 'in')
  })
}

/**
 * Which way the figures of the money column run, where the file says. A lone Debit
 * means money out and a lone Credit money in, as long as its figures all run one
 * way: a column with both signs is a signed column whatever it is called. A
 * statement that marks only its credits, with a CR or a plus, leaves its charges
 * plain, and says so by marking a fair share of its figures.
 */
export function readWay(cols: ImportColumns, headers: string[], rows: string[][]): Way | undefined {
  if (cols.amount < 0 || isSplit(cols) || hasDirection(cols)) return undefined
  const figures = figuresOf(rows, cols.amount)
  const minus = figures.filter(isMinus).length
  if (figures.length === 0 || (minus > 0 && minus < figures.length)) return undefined
  const name = headerWords(headers[cols.amount] ?? '')
  const [out, into] = [MONEY_OUT.test(name), MONEY_IN.test(name)]
  if (out !== into) return out ? 'out' : 'in'
  return !cols.noMarks && marksCredits(figures) ? 'out' : undefined
}

/** The sign a column of a pair writes its own side's money with. Most of its cells say. */
function ownSign(rows: string[][], at: number): 1 | -1 {
  const figures = figuresOf(rows, at)
  return figures.filter(isMinus).length * 2 > figures.length ? -1 : 1
}

/** What a table's cells say beside the columns as they stand, a person's picks included. */
export function rereadCells(cols: ImportColumns, headers: string[], rows: string[][]): ImportColumns {
  return {
    ...cols,
    way: readWay(cols, headers, rows),
    marked: !cols.noMarks && marksOf(cols, rows) != null,
    sides: isSplit(cols) ? { out: ownSign(rows, cols.amount), in: ownSign(rows, cols.inflow!) } : undefined,
  }
}

/** Whether a row has cells past its columns, which a file with a comma in a row's words does. */
const overflows = (r: string[], width: number) => r.slice(width).some((c) => c.trim() !== '')

const mostRunPast = (rows: string[][], width: number) => rows.filter((r) => overflows(r, width)).length * 2 > rows.length

/** What the cells add to what the headers say. When most rows run past the header, the header is the short one. */
function readCells(cols: ImportColumns, headers: string[], rows: string[][]): ImportColumns {
  const width = mostRunPast(rows, headers.length) ? undefined : headers.length
  return rereadCells({ ...cols, direction: readDirection(cols, headers, rows), width }, headers, rows)
}

/** The two halves of a figure whose thousands comma nothing quoted: -1 then 650.00. */
const FIGURE_HEAD = /^[-+(]?[$£€]?-?\d{1,3}(?:,\d{3})*$/
const FIGURE_TAIL = /^\d{3}(?:\.\d*)?[)-]?$/

/** How many cells of a row have anything in them, or come before one that has. */
const reach = (r: string[]) => r.findLastIndex((c) => c.trim() !== '') + 1

/** The count that comes up most. */
function usual(counts: number[]): number {
  const seen = new Map<number, number>()
  for (const n of counts) seen.set(n, (seen.get(n) ?? 0) + 1)
  return [...seen].reduce((best, next) => (next[1] > best[1] ? next : best), [0, 0])[0]
}

/**
 * Rows with a figure a comma split back in one cell, wherever a row has cells to spare:
 * past `width`, or more of them than the rows around it where those end in empty ones.
 */
function joinFigures(rows: string[][], width: number): string[][] {
  const most = Math.max(width, usual(rows.map((r) => r.length)))
  const spare = (r: string[]) => reach(r) > width || r.length > most
  return rows.map((r) => {
    const row = [...r]
    for (let i = 0; i + 1 < row.length && spare(row); ) {
      const [head, tail] = [row[i].trim(), row[i + 1].trim()]
      if (FIGURE_HEAD.test(head) && FIGURE_TAIL.test(tail)) row.splice(i, 2, `${head},${tail}`)
      else i++
    }
    return row
  })
}

/**
 * A comma file's rows under a header. A figure with an unquoted comma runs past the
 * header and moves every cell after it, so it is read as the one figure it is. Where
 * that leaves most rows past the header all the same, the header is the short one, and
 * only a row past the others can have a figure split.
 */
function wholeFigures(rows: string[][], width: number): string[][] {
  const joined = joinFigures(rows, width)
  return mostRunPast(joined, width) ? joinFigures(rows, usual(rows.map(reach))) : joined
}

/** A row whose cells have moved, so its figures cannot be trusted to be in their columns. */
export const isWide = (r: string[], cols: ImportColumns): boolean => cols.width != null && overflows(r, cols.width)

/** How many rows below a header read as a day and money under it. */
function rowsUnder(rows: string[][], at: number): number {
  const cols = columnsFrom(rows[at].map((h) => h.trim()))
  return rows.slice(at + 1).filter((r) => parseDate(r[cols.date] ?? '') != null && rowFigure(r, cols) != null).length
}

/**
 * A bank's export as a table. Some put a summary above the rows, and a summary's
 * own line can name a date and an amount too, so the header is the row that names
 * them with the most rows reading under it, the first of them on a tie. Some have no
 * header at all, and their first row is a transaction that must not be lost.
 */
export function readTable(text: string): ParsedCsv & { cols: ImportColumns } {
  const delimiter = delimiterOf(text)
  const rows = csvRows(text, delimiter).filter(filled)
  const under = (headers: string[], cells: string[][]) => {
    const body = delimiter === ',' ? wholeFigures(cells, headers.length) : cells
    return { headers, rows: body, cols: readCells(columnsFrom(headers, body), headers, body) }
  }
  const named = rows.slice(0, HEADER_SEARCH).flatMap((r, i) => {
    const roles = guessColumns(r.map((c) => c.trim()))
    return !rowOfData(r) && roles.includes('date') && roles.includes('amount') ? [i] : []
  })
  const at = named.length > 0 ? named.reduce((best, i) => (rowsUnder(rows, i) > rowsUnder(rows, best) ? i : best)) : -1
  if (at >= 0) return under(rows[at].map((h) => h.trim()), rows.slice(at + 1))
  if (rows.length > 0 && rowOfData(rows[0])) {
    const body = delimiter === ',' ? joinFigures(rows, usual(rows.map(reach))) : rows
    const headers = columnsOf(body).map((i) => `Column ${i + 1}`)
    return { headers, rows: body, cols: readCells(columnsFromCells(body), headers, body) }
  }
  return under((rows[0] ?? []).map((h) => h.trim()), rows.slice(1))
}

/**
 * Parse a money cell like "$1,234.56", "(45.00)", "-12.34" or "12.34 DR" into a
 * number. A comma only ever groups thousands: "12,50" could be 12.50 or 1,250, and
 * a figure read a hundred times too big is worse than a row left out.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/−/g, '-')
  if (!s) return null
  const mark = s.match(/\s*(cr|dr)\.?$/i)
  const figure = mark ? s.slice(0, mark.index) : s
  const negative = /^\(.*\)$/.test(figure) || /^[$£€]?\s*-|-$/.test(figure)
  const cleaned = figure.replace(/[()$£€\s]/g, '').replace(/^-|-$/g, '')
  if (!/^\+?(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?$/.test(cleaned) || !/\d/.test(cleaned)) return null
  const n = Number(cleaned.replace(/,/g, ''))
  if (mark) return mark[1].toLowerCase() === 'dr' ? -n : n
  return negative ? -n : n
}

/** A cell of a pair with nothing in it: some files fill those with a dash. */
const isEmpty = (cell: string) => !cell || /^[-–—]$/.test(cell)

/**
 * The two cells of a file that splits money out and money in. A cell against its
 * column's sign undoes a row of that side, and a row filled on both sides is what
 * they come to. With no column's sign to go by, a cell only says its side.
 */
function readPair(out: string, into: string, sides: ImportColumns['sides']): number | null {
  const [spent, got] = [isEmpty(out) ? 0 : parseAmount(out), isEmpty(into) ? 0 : parseAmount(into)]
  if (spent == null || got == null || (isEmpty(out) && isEmpty(into))) return null
  return (sides ? got * sides.in : Math.abs(got)) - (sides ? spent * sides.out : Math.abs(spent))
}

/** A row's money, negative when it went out, or null when its cells do not say. */
export function rowFigure(r: string[], cols: ImportColumns): number | null {
  const cell = (at: number | undefined) => (at != null && at >= 0 ? (r[at] ?? '').trim() : '')
  const figure = cell(cols.amount)
  if (isSplit(cols)) return readPair(figure, cell(cols.inflow), cols.sides)
  const n = parseAmount(figure)
  if (n == null) return null
  const way = hasDirection(cols) ? wayOf(cell(cols.direction)) : cols.marked && isMarked(figure) ? undefined : cols.way
  if (hasDirection(cols) && !way) return null
  return !way ? n : way === 'out' ? -Math.abs(n) : Math.abs(n)
}

/** Whether a row's money-out cell runs against its column: that spending coming back. */
export const undoesSpending = (r: string[], cols: ImportColumns): boolean =>
  isSplit(cols) && (parseAmount((r[cols.amount] ?? '').trim()) ?? 0) * (cols.sides?.out ?? 0) < 0

/** A row that only states a balance, and moves no money: OPENING BALANCE, Ending balance as of 11/30/2026, Balance Forward. */
const BALANCE_LINE = /^(?:(?:opening|beginning|starting|closing|ending)\s+balance(?:\s+as\s+of\b.*)?|balance\s+(?:brought\s+|carried\s+)?forward)[\W\d]*$/i

/** A row that only adds up the rows above it: TOTAL, Subtotal, GRAND TOTAL, TOTAL CREDITS. A number after it can be a shop's. */
const TOTAL_LINE = /^(?:grand\s+|sub[\s-]*)?totals?(?:\s+(?:credits|debits|deposits|withdrawals|purchases|payments))?\W*$/i

export const isBalanceLine = (note: string): boolean => BALANCE_LINE.test(note) || TOTAL_LINE.test(note)

/** PayPal's Type for money moving between it and a person's own bank or card, which is neither spending nor income. */
const OWN_MONEY = /^(?:bank deposit to pp account|general (?:credit )?card deposit|(?:general|user initiated) withdrawal)\b/i

export const isOwnMoney = (action: string): boolean => OWN_MONEY.test(action)

/** PayPal's Type for a shop giving money back, on a file that reads as a bank's, where nothing else would say so. */
export const saysRefund = (action: string): boolean => /^payment refund$/i.test(action)

/** Which number comes first in a date like 03/11/2026. */
export type DateOrder = 'month-first' | 'day-first'

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

// 2026-11-03 and 2026/11/03, with or without a time after them.
const YEAR_FIRST = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/
// 11/03/2026, 11-03-26 and 11.03.2026, with or without a time after them.
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/
// Nov 3, 2026 and November 3rd 2026.
const NAME_FIRST = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})(?!\d)/i
// 3 Nov 2026 and 03-Nov-26.
const NAME_SECOND = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{4}|\d{2})(?!\d)/i

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))

/** A month's number from its name or a short form of it, or 0. */
const monthNumber = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase())) + 1

/** YYYY-MM-DD for a day that exists on the calendar, and null for 2026-13-10 or Feb 30. */
function calendarDay(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100) return null
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/**
 * Normalize common date formats to YYYY-MM-DD. Returns null if unparseable, so a
 * date the calendar does not have never reaches the ledger. Only written-out
 * formats count: Date.parse guesses differently in each browser, and turns text
 * like "Check 1234" into a date.
 */
export function parseDate(raw: string, order: DateOrder = 'month-first'): string | null {
  const s = raw.trim()
  const yearFirst = s.match(YEAR_FIRST)
  if (yearFirst) return calendarDay(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]))
  const yearLast = s.match(YEAR_LAST)
  if (yearLast) {
    const [first, second] = [Number(yearLast[1]), Number(yearLast[3])]
    const [m, d] = order === 'day-first' ? [second, first] : [first, second]
    return calendarDay(fullYear(yearLast[4]), m, d)
  }
  const nameFirst = s.match(NAME_FIRST)
  if (nameFirst) return calendarDay(fullYear(nameFirst[3]), monthNumber(nameFirst[1]), Number(nameFirst[2]))
  const nameSecond = s.match(NAME_SECOND)
  if (nameSecond) return calendarDay(fullYear(nameSecond[3]), monthNumber(nameSecond[2]), Number(nameSecond[1]))
  return null
}

/**
 * How a file writes its dates, read from the whole column. A number above 12 can
 * only be a day, which settles the order. `proven` is false when nothing settles
 * it (03/11 alone could be either) or the rows disagree, so the person has to say.
 */
export function readDateOrder(cells: string[]): { order: DateOrder; proven: boolean } {
  let dayFirst = 0
  let monthFirst = 0
  let either = 0
  for (const cell of cells) {
    const found = cell.trim().match(YEAR_LAST)
    if (!found) continue
    const [first, second] = [Number(found[1]), Number(found[3])]
    if (first > 12 && first <= 31 && second <= 12) dayFirst++
    else if (second > 12 && second <= 31 && first <= 12) monthFirst++
    else if (first !== second && first <= 12 && second <= 12) either++
  }
  const settled = dayFirst + monthFirst > 0
  return {
    order: dayFirst > monthFirst ? 'day-first' : 'month-first',
    proven: settled ? dayFirst === 0 || monthFirst === 0 : either === 0,
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
