import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category } from '../db/db'
import { money } from '../lib/format'
import { shiftMonth, monthLabel, currentMonth } from '../lib/dates'
import { Icon } from './Icon'

interface Props {
  month: string
  categories: Category[]
}

/**
 * Insights — analytics that answer real questions, not wallpaper:
 *   1. What changed vs last month (top movers, same-period-fair for the live month)
 *   2. Where it goes (footed category breakdown)
 *   3. Habits — merchants you keep going back to (frequency × cost)
 *   4. What you can actually cut (fixed vs flexible spend)
 *   5. Are you saving more or less over time (4-month trend)
 * Everything foots to the synced transactions; CPA-grade receipt at the bottom.
 */
export function Analysis({ month, categories }: Props) {
  const prevMonth = shiftMonth(month, -1)
  const isCurrent = month === currentMonth()
  const dayOfMonth = new Date().getDate()

  const txns = useLiveQuery(() => db.transactions.where('date').startsWith(month).toArray(), [month], [])
  const prevTxns = useLiveQuery(() => db.transactions.where('date').startsWith(prevMonth).toArray(), [prevMonth], [])
  const trendStart = `${shiftMonth(month, -3)}-01`
  const trendEnd = `${shiftMonth(month, 1)}-01`
  const recentTxns = useLiveQuery(
    () => db.transactions.where('date').between(trendStart, trendEnd, true, false).toArray(),
    [trendStart, trendEnd],
    [],
  )

  const catById = useMemo(
    () => new Map(categories.filter((c) => c.id != null).map((c) => [c.id!, c])),
    [categories],
  )

  const a = useMemo(() => {
    let income = 0
    let spend = 0
    let spendCount = 0
    const byCat = new Map<number | null, number>()
    const merch = new Map<string, { n: number; amt: number }>()
    for (const t of txns) {
      if (t.deleted) continue
      if (t.type === 'income') {
        income += t.amount
        continue
      }
      spend += t.amount
      spendCount++
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + t.amount)
      const name = (t.note || 'Other').trim() || 'Other'
      const m = merch.get(name) ?? { n: 0, amt: 0 }
      m.n++
      m.amt += t.amount
      merch.set(name, m)
    }

    // Last month, cut to the SAME number of days when viewing the live month —
    // comparing 9 days of July against all 31 of June would be meaningless.
    let prevSpend = 0
    const prevByCat = new Map<number | null, number>()
    for (const t of prevTxns) {
      if (t.deleted || t.type !== 'expense') continue
      if (isCurrent && Number(t.date.slice(8, 10)) > dayOfMonth) continue
      prevSpend += t.amount
      prevByCat.set(t.categoryId, (prevByCat.get(t.categoryId) ?? 0) + t.amount)
    }

    const keys = new Set([...byCat.keys(), ...prevByCat.keys()])
    const movers = [...keys]
      .map((k) => ({ id: k, now: byCat.get(k) ?? 0, before: prevByCat.get(k) ?? 0 }))
      .map((x) => ({ ...x, delta: x.now - x.before }))
      .filter((x) => Math.abs(x.delta) >= 25)
      .sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
      .slice(0, 5)

    const habits = [...merch.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .filter((h) => h.n >= 3)
      .sort((p, q) => q.amt - p.amt)
      .slice(0, 5)

    const cats = [...byCat.entries()].map(([id, amt]) => ({ id, amt })).sort((x, y) => y.amt - x.amt)
    const footed = cats.reduce((s, c) => s + c.amt, 0)
    return { income, spend, spendCount, movers, habits, cats, prevSpend, footed }
  }, [txns, prevTxns, isCurrent, dayOfMonth])

  // Fixed vs flexible: what's locked in vs what you actually control.
  const FIXED = useMemo(() => new Set(['rent', 'subscriptions', 'health']), [])
  const fixed = a.cats.reduce((s, c) => {
    const cat = c.id != null ? catById.get(c.id) : null
    return cat && FIXED.has(cat.name.toLowerCase()) ? s + c.amt : s
  }, 0)
  const flexible = a.spend - fixed

  // Savings by month, last 4 — is the direction up or down?
  const trend = useMemo(() => {
    const months = [-3, -2, -1, 0].map((d) => shiftMonth(month, d))
    const by = new Map(months.map((m) => [m, { inc: 0, out: 0 }]))
    for (const t of recentTxns) {
      if (t.deleted) continue
      const b = by.get(t.date.slice(0, 7))
      if (!b) continue
      if (t.type === 'income') b.inc += t.amount
      else b.out += t.amount
    }
    return months.map((m) => {
      const b = by.get(m)!
      return { m, saved: b.inc - b.out, has: b.inc > 0 || b.out > 0 }
    })
  }, [recentTxns, month])
  const trendMax = Math.max(1, ...trend.map((t) => Math.abs(t.saved)))

  const hasData = a.spendCount > 0 || a.income > 0
  const delta = a.prevSpend > 0 ? (a.spend - a.prevSpend) / a.prevSpend : null
  const up = (delta ?? 0) > 0
  const ties = Math.abs(a.footed - a.spend) < 0.005
  const prevName = monthLabel(prevMonth).split(' ')[0]
  const compareLabel = isCurrent ? `same point in ${prevName}` : prevName

  if (!hasData) {
    return (
      <div className="analysis">
        <p className="empty">
          Nothing to analyze yet this month.<br />
          Insights fill in as transactions sync.
        </p>
      </div>
    )
  }

  return (
    <div className="analysis">
      <div className="an-hero">
        <span className="an-hero-label">Spending</span>
        <span className="an-hero-num num">{money(a.spend)}</span>
        {delta != null && (
          <span className={`an-trend ${up ? 'over' : 'pos'}`}>
            {up ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% vs {compareLabel}
          </span>
        )}
      </div>

      {/* Income − Spending = Saved */}
      <div className="an-tie">
        <div className="an-tie-cell">
          <span className="an-tie-label">Income</span>
          <span className="an-tie-val num pos">{money(a.income)}</span>
        </div>
        <span className="an-tie-op">−</span>
        <div className="an-tie-cell">
          <span className="an-tie-label">Spending</span>
          <span className="an-tie-val num">{money(a.spend)}</span>
        </div>
        <span className="an-tie-op">=</span>
        <div className="an-tie-cell">
          <span className="an-tie-label">Saved</span>
          <span className={`an-tie-val num ${a.income - a.spend >= 0 ? 'pos' : 'over'}`}>
            {money(a.income - a.spend, { sign: true })}
          </span>
          {a.income > 0 && (
            <span className={`an-tie-rate num ${a.income - a.spend >= 0 ? 'pos' : 'over'}`}>
              {a.income - a.spend >= 0
                ? `${Math.round(((a.income - a.spend) / a.income) * 100)}% of income`
                : 'over income'}
            </span>
          )}
        </div>
      </div>

      {/* 1 — What changed */}
      {a.movers.length > 0 && (
        <>
          <div className="an-section-title">What changed vs {compareLabel}</div>
          <ul className="an-movers">
            {a.movers.map((mv) => {
              const cat = mv.id != null ? catById.get(mv.id) : null
              const upM = mv.delta > 0
              return (
                <li key={mv.id ?? 'uncat'} className="an-mover">
                  <span className="cat-tile sm"><Icon name={cat?.icon ?? 'tag'} size={16} /></span>
                  <div className="an-mover-main">
                    <span className="an-mover-name">{cat?.name ?? 'Uncategorized'}</span>
                    <span className="an-mover-sub num">{money(mv.before)} → {money(mv.now)}</span>
                  </div>
                  <span className={`an-mover-delta num ${upM ? 'over' : 'pos'}`}>
                    {upM ? '+' : '−'}{money(Math.abs(mv.delta))}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {/* 2 — Where it goes */}
      <div className="an-section-title">Where it goes</div>
      <ul className="an-cats">
        {a.cats.map((r) => {
          const cat = r.id != null ? catById.get(r.id) ?? null : null
          const name = cat?.name ?? 'Uncategorized'
          const icon = cat?.icon ?? 'tag'
          const pct = a.spend > 0 ? (r.amt / a.spend) * 100 : 0
          return (
            <li key={r.id ?? 'uncat'} className="an-cat">
              <span className="cat-tile sm"><Icon name={icon} size={16} /></span>
              <div className="an-cat-main">
                <div className="an-cat-top">
                  <span className="an-cat-name">{name}</span>
                  <span className="an-cat-amt num">{money(r.amt)}</span>
                </div>
                <div className="an-cat-bar">
                  <div className="an-cat-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <span className="an-cat-pct num">{pct.toFixed(0)}%</span>
            </li>
          )
        })}
      </ul>

      {/* 3 — Habits: repeat merchants (frequency × cost) */}
      {a.habits.length > 0 && (
        <>
          <div className="an-section-title">Habits — where you keep going back</div>
          <ul className="an-habits">
            {a.habits.map((h) => (
              <li key={h.name} className="an-habit">
                <div className="an-habit-main">
                  <span className="an-habit-name">{h.name}</span>
                  <span className="an-habit-sub num">{h.n}× · ~{money(h.amt / h.n)} each</span>
                </div>
                <span className="an-habit-amt num">{money(h.amt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 4 — What you control */}
      {a.spend > 0 && (
        <>
          <div className="an-section-title">What you can actually cut</div>
          <div className="an-mix">
            <div className="an-mix-bar">
              <div className="an-mix-fixed" style={{ width: `${(fixed / Math.max(1, a.spend)) * 100}%` }} />
            </div>
            <div className="an-mix-row">
              <span><span className="an-mix-dot fixed" /> Fixed (rent, subs, health) <strong className="num">{money(fixed)}</strong></span>
              <span><span className="an-mix-dot flex" /> Flexible <strong className="num">{money(flexible)}</strong></span>
            </div>
            {flexible > 0 && (
              <p className="an-mix-note">
                <Icon name="sparkles" size={13} /> Cutting flexible spend 20% frees{' '}
                <strong className="num">{money(flexible * 0.2)}</strong>/mo — that's{' '}
                <strong className="num">{money(flexible * 0.2 * 12)}</strong> a year.
              </p>
            )}
          </div>
        </>
      )}

      {/* 5 — Savings trend */}
      <div className="an-section-title">Saved by month</div>
      <ul className="an-savetrend">
        {trend.map((t) => (
          <li key={t.m} className="an-savemonth">
            <span className="an-savemonth-label">{monthLabel(t.m).split(' ')[0].slice(0, 3)}</span>
            <div className="an-savemonth-track">
              <div
                className={`an-savemonth-bar ${t.saved >= 0 ? 'pos-bg' : 'over-bg'}`}
                style={{ width: `${t.has ? Math.max(3, (Math.abs(t.saved) / trendMax) * 100) : 0}%` }}
              />
            </div>
            <span className={`an-savemonth-amt num ${t.saved >= 0 ? 'pos' : 'over'}`}>
              {t.has ? money(t.saved, { sign: true }) : '—'}
            </span>
          </li>
        ))}
      </ul>

      {/* Footing receipt */}
      <div className={`an-foot ${ties ? '' : 'an-foot-warn'}`}>
        <Icon name={ties ? 'check' : 'alert'} size={13} />
        {a.spendCount} spending {a.spendCount === 1 ? 'transaction' : 'transactions'} · categories foot to{' '}
        <strong className="num">{money(a.footed)}</strong>
        {ties ? ' · ties to spending ✓' : ` · vs spending ${money(a.spend)}`}
      </div>
    </div>
  )
}
