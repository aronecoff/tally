/**
 * OFX and QFX statements, the two forms a bank's "download for Quicken" takes:
 * version 1 is SGML, where a value's closing tag is left out, and version 2 is
 * XML. One walk over the tags reads both, because a closing tag on a value says
 * nothing new. QFX is OFX with a few extra tags, which are skipped.
 */
export interface OfxRow {
  /** The bank's own id for the row (FITID). It stays the same across downloads. */
  id: string
  /** YYYY-MM-DD as the bank wrote it, or the cell as it stands if it is not a date. */
  date: string
  amount: string
  name: string
  memo: string
}

export interface OfxStatement {
  /** A card statement. A bank statement's positives are money in, a card's are refunds and payments. */
  card: boolean
  /** The account's number, whole. It is only for telling statements apart. */
  account: string
  rows: OfxRow[]
}

export interface OfxFile {
  /** The institution's name, when the file gives one. */
  org: string
  statements: OfxStatement[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (s: string) =>
  s
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n: string) => ENTITIES[n.toLowerCase()])

/** YYYYMMDD from the front of an OFX date (20261103120000.000[-8:PST]), as written:
 *  moving it by its time zone would put a late-evening row on the next day. */
function dayOf(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw
}

/** Whether this text is an OFX statement. A CSV cannot start with these. */
export function isOfx(text: string): boolean {
  const head = text.slice(0, 4096)
  return /^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX\b/i.test(head) || /<OFX[\s>]/i.test(head)
}

/** The statements in a file, in order. A file with none gives an empty list. */
export function parseOfx(text: string): OfxFile {
  const start = text.search(/<OFX[\s>]/i)
  const body = start >= 0 ? text.slice(start) : text
  const out: OfxFile = { org: '', statements: [] }

  let statement: OfxStatement | null = null
  let row: Record<string, string> | null = null
  /** The aggregates open just now, so <ORG> under <FI> is told from one elsewhere. */
  const open: string[] = []

  const closeRow = () => {
    if (row && statement) {
      statement.rows.push({
        id: row.FITID ?? '',
        date: dayOf(row.DTPOSTED ?? ''),
        amount: row.TRNAMT ?? '',
        name: row.NAME ?? row.PAYEE ?? '',
        memo: row.MEMO ?? '',
      })
    }
    row = null
  }

  for (const [, slash, rawTag, rawValue] of body.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9.]*)[^>]*>([^<]*)/g)) {
    const tag = rawTag.toUpperCase()
    const value = decode(rawValue).trim()

    if (slash) {
      if (tag === 'STMTTRN') closeRow()
      if (tag === 'STMTRS' || tag === 'CCSTMTRS') {
        closeRow()
        statement = null
      }
      const at = open.lastIndexOf(tag)
      if (at >= 0) open.length = at
      continue
    }

    // A tag with a value is a leaf. An aggregate has none, and is followed by its tags.
    if (value) {
      if (row) row[tag] = value
      else if (tag === 'ACCTID' && statement) statement.account = value
      else if (tag === 'ACCTTYPE' && value.toUpperCase() === 'CREDITLINE' && statement) statement.card = true
      else if (tag === 'ORG' && open.includes('FI')) out.org = value
      continue
    }

    open.push(tag)
    if (tag === 'STMTRS' || tag === 'CCSTMTRS') {
      statement = { card: tag === 'CCSTMTRS', account: '', rows: [] }
      out.statements.push(statement)
    } else if (tag === 'STMTTRN') {
      closeRow() // some files leave out </STMTTRN>
      row = {}
    }
  }
  closeRow()
  return out
}
