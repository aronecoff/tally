import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category } from '../db/db'
import { money } from '../lib/format'
import { monthLabel } from '../lib/dates'
import { Icon } from './Icon'

interface Props {
  month: string
  categories: Category[]
}

type Status = 'ok' | 'near' | 'over'

interface Row {
  category: Category | null
  spent: number
  limit: number
  status: Status
}

const NEAR_THRESHOLD = 0.85

function statusOf(spent: number, limit: number): Status {
  if (limit <= 0) return 'ok'
  if (spent > limit) return 'over'
  if (spent >= limit * NEAR_THRESHOLD) return 'near'
  return 'ok'
}

export function Dashboard({ month, categories }: Props) {
  const txns = useLiveQuery(
    () => db.transactions.where('date').startsWith(month).toArray(),
    [month],
    [],
  )

  const { income, expense, net, rows, totalLimit } = useMemo(() => {
    const byCat = new Map<number | null, number>()
    let income = 0
    let expense = 0
    for (const t of txns) {
      if (t.type === 'income') income += t.amount
      else {
        expense += t.amount
        byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + t.amount)
      }
    }

    const expenseCats = categories
      .filter((c) => c.kind === 'expense')
      .sort((a, b) => a.sortOrder - b.sortOrder)

    const rows: Row[] = expenseCats
      .map((c) => {
        const spent = byCat.get(c.id ?? -1) ?? 0
        return { category: c, spent, limit: c.monthlyBudget, status: statusOf(spent, c.monthlyBudget) }
      })
      .filter((r) => r.limit > 0 || r.spent > 0)

    const uncategorized = byCat.get(null) ?? 0
    if (uncategorized > 0) rows.push({ category: null, spent: uncategorized, limit: 0, status: 'ok' })

    const rank = { over: 0, near: 1, ok: 2 }
    rows.sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
      const ap = a.limit > 0 ? a.spent / a.limit : -1
      const bp = b.limit > 0 ? b.spent / b.limit : -1
      return bp - ap
    })

    const totalLimit = expenseCats.reduce((s, c) => s + c.monthlyBudget, 0)
    return { income, expense, net: income - expense, rows, totalLimit }
  }, [txns, categories])

  const alerts = rows.filter((r) => r.status !== 'ok' && r.category)
  const hasLimit = totalLimit > 0
  const totalPct = hasLimit ? Math.min(100, (expense / totalLimit) * 100) : 0
  const totalOver = hasLimit && expense > totalLimit
  const left = totalLimit - expense
  const heroColor = totalOver ? 'var(--over)' : 'var(--white)'

  return (
    <div className="dash">
      <div className="dash-left">
      <div className="hero">
        <span className="hero-label">Spent in {monthLabel(month).split(' ')[0]}</span>
        <span className="hero-num num">{money(expense)}</span>
        {hasLimit && (
          <>
            <div className="hero-bar">
              <div className="hero-bar-fill" style={{ width: `${totalPct}%`, background: heroColor }} />
            </div>
            <span className="hero-cap">
              {totalOver ? (
                <><strong className="over num">{money(-left)} over</strong> your {money(totalLimit)} limit</>
              ) : (
                <><strong className="num">{money(left)} left</strong> of your {money(totalLimit)} limit</>
              )}
            </span>
          </>
        )}
      </div>

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a) => {
            const over = a.status === 'over'
            const fig = over ? a.spent - a.limit : a.limit - a.spent
            return (
              <div key={a.category!.id} className="alert">
                <span className="alert-dot" style={{ background: over ? 'var(--over)' : 'var(--near)' }} />
                <span className="alert-name">{a.category!.name}</span>
                <span className={`alert-fig num ${over ? 'over' : 'near'}`}>
                  {over ? `${money(fig)} over limit` : `${money(fig)} left`}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="mini-stats">
        <div className="mini-stat">
          <span className="mini-label">Income</span>
          <span className="mini-value num">{money(income)}</span>
        </div>
        <div className="mini-stat">
          <span className="mini-label">Net</span>
          <span className={`mini-value num ${net >= 0 ? 'pos' : 'over'}`}>{money(net, { sign: true })}</span>
        </div>
      </div>

      </div>

      <div className="dash-right">
      <div className="section-title">
        <span>Spending limits</span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">Nothing tracked yet this month.<br />Tap ＋ to add a transaction.</p>
      ) : (
        <ul className="limit-list">
          {rows.map((r) => {
            const name = r.category?.name ?? 'Uncategorized'
            const icon = r.category?.icon ?? 'tag'
            const has = r.limit > 0
            const p = has ? Math.min(100, (r.spent / r.limit) * 100) : 0
            const barColor =
              r.status === 'over' ? 'var(--over)' : r.status === 'near' ? 'var(--near)' : 'var(--text-2)'
            const remaining = r.limit - r.spent
            return (
              <li key={r.category?.id ?? 'uncat'} className="limit-row">
                <span className="cat-tile">
                  <Icon name={icon} size={18} />
                </span>
                <div className="limit-main">
                  <div className="limit-top">
                    <span className="limit-name">{name}</span>
                    <span className="limit-figs num">
                      <strong className={r.status === 'over' ? 'over' : ''}>{money(r.spent)}</strong>
                      {has && <span className="of"> / {money(r.limit)}</span>}
                    </span>
                  </div>
                  {has ? (
                    <div className="bar">
                      <div className="bar-fill" style={{ width: `${p}%`, background: barColor }} />
                    </div>
                  ) : (
                    <div className="bar bar-nobudget" />
                  )}
                  {has && (
                    <span className={`limit-meta num ${r.status === 'over' ? 'over' : r.status === 'near' ? 'near' : ''}`}>
                      {r.status === 'over'
                        ? `${money(-remaining)} over your limit`
                        : `${money(remaining)} left`}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      </div>
    </div>
  )
}
