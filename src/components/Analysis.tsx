import { memo, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Category } from '../db/db'
import { money, pct, toCents } from '../lib/format'
import { isFixed } from '../lib/categorize'
import { cleanMerchant } from '../lib/merchants'
import { oneOffRows, paceProjector } from '../lib/projection'
import { awaitingPay } from '../lib/payday'
import { beforePayday, OVERSPENT, SAVED } from '../lib/copy'
import { shiftMonth, monthLabel, dayLabel } from '../lib/dates'
import { useToday } from '../lib/useToday'
import { useKeyedLiveQuery } from '../lib/useKeyedLiveQuery'
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

/** Whole-percent shares of the PURCHASES: the positive amounts sum to exactly
 *  100 (largest remainder). A category whose refunds outweigh its purchases
 *  (net negative) has no share: it read '−5%' and pushed the rest past 100. */
function shares(amts: number[]): number[] {
  const gross = amts.reduce((s, x) => s + Math.max(0, x), 0)
  if (gross <= 0) return amts.map(() => 0)
  const raw = amts.map((x) => (x > 0 ? (x / gross) * 100 : 0))
  const out = raw.map((x) => Math.floor(x))
  let left = 100 - out.reduce((s, x) => s + x, 0)
  const order = raw
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .filter(({ i }) => amts[i] > 0)
    .sort((p, q) => q.r - p.r)
  for (const { i } of order) {
    if (left <= 0) break
    out[i]++
    left--
  }
  return out
}

/** "rent, subscriptions and health" */
function listWords(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
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
  // A month step suspends rather than show the old month's figures under the
  // new label (lib/useKeyedLiveQuery).
  const liveTxns = useKeyedLiveQuery(liveMonth, () => db.transactions.where('date').startsWith(liveMonth).toArray())
  const livePrevMonth = shiftMonth(liveMonth, -1)
  const livePrev = useKeyedLiveQuery(livePrevMonth, () =>
    db.transactions.where('date').startsWith(livePrevMonth).toArray(),
  )
  // Every transaction, for the full-history cash-flow chart.
  const liveAll = useLiveQuery(() => db.transactions.toArray(), [])

  const month = useWhileActive(liveMonth, active)
  const categories = useWhileActive(liveCats, active)
  const txns = useWhileActive(liveTxns, active)
  const prevTxns = useWhileActive(livePrev, active)
  const allTxns = useWhileActive(liveAll, active)

  const prevMonth = shiftMonth(month, -1)
  // The clock as a subscription, so a pane left open past midnight moves on.
  const today = useToday()
  const nowKey = today.slice(0, 7)
  const isCurrent = month === nowKey
  const dayOfMonth = Number(today.slice(8, 10))

  // Where the bank feed's history starts: the earliest bank row the bank still
  // stands behind (not pinned by hand; pinned rows outlive the feed window).
  // A month that starts before it is only partly covered, however many rows
  // it has: June read as a complete +$6,053 month from its 24th on.
  const coverStart = useMemo(() => {
    let start: string | null = null
    for (const t of allTxns ?? []) {
      if (t.deleted || t.manual || !(t.uid ?? '').startsWith('sf:')) continue
      if (start == null || t.date < start) start = t.date
    }
    return start
  }, [allTxns])
  /** A finished month the data cannot support: a handful of purchases, or the
   *  bank history starting after its first days. */
  const incomplete = (m: string, purchases: number) =>
    m !== nowKey && (purchases < 10 || (coverStart != null && coverStart > `${m}-03`))

  const history = useMemo<MonthPoint[]>(() => {
    if (!allTxns) return []
    const by = new Map<string, { income: number; spend: number; n: number }>()
    for (const t of allTxns) {
      if (t.deleted) continue
      const k = t.date.slice(0, 7)
      // Rent paid early is dated the 1st of the month it pays for: a month
      // that has not started yet gets no column.
      if (k > nowKey) continue
      const b = by.get(k) ?? { income: 0, spend: 0, n: 0 }
      if (t.type === 'income') b.income += toCents(t.amount)
      else {
        b.spend += toCents(t.amount)
        if (t.amount > 0) b.n++ // refunds net into spend but are not purchases
      }
      by.set(k, b)
    }
    // The live month before payday draws nothing 'over' (lib/payday.ts).
    const waiting = awaitingPay(nowKey, allTxns.filter((t) => t.date.startsWith(nowKey)), allTxns, categories)
    return [...by.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([m, b]) => ({
        m,
        income: b.income / 100,
        spend: b.spend / 100,
        partial: m === nowKey,
        ...(m === nowKey && waiting ? { awaitingPay: true } : {}),
        // A month with a handful of expenses is missing data, not frugal — the
        // bank feed only reaches back so far and older months arrive gutted.
        sparse: m !== nowKey && (b.n < 10 || (coverStart != null && coverStart > `${m}-03`)),
      }))
      .slice(-14)
  }, [allTxns, coverStart, nowKey, categories])

  const catById = useMemo(
    () => new Map(categories.filter((c) => c.id != null).map((c) => [c.id!, c])),
    [categories],
  )

  const a = useMemo(() => {
    // Every sum in whole cents, divided once (a float sum read '−$0.00').
    let incomeC = 0
    let spendC = 0
    let spendCount = 0
    let purchases = 0
    const byCat = new Map<number | null, number>()
    // Purchases and refunds apart, for 'What changed': a refund of an earlier
    // purchase netted into a short window read as a spending jump.
    const grossByCat = new Map<number | null, number>()
    let refundsNow = 0
    let flexLumpC = 0
    const merch = new Map<string, { n: number; amt: number; gross: number; cat: number | null }>()
    const fixedId = (key: number | null) => {
      const cat = key != null ? catById.get(key) : undefined
      return !!cat && isFixed(cat)
    }
    // Rows the pace counts once (big rows, refunds, monthly bills), as on Home and Budget.
    const once = oneOffRows(txns ?? [], allTxns ?? [], month)
    for (const t of txns ?? []) {
      if (t.deleted) continue
      const c = toCents(t.amount)
      if (t.type === 'income') {
        incomeC += c
        continue
      }
      spendC += c
      spendCount++
      if (t.amount > 0) purchases++
      // Normalise: an id that no longer maps to a live category is Uncategorized,
      // otherwise each tombstoned id renders as its own "Uncategorized" row.
      const key = t.categoryId != null && catById.has(t.categoryId) ? t.categoryId : null
      byCat.set(key, (byCat.get(key) ?? 0) + c)
      if (c > 0) grossByCat.set(key, (grossByCat.get(key) ?? 0) + c)
      else refundsNow -= c
      if (once.has(t) && !fixedId(key)) flexLumpC += c
      // Group by cleaned merchant, or store numbers split one habit into many.
      // The glyph is the category of the first charge seen (rows arrive by date).
      const name = cleanMerchant(t.note || '') || 'Other'
      const m = merch.get(name) ?? { n: 0, amt: 0, gross: 0, cat: key }
      // A refund lowers the merchant's total but is not another charge, and
      // stays out of the average (as on the transaction sheet).
      if (c > 0) {
        m.n++
        m.gross += c
      }
      m.amt += c
      merch.set(name, m)
    }

    // Last month, cut to the SAME number of days when viewing the live month —
    // comparing 9 days of July against all 31 of June would be meaningless.
    let prevSpendC = 0
    let prevPurchases = 0
    let prevFlexFullC = 0
    let refundsPrev = 0
    const prevGrossByCat = new Map<number | null, number>()
    for (const t of prevTxns ?? []) {
      if (t.deleted || t.type !== 'expense') continue
      const c = toCents(t.amount)
      const pkey = t.categoryId != null && catById.has(t.categoryId) ? t.categoryId : null
      // The whole previous month, for the flexible-spend tip and its coverage.
      if (c > 0) prevPurchases++
      if (!fixedId(pkey)) prevFlexFullC += c
      if (isCurrent && Number(t.date.slice(8, 10)) > dayOfMonth) continue
      prevSpendC += c
      if (c > 0) prevGrossByCat.set(pkey, (prevGrossByCat.get(pkey) ?? 0) + c)
      else refundsPrev -= c
    }

    // Movers compare purchases; refunds are one line of their own whose delta
    // is their effect on spending, so every mover adds up to the net change.
    const keys = new Set([...grossByCat.keys(), ...prevGrossByCat.keys()])
    const candidates: { id: number | null | 'refunds'; now: number; before: number; delta: number }[] = [...keys].map((k) => {
      const now = grossByCat.get(k) ?? 0
      const before = prevGrossByCat.get(k) ?? 0
      return { id: k, now, before, delta: now - before }
    })
    candidates.push({ id: 'refunds', now: refundsNow, before: refundsPrev, delta: refundsPrev - refundsNow })
    const movers = candidates
      .filter((x) => Math.abs(x.delta) >= 2500)
      .sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
      .slice(0, 5)
      .map((x) => ({ id: x.id, now: x.now / 100, before: x.before / 100, delta: x.delta / 100 }))

    const habits = [...merch.entries()]
      .map(([name, v]) => ({ name, n: v.n, cat: v.cat, amt: v.amt / 100, gross: v.gross / 100 }))
      .filter((h) => h.n >= 3)
      .sort((p, q) => q.amt - p.amt)
      .slice(0, 5)

    const cats = [...byCat.entries()].map(([id, amt]) => ({ id, amt: amt / 100 })).sort((x, y) => y.amt - x.amt)
    const share = shares(cats.map((c) => c.amt))
    const gross = cats.reduce((s, c) => s + Math.max(0, toCents(c.amt)), 0) / 100
    const footed = cats.reduce((s, c) => s + toCents(c.amt), 0) / 100
    const fixedC = [...byCat.entries()].reduce((s, [id, amt]) => (fixedId(id) ? s + amt : s), 0)
    return {
      income: incomeC / 100,
      spend: spendC / 100,
      spendCount,
      purchases,
      movers,
      habits,
      cats,
      share,
      gross,
      fixed: fixedC / 100,
      flexible: (spendC - fixedC) / 100,
      flexLump: flexLumpC / 100,
      prevSpend: prevSpendC / 100,
      prevPurchases,
      prevHas: (prevTxns ?? []).some((t) => !t.deleted),
      prevFlexFull: prevFlexFullC / 100,
      footed,
    }
  }, [txns, prevTxns, allTxns, month, isCurrent, dayOfMonth, catById])

  // The hero figure settles when it changes (a month step, a sync landing).
  const heroRef = useRef<HTMLElement>(null)
  useSettle(heroRef, '.hero-fig')

  if (txns === undefined || prevTxns === undefined || allTxns === undefined) {
    return <Skeleton variant="insights" />
  }

  // Fixed vs flexible: what's locked in vs what you actually control. Fixed
  // follows the category's flag or built-in key, so a renamed Rent stays fixed.
  const fixed = a.fixed
  const flexible = a.flexible
  const fixedNames = categories
    .filter((c) => c.kind === 'expense' && !c.deleted && isFixed(c))
    .sort((x, y) => x.sortOrder - y.sortOrder)
    .map((c) => c.name.toLowerCase())
  const fixedNote = fixedNames.length === 0 ? 'no category is fixed' : `${listWords(fixedNames)} ${fixedNames.length === 1 ? 'is' : 'are'} fixed`

  // The tip's monthly basis. Month-to-date spending is not a month: on the 4th
  // it put ~$20 a month on a ~$665 habit. A past month is its own basis; the
  // live month uses its pace once it can be paced, else last month in full.
  const pace = paceProjector(dayOfMonth, daysIn(month))
  const prevPoint = history.find((h) => h.m === prevMonth)
  const basis: { amt: number; from: 'month' | 'pace' | 'prev' } | null = !isCurrent
    ? { amt: flexible, from: 'month' }
    : pace.canProject
      ? { amt: pace.flexEnd(flexible, a.flexLump), from: 'pace' }
      : a.prevFlexFull > 0 && prevPoint && !prevPoint.sparse
        ? { amt: a.prevFlexFull, from: 'prev' }
        : null

  const hasData = a.spendCount > 0 || a.income > 0
  const net = a.income - a.spend
  // The live month before payday is not 'Overspent' (lib/payday.ts, shared
  // with Home and Budget): an interest credit on the 7th is not pay.
  const awaitingIncome = isCurrent && awaitingPay(month, txns, prevTxns, categories)
  // A finished month the bank history only partly covers.
  const viewedIncomplete = incomplete(month, a.purchases)
  const prevIncomplete = a.prevHas && incomplete(prevMonth, a.prevPurchases)
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
          {awaitingIncome ? (
            <>
              <span className="hero-state">{beforePayday(a.income)}</span>
              <Money className="hero-fig" value={a.spend} />
              <span className="hero-caption num">spent so far</span>
            </>
          ) : (
            <>
              <span className={`hero-state ${net >= 0 ? 'ok' : 'over'}`}>{net >= 0 ? SAVED : OVERSPENT}</span>
              <Money className="hero-fig" value={Math.abs(net)} />
              {viewedIncomplete ? (
                <span className="hero-caption num">
                  Partial data
                  {coverStart != null && coverStart > `${month}-03` && <> · bank history starts {dayLabel(coverStart)}</>}
                </span>
              ) : (
                net >= 0 && a.income > 0 && <span className="hero-caption num">{pct((net / a.income) * 100)} of income</span>
              )}
            </>
          )}
          {chart}
        </section>
      </div>

      <div className="an-side">
        {/* 1 — What changed. Never against a month the data only partly
            covers: June's half month made July read '625% more'. */}
        {(prevIncomplete || a.movers.length > 0 || delta != null) && (
          <section className="sect enter">
            <div className="sect-row an-head">
              <h2 className="sect-title">What changed</h2>
              {prevIncomplete ? (
                <span className="sect-note">{prevLabel.split(' ')[0]} has partial data</span>
              ) : (
                delta != null && (
                  <span className={`sect-note an-cmp num${r === '0' ? '' : up ? ' over' : ' pos'}`}>
                    {r === '0' ? `Level with ${compareLabel}` : `${r}% ${up ? 'more' : 'less'} than ${compareLabel}`}
                  </span>
                )
              )}
            </div>
            {!prevIncomplete && a.movers.length > 0 && (
              <ul className="an-list">
                {a.movers.map((mv) => {
                  const upM = mv.delta > 0
                  if (mv.id === 'refunds') {
                    // Money back is not spending behaviour: no red or green.
                    return (
                      <li key="refunds" className="an-row row-sep">
                        <span className="cat-tile"><Icon name="plus-circle" size={20} /></span>
                        <span className="an-main">
                          <span className="an-line">
                            <span className="an-name">Refunds</span>
                            <span className="an-fig num">{upM ? '+' : '−'}{money(Math.abs(mv.delta))}</span>
                          </span>
                          <span className="an-sub num">{money(mv.before)} back → {money(mv.now)} back</span>
                        </span>
                      </li>
                    )
                  }
                  const cat = mv.id != null ? catById.get(mv.id) : null
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
                // The bar keeps the raw share of purchases; the label is the
                // rounded one that sums to 100. A net refund has no share.
                const raw = a.gross > 0 && c.amt > 0 ? c.amt / a.gross : 0
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
                        <span className="an-cat-pct num">{c.amt > 0 ? pct(a.share[i]) : ''}</span>
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
                        {h.n} charges · avg {money(h.gross / h.n)}
                        {h.gross - h.amt >= 0.005 && <> · {money(h.gross - h.amt)} refunded</>}
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
              <span className="sect-note">{fixedNote}</span>
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
            {basis && basis.amt > 0 && (
              <p className="an-mix-note">
                {basis.from === 'pace' ? (
                  <>
                    At this pace flexible ends near <strong className="num">~{money(basis.amt, { approx: true })}</strong>; 20% less
                    saves{' '}
                  </>
                ) : basis.from === 'prev' ? (
                  <>Based on {prevLabel.split(' ')[0]}, spending 20% less on flexible saves </>
                ) : (
                  <>Spending 20% less on flexible saves </>
                )}
                <strong className="num">~{money(basis.amt * 0.2, { approx: true })}</strong> a month,{' '}
                <strong className="num">~{money(basis.amt * 0.2 * 12, { approx: true })}</strong> a year.
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
