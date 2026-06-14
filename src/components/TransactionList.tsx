import { useMemo, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'
import { dayLabel } from '../lib/dates'
import { Icon } from './Icon'

interface Props {
  month: string
  categories: Category[]
  onEdit: (t: Transaction) => void
}

export function TransactionList({ month, categories, onEdit }: Props) {
  const txns = useLiveQuery(
    () => db.transactions.where('date').startsWith(month).toArray(),
    [month],
    [],
  )

  const catById = useMemo(() => {
    const m = new Map<number, Category>()
    for (const c of categories) if (c.id != null) m.set(c.id, c)
    return m
  }, [categories])

  const sorted = useMemo(
    () => [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0))),
    [txns],
  )

  if (sorted.length === 0) {
    return <p className="empty">No transactions this month yet.<br />Tap ＋ to add one.</p>
  }

  const count = sorted.length

  return (
    <>
      <div className="txn-group-label">
        {count} transaction{count === 1 ? '' : 's'}
      </div>
      <ul className="txn-list">
        {sorted.map((t, i) => {
          const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
          return (
            <li
              key={t.id}
              className="txn-row"
              style={{ ['--i' as string]: Math.min(i, 14) } as CSSProperties}
              onClick={() => onEdit(t)}
            >
              <span className="cat-tile sm">
                <Icon name={cat?.icon ?? 'tag'} size={18} />
              </span>
              <span className="txn-main">
                <span className="txn-note">{t.note || cat?.name || 'Uncategorized'}</span>
                <span className="txn-sub">
                  {dayLabel(t.date)}
                  {cat ? ` · ${cat.name}` : ''}
                  {t.account ? ` · ${t.account}` : ''}
                </span>
              </span>
              <span className={`txn-amt num ${t.type === 'income' ? 'pos' : ''}`}>
                {t.type === 'income' ? '+' : '−'}
                {money(t.amount)}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}
