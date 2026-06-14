export interface ParsedCsv {
  headers: string[]
  rows: string[][]
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
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
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const headers = (rows.shift() ?? []).map((h) => h.trim())
  const body = rows.filter((r) => r.some((c) => c.trim() !== ''))
  return { headers, rows: body }
}

export type ColumnRole = 'date' | 'amount' | 'description' | 'ignore'

/** Best-effort guess of which column is which, from header names. */
export function guessColumns(headers: string[]): ColumnRole[] {
  return headers.map((h) => {
    const k = h.toLowerCase()
    if (/(^|\b)(date|posted|posting)\b/.test(k)) return 'date'
    if (/(amount|debit|credit|value|total)/.test(k)) return 'amount'
    if (/(desc|memo|name|payee|merchant|details|transaction)/.test(k)) return 'description'
    return 'ignore'
  })
}

/** Parse a money cell like "$1,234.56", "(45.00)", or "-12.34" into a number. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const negative = /^\(.*\)$/.test(s) || s.includes('-')
  const cleaned = s.replace(/[(),$\s]/g, '').replace(/-/g, '')
  const n = Number(cleaned)
  if (Number.isNaN(n)) return null
  return negative ? -n : n
}

/** Normalize common date formats to YYYY-MM-DD. Returns null if unparseable. */
export function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  // Already ISO
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // MM/DD/YYYY or M/D/YY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (us) {
    const yy = us[3].length === 2 ? `20${us[3]}` : us[3]
    return `${yy}-${pad(us[1])}-${pad(us[2])}`
  }
  const t = Date.parse(s)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  return null
}

function pad(n: string | number): string {
  return String(n).padStart(2, '0')
}
