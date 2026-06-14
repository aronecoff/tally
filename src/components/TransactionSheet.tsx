import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction, type TxType } from '../db/db'
import { todayISO } from '../lib/dates'
import { guessCategoryName } from '../lib/categorize'
import { money } from '../lib/format'
import { Icon } from './Icon'

interface Props {
  categories: Category[]
  /** null = create new; a Transaction = edit existing. */
  initial: Transaction | null
  onClose: () => void
}

export function TransactionSheet({ categories, initial, onClose }: Props) {
  const editing = initial != null
  const [type, setType] = useState<TxType>(initial?.type ?? 'expense')
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [date, setDate] = useState(initial?.date ?? todayISO())
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId ?? null)
  const [note, setNote] = useState(initial?.note ?? '')
  const [account, setAccount] = useState(initial?.account ?? '')
  const [touchedCategory, setTouchedCategory] = useState(editing)
  const guessedOnce = useRef(editing)

  const visibleCategories = useMemo(
    () => categories.filter((c) => c.kind === type).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories, type],
  )

  // Auto-suggest a category from the note — but only once, and never after the
  // user has picked one, so it never fights their choice.
  useEffect(() => {
    if (touchedCategory || guessedOnce.current) return
    const guess = guessCategoryName(note)
    if (!guess) return
    const match = visibleCategories.find((c) => c.name === guess)
    if (match) {
      setCategoryId(match.id ?? null)
      guessedOnce.current = true
    }
  }, [note, touchedCategory, visibleCategories])

  // Esc closes the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (categoryId == null) return
    if (!visibleCategories.some((c) => c.id === categoryId)) setCategoryId(null)
  }, [visibleCategories, categoryId])

  const amountNum = Number(amount)
  const valid = amount !== '' && !Number.isNaN(amountNum) && amountNum > 0

  // Accountability: how much is already spent in the selected category this month
  // (excluding the row being edited), so we can warn before this entry breaches a limit.
  const monthOfDate = date.slice(0, 7)
  const priorSpend = useLiveQuery(async () => {
    if (type !== 'expense' || categoryId == null) return 0
    const rows = await db.transactions.where('categoryId').equals(categoryId).toArray()
    return rows
      .filter((r) => r.type === 'expense' && r.date.startsWith(monthOfDate) && r.id !== initial?.id)
      .reduce((s, r) => s + r.amount, 0)
  }, [type, categoryId, monthOfDate, initial?.id], 0)

  const selectedCat = categories.find((c) => c.id === categoryId)
  const limit = selectedCat?.kind === 'expense' ? selectedCat.monthlyBudget : 0
  const projected = (priorSpend ?? 0) + (valid ? amountNum : 0)
  const warnOver = limit > 0 && valid && projected > limit
  const warnNear = limit > 0 && valid && !warnOver && projected >= limit * 0.85

  async function save() {
    if (!valid) return
    const now = Date.now()
    const fields = {
      date,
      amount: Math.round(amountNum * 100) / 100,
      type,
      categoryId,
      account: account.trim(),
      note: note.trim(),
      updatedAt: now,
    }
    if (editing && initial?.id != null) {
      await db.transactions.update(initial.id, fields)
    } else {
      await db.transactions.add({ ...fields, createdAt: now } as Transaction)
    }
    onClose()
  }

  async function remove() {
    if (editing && initial?.id != null) {
      if (!window.confirm('Delete this transaction?')) return
      await db.transactions.delete(initial.id)
      onClose()
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>{editing ? 'Edit transaction' : 'New transaction'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="seg">
          <button className={type === 'expense' ? 'seg-on' : ''} onClick={() => setType('expense')}>
            Expense
          </button>
          <button className={type === 'income' ? 'seg-on' : ''} onClick={() => setType('income')}>
            Income
          </button>
        </div>

        <div className="amount-display">
          <span className="currency">$</span>
          <input
            inputMode="decimal"
            type="text"
            placeholder="0"
            value={amount}
            autoFocus
            onChange={(e) => {
              // Strip anything but digits and a single decimal point (handles
              // pasted "1,234.56", currency symbols, etc.).
              let v = e.target.value.replace(/[^\d.]/g, '')
              const dot = v.indexOf('.')
              if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
              setAmount(v)
            }}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </div>

        <div className="chip-grid">
          {visibleCategories.map((c) => {
            const on = c.id === categoryId
            return (
              <button
                key={c.id}
                className={`chip ${on ? 'on' : ''}`}
                onClick={() => {
                  setTouchedCategory(true)
                  setCategoryId(on ? null : c.id ?? null)
                }}
              >
                <span className="chip-ic">
                  <Icon name={c.icon} size={15} />
                </span>
                {c.name}
              </button>
            )
          })}
        </div>

        {(warnOver || warnNear) && selectedCat && (
          <div className={`limit-warn ${warnOver ? 'is-over' : 'is-near'}`}>
            <Icon name="alert" size={16} />
            <span>
              {warnOver ? (
                <>Puts {selectedCat.name} <strong className="num">{money(projected - limit)}</strong> over its {money(limit)} limit.</>
              ) : (
                <>Only <strong className="num">{money(limit - projected)}</strong> left in {selectedCat.name} after this.</>
              )}
            </span>
          </div>
        )}

        <label className="field">
          <span>Note</span>
          <input
            type="text"
            placeholder="e.g. Trader Joe's"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Account <em>(optional)</em></span>
            <input
              type="text"
              placeholder="Amex"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
        </div>

        <div className="sheet-actions">
          {editing && (
            <button className="btn-danger" onClick={remove}>Delete</button>
          )}
          <button className="btn-primary" disabled={!valid} onClick={save}>
            {editing ? 'Save changes' : 'Add transaction'}
          </button>
        </div>
      </div>
    </div>
  )
}
