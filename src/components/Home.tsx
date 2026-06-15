import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { currentMonth, todayISO } from '../lib/dates'
import { money } from '../lib/format'
import { parseEntry } from '../lib/parse'
import { Icon } from './Icon'

interface Props {
  categories: Category[]
  onEdit: (t: Transaction) => void
  onMore: () => void
}

export function Home({ categories, onEdit, onMore }: Props) {
  const month = currentMonth()
  const today = todayISO()
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const monthTxns = useLiveQuery(
    () => db.transactions.where('date').startsWith(month).toArray(),
    [month],
    [],
  )

  const catById = useMemo(() => {
    const m = new Map<number, Category>()
    for (const c of categories) if (c.id != null) m.set(c.id, c)
    return m
  }, [categories])

  const { safeToday, monthLeft, daysLeft, hasLimit, todays } = useMemo(() => {
    const now = new Date()
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const daysLeft = daysInMonth - now.getDate() + 1

    const monthLimit = categories
      .filter((c) => c.kind === 'expense' && !c.deleted)
      .reduce((s, c) => s + c.monthlyBudget, 0)

    let monthSpent = 0
    let todaySpent = 0
    const todays: Transaction[] = []
    for (const t of monthTxns) {
      if (t.deleted || t.type !== 'expense') {
        if (!t.deleted && t.date === today) todays.push(t)
        continue
      }
      monthSpent += t.amount
      if (t.date === today) {
        todaySpent += t.amount
        todays.push(t)
      }
    }

    const beforeToday = monthSpent - todaySpent
    const perDay = monthLimit > 0 ? (monthLimit - beforeToday) / daysLeft : 0
    const safeToday = perDay - todaySpent
    todays.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))

    return { safeToday, monthLeft: monthLimit - monthSpent, daysLeft, hasLimit: monthLimit > 0, todays }
  }, [monthTxns, categories, today])

  async function log() {
    const parsed = parseEntry(text, categories)
    if (!parsed) {
      setFlash('Add an amount — e.g. "lunch 14"')
      bumpFlash()
      return
    }
    const now = Date.now()
    await db.transactions.add({
      date: parsed.date,
      amount: parsed.amount,
      type: parsed.type,
      categoryId: parsed.categoryId,
      account: '',
      note: parsed.note,
      createdAt: now,
      updatedAt: now,
    } as Transaction)
    setText('')
    setFlash(`${parsed.type === 'income' ? '+' : '−'}${money(parsed.amount)} · ${parsed.note}`)
    bumpFlash()
  }

  function bumpFlash() {
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 2600)
  }

  const over = hasLimit && safeToday < 0

  return (
    <div className="home">
      <div className="home-hero">
        <span className="home-label">{hasLimit ? 'Safe to spend today' : 'Spent today'}</span>
        <span className={`home-num num ${over ? 'over' : ''}`}>
          {hasLimit ? (
            <>{over ? '−' : ''}{money(Math.abs(safeToday))}</>
          ) : (
            money(todays.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0))
          )}
        </span>
        <span className="home-sub">
          {hasLimit ? (
            <><strong className="num">{money(monthLeft)}</strong> left this month · {daysLeft} days</>
          ) : (
            'Set monthly limits to see what’s safe to spend'
          )}
        </span>
      </div>

      <div className="home-input">
        <input
          type="text"
          inputMode="text"
          value={text}
          placeholder='Log it — “lunch 14” or “got paid 3200”'
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && log()}
        />
        <button className="home-send" onClick={log} aria-label="Log" disabled={!text.trim()}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      <div className={`home-flash ${flash ? 'on' : ''}`}>{flash ?? ''}</div>

      <div className="home-today">
        <span className="txn-group-label">Today</span>
        {todays.length === 0 ? (
          <p className="home-empty">Nothing logged yet. Type a spend above to start.</p>
        ) : (
          <ul className="txn-list">
            {todays.map((t) => {
              const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
              return (
                <li key={t.id} className="txn-row" onClick={() => onEdit(t)}>
                  <span className="cat-tile sm">
                    <Icon name={cat?.icon ?? 'tag'} size={18} />
                  </span>
                  <span className="txn-main">
                    <span className="txn-note">{t.note || cat?.name || 'Uncategorized'}</span>
                    <span className="txn-sub">{cat?.name ?? 'Uncategorized'}</span>
                  </span>
                  <span className={`txn-amt num ${t.type === 'income' ? 'pos' : ''}`}>
                    {t.type === 'income' ? '+' : '−'}
                    {money(t.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <button className="home-more" onClick={onMore}>
        <Icon name="pie" size={15} /> Budget, activity &amp; more
      </button>
    </div>
  )
}
