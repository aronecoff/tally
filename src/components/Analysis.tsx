import { memo, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category } from '../db/db'
import { money, pct } from '../lib/format'
import { isFixedCategory } from '../lib/categorize'
import { cleanMerchant } from '../lib/merchants'
import { shiftMonth, monthLabel, currentMonth } from '../lib/dates'
import { useSettle } from '../lib/motion'
import { CashflowChart, type MonthPoint } from './CashflowChart'
import { Icon } from './Icon'
import { Money } from './Money'
import { Skeleton } from './Skeleton'

interface Props {
  month: string
  categories: Category[]
  /** This pane is the visible one (heavy work is skipped while hidden). */
  active: boolean
}

/**
 * The value while the pane is visible; while it is hidden, the last value it
 * had when visible. Heavy memos read these, so a sync or a month change made
 * on another tab does not recompute a pane nobody can see. On the render that
 * shows the pane again the live value is used directly, so nothing stale flashes.
 */
function useWhileActive<T>(value: T, active: boolean): T {
  const [held, setHeld] = useState(value)
  if (active && held !== value) setHeld(value)
  return active ? value : held
}

/** Days in a YYYY-MM month. */
function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

/** Whole-percent shares. When every amount is positive they sum to exactly 100
 *  (largest remainder); otherwise each is simply rounded. */
function shares(amts: number[]): number[] {
  const total = amts.reduce((s, x) => s + x, 0)
  if (total <= 0) return amts.map(() => 0)
  const raw = amts.map((x) => (x / total) * 100)
  if (!amts.every((x) => x > 0)) return raw.map((x) => Math.round(x))
  const out = raw.map((x) => Math.floor(x))
  let left = 100 - out.reduce((s, x) => s + x, 0)
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((p, q) => q.r - p.r)
  for (const { i } of order) {
    if (left <= 0) break
    out[i]++
    left--
  }
  return out
}

/**
 * Insights: the month's answer (saved or overspent) as the hero, with the
 * cash-flow chart as its proof, then:
 *   1. What changed vs last month (top movers, same-period-fair for the live month)
 *   2. By category (footed breakdown)
 *   3. Repeat merchants (frequency × cost)
 *   4. Fixed vs flexible (what can actually be cut)
 * Everything foots to the synced transactions; the receipt is at the bottom.
 */
export const Analysis = memo(function Analysis({ month: liveMonth, categories: liveCats, active }: Props) {
  // Queries follow the live month, so the data is ready when the pane is shown.
  const liveTxns = useLiveQuery(() => db.transactions.where('date').startsWith(liveMonth).toArray(), [liveMonth])
  const livePrevMonth = shiftMonth(liveMonth, -1)
  const livePrev = useLiveQuery(
    () => db.transactions.where('date').startsWith(livePrevMonth).toArray(),
    [livePrevMonth],
  )
  // Every transaction, for the full-history cash-flow chart.
  const liveAll = useLiveQuery(() => db.transactions.toArray(), [])

  const month = useWhileActive(liveMonth, active)
  const categories = useWhileActive(liveCats, active)
  const txns = useWhileActive(liveTxns, active)
  const prevTxns = useWhileActive(livePrev, active)
  const allTxns = useWhileActive(liveAll, active)

  const prevMonth = shiftMonth(month, -1)
  const isCurrent = month === currentMonth()
  const dayOfMonth = new Date().getDate()

  const history = useMemo<MonthPoint[]>(() => {
    if (!allTxns) return []
    const by = new Map<string, { income: number; spend: number; n: number }>()
    for (const t of allTxns) {
      if (t.deleted) continue
      const k = t.date.slice(0, 7)
      const b = by.get(k) ?? { income: 0, spend: 0, n: 0 }
      if (t.type === 'income') b.income += t.amount
      else {
        b.spend += t.amount
        if (t.amount > 0) b.n++ // refunds net into spend but are not purchases
      }
      by.set(k, b)
    }
    const nowKey = currentMonth()
    return [...by.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, b]) => ({
        m,
        income: b.income,
        spend: b.spend,
        partial: m === nowKey,
        // A month with a handful of expenses is missing data, not frugal — the
        // bank feed only reaches back so far and older months arrive gutted.
        sparse: m !== nowKey && b.n < 10,
      }))
      .slice(-14)
  }, [allTxns])

  const catById = useMemo(
    () => new Map(categories.filter((c) => c.id != null).map((c) => [c.id!, c])),
    [categories],
  )

  const a = useMemo(() => {
    let income = 0
    let spend = 0
    let spendCount = 0
    const byCat = new Map<number | null, number>()
    const merch = new Map<string, { n: number; amt: number; cat: number | null }>()
    for (const t of txns ?? []) {
      if (t.deleted) continue
      if (t.type === 'income') {
        income += t.amount
        continue
      }
      spend += t.amount
      spendCount++
      // Normalise: an id that no longer maps to a live category is Uncategorized,
      // otherwise each tombstoned id renders as its own "Uncategorized" row.
      const key = t.categoryId != null && catById.has(t.categoryId) ? t.categoryId : null
      byCat.set(key, (byCat.get(key) ?? 0) + t.amount)
      // Group by cleaned merchant, or store numbers split one habit into many.
      // The glyph is the category of the first charge seen (rows arrive by date).
      const name = cleanMerchant(t.note || '') || 'Other'
      const m = merch.get(name) ?? { n: 0, amt: 0, cat: key }
      // A refund lowers the merchant's total but is not another charge.
      if (t.amount > 0) m.n++
      m.amt += t.amount
      merch.set(name, m)
    }

    // Last month, cut to the SAME number of days when viewing the live month —
    // comparing 9 days of July against all 31 of June would be meaningless.
    let prevSpend = 0
    const prevByCat = new Map<number | null, number>()
    for (const t of prevTxns ?? []) {
      if (t.deleted || t.type !== 'expense') continue
      if (isCurrent && Number(t.date.slice(8, 10)) > dayOfMonth) continue
      prevSpend += t.amount
      const pkey = t.categoryId != null && catById.has(t.categoryId) ? t.categoryId : null
      prevByCat.set(pkey, (prevByCat.get(pkey) ?? 0) + t.amount)
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
    const share = shares(cats.map((c) => c.amt))
    const footed = cats.reduce((s, c) => s + c.amt, 0)
    return { income, spend, spendCount, movers, habits, cats, share, prevSpend, footed }
  }, [txns, prevTxns, isCurrent, dayOfMonth, catById])

  // The hero figure settles when it changes (a month step, a sync landing).
  const heroRef = useRef<HTMLElement>(null)
  useSettle(heroRef, '.hero-fig')

  if (txns === undefined || prevTxns === undefined || allTxns === undefined) {
    return <Skeleton variant="insights" />
  }

  // Fixed vs flexible: what's locked in vs what you actually control.
  const fixed = a.cats.reduce((s, c) => {
    const cat = c.id != null ? catById.get(c.id) : null
    return cat && isFixedCategory(cat.name) ? s + c.amt : s
  }, 0)
  const flexible = a.spend - fixed

  const hasData = a.spendCount > 0 || a.income > 0
  const net = a.income - a.spend
  const delta = a.prevSpend > 0 ? (a.spend - a.prevSpend) / a.prevSpend : null
  const up = (delta ?? 0) > 0
  const r = delta != null ? Math.abs(delta * 100).toFixed(0) : '0'
  const ties = Math.abs(a.footed - a.spend) < 0.005
  const prevLabel = monthLabel(prevMonth)
  // Matches the comparison window above exactly: days 1..today of last month.
  const compareLabel = isCurrent
    ? `${prevLabel.slice(0, 3)} 1–${Math.min(dayOfMonth, daysIn(prevMonth))}`
    : prevLabel.split(' ')[0]
  const chart = history.length > 1 && <CashflowChart key={month} months={history} focus={month} />

  // A month with no data keeps the hero's anatomy and left edge (eyebrow, the
  // plain answer, a caption) with no figure, so the chart below stays anchored.
  if (!hasData) {
    return (
      <div className="analysis">
        <section className="sect enter">
          <span className="hero-label">{isCurrent ? 'So far this month' : 'For the month'}</span>
          <span className="hero-state">No activity in {monthLabel(month)}.</span>
          {isCurrent && (
            <span className="hero-caption">
              Insights appear as transactions sync.
            </span>
          )}
          {chart}
        </section>
      </div>
    )
  }

  return (
    <div className="analysis an-grid">
      <div className="an-lead">
        <section className="sect enter" ref={heroRef}>
          <span className="hero-label">{isCurrent ? 'So far this month' : 'For the month'}</span>
          <span className={`hero-state ${net >= 0 ? 'ok' : 'over'}`}>{net >= 0 ? 'Saved' : 'Overspent'}</span>
          <Money className="hero-fig" value={Math.abs(net)} />
          {net >= 0 && a.income > 0 && <span className="hero-caption num">{pct((net / a.income) * 100)} of income</span>}
          {chart}
        </section>
      </div>

      <div className="an-side">
        {/* 1 — What changed */}
        {(a.movers.length > 0 || delta != null) && (
          <section className="sect enter">
            <div className="sect-row an-head">
              <h2 className="sect-title">What changed</h2>
              {delta != null && (
                <span className={`sect-note an-cmp num${r === '0' ? '' : up ? ' over' : ' pos'}`}>
                  {r === '0' ? `Level with ${compareLabel}` : `${r}% ${up ? 'more' : 'less'} than ${compareLabel}`}
                </span>
              )}
            </div>
            {a.movers.length > 0 && (
              <ul className="an-list">
                {a.movers.map((mv) => {
                  const cat = mv.id != null ? catById.get(mv.id) : null
                  const upM = mv.delta > 0
                  return (
                    <li key={mv.id ?? 'uncat'} className="an-row row-sep">
                      <span className="cat-tile"><Icon name={cat?.icon ?? 'tag'} size={20} /></span>
                      <span className="an-main">
                        <span className="an-line">
                          <span className="an-name">{cat?.name ?? 'Uncategorized'}</span>
                          <span className={`an-fig num ${upM ? 'over' : 'pos'}`}>
                            {upM ? '+' : '−'}{money(Math.abs(mv.delta))}
                          </span>
                        </span>
                        <span className="an-sub num">{money(mv.before)} → {money(mv.now)}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}

        {/* 2 — By category */}
        {a.cats.length > 0 && (
          <section className="sect enter">
            <div className="sect-row an-head">
              <h2 className="sect-title">By category</h2>
              <span className="sect-note">share of spending</span>
            </div>
            <ul className="an-list">
              {a.cats.map((c, i) => {
                const cat = c.id != null ? catById.get(c.id) ?? null : null
                // The bar keeps the raw share; the label is the rounded one that sums to 100.
                const raw = a.spend > 0 ? c.amt / a.spend : 0
                return (
                  <li key={c.id ?? 'uncat'} className="an-row row-sep">
                    <span className="cat-tile"><Icon name={cat?.icon ?? 'tag'} size={20} /></span>
                    <span className="an-main">
                      <span className="an-line">
                        <span className="an-name">{cat?.name ?? 'Uncategorized'}</span>
                        <span className="an-fig num">{money(c.amt)}</span>
                      </span>
                      <span className="an-cat-barrow">
                        <span className="an-cat-track">
                          <span
                            className="an-cat-fill rail-fill"
                            style={{ '--p': Math.max(0, Math.min(1, raw)) } as CSSProperties}
                          />
                        </span>
                        <span className="an-cat-pct num">{pct(a.share[i])}</span>
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* 3 — Repeat merchants (frequency × cost) */}
        {a.habits.length > 0 && (
          <section className="sect enter">
            <div className="sect-row an-head">
              <h2 className="sect-title">Repeat merchants</h2>
              <span className="sect-note">3+ charges</span>
            </div>
            <ul className="an-list">
              {a.habits.map((h) => {
                const cat = h.cat != null ? catById.get(h.cat) : null
                return (
                  <li key={h.name} className="an-row row-sep">
                    <span className="cat-tile"><Icon name={cat?.icon ?? 'tag'} size={20} /></span>
                    <span className="an-main">
                      <span className="an-line">
                        <span className="an-name">{h.name}</span>
                        <span className="an-fig num">{money(h.amt)}</span>
                      </span>
                      <span className="an-sub num">
                        {h.n} charges · avg {money(h.amt / h.n)}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* 4 — What can actually be cut */}
        {a.spend > 0 && (
          <section className="sect enter">
            <div className="sect-row an-head">
              <h2 className="sect-title">Fixed vs flexible</h2>
              <span className="sect-note">rent, subscriptions and health are fixed</span>
            </div>
            <div className="an-mix-bar" aria-hidden="true">
              {fixed > 0 && <span className="an-mix-seg fixed" style={{ flexGrow: fixed }} />}
              {flexible > 0 && <span className="an-mix-seg flex" style={{ flexGrow: flexible }} />}
            </div>
            <div className="an-mix-key">
              <span>
                <i className="an-mix-dot fixed" />
                Fixed <strong className="num">{money(fixed)}</strong>
              </span>
              <span>
                <i className="an-mix-dot flex" />
                Flexible <strong className="num">{money(flexible)}</strong>
              </span>
            </div>
            {flexible > 0 && (
              <p className="an-mix-note">
                Spending 20% less on flexible saves{' '}
                <strong className="num">~{money(flexible * 0.2, { approx: true })}</strong> a month,{' '}
                <strong className="num">~{money(flexible * 0.2 * 12, { approx: true })}</strong> a year.
              </p>
            )}
          </section>
        )}

        {/* Footing receipt */}
        <p className={`an-foot${ties ? '' : ' warn'}`}>
          <Icon name={ties ? 'check' : 'alert'} size={13} />
          {a.spendCount} {a.spendCount === 1 ? 'transaction' : 'transactions'} · categories add up to{' '}
          <strong className="num">{money(a.footed)}</strong>
          {!ties && (
            <>
              , spending is <strong className="num">{money(a.spend)}</strong>
            </>
          )}
        </p>
      </div>
    </div>
  )
})
