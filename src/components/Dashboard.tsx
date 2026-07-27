import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { money } from '../lib/format'
import { isFixedCategory } from '../lib/categorize'
import { monthLabel, currentMonth, dayLabel } from '../lib/dates'
import { Icon } from './Icon'

interface Props {
  month: string
  categories: Category[]
  onManageCategories?: () => void
  onEdit?: (t: Transaction) => void
}

type State = 'ok' | 'near' | 'pace' | 'over' | 'none'

interface Row {
  id: number | null
  name: string
  icon: string
  spent: number
  limit: number
  projected: number
  state: State
  txns: Transaction[]
}

/**
 * Budget tab — the same liquid-glass dashboard language as Home, but focused:
 * a spend summary, then every category with its pace/trajectory AND a tap-to-open
 * breakdown of the exact transactions filed under it (so you can see how it's
 * categorized). Budgets are the seeded monthly limits — never mutated here.
 */
export function Dashboard({ month, categories, onManageCategories, onEdit }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const txns = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month], [])

  const isCurrent = month === currentMonth()
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  const dayOfMonth = isCurrent ? new Date().getDate() : daysInMonth

  const data = useMemo(() => {
    const byCat = new Map<number | null, number>()
    const txByCat = new Map<number | null, Transaction[]>()
    let income = 0
    let expense = 0
    for (const t of txns) {
      if (t.deleted) continue
      if (t.type === 'income') {
        income += t.amount
        continue
      }
      expense += t.amount
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + t.amount)
      const list = txByCat.get(t.categoryId)
      if (list) list.push(t)
      else txByCat.set(t.categoryId, [t])
    }
    for (const list of txByCat.values()) list.sort((a, b) => b.amount - a.amount)

    // Only forecast once ~20% into the month — projecting from day 1 (rent on the
    // 1st) would wildly over-forecast. Past months already have dayOfMonth = full.
    const frac = daysInMonth > 0 ? dayOfMonth / daysInMonth : 1
    const canProject = frac >= 0.2
    const project = (s: number) => (canProject ? Math.round(s / frac) : s)
    const stateOf = (spent: number, limit: number, projected: number, fixed = false): State => {
      if (limit <= 0) return 'none'
      if (spent > limit) return 'over'
      if (isCurrent && projected > limit) return 'pace'
      // "close" warns you're approaching a cap mid-month; a fixed bill landing
      // at its budgeted amount is the expected outcome, not a warning.
      if (!fixed && spent >= limit * 0.85) return 'near'
      return 'ok'
    }

    const expenseCats = categories.filter((c) => c.kind === 'expense').sort((a, b) => a.sortOrder - b.sortOrder)
    const rows: Row[] = expenseCats
      .map((c) => {
        const spent = byCat.get(c.id!) ?? 0
        const limit = c.monthlyBudget || 0
        // Fixed bills (rent, subs) never extrapolate: the month-end truth is the
        // bill itself — what's paid, or the budgeted amount if it hasn't hit yet.
        const fixed = isFixedCategory(c.name)
        const projected = fixed ? Math.max(spent, limit) : project(spent)
        return { id: c.id!, name: c.name, icon: c.icon, spent, limit, projected, state: stateOf(spent, limit, projected, fixed), txns: txByCat.get(c.id!) ?? [] }
      })
      .filter((r) => r.limit > 0 || r.spent > 0)

    const uncat = byCat.get(null) ?? 0
    if (uncat > 0) {
      rows.push({ id: null, name: 'Uncategorized', icon: 'tag', spent: uncat, limit: 0, projected: project(uncat), state: 'none', txns: txByCat.get(null) ?? [] })
    }

    const rank: Record<State, number> = { over: 0, pace: 1, near: 2, none: 3, ok: 4 }
    rows.sort((a, b) => (rank[a.state] - rank[b.state]) || b.spent - a.spent)

    const totalLimit = expenseCats.reduce((s, c) => s + (c.monthlyBudget || 0), 0)
    // Month-end projection: fixed bills contribute their known amount; only the
    // flexible remainder extrapolates at the current daily pace.
    let fixedSpent = 0
    let fixedKnown = 0
    for (const c of expenseCats) {
      if (!isFixedCategory(c.name)) continue
      const s = byCat.get(c.id!) ?? 0
      fixedSpent += s
      fixedKnown += Math.max(s, c.monthlyBudget || 0)
    }
    return { income, expense, net: income - expense, rows, totalLimit, projectedTotal: fixedKnown + project(expense - fixedSpent), canProject: canProject && isCurrent }
  }, [txns, categories, isCurrent, daysInMonth, dayOfMonth])

  const hasLimit = data.totalLimit > 0
  const over = hasLimit && data.expense > data.totalLimit
  const pct = hasLimit ? Math.min(100, (data.expense / data.totalLimit) * 100) : 0
  const left = data.totalLimit - data.expense
  const label = monthLabel(month).split(' ')
  const period = label[1] === String(new Date().getFullYear()) ? label[0] : `${label[0]} ${label[1]}`

  return (
    <div className="dash-home">
      <div className="dash-col">
      {/* Spend summary */}
      <div className="cf-card">
        <div className="cf-head">
          <span className="cf-title">Spent in {period}</span>
          <span className="cf-net num">{money(data.expense)}</span>
        </div>
        {hasLimit && (
          <>
            <div className="cf-bar">
              <div className={`cf-bar-fill ${over ? 'over' : 'out'}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="bud-cap">
              {over ? (
                <><strong className="over num">{money(-left)} over</strong> your {money(data.totalLimit)} limit</>
              ) : (
                <><strong className="num">{money(left)} left</strong> of your {money(data.totalLimit)} limit
                  {data.canProject && <> · proj. <strong className="num">{money(data.projectedTotal)}</strong></>}</>
              )}
            </span>
          </>
        )}
        <div className="bud-mini">
          <div><span className="bud-mini-label">Income</span><span className="num">{money(data.income)}</span></div>
          <div><span className="bud-mini-label">Net</span><span className={`num ${data.net >= 0 ? 'pos' : 'over'}`}>{money(data.net, { sign: true })}</span></div>
        </div>
      </div>
      </div>

      <div className="dash-col">
      {/* Categories with drill-down */}
      <div className="card-sect">
        <div className="sect-row">
          <span className="sect-title">Budgets</span>
          <span className="sect-note">tap a category for its transactions</span>
        </div>
        {data.rows.length === 0 ? (
          <p className="empty">Nothing tracked yet this month.</p>
        ) : (
          <ul className="bud-list">
            {data.rows.map((r) => {
              const key = r.id == null ? 'uncat' : String(r.id)
              const expanded = open === key
              const has = r.limit > 0
              const barPct = has ? Math.min(100, (r.spent / r.limit) * 100) : 0
              const fill = r.state === 'over' ? 'over' : r.state === 'pace' || r.state === 'near' ? 'pace' : r.state === 'none' ? 'nobudget' : 'ok'
              const tile = r.state === 'over' ? 'over' : r.state === 'pace' || r.state === 'near' ? 'pace' : r.state === 'ok' ? 'ok' : ''
              return (
                <li key={key} className={`bud-cat ${expanded ? 'open' : ''}`}>
                  <button className="bud-cat-head" onClick={() => setOpen(expanded ? null : key)}>
                    <span className={`cat-tile sm ${tile}`}><Icon name={r.icon} size={16} /></span>
                    <div className="traj-main">
                      <div className="traj-top">
                        <span className="traj-name">{r.name}</span>
                        <span className="traj-figs num">
                          <strong className={r.state === 'over' ? 'over' : ''}>{money(r.spent)}</strong>
                          {has && <span className="of"> / {money(r.limit)}</span>}
                        </span>
                      </div>
                      {has && (
                        <div className="traj-bar">
                          <div className={`traj-fill ${fill}`} style={{ width: `${barPct}%` }} />
                        </div>
                      )}
                      <div className="traj-meta">
                        {r.state === 'none' ? (
                          r.id === null ? (
                            <span className="muted">
                              {r.txns.length === 1 ? '1 transaction needs' : `${r.txns.length} transactions need`} a category — tap to sort
                            </span>
                          ) : (
                            <span className="muted">{r.txns.length} {r.txns.length === 1 ? 'transaction' : 'transactions'}</span>
                          )
                        ) : r.state === 'over' ? (
                          <span className="over">over by {money(r.spent - r.limit)}</span>
                        ) : r.state === 'pace' ? (
                          <span className="near">on pace for {money(r.projected)} — over</span>
                        ) : r.state === 'near' ? (
                          <span className="near">{money(r.limit - r.spent)} left · close</span>
                        ) : (
                          <span className="pos">{money(r.limit - r.spent)} left</span>
                        )}
                      </div>
                    </div>
                    <Icon name="chevron" size={16} className={`bud-chev ${expanded ? 'open' : ''}`} />
                  </button>
                  {expanded && (
                    <ul className="bud-txns">
                      {r.txns.length === 0 ? (
                        <li className="bud-txn muted">No transactions this month.</li>
                      ) : (
                        r.txns.map((t) => (
                          <li
                            key={t.id}
                            className={`bud-txn ${onEdit ? 'bud-txn-editable' : ''}`}
                            onClick={() => onEdit?.(t)}
                            title="Tap to edit or remove"
                          >
                            <span className="bud-txn-date">{dayLabel(t.date)}</span>
                            <span className="bud-txn-note">{t.note || 'Transaction'}</span>
                            <span className="bud-txn-amt num">{money(t.amount)}</span>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {onManageCategories && (
        <button className="home-more" onClick={onManageCategories}>
          <Icon name="tag" size={15} /> Manage categories &amp; budgets
        </button>
      )}
      </div>
    </div>
  )
}
