import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction, type TxType } from '../db/db'
import { todayISO, dayLabel } from '../lib/dates'
import { guessCategoryName } from '../lib/categorize'
import { cleanMerchant, merchantInfo } from '../lib/merchants'
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
  const [logoFailed, setLogoFailed] = useState(false)
  const guessedOnce = useRef(editing)

  // Purchase detail (edit mode): who the merchant is + your history with them.
  // Banks never transmit the purchased items, so the "what did I buy?" answer
  // is a deep link into the merchant's own order page.
  const merchant = useMemo(() => (editing ? merchantInfo(initial?.note ?? '') : null), [editing, initial?.note])
  const history = useLiveQuery(async () => {
    if (!editing || !initial?.note?.trim()) return null
    const key = cleanMerchant(initial.note).toLowerCase()
    if (!key) return null
    const all = await db.transactions.toArray()
    const same = all
      .filter((t) => !t.deleted && t.id !== initial.id && t.type === initial.type && cleanMerchant(t.note).toLowerCase() === key)
      .sort((a, b) => b.date.localeCompare(a.date))
    if (same.length === 0) return null
    const total = same.reduce((s, t) => s + t.amount, 0) + initial.amount
    return { count: same.length + 1, total, avg: total / (same.length + 1), last: same[0] }
  }, [editing, initial?.id, initial?.note, initial?.type, initial?.amount], null)

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
      .filter((r) => r.type === 'expense' && !r.deleted && r.date.startsWith(monthOfDate) && r.id !== initial?.id)
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
      // A hand-edit is authoritative: pin it so bank re-syncs never revert it.
      manual: true,
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
      // Pin the delete: without `manual`, a bank re-sync would resurrect the row.
      await db.transactions.update(initial.id, { deleted: true, manual: true, updatedAt: Date.now() })
      onClose()
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h2>{editing ? 'Transaction' : 'New transaction'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {editing && merchant && (merchant.name || selectedCat) && (
          <div className="txn-hero">
            <span className="txn-logo">
              {merchant.logoUrl && !logoFailed ? (
                <img src={merchant.logoUrl} alt="" onError={() => setLogoFailed(true)} />
              ) : (
                <Icon name={selectedCat?.icon ?? 'tag'} size={20} />
              )}
            </span>
            <div className="txn-hero-main">
              <span className="txn-hero-name">{merchant.name || selectedCat?.name || 'No description'}</span>
              <span className="txn-hero-sub">
                {history
                  ? <>{history.count} visits · avg {money(history.avg)} · last {dayLabel(history.last.date)}</>
                  : <>first transaction with this merchant</>}
              </span>
            </div>
          </div>
        )}
        {editing && merchant && (merchant.orderUrl || merchant.searchUrl) && (
          <div className="txn-links">
            {merchant.orderUrl ? (
              <a className="txn-link" href={merchant.orderUrl} target="_blank" rel="noopener noreferrer">
                {merchant.orderLabel} <Icon name="chevron" size={13} />
              </a>
            ) : (
              <a className="txn-link" href={merchant.searchUrl!} target="_blank" rel="noopener noreferrer">
                Look up this charge <Icon name="chevron" size={13} />
              </a>
            )}
          </div>
        )}

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
              // pasted "1,234.56", currency symbols, etc.), clamped to cents —
              // otherwise a paste like "100.50.25" silently became 100.5025.
              let v = e.target.value.replace(/[^\d.]/g, '')
              const dot = v.indexOf('.')
              if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '')
              v = v.replace(/^(\d*\.\d{2}).*$/, '$1')
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
