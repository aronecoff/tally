import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category, type Transaction } from '../db/db'
import { currentMonth, todayISO, monthLabel } from '../lib/dates'
import { isFixedCategory } from '../lib/categorize'
import { money } from '../lib/format'
import { Icon } from './Icon'

interface Props {
  categories: Category[]
  onEdit: (t: Transaction) => void
  onMore: () => void
}

type Row = {
  id: number | null
  name: string
  icon: string
  spent: number
  budget: number
  projected: number
}

/**
 * Home = the live dashboard for the current month. One clean scroll: cash flow →
 * quick add → day-by-day → every budget category with pace + projected month-end
 * → recurring bills. All liquid-glass, all footed off real synced transactions.
 */
export function Home({ categories, onEdit, onMore }: Props) {
  const month = currentMonth()
  const today = todayISO()
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const dayOfMonth = now.getDate()

  const monthTxns = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month], [])
  const since = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 100)
    return d.toISOString().slice(0, 10)
  }, [])
  const recentTxns = useLiveQuery(() => db.transactions.where('date').aboveOrEqual(since).toArray(), [since], [])

  const catById = useMemo(() => {
    const m = new Map<number, Category>()
    for (const c of categories) if (c.id != null) m.set(c.id, c)
    return m
  }, [categories])

  const d = useMemo(() => {
    let income = 0
    let spend = 0
    const byCat = new Map<number | null, number>()
    const daily = new Array(daysInMonth).fill(0)
    for (const t of monthTxns) {
      if (t.deleted) continue
      if (t.type === 'income') {
        income += t.amount
      } else {
        spend += t.amount
        byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + t.amount)
        const day = Number(t.date.slice(8, 10))
        if (day >= 1 && day <= daysInMonth) daily[day - 1] += t.amount
      }
    }
    // Project month-end at the current pace — but only once we're far enough in
    // that a linear extrapolation is meaningful. Projecting from day 1 (e.g. rent
    // paid on the 1st) would absurdly forecast 30× that. Below the threshold we
    // just report actual spend (no forecast).
    const frac = daysInMonth > 0 ? dayOfMonth / daysInMonth : 1
    const canProject = frac >= 0.2
    const divisor = dayOfMonth > 0 ? dayOfMonth : daysInMonth
    const project = (s: number) => (canProject ? Math.round(s / frac) : s)

    const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.deleted)
    const rows: Row[] = expenseCats
      .map((c) => {
        const spent = byCat.get(c.id!) ?? 0
        const budget = c.monthlyBudget || 0
        // Fixed bills (rent, subs) never extrapolate: the month-end truth is the
        // bill itself — what's paid, or the budgeted amount if it hasn't hit yet.
        const projected = isFixedCategory(c.name) ? Math.max(spent, budget) : project(spent)
        return { id: c.id!, name: c.name, icon: c.icon, spent, budget, projected }
      })
      .filter((r) => r.spent > 0 || r.budget > 0)
    const uncat = byCat.get(null) ?? 0
    if (uncat > 0) rows.push({ id: null, name: 'Uncategorized', icon: 'tag', spent: uncat, budget: 0, projected: project(uncat) })
    rows.sort((a, b) => b.spent - a.spent)

    const totalBudget = expenseCats.reduce((s, c) => s + (c.monthlyBudget || 0), 0)
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
    const maxDaily = Math.max(1, ...daily)
    return {
      income,
      spend,
      net: income - spend,
      daily,
      maxDaily,
      rows,
      totalBudget,
      projectedTotal: fixedKnown + project(spend - fixedSpent),
      canProject,
      avgPerDay: Math.round(spend / divisor),
    }
  }, [monthTxns, categories, daysInMonth, dayOfMonth])

  // Recurring bills: an expense whose merchant recurs across ≥2 distinct months.
  const bills = useMemo(() => {
    const groups = new Map<string, { name: string; months: Set<string>; last: number; lastDate: string; catId: number | null }>()
    for (const t of recentTxns) {
      if (t.deleted || t.type !== 'expense') continue
      const key = (t.note || '').trim().toLowerCase()
      if (!key) continue
      const g = groups.get(key)
      const m = t.date.slice(0, 7)
      if (!g) groups.set(key, { name: t.note, months: new Set([m]), last: t.amount, lastDate: t.date, catId: t.categoryId })
      else {
        g.months.add(m)
        if (t.date > g.lastDate) {
          g.lastDate = t.date
          g.last = t.amount
          g.catId = t.categoryId
        }
      }
    }
    return [...groups.values()]
      .filter((g) => g.months.size >= 2)
      .sort((a, b) => b.last - a.last)
      .slice(0, 6)
  }, [recentTxns])

  const todays = useMemo(
    () => monthTxns.filter((t) => !t.deleted && t.date === today).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)),
    [monthTxns, today],
  )

  const inTotal = d.income
  const outTotal = d.spend
  const flowMax = Math.max(1, inTotal, outTotal)

  // The one question the top of Home must answer: am I inside my budget?
  const overBudget = d.totalBudget > 0 && d.spend > d.totalBudget
  const overPaceBudget = d.totalBudget > 0 && !overBudget && d.canProject && d.projectedTotal > d.totalBudget
  const budgetPct = d.totalBudget > 0 ? Math.min(100, (d.spend / d.totalBudget) * 100) : 0
  const budgetState = overBudget ? 'over' : overPaceBudget ? 'pace' : 'ok'

  return (
    <div className="dash-home">
      <div className="dash-col">
      {/* Cash flow + budget verdict */}
      <div className="cf-card">
        <div className="cf-head">
          <span className="cf-title">{monthLabel(month)} cash flow</span>
          <span className={`cf-net num ${d.net >= 0 ? 'pos' : 'over'}`}>{money(d.net, { sign: true })}</span>
        </div>

        {d.totalBudget > 0 && (
          <div className={`bud-verdict ${budgetState}`}>
            <div className="bud-verdict-top">
              <span className="bud-verdict-label">
                {overBudget ? 'Over budget' : overPaceBudget ? 'On pace to go over' : 'Inside budget'}
              </span>
              <span className="bud-verdict-fig num">
                {overBudget
                  ? `${money(d.spend - d.totalBudget)} over`
                  : `${money(d.totalBudget - d.spend)} left`}
              </span>
            </div>
            <div className="traj-bar">
              <div className={`traj-fill ${budgetState}`} style={{ width: `${budgetPct}%` }} />
            </div>
            <span className="bud-verdict-sub num">
              {money(d.spend)} of {money(d.totalBudget)}
              {d.canProject && !overBudget && <> · on pace for {money(d.projectedTotal)}</>}
            </span>
          </div>
        )}
        <div className="cf-flows">
          <div className="cf-flow">
            <div className="cf-flow-top">
              <span className="cf-flow-label"><span className="cf-dot in" /> In</span>
              <span className="cf-flow-amt num">{money(inTotal)}</span>
            </div>
            <div className="cf-bar"><div className="cf-bar-fill in" style={{ width: `${(inTotal / flowMax) * 100}%` }} /></div>
          </div>
          <div className="cf-flow">
            <div className="cf-flow-top">
              <span className="cf-flow-label"><span className="cf-dot out" /> Out</span>
              <span className="cf-flow-amt num">{money(outTotal)}</span>
            </div>
            <div className="cf-bar"><div className="cf-bar-fill out" style={{ width: `${(outTotal / flowMax) * 100}%` }} /></div>
          </div>
        </div>

        {/* Savings — what actually stayed in your pocket this month. */}
        {(inTotal > 0 || outTotal > 0) && (
          <div className="cf-save">
            <span className="cf-save-label">{d.net >= 0 ? 'Saved this month' : 'Spent more than earned'}</span>
            <span className="cf-save-figs">
              <strong className={`num ${d.net >= 0 ? 'pos' : 'over'}`}>{money(Math.abs(d.net))}</strong>
              {inTotal > 0 && (
                <span className={`cf-save-rate num ${d.net >= 0 ? 'pos' : 'over'}`}>
                  {d.net >= 0 ? `${Math.round((d.net / inTotal) * 100)}% of income` : 'over income'}
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Day by day */}
      <div className="card-sect">
        <div className="sect-row">
          <span className="sect-title">Day by day</span>
          <span className="sect-note num">{money(d.avgPerDay)}/day avg</span>
        </div>
        <div className="daily">
          {d.daily.map((amt, i) => {
            // Bars are DIRECT flex children with explicit px heights — the
            // wrapper-column + percentage-height version misrendered in WebKit
            // (iOS painted every bar full-size).
            const h = Math.max(2, Math.round((amt / d.maxDaily) * 64))
            const isToday = i + 1 === dayOfMonth
            return (
              <div
                key={i}
                // "zero", not "empty" — .empty is the app's padded empty-state
                // message class and inflates the bar to 48×104.
                className={`daily-bar ${isToday ? 'today' : ''} ${amt === 0 ? 'zero' : ''}`}
                style={{ height: `${h}px` }}
                title={`Day ${i + 1}: ${money(amt)}`}
              />
            )
          })}
        </div>
        <div className="daily-axis"><span>1</span><span>{Math.ceil(daysInMonth / 2)}</span><span>{daysInMonth}</span></div>
      </div>
      </div>

      <div className="dash-col">
      {/* Budgets + trajectory */}
      <div className="card-sect">
        <div className="sect-row">
          <span className="sect-title">Budgets</span>
          <span className="sect-note">
            {d.totalBudget > 0 ? (
              d.canProject ? (
                <>proj. <strong className="num">{money(d.projectedTotal)}</strong> of {money(d.totalBudget)}</>
              ) : (
                <><strong className="num">{money(d.spend)}</strong> of {money(d.totalBudget)}</>
              )
            ) : (
              'set limits below'
            )}
          </span>
        </div>
        <ul className="traj">
          {d.rows.map((r) => {
            const hasBudget = r.budget > 0
            const pct = hasBudget ? Math.min((r.spent / r.budget) * 100, 100) : 0
            const over = hasBudget && r.spent > r.budget
            const overPace = hasBudget && !over && r.projected > r.budget
            const state = !hasBudget ? 'none' : over ? 'over' : overPace ? 'pace' : 'ok'
            return (
              <li key={r.id ?? 'uncat'} className="traj-row">
                <span className={`cat-tile sm ${state}`}><Icon name={r.icon} size={16} /></span>
                <div className="traj-main">
                  <div className="traj-top">
                    <span className="traj-name">{r.name}</span>
                    <span className="traj-figs num">
                      <strong>{money(r.spent)}</strong>
                      {hasBudget && <span className="of"> / {money(r.budget)}</span>}
                    </span>
                  </div>
                  {hasBudget && (
                    <div className="traj-bar">
                      <div className={`traj-fill ${state}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <div className="traj-meta">
                    {!hasBudget ? (
                      <span className="muted">{r.id === null ? 'needs a category — sort it in Budget' : 'not budgeted'}</span>
                    ) : over ? (
                      <span className="over">over by {money(r.spent - r.budget)}</span>
                    ) : overPace ? (
                      <span className="near">on pace for {money(r.projected)} — over</span>
                    ) : (
                      <span className="pos">on track · {money(r.budget - r.spent)} left</span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Recurring bills */}
      {bills.length > 0 && (
        <div className="card-sect">
          <div className="sect-row"><span className="sect-title">Recurring bills</span></div>
          <ul className="bills">
            {bills.map((b) => {
              const cat = b.catId != null ? catById.get(b.catId) : undefined
              return (
                <li key={b.name} className="bill-row">
                  <span className="cat-tile sm"><Icon name={cat?.icon ?? 'repeat'} size={16} /></span>
                  <div className="bill-main">
                    <span className="bill-name">{b.name}</span>
                    <span className="bill-sub">{cat?.name ?? 'Bill'} · monthly</span>
                  </div>
                  <span className="bill-amt num">{money(b.last)}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Today */}
      {todays.length > 0 && (
        <div className="card-sect">
          <div className="sect-row"><span className="sect-title">Today</span></div>
          <ul className="txn-list">
            {todays.map((t) => {
              const cat = t.categoryId != null ? catById.get(t.categoryId) : undefined
              return (
                <li key={t.id} className="txn-row" onClick={() => onEdit(t)}>
                  <span className="cat-tile sm"><Icon name={cat?.icon ?? 'tag'} size={18} /></span>
                  <span className="txn-main">
                    <span className="txn-note">{t.note || cat?.name || 'Uncategorized'}</span>
                    <span className="txn-sub">{cat?.name ?? 'Uncategorized'}</span>
                  </span>
                  <span className={`txn-amt num ${t.type === 'income' ? 'pos' : ''}`}>
                    {t.type === 'income' ? '+' : '−'}{money(t.amount)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <button className="home-more" onClick={onMore}>
        <Icon name="pie" size={15} /> Full budget &amp; activity
      </button>
      </div>
    </div>
  )
}
