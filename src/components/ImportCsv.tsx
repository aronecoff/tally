import { useMemo, useState, type ChangeEvent } from 'react'
import { db, type Category, type Transaction } from '../db/db'
import { parseCsv, guessColumns, parseAmount, parseDate, type ColumnRole } from '../lib/csv'
import { guessCategoryName } from '../lib/categorize'
import { money } from '../lib/format'

interface Props {
  categories: Category[]
  onDone: () => void
}

type SignMode = 'negative-expense' | 'all-expense'

interface Staged {
  date: string
  amount: number
  type: 'expense' | 'income'
  note: string
  categoryId: number | null
  categoryName: string | null
}

export function ImportCsv({ categories, onDone }: Props) {
  const [raw, setRaw] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [roles, setRoles] = useState<ColumnRole[]>([])
  const [signMode, setSignMode] = useState<SignMode>('negative-expense')
  const [imported, setImported] = useState<number | null>(null)
  const [skipped, setSkipped] = useState(0)

  const catByName = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of categories) if (c.id != null) m.set(c.name.toLowerCase(), c.id)
    return m
  }, [categories])

  function ingest(text: string) {
    setRaw(text)
    setImported(null)
    if (!text.trim()) {
      setHeaders([])
      setRows([])
      setRoles([])
      return
    }
    const parsed = parseCsv(text)
    setHeaders(parsed.headers)
    setRows(parsed.rows)
    setRoles(guessColumns(parsed.headers))
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    ingest(await file.text())
  }

  const dateIdx = roles.indexOf('date')
  const amountIdx = roles.indexOf('amount')
  const descIdx = roles.indexOf('description')

  const staged = useMemo<Staged[]>(() => {
    if (dateIdx < 0 || amountIdx < 0) return []
    const out: Staged[] = []
    for (const r of rows) {
      const date = parseDate(r[dateIdx] ?? '')
      const amt = parseAmount(r[amountIdx] ?? '')
      if (!date || amt == null || amt === 0) continue
      const note = descIdx >= 0 ? (r[descIdx] ?? '').trim() : ''
      const type: 'expense' | 'income' =
        signMode === 'all-expense' ? 'expense' : amt < 0 ? 'expense' : 'income'
      const guessName = guessCategoryName(note)
      const categoryId = guessName ? catByName.get(guessName.toLowerCase()) ?? null : null
      out.push({
        date,
        amount: Math.abs(amt),
        type,
        note,
        categoryId,
        categoryName: categoryId != null ? guessName : null,
      })
    }
    return out
  }, [rows, dateIdx, amountIdx, descIdx, signMode, catByName])

  async function doImport() {
    if (staged.length === 0) return
    const now = Date.now()

    // Idempotent import: skip rows that already exist (same date + amount + type + note),
    // and de-dupe within this file too. Lets you safely re-import overlapping statements.
    const existing = await db.transactions.toArray()
    const key = (t: { date: string; amount: number; type: string; note: string }) =>
      `${t.date}|${t.amount}|${t.type}|${t.note.trim().toLowerCase()}`
    const seen = new Set(existing.map(key))

    const fresh = staged.filter((s) => {
      const k = key(s)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    if (fresh.length > 0) {
      const records: Transaction[] = fresh.map((s) => ({
        date: s.date,
        amount: s.amount,
        type: s.type,
        categoryId: s.categoryId,
        account: '',
        note: s.note,
        createdAt: now,
        updatedAt: now,
      }))
      await db.transactions.bulkAdd(records)
    }
    setSkipped(staged.length - fresh.length)
    setImported(fresh.length)
  }

  function setRole(i: number, role: ColumnRole) {
    setRoles((prev) => {
      const next = [...prev]
      // A role (except 'ignore') belongs to one column only.
      if (role !== 'ignore') {
        for (let j = 0; j < next.length; j++) if (next[j] === role) next[j] = 'ignore'
      }
      next[i] = role
      return next
    })
  }

  if (imported != null) {
    return (
      <div className="import">
        <div className="import-done">
          <div className="big-check">✓</div>
          <h3>Imported {imported} transaction{imported === 1 ? '' : 's'}</h3>
          <p className="muted">
            {skipped > 0 && <>Skipped {skipped} duplicate{skipped === 1 ? '' : 's'} already on file. </>}
            Review categories in the Activity tab — uncategorized rows are easy to tap and fix.
          </p>
          <div className="sheet-actions">
            <button className="btn-ghost" onClick={() => ingest('')}>Import another</button>
            <button className="btn-primary" onClick={onDone}>Done</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="import">
      <p className="muted import-intro">
        Drop in a CSV export from your bank or card. Pick which columns are the date, amount, and
        description — we’ll auto-categorize what we recognize.
      </p>

      <div className="import-inputs">
        <label className="file-btn">
          Choose CSV file
          <input type="file" accept=".csv,text/csv" onChange={onFile} hidden />
        </label>
        <span className="muted">or paste below</span>
      </div>

      <textarea
        className="csv-paste"
        placeholder="Date,Description,Amount&#10;2026-06-03,Trader Joe's,-54.20&#10;2026-06-01,Payroll,3200.00"
        value={raw}
        onChange={(e) => ingest(e.target.value)}
        rows={4}
      />

      {headers.length > 0 && (
        <>
          <h3 className="section-title">Map columns</h3>
          <div className="col-map">
            {headers.map((h, i) => (
              <div key={i} className="col-map-row">
                <span className="col-name">{h || `Column ${i + 1}`}</span>
                <select value={roles[i]} onChange={(e) => setRole(i, e.target.value as ColumnRole)}>
                  <option value="ignore">Ignore</option>
                  <option value="date">Date</option>
                  <option value="amount">Amount</option>
                  <option value="description">Description</option>
                </select>
              </div>
            ))}
          </div>

          <div className="seg sign-seg">
            <button className={signMode === 'negative-expense' ? 'seg-on' : ''} onClick={() => setSignMode('negative-expense')}>
              Negatives are spending
            </button>
            <button className={signMode === 'all-expense' ? 'seg-on' : ''} onClick={() => setSignMode('all-expense')}>
              Everything is spending
            </button>
          </div>

          {dateIdx < 0 || amountIdx < 0 ? (
            <p className="empty">Pick a <strong>Date</strong> and an <strong>Amount</strong> column to preview.</p>
          ) : (
            <>
              <h3 className="section-title">Preview · {staged.length} row{staged.length === 1 ? '' : 's'}</h3>
              <ul className="preview-list">
                {staged.slice(0, 8).map((s, i) => (
                  <li key={i} className="preview-row">
                    <span className="muted">{s.date}</span>
                    <span className="preview-note">{s.note || '—'}</span>
                    <span className="muted">{s.categoryName ?? 'uncategorized'}</span>
                    <span className={`num ${s.type === 'income' ? 'pos' : 'over'}`}>
                      {s.type === 'income' ? '+' : '−'}{money(s.amount)}
                    </span>
                  </li>
                ))}
                {staged.length > 8 && <li className="muted preview-more">+{staged.length - 8} more…</li>}
              </ul>
              <div className="sheet-actions">
                <button className="btn-primary" disabled={staged.length === 0} onClick={doImport}>
                  Import {staged.length} transaction{staged.length === 1 ? '' : 's'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
